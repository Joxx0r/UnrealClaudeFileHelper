#!/usr/bin/env node

import { readFile } from 'fs/promises';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { readdirSync, statSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { IndexDatabase } from './database.js';
import { createApi } from './api.js';
import { FileWatcher } from './watcher.js';
import { BackgroundIndexer } from './background-indexer.js';
import { parseFile } from '../parser.js';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function killExistingService(port) {
  try {
    const netstatOutput = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
      encoding: 'utf-8',
      shell: 'cmd.exe'
    });

    const lines = netstatOutput.trim().split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && pid !== '0') {
        console.log(`Killing existing service (PID ${pid})...`);
        try {
          execSync(`taskkill /PID ${pid} /F`, { shell: 'cmd.exe', stdio: 'ignore' });
        } catch {
        }
      }
    }
  } catch {
  }
}

class UnrealIndexService {
  constructor() {
    this.config = null;
    this.database = null;
    this.watcher = null;
    this.server = null;
    this.backgroundIndexer = null;
  }

  async loadConfig() {
    const configPath = join(__dirname, '..', '..', 'config.json');

    if (!existsSync(configPath)) {
      throw new Error(
        `config.json not found at ${configPath}\n` +
        `Run setup.bat or: npm run setup`
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
      throw new Error(`Invalid JSON in config.json: ${err.message}\nRun setup.bat to regenerate.`);
    }

    // Validate projects
    if (!this.config.projects || !Array.isArray(this.config.projects) || this.config.projects.length === 0) {
      throw new Error(
        `config.json has no projects configured.\n` +
        `Run setup.bat or: npm run setup`
      );
    }

    // Validate and warn about project paths
    for (const project of this.config.projects) {
      if (!project.name) {
        console.warn(`WARNING: Project missing "name" field, skipping.`);
        continue;
      }
      if (!project.paths || project.paths.length === 0) {
        console.warn(`WARNING: Project "${project.name}" has no paths configured.`);
        continue;
      }
      if (!project.language) {
        console.warn(`WARNING: Project "${project.name}" has no "language" field. It will default to angelscript.`);
      }
      for (const p of project.paths) {
        if (!existsSync(p)) {
          console.warn(`WARNING: Path does not exist for "${project.name}": ${p}`);
        }
      }
    }

    this.config.service = this.config.service || { port: 3847, host: '127.0.0.1' };
    this.config.watcher = this.config.watcher || { debounceMs: 100 };

    return this.config;
  }

  async initialize() {
    const totalStart = performance.now();
    await this.loadConfig();

    const { port, host } = this.config.service;

    let t = performance.now();
    killExistingService(port);
    console.log(`[Startup] kill existing: ${(performance.now() - t).toFixed(0)}ms`);

    t = performance.now();
    const dbPath = join(__dirname, '..', '..', 'data', 'index.db');
    this.database = new IndexDatabase(dbPath).open();
    console.log(`[Startup] database open: ${(performance.now() - t).toFixed(0)}ms`);

    this.backgroundIndexer = new BackgroundIndexer(this.database, this.config);

    const angelscriptEmpty = this.database.isLanguageEmpty('angelscript');
    const cppEmpty = this.database.isLanguageEmpty('cpp');

    if (angelscriptEmpty) {
      t = performance.now();
      console.log('[Startup] AngelScript index empty, building synchronously...');
      await this.indexAngelscriptSync();
      console.log(`[Startup] angelscript sync index: ${((performance.now() - t) / 1000).toFixed(1)}s`);
    }

    const configEmpty = this.database.isLanguageEmpty('config');
    if (configEmpty) {
      t = performance.now();
      console.log('[Startup] Config index empty, building synchronously...');
      await this.indexConfigSync();
      console.log(`[Startup] config sync index: ${(performance.now() - t).toFixed(0)}ms`);
    }

    const app = createApi(this.database, this);

    this.server = app.listen(port, host, () => {
      console.log(`[Startup] server listening at http://${host}:${port} (${((performance.now() - totalStart) / 1000).toFixed(1)}s total)`);
    });

    this.watcher = new FileWatcher(this.config, this.database, {
      debounceMs: this.config.watcher.debounceMs,
      onUpdate: (stats) => {
        this.database.setMetadata('lastUpdate', {
          timestamp: new Date().toISOString(),
          ...stats
        });
      }
    });
    this.watcher.start();

    if (cppEmpty) {
      console.log('Starting C++ indexing in background...');
      this.backgroundIndexer.indexLanguageAsync('cpp').then(() => {
        console.log('C++ background indexing complete');
        this.printIndexSummary();
        if (this._onCppComplete) this._onCppComplete();
      }).catch(err => {
        console.error('C++ background indexing failed:', err);
      });
    }

    const assetsEmpty = this.database.isAssetIndexEmpty();
    if (assetsEmpty) {
      console.log('Starting asset indexing in background...');
      this.backgroundIndexer.indexAssets().then(() => {
        this.printIndexSummary();
      }).catch(err => {
        console.error('Asset indexing failed:', err);
      });
    }

    // Seed trigram count caches if missing (one-time migration)
    if (this.database.hasTrigramTables() &&
        (this.database.getMetadata('trigramCount') === null || this.database.getMetadata('trigramFileCount') === null)) {
      console.log('[Startup] Calculating trigram counts (one-time)...');
      const t2 = performance.now();
      this.database.recalculateTrigramCount();
      console.log(`[Startup] trigram counts cached: ${(performance.now() - t2).toFixed(0)}ms`);
    }

    this.printIndexSummary();

    // Build trigram index for files that don't have it yet (migration path)
    const needsTrigramBuild = this.database.getMetadata('trigramBuildNeeded');
    if (needsTrigramBuild) {
      const startTrigramBuild = () => {
        this.buildMissingTrigrams().catch(err => {
          console.error('[Trigram] Build failed:', err);
        });
      };

      if (cppEmpty) {
        // C++ is indexing in background — it will get trigrams via the pipeline.
        // Wait for it to finish, then build trigrams for remaining files.
        this._onCppComplete = startTrigramBuild;
      } else {
        startTrigramBuild();
      }
    }

    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  async indexAngelscriptSync() {
    const startTime = Date.now();
    console.log('Building AngelScript index...');

    let totalFiles = 0;
    let totalTypes = 0;

    const asProjects = this.config.projects.filter(p => p.language === 'angelscript');
    for (const project of asProjects) {
      for (const basePath of project.paths) {
        const { files, types } = await this.indexDirectory(basePath, project.name, basePath, 'angelscript');
        totalFiles += files;
        totalTypes += types;
      }
    }

    const buildTimeMs = Date.now() - startTime;
    console.log(`AngelScript index built: ${totalFiles} files, ${totalTypes} types in ${buildTimeMs}ms`);

    this.database.setIndexStatus('angelscript', 'ready', totalFiles, totalFiles);
    this.database.setMetadata('lastBuild', {
      timestamp: new Date().toISOString(),
      totalFiles,
      totalTypes,
      buildTimeMs,
      language: 'angelscript'
    });

    return { totalFiles, totalTypes, buildTimeMs };
  }

  async indexConfigSync() {
    let totalFiles = 0;
    const configProjects = this.config.projects.filter(p => p.language === 'config');
    for (const project of configProjects) {
      for (const basePath of project.paths) {
        const { files } = await this.indexDirectory(basePath, project.name, basePath, 'config', project.extensions);
        totalFiles += files;
      }
    }
    console.log(`Config index built: ${totalFiles} files`);
    this.database.setIndexStatus('config', 'ready', totalFiles, totalFiles);
    return { totalFiles };
  }

  async indexLanguageAsync(language) {
    return this.backgroundIndexer.indexLanguageAsync(language);
  }

  async fullRebuild() {
    const startTime = Date.now();
    console.log('Full rebuild starting...');

    await this.indexAngelscriptSync();

    this.backgroundIndexer.indexLanguageAsync('cpp').then(() => {
      const buildTimeMs = Date.now() - startTime;
      console.log(`Full rebuild complete in ${buildTimeMs}ms`);

      this.database.setMetadata('lastBuild', {
        timestamp: new Date().toISOString(),
        buildTimeMs
      });
    }).catch(err => {
      console.error('C++ indexing failed:', err);
    });

    return { status: 'started', message: 'AngelScript complete, C++ indexing in background' };
  }

  async indexDirectory(dirPath, projectName, basePath, language = 'angelscript', extensions = null) {
    let files = 0;
    let types = 0;

    if (!extensions) {
      extensions = language === 'cpp' ? ['.h', '.cpp'] : ['.as'];
    }

    const scanDir = async (dir) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (this.shouldExclude(fullPath)) continue;
          await scanDir(fullPath);
        } else if (entry.isFile()) {
          const hasMatchingExt = extensions.some(ext => entry.name.endsWith(ext));
          if (!hasMatchingExt) continue;
          if (this.shouldExclude(fullPath)) continue;

          try {
            const fileStat = statSync(fullPath);
            const mtime = Math.floor(fileStat.mtimeMs);
            const relativePath = relative(basePath, fullPath).replace(/\\/g, '/');
            const module = this.deriveModule(relativePath, projectName, language);

            // Config files (e.g. .ini) only need file-level indexing, no type parsing
            if (language === 'config') {
              this.database.upsertFile(fullPath, projectName, module, mtime, language);
              files++;
              continue;
            }

            const parsed = await parseFile(fullPath);

            this.database.transaction(() => {
              const fileId = this.database.upsertFile(fullPath, projectName, module, mtime, language);
              this.database.clearTypesForFile(fileId);

              const typeList = [];
              for (const cls of parsed.classes) {
                typeList.push({ name: cls.name, kind: cls.kind || 'class', parent: cls.parent, line: cls.line });
              }
              for (const struct of parsed.structs) {
                typeList.push({ name: struct.name, kind: 'struct', parent: struct.parent || null, line: struct.line });
              }
              for (const en of parsed.enums) {
                typeList.push({ name: en.name, kind: 'enum', parent: null, line: en.line });
              }
              if (language === 'angelscript') {
                for (const event of parsed.events || []) {
                  typeList.push({ name: event.name, kind: 'event', parent: null, line: event.line });
                }
                for (const delegate of parsed.delegates || []) {
                  typeList.push({ name: delegate.name, kind: 'delegate', parent: null, line: delegate.line });
                }
                for (const ns of parsed.namespaces || []) {
                  typeList.push({ name: ns.name, kind: 'namespace', parent: null, line: ns.line });
                }
              }
              // C++ delegates from DECLARE_*DELEGATE* macros
              if (language === 'cpp') {
                for (const del of parsed.delegates || []) {
                  typeList.push({ name: del.name, kind: 'delegate', parent: null, line: del.line });
                }
              }

              if (typeList.length > 0) {
                this.database.insertTypes(fileId, typeList);
              }

              // Insert members (functions, properties, enum values)
              if (parsed.members && parsed.members.length > 0) {
                const typeIds = this.database.getTypeIdsForFile(fileId);
                const nameToId = new Map(typeIds.map(t => [t.name, t.id]));

                const resolvedMembers = parsed.members.map(m => ({
                  typeId: nameToId.get(m.ownerName) || null,
                  name: m.name,
                  memberKind: m.memberKind,
                  line: m.line,
                  isStatic: m.isStatic,
                  specifiers: m.specifiers
                }));

                this.database.insertMembers(fileId, resolvedMembers);
              }

              types += typeList.length;
            });

            files++;
          } catch (err) {
          }
        }
      }
    };

