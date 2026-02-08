import { Worker } from 'worker_threads';
import { readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { parseUAssetHeader } from '../parsers/uasset-parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class BackgroundIndexer {
  constructor(database, config) {
    this.database = database;
    this.config = config;
    this.isIndexing = false;
    this.abortController = null;
  }

  async indexLanguageAsync(language) {
    if (this.isIndexing) {
      console.log(`Already indexing, skipping ${language}`);
      return;
    }

    this.isIndexing = true;
    this.abortController = new AbortController();

    try {
      const projects = this.config.projects.filter(p => p.language === language);
      if (projects.length === 0) {
        console.log(`No projects configured for language: ${language}`);
        return;
      }

      const collectStart = performance.now();
      const files = [];
      for (const project of projects) {
        const extensions = project.extensions || (language === 'cpp' ? ['.h', '.cpp'] : ['.as']);
        for (const basePath of project.paths) {
          const projectFiles = this.collectFiles(basePath, project.name, extensions, language);
          files.push(...projectFiles);
        }
      }

      console.log(`[Indexer] collectFiles ${language}: ${((performance.now() - collectStart) / 1000).toFixed(1)}s (${files.length} files)`);
      this.database.setIndexStatus(language, 'indexing', 0, files.length);

      const workerCount = Math.min(8, os.cpus().length);
      const chunkSize = Math.ceil(files.length / workerCount);
      const chunks = [];

      for (let i = 0; i < files.length; i += chunkSize) {
        chunks.push(files.slice(i, i + chunkSize));
      }

      console.log(`[Indexer] starting ${chunks.length} workers for ${language}`);
      const workerStart = performance.now();

      const workerPromises = chunks.map((chunk, index) =>
        this.runWorker(chunk, language, index)
      );

      const results = await Promise.all(workerPromises);
      console.log(`[Indexer] workers ${language}: ${((performance.now() - workerStart) / 1000).toFixed(1)}s`);

      let totalProcessed = 0;
      let totalTypes = 0;

      const allFileResults = [];
      for (const result of results) {
        totalProcessed += result.filesProcessed;
        totalTypes += result.typesFound;
        allFileResults.push(...result.results);
      }

      const insertStart = performance.now();
      console.log(`[Indexer] ${language} workers done: ${totalProcessed} files parsed, inserting into database...`);

      const BATCH_SIZE = 100;
      for (let i = 0; i < allFileResults.length; i += BATCH_SIZE) {
        const batch = allFileResults.slice(i, i + BATCH_SIZE);

        this.database.transaction(() => {
          for (const fileResult of batch) {
            const fileId = this.database.upsertFile(
              fileResult.path,
              fileResult.project,
              fileResult.module,
              fileResult.mtime,
              language
            );
            this.database.clearTypesForFile(fileId);

            if (fileResult.types.length > 0) {
              this.database.insertTypesBatch(fileId, fileResult.types);
            }

            // Insert members (functions, properties, enum values)
            const members = fileResult.members || [];
            if (members.length > 0) {
              const typeIds = this.database.getTypeIdsForFile(fileId);
              const nameToId = new Map(typeIds.map(t => [t.name, t.id]));

              const resolvedMembers = members.map(m => ({
                typeId: nameToId.get(m.ownerName) || null,
                name: m.name,
                memberKind: m.memberKind,
                line: m.line,
                isStatic: m.isStatic,
                specifiers: m.specifiers
              }));

              this.database.insertMembers(fileId, resolvedMembers);
            }

            // Insert compressed content for Zoekt mirror bootstrap
            if (fileResult.compressedContent) {
              this.database.upsertFileContent(fileId, fileResult.compressedContent, fileResult.contentHash);
            }
          }
        });

        this.database.setIndexStatus(language, 'indexing', i + batch.length, allFileResults.length);

        await new Promise(resolve => setImmediate(resolve));
      }

      console.log(`[Indexer] db insert ${language}: ${((performance.now() - insertStart) / 1000).toFixed(1)}s`)
      console.log(`[Indexer] ${language} complete: ${totalProcessed} files, ${totalTypes} types`);
      this.database.setIndexStatus(language, 'ready', allFileResults.length, allFileResults.length);

    } catch (error) {
      console.error(`Error indexing ${language}:`, error);
      this.database.setIndexStatus(language, 'error', 0, 0, error.message);
    } finally {
      this.isIndexing = false;
      this.abortController = null;
    }
  }

  collectFiles(dirPath, projectName, extensions, language) {
    const files = [];

    const scanDir = (dir) => {
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
          scanDir(fullPath);
        } else if (entry.isFile()) {
          const hasMatchingExt = extensions.some(ext => entry.name.endsWith(ext));
          if (!hasMatchingExt) continue;
          if (this.shouldExclude(fullPath)) continue;

          try {
            const fileStat = statSync(fullPath);
            const mtime = Math.floor(fileStat.mtimeMs);
            const relativePath = relative(dirPath, fullPath).replace(/\\/g, '/');
            const module = this.deriveModule(relativePath, projectName);

            files.push({
              path: fullPath,
              project: projectName,
              module,
              mtime,
              basePath: dirPath
            });
          } catch {
          }
        }
      }
    };

    scanDir(dirPath);
    return files;
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

  deriveModule(relativePath, projectName) {
    const parts = relativePath.replace(/\.(as|h|cpp)$/, '').split('/');
    parts.pop();
    return [projectName, ...parts].join('.');
  }

  runWorker(files, language, workerIndex) {
    return new Promise((resolve, reject) => {
      const workerPath = join(__dirname, 'index-worker.js');

      const worker = new Worker(workerPath, {
        workerData: { files, language, workerIndex }
      });

      worker.on('message', (message) => {
        if (message.type === 'progress') {
          const currentStatus = this.database.getIndexStatus(language);
          this.database.setIndexStatus(
            language,
            'indexing',
            currentStatus.progress_current + message.processed,
            currentStatus.progress_total
          );
        } else if (message.type === 'complete') {
          resolve(message.result);
        }
      });

      worker.on('error', reject);

      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker ${workerIndex} exited with code ${code}`));
        }
      });
    });
  }

  async indexAssets() {
    const contentProjects = this.config.projects.filter(p => p.language === 'content');
    if (contentProjects.length === 0) {
      return;
    }

    console.log('Starting asset indexing...');
    this.database.setIndexStatus('content', 'indexing', 0, 0);

    try {
      let totalAssets = 0;

      for (const project of contentProjects) {
        const contentRoot = project.contentRoot || project.paths[0];
        const extensions = project.extensions || ['.uasset', '.umap'];

        const scanStart = performance.now();
        const files = this.collectFiles(contentRoot, project.name, extensions, 'content');
        console.log(`[Indexer] collectFiles ${project.name}: ${((performance.now() - scanStart) / 1000).toFixed(1)}s (${files.length} assets)`);

        const BATCH_SIZE = 5000;
        for (let i = 0; i < files.length; i += BATCH_SIZE) {
          const batchStart = performance.now();
          const batch = files.slice(i, i + BATCH_SIZE);
          const assets = batch.map(f => {
            const relativePath = relative(contentRoot, f.path).replace(/\\/g, '/');
            const ext = relativePath.match(/\.[^.]+$/)?.[0] || '';
            const contentPath = '/Game/' + relativePath.replace(/\.[^.]+$/, '');
            const name = relativePath.split('/').pop().replace(/\.[^.]+$/, '');
            const folder = '/Game/' + relativePath.split('/').slice(0, -1).join('/');

            // Parse .uasset header for class hierarchy info
            let assetClass = null;
            let parentClass = null;
            if (ext === '.uasset') {
              try {
                const info = parseUAssetHeader(f.path);
                assetClass = info.assetClass;
                parentClass = info.parentClass;
              } catch { /* skip unparseable */ }
            }


            return {
              path: f.path,
              name,
              contentPath,
              folder: folder || '/Game',
              project: project.name,
              extension: ext,
              mtime: f.mtime,
              assetClass,
              parentClass
            };
          });

          this.database.upsertAssetBatch(assets);
          this.database.indexAssetContent(assets);
          totalAssets += batch.length;
          console.log(`[Indexer] asset batch ${i}-${i + batch.length}: ${((performance.now() - batchStart) / 1000).toFixed(1)}s`);
          this.database.setIndexStatus('content', 'indexing', totalAssets, files.length);

          await new Promise(resolve => setImmediate(resolve));
        }
      }

      console.log(`Asset indexing complete: ${totalAssets} assets indexed`);
      this.database.setIndexStatus('content', 'ready', totalAssets, totalAssets);
    } catch (error) {
      console.error('Error indexing assets:', error);
      this.database.setIndexStatus('content', 'error', 0, 0, error.message);
    }
  }

  abort() {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
