import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { join, relative, dirname, basename } from 'path';
import { parseFile } from './parser.js';

export class Indexer {
  constructor(config) {
    this.config = config;
    this.index = null;
  }

  async buildIndex() {
    const startTime = Date.now();
    const files = [];

    for (const project of this.config.projects) {
      for (const basePath of project.paths) {
        const projectFiles = await this.scanDirectory(basePath, project.name, basePath);
        files.push(...projectFiles);
      }
    }

    const typeToFiles = new Map();
    const parentToChildren = new Map();
    const moduleToTypes = new Map();
    const allTypeNames = new Set();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      const addType = (name, kind) => {
        if (!typeToFiles.has(name)) {
          typeToFiles.set(name, []);
        }
        typeToFiles.get(name).push({ fileIndex: i, kind });
        allTypeNames.add(name);

        if (!moduleToTypes.has(file.module)) {
          moduleToTypes.set(file.module, []);
        }
        moduleToTypes.get(file.module).push({ name, kind });
      };

      for (const cls of file.classes) {
        addType(cls.name, 'class');
        if (cls.parent) {
          if (!parentToChildren.has(cls.parent)) {
            parentToChildren.set(cls.parent, []);
          }
          parentToChildren.get(cls.parent).push(cls.name);
        }
      }

      for (const struct of file.structs) {
        addType(struct.name, 'struct');
      }

      for (const en of file.enums) {
        addType(en.name, 'enum');
      }

      for (const event of file.events) {
        addType(event.name, 'event');
      }

      for (const delegate of file.delegates) {
        addType(delegate.name, 'delegate');
      }

      for (const ns of file.namespaces) {
        addType(ns.name, 'namespace');
      }
    }

    const stats = {
      totalFiles: files.length,
      totalClasses: files.reduce((sum, f) => sum + f.classes.length, 0),
      totalStructs: files.reduce((sum, f) => sum + f.structs.length, 0),
      totalEnums: files.reduce((sum, f) => sum + f.enums.length, 0),
      totalEvents: files.reduce((sum, f) => sum + f.events.length, 0),
      totalDelegates: files.reduce((sum, f) => sum + f.delegates.length, 0),
      totalNamespaces: files.reduce((sum, f) => sum + f.namespaces.length, 0),
      buildTimeMs: Date.now() - startTime,
      projects: {}
    };

    for (const project of this.config.projects) {
      const projectFiles = files.filter(f => f.project === project.name);
      stats.projects[project.name] = {
        files: projectFiles.length,
        classes: projectFiles.reduce((sum, f) => sum + f.classes.length, 0),
        structs: projectFiles.reduce((sum, f) => sum + f.structs.length, 0)
      };
    }

    this.index = {
      version: 1,
      generatedAt: new Date().toISOString(),
      stats,
      files,
      lookups: {
        typeToFiles: Object.fromEntries(typeToFiles),
        parentToChildren: Object.fromEntries(parentToChildren),
        moduleToTypes: Object.fromEntries(moduleToTypes),
        allTypeNames: [...allTypeNames].sort()
      }
    };