    await scanDir(dirPath);
    return { files, types };
  }

  shouldExclude(path) {
    const normalizedPath = path.replace(/\\/g, '/');
    for (const pattern of this.config.exclude || []) {
      if (pattern.includes('**')) {
        const regex = new RegExp(pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'));
        if (regex.test(normalizedPath)) return true;
      } else if (normalizedPath.includes(pattern.replace(/\*/g, ''))) {
        return true;
      }
    }
    return false;
  }

  deriveModule(relativePath, projectName, language = 'angelscript') {
    const parts = relativePath.replace(/\.(as|h|cpp)$/, '').split('/');
    parts.pop();
    return [projectName, ...parts].join('.');
  }

  async buildMissingTrigrams() {
    const missingFiles = this.database.getFilesWithoutContent();
    if (missingFiles.length === 0) {
      console.log('[Trigram] All files already have trigram data');
      this.database.setMetadata('trigramBuildNeeded', false);
      return;
    }

    console.log(`[Trigram] Building trigram index for ${missingFiles.length} files...`);
    const buildStart = performance.now();

    const workerCount = Math.min(8, os.cpus().length);
    const workerPath = join(__dirname, 'trigram-build-worker.js');
    const WAVE_SIZE = 2000;
    const INSERT_BATCH = 100;
    let totalProcessed = 0;

    for (let w = 0; w < missingFiles.length; w += WAVE_SIZE) {
      const wave = missingFiles.slice(w, w + WAVE_SIZE);
      const chunkSize = Math.ceil(wave.length / workerCount);
      const chunks = [];
      for (let i = 0; i < wave.length; i += chunkSize) {
        chunks.push(wave.slice(i, i + chunkSize));
      }

      const waveStart = performance.now();
      const workerPromises = chunks.map(chunk =>
        new Promise((resolve, reject) => {
          const worker = new Worker(workerPath, { workerData: { files: chunk } });
          worker.on('message', msg => {
            if (msg.type === 'complete') resolve(msg.results);
          });
          worker.on('error', reject);
          worker.on('exit', code => {
            if (code !== 0) reject(new Error(`Trigram worker exited with code ${code}`));
          });
        })
      );

      const waveResults = (await Promise.all(workerPromises)).flat();

      // Insert in small batches with event loop yields
      for (let i = 0; i < waveResults.length; i += INSERT_BATCH) {
        const batch = waveResults.slice(i, i + INSERT_BATCH);
        this.database.transaction(() => {
          for (const result of batch) {
            this.database.upsertFileContent(result.fileId, result.compressedContent, result.contentHash);
            this.database.clearTrigramsForFile(result.fileId);
            if (result.trigrams.length > 0) {
              this.database.insertTrigrams(result.fileId, result.trigrams);
            }
          }
        });
        await new Promise(resolve => setImmediate(resolve));
      }

      totalProcessed += waveResults.length;
      const waveMs = ((performance.now() - waveStart) / 1000).toFixed(1);
      console.log(`[Trigram] Wave ${Math.floor(w / WAVE_SIZE) + 1}: ${totalProcessed}/${missingFiles.length} files (${waveMs}s)`);
    }

    this.database.setMetadata('trigramBuildNeeded', false);
    // Recalculate exact trigram count after full build
    const exactCount = this.database.recalculateTrigramCount();
    const totalTime = ((performance.now() - buildStart) / 1000).toFixed(1);
    const stats = this.database.getTrigramStats();
    console.log(`[Trigram] Build complete in ${totalTime}s: ${stats.filesWithContent} files, ${exactCount} trigram entries`);
  }

  printIndexSummary() {
    const stats = this.database.getStats();
    const assetStats = this.database.getAssetStats();

    console.log('--- Index Summary ---');
    for (const [lang, langStats] of Object.entries(stats.byLanguage)) {
      if (lang === 'content') continue; // shown separately as assets
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

    if (this.watcher) {
      this.watcher.stop();
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
