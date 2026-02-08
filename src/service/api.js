import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { rankResults, groupResultsByFile } from './search-ranking.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SLOW_QUERY_MS = 100;

export function createApi(database, indexer, queryPool = null, { zoektClient = null, zoektManager = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, '..', '..', 'public')));

  // Compute common path prefix for all indexed files (strip from responses)
  let pathPrefix = '';
  try {
    const sample = database.db.prepare(
      "SELECT path FROM files WHERE language != 'asset' LIMIT 100"
    ).all().map(r => r.path.replace(/\\/g, '/'));
    if (sample.length > 0) {
      pathPrefix = sample[0];
      for (const p of sample) {
        while (pathPrefix && !p.startsWith(pathPrefix)) {
          pathPrefix = pathPrefix.slice(0, pathPrefix.lastIndexOf('/'));
        }
      }
      if (pathPrefix && !pathPrefix.endsWith('/')) pathPrefix += '/';
    }
  } catch {}

  function cleanPath(v) {
    if (typeof v !== 'string') return v;
    const normalized = v.replace(/\\/g, '/');
    return pathPrefix && normalized.startsWith(pathPrefix) ? normalized.slice(pathPrefix.length) : normalized;
  }

  // Execute a read query via the worker pool (parallel) or fall back to direct (sequential)
  async function poolQuery(method, args, timeoutMs = 30000) {
    if (queryPool) {
      const { result, durationMs } = await queryPool.execute(method, args, timeoutMs);
      if (durationMs >= SLOW_QUERY_MS) {
        const resultCount = Array.isArray(result) ? result.length :
          result?.results ? result.results.length : null;
        database._logSlowQuery(method, args, durationMs, resultCount);
      }
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
  setInterval(refreshStatsCache, 30000);

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
      const { name, fuzzy, project, language, maxResults } = req.query;

      if (!name) {
        return res.status(400).json({ error: 'name parameter required' });
      }

      const mr = parseInt(maxResults, 10) || 10;

      const opts = {
        fuzzy: fuzzy === 'true',
        project: project || null,
        language: language || null,
        kind: req.query.kind || null,
        maxResults: mr
      };

      const results = await poolQuery('findTypeByName', [name, opts]);
      res.json({ results, source: 'database' });
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

      const opts = {
        recursive: recursive !== 'false',
        project: project || null,
        language: language || null,
        maxResults: parseInt(maxResults, 10) || 50
      };

      const result = await poolQuery('findChildrenOf', [parent, opts]);
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

      const opts = {
        project: project || null,
        language: language || null,
        maxResults: parseInt(maxResults, 10) || 100
      };

      const result = await poolQuery('browseModule', [module, opts]);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/find-file', async (req, res) => {
    try {
      const { filename, project, language, maxResults } = req.query;

      if (!filename) {
        return res.status(400).json({ error: 'filename parameter required' });
      }

      const opts = {
        project: project || null,
        language: language || null,
        maxResults: parseInt(maxResults, 10) || 20
      };

      const results = await poolQuery('findFileByName', [filename, opts]);
      res.json({ results });
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
      const { name, fuzzy, containingType, memberKind, project, language, maxResults } = req.query;

      if (!name) {
        return res.status(400).json({ error: 'name parameter required' });
      }

      const mr = parseInt(maxResults, 10) || 20;

      const opts = {
        fuzzy: fuzzy === 'true',
        containingType: containingType || null,
        memberKind: memberKind || null,
        project: project || null,
        language: language || null,
        maxResults: mr
      };

      const results = await poolQuery('findMember', [name, opts]);
      res.json({ results, source: 'database' });
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

      const opts = {
        fuzzy: fuzzy === 'true',
        project: project || null,
        folder: folder || null,
        maxResults: parseInt(maxResults, 10) || 20
      };

      const results = await poolQuery('findAssetByName', [name, opts]);
      res.json({ results });
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
      const daysOld = req.query.daysOld ? parseInt(req.query.daysOld) : 7;
      const deleted = database.cleanupOldAnalytics(daysOld);
      res.json({ deleted, message: `Deleted ${deleted} analytics records older than ${daysOld} days` });
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
    const { pattern, project, language, caseSensitive: cs, maxResults: mr, contextLines: cl, grouped } = req.query;

    if (!pattern) {
      return res.status(400).json({ error: 'pattern parameter required' });
    }

    if (!zoektClient || !zoektManager?.isAvailable()) {
      return res.status(503).json({ error: 'Search not available (Zoekt not running). It may be restarting — retry in a few seconds.' });
    }

    const caseSensitive = cs !== 'false';
    const maxResults = parseInt(mr, 10) || 50;
    const contextLines = parseInt(cl, 10) || 2;

    try {
      new RegExp(pattern, caseSensitive ? '' : 'i');
    } catch (e) {
      return res.status(400).json({ error: `Invalid regex: ${e.message}` });
    }

    if (project && !database.projectExists(project)) {
      return res.status(400).json({ error: `Unknown project: ${project}` });
    }

    const grepStartMs = performance.now();

    try {
      // Source + asset search via Zoekt in parallel
      const [sourceResult, assetResult] = await Promise.all([
        zoektClient.search(pattern, {
          project: project || null,
          language: (language && language !== 'all') ? language : null,
          caseSensitive,
          maxResults,
          contextLines
        }),
        zoektClient.searchAssets(pattern, {
          project: project || null,
          caseSensitive,
          maxResults: 20
        })
      ]);

      // Clean paths and rank results
      let results = sourceResult.results.map(r => ({ ...r, file: cleanPath(r.file) }));

      const uniquePaths = [...new Set(results.map(r => r.file))];
      const mtimeMap = database.getFilesMtime(uniquePaths);
      results = rankResults(results, mtimeMap);

      const durationMs = Math.round(performance.now() - grepStartMs);
      const logFn = durationMs > 1000 ? console.warn : console.log;
      logFn(`[Grep] "${pattern.slice(0, 60)}" -> ${results.length} results (zoekt, ${durationMs}ms)`);

      if (grouped === 'true') {
        return res.json({
          results: groupResultsByFile(results),
          totalMatches: sourceResult.totalMatches,
          truncated: sourceResult.results.length < sourceResult.totalMatches,
          timedOut: false,
          filesSearched: sourceResult.filesSearched,
          searchEngine: 'zoekt',
          zoektDurationMs: sourceResult.zoektDurationMs,
          grouped: true,
          assets: assetResult.results.length > 0 ? assetResult.results : undefined
        });
      }

      const response = {
        results,
        totalMatches: sourceResult.totalMatches,
        truncated: sourceResult.results.length < sourceResult.totalMatches,
        timedOut: false,
        filesSearched: sourceResult.filesSearched,
        searchEngine: 'zoekt',
        zoektDurationMs: sourceResult.zoektDurationMs
      };
      if (assetResult.results.length > 0) {
        response.assets = assetResult.results;
      }
      return res.json(response);
    } catch (err) {
      const durationMs = Math.round(performance.now() - grepStartMs);
      console.warn(`[Grep] "${pattern.slice(0, 60)}" -> error (${durationMs}ms): ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  });

  return app;
}
