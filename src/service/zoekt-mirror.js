import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { inflateSync } from 'zlib';
import tarStream from 'tar-stream';

export class ZoektMirror {
  constructor(mirrorDir) {
    this.mirrorDir = mirrorDir;
    this.pathPrefix = '';
    this.markerPath = join(mirrorDir, '.zoekt-mirror-marker');
  }

  isReady() {
    return existsSync(this.markerPath);
  }

  getMirrorRoot() {
    return this.mirrorDir;
  }

  bootstrapFromDatabase(database, onProgress = null) {
    const startMs = performance.now();
    console.log('[ZoektMirror] Bootstrapping mirror from database...');

    mkdirSync(this.mirrorDir, { recursive: true });

    this._computePathPrefix(database);

    // Fetch all source file content from SQLite
    const rows = database.db.prepare(
      `SELECT fc.content, f.path, f.language FROM file_content fc
       JOIN files f ON f.id = fc.file_id
       WHERE f.language NOT IN ('content')`
    ).all();

    const total = rows.length;
    let written = 0;
    let assetCount = 0;
    let errors = 0;
    for (const row of rows) {
      try {
        const content = inflateSync(row.content);
        const isAsset = row.language === 'asset';
        const relativePath = isAsset
          ? this._toAssetMirrorPath(row.path)
          : this._toRelativePath(row.path);
        const fullPath = join(this.mirrorDir, relativePath);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content);
        written++;
        if (isAsset) assetCount++;

        // Progress reporting every 5000 files
        if (onProgress && written % 5000 === 0) {
          const elapsed = (performance.now() - startMs) / 1000;
          const rate = written / elapsed;
          onProgress({ written, total, rate: Math.round(rate), etaSeconds: Math.ceil((total - written) / rate) });
        }
      } catch (err) {
        errors++;
        if (errors <= 5) {
          console.warn(`[ZoektMirror] Error writing ${row.path}: ${err.message}`);
        }
      }
    }

