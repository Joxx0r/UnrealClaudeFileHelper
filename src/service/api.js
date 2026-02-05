import express from 'express';
import { Worker } from 'worker_threads';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { inflateSync } from 'zlib';
import { patternToTrigrams } from './trigram.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SLOW_QUERY_MS = 100;

export function createApi(database, indexer, queryPool = null) {
  const app = express();
  app.use(express.json());

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
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      memoryMB: {
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        rss: Math.round(mem.rss / 1024 / 1024)
      }
    });
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

      const opts = {
        fuzzy: fuzzy === 'true',
        project: project || null,
        language: language || null,
        kind: req.query.kind || null,
        maxResults: parseInt(maxResults, 10) || 10
      };

      const results = await poolQuery('findTypeByName', [name, opts]);
      res.json({ results });
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

      const opts = {
        fuzzy: fuzzy === 'true',
        containingType: containingType || null,
        memberKind: memberKind || null,
        project: project || null,
        language: language || null,
        maxResults: parseInt(maxResults, 10) || 20
      };

      const results = await poolQuery('findMember', [name, opts]);
      res.json({ results });
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

  // Extract literal substrings from simple alternation patterns for fast pre-filtering
  function extractLiterals(pattern) {
    if (/^[\w|]+$/.test(pattern)) return pattern.split('|').filter(s => s.length > 0);
    return null;
  }

  const GREP_TIMEOUT_MS = 30000;

  // Inline grep matching for trigram candidates (avoids worker thread overhead)
  function grepCandidates(candidates, regex, maxResults, contextLines) {
    const results = [];
    let totalMatches = 0;
    let filesSearched = 0;

    for (const entry of candidates) {
      if (results.length >= maxResults) break;
      filesSearched++;

      let content;
      try {
        content = inflateSync(entry.content).toString('utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = regex.exec(lines[i]);
        if (!match) continue;

        totalMatches++;
        if (results.length < maxResults) {
          const ctxStart = Math.max(0, i - contextLines);
          const ctxEnd = Math.min(lines.length - 1, i + contextLines);
          const context = [];
          for (let c = ctxStart; c <= ctxEnd; c++) {
            context.push(lines[c]);
          }
          results.push({
            file: entry.path,
            project: entry.project,
            language: entry.language,
            line: i + 1,
            column: match.index + 1,
            match: lines[i],
            context
          });
        }
        if (results.length >= maxResults) break;
      }
    }

    return { results, totalMatches, filesSearched };
  }

  app.get('/grep', async (req, res) => {
    const { pattern, project, language, caseSensitive: cs, maxResults: mr, contextLines: cl } = req.query;

    if (!pattern) {
      return res.status(400).json({ error: 'pattern parameter required' });
    }

    const caseSensitive = cs !== 'false';
    const maxResults = parseInt(mr, 10) || 50;
    const contextLines = parseInt(cl, 10) || 2;

    let regex;
    try {
      regex = new RegExp(pattern, caseSensitive ? '' : 'i');
    } catch (e) {
      return res.status(400).json({ error: `Invalid regex: ${e.message}` });
    }

    if (project && !database.projectExists(project)) {
      return res.status(400).json({ error: `Unknown project: ${project}` });
    }

    try {
      const useTrigramIndex = database.isTrigramIndexReady();

      if (useTrigramIndex) {
        const trigrams = patternToTrigrams(pattern, true);

        if (trigrams.length > 0) {
          // Full grep pipeline offloaded to worker: query + decompress + match
          const grepOpts = {
            project: project || null,
            language: (language && language !== 'all') ? language : null,
            trigrams
          };
          const result = await poolQuery('grepInline', [pattern, caseSensitive ? '' : 'i', maxResults, contextLines, grepOpts]);

          if (result !== null) {
            return res.json({
              results: result.results,
              totalMatches: result.totalMatches,
              truncated: result.results.length < result.totalMatches,
              timedOut: false,
              filesSearched: result.filesSearched
            });
          }
        }
      }
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    // Fallback: read files from disk via worker (trigram index not ready or unindexable pattern)
    const workerPath = join(__dirname, 'grep-worker.js');
    const dbFiles = database.getFilteredFiles(project || null, language || null);
    const files = dbFiles.map(f => ({ filePath: f.path, project: f.project, language: f.language }));
    const literals = extractLiterals(pattern);

    const worker = new Worker(workerPath, {
      workerData: { files, pattern, flags: caseSensitive ? '' : 'i', maxResults, contextLines, literals }
    });

    const timeoutId = setTimeout(() => {
      worker.postMessage('abort');
    }, GREP_TIMEOUT_MS);

    let responded = false;

    res.on('close', () => {
      if (!responded) {
        worker.postMessage('abort');
        clearTimeout(timeoutId);
        worker.terminate();
      }
    });

    worker.on('message', (msg) => {
      if (msg.type === 'complete') {
        clearTimeout(timeoutId);
        responded = true;
        res.json({
          results: msg.results,
          totalMatches: msg.totalMatches,
          truncated: msg.results.length < msg.totalMatches,
          timedOut: msg.aborted,
          filesSearched: msg.filesSearched
        });
        worker.terminate();
      }
    });

    worker.on('error', (err) => {
      clearTimeout(timeoutId);
      if (!responded) {
        responded = true;
        res.status(500).json({ error: err.message });
      }
      worker.terminate();
    });
  });

  return app;
}
