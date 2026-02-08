#!/usr/bin/env node

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { IndexDatabase } from './database.js';
import { createApi } from './api.js';
import { QueryPool } from './query-pool.js';
import { ZoektMirror } from './zoekt-mirror.js';
import { ZoektManager } from './zoekt-manager.js';
import { ZoektClient } from './zoekt-client.js';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function killExistingService(port) {
  try {
    const output = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' });
    for (const pid of output.trim().split('\n').filter(Boolean)) {
      console.log(`Killing existing service (PID ${pid})...`);
      try {
        execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
      } catch {}
    }
  } catch {}
}

class UnrealIndexService {
  constructor() {
    this.config = null;
    this.database = null;
    this.queryPool = null;
    this.server = null;
    this.zoektMirror = null;
    this.zoektManager = null;
    this.zoektClient = null;
  }

  async loadConfig() {
    const configPath = join(__dirname, '..', '..', 'config.json');

    if (!existsSync(configPath)) {
      throw new Error(
        `config.json not found at ${configPath}\n` +
        `Create a config.json with project definitions.`
      );
    }

    let configContent;
    try {
      configContent = await readFile(configPath, 'utf-8');
      // Strip UTF-8 BOM if present
      if (configContent.charCodeAt(0) === 0xFEFF) {
        configContent = configContent.slice(1);
      }
    } catch (err) {
      throw new Error(`Cannot read config.json: ${err.message}`);
    }

    try {
      this.config = JSON.parse(configContent);
    } catch (err) {
      throw new Error(`Invalid JSON in config.json: ${err.message}`);
    }

    // Validate projects
    if (!this.config.projects || !Array.isArray(this.config.projects) || this.config.projects.length === 0) {
      throw new Error(`config.json has no projects configured.`);
    }

    for (const project of this.config.projects) {
      if (!project.name) {
        console.warn(`WARNING: Project missing "name" field, skipping.`);
        continue;
      }
      if (!project.language) {
        console.warn(`WARNING: Project "${project.name}" has no "language" field. It will default to angelscript.`);
      }
    }

    this.config.service = this.config.service || { port: 3847, host: '127.0.0.1' };

    return this.config;
  }

