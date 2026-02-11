import { extractTrigrams } from './trigram.js';
import { specifierBoost, KIND_WEIGHT, trigramThreshold, splitCamelCase, dedupTypes, scoreEntry } from './scoring.js';

// String interning pool — reuses identical strings to save memory
function createInterner() {
  const pool = new Map();
  return (s) => {
    if (s == null) return s;
    const existing = pool.get(s);
    if (existing !== undefined) return existing;
    pool.set(s, s);
    return s;
  };
}

// Extract lowercase basename without extension
function extractBasename(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const filename = lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
  const dotIdx = filename.lastIndexOf('.');
  const stem = dotIdx > 0 ? filename.substring(0, dotIdx) : filename;
  return stem.toLowerCase();
}

export class MemoryIndex {
  constructor() {
    // Files
    this.filesById = new Map();
    this.filesByPath = new Map();         // path → id
    this.filesByBasename = new Map();     // basename_lower → [id]
    this.filesByModule = new Map();       // module → [id]
    this.filesByProject = new Map();      // project → [id]

    // Types
    this.typesById = new Map();
    this.typesByName = new Map();         // name → [id]
    this.typesByNameLower = new Map();    // lower(name) → [id]
    this.typesByFileId = new Map();       // fileId → [id]
    this.typesByParent = new Map();       // parent → [id]

    // Members
    this.membersById = new Map();
    this.membersByName = new Map();       // name → [id]
    this.membersByNameLower = new Map();  // lower(name) → [id]
    this.membersByTypeId = new Map();     // typeId → [id]
    this.membersByFileId = new Map();     // fileId → [id]

    // Assets
    this.assetsById = new Map();
    this.assetsByPath = new Map();        // path → id
    this.assetsByName = new Map();        // name → [id]
    this.assetsByNameLower = new Map();   // lower(name) → [id]
    this.assetsByParentClass = new Map(); // parent_class → [id]
    this.assetsByFolder = new Map();      // folder → [id]
    this.assetsByProject = new Map();     // project → [id]

    // Inheritance graph (Phase 4)
    this.childrenAdjacency = new Map();   // parent name → [child name]
    this.inheritanceParent = new Map();   // child name → parent name
    this._descendantsCache = new Map();   // memoized transitive closure

    // Trigram indexes for fuzzy search (Phase 5)
    this.typeTrigramIndex = new Map();    // trigram int → [type_id]
    this.memberTrigramIndex = new Map();  // trigram int → [member_id]

    // Sorted name arrays for fast prefix search
    this._sortedTypeNamesLower = null;    // sorted string[] of typesByNameLower keys
    this._sortedMemberNamesLower = null;  // sorted string[] of membersByNameLower keys
    this._sortedBasenames = null;         // sorted string[] of filesByBasename keys
    this._sortedModuleNames = null;       // sorted string[] of filesByModule keys

    // Stats counters
    this._stats = {
      totalFiles: 0, totalTypes: 0, totalMembers: 0, totalAssets: 0,
      byKind: {}, byMemberKind: {}, byLanguage: {}, projects: {}
    };

    this._loaded = false;
  }

  get isLoaded() { return this._loaded; }

  // --- Phase 2: Bulk loading from SQLite ---

  load(db) {
    const t0 = performance.now();
    const intern = createInterner();

    // Load files (exclude language='content' and 'asset')
    const files = db.prepare(
      "SELECT id, path, project, module, language, mtime, basename_lower, path_lower, relative_path FROM files WHERE language NOT IN ('content', 'asset')"
    ).all();

    for (const f of files) {
      const rec = {
        id: f.id,
        path: f.path,
        project: intern(f.project),
        module: intern(f.module),
        language: intern(f.language),
        mtime: f.mtime,
        basenameLower: f.basename_lower || extractBasename(f.path),
        pathLower: f.path_lower || f.path.toLowerCase().replace(/\\/g, '/'),
        relativePath: f.relative_path
      };
      this._addFileRecord(rec);
    }

    console.log(`[MemoryIndex] Files: ${this.filesById.size} (${(performance.now() - t0).toFixed(0)}ms)`);

    // Load types
    let t = performance.now();
    const types = db.prepare(
      'SELECT id, file_id, name, kind, parent, line, depth FROM types'
    ).all();

    for (const row of types) {
      const rec = {
        id: row.id,
        fileId: row.file_id,
        name: row.name,
        kind: intern(row.kind),
        parent: row.parent ? intern(row.parent) : null,
        line: row.line,
        depth: row.depth
      };
      this._addTypeRecord(rec);
    }

    console.log(`[MemoryIndex] Types: ${this.typesById.size} (${(performance.now() - t).toFixed(0)}ms)`);

    // Load members
    t = performance.now();
    const members = db.prepare(
      'SELECT id, type_id, file_id, name, member_kind, line, is_static, specifiers FROM members'
    ).all();

    for (const row of members) {
      const rec = {
        id: row.id,
        typeId: row.type_id,
        fileId: row.file_id,
        name: row.name,
        memberKind: intern(row.member_kind),
        line: row.line,
        isStatic: row.is_static,
        specifiers: row.specifiers ? intern(row.specifiers) : null
      };
      this._addMemberRecord(rec);
    }

    console.log(`[MemoryIndex] Members: ${this.membersById.size} (${(performance.now() - t).toFixed(0)}ms)`);

    // Load assets
    t = performance.now();
    const assets = db.prepare(
      'SELECT id, path, name, content_path, folder, project, extension, mtime, asset_class, parent_class FROM assets'
    ).all();

    for (const row of assets) {
      const rec = {
        id: row.id,
        path: row.path,
        name: row.name,
        contentPath: row.content_path,
        folder: intern(row.folder),
        project: intern(row.project),
        extension: intern(row.extension),
        mtime: row.mtime,
        assetClass: row.asset_class ? intern(row.asset_class) : null,
        parentClass: row.parent_class ? intern(row.parent_class) : null
      };
      this._addAssetRecord(rec);
    }

    console.log(`[MemoryIndex] Assets: ${this.assetsById.size} (${(performance.now() - t).toFixed(0)}ms)`);

    // Build trigram indexes
    t = performance.now();
    this._buildTrigramIndexes();
    console.log(`[MemoryIndex] Trigrams: types=${this.typeTrigramIndex.size}, members=${this.memberTrigramIndex.size} (${(performance.now() - t).toFixed(0)}ms)`);

    // Build inheritance graph
    t = performance.now();
    this._buildInheritanceGraph();
    console.log(`[MemoryIndex] Inheritance: ${this.childrenAdjacency.size} parents (${(performance.now() - t).toFixed(0)}ms)`);

    // Compute stats
    this._recomputeStats();

    // Build sorted name arrays for prefix search
    t = performance.now();
    this._rebuildSortedIndexes();
    console.log(`[MemoryIndex] Sorted indexes built (${(performance.now() - t).toFixed(0)}ms)`);

    this._loaded = true;
    const totalMs = (performance.now() - t0).toFixed(0);
    const mem = process.memoryUsage();
    console.log(`[MemoryIndex] Load complete in ${totalMs}ms (heap: ${Math.round(mem.heapUsed / 1024 / 1024)}MB)`);
  }