    // Write marker file
    writeFileSync(this.markerPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      fileCount: written,
      assetCount,
      pathPrefix: this.pathPrefix
    }));

    const durationS = ((performance.now() - startMs) / 1000).toFixed(1);
    console.log(`[ZoektMirror] Bootstrap complete: ${written} files written (${assetCount} assets), ${errors} errors (${durationS}s)`);
    return written;
  }

  /**
   * Stream all mirror files as a tar archive to a writable stream.
   * Used for direct-to-WSL bootstrap, skipping the Windows filesystem.
   */
  async bootstrapToStream(database, outputStream, onProgress = null) {
    const startMs = performance.now();
    console.log('[ZoektMirror] Streaming bootstrap to tar...');

    // Compute path prefix (same logic as bootstrapFromDatabase)
    this._computePathPrefix(database);

    const rows = database.db.prepare(
      `SELECT fc.content, f.path, f.language FROM file_content fc
       JOIN files f ON f.id = fc.file_id
       WHERE f.language NOT IN ('content')`
    ).all();

    const total = rows.length;
    let written = 0;
    let assetCount = 0;
    let errors = 0;

    const pack = tarStream.pack();
    // Suppress 'Writable stream closed prematurely' — the receiving tar process
    // may exit after consuming all data before the pack stream fully finalizes.
    pack.on('error', () => {});
    outputStream.on('error', () => {});
    pack.pipe(outputStream);

    for (const row of rows) {
      try {
        const content = inflateSync(row.content);
        const isAsset = row.language === 'asset';
        const relativePath = isAsset
          ? this._toAssetMirrorPath(row.path)
          : this._toRelativePath(row.path);

        // Write tar entry — use a promise to handle backpressure
        await new Promise((resolve, reject) => {
          const entry = pack.entry({ name: relativePath, size: content.length }, (err) => {
            if (err) reject(err);
            else resolve();
          });
          entry.end(content);
        });

        written++;
        if (isAsset) assetCount++;

        if (onProgress && written % 5000 === 0) {
          const elapsed = (performance.now() - startMs) / 1000;
          const rate = written / elapsed;
          onProgress({ written, total, rate: Math.round(rate), etaSeconds: Math.ceil((total - written) / rate) });
        }
      } catch (err) {
        errors++;
        if (errors <= 5) {
          console.warn(`[ZoektMirror] Error streaming ${row.path}: ${err.message}`);
        }
      }
    }

    // Finalize the tar archive
    pack.finalize();

    // Write marker file to Windows mirror dir (for integrity checks)
    mkdirSync(this.mirrorDir, { recursive: true });
    writeFileSync(this.markerPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      fileCount: written,
      assetCount,
      pathPrefix: this.pathPrefix
    }));

    const durationS = ((performance.now() - startMs) / 1000).toFixed(1);
    console.log(`[ZoektMirror] Tar stream complete: ${written} files (${assetCount} assets), ${errors} errors (${durationS}s)`);
    return written;
  }

  /**
   * Extract common path prefix from database samples.
   */
  _computePathPrefix(database) {
    const sample = database.db.prepare(
      `SELECT path FROM (
        SELECT path, ROW_NUMBER() OVER (PARTITION BY project ORDER BY ROWID) as rn
        FROM files WHERE language NOT IN ('content', 'asset')
      ) WHERE rn <= 5`
    ).all().map(r => r.path.replace(/\\/g, '/'));

    if (sample.length > 0) {
      this.pathPrefix = sample[0];
      for (const p of sample) {
        while (this.pathPrefix && !p.startsWith(this.pathPrefix)) {
          this.pathPrefix = this.pathPrefix.slice(0, this.pathPrefix.lastIndexOf('/'));
        }
      }
      if (this.pathPrefix && !this.pathPrefix.endsWith('/')) this.pathPrefix += '/';
    }
  }

  verifyIntegrity(database) {
    if (!this.isReady()) {
      return { valid: false, reason: 'no marker file' };
    }
    try {
      const manifest = JSON.parse(readFileSync(this.markerPath, 'utf-8'));
      const dbCount = database.db.prepare(
        "SELECT COUNT(*) as c FROM file_content fc JOIN files f ON f.id = fc.file_id WHERE f.language != 'content'"
      ).get().c;

      const drift = dbCount > 0 ? Math.abs(dbCount - manifest.fileCount) / dbCount : 0;
      if (drift > 0.05) {
        return { valid: false, reason: `count mismatch: db=${dbCount}, mirror=${manifest.fileCount} (${(drift * 100).toFixed(1)}% drift)` };
      }
      return { valid: true, dbCount, mirrorCount: manifest.fileCount };
    } catch (err) {
      return { valid: false, reason: `marker parse error: ${err.message}` };
    }
  }

  loadPrefix(database) {
    // Load prefix from marker or recompute
    if (existsSync(this.markerPath)) {
      try {
        const marker = JSON.parse(readFileSync(this.markerPath, 'utf-8'));
        if (marker.pathPrefix) {
          this.pathPrefix = marker.pathPrefix;
          return;
        }
      } catch {}
    }

    this._computePathPrefix(database);
  }

  updateFile(filePath, content) {
    try {
      const relativePath = this._toRelativePath(filePath);
      const fullPath = join(this.mirrorDir, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
    } catch (err) {
      console.warn(`[ZoektMirror] Error updating ${filePath}: ${err.message}`);
    }
  }

  deleteFile(filePath) {
    try {
      const relativePath = this._toRelativePath(filePath);
      const fullPath = join(this.mirrorDir, relativePath);
      if (existsSync(fullPath)) {
        unlinkSync(fullPath);
      }
    } catch (err) {
      // File may already be gone
    }
  }

  getPathPrefix() {
    return this.pathPrefix;
  }

  updateAsset(contentPath, content) {
    try {
      const relativePath = this._toAssetMirrorPath(contentPath);
      const fullPath = join(this.mirrorDir, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
    } catch (err) {
      console.warn(`[ZoektMirror] Error updating asset ${contentPath}: ${err.message}`);
    }
  }

  deleteAsset(contentPath) {
    try {
      const relativePath = this._toAssetMirrorPath(contentPath);
      const fullPath = join(this.mirrorDir, relativePath);
      if (existsSync(fullPath)) {
        unlinkSync(fullPath);
      }
    } catch {}
  }

  _toRelativePath(fullPath) {
    const normalized = fullPath.replace(/\\/g, '/');
    if (this.pathPrefix && normalized.startsWith(this.pathPrefix)) {
      return normalized.slice(this.pathPrefix.length);
    }
    return normalized;
  }

  _toAssetMirrorPath(contentPath) {
    // Asset content paths like /Game/Discovery/MyAsset or /Game/Discovery/MyAsset.uasset
    // → _assets/Game/Discovery/MyAsset.uasset
    // Always append .uasset if no extension — avoids file/directory name collisions
    // (e.g., "Weapon_AR" can be both a leaf asset and a directory for child assets)
    let normalized = contentPath.replace(/\\/g, '/').replace(/^\//, '');
    if (!normalized.includes('.')) {
      normalized += '.uasset';
    }
    return `_assets/${normalized}`;
  }
}