    return this.index;
  }

  async scanDirectory(dirPath, projectName, basePath) {
    const files = [];

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);

        if (entry.isDirectory()) {
          if (this.shouldExclude(fullPath)) {
            continue;
          }
          const subFiles = await this.scanDirectory(fullPath, projectName, basePath);
          files.push(...subFiles);
        } else if (entry.isFile() && entry.name.endsWith('.as')) {
          if (this.shouldExclude(fullPath)) {
            continue;
          }

          try {
            const parsed = await parseFile(fullPath);
            const relativePath = relative(basePath, fullPath).replace(/\\/g, '/');
            const module = this.deriveModule(relativePath, projectName);

            files.push({
              path: fullPath,
              relativePath,
              module,
              project: projectName,
              classes: parsed.classes,
              structs: parsed.structs,
              enums: parsed.enums,
              events: parsed.events,
              delegates: parsed.delegates,
              namespaces: parsed.namespaces
            });
          } catch (err) {
            // Skip files that can't be parsed
          }
        }
      }
    } catch (err) {
      // Directory doesn't exist or can't be read
    }

    return files;
  }

  shouldExclude(path) {
    const normalizedPath = path.replace(/\\/g, '/');
    for (const pattern of this.config.exclude || []) {
      if (pattern.includes('**')) {
        const regex = new RegExp(pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'));
        if (regex.test(normalizedPath)) {
          return true;
        }
      } else if (normalizedPath.includes(pattern.replace(/\*/g, ''))) {
        return true;
      }
    }
    return false;
  }

  deriveModule(relativePath, projectName) {
    const parts = relativePath.replace(/\.as$/, '').split('/');
    parts.pop();
    return [projectName, ...parts].join('.');
  }

  stripPrefix(name) {
    return name.replace(/^[UAFES]/, '');
  }

  findTypeByName(name, options = {}) {
    if (!this.index) {
      return { error: 'Index not built' };
    }

    const { fuzzy = false, project = null, maxResults = 10 } = options;

    if (!fuzzy) {
      let entries = this.index.lookups.typeToFiles[name];

      if (!entries) {
        const nameWithoutPrefix = this.stripPrefix(name);
        for (const prefix of ['U', 'A', 'F', 'E', 'S', '']) {
          const tryName = prefix + nameWithoutPrefix;
          if (tryName !== name && this.index.lookups.typeToFiles[tryName]) {
            entries = this.index.lookups.typeToFiles[tryName];
            break;
          }
        }
      }

      if (!entries) {
        return { results: [] };
      }

      const results = entries
        .map(entry => {
          const file = this.index.files[entry.fileIndex];
          if (project && file.project !== project) {
            return null;
          }

          const typeInfo = this.findTypeInFile(file, entry.kind === 'class' ? file.classes.find(c => this.index.lookups.typeToFiles[c.name] === entries)?.name || name : name, entry.kind);
          const actualName = this.findActualName(file, entry.kind, entries);
          return {
            name: actualName,
            kind: entry.kind,
            file: file.path,
            relativePath: file.relativePath,
            project: file.project,
            module: file.module,
            line: typeInfo?.line || 1,
            parent: typeInfo?.parent || null
          };
        })
        .filter(Boolean);

      return { results };
    }

    const matches = this.fuzzyMatch(name, this.index.lookups.allTypeNames, maxResults * 3);
    const results = [];

    for (const match of matches) {
      const entries = this.index.lookups.typeToFiles[match.name];
      if (!entries) continue;

      for (const entry of entries) {
        const file = this.index.files[entry.fileIndex];
        if (project && file.project !== project) continue;

        const typeInfo = this.findTypeInFile(file, match.name, entry.kind);
        results.push({
          name: match.name,
          kind: entry.kind,
          file: file.path,
          relativePath: file.relativePath,
          project: file.project,
          module: file.module,
          line: typeInfo?.line || 1,
          parent: typeInfo?.parent || null,
          score: match.score
        });
      }
    }

    return { results: results.slice(0, maxResults) };
  }

  findActualName(file, kind, entries) {
    const collections = {
      class: file.classes,
      struct: file.structs,
      enum: file.enums,
      event: file.events,
      delegate: file.delegates,
      namespace: file.namespaces
    };
    const collection = collections[kind] || [];
    for (const item of collection) {
      if (this.index.lookups.typeToFiles[item.name] === entries) {
        return item.name;
      }
    }
    return collection[0]?.name || '';
  }

  findTypeInFile(file, name, kind) {
    const collections = {
      class: file.classes,
      struct: file.structs,
      enum: file.enums,
      event: file.events,
      delegate: file.delegates,
      namespace: file.namespaces
    };

    const collection = collections[kind] || [];
    return collection.find(item => item.name === name);
  }

  fuzzyMatch(query, candidates, maxResults) {
    const queryLower = query.toLowerCase();
    const queryStripped = this.stripPrefix(query).toLowerCase();
    const scored = [];

    for (const candidate of candidates) {
      const candidateLower = candidate.toLowerCase();
      const candidateStripped = this.stripPrefix(candidate).toLowerCase();

      if (candidateLower === queryLower) {
        scored.push({ name: candidate, score: 1.0 });
        continue;
      }

      if (candidateStripped === queryStripped) {
        scored.push({ name: candidate, score: 0.98 });
        continue;
      }

      if (candidateLower.startsWith(queryLower)) {
        scored.push({ name: candidate, score: 0.95 });
        continue;
      }

      if (candidateStripped.startsWith(queryStripped)) {
        scored.push({ name: candidate, score: 0.93 });
        continue;
      }

      if (candidateStripped.startsWith(queryLower)) {
        scored.push({ name: candidate, score: 0.92 });
        continue;
      }

      if (candidateLower.includes(queryLower)) {
        const position = candidateLower.indexOf(queryLower);
        const score = 0.85 - (position / candidate.length) * 0.15;
        scored.push({ name: candidate, score });
        continue;
      }

      if (candidateStripped.includes(queryStripped)) {
        const position = candidateStripped.indexOf(queryStripped);
        const score = 0.80 - (position / candidateStripped.length) * 0.15;
        scored.push({ name: candidate, score });
        continue;
      }

      if (candidateStripped.includes(queryLower)) {
        const position = candidateStripped.indexOf(queryLower);
        const score = 0.75 - (position / candidateStripped.length) * 0.15;
        scored.push({ name: candidate, score });
        continue;
      }

      const wordsInCandidate = candidateStripped.replace(/([A-Z])/g, ' $1').toLowerCase().trim().split(/\s+/);
      const queryWords = queryLower.split(/\s+/);
      let wordMatchScore = 0;
      for (const qWord of queryWords) {
        for (const cWord of wordsInCandidate) {
          if (cWord.startsWith(qWord)) {
            wordMatchScore += 0.6 / queryWords.length;
            break;
          }
          if (cWord.includes(qWord)) {
            wordMatchScore += 0.4 / queryWords.length;
            break;
          }
        }
      }
      if (wordMatchScore > 0.3) {
        scored.push({ name: candidate, score: wordMatchScore });
        continue;
      }

      const threshold = query.length < 5 ? 0.25 : 0.35;
      const distance = this.levenshteinDistance(queryStripped, candidateStripped);
      const maxLen = Math.max(queryStripped.length, candidateStripped.length);
      const similarity = 1 - distance / maxLen;
      if (similarity > threshold) {
        scored.push({ name: candidate, score: similarity * 0.5 });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults);
  }

  levenshteinDistance(a, b) {
    const matrix = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  findChildrenOf(parentClass, options = {}) {
    if (!this.index) {
      return { error: 'Index not built' };
    }

    const { recursive = true, maxResults = 50, project = null } = options;
    const children = new Set();
    const queue = [parentClass];

    while (queue.length > 0) {
      const current = queue.shift();
      const directChildren = this.index.lookups.parentToChildren[current] || [];

      for (const child of directChildren) {
        if (!children.has(child)) {
          children.add(child);
          if (recursive) {
            queue.push(child);
          }
        }
      }
    }

    const results = [];
    for (const childName of children) {
      const entries = this.index.lookups.typeToFiles[childName];
      if (!entries) continue;

      for (const entry of entries) {
        const file = this.index.files[entry.fileIndex];
        if (project && file.project !== project) continue;

        const classInfo = file.classes.find(c => c.name === childName);
        results.push({
          name: childName,
          parent: classInfo?.parent || null,
          file: file.path,
          relativePath: file.relativePath,
          project: file.project,
          module: file.module,
          line: classInfo?.line || 1
        });

        if (results.length >= maxResults) {
          return { results, truncated: true, totalChildren: children.size };
        }
      }
    }

    return { results, truncated: false, totalChildren: children.size };
  }

  browseModule(modulePath, options = {}) {
    if (!this.index) {
      return { error: 'Index not built' };
    }

    const { project = null, maxResults = 100 } = options;
    const matchingModules = Object.keys(this.index.lookups.moduleToTypes)
      .filter(m => m === modulePath || m.startsWith(modulePath + '.'));

    const types = [];
    const files = new Set();
    const seenTypes = new Set();
    let truncated = false;

    for (const mod of matchingModules) {
      const moduleTypes = this.index.lookups.moduleToTypes[mod] || [];
      for (const type of moduleTypes) {
        if (seenTypes.has(type.name)) continue;

        const entries = this.index.lookups.typeToFiles[type.name];
        if (!entries) continue;

        for (const entry of entries) {
          const file = this.index.files[entry.fileIndex];
          if (project && file.project !== project) continue;
          if (!matchingModules.includes(file.module)) continue;

          files.add(file.path);
          if (!seenTypes.has(type.name)) {
            seenTypes.add(type.name);
            const typeInfo = this.findTypeInFile(file, type.name, type.kind);
            types.push({
              name: type.name,
              kind: type.kind,
              file: file.path,
              relativePath: file.relativePath,
              line: typeInfo?.line || 1
            });

            if (types.length >= maxResults) {
              truncated = true;
              break;
            }
          }
        }
        if (truncated) break;
      }
      if (truncated) break;
    }

    return {
      module: modulePath,
      files: [...files].slice(0, 50),
      types,
      truncated,
      totalFiles: files.size
    };
  }

  findFileByName(filename, options = {}) {
    if (!this.index) {
      return { error: 'Index not built' };
    }

    const { project = null, maxResults = 20 } = options;
    const filenameLower = filename.toLowerCase().replace(/\.as$/, '');
    const results = [];

    for (const file of this.index.files) {
      if (project && file.project !== project) continue;

      const baseName = file.relativePath.split('/').pop().replace(/\.as$/, '').toLowerCase();

      let score = 0;
      if (baseName === filenameLower) {
        score = 1.0;
      } else if (baseName.startsWith(filenameLower)) {
        score = 0.9;
      } else if (baseName.includes(filenameLower)) {
        score = 0.7;
      } else if (file.relativePath.toLowerCase().includes(filenameLower)) {
        score = 0.5;
      }

      if (score > 0) {
        const allTypes = [
          ...file.classes.map(c => ({ ...c, kind: 'class' })),
          ...file.structs.map(s => ({ ...s, kind: 'struct' })),
          ...file.enums.map(e => ({ ...e, kind: 'enum' }))
        ];

        results.push({
          file: file.path,
          relativePath: file.relativePath,
          project: file.project,
          module: file.module,
          score,
          types: allTypes.slice(0, 10).map(t => ({ name: t.name, kind: t.kind, line: t.line }))
        });
      }

      if (results.length >= maxResults * 2) break;
    }

    results.sort((a, b) => b.score - a.score);
    return { results: results.slice(0, maxResults) };
  }

  getStats() {
    if (!this.index) {
      return { error: 'Index not built' };
    }
    return this.index.stats;
  }

  getSummary() {
    if (!this.index) {
      return { error: 'Index not built' };
    }

    const modules = Object.keys(this.index.lookups.moduleToTypes).sort();
    const topLevelModules = [...new Set(modules.map(m => m.split('.')[0]))];

    return {
      generatedAt: this.index.generatedAt,
      stats: this.index.stats,
      projects: Object.keys(this.index.stats.projects),
      topLevelModules,
      moduleCount: modules.length
    };
  }

  async saveToCache(cachePath) {
    await writeFile(cachePath, JSON.stringify(this.index, null, 2));
  }

  async loadFromCache(cachePath) {
    try {
      const content = await readFile(cachePath, 'utf-8');
      this.index = JSON.parse(content);
      return true;
    } catch {
      return false;
    }
  }
}