  // --- Internal record management ---

  _addToMultiMap(map, key, value) {
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(value);
  }

  _removeFromMultiMap(map, key, value) {
    const arr = map.get(key);
    if (!arr) return;
    const idx = arr.indexOf(value);
    if (idx >= 0) arr.splice(idx, 1);
    if (arr.length === 0) map.delete(key);
  }

  _addFileRecord(rec) {
    this.filesById.set(rec.id, rec);
    this.filesByPath.set(rec.path, rec.id);
    this._addToMultiMap(this.filesByBasename, rec.basenameLower, rec.id);
    this._addToMultiMap(this.filesByModule, rec.module, rec.id);
    this._addToMultiMap(this.filesByProject, rec.project, rec.id);

    // Stats
    this._stats.totalFiles++;
    if (!this._stats.byLanguage[rec.language]) this._stats.byLanguage[rec.language] = { files: 0, types: 0 };
    this._stats.byLanguage[rec.language].files++;
    if (!this._stats.projects[rec.project]) this._stats.projects[rec.project] = { files: 0, types: 0, language: rec.language };
    this._stats.projects[rec.project].files++;
  }

  _removeFileRecord(fileId) {
    const rec = this.filesById.get(fileId);
    if (!rec) return;
    this.filesById.delete(fileId);
    this.filesByPath.delete(rec.path);
    this._removeFromMultiMap(this.filesByBasename, rec.basenameLower, fileId);
    this._removeFromMultiMap(this.filesByModule, rec.module, fileId);
    this._removeFromMultiMap(this.filesByProject, rec.project, fileId);

    this._stats.totalFiles--;
    if (this._stats.byLanguage[rec.language]) this._stats.byLanguage[rec.language].files--;
    if (this._stats.projects[rec.project]) this._stats.projects[rec.project].files--;
  }

  _addTypeRecord(rec) {
    this.typesById.set(rec.id, rec);
    this._addToMultiMap(this.typesByName, rec.name, rec.id);
    this._addToMultiMap(this.typesByNameLower, rec.name.toLowerCase(), rec.id);
    this._addToMultiMap(this.typesByFileId, rec.fileId, rec.id);
    if (rec.parent) {
      this._addToMultiMap(this.typesByParent, rec.parent, rec.id);
    }

    // Stats
    this._stats.totalTypes++;
    this._stats.byKind[rec.kind] = (this._stats.byKind[rec.kind] || 0) + 1;
    const file = this.filesById.get(rec.fileId);
    if (file) {
      if (this._stats.byLanguage[file.language]) this._stats.byLanguage[file.language].types++;
      if (this._stats.projects[file.project]) this._stats.projects[file.project].types++;
    }

    // Trigram index
    const trigrams = extractTrigrams(rec.name);
    for (const tri of trigrams) {
      this._addToMultiMap(this.typeTrigramIndex, tri, rec.id);
    }
  }

  _removeTypeRecord(typeId) {
    const rec = this.typesById.get(typeId);
    if (!rec) return;
    this.typesById.delete(typeId);
    this._removeFromMultiMap(this.typesByName, rec.name, typeId);
    this._removeFromMultiMap(this.typesByNameLower, rec.name.toLowerCase(), typeId);
    this._removeFromMultiMap(this.typesByFileId, rec.fileId, typeId);
    if (rec.parent) {
      this._removeFromMultiMap(this.typesByParent, rec.parent, typeId);
    }

    this._stats.totalTypes--;
    if (this._stats.byKind[rec.kind]) this._stats.byKind[rec.kind]--;
    const file = this.filesById.get(rec.fileId);
    if (file) {
      if (this._stats.byLanguage[file.language]) this._stats.byLanguage[file.language].types--;
      if (this._stats.projects[file.project]) this._stats.projects[file.project].types--;
    }

    // Trigram index
    const trigrams = extractTrigrams(rec.name);
    for (const tri of trigrams) {
      this._removeFromMultiMap(this.typeTrigramIndex, tri, typeId);
    }
  }

  _addMemberRecord(rec) {
    this.membersById.set(rec.id, rec);
    this._addToMultiMap(this.membersByName, rec.name, rec.id);
    this._addToMultiMap(this.membersByNameLower, rec.name.toLowerCase(), rec.id);
    if (rec.typeId) this._addToMultiMap(this.membersByTypeId, rec.typeId, rec.id);
    this._addToMultiMap(this.membersByFileId, rec.fileId, rec.id);

    this._stats.totalMembers++;
    this._stats.byMemberKind[rec.memberKind] = (this._stats.byMemberKind[rec.memberKind] || 0) + 1;

    // Trigram index
    const trigrams = extractTrigrams(rec.name);
    for (const tri of trigrams) {
      this._addToMultiMap(this.memberTrigramIndex, tri, rec.id);
    }
  }

  _removeMemberRecord(memberId) {
    const rec = this.membersById.get(memberId);
    if (!rec) return;
    this.membersById.delete(memberId);
    this._removeFromMultiMap(this.membersByName, rec.name, memberId);
    this._removeFromMultiMap(this.membersByNameLower, rec.name.toLowerCase(), memberId);
    if (rec.typeId) this._removeFromMultiMap(this.membersByTypeId, rec.typeId, memberId);
    this._removeFromMultiMap(this.membersByFileId, rec.fileId, memberId);

    this._stats.totalMembers--;
    if (this._stats.byMemberKind[rec.memberKind]) this._stats.byMemberKind[rec.memberKind]--;

    // Trigram index
    const trigrams = extractTrigrams(rec.name);
    for (const tri of trigrams) {
      this._removeFromMultiMap(this.memberTrigramIndex, tri, memberId);
    }
  }

  _addAssetRecord(rec) {
    this.assetsById.set(rec.id, rec);
    this.assetsByPath.set(rec.path, rec.id);
    this._addToMultiMap(this.assetsByName, rec.name, rec.id);
    this._addToMultiMap(this.assetsByNameLower, rec.name.toLowerCase(), rec.id);
    if (rec.parentClass) this._addToMultiMap(this.assetsByParentClass, rec.parentClass, rec.id);
    this._addToMultiMap(this.assetsByFolder, rec.folder, rec.id);
    this._addToMultiMap(this.assetsByProject, rec.project, rec.id);
    this._stats.totalAssets++;
  }

  _removeAssetRecord(assetId) {
    const rec = this.assetsById.get(assetId);
    if (!rec) return;
    this.assetsById.delete(assetId);
    this.assetsByPath.delete(rec.path);
    this._removeFromMultiMap(this.assetsByName, rec.name, assetId);
    this._removeFromMultiMap(this.assetsByNameLower, rec.name.toLowerCase(), assetId);
    if (rec.parentClass) this._removeFromMultiMap(this.assetsByParentClass, rec.parentClass, assetId);
    this._removeFromMultiMap(this.assetsByFolder, rec.folder, assetId);
    this._removeFromMultiMap(this.assetsByProject, rec.project, assetId);
    this._stats.totalAssets--;
  }

  _buildTrigramIndexes() {
    // Already built incrementally during _addTypeRecord/_addMemberRecord
    // This method exists for clarity and could rebuild if needed
  }

