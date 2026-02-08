import chokidar from 'chokidar';
import { relative } from 'path';
import { stat, readFile } from 'fs/promises';
import { deflateSync } from 'zlib';
import { parseFile } from '../parser.js';
import { parseCppContent } from '../parsers/cpp-parser.js';
import { parseUAssetHeader } from '../parsers/uasset-parser.js';
import { extractTrigrams, contentHash } from './trigram.js';

export class FileWatcher {
  constructor(config, database, options = {}) {
    this.config = config;
    this.database = database;
    this.watcher = null;
    this.debounceMs = options.debounceMs || 100;
    this.pendingUpdates = new Map();
    this.debounceTimer = null;
    this.onUpdate = options.onUpdate || (() => {});
    this.zoektMirror = options.zoektMirror || null;
    this.zoektManager = options.zoektManager || null;
  }

  start() {
    const watchPaths = [];

    for (const project of this.config.projects) {
      for (const basePath of project.paths) {
        watchPaths.push(basePath);
      }
    }

    this.watcher = chokidar.watch(watchPaths, {
      ignored: [
        /(^|[\/\\])\../,
        ...(this.config.exclude || []).map(p => new RegExp(p.replace(/\*\*/g, '.*').replace(/\*/g, '[^/\\\\]*')))
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50
      }
    });

    this.watcher.on('add', path => this.queueUpdate(path, 'add'));
    this.watcher.on('change', path => this.queueUpdate(path, 'change'));
    this.watcher.on('unlink', path => this.queueUpdate(path, 'unlink'));

    this.watcher.on('error', error => {
      console.error('Watcher error:', error);
    });

    console.log(`File watcher started for ${watchPaths.length} paths`);
    return this;
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  queueUpdate(filePath, eventType) {
    if (!this.hasMatchingExtension(filePath)) return;

    this.pendingUpdates.set(filePath, eventType);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.processPendingUpdates();
    }, this.debounceMs);
  }

  hasMatchingExtension(filePath) {
    const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();

    for (const project of this.config.projects) {
      const extensions = project.extensions || (project.language === 'cpp' ? ['.h', '.cpp'] : ['.as']);
      for (const basePath of project.paths) {
        const normalizedBase = basePath.replace(/\\/g, '/').toLowerCase();
        if (normalizedPath.startsWith(normalizedBase)) {
          return extensions.some(ext => filePath.endsWith(ext));
        }
      }
    }

    return false;
  }

  async processPendingUpdates() {
    const updates = new Map(this.pendingUpdates);
    this.pendingUpdates.clear();
    const watcherStart = performance.now();

    let added = 0;
    let changed = 0;
    let deleted = 0;
    const affectedProjects = new Set();

    // Phase 1: Handle deletes immediately (no I/O needed)
    const ioTasks = [];
    for (const [filePath, eventType] of updates) {
      const project = this.findProjectForPath(filePath);
      if (!project && eventType !== 'unlink') continue;

      const language = project?.language || 'angelscript';

      if (eventType === 'unlink') {
        if (language === 'content') {
          if (this.database.deleteAsset(filePath)) {
            deleted++;
            affectedProjects.add('_assets');
          }
        } else {
          if (this.database.deleteFile(filePath)) {
            deleted++;
            if (project) affectedProjects.add(project.name);
          }
          // Remove from Zoekt mirror (Windows + WSL)
          if (this.zoektMirror) {
            const relativePath = this.zoektMirror._toRelativePath(filePath);
            this.zoektMirror.deleteFile(filePath);
            if (this.zoektManager) {
              this.zoektManager.deleteWslMirrorFile(relativePath);
            }
          }
        }
      } else {
        ioTasks.push({ filePath, eventType, project, language });
      }
    }

    // Phase 2: Parallel I/O — read files concurrently (P4 drive benefits from concurrency)
    const MAX_CONCURRENT = 10;
    const ioResults = [];

    for (let i = 0; i < ioTasks.length; i += MAX_CONCURRENT) {
      const batch = ioTasks.slice(i, i + MAX_CONCURRENT);
      const batchResults = await Promise.all(batch.map(task => this._readAndParse(task)));
      ioResults.push(...batchResults);
    }

    // Phase 3: Serial DB writes (SQLite requires single-writer)
    for (const result of ioResults) {
      if (!result) continue;
      try {
        this._writeToDatabase(result);
        if (result.eventType === 'add') added++;
        else changed++;
        // Track affected project for scoped Zoekt reindexing
        if (result.type === 'asset') {
          affectedProjects.add('_assets');
        } else if (result.project) {
          affectedProjects.add(result.project.name);
        }
      } catch (err) {
        console.error(`Error writing ${result.filePath}:`, err.message);
      }
    }

    if (added > 0 || changed > 0 || deleted > 0) {
      const ms = (performance.now() - watcherStart).toFixed(1);
      console.log(`[Watcher] +${added} ~${changed} -${deleted} (${updates.size} files) — ${ms}ms`);
      this.onUpdate({ added, changed, deleted });

      // Trigger scoped Zoekt re-indexing (only affected projects)
      if (this.zoektManager) {
        this.zoektManager.triggerReindex(added + changed + deleted, affectedProjects);
      }
    }
  }

  // I/O phase: read file from disk, parse content (can run in parallel)
  async _readAndParse({ filePath, eventType, project, language }) {
    try {
      if (language === 'content') {
        const basePath = this.findBasePathForFile(filePath, project);
        if (!basePath) return null;

        const fileStat = await stat(filePath);
        const mtime = Math.floor(fileStat.mtimeMs);
        const contentRoot = project.contentRoot || project.paths[0];
        const relativePath = relative(contentRoot, filePath).replace(/\\/g, '/');
        const ext = relativePath.match(/\.[^.]+$/)?.[0] || '';
        const contentPath = '/Game/' + relativePath.replace(/\.[^.]+$/, '');
        const name = relativePath.split('/').pop().replace(/\.[^.]+$/, '');
        const folder = '/Game/' + relativePath.split('/').slice(0, -1).join('/');

        let assetClass = null;
        let parentClass = null;
        if (ext === '.uasset') {
          try {
            const info = parseUAssetHeader(filePath);
            assetClass = info.assetClass;
            parentClass = info.parentClass;
          } catch { /* skip */ }
        }

        return { filePath, eventType, language, type: 'asset', project, data: {
          path: filePath, name, contentPath, folder: folder || '/Game',
          project: project.name, extension: ext, mtime, assetClass, parentClass
        }};
      }

      const basePath = this.findBasePathForFile(filePath, project);
      if (!basePath) return null;

      const fileStat = await stat(filePath);
      const mtime = Math.floor(fileStat.mtimeMs);

      const existingFile = this.database.getFileByPath(filePath);
      if (existingFile && existingFile.mtime === mtime) return null;

      const relativePath = relative(basePath, filePath).replace(/\\/g, '/');
      const module = this.deriveModule(relativePath, project.name, language);

      if (language === 'config') {
        return { filePath, eventType, language, type: 'config', project, module, mtime };
      }

      const fileContent = await readFile(filePath, 'utf-8');
      let parsed;
      if (language === 'cpp') {
        parsed = parseCppContent(fileContent, filePath);
      } else {
        parsed = await parseFile(filePath);
      }

      return { filePath, eventType, language, type: 'source', project, module, mtime, parsed, fileContent };
    } catch (err) {
      console.error(`Error reading ${filePath}:`, err.message);
      return null;
    }
  }

  // DB write phase: must run serially (single SQLite writer)
  _writeToDatabase(result) {
    if (result.type === 'asset') {
      this.database.upsertAssetBatch([result.data]);
      this.database.indexAssetContent([result.data]);
      return;
    }

    if (result.type === 'config') {
      this.database.upsertFile(result.filePath, result.project.name, result.module, result.mtime, result.language);
      return;
    }

    // Source file: full type/member/trigram update
    const { filePath, project, module, mtime, language, parsed, fileContent } = result;

    this.database.transaction(() => {
      const fileId = this.database.upsertFile(filePath, project.name, module, mtime, language);
      this.database.clearTypesForFile(fileId);

      const types = [];
      for (const cls of parsed.classes) {
        types.push({ name: cls.name, kind: cls.kind || 'class', parent: cls.parent, line: cls.line });
      }
      for (const struct of parsed.structs) {
        types.push({ name: struct.name, kind: 'struct', parent: struct.parent || null, line: struct.line });
      }
      for (const en of parsed.enums) {
        types.push({ name: en.name, kind: 'enum', parent: null, line: en.line });
      }
      if (language === 'angelscript') {
        for (const event of parsed.events || []) {
          types.push({ name: event.name, kind: 'event', parent: null, line: event.line });
        }
        for (const delegate of parsed.delegates || []) {
          types.push({ name: delegate.name, kind: 'delegate', parent: null, line: delegate.line });
        }
        for (const ns of parsed.namespaces || []) {
          types.push({ name: ns.name, kind: 'namespace', parent: null, line: ns.line });
        }
      }
      if (language === 'cpp') {
        for (const del of parsed.delegates || []) {
          types.push({ name: del.name, kind: 'delegate', parent: null, line: del.line });
        }
      }

      if (types.length > 0) {
        this.database.insertTypes(fileId, types);
      }

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

      if (fileContent && fileContent.length <= 500000) {
        const trigrams = [...extractTrigrams(fileContent)];
        const compressed = deflateSync(fileContent);
        const hash = contentHash(fileContent);
        this.database.upsertFileContent(fileId, compressed, hash);
        this.database.clearTrigramsForFile(fileId);
        if (trigrams.length > 0) {
          this.database.insertTrigrams(fileId, trigrams);
        }

        // Update Zoekt mirror with the raw file content (Windows + WSL)
        if (this.zoektMirror) {
          this.zoektMirror.updateFile(filePath, fileContent);
          if (this.zoektManager) {
            const relativePath = this.zoektMirror._toRelativePath(filePath);
            this.zoektManager.updateWslMirrorFile(relativePath, fileContent);
          }
        }
      }
    });
  }

  findProjectForPath(filePath) {
    const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();

    for (const project of this.config.projects) {
      for (const basePath of project.paths) {
        const normalizedBase = basePath.replace(/\\/g, '/').toLowerCase();
        if (normalizedPath.startsWith(normalizedBase)) {
          return project;
        }
      }
    }

    return null;
  }

  findBasePathForFile(filePath, project) {
    const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();

    for (const basePath of project.paths) {
      const normalizedBase = basePath.replace(/\\/g, '/').toLowerCase();
      if (normalizedPath.startsWith(normalizedBase)) {
        return basePath;
      }
    }

    return null;
  }

  deriveModule(relativePath, projectName, language = 'angelscript') {
    const parts = relativePath.replace(/\.(as|h|cpp)$/, '').split('/');
    parts.pop();
    return [projectName, ...parts].join('.');
  }
}