  async initialize() {
    const totalStart = performance.now();
    await this.loadConfig();

    const { port, host } = this.config.service;

    let t = performance.now();
    killExistingService(port);
    console.log(`[Startup] kill existing: ${(performance.now() - t).toFixed(0)}ms`);

    // Database path — use config.data.dbPath or default to local data/index.db
    const dataConfig = this.config.data || {};
    const dbPath = dataConfig.dbPath
      ? dataConfig.dbPath.replace(/^~/, process.env.HOME || '')
      : join(__dirname, '..', '..', 'data', 'index.db');

    t = performance.now();
    this.database = new IndexDatabase(dbPath).open();
    console.log(`[Startup] database open: ${(performance.now() - t).toFixed(0)}ms`);

    // Compute inheritance depth if needed (before spawning workers so they get fresh data)
    if (this.database.getMetadata('depthComputeNeeded')) {
      t = performance.now();
      const depthCount = this.database.computeInheritanceDepth();
      console.log(`[Startup] inheritance depth: ${depthCount} types (${(performance.now() - t).toFixed(0)}ms)`);
    }

    // Spawn query worker pool
    const workerCount = Math.min(5, Math.max(1, os.cpus().length - 1));
    t = performance.now();
    this.queryPool = new QueryPool(dbPath, workerCount);
    await this.queryPool.spawn();
    const spawnMs = (performance.now() - t).toFixed(0);
    const warmupResults = await this.queryPool.warmup();
    const warmupMs = warmupResults.map(r => r.durationMs?.toFixed(0) || '?').join(', ');
    console.log(`[Startup] query pool: ${workerCount} workers (${spawnMs}ms spawn, warmup: ${warmupMs}ms)`);

    // Zoekt initialization
    const zoektConfig = this.config.zoekt || {};
    if (zoektConfig.enabled !== false) {
      t = performance.now();
      try {
        const dataDir = join(__dirname, '..', '..', 'data');
        const mirrorDir = dataConfig.mirrorDir
          ? dataConfig.mirrorDir.replace(/^~/, process.env.HOME || '')
          : (zoektConfig.mirrorDir
            ? join(__dirname, '..', '..', zoektConfig.mirrorDir)
            : join(dataDir, 'zoekt-mirror'));
        const indexDir = dataConfig.indexDir
          ? dataConfig.indexDir.replace(/^~/, process.env.HOME || '')
          : (zoektConfig.indexDir
            ? join(__dirname, '..', '..', zoektConfig.indexDir)
            : join(dataDir, 'zoekt-index'));

        this.zoektMirror = new ZoektMirror(mirrorDir);

        this.zoektManager = new ZoektManager({
          indexDir,
          webPort: zoektConfig.webPort || 6070,
          parallelism: zoektConfig.parallelism || 4,
          fileLimitBytes: zoektConfig.fileLimitBytes || 524288,
          reindexDebounceMs: zoektConfig.reindexDebounceMs || 5000,
          zoektBin: zoektConfig.zoektBin || null
        });

        if (!this.zoektManager.init()) {
          throw new Error('Zoekt binaries not found');
        }

        const mirrorProgress = (p) => {
          console.log(`[Startup] Mirror: ${p.written}/${p.total} (${Math.round(p.written / p.total * 100)}%) — ETA ${p.etaSeconds}s`);
        };

        const needsBootstrap = !this.zoektMirror.isReady();
        let mirrorIntegrityFailed = false;

        if (!needsBootstrap) {
          this.zoektMirror.loadPrefix(this.database);
          const check = this.zoektMirror.verifyIntegrity(this.database);
          if (!check.valid) {
            console.warn(`[Startup] Mirror integrity check failed: ${check.reason}, rebuilding...`);
            mirrorIntegrityFailed = true;
          } else {
            console.log(`[Startup] Mirror OK (${check.mirrorCount} files)`);
          }
        }

        if (needsBootstrap || mirrorIntegrityFailed) {
          // Check if DB has file_content to bootstrap from
          const hasContent = this.database.db.prepare(
            'SELECT 1 FROM file_content LIMIT 1'
          ).get();

          if (hasContent) {
            console.log('[Startup] Bootstrapping mirror from database...');
            this.zoektMirror.bootstrapFromDatabase(this.database, mirrorProgress);
          } else {
            console.log('[Startup] No mirror and no file_content — waiting for watcher to populate data');
          }
        }

        this.zoektManager.mirrorRoot = this.zoektMirror.getMirrorRoot();

        const started = await this.zoektManager.start();
        if (started) {
          this.zoektClient = new ZoektClient(this.zoektManager.getPort(), {
            timeoutMs: zoektConfig.searchTimeoutMs || 10000
          });
          console.log(`[Startup] Zoekt ready (${((performance.now() - t) / 1000).toFixed(1)}s) — grep search available`);
          // Run index in background — existing shards are already usable
          this.zoektManager.runIndex(this.zoektMirror.getMirrorRoot()).then(() => {
            console.log('[Startup] Zoekt index build complete');
          }).catch(indexErr => {
            console.warn(`[Startup] Zoekt index failed (using existing shards): ${indexErr.message}`);
          });
        } else {
          console.warn('[Startup] Zoekt unavailable — grep search will not work until Zoekt starts');
        }
      } catch (err) {
        console.warn(`[Startup] Zoekt initialization failed: ${err.message}`);
        console.warn('[Startup] Zoekt unavailable — grep search will not work until Zoekt starts');
      }
    }

    // The indexer param is passed to createApi for the /refresh endpoint.
    // With the WSL migration, we pass `this` which still has indexLanguageAsync/fullRebuild
    // for manual refresh, but the watcher handles all automatic indexing.
    const app = createApi(this.database, this, this.queryPool, {
      zoektClient: this.zoektClient,
      zoektManager: this.zoektManager,
      zoektMirror: this.zoektMirror
    });

    this.server = app.listen(port, host, () => {
      console.log(`[Startup] server listening at http://${host}:${port} (${((performance.now() - totalStart) / 1000).toFixed(1)}s total)`);
    });

    this.printIndexSummary();

    // Build asset content index if assets exist but haven't been indexed yet (migration)
    this.buildAssetContentIfNeeded();

    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  // Keep these for the /refresh API endpoint
  async indexLanguageAsync(language) {
    // Import BackgroundIndexer lazily only when /refresh is called
    const { BackgroundIndexer } = await import('./background-indexer.js');
    const indexer = new BackgroundIndexer(this.database, this.config);
    return indexer.indexLanguageAsync(language);
  }

  async fullRebuild() {
    const { BackgroundIndexer } = await import('./background-indexer.js');
    const indexer = new BackgroundIndexer(this.database, this.config);
    return indexer.fullRebuild();
  }

  buildAssetContentIfNeeded() {
    const hasAssets = this.database.db.prepare('SELECT 1 FROM assets LIMIT 1').get();
    const hasAssetFiles = this.database.db.prepare("SELECT 1 FROM files WHERE language = 'asset' LIMIT 1").get();
    if (hasAssets && !hasAssetFiles) {
      console.log('[Startup] Building asset content index for grep (one-time migration)...');
      const t = performance.now();
      const BATCH_SIZE = 5000;
      let total = 0;
      const allAssets = this.database.db.prepare(
        'SELECT name, content_path as contentPath, folder, project, extension, mtime, asset_class as assetClass, parent_class as parentClass FROM assets'
      ).all();
      for (let i = 0; i < allAssets.length; i += BATCH_SIZE) {
        this.database.indexAssetContent(allAssets.slice(i, i + BATCH_SIZE));
        total += Math.min(BATCH_SIZE, allAssets.length - i);
        if (total % 50000 === 0) console.log(`[Startup] asset content: ${total}/${allAssets.length}`);
      }
      console.log(`[Startup] Asset content index built: ${total} assets in ${((performance.now() - t) / 1000).toFixed(1)}s`);
    }
  }

  printIndexSummary() {
    const stats = this.database.getStats();
    const assetStats = this.database.getAssetStats();

    console.log('--- Index Summary ---');
    for (const [lang, langStats] of Object.entries(stats.byLanguage)) {
      if (lang === 'content') continue;
      if (lang === 'config') {
        console.log(`  ${lang}: ${langStats.files} files`);
      } else {
        console.log(`  ${lang}: ${langStats.files} files, ${langStats.types} types`);
      }
    }

    if (assetStats.total > 0) {
      const bpCount = assetStats.blueprintCount || 0;
      console.log(`  assets: ${assetStats.total} files (${bpCount} with class hierarchy)`);
    }

    const kindEntries = Object.entries(stats.byKind);
    if (kindEntries.length > 0) {
      console.log(`  Types: ${kindEntries.map(([k, v]) => `${v} ${k}s`).join(', ')}`);
    }

    const memberEntries = Object.entries(stats.byMemberKind);
    if (memberEntries.length > 0) {
      console.log(`  Members: ${stats.totalMembers} total (${memberEntries.map(([k, v]) => `${v} ${k.replace('_', ' ')}s`).join(', ')})`);
    } else {
      console.log(`  Members: 0 (run POST /refresh to rebuild with member indexing)`);
    }

    const trigramStats = this.database.getTrigramStats();
    if (trigramStats) {
      const ready = this.database.isTrigramIndexReady();
      console.log(`  Trigrams: ${trigramStats.filesWithContent} files, ${trigramStats.trigramRows} entries${ready ? '' : ' (building...)'}`);
    }
    console.log('---------------------');
  }

  shutdown() {
    console.log('Shutting down...');

    if (this.zoektManager) {
      this.zoektManager.stop();
    }

    if (this.queryPool) {
      this.queryPool.shutdown();
    }

    if (this.server) {
      this.server.close();
    }

    if (this.database) {
      this.database.close();
    }

    process.exit(0);
  }
}

const service = new UnrealIndexService();
service.initialize().catch(err => {
  console.error('Failed to start service:', err);
  process.exit(1);
});
