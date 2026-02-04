import chokidar from 'chokidar';
import { relative } from 'path';
import { stat, readFile } from 'fs/promises';
import { parseFile } from '../parser.js';
import { parseCppContent } from '../parsers/cpp-parser.js';
import { parseUAssetHeader } from '../parsers/uasset-parser.js';

export class FileWatcher {
  constructor(config, database, options = {}) {
    this.config = config;
    this.database = database;
    this.watcher = null;
    this.debounceMs = options.debounceMs || 100;
    this.pendingUpdates = new Map();
    this.debounceTimer = null;
    this.onUpdate = options.onUpdate || (() => {});
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
        ...this.config.exclude.map(p => new RegExp(p.replace(/\*\*/g, '.*').replace(/\*/g, '[^/\\\\]*')))
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

    let added = 0;
    let changed = 0;
    let deleted = 0;

    for (const [filePath, eventType] of updates) {
      try {
        const project = this.findProjectForPath(filePath);
        if (!project && eventType !== 'unlink') continue;

        const language = project?.language || 'angelscript';

        // Handle content/asset file changes separately
        if (language === 'content') {
          if (eventType === 'unlink') {
            const removed = this.database.deleteAsset(filePath);
            if (removed) deleted++;
          } else {
            const basePath = this.findBasePathForFile(filePath, project);
            if (!basePath) continue;

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

            this.database.upsertAssetBatch([{
              path: filePath,
              name,
              contentPath,
              folder: folder || '/Game',
              project: project.name,
              extension: ext,
              mtime,
              assetClass,
              parentClass
            }]);

            if (eventType === 'add') added++;
            else changed++;
          }
          continue;
        }

        if (eventType === 'unlink') {
          const removed = this.database.deleteFile(filePath);
          if (removed) deleted++;
        } else {
          const basePath = this.findBasePathForFile(filePath, project);
          if (!basePath) continue;

          const fileStat = await stat(filePath);
          const mtime = Math.floor(fileStat.mtimeMs);

          const existingFile = this.database.getFileByPath(filePath);
          if (existingFile && existingFile.mtime === mtime) {
            continue;
          }

          let parsed;

          if (language === 'cpp') {
            const content = await readFile(filePath, 'utf-8');
            parsed = parseCppContent(content, filePath);
          } else {
            parsed = await parseFile(filePath);
          }

          const relativePath = relative(basePath, filePath).replace(/\\/g, '/');
          const module = this.deriveModule(relativePath, project.name, language);

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
            // C++ delegates
            if (language === 'cpp') {
              for (const del of parsed.delegates || []) {
                types.push({ name: del.name, kind: 'delegate', parent: null, line: del.line });
              }
            }

            if (types.length > 0) {
              this.database.insertTypes(fileId, types);
            }

            // Insert members
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
          });

          if (eventType === 'add') added++;
          else changed++;
        }
      } catch (err) {
        console.error(`Error processing ${filePath}:`, err.message);
      }
    }

    if (added > 0 || changed > 0 || deleted > 0) {
      console.log(`Index updated: +${added} ~${changed} -${deleted}`);
      this.onUpdate({ added, changed, deleted });
    }
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