  _rebuildSortedIndexes() {
    this._sortedTypeNamesLower = [...this.typesByNameLower.keys()].sort();
    this._sortedMemberNamesLower = [...this.membersByNameLower.keys()].sort();
    this._sortedBasenames = [...this.filesByBasename.keys()].sort();
    this._sortedModuleNames = [...this.filesByModule.keys()].sort();
    this._sortedAssetNamesLower = [...this.assetsByNameLower.keys()].sort();
  }

  _invalidateSortedIndexes() {
    this._sortedTypeNamesLower = null;
    this._sortedMemberNamesLower = null;
    this._sortedBasenames = null;
    this._sortedModuleNames = null;
    this._sortedAssetNamesLower = null;
  }

  // Binary search for first key >= prefix in sorted array, then collect all prefix matches
  _prefixScan(sortedKeys, prefix) {
    if (!sortedKeys) return [];
    let lo = 0, hi = sortedKeys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedKeys[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    const result = [];
    while (lo < sortedKeys.length && sortedKeys[lo].startsWith(prefix)) {
      result.push(sortedKeys[lo]);
      lo++;
    }
    return result;
  }

  // --- Phase 4: Inheritance graph ---

  _buildInheritanceGraph() {
    this.childrenAdjacency.clear();
    this.inheritanceParent.clear();
    this._descendantsCache.clear();

    // From types
    for (const [, rec] of this.typesById) {
      if (rec.parent && (rec.kind === 'class' || rec.kind === 'struct' || rec.kind === 'interface')) {
        this.inheritanceParent.set(rec.name, rec.parent);
        let children = this.childrenAdjacency.get(rec.parent);
        if (!children) { children = []; this.childrenAdjacency.set(rec.parent, children); }
        if (!children.includes(rec.name)) children.push(rec.name);
      }
    }

    // From assets
    for (const [, rec] of this.assetsById) {
      if (rec.parentClass && rec.assetClass) {
        this.inheritanceParent.set(rec.name, rec.parentClass);
        let children = this.childrenAdjacency.get(rec.parentClass);
        if (!children) { children = []; this.childrenAdjacency.set(rec.parentClass, children); }
        if (!children.includes(rec.name)) children.push(rec.name);
      }
    }
  }

  invalidateInheritanceCache() {
    this._descendantsCache.clear();
    this._buildInheritanceGraph();
    this._invalidateSortedIndexes();
    this._rebuildSortedIndexes();
  }

  _getTransitiveDescendants(parentName) {
    const cached = this._descendantsCache.get(parentName);
    if (cached) return cached;

    const descendants = new Set();
    const queue = [parentName];
    let idx = 0;
    while (idx < queue.length) {
      const current = queue[idx++];
      const children = this.childrenAdjacency.get(current);
      if (children) {
        for (const child of children) {
          if (!descendants.has(child)) {
            descendants.add(child);
            queue.push(child);
          }
        }
      }
      // Also check stripped variants for assets
      const stripped = current.replace(/^[AUFESI](?=[A-Z])/, '');
      if (stripped !== current) {
        const strippedChildren = this.childrenAdjacency.get(stripped);
        if (strippedChildren) {
          for (const child of strippedChildren) {
            if (!descendants.has(child)) {
              descendants.add(child);
              queue.push(child);
            }
          }
        }
      }
    }

    this._descendantsCache.set(parentName, descendants);
    return descendants;
  }

  _isActorComponentDescendant(typeName) {
    if (typeName === 'UActorComponent') return true;
    let current = typeName;
    const visited = new Set();
    while (current) {
      if (visited.has(current)) break;
      visited.add(current);
      if (current === 'UActorComponent') return true;
      current = this.inheritanceParent.get(current) || null;
    }
    return false;
  }

  _getSubtypeNames(parentClass) {
    return [...this._getTransitiveDescendants(parentClass)];
  }

  // --- Phase 3: Query methods ---

  projectExists(project) {
    return this.filesByProject.has(project) || this.assetsByProject.has(project);
  }

  getDistinctProjects() {
    const projects = new Set([...this.filesByProject.keys(), ...this.assetsByProject.keys()]);
    return [...projects].sort();
  }

  findTypeByName(name, options = {}) {
    const { fuzzy = false, project = null, language = null, kind = null, maxResults = 10, includeAssets } = options;

    const includeSourceTypes = !language || language === 'all' || language === 'angelscript' || language === 'cpp';
    const assetsDefault = !fuzzy;
    const includeBlueprints = (includeAssets !== undefined ? includeAssets : (language === 'blueprint' || assetsDefault))
      && (!language || language === 'all' || language === 'blueprint');

    if (!fuzzy) {
      let results = [];

      if (includeSourceTypes) {
        // Exact match — collect all, sort headers first, then truncate
        const typeIds = this.typesByName.get(name) || [];
        for (const tid of typeIds) {
          const t = this.typesById.get(tid);
          if (!t) continue;
          if (kind && t.kind !== kind) continue;
          const f = this.filesById.get(t.fileId);
          if (!f) continue;
          if (project && f.project !== project) continue;
          if (language && language !== 'all' && language !== 'blueprint' && f.language !== language) continue;
          results.push({ name: t.name, kind: t.kind, parent: t.parent, line: t.line, path: f.path, project: f.project, matchReason: 'exact' });
        }
        if (results.length > 1) {
          results.sort((a, b) => {
            const aH = /\.(h|hpp|hxx)$/i.test(a.path) ? 0 : 1;
            const bH = /\.(h|hpp|hxx)$/i.test(b.path) ? 0 : 1;
            return aH - bH;
          });
        }
        if (results.length > maxResults) results.length = maxResults;

        // UE prefix fallback
        if (results.length === 0) {
          const candidates = new Set();
          for (const prefix of ['A', 'U', 'F', 'E', 'S', 'I']) {
            const tryName = prefix + name;
            if (tryName !== name) candidates.add(tryName);
          }
          const nameWithoutPrefix = name.replace(/^[UAFESI]/, '');
          if (nameWithoutPrefix !== name) {
            for (const prefix of ['A', 'U', 'F', 'E', 'S', 'I', '']) {
              const tryName = prefix + nameWithoutPrefix;
              if (tryName !== name) candidates.add(tryName);
            }
          }

          for (const tryName of candidates) {
            const ids = this.typesByName.get(tryName) || [];
            for (const tid of ids) {
              const t = this.typesById.get(tid);
              if (!t) continue;
              if (kind && t.kind !== kind) continue;
              const f = this.filesById.get(t.fileId);
              if (!f) continue;
              if (project && f.project !== project) continue;
              if (language && language !== 'all' && language !== 'blueprint' && f.language !== language) continue;
              results.push({ name: t.name, kind: t.kind, parent: t.parent, line: t.line, path: f.path, project: f.project, matchReason: 'prefix-variant' });
            }
          }
          if (results.length > 1) {
            results.sort((a, b) => {
              const aH = /\.(h|hpp|hxx)$/i.test(a.path) ? 0 : 1;
              const bH = /\.(h|hpp|hxx)$/i.test(b.path) ? 0 : 1;
              return aH - bH;
            });
          }
          if (results.length > maxResults) results.length = maxResults;
        }
      }

      // Blueprint assets
      if (includeBlueprints && results.length < maxResults) {
        const assetIds = this.assetsByName.get(name) || [];
        for (const aid of assetIds) {
          const a = this.assetsById.get(aid);
          if (!a || !a.assetClass) continue;
          if (project && a.project !== project) continue;
          results.push({
            name: a.name, kind: 'class', parent: a.parentClass, line: 0,
            path: a.contentPath, project: a.project, asset_class: a.assetClass,
            language: 'blueprint', module: a.folder, matchReason: 'exact'
          });
          if (results.length >= maxResults) break;
        }

        // Try without _C suffix
        if (results.length === 0 && name.endsWith('_C')) {
          const baseName = name.slice(0, -2);
          const baseIds = this.assetsByName.get(baseName) || [];
          for (const aid of baseIds) {
            const a = this.assetsById.get(aid);
            if (!a || !a.assetClass) continue;
            if (project && a.project !== project) continue;
            results.push({
              name: a.name, kind: 'class', parent: a.parentClass, line: 0,
              path: a.contentPath, project: a.project, asset_class: a.assetClass,
              language: 'blueprint', module: a.folder, matchReason: 'exact'
            });
            if (results.length >= maxResults) break;
          }
        }
      }

      return dedupTypes(results);
    }

    // --- Fuzzy search ---
    const nameLower = name.toLowerCase();
    const nameStripped = name.replace(/^[UAFESI]/, '').toLowerCase();
    const MAX_CANDIDATES = 200;
    const candidates = [];
    const seenIds = new Set();

    // Helper to resolve type IDs to candidate objects
    const addTypeCandidate = (tid) => {
      if (candidates.length >= MAX_CANDIDATES || seenIds.has(tid)) return;
      const t = this.typesById.get(tid);
      if (!t) return;
      if (kind && t.kind !== kind) return;
      const f = this.filesById.get(t.fileId);
      if (!f) return;
      if (project && f.project !== project) return;
      if (language && language !== 'all' && language !== 'blueprint' && f.language !== language) return;
      seenIds.add(tid);
      candidates.push({ id: tid, name: t.name, kind: t.kind, parent: t.parent, line: t.line, depth: t.depth, path: f.path, project: f.project });
    };

    if (includeSourceTypes) {
      // Step 1: Prefix match via sorted binary search
      const prefixKeys = this._prefixScan(this._sortedTypeNamesLower, nameLower);
      for (const key of prefixKeys) {
        if (candidates.length >= MAX_CANDIDATES) break;
        const ids = this.typesByNameLower.get(key);
        if (ids) for (const tid of ids) addTypeCandidate(tid);
      }

      // Step 1.5: UE prefix-expanded search
      if (candidates.length < MAX_CANDIDATES) {
        const prefixVariants = new Set();
        for (const p of ['a', 'u', 'f', 'e', 's', 'i']) {
          prefixVariants.add(p + nameLower);
          if (nameStripped !== nameLower) prefixVariants.add(p + nameStripped);
        }
        for (const prefix of prefixVariants) {
          if (candidates.length >= MAX_CANDIDATES) break;
          const keys = this._prefixScan(this._sortedTypeNamesLower, prefix);
          for (const key of keys) {
            if (candidates.length >= MAX_CANDIDATES) break;
            const ids = this.typesByNameLower.get(key);
            if (ids) for (const tid of ids) addTypeCandidate(tid);
          }
        }
      }

      // Early termination: skip trigram/substring if prefix matches already saturate results
      const skipDeepSearch = candidates.length >= maxResults;

      // Step 2: Trigram search
      let usedTrigramSearch = false;
      if (!skipDeepSearch && candidates.length < MAX_CANDIDATES && nameLower.length >= 3) {
        const trigrams = [...extractTrigrams(nameLower)];
        if (trigrams.length >= 3) {
          usedTrigramSearch = true;
          const threshold = trigramThreshold(nameLower.length);
          const minMatch = Math.max(2, Math.ceil(trigrams.length * threshold));

          // Count trigram co-occurrences
          const counts = new Map();
          for (const tri of trigrams) {
            const posting = this.typeTrigramIndex.get(tri);
            if (posting) {
              for (const tid of posting) {
                if (!seenIds.has(tid)) {
                  counts.set(tid, (counts.get(tid) || 0) + 1);
                }
              }
            }
          }

          for (const [tid, count] of counts) {
            if (candidates.length >= MAX_CANDIDATES) break;
            if (count >= minMatch) addTypeCandidate(tid);
          }
        }
      }

      // Step 3: Substring scan (only if trigrams weren't used — short queries)
      if (!skipDeepSearch && !usedTrigramSearch && candidates.length < maxResults) {
        for (const [key, ids] of this.typesByNameLower) {
          if (candidates.length >= MAX_CANDIDATES) break;
          if (key.includes(nameLower)) {
            for (const tid of ids) addTypeCandidate(tid);
          }
        }
      }
    }

    // Blueprint assets in fuzzy mode — prefix scan + capped substring
    if (includeBlueprints) {
      const MAX_BP_CANDIDATES = 200;
      let bpCount = 0;

      const addBlueprintCandidate = (aid) => {
        if (bpCount >= MAX_BP_CANDIDATES) return;
        const a = this.assetsById.get(aid);
        if (!a || !a.assetClass) return;
        if (project && a.project !== project) return;
        bpCount++;
        candidates.push({
          name: a.name, kind: 'class', parent: a.parentClass, line: 0,
          path: a.contentPath, project: a.project, asset_class: a.assetClass,
          language: 'blueprint', module: a.folder
        });
      };

      // Prefix scan
      const bpPrefixKeys = this._prefixScan(this._sortedAssetNamesLower, nameLower);
      for (const key of bpPrefixKeys) {
        if (bpCount >= MAX_BP_CANDIDATES) break;
        const ids = this.assetsByNameLower.get(key);
        if (ids) for (const aid of ids) addBlueprintCandidate(aid);
      }

      // Substring fallback if not enough
      if (bpCount < maxResults && this._sortedAssetNamesLower) {
        for (let i = 0; i < this._sortedAssetNamesLower.length && bpCount < MAX_BP_CANDIDATES; i++) {
          const key = this._sortedAssetNamesLower[i];
          if (key.includes(nameLower)) {
            const ids = this.assetsByNameLower.get(key);
            if (ids) for (const aid of ids) addBlueprintCandidate(aid);
          }
        }
      }
    }

    // Score candidates
    const searchWords = splitCamelCase(name);
    const scored = candidates.map(row => {
      const candidateLower = row.name.toLowerCase();
      const candidateStripped = row.name.replace(/^[UAFESI]/, '').toLowerCase();
      let score = 0;
      let matchReason = 'trigram';

      if (candidateLower === nameLower) { score = 1.0; matchReason = 'exact'; }
      else if (candidateStripped === nameStripped) { score = 0.98; matchReason = 'exact-stripped'; }
      else if (candidateStripped === nameLower) { score = 0.97; matchReason = 'exact-stripped'; }
      else if (candidateLower.startsWith(nameLower)) { score = 0.95; matchReason = 'prefix'; }
      else if (candidateStripped.startsWith(nameStripped)) { score = 0.93; matchReason = 'prefix-stripped'; }
      else if (candidateStripped.startsWith(nameLower)) { score = 0.92; matchReason = 'prefix-stripped'; }
      else if (candidateLower.includes(nameLower)) { score = 0.85; matchReason = 'substring'; }
      else if (candidateStripped.includes(nameStripped)) { score = 0.80; matchReason = 'substring-stripped'; }
      else if (searchWords.length >= 2) {
        const candidateWords = splitCamelCase(row.name);
        const matchedWords = searchWords.filter(sw => candidateWords.some(cw => cw === sw));
        const wordRatio = matchedWords.length / searchWords.length;
        const compoundMatched = searchWords.filter(sw =>
          candidateWords.some(cw => cw.startsWith(sw) || sw.startsWith(cw))
        );
        const compoundRatio = compoundMatched.length / searchWords.length;
        const bestRatio = Math.max(wordRatio, compoundRatio);
        if (bestRatio === 1) { score = 0.7; matchReason = 'word-match-all'; }
        else if (bestRatio >= 0.66) { score = 0.5; matchReason = 'word-match-most'; }
        else if (bestRatio >= 0.5) { score = 0.4; matchReason = 'word-match-some'; }
        else { score = 0.3; matchReason = 'word-match-few'; }
      } else {
        score = 0.3;
        matchReason = 'trigram';
      }

      // Getter/setter awareness
      if (score < 0.85) {
        const queryCore = nameLower.replace(/^(get|set|is|has|can|should)/, '');
        const candidateCore = candidateLower.replace(/^(get|set|is|has|can|should)/, '');
        if (queryCore.length > 0 && queryCore === candidateCore && queryCore !== nameLower) {
          score = Math.max(score, 0.88);
          matchReason = 'getter-setter';
        } else if (queryCore.length > 0 && candidateCore.includes(queryCore) && queryCore !== nameLower) {
          score = Math.max(score, 0.75);
          matchReason = matchReason === 'trigram' ? 'getter-setter-partial' : matchReason;
        }
      }

      score += KIND_WEIGHT[row.kind] || 0;
      if (row.depth != null) {
        score += Math.max(0, 0.03 - row.depth * 0.005);
      }

      return { ...row, score, matchReason };
    });

    const filtered = scored.filter(r => r.score >= 0.4);
    filtered.sort((a, b) => b.score - a.score);
    return dedupTypes(filtered).slice(0, maxResults).map(({ id, file_id, ...rest }) => rest);
  }

  findMember(name, options = {}) {
    const { fuzzy = false, containingType = null, containingTypeHierarchy = false,
            memberKind = null, project = null, language = null, maxResults = 20 } = options;

    const typeNames = containingType && containingTypeHierarchy
      ? new Set([containingType, ...this._getSubtypeNames(containingType)])
      : null;

    const matchesContainingType = (typeName) => {
      if (!containingType) return true;
      if (!typeName) return !containingType;
      if (typeNames) {
        return typeNames.has(typeName) || typeName.startsWith(`${containingType}MixinLibrary`);
      }
      return typeName === containingType || typeName.startsWith(`${containingType}MixinLibrary`);
    };

    const matchesFilters = (memberId) => {
      const m = this.membersById.get(memberId);
      if (!m) return null;
      if (memberKind && m.memberKind !== memberKind) return null;
      const f = this.filesById.get(m.fileId);
      if (!f) return null;
      if (project && f.project !== project) return null;
      if (language && language !== 'all' && f.language !== language) return null;

      // Check containing type
      let typeName = null, typeKind = null;
      if (m.typeId) {
        const t = this.typesById.get(m.typeId);
        if (t) { typeName = t.name; typeKind = t.kind; }
      }
      if (!matchesContainingType(typeName)) return null;

      return {
        name: m.name, member_kind: m.memberKind, line: m.line, specifiers: m.specifiers,
        type_name: typeName, type_kind: typeKind, path: f.path, project: f.project
      };
    };

    if (!fuzzy) {
      const memberIds = this.membersByName.get(name) || [];
      let results = [];
      for (const mid of memberIds) {
        const row = matchesFilters(mid);
        if (row) {
          results.push({ ...row, matchReason: 'exact' });
          if (results.length >= maxResults) break;
        }
      }
      results = this._appendSyntheticComponentMethods(results, name, containingType, false, maxResults);
      return results;
    }

    // --- Fuzzy ---
    const nameLower = name.toLowerCase();
    const MAX_CANDIDATES = 200;
    const candidates = [];
    const seenIds = new Set();

    // Step 1: Prefix match via sorted binary search
    const memberPrefixKeys = this._prefixScan(this._sortedMemberNamesLower, nameLower);
    for (const key of memberPrefixKeys) {
      if (candidates.length >= MAX_CANDIDATES) break;
      const ids = this.membersByNameLower.get(key);
      if (ids) {
        for (const mid of ids) {
          if (candidates.length >= MAX_CANDIDATES) break;
          if (seenIds.has(mid)) continue;
          const row = matchesFilters(mid);
          if (row) {
            seenIds.add(mid);
            candidates.push({ id: mid, ...row });
          }
        }
      }
    }

    // Early termination: skip trigram search if prefix matches already saturate results
    const skipDeepSearch = candidates.length >= maxResults;

    // Step 2: Trigram search — also collect per-candidate match counts for scoring
    const trigramMatchCounts = new Map(); // memberId → count of matching query trigrams
    let searchTrigramCount = 0;
    if (!skipDeepSearch && candidates.length < MAX_CANDIDATES && nameLower.length >= 3) {
      const trigrams = [...extractTrigrams(nameLower)];
      searchTrigramCount = trigrams.length;
      if (trigrams.length >= 3) {
        const threshold = trigramThreshold(nameLower.length);
        const minMatch = Math.max(2, Math.ceil(trigrams.length * threshold));

        const counts = new Map();
        for (const tri of trigrams) {
          const posting = this.memberTrigramIndex.get(tri);
          if (posting) {
            for (const mid of posting) {
              if (!seenIds.has(mid)) {
                counts.set(mid, (counts.get(mid) || 0) + 1);
              }
            }
          }
        }

        for (const [mid, count] of counts) {
          if (candidates.length >= MAX_CANDIDATES) break;
          if (count >= minMatch) {
            const row = matchesFilters(mid);
            if (row) {
              seenIds.add(mid);
              trigramMatchCounts.set(mid, count);
              candidates.push({ id: mid, ...row });
            }
          }
        }
      }
    }

    // Score — use count-based approximation instead of per-candidate extractTrigrams
    const searchWords = splitCamelCase(name);

    const scored = candidates.map(row => {
      const candidateLower = row.name.toLowerCase();
      let score = 0;
      let matchReason = 'trigram';

      if (candidateLower === nameLower) { score = 1.0; matchReason = 'exact'; }
      else if (candidateLower.startsWith(nameLower)) { score = 0.95; matchReason = 'prefix'; }
      else if (candidateLower.includes(nameLower)) { score = 0.85; matchReason = 'substring'; }
      else if (nameLower.includes(candidateLower)) { score = 0.8; matchReason = 'reverse-substring'; }
      else if (searchTrigramCount > 0) {
        // Approximate Jaccard using trigram match count from the search phase
        const matchCount = trigramMatchCounts.get(row.id) || 0;
        const estimatedCandidateTrigrams = Math.max(1, candidateLower.length - 2);
        const similarity = matchCount / Math.max(searchTrigramCount, estimatedCandidateTrigrams);
        score = similarity * 0.7;
        matchReason = 'trigram';
      }

      if (score < 0.7 && searchWords.length >= 2) {
        const candidateWords = splitCamelCase(row.name);
        const compoundMatched = searchWords.filter(sw =>
          candidateWords.some(cw => cw.startsWith(sw) || sw.startsWith(cw))
        );
        const compoundRatio = compoundMatched.length / searchWords.length;
        if (compoundRatio === 1 && score < 0.7) { score = 0.7; matchReason = 'word-match-all'; }
        else if (compoundRatio >= 0.66 && score < 0.5) { score = 0.5; matchReason = 'word-match-most'; }
      }

      score += specifierBoost(row.specifiers);
      return { ...row, score, matchReason };
    });

    scored.sort((a, b) => b.score - a.score);
    const MIN_SCORE = 0.15;
    let results = scored.filter(r => r.score >= MIN_SCORE).slice(0, maxResults).map(({ id, ...rest }) => rest);
    results = this._appendSyntheticComponentMethods(results, name, containingType, true, maxResults);
    return results;
  }

  _appendSyntheticComponentMethods(results, name, containingType, fuzzy, maxResults) {
    if (!containingType || results.length >= maxResults) return results;
    const syntheticMethods = ['Get', 'GetOrCreate'];
    const nameLower = name.toLowerCase();
    const existingNames = new Set(results.map(r => r.name));
    const needed = syntheticMethods.filter(m => {
      if (existingNames.has(m)) return false;
      if (!fuzzy && name !== m) return false;
      if (fuzzy && !m.toLowerCase().startsWith(nameLower)) return false;
      return true;
    });
    if (needed.length > 0 && this._isActorComponentDescendant(containingType)) {
      for (const methodName of needed) {
        results.push({
          name: methodName, member_kind: 'function', line: 0, specifiers: 'static',
          type_name: containingType, type_kind: 'class', path: null, project: null,
          matchReason: fuzzy ? 'synthetic-component' : 'exact',
        });
      }
    }
    return results;
  }

  listMembersForType(typeName, options = {}) {
    const { project = null, language = null, maxFunctions = 30, maxProperties = 30 } = options;

    const functions = [];
    const properties = [];
    const enumValues = [];
    let functionsOverflow = false;
    let propertiesOverflow = false;

    const typeIds = this.typesByName.get(typeName) || [];
    for (const tid of typeIds) {
      const t = this.typesById.get(tid);
      if (!t) continue;
      const f = this.filesById.get(t.fileId);
      if (!f) continue;
      if (project && f.project !== project) continue;
      if (language && language !== 'all' && f.language !== language) continue;

      const memberIds = this.membersByTypeId.get(tid) || [];
      for (const mid of memberIds) {
        const m = this.membersById.get(mid);
        if (!m) continue;
        const entry = {
          name: m.name, member_kind: m.memberKind, line: m.line,
          specifiers: m.specifiers, type_name: t.name, type_kind: t.kind,
          path: f.path, project: f.project, matchReason: 'type-member'
        };
        if (m.memberKind === 'function') {
          if (functions.length < maxFunctions) functions.push(entry);
          else functionsOverflow = true;
        } else if (m.memberKind === 'enum_value') {
          enumValues.push(entry);
        } else {
          if (properties.length < maxProperties) properties.push(entry);
          else propertiesOverflow = true;
        }
      }
    }
    return {
      functions, properties, enumValues,
      truncated: { functions: functionsOverflow, properties: propertiesOverflow }
    };
  }

  findFileByName(filename, options = {}) {
    const { project = null, language = null, maxResults = 20 } = options;
    const filenameLower = filename.toLowerCase().replace(/\.[^.]+$/, '');

    const matchingFiles = [];

    // Use sorted index for prefix matches (fast), then trigram/contains for the rest
    const prefixKeys = this._prefixScan(this._sortedBasenames, filenameLower);
    const seenBasenames = new Set(prefixKeys);

    // Also do substring scan on all basenames for contains matches (needed for "actor" → "myactor")
    // But use trigram shortcut: only scan if prefix didn't yield enough results
    const basenameKeys = prefixKeys.length < maxResults
      ? [...new Set([...prefixKeys, ...[...this.filesByBasename.keys()].filter(b => !seenBasenames.has(b) && b.includes(filenameLower))])]
      : prefixKeys;

    for (const basename of basenameKeys) {
      const ids = this.filesByBasename.get(basename);
      if (!ids) continue;
      for (const fid of ids) {
        const f = this.filesById.get(fid);
        if (!f) continue;
        if (project && f.project !== project) continue;
        if (language && language !== 'all' && f.language !== language) continue;

        // Score
        let score;
        if (f.basenameLower === filenameLower) score = 1.0;
        else if (f.basenameLower.startsWith(filenameLower)) score = 0.85;
        else if (f.basenameLower.includes(filenameLower)) score = 0.7;
        else score = 0.5;

        // Path tiebreakers
        const pl = f.pathLower;
        if (pl.endsWith('.h')) score += 0.01;
        if (pl.includes('/runtime/')) score += 0.004;
        else if (pl.includes('/developer/')) score += 0.002;
        if (pl.includes('/public/') || pl.includes('/classes/')) score += 0.003;
        else if (pl.includes('/private/')) score += 0.001;

        matchingFiles.push({ id: f.id, file: f.path, project: f.project, language: f.language, score });
      }
    }

    matchingFiles.sort((a, b) => b.score - a.score || a.file.length - b.file.length);

    const topFiles = matchingFiles.slice(0, maxResults);
    if (topFiles.length === 0) return [];

    // Batch-resolve types
    return topFiles.map(f => {
      const typeIds = this.typesByFileId.get(f.id) || [];
      const types = [];
      for (const tid of typeIds) {
        if (types.length >= 10) break;
        const t = this.typesById.get(tid);
        if (t) types.push({ name: t.name, kind: t.kind, line: t.line });
      }
      return { file: f.file, project: f.project, language: f.language, score: f.score, types };
    });
  }

  findAssetByName(name, options = {}) {
    const { fuzzy = false, project = null, folder = null, maxResults = 20 } = options;

    const matchAsset = (aid) => {
      const a = this.assetsById.get(aid);
      if (!a) return null;
      if (project && a.project !== project) return null;
      if (folder && !a.folder.startsWith(folder)) return null;
      return { name: a.name, content_path: a.contentPath, project: a.project, asset_class: a.assetClass, parent_class: a.parentClass };
    };

    if (!fuzzy) {
      // Exact match
      const ids = this.assetsByName.get(name) || [];
      let results = [];
      for (const aid of ids) {
        const r = matchAsset(aid);
        if (r) results.push(r);
        if (results.length >= maxResults) break;
      }

      if (results.length === 0) {
        // Case-insensitive exact
        const lowerIds = this.assetsByNameLower.get(name.toLowerCase()) || [];
        for (const aid of lowerIds) {
          const r = matchAsset(aid);
          if (r) results.push(r);
          if (results.length >= maxResults) break;
        }
      }

      return results;
    }

    // Fuzzy — prefix scan + capped substring fallback
    const nameLower = name.toLowerCase();
    const MAX_CANDIDATES = 200;
    const candidates = [];
    const seenIds = new Set();

    const addAssetCandidate = (aid) => {
      if (seenIds.has(aid) || candidates.length >= MAX_CANDIDATES) return;
      const a = this.assetsById.get(aid);
      if (!a) return;
      if (project && a.project !== project) return;
      if (folder && !a.folder.startsWith(folder)) return;
      seenIds.add(aid);

      const assetLower = a.name.toLowerCase();
      let score;
      if (assetLower === nameLower) score = 1.0;
      else if (assetLower.startsWith(nameLower)) score = 0.95;
      else if (assetLower.includes(nameLower)) score = 0.85;
      else if (assetLower.endsWith(nameLower)) score = 0.7;
      else score = 0.5;

      candidates.push({
        name: a.name, content_path: a.contentPath, project: a.project,
        asset_class: a.assetClass, parent_class: a.parentClass, score
      });
    };

    // Step 1: Prefix scan via sorted binary search
    const prefixKeys = this._prefixScan(this._sortedAssetNamesLower, nameLower);
    for (const key of prefixKeys) {
      if (candidates.length >= MAX_CANDIDATES) break;
      const ids = this.assetsByNameLower.get(key);
      if (ids) for (const aid of ids) addAssetCandidate(aid);
    }

    // Step 2: Substring scan only if not enough results (short queries)
    if (candidates.length < maxResults) {
      const sorted = this._sortedAssetNamesLower;
      if (sorted) {
        for (let i = 0; i < sorted.length && candidates.length < MAX_CANDIDATES; i++) {
          if (sorted[i].includes(nameLower)) {
            const ids = this.assetsByNameLower.get(sorted[i]);
            if (ids) for (const aid of ids) addAssetCandidate(aid);
          }
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, maxResults);
  }

  findChildrenOf(parentClass, options = {}) {
    const { recursive = true, project = null, language = null, maxResults = 50 } = options;

    const includeSourceTypes = !language || language === 'all' || language === 'angelscript' || language === 'cpp';
    const includeBlueprints = !language || language === 'all' || language === 'blueprint';

    // Check if parent exists
    const parentFoundInTypes = (this.typesByName.get(parentClass) || []).length > 0;
    const parentFoundInAssets = (this.assetsByName.get(parentClass) || []).some(aid => {
      const a = this.assetsById.get(aid);
      return a && a.assetClass;
    });
    const parentFound = parentFoundInTypes || parentFoundInAssets;

    if (!recursive) {
      const results = [];

      if (includeSourceTypes) {
        const childIds = this.typesByParent.get(parentClass) || [];
        for (const tid of childIds) {
          const t = this.typesById.get(tid);
          if (!t) continue;
          if (t.kind !== 'class' && t.kind !== 'struct' && t.kind !== 'interface') continue;
          const f = this.filesById.get(t.fileId);
          if (!f) continue;
          if (project && f.project !== project) continue;
          if (language && language !== 'all' && f.language !== language) continue;
          results.push({ name: t.name, kind: t.kind, parent: t.parent, line: t.line, path: f.path, project: f.project });
          if (results.length >= maxResults) break;
        }
      }

      if (includeBlueprints && results.length < maxResults) {
        const assetNames = [parentClass];
        const stripped = parentClass.replace(/^[AUFESI](?=[A-Z])/, '');
        if (stripped !== parentClass) assetNames.push(stripped);

        for (const pName of assetNames) {
          const childIds = this.assetsByParentClass.get(pName) || [];
          for (const aid of childIds) {
            const a = this.assetsById.get(aid);
            if (!a || !a.assetClass) continue;
            if (project && a.project !== project) continue;
            results.push({
              name: a.name, kind: 'class', parent: a.parentClass, line: 0,
              path: a.contentPath, project: a.project, asset_class: a.assetClass,
              language: 'blueprint', module: a.folder
            });
            if (results.length >= maxResults) break;
          }
        }
      }

      if (results.length > maxResults) results.length = maxResults;
      return { results, truncated: results.length >= maxResults, totalChildren: results.length, parentFound };
    }

    // Recursive — use pre-computed graph
    const descendants = this._getTransitiveDescendants(parentClass);

    if (descendants.size === 0) {
      return { results: [], truncated: false, totalChildren: 0, parentFound };
    }

    const results = [];

    if (includeSourceTypes) {
      for (const childName of descendants) {
        const ids = this.typesByName.get(childName) || [];
        for (const tid of ids) {
          const t = this.typesById.get(tid);
          if (!t) continue;
          if (t.kind !== 'class' && t.kind !== 'struct' && t.kind !== 'interface') continue;
          const f = this.filesById.get(t.fileId);
          if (!f) continue;
          if (project && f.project !== project) continue;
          if (language && language !== 'all' && language !== 'blueprint' && f.language !== language) continue;
          results.push({ name: t.name, kind: t.kind, parent: t.parent, line: t.line, path: f.path, project: f.project });
          if (results.length >= maxResults) break;
        }
        if (results.length >= maxResults) break;
      }
    }

    if (includeBlueprints && results.length < maxResults) {
      for (const childName of descendants) {
        const ids = this.assetsByName.get(childName) || [];
        for (const aid of ids) {
          const a = this.assetsById.get(aid);
          if (!a || !a.assetClass) continue;
          if (project && a.project !== project) continue;
          results.push({
            name: a.name, kind: 'class', parent: a.parentClass, line: 0,
            path: a.contentPath, project: a.project, asset_class: a.assetClass,
            language: 'blueprint', module: a.folder
          });
          if (results.length >= maxResults) break;
        }
        if (results.length >= maxResults) break;
      }
    }

    if (results.length > maxResults) results.length = maxResults;
    const truncated = results.length >= maxResults;
    return { results, truncated, totalChildren: results.length, parentFound };
  }

  browseModule(modulePath, options = {}) {
    const { project = null, language = null, maxResults = 100 } = options;

    const results = [];
    const fileSet = new Set();

    // Gather types from matching modules
    for (const [mod, fileIds] of this.filesByModule) {
      if (mod !== modulePath && !mod.startsWith(modulePath + '.')) continue;

      for (const fid of fileIds) {
        const f = this.filesById.get(fid);
        if (!f) continue;
        if (project && f.project !== project) continue;
        if (language && language !== 'all' && f.language !== language) continue;

        fileSet.add(f.path);

        const typeIds = this.typesByFileId.get(fid) || [];
        for (const tid of typeIds) {
          const t = this.typesById.get(tid);
          if (t) {
            results.push({ name: t.name, kind: t.kind, parent: t.parent, line: t.line, path: f.path, project: f.project, module: f.module });
          }
          if (results.length > maxResults) break;
        }
        if (results.length > maxResults) break;
      }
    }

    const truncated = results.length > maxResults;
    const files = [...fileSet].slice(0, 50);

    if (results.length === 0) {
      // No types — list files directly
      const allFiles = [];
      for (const [mod, fileIds] of this.filesByModule) {
        if (mod !== modulePath && !mod.startsWith(modulePath + '.')) continue;
        for (const fid of fileIds) {
          const f = this.filesById.get(fid);
          if (!f) continue;
          if (project && f.project !== project) continue;
          if (language && language !== 'all' && f.language !== language) continue;
          allFiles.push(f.path);
          if (allFiles.length > maxResults) break;
        }
      }
      return {
        module: modulePath, types: [], files: allFiles.slice(0, maxResults),
        truncated: allFiles.length > maxResults, totalFiles: allFiles.length
      };
    }

    return {
      module: modulePath, types: results.slice(0, maxResults), files,
      truncated, totalFiles: fileSet.size
    };
  }

  listModules(parent = '', options = {}) {
    const { project = null, language = null, depth = 1 } = options;

    const moduleCounts = new Map();
    const parentDepth = parent ? parent.split('.').length : 0;
    const targetDepth = parentDepth + depth;

    for (const [mod, fileIds] of this.filesByModule) {
      if (parent && mod !== parent && !mod.startsWith(parent + '.')) continue;

      // Count files matching filters
      let count = 0;
      for (const fid of fileIds) {
        const f = this.filesById.get(fid);
        if (!f) continue;
        if (project && f.project !== project) continue;
        if (language && language !== 'all' && f.language !== language) continue;
        count++;
      }
      if (count === 0) continue;

      const parts = mod.split('.');
      if (parts.length <= parentDepth) continue;
      const truncated = parts.slice(0, targetDepth).join('.');
      moduleCounts.set(truncated, (moduleCounts.get(truncated) || 0) + count);
    }

    return Array.from(moduleCounts.entries())
      .map(([path, fileCount]) => ({ path, fileCount }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  getStats() {
    return {
      totalFiles: this._stats.totalFiles,
      totalTypes: this._stats.totalTypes,
      totalMembers: this._stats.totalMembers,
      byKind: { ...this._stats.byKind },
      byMemberKind: { ...this._stats.byMemberKind },
      byLanguage: { ...this._stats.byLanguage },
      projects: { ...this._stats.projects }
    };
  }

  getAssetStats() {
    const byProject = new Map();
    const byExtension = new Map();
    const byAssetClass = new Map();
    let blueprintCount = 0;

    for (const [, a] of this.assetsById) {
      byProject.set(a.project, (byProject.get(a.project) || 0) + 1);
      byExtension.set(a.extension, (byExtension.get(a.extension) || 0) + 1);
      const cls = a.assetClass || 'Unknown';
      byAssetClass.set(cls, (byAssetClass.get(cls) || 0) + 1);
      if (a.parentClass) blueprintCount++;
    }

    return {
      total: this.assetsById.size,
      byProject: [...byProject.entries()].map(([project, count]) => ({ project, count })),
      byExtension: [...byExtension.entries()].map(([extension, count]) => ({ extension, count })),
      byAssetClass: [...byAssetClass.entries()].map(([asset_class, count]) => ({ asset_class, count }))
        .sort((a, b) => b.count - a.count),
      blueprintCount
    };
  }

  _recomputeStats() {
    this._stats = {
      totalFiles: this.filesById.size,
      totalTypes: this.typesById.size,
      totalMembers: this.membersById.size,
      totalAssets: this.assetsById.size,
      byKind: {},
      byMemberKind: {},
      byLanguage: {},
      projects: {}
    };

    // Language/project stats from files
    for (const [, f] of this.filesById) {
      if (!this._stats.byLanguage[f.language]) this._stats.byLanguage[f.language] = { files: 0, types: 0 };
      this._stats.byLanguage[f.language].files++;
      if (!this._stats.projects[f.project]) this._stats.projects[f.project] = { files: 0, types: 0, language: f.language };
      this._stats.projects[f.project].files++;
    }

    // Type stats
    for (const [, t] of this.typesById) {
      this._stats.byKind[t.kind] = (this._stats.byKind[t.kind] || 0) + 1;
      const f = this.filesById.get(t.fileId);
      if (f) {
        if (this._stats.byLanguage[f.language]) this._stats.byLanguage[f.language].types++;
        if (this._stats.projects[f.project]) this._stats.projects[f.project].types++;
      }
    }

    // Member stats
    for (const [, m] of this.membersById) {
      this._stats.byMemberKind[m.memberKind] = (this._stats.byMemberKind[m.memberKind] || 0) + 1;
    }
  }

  // --- Phase 6: Ingest sync hooks ---

  removeFile(fileId) {
    // Remove associated types and members first
    const typeIds = this.typesByFileId.get(fileId) || [];
    for (const tid of [...typeIds]) {
      this._removeTypeRecord(tid);
    }
    const memberIds = this.membersByFileId.get(fileId) || [];
    for (const mid of [...memberIds]) {
      this._removeMemberRecord(mid);
    }
    this._removeFileRecord(fileId);
  }

  addFile(fileId, fileRecord) {
    const rec = {
      id: fileId,
      path: fileRecord.path,
      project: fileRecord.project,
      module: fileRecord.module,
      language: fileRecord.language,
      mtime: fileRecord.mtime,
      basenameLower: fileRecord.basenameLower || extractBasename(fileRecord.path),
      pathLower: fileRecord.pathLower || fileRecord.path.toLowerCase().replace(/\\/g, '/'),
      relativePath: fileRecord.relativePath || null
    };
    this._addFileRecord(rec);
  }

  addTypes(fileId, typeRecords) {
    for (const t of typeRecords) {
      this._addTypeRecord({
        id: t.id,
        fileId,
        name: t.name,
        kind: t.kind,
        parent: t.parent || null,
        line: t.line,
        depth: t.depth || null
      });
    }
  }

  addMembers(fileId, memberRecords) {
    for (const m of memberRecords) {
      this._addMemberRecord({
        id: m.id,
        typeId: m.typeId || null,
        fileId,
        name: m.name,
        memberKind: m.memberKind,
        line: m.line,
        isStatic: m.isStatic || 0,
        specifiers: m.specifiers || null
      });
    }
  }

  upsertAssets(assetRecords) {
    for (const a of assetRecords) {
      // Remove existing if present
      const existingId = this.assetsByPath.get(a.path);
      if (existingId != null) {
        this._removeAssetRecord(existingId);
      }
      this._addAssetRecord({
        id: a.id,
        path: a.path,
        name: a.name,
        contentPath: a.contentPath,
        folder: a.folder,
        project: a.project,
        extension: a.extension,
        mtime: a.mtime,
        assetClass: a.assetClass || null,
        parentClass: a.parentClass || null
      });
    }
  }

  removeFileByPath(path) {
    const fileId = this.filesByPath.get(path);
    if (fileId != null) {
      this.removeFile(fileId);
    }
  }

  removeAssetByPath(path) {
    const assetId = this.assetsByPath.get(path);
    if (assetId != null) {
      this._removeAssetRecord(assetId);
    }
  }
}
