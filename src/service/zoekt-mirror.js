import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, rmSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { inflateSync } from 'zlib';

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

  /**
   * Rebuild the mirror directory from database file_content.
   * Used when mirror is missing/corrupt but DB has compressed content.
   */
  bootstrapFromDatabase(database, onProgress = null) {
    const startMs = performance.now();
    console.log('[ZoektMirror] Bootstrapping mirror from database...');

    // Clean mirror to remove stale files from old path schemes
    this._cleanMirror();

    // Compute per-project path prefixes (matches watcher's project/relativePath convention)
    const projectPrefixes = this._computeProjectPrefixes(database);

    const rows = database.db.prepare(
      `SELECT fc.content, f.path, f.language, f.project, f.relative_path FROM file_content fc
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
          : (row.relative_path
              ? row.project + '/' + row.relative_path
              : this._toProjectRelativePath(row.path, row.project, projectPrefixes));

        const fullPath = join(this.mirrorDir, relativePath);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content);

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
    console.log(`[ZoektMirror] Bootstrap complete: ${written} files (${assetCount} assets), ${errors} errors (${durationS}s)`);
    return written;
  }

  /**
   * Write a single file to the mirror directory.
   */
  updateFile(relativePath, content) {
    const fullPath = join(this.mirrorDir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
  }

  /**
   * Delete a single file from the mirror directory.
   */
  deleteFile(relativePath) {
    try {
      unlinkSync(join(this.mirrorDir, relativePath));
    } catch {}
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

  getPathPrefix() {
    return this.pathPrefix;
  }

  /**
   * Clean mirror directory contents (preserve the directory itself).
   */
  _cleanMirror() {
    try {
      for (const entry of readdirSync(this.mirrorDir)) {
        if (entry === '.zoekt-mirror-marker') continue;
        const entryPath = join(this.mirrorDir, entry);
        rmSync(entryPath, { recursive: true, force: true });
      }
    } catch {}
  }

  /**
   * Compute per-project path prefixes from DB file paths.
   * Returns { projectName: prefix } map where prefix is the base directory for that project.
   */
  _computeProjectPrefixes(database) {
    // Use MIN and MAX paths per project — their common prefix is always the broadest
    const rows = database.db.prepare(
      `SELECT project, MIN(path) as min_path, MAX(path) as max_path
       FROM files WHERE language NOT IN ('content', 'asset')
       GROUP BY project`
    ).all();

    const prefixes = {};
    for (const row of rows) {
      const a = row.min_path.replace(/\\/g, '/');
      const b = row.max_path.replace(/\\/g, '/');
      let prefix = a;
      while (prefix && !b.startsWith(prefix)) {
        prefix = prefix.slice(0, prefix.lastIndexOf('/'));
      }
      if (prefix && !prefix.endsWith('/')) prefix += '/';
      prefixes[row.project] = prefix;
    }
    return prefixes;
  }

  /**
   * Convert a full file path to project/relativePath mirror path.
   * Matches the watcher's convention: project + '/' + relativePath.
   */
  _toProjectRelativePath(fullPath, project, projectPrefixes) {
    const normalized = fullPath.replace(/\\/g, '/');
    const prefix = projectPrefixes[project];
    if (prefix && normalized.startsWith(prefix)) {
      return project + '/' + normalized.slice(prefix.length);
    }
    // Fallback: use global prefix
    if (this.pathPrefix && normalized.startsWith(this.pathPrefix)) {
      return normalized.slice(this.pathPrefix.length);
    }
    return normalized;
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
    let normalized = contentPath.replace(/\\/g, '/').replace(/^\//, '');
    if (!normalized.includes('.')) {
      normalized += '.uasset';
    }
    return `_assets/${normalized}`;
  }
}
