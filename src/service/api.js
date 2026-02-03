import express from 'express';

export function createApi(database, indexer) {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

  app.get('/stats', (req, res) => {
    try {
      const stats = database.getStats();
      const lastBuild = database.getMetadata('lastBuild');
      const indexStatus = database.getAllIndexStatus();
      res.json({ ...stats, lastBuild, indexStatus });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/find-type', (req, res) => {
    try {
      const { name, fuzzy, project, language, maxResults } = req.query;

      if (!name) {
        return res.status(400).json({ error: 'name parameter required' });
      }

      const results = database.findTypeByName(name, {
        fuzzy: fuzzy === 'true',
        project: project || null,
        language: language || null,
        kind: req.query.kind || null,
        maxResults: parseInt(maxResults, 10) || 10
      });

      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/find-children', (req, res) => {
    try {
      const { parent, recursive, project, language, maxResults } = req.query;

      if (!parent) {
        return res.status(400).json({ error: 'parent parameter required' });
      }

      const result = database.findChildrenOf(parent, {
        recursive: recursive !== 'false',
        project: project || null,
        language: language || null,
        maxResults: parseInt(maxResults, 10) || 50
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/browse-module', (req, res) => {
    try {
      const { module, project, language, maxResults } = req.query;

      if (!module) {
        return res.status(400).json({ error: 'module parameter required' });
      }

      const result = database.browseModule(module, {
        project: project || null,
        language: language || null,
        maxResults: parseInt(maxResults, 10) || 100
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/find-file', (req, res) => {
    try {
      const { filename, project, language, maxResults } = req.query;

      if (!filename) {
        return res.status(400).json({ error: 'filename parameter required' });
      }

      const results = database.findFileByName(filename, {
        project: project || null,
        language: language || null,
        maxResults: parseInt(maxResults, 10) || 20
      });

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
      const stats = database.getStats();
      const lastBuild = database.getMetadata('lastBuild');
      const indexStatus = database.getAllIndexStatus();

      res.json({
        generatedAt: lastBuild?.timestamp || null,
        stats,
        projects: Object.keys(stats.projects),
        languages: Object.keys(stats.byLanguage || {}),
        buildTimeMs: lastBuild?.buildTimeMs || null,
        indexStatus
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/find-member', (req, res) => {
    try {
      const { name, fuzzy, containingType, memberKind, project, language, maxResults } = req.query;

      if (!name) {
        return res.status(400).json({ error: 'name parameter required' });
      }

      const results = database.findMember(name, {
        fuzzy: fuzzy === 'true',
        containingType: containingType || null,
        memberKind: memberKind || null,
        project: project || null,
        language: language || null,
        maxResults: parseInt(maxResults, 10) || 20
      });

      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/list-modules', (req, res) => {
    try {
      const { parent, project, language, depth } = req.query;

      const results = database.listModules(parent || '', {
        project: project || null,
        language: language || null,
        depth: parseInt(depth, 10) || 1
      });

      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}
