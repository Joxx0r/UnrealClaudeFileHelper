import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { deflateSync, inflateSync } from 'zlib';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { spawn, execSync } from 'child_process';
import { rankResults, groupResultsByFile } from './search-ranking.js';
import { contentHash } from './trigram.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SLOW_QUERY_MS = 100;

// Read git version at startup (commit hash for version comparison)
let SERVICE_VERSION = 'unknown';
try {
  const pkgPath = join(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  SERVICE_VERSION = pkg.version || 'unknown';
} catch {}
let SERVICE_GIT_HASH = 'unknown';
try {
  SERVICE_GIT_HASH = execSync('git rev-parse --short HEAD', { cwd: join(__dirname, '..', '..'), encoding: 'utf-8' }).trim();
} catch {}

// LRU+TTL cache for /grep results — agents often repeat the same search
class GrepCache {
  constructor(maxSize = 200, ttlMs = 30000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) { this.cache.delete(key); return undefined; }
    this.cache.delete(key); this.cache.set(key, entry); // LRU refresh
    return entry.data;
  }
  set(key, data) {
    if (this.cache.size >= this.maxSize) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, { data, ts: Date.now() });
  }
  invalidate() { this.cache.clear(); }
}

const grepCache = new GrepCache(200, 30000);

// Watcher heartbeat state — in-memory only, not persisted
const watcherState = {
  watchers: new Map(),   // watcherId → { ...payload, receivedAt }
  lastIngestAt: null,
  ingestCounts: { total: 0, files: 0, assets: 0, deletes: 0 }
};

/** Validate project parameter, returning a 400 response if invalid. Returns true if invalid (response sent). */
function validateProject(database, project, res, memIdx) {
  if (project) {
    const exists = (memIdx && memIdx.isLoaded) ? memIdx.projectExists(project) : database.projectExists(project);
    if (!exists) {
      const available = (memIdx && memIdx.isLoaded) ? memIdx.getDistinctProjects() : database.getDistinctProjects();
      res.status(400).json({ error: `Unknown project: ${project}. Available projects: ${available.join(', ')}` });
      return true;
    }
  }
  return false;
}

/** Build hints array for empty search results to guide agents. */
function buildEmptyResultHints(database, { project, fuzzy, supportsFuzzy = false }, memIdx) {
  const hints = [];
  if (project) {
    hints.push(`No results in project '${project}'. Try removing the project filter to search all projects.`);
  }
  if (supportsFuzzy && !fuzzy) {
    hints.push('Try fuzzy=true for partial name matching.');
  }
  const available = (memIdx && memIdx.isLoaded) ? memIdx.getDistinctProjects() : database.getDistinctProjects();
  if (available.length > 0) {
    hints.push(`Available projects: ${available.join(', ')}`);
  }
  return hints;
}

/** Extract basename from a full path if path separators are present. */
function extractFilename(input) {
  if (input.includes('/') || input.includes('\\')) {
    return input.split(/[/\\]/).pop() || input;
  }
  return input;
}

/** Attach source context lines to results that have path + line.
 *  Batch-fetches file content from DB, decompresses, extracts line windows.
 *  Mutates results in-place, adding context: { lines, startLine } */
function attachContextLines(results, contextLines, database, fileIdResolver) {
  if (!contextLines || contextLines <= 0 || results.length === 0) return;

  // Collect unique file IDs
  const fileIds = new Set();
  for (const r of results) {
    const fid = fileIdResolver(r);
    if (fid != null && r.line > 0) fileIds.add(fid);
  }
  if (fileIds.size === 0) return;

  const contentMap = database.getFileContentBatch([...fileIds]);

  // Cache decompressed line arrays per file
  const linesCache = new Map();
  const getLines = (fileId) => {
    if (linesCache.has(fileId)) return linesCache.get(fileId);
    const entry = contentMap.get(fileId);
    if (!entry || !entry.content) { linesCache.set(fileId, null); return null; }
    try {
      const text = inflateSync(entry.content).toString('utf-8');
      const lines = text.split('\n');
      linesCache.set(fileId, lines);
      return lines;
    } catch {
      linesCache.set(fileId, null);
      return null;
    }
  };

  for (const r of results) {
    const fid = fileIdResolver(r);
    if (fid == null || r.line <= 0) continue;
    const lines = getLines(fid);
    if (!lines) continue;

    const lineIdx = r.line - 1; // 0-indexed
    const startIdx = Math.max(0, lineIdx - contextLines);
    const endIdx = Math.min(lines.length - 1, lineIdx + contextLines);
    r.context = {
      startLine: startIdx + 1,
      lines: lines.slice(startIdx, endIdx + 1)
    };
  }
}

/** Attach just the signature line to member results. */
function attachSignatures(results, database, fileIdResolver) {
  if (results.length === 0) return;

  const fileIds = new Set();
  for (const r of results) {
    const fid = fileIdResolver(r);
    if (fid != null && r.line > 0) fileIds.add(fid);
  }
  if (fileIds.size === 0) return;

  const contentMap = database.getFileContentBatch([...fileIds]);
  const linesCache = new Map();
  const getLines = (fileId) => {
    if (linesCache.has(fileId)) return linesCache.get(fileId);
    const entry = contentMap.get(fileId);
    if (!entry || !entry.content) { linesCache.set(fileId, null); return null; }
    try {
      const text = inflateSync(entry.content).toString('utf-8');
      const lines = text.split('\n');
      linesCache.set(fileId, lines);
      return lines;
    } catch {
      linesCache.set(fileId, null);
      return null;
    }
  };

  for (const r of results) {
    const fid = fileIdResolver(r);
    if (fid == null || r.line <= 0) continue;
    const lines = getLines(fid);
    if (!lines) continue;
    const lineIdx = r.line - 1;
    if (lineIdx < lines.length) {
      r.signature = lines[lineIdx].trim();
    }
  }
}

