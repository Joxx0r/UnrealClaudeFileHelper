import { Worker } from 'worker_threads';
import { readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

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

      const files = [];
      for (const project of projects) {
        const extensions = project.extensions || (language === 'cpp' ? ['.h', '.cpp'] : ['.as']);
        for (const basePath of project.paths) {
          const projectFiles = this.collectFiles(basePath, project.name, extensions, language);
          files.push(...projectFiles);
        }
      }

      console.log(`Found ${files.length} ${language} files to index`);
      this.database.setIndexStatus(language, 'indexing', 0, files.length);

      const workerCount = Math.min(8, os.cpus().length);
      const chunkSize = Math.ceil(files.length / workerCount);
      const chunks = [];

      for (let i = 0; i < files.length; i += chunkSize) {
        chunks.push(files.slice(i, i + chunkSize));
      }

      console.log(`Starting ${chunks.length} workers for ${language} indexing`);

      const workerPromises = chunks.map((chunk, index) =>
        this.runWorker(chunk, language, index)
      );

      const results = await Promise.all(workerPromises);

      let totalProcessed = 0;
      let totalTypes = 0;

      const allFileResults = [];
      for (const result of results) {
        totalProcessed += result.filesProcessed;
        totalTypes += result.typesFound;
        allFileResults.push(...result.results);
      }

      console.log(`${language} workers complete: ${totalProcessed} files parsed, inserting into database...`);

      const BATCH_SIZE = 500;
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
          }
        });

        this.database.setIndexStatus(language, 'indexing', i + batch.length, allFileResults.length);

        await new Promise(resolve => setImmediate(resolve));
      }

      console.log(`${language} indexing complete: ${totalProcessed} files, ${totalTypes} types`);
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

  abort() {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
