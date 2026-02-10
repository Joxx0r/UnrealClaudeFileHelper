import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { deflateSync } from 'zlib';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { rankResults, groupResultsByFile } from './search-ranking.js';
import { contentHash } from './trigram.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SLOW_QUERY_MS = 100;

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
function validateProject(database, project, res) {
  if (project && !database.projectExists(project)) {
    const available = database.getDistinctProjects();
    res.status(400).json({ error: `Unknown project: ${project}. Available projects: ${available.join(', ')}` });
    return true;
  }
  return false;
}

/** Build hints array for empty search results to guide agents. */
function buildEmptyResultHints(database, { project, fuzzy, supportsFuzzy = false }) {
  const hints = [];
  if (project) {
    hints.push(`No results in project '${project}'. Try removing the project filter to search all projects.`);
  }
  if (supportsFuzzy && !fuzzy) {
    hints.push('Try fuzzy=true for partial name matching.');
  }
  const available = database.getDistinctProjects();
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

export function createApi(database, indexer, queryPool = null, { zoektClient = null, zoektManager = null, zoektMirror = null } = {}) {
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

  // Execute a read query via the worker pool (parallel) or fall back to direct (sequential)
  async function poolQuery(method, args, timeoutMs = 30000) {
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
      projectFreshness
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
            processed++;
          } else if (database.deleteAsset(filePath)) {
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

          database.transaction(() => {
            const fileId = database.upsertFile(file.path, file.project, file.module, file.mtime, file.language, file.relativePath || null);
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

      const stats = database.getStats();
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

  app.get('/find-type', async (req, res) => {
    try {
      const { name, fuzzy, project, language, maxResults, includeAssets } = req.query;

      if (!name) {
        return res.status(400).json({ error: 'name parameter required' });
      }
      if (validateProject(database, project, res)) return;

      const mr = parseInt(maxResults, 10) || 10;

      const opts = {
        fuzzy: fuzzy === 'true',
        project: project || null,
        language: language || null,
        kind: req.query.kind || null,
        maxResults: mr,
        includeAssets: includeAssets === 'true' ? true : includeAssets === 'false' ? false : undefined
      };

      const results = await poolQuery('findTypeByName', [name, opts]);
      results.forEach(r => {
        if (r.path) r.path = cleanPath(r.path, r.project);
        if (r.implementationPath) r.implementationPath = cleanPath(r.implementationPath, r.project);
      });
      const response = { results };
      if (results.length === 0) {
        response.hints = buildEmptyResultHints(database, { project, fuzzy: opts.fuzzy, supportsFuzzy: true });
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
      if (validateProject(database, project, res)) return;

      const opts = {
        recursive: recursive !== 'false',
        project: project || null,
        language: language || null,
        maxResults: parseInt(maxResults, 10) || 50
      };

      const result = await poolQuery('findChildrenOf', [parent, opts]);
      if (result.results) result.results.forEach(r => { if (r.path) r.path = cleanPath(r.path, r.project); });
      if (result.results && result.results.length === 0) {
        result.hints = buildEmptyResultHints(database, { project });
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
      if (validateProject(database, project, res)) return;

      const opts = {
        project: project || null,
        language: language || null,
        maxResults: parseInt(maxResults, 10) || 100
      };

      const result = await poolQuery('browseModule', [module, opts]);
      if (result.types) result.types.forEach(r => { if (r.path) r.path = cleanPath(r.path, r.project); });
      if (result.files) result.files = result.files.map(f => cleanPath(f));
      if ((!result.types || result.types.length === 0) && (!result.files || result.files.length === 0)) {
        result.hints = buildEmptyResultHints(database, { project });
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
      if (validateProject(database, project, res)) return;

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
        response.hints = buildEmptyResultHints(database, { project });
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
      const { name, fuzzy, containingType, containingTypeHierarchy, memberKind, project, language, maxResults } = req.query;

      if (!name) {
        return res.status(400).json({ error: 'name parameter required' });
      }
      if (validateProject(database, project, res)) return;

      const mr = parseInt(maxResults, 10) || 20;

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
      results.forEach(r => { if (r.path) r.path = cleanPath(r.path, r.project); });
      const response = { results };
      if (results.length === 0) {
        response.hints = buildEmptyResultHints(database, { project, fuzzy: opts.fuzzy, supportsFuzzy: true });
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

  // --- Asset search ---

  app.get('/find-asset', async (req, res) => {
    try {
      const { name, fuzzy, project, folder, maxResults } = req.query;

      if (!name) {
        return res.status(400).json({ error: 'name parameter required' });
      }
      if (validateProject(database, project, res)) return;

      const opts = {
        fuzzy: fuzzy === 'true',
        project: project || null,
        folder: folder || null,
        maxResults: parseInt(maxResults, 10) || 20
      };

      const results = await poolQuery('findAssetByName', [name, opts]);
      const response = { results };
      if (results.length === 0) {
        response.hints = buildEmptyResultHints(database, { project, fuzzy: opts.fuzzy, supportsFuzzy: true });
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
      res.json(database.getAssetStats());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Query Analytics ---

  app.get('/query-analytics', (req, res) => {
    try {
      const { method, minDurationMs, limit, since, summary } = req.query;

      if (summary === 'true') {
        res.json(database.getQueryAnalyticsSummary());
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

    if (validateProject(database, project, res)) return;

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

      if (grouped !== 'false') {
        const groupedResponse = {
          results: groupResultsByFile(results),
          totalMatches: postFilterCount,
          truncated: postFilterCount > maxResults,
          grouped: true
        };
        if (assetResult.results.length > 0) groupedResponse.assets = assetResult.results;
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