export function createApi(database, indexer, queryPool = null, { zoektClient = null, zoektManager = null, zoektMirror = null, memoryIndex = null } = {}) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.static(join(__dirname, '..', '..', 'public')));

  // Compute per-project path prefixes (strip from responses to match Zoekt mirror paths)
  const projectPrefixes = new Map();
  let globalPrefix = '';
  try {
    const rows = database.db.prepare(
      "SELECT project, MIN(path) as min_path, MAX(path) as max_path FROM files WHERE language NOT IN ('content', 'asset') GROUP BY project"
    ).all();
    for (const row of rows) {
      if (row.min_path && row.max_path) {
        const a = row.min_path.replace(/\\/g, '/');
        const b = row.max_path.replace(/\\/g, '/');
        let prefix = a;
        while (prefix && !b.startsWith(prefix)) {
          prefix = prefix.slice(0, prefix.lastIndexOf('/'));
        }
        if (prefix && !prefix.endsWith('/')) prefix += '/';
        if (prefix) projectPrefixes.set(row.project, prefix);
      }
    }
    // Global fallback: common prefix across all projects
    const all = database.db.prepare(
      "SELECT MIN(path) as min_path, MAX(path) as max_path FROM files WHERE language NOT IN ('content', 'asset')"
    ).get();
    if (all && all.min_path && all.max_path) {
      const a = all.min_path.replace(/\\/g, '/');
      const b = all.max_path.replace(/\\/g, '/');
      globalPrefix = a;
      while (globalPrefix && !b.startsWith(globalPrefix)) {
        globalPrefix = globalPrefix.slice(0, globalPrefix.lastIndexOf('/'));
      }
      if (globalPrefix && !globalPrefix.endsWith('/')) globalPrefix += '/';
    }
  } catch {}

  function cleanPath(v, project) {
    if (typeof v !== 'string') return v;
    const normalized = v.replace(/\\/g, '/');
    // Per-project prefix: strip and prepend project name to match Zoekt mirror paths
    if (project) {
      const prefix = projectPrefixes.get(project);
      if (prefix && normalized.startsWith(prefix)) {
        return project + '/' + normalized.slice(prefix.length);
      }
    }
    // Fallback to global prefix
    return globalPrefix && normalized.startsWith(globalPrefix) ? normalized.slice(globalPrefix.length) : normalized;
  }

  function hasRegexMeta(s) {
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\') { i++; continue; }
      if ('.+*?^${}()|[]'.includes(s[i])) return true;
    }
    return false;
  }

  // Execute a read query: memory index (sync) → worker pool → direct database
  async function poolQuery(method, args, timeoutMs = 30000) {
    // Try in-memory index first (synchronous, sub-millisecond)
    if (memoryIndex && memoryIndex.isLoaded && typeof memoryIndex[method] === 'function') {
      const start = performance.now();
      const result = memoryIndex[method](...args);
      const durationMs = performance.now() - start;
      const resultCount = Array.isArray(result) ? result.length :
        result?.results ? result.results.length : null;
      database._logSlowQuery(method, args, durationMs, resultCount);
      return result;
    }
    // Fall back to worker pool or direct database
    if (queryPool) {
      const { result, durationMs } = await queryPool.execute(method, args, timeoutMs);
      const resultCount = Array.isArray(result) ? result.length :
        result?.results ? result.results.length : null;
      database._logSlowQuery(method, args, durationMs, resultCount);
      return result;
    }
    return database[method](...args);
  }

  // Request duration logging (skip /health to reduce noise)
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const start = performance.now();
    res.on('finish', () => {
      const ms = (performance.now() - start).toFixed(1);
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      console.log(`[${new Date().toISOString()}] [API] ${req.method} ${req.path}${query} — ${ms}ms (${res.statusCode})`);
    });
    next();
  });

  app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    const response = {
      status: 'ok',
      version: SERVICE_VERSION,
      gitHash: SERVICE_GIT_HASH,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      memoryMB: {
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        rss: Math.round(mem.rss / 1024 / 1024)
      }
    };
    if (zoektManager) {
      response.zoekt = zoektManager.getStatus();
    }
    if (memoryIndex) {
      response.memoryIndex = {
        loaded: memoryIndex.isLoaded,
        files: memoryIndex.filesById.size,
        types: memoryIndex.typesById.size,
        members: memoryIndex.membersById.size,
        assets: memoryIndex.assetsById.size
      };
    }
    response.queryMode = (memoryIndex && memoryIndex.isLoaded) ? 'memory' : (queryPool ? 'worker-pool' : 'direct');
    res.json(response);
  });

  // --- Watcher status (public, consumed by GUI) ---

  app.get('/watcher-status', (req, res) => {
    const watchers = [];
    const cutoff = Date.now() - 45000; // 3 missed heartbeats = stale

    for (const [id, w] of watcherState.watchers) {
      const receivedMs = new Date(w.receivedAt).getTime();
      watchers.push({
        ...w,
        status: receivedMs > cutoff ? 'active' : 'stale'
      });
    }

    // Per-project freshness from DB (last mtime per project)
    let projectFreshness = [];
    try {
      const rows = database.db.prepare(`
        SELECT project, MAX(mtime) as lastMtime
        FROM files WHERE language != 'asset'
        GROUP BY project
      `).all();
      projectFreshness = rows.map(p => ({
        project: p.project,
        lastFileModified: p.lastMtime || null
      }));
    } catch {}

    res.json({
      hasActiveWatcher: watchers.some(w => w.status === 'active'),
      watchers,
      lastIngestAt: watcherState.lastIngestAt,
      ingestCounts: watcherState.ingestCounts,
      projectFreshness,
      serviceVersion: SERVICE_VERSION,
      serviceGitHash: SERVICE_GIT_HASH
    });
  });

  // --- Internal endpoints (watcher → service communication) ---

  app.get('/internal/status', (req, res) => {
    try {
      const rows = database.db.prepare(
        "SELECT language, COUNT(*) as count FROM files WHERE language != 'asset' GROUP BY language"
      ).all();
      const counts = {};
      let total = 0;
      for (const row of rows) {
        counts[row.language] = row.count;
        total += row.count;
      }
      // Include asset counts so watcher knows content is populated
      const assetCount = database.db.prepare("SELECT COUNT(*) as count FROM assets").get().count;
      if (assetCount > 0) {
        counts['content'] = assetCount;
        total += assetCount;
      }
      res.json({ counts, isEmpty: total === 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/internal/file-mtimes', (req, res) => {
    try {
      const { language, project } = req.query;
      if (!language || !project) {
        return res.status(400).json({ error: 'language and project parameters required' });
      }
      // For text-searchable languages, report null mtime for files missing content
      // so the watcher re-ingests them (self-healing for previously content-less files)
      const needsContent = ['angelscript', 'cpp', 'config'].includes(language);
      const sql = needsContent
        ? `SELECT f.path, f.mtime, fc.file_id as has_content
           FROM files f LEFT JOIN file_content fc ON f.id = fc.file_id
           WHERE f.language = ? AND f.project = ?`
        : "SELECT path, mtime FROM files WHERE language = ? AND project = ?";
      const rows = database.db.prepare(sql).all(language, project);
      const mtimes = {};
      for (const row of rows) {
        mtimes[row.path] = (needsContent && !row.has_content) ? null : row.mtime;
      }
      res.json(mtimes);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/internal/asset-mtimes', (req, res) => {
    try {
      const { project } = req.query;
      if (!project) {
        return res.status(400).json({ error: 'project parameter required' });
      }
      const rows = database.db.prepare(
        "SELECT path, mtime FROM assets WHERE project = ?"
      ).all(project);
      const mtimes = {};
      for (const row of rows) {
        mtimes[row.path] = row.mtime;
      }
      res.json(mtimes);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/internal/ingest', (req, res) => {
    try {
      const { files = [], assets = [], deletes = [] } = req.body;
      const affectedProjects = new Set();
      let processed = 0;
      const errors = [];

      // Process deletes
      for (const filePath of deletes) {
        try {
          // Try source file first, then asset
          if (database.deleteFile(filePath)) {
            if (memoryIndex) memoryIndex.removeFileByPath(filePath);
            processed++;
          } else if (database.deleteAsset(filePath)) {
            if (memoryIndex) memoryIndex.removeAssetByPath(filePath);
            affectedProjects.add('_assets');
            processed++;
          }
          // Remove from mirror
          if (zoektMirror && zoektManager) {
            try {
              const relativePath = zoektMirror._toRelativePath(filePath);
              zoektManager.deleteMirrorFile(relativePath);
            } catch {}
          }
        } catch (err) {
          errors.push({ path: filePath, error: err.message });
        }
      }

      // Process source files
      for (const file of files) {
        try {
          // Mtime guard: skip re-processing if file hasn't changed
          // Exception: if file has content but no stored content yet, re-process
          const existing = database.getFileByPath(file.path);
          if (existing && existing.mtime === file.mtime) {
            const hasStoredContent = file.content ? !!database.getFileContent(existing.id) : true;
            if (hasStoredContent) {
              processed++;
              continue;
            }
          }

          let ingestFileId;
          database.transaction(() => {
            const fileId = database.upsertFile(file.path, file.project, file.module, file.mtime, file.language, file.relativePath || null);
            ingestFileId = fileId;
            database.clearTypesForFile(fileId);

            if (file.types && file.types.length > 0) {
              database.insertTypes(fileId, file.types);
            }

            if (file.members && file.members.length > 0) {
              const typeIds = database.getTypeIdsForFile(fileId);
              const nameToId = new Map(typeIds.map(t => [t.name, t.id]));
              const resolvedMembers = file.members.map(m => ({
                typeId: nameToId.get(m.ownerName) || null,
                name: m.name,
                memberKind: m.memberKind,
                line: m.line,
                isStatic: m.isStatic,
                specifiers: m.specifiers
              }));
              database.insertMembers(fileId, resolvedMembers);
            }

            if (file.content && file.content.length <= 2000000) {
              const compressed = deflateSync(file.content);
              const hash = contentHash(file.content);
              database.upsertFileContent(fileId, compressed, hash);

              // Write to Zoekt mirror
              if (zoektManager) {
                try {
                  const mirrorPath = file.relativePath
                    ? `${file.project}/${file.relativePath}`
                    : (zoektMirror ? zoektMirror._toRelativePath(file.path) : file.path);
                  zoektManager.updateMirrorFile(mirrorPath, file.content);
                } catch {}
              }
            }
          });

          // Sync memory index after successful transaction
          if (memoryIndex && ingestFileId) {
            memoryIndex.removeFile(ingestFileId);
            const baseLower = file.path.replace(/\\/g, '/');
            const lastSlash = baseLower.lastIndexOf('/');
            const fn = lastSlash >= 0 ? baseLower.substring(lastSlash + 1) : baseLower;
            const dotIdx = fn.lastIndexOf('.');
            const stem = dotIdx > 0 ? fn.substring(0, dotIdx) : fn;
            memoryIndex.addFile(ingestFileId, {
              path: file.path, project: file.project, module: file.module,
              language: file.language, mtime: file.mtime,
              basenameLower: stem.toLowerCase(),
              relativePath: file.relativePath || null
            });

            // Re-read types and members from DB (they now have correct IDs)
            const dbTypes = database.getTypeIdsForFile(ingestFileId);
            if (dbTypes.length > 0) {
              const typeRows = database.db.prepare(
                `SELECT id, name, kind, parent, line, depth FROM types WHERE file_id = ?`
              ).all(ingestFileId);
              memoryIndex.addTypes(ingestFileId, typeRows.map(t => ({
                id: t.id, name: t.name, kind: t.kind, parent: t.parent, line: t.line, depth: t.depth
              })));
            }

            const memberRows = database.db.prepare(
              `SELECT id, type_id as typeId, name, member_kind as memberKind, line, is_static as isStatic, specifiers FROM members WHERE file_id = ?`
            ).all(ingestFileId);
            if (memberRows.length > 0) {
              memoryIndex.addMembers(ingestFileId, memberRows);
            }
          }

          affectedProjects.add(file.project);
          processed++;
        } catch (err) {
          errors.push({ path: file.path, error: err.message });
        }
      }

      // Process assets
      if (assets.length > 0) {
        try {
          database.upsertAssetBatch(assets);
          database.indexAssetContent(assets);

          // Sync memory index with newly upserted assets
          if (memoryIndex) {
            const assetRows = [];
            for (const a of assets) {
              const row = database.db.prepare('SELECT id, path, name, content_path, folder, project, extension, mtime, asset_class, parent_class FROM assets WHERE path = ?').get(a.path);
              if (row) {
                assetRows.push({
                  id: row.id, path: row.path, name: row.name, contentPath: row.content_path,
                  folder: row.folder, project: row.project, extension: row.extension, mtime: row.mtime,
                  assetClass: row.asset_class, parentClass: row.parent_class
                });
              }
            }
            if (assetRows.length > 0) memoryIndex.upsertAssets(assetRows);
          }

          affectedProjects.add('_assets');
          processed += assets.length;
        } catch (err) {
          errors.push({ type: 'assets', error: err.message });
        }
      }

      // Flag inheritance depth for recomputation after new types are ingested
      if (processed > 0) {
        database.setMetadata('depthComputeNeeded', true);
        grepCache.invalidate();
        if (memoryIndex) memoryIndex.invalidateInheritanceCache();
      }

      // Track ingest activity for watcher status
      watcherState.lastIngestAt = new Date().toISOString();
      watcherState.ingestCounts.total += processed;
      watcherState.ingestCounts.files += files.length;
      watcherState.ingestCounts.assets += assets.length;
      watcherState.ingestCounts.deletes += deletes.length;

      // Trigger Zoekt reindex for affected projects
      if (zoektManager && affectedProjects.size > 0) {
        zoektManager.triggerReindex(processed, affectedProjects);
      }

      // Update mirror marker so bootstrapFromDatabase doesn't run on restart
      if (zoektMirror && processed > 0) {
        try {
          const fileCount = database.db.prepare(
            "SELECT COUNT(*) as c FROM file_content"
          ).get().c;
          if (zoektMirror.markerPath) {
            writeFileSync(zoektMirror.markerPath, JSON.stringify({
              timestamp: new Date().toISOString(),
              fileCount,
              source: 'ingest'
            }));
          }
        } catch {}
      }

      res.json({ processed, errors: errors.length > 0 ? errors : undefined });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/internal/heartbeat', (req, res) => {
    const hb = req.body;
    if (!hb || !hb.watcherId) {
      return res.status(400).json({ error: 'watcherId required' });
    }
    watcherState.watchers.set(hb.watcherId, {
      ...hb,
      receivedAt: new Date().toISOString()
    });
    // Prune stale watchers (not heard from in >60s)
    const cutoff = Date.now() - 60000;
    for (const [id, w] of watcherState.watchers) {
      if (new Date(w.receivedAt).getTime() < cutoff) {
        watcherState.watchers.delete(id);
      }
    }
    res.json({ ok: true });
  });

  app.post('/internal/start-watcher', (req, res) => {
    // Check if a watcher is already active
    const cutoff = Date.now() - 45000;
    for (const [, w] of watcherState.watchers) {
      if (new Date(w.receivedAt).getTime() > cutoff) {
        return res.status(409).json({ error: 'Watcher already active', watcherId: w.watcherId });
      }
    }

    // Read config to get Windows repo dir
    let config;
    try {
      const configPath = join(__dirname, '..', '..', 'config.json');
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      return res.status(500).json({ error: 'Could not read config.json' });
    }

    const winRepoDir = config.watcher?.windowsRepoDir;
    if (!winRepoDir) {
      return res.status(500).json({ error: 'watcher.windowsRepoDir not set in config.json' });
    }

    // The watcher runs on Windows — spawn via cmd.exe from WSL
    const watcherScript = `${winRepoDir}\\src\\watcher\\watcher-client.js`;
    const configFile = `${winRepoDir}\\config.json`;

    try {
      const child = spawn('/mnt/c/Windows/System32/cmd.exe', ['/c', 'start', '/b', 'node', watcherScript, configFile], {
        detached: true,
        stdio: 'ignore'
      });
      child.on('error', err => {
        console.error(`[API] Watcher spawn error: ${err.message}`);
      });
      child.unref();
      console.log(`[API] Started watcher via cmd.exe: node ${watcherScript}`);
      res.json({ ok: true, message: 'Watcher process started' });
    } catch (err) {
      console.error(`[API] Failed to start watcher: ${err.message}`);
      res.status(500).json({ error: `Failed to start watcher: ${err.message}` });
    }
  });

  app.post('/internal/restart-zoekt', async (req, res) => {
    if (!zoektManager) {
      return res.status(404).json({ error: 'Zoekt is not configured', hint: 'Enable zoekt in config.json and ensure Go/zoekt binaries are installed' });
    }
    try {
      console.log('[API] Restarting Zoekt...');
      await zoektManager.stop();
      // Reset restart attempts so it can try again
      zoektManager.restartAttempts = 0;
      zoektManager.maxRestartAttempts = 5;
      const started = await zoektManager.start();
      if (started) {
        res.json({ ok: true, message: 'Zoekt restarted successfully' });
      } else {
        res.status(500).json({ error: 'Zoekt failed to start after restart', hint: 'Check /tmp/unreal-index.log for details' });
      }
    } catch (err) {
      console.error(`[API] Zoekt restart failed: ${err.message}`);
      res.status(500).json({ error: `Zoekt restart failed: ${err.message}` });
    }
  });

  app.get('/status', (req, res) => {
    try {
      const allStatus = database.getAllIndexStatus();
      const statusMap = {};
      for (const s of allStatus) {
        statusMap[s.language] = {
          status: s.status,
          progress: s.progress_total > 0 ? `${s.progress_current}/${s.progress_total}` : null,
          progressPercent: s.progress_total > 0 ? Math.round((s.progress_current / s.progress_total) * 100) : null,
          error: s.error_message,
          lastUpdated: s.last_updated
        };
      }
      res.json(statusMap);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Stats cache — refreshed on a timer, never blocks request handling
  let statsCache = null;

  function refreshStatsCache() {
    try {
      // Recompute inheritance depth if flagged (debounced via timer)
      if (database.getMetadata('depthComputeNeeded')) {
        const t = performance.now();
        const count = database.computeInheritanceDepth();
        console.log(`[Stats] inheritance depth recomputed: ${count} types (${(performance.now() - t).toFixed(0)}ms)`);
      }

      const stats = (memoryIndex && memoryIndex.isLoaded) ? memoryIndex.getStats() : database.getStats();
      const lastBuild = database.getMetadata('lastBuild');
      const indexStatus = database.getAllIndexStatus();
      const trigramStats = database.getTrigramStats();
      const trigramReady = database.isTrigramIndexReady();
      const nameTrigramStats = database.getNameTrigramStats();
      statsCache = {
        ...stats,
        lastBuild,
        indexStatus,
        trigram: trigramStats ? { ...trigramStats, ready: trigramReady } : null,
        nameTrigram: nameTrigramStats
      };
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [Stats] cache refresh failed:`, err.message);
    }
  }

  // Refresh stats every 30 seconds in the background
  refreshStatsCache();
  app._statsInterval = setInterval(refreshStatsCache, 30000);

  app.get('/stats', (req, res) => {
    if (statsCache) {
      return res.json(statsCache);
    }
    // Fallback: compute on demand if cache hasn't been populated yet
    try {
      refreshStatsCache();
      res.json(statsCache);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Resolve file path → file ID using memory index or DB
  function resolveFileId(path) {
    if (!path) return null;
    if (memoryIndex && memoryIndex.isLoaded) {
      return memoryIndex.filesByPath.get(path) ?? null;
    }
    const row = database.db.prepare('SELECT id FROM files WHERE path = ?').get(path);
    return row ? row.id : null;
  }

  app.get('/find-type', async (req, res) => {
    try {
      const { name, fuzzy, project, language, maxResults, includeAssets, contextLines: cl } = req.query;

      if (!name) {
        return res.status(400).json({ error: 'name parameter required' });
      }
      if (validateProject(database, project, res, memoryIndex)) return;

      const mr = parseInt(maxResults, 10) || 10;
      const contextLines = cl !== undefined ? parseInt(cl, 10) : 0;

      const opts = {
        fuzzy: fuzzy === 'true',
        project: project || null,
        language: language || null,
        kind: req.query.kind || null,
        maxResults: mr,
        includeAssets: includeAssets === 'true' ? true : includeAssets === 'false' ? false : undefined
      };

      const results = await poolQuery('findTypeByName', [name, opts]);

      // Attach context lines before cleaning paths (need original paths for file ID lookup)
      if (contextLines > 0) {
        attachContextLines(results, contextLines, database, r => resolveFileId(r.path));
      }

      results.forEach(r => {
        if (r.path) r.path = cleanPath(r.path, r.project);
        if (r.implementationPath) r.implementationPath = cleanPath(r.implementationPath, r.project);
      });
      const response = { results };
      if (results.length === 0) {
        response.hints = buildEmptyResultHints(database, { project, fuzzy: opts.fuzzy, supportsFuzzy: true }, memoryIndex);
      }
      res.json(response);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/find-children', async (req, res) => {
    try {
      const { parent, recursive, project, language, maxResults } = req.query;

      if (!parent) {
        return res.status(400).json({ error: 'parent parameter required' });
      }
      if (validateProject(database, project, res, memoryIndex)) return;

      const opts = {
        recursive: recursive !== 'false',
        project: project || null,
        language: language || null,
        maxResults: parseInt(maxResults, 10) || 50
      };

      const result = await poolQuery('findChildrenOf', [parent, opts]);
      if (result.results) result.results.forEach(r => { if (r.path) r.path = cleanPath(r.path, r.project); });
      if (result.results && result.results.length === 0) {
        result.hints = buildEmptyResultHints(database, { project }, memoryIndex);
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/browse-module', async (req, res) => {
    try {
      const { module, project, language, maxResults } = req.query;

      if (!module) {
        return res.status(400).json({ error: 'module parameter required' });
      }
      if (validateProject(database, project, res, memoryIndex)) return;

      const opts = {
        project: project || null,
        language: language || null,
        maxResults: parseInt(maxResults, 10) || 100
      };

      const result = await poolQuery('browseModule', [module, opts]);
      if (result.types) result.types.forEach(r => { if (r.path) r.path = cleanPath(r.path, r.project); });
      if (result.files) result.files = result.files.map(f => cleanPath(f));
      if ((!result.types || result.types.length === 0) && (!result.files || result.files.length === 0)) {
        result.hints = buildEmptyResultHints(database, { project }, memoryIndex);
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/find-file', async (req, res) => {
    try {
      const { filename: rawFilename, project, language, maxResults } = req.query;

      if (!rawFilename) {
        return res.status(400).json({ error: 'filename parameter required' });
      }
      if (validateProject(database, project, res, memoryIndex)) return;

      const filename = extractFilename(rawFilename);

      const opts = {
        project: project || null,
        language: language || null,
        maxResults: parseInt(maxResults, 10) || 20
      };

      const results = await poolQuery('findFileByName', [filename, opts]);
      results.forEach(r => { if (r.file) r.file = cleanPath(r.file, r.project); });
      const response = { results };
      if (results.length === 0) {
        response.hints = buildEmptyResultHints(database, { project }, memoryIndex);
      }
      res.json(response);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/refresh', async (req, res) => {
    try {
      const { language } = req.query;

      if (language && language !== 'all') {
        await indexer.indexLanguageAsync(language);
        res.json({ success: true, language });
      } else {
        const stats = await indexer.fullRebuild();
        res.json({ success: true, stats });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/summary', (req, res) => {
    try {
      const stats = statsCache || database.getStats();
      const lastBuild = database.getMetadata('lastBuild');
      const indexStatus = statsCache?.indexStatus || database.getAllIndexStatus();

      res.json({
        generatedAt: lastBuild?.timestamp || null,
        stats,
        projects: Object.keys(stats.projects || {}),
        languages: Object.keys(stats.byLanguage || {}),
        buildTimeMs: lastBuild?.buildTimeMs || null,
        indexStatus
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/find-member', async (req, res) => {
    try {
      const { name, fuzzy, containingType, containingTypeHierarchy, memberKind, project, language, maxResults, contextLines: cl, includeSignatures: iSig } = req.query;

      if (!name) {
        return res.status(400).json({ error: 'name parameter required' });
      }
      if (validateProject(database, project, res, memoryIndex)) return;

      const mr = parseInt(maxResults, 10) || 20;
      const contextLines = cl !== undefined ? parseInt(cl, 10) : 0;
      const includeSignatures = iSig === 'true';

      const opts = {
        fuzzy: fuzzy === 'true',
        containingType: containingType || null,
        containingTypeHierarchy: containingTypeHierarchy === 'true',
        memberKind: memberKind || null,
        project: project || null,
        language: language || null,
        maxResults: mr
      };

      const results = await poolQuery('findMember', [name, opts]);

      // Attach context or signatures before cleaning paths
      if (contextLines > 0) {
        attachContextLines(results, contextLines, database, r => resolveFileId(r.path));
      } else if (includeSignatures) {
        attachSignatures(results, database, r => resolveFileId(r.path));
      }

      results.forEach(r => { if (r.path) r.path = cleanPath(r.path, r.project); });
      const response = { results };
      if (results.length === 0) {
        response.hints = buildEmptyResultHints(database, { project, fuzzy: opts.fuzzy, supportsFuzzy: true }, memoryIndex);
      }
      res.json(response);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/list-modules', async (req, res) => {
    try {
      const { parent, project, language, depth } = req.query;

      const opts = {
        project: project || null,
        language: language || null,
        depth: parseInt(depth, 10) || 1
      };

      const results = await poolQuery('listModules', [parent || '', opts]);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Compound explain-type endpoint (S3) ---

  app.get('/explain-type', async (req, res) => {
    try {
      const { name, project, language, contextLines: cl, includeMembers: im, includeChildren: ic, maxChildren: mc, maxFunctions: mf, maxProperties: mp } = req.query;

      if (!name) {
        return res.status(400).json({ error: 'name parameter required' });
      }
      if (validateProject(database, project, res, memoryIndex)) return;

      const startMs = performance.now();
      const contextLines = cl !== undefined ? parseInt(cl, 10) : 0;
      const includeMembers = im !== 'false';
      const includeChildren = ic !== 'false';
      const maxChildren = parseInt(mc, 10) || 20;

      // Step 1: Find the type
      const typeOpts = { project: project || null, language: language || null, maxResults: 1 };
      const typeResults = await poolQuery('findTypeByName', [name, typeOpts]);

      if (typeResults.length === 0) {
        const response = { type: null, hints: buildEmptyResultHints(database, { project, supportsFuzzy: true }, memoryIndex) };
        return res.json(response);
      }

      const typeResult = typeResults[0];
      const typeName = typeResult.name;

      // Attach context before cleaning path
      if (contextLines > 0) {
        attachContextLines([typeResult], contextLines, database, r => resolveFileId(r.path));
      }
      if (typeResult.path) typeResult.path = cleanPath(typeResult.path, typeResult.project);

      const response = { type: typeResult };

      // Step 2: Members — list all members of this type directly
      if (includeMembers) {
        const maxFunctions = parseInt(mf, 10) || 30;
        const maxProperties = parseInt(mp, 10) || 30;
        const memberOpts = {
          project: project || null,
          language: language || null,
          maxFunctions,
          maxProperties
        };
        const memberResult = await poolQuery('listMembersForType', [typeName, memberOpts]);
        const { functions, properties, enumValues, truncated } = memberResult;
        const allMembers = [...functions, ...properties, ...enumValues];

        // Attach signatures for members
        if (contextLines > 0) {
          attachContextLines(allMembers, contextLines, database, r => resolveFileId(r.path));
        } else {
          attachSignatures(allMembers, database, r => resolveFileId(r.path));
        }

        allMembers.forEach(r => { if (r.path) r.path = cleanPath(r.path, r.project); });

        response.members = { functions, properties, enumValues, count: allMembers.length, truncated };
      }

      // Step 3: Children
      if (includeChildren) {
        const childOpts = {
          recursive: true,
          project: project || null,
          language: language || null,
          maxResults: maxChildren
        };
        const childResult = await poolQuery('findChildrenOf', [typeName, childOpts]);
        if (childResult.results) {
          childResult.results.forEach(r => { if (r.path) r.path = cleanPath(r.path, r.project); });
        }
        response.children = childResult;
      }

      response.queryTimeMs = Math.round(performance.now() - startMs);
      res.json(response);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Asset search ---

  app.get('/find-asset', async (req, res) => {
    try {
      const { name, fuzzy, project, folder, maxResults } = req.query;

      if (!name) {
        return res.status(400).json({ error: 'name parameter required' });
      }
      if (validateProject(database, project, res, memoryIndex)) return;

      const opts = {
        fuzzy: fuzzy !== 'false',
        project: project || null,
        folder: folder || null,
        maxResults: parseInt(maxResults, 10) || 20
      };

      const results = await poolQuery('findAssetByName', [name, opts]);
      const response = { results };
      if (results.length === 0) {
        response.hints = buildEmptyResultHints(database, { project, fuzzy: opts.fuzzy, supportsFuzzy: true }, memoryIndex);
      }
      res.json(response);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/browse-assets', (req, res) => {
    try {
      const { folder, project, maxResults } = req.query;

      if (!folder) {
        return res.status(400).json({ error: 'folder parameter required' });
      }

      const result = database.browseAssetFolder(folder, {
        project: project || null,
        maxResults: parseInt(maxResults, 10) || 100
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/list-asset-folders', (req, res) => {
    try {
      const { parent, project, depth } = req.query;

      const results = database.listAssetFolders(parent || '/Game', {
        project: project || null,
        depth: parseInt(depth, 10) || 1
      });

      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/asset-stats', (req, res) => {
    try {
      res.json((memoryIndex && memoryIndex.isLoaded) ? memoryIndex.getAssetStats() : database.getAssetStats());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Query Analytics ---

  app.get('/query-analytics', (req, res) => {
    try {
      const { method, minDurationMs, limit, since, summary } = req.query;

      if (summary === 'true') {
        res.json(database.getQueryAnalyticsSummary(since || null));
      } else {
        const options = {
          method: method || null,
          minDurationMs: minDurationMs ? parseFloat(minDurationMs) : null,
          limit: limit ? parseInt(limit) : 100,
          since: since || null
        };
        res.json({ queries: database.getQueryAnalytics(options) });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/query-analytics', (req, res) => {
    try {
      if (req.query.all === 'true') {
        const result = database.db.prepare('DELETE FROM query_analytics').run();
        res.json({ deleted: result.changes, message: `Cleared all ${result.changes} analytics records` });
      } else {
        const daysOld = req.query.daysOld ? parseInt(req.query.daysOld) : 7;
        const deleted = database.cleanupOldAnalytics(daysOld);
        res.json({ deleted, message: `Deleted ${deleted} analytics records older than ${daysOld} days` });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- MCP Tool Analytics ---

  app.post('/internal/mcp-tool-call', (req, res) => {
    try {
      const { tool, args, durationMs, resultSize, sessionId } = req.body;
      if (!tool) return res.status(400).json({ error: 'tool required' });
      database.logMcpToolCall(tool, args || null, durationMs || null, resultSize || null, sessionId || null);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/mcp-tool-analytics', (req, res) => {
    try {
      const { summary, toolName, sessionId, limit, since } = req.query;
      if (summary === 'true') {
        res.json(database.getMcpToolSummary(since || null));
      } else {
        const calls = database.getMcpToolCalls({
          toolName: toolName || null,
          sessionId: sessionId || null,
          limit: limit ? parseInt(limit) : 100,
          since: since || null
        });
        res.json({ calls });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/mcp-tool-analytics', (req, res) => {
    try {
      if (req.query.all === 'true') {
        const result = database.db.prepare('DELETE FROM mcp_tool_analytics').run();
        res.json({ deleted: result.changes });
      } else {
        const daysOld = req.query.daysOld ? parseInt(req.query.daysOld) : 7;
        const deleted = database.cleanupOldMcpAnalytics(daysOld);
        res.json({ deleted });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Name Trigram Index ---

  app.get('/name-trigram-status', (req, res) => {
    try {
      res.json(database.getNameTrigramStats());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/build-name-trigrams', (req, res) => {
    try {
      if (database.isNameTrigramIndexReady()) {
        const stats = database.getNameTrigramStats();
        return res.json({ message: 'Name trigram index already built', ...stats });
      }

      console.log(`[${new Date().toISOString()}] [NameTrigram] Building index...`);
      const start = performance.now();

      const result = database.buildNameTrigramIndex((entityType, current, total) => {
        if (current % 10000 === 0) {
          console.log(`[${new Date().toISOString()}] [NameTrigram] ${entityType}: ${current}/${total}`);
        }
      });

      const duration = ((performance.now() - start) / 1000).toFixed(1);
      console.log(`[${new Date().toISOString()}] [NameTrigram] Build complete in ${duration}s`);

      refreshStatsCache();
      res.json({
        message: 'Name trigram index built successfully',
        types: result.types,
        members: result.members,
        durationSeconds: parseFloat(duration)
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Batch query endpoint (S6) ---

  const BATCH_ALLOWED_METHODS = new Set([
    'findTypeByName', 'findMember', 'findChildrenOf', 'findFileByName', 'findAssetByName', 'listModules', 'browseModule', 'listMembersForType'
  ]);

  // Methods whose results have a .path field that needs cleaning
  const BATCH_PATH_METHODS = new Set([
    'findTypeByName', 'findMember', 'findChildrenOf', 'findFileByName', 'listMembersForType'
  ]);

  app.post('/batch', async (req, res) => {
    try {
      const { queries } = req.body;
      if (!Array.isArray(queries) || queries.length === 0) {
        return res.status(400).json({ error: 'queries array required' });
      }
      if (queries.length > 10) {
        return res.status(400).json({ error: 'Maximum 10 queries per batch' });
      }

      const startMs = performance.now();
      const results = [];

      for (const q of queries) {
        const { method, args } = q;
        if (!method || !BATCH_ALLOWED_METHODS.has(method)) {
          results.push({ error: `Unknown or disallowed method: ${method}` });
          continue;
        }
        try {
          const argArray = Array.isArray(args) ? args : [args];
          const result = await poolQuery(method, argArray);

          // Post-process: attach contextLines/signatures (#36) and clean paths (#37)
          if (Array.isArray(result)) {
            const opts = argArray[1] || {};
            const ctxLines = parseInt(opts.contextLines, 10) || 0;

            if ((method === 'findMember' || method === 'findTypeByName') && ctxLines > 0) {
              attachContextLines(result, ctxLines, database, r => resolveFileId(r.path));
            }
            if (method === 'findMember' && opts.includeSignatures) {
              attachSignatures(result, database, r => resolveFileId(r.path));
            }
            if (BATCH_PATH_METHODS.has(method)) {
              result.forEach(r => {
                if (r.path) r.path = cleanPath(r.path, r.project);
                if (r.implementationPath) r.implementationPath = cleanPath(r.implementationPath, r.project);
              });
            }
          } else if (result && result.results && BATCH_PATH_METHODS.has(method)) {
            // findChildrenOf returns { results: [...] }
            result.results.forEach(r => {
              if (r.path) r.path = cleanPath(r.path, r.project);
              if (r.implementationPath) r.implementationPath = cleanPath(r.implementationPath, r.project);
            });
          }

          results.push({ result });
        } catch (err) {
          results.push({ error: err.message });
        }
      }

      res.json({ results, totalTimeMs: Math.round(performance.now() - startMs) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Content search (grep) ---

  app.get('/grep', async (req, res) => {
    const { pattern, project, language, caseSensitive: cs, maxResults: mr, contextLines: cl, grouped, includeAssets: ia, symbols: sym } = req.query;

    if (!pattern) {
      return res.status(400).json({ error: 'pattern parameter required' });
    }

    if (!zoektClient || !zoektManager?.isAvailable()) {
      return res.status(503).json({ error: 'Search not available (Zoekt not running). It may be restarting — retry in a few seconds.' });
    }

    const caseSensitive = cs !== 'false';
    const maxResults = parseInt(mr, 10) || 20;
    const contextLines = cl !== undefined ? parseInt(cl, 10) : 0;
    const includeAssets = ia === 'true';
    const skipSymbols = sym === 'false';

    // Check grep cache
    const cacheKey = `${pattern}|${project || ''}|${language || ''}|${cs}|${mr}|${cl}|${grouped}|${ia}|${sym}`;
    const cached = grepCache.get(cacheKey);
    if (cached) return res.json(cached);

    try {
      new RegExp(pattern, caseSensitive ? '' : 'i');
    } catch (e) {
      return res.status(400).json({ error: `Invalid regex: ${e.message}` });
    }

    if (validateProject(database, project, res, memoryIndex)) return;

    if (language === 'blueprint') {
      return res.status(400).json({ error: 'Blueprint content is binary and not text-searchable. Use find_type or find_asset to search blueprints by name.' });
    }

    const grepStartMs = performance.now();

    // Over-fetch from Zoekt when multi-word post-filter will discard many results
    const isMultiWord = !hasRegexMeta(pattern) && pattern.includes(' ');
    const zoektMaxResults = isMultiWord ? Math.max(maxResults * 5, 100) : maxResults;
    // Request context lines for proximity matching on multi-word queries
    const effectiveContextLines = isMultiWord ? Math.max(contextLines, 3) : contextLines;

    try {
      // Source search + optional asset search via Zoekt
      const sourcePromise = zoektClient.search(pattern, {
        project: project || null,
        language: (language && language !== 'all') ? language : null,
        caseSensitive,
        maxResults: zoektMaxResults,
        contextLines: effectiveContextLines
      });
      const assetPromise = includeAssets
        ? zoektClient.searchAssets(pattern, { project: project || null, caseSensitive, maxResults: 20 })
        : Promise.resolve({ results: [] });
      const [sourceResult, assetResult] = await Promise.all([sourcePromise, assetPromise]);

      // Clean paths and rank results
      let results = sourceResult.results.map(r => ({ ...r, file: cleanPath(r.file) }));

      // Post-filter: Zoekt tokenizes multi-word queries, so "class Foo" matches
      // lines with "class" OR "Foo" separately. For multi-word literal patterns,
      // require ALL words to appear in the match line or within nearby context lines.
      if (!hasRegexMeta(pattern) && pattern.includes(' ')) {
        const words = pattern.split(/\s+/).filter(Boolean);
        if (words.length > 1) {
          const needles = words.map(w => caseSensitive ? w : w.toLowerCase());
          results = results.filter(r => {
            const hay = caseSensitive ? r.match : r.match.toLowerCase();
            // Exact: all words on the same line
            if (needles.every(n => hay.includes(n))) return true;
            // Proximity: all words within match line + context lines
            if (r.context && r.context.length > 0) {
              const allText = [r.match, ...r.context].join(' ');
              const allHay = caseSensitive ? allText : allText.toLowerCase();
              if (needles.every(n => allHay.includes(n))) {
                r._proximityMatch = true;
                return true;
              }
            }
            return false;
          });
        }
      }

      const postFilterCount = results.length;

      const uniquePaths = [...new Set(results.map(r => r.file))];
      const mtimeMap = database.getFilesMtime(uniquePaths);

      // Symbol cross-reference: boost results at known type/member definitions
      // Skip when symbols=false (e.g. hook queries that don't need ranking precision)
      let symbolMap;
      if (skipSymbols) {
        symbolMap = new Map();
      } else {
        const fileLines = results.map(r => ({ path: r.file, line: r.line }));
        symbolMap = database.findSymbolsAtLocations(fileLines);
      }

      results = rankResults(results, mtimeMap, symbolMap);
      if (results.length > maxResults) results = results.slice(0, maxResults);

      const durationMs = Math.round(performance.now() - grepStartMs);
      const logFn = durationMs > 1000 ? console.warn : console.log;
      logFn(`[Grep] "${pattern.slice(0, 60)}" -> ${results.length} results (zoekt, ${durationMs}ms)`);

      // Log to query analytics
      database._logSlowQuery('grep', [pattern, project || '', language || ''], durationMs, results.length);

      // Build hints for zero-result greps to help agents understand why
      const grepHints = [];
      if (results.length === 0) {
        if (pattern.includes('\\n') || pattern.includes('\\r')) {
          grepHints.push('Pattern contains \\n (newline). Grep is line-based and cannot match across line boundaries. Split into separate single-line searches instead.');
        }
        if (pattern.includes('\\|')) {
          grepHints.push('Pattern contains \\| (escaped pipe = literal |). For alternation (OR), use unescaped | e.g. "patternA|patternB".');
        }
        if (project) {
          grepHints.push(`No results in project '${project}'. Try removing the project filter to search all projects.`);
        }
      }

      if (grouped !== 'false') {
        const groupedResponse = {
          results: groupResultsByFile(results),
          totalMatches: postFilterCount,
          truncated: postFilterCount > maxResults,
          grouped: true
        };
        if (assetResult.results.length > 0) groupedResponse.assets = assetResult.results;
        if (grepHints.length > 0) groupedResponse.hints = grepHints;
        grepCache.set(cacheKey, groupedResponse);
        return res.json(groupedResponse);
      }

      const response = {
        results,
        totalMatches: postFilterCount,
        truncated: postFilterCount > maxResults
      };
      if (assetResult.results.length > 0) {
        response.assets = assetResult.results;
      }
      if (grepHints.length > 0) response.hints = grepHints;
      grepCache.set(cacheKey, response);
      return res.json(response);
    } catch (err) {
      const durationMs = Math.round(performance.now() - grepStartMs);
      console.warn(`[Grep] "${pattern.slice(0, 60)}" -> error (${durationMs}ms): ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  });

  return app;
}
