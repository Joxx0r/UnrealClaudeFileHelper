import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SLOW_QUERY_MS = 100;

function dedupTypes(results) {
  const best = new Map();
  for (const r of results) {
    const key = `${r.name}:${r.kind}`;
    const existing = best.get(key);
    if (!existing || scoreEntry(r) > scoreEntry(existing)) {
      best.set(key, r);
    }
  }
  return [...best.values()];
}

function scoreEntry(r) {
  let s = 0;
  if (r.parent) s += 10;
  if (r.path && r.path.endsWith('.h')) s += 5;
  return s;
}

export class IndexDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath || join(__dirname, '..', '..', 'data', 'index.db');
    this.db = null;
  }

  open() {
    const dataDir = dirname(this.dbPath);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.createSchema();
    return this;
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        module TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'angelscript',
        mtime INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS types (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        parent TEXT,
        line INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_types_name ON types(name);
      CREATE INDEX IF NOT EXISTS idx_types_name_lower ON types(lower(name));
      CREATE INDEX IF NOT EXISTS idx_types_parent ON types(parent);
      CREATE INDEX IF NOT EXISTS idx_types_kind ON types(kind);
      CREATE INDEX IF NOT EXISTS idx_files_module ON files(module);
      CREATE INDEX IF NOT EXISTS idx_files_project ON files(project);
      CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
      CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);

      CREATE TABLE IF NOT EXISTS members (
        id INTEGER PRIMARY KEY,
        type_id INTEGER REFERENCES types(id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        member_kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        is_static INTEGER DEFAULT 0,
        specifiers TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_members_name ON members(name);
      CREATE INDEX IF NOT EXISTS idx_members_name_lower ON members(lower(name));
      CREATE INDEX IF NOT EXISTS idx_members_type_id ON members(type_id);
      CREATE INDEX IF NOT EXISTS idx_members_file_id ON members(file_id);
      CREATE INDEX IF NOT EXISTS idx_members_kind ON members(member_kind);

      CREATE TABLE IF NOT EXISTS assets (
        id INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        content_path TEXT NOT NULL,
        folder TEXT NOT NULL,
        project TEXT NOT NULL,
        extension TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        asset_class TEXT,
        parent_class TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
      CREATE INDEX IF NOT EXISTS idx_assets_name_lower ON assets(lower(name));
      CREATE INDEX IF NOT EXISTS idx_assets_folder ON assets(folder);
      CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project);
      CREATE INDEX IF NOT EXISTS idx_assets_content_path ON assets(content_path);

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS index_status (
        language TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        progress_current INTEGER DEFAULT 0,
        progress_total INTEGER DEFAULT 0,
        error_message TEXT,
        last_updated TEXT
      );
    `);

    this.migrateSchema();
  }

  migrateSchema() {
    const hasLanguageColumn = this.db.prepare(`
      SELECT COUNT(*) as count FROM pragma_table_info('files') WHERE name = 'language'
    `).get().count > 0;

    if (!hasLanguageColumn) {
      this.db.exec(`ALTER TABLE files ADD COLUMN language TEXT NOT NULL DEFAULT 'angelscript'`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_files_language ON files(language)`);
    }

    const hasStatusTable = this.db.prepare(`
      SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='index_status'
    `).get().count > 0;

    if (!hasStatusTable) {
      this.db.exec(`
        CREATE TABLE index_status (
          language TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending',
          progress_current INTEGER DEFAULT 0,
          progress_total INTEGER DEFAULT 0,
          error_message TEXT,
          last_updated TEXT
        )
      `);
    }

    const hasAssetsTable = this.db.prepare(`
      SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='assets'
    `).get().count > 0;

    if (!hasAssetsTable) {
      this.db.exec(`
        CREATE TABLE assets (
          id INTEGER PRIMARY KEY,
          path TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          content_path TEXT NOT NULL,
          folder TEXT NOT NULL,
          project TEXT NOT NULL,
          extension TEXT NOT NULL,
          mtime INTEGER NOT NULL
        );
        CREATE INDEX idx_assets_name ON assets(name);
        CREATE INDEX idx_assets_name_lower ON assets(lower(name));
        CREATE INDEX idx_assets_folder ON assets(folder);
        CREATE INDEX idx_assets_project ON assets(project);
        CREATE INDEX idx_assets_content_path ON assets(content_path);
      `);
    }

    // Migrate assets table to include asset_class and parent_class columns
    const hasAssetClassColumn = this.db.prepare(`
      SELECT COUNT(*) as count FROM pragma_table_info('assets') WHERE name = 'asset_class'
    `).get().count > 0;

    if (!hasAssetClassColumn) {
      this.db.exec(`ALTER TABLE assets ADD COLUMN asset_class TEXT`);
      this.db.exec(`ALTER TABLE assets ADD COLUMN parent_class TEXT`);
      // Clear assets to trigger re-index with new parser
      this.db.exec(`DELETE FROM assets`);
      this.db.exec(`DELETE FROM index_status WHERE language = 'content'`);
    }
    // Always ensure indexes exist (safe for both new and migrated databases)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_assets_parent_class ON assets(parent_class)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_assets_asset_class ON assets(asset_class)`);

    const hasMembersTable = this.db.prepare(`
      SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='members'
    `).get().count > 0;

    if (!hasMembersTable) {
      this.db.exec(`
        CREATE TABLE members (
          id INTEGER PRIMARY KEY,
          type_id INTEGER REFERENCES types(id) ON DELETE CASCADE,
          file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          member_kind TEXT NOT NULL,
          line INTEGER NOT NULL,
          is_static INTEGER DEFAULT 0,
          specifiers TEXT
        );
        CREATE INDEX idx_members_name ON members(name);
        CREATE INDEX idx_members_name_lower ON members(lower(name));
        CREATE INDEX idx_members_type_id ON members(type_id);
        CREATE INDEX idx_members_file_id ON members(file_id);
        CREATE INDEX idx_members_kind ON members(member_kind);
      `);
    }

    // Trigram index tables for content search
    const hasFileContentTable = this.db.prepare(`
      SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='file_content'
    `).get().count > 0;

    if (!hasFileContentTable) {
      this.db.exec(`
        CREATE TABLE file_content (
          file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
          content BLOB NOT NULL,
          content_hash INTEGER NOT NULL
        );

        CREATE TABLE trigrams (
          trigram INTEGER NOT NULL,
          file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          PRIMARY KEY (trigram, file_id)
        ) WITHOUT ROWID;

        CREATE INDEX idx_trigrams_file ON trigrams(file_id);
      `);

      // Flag that trigram index needs building from existing files
      this.setMetadata('trigramBuildNeeded', true);
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  getFileByPath(path) {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(path);
  }

  getAllFiles() {
    return this.db.prepare('SELECT * FROM files').all();
  }

  projectExists(project) {
    return !!this.db.prepare('SELECT 1 FROM files WHERE project = ? LIMIT 1').get(project);
  }

  getFilteredFiles(project, language) {
    let sql = 'SELECT * FROM files WHERE language != ?';
    const params = ['content'];
    if (project) { sql += ' AND project = ?'; params.push(project); }
    if (language && language !== 'all') { sql += ' AND language = ?'; params.push(language); }
    return this.db.prepare(sql).all(...params);
  }

  upsertFile(path, project, module, mtime, language = 'angelscript') {
    const stmt = this.db.prepare(`
      INSERT INTO files (path, project, module, mtime, language)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        project = excluded.project,
        module = excluded.module,
        mtime = excluded.mtime,
        language = excluded.language
      RETURNING id
    `);
    return stmt.get(path, project, module, mtime, language).id;
  }

  deleteFile(path) {
    // CASCADE handles members, types, file_content, and trigrams
    return this.db.prepare('DELETE FROM files WHERE path = ?').run(path).changes > 0;
  }

  deleteFileById(fileId) {
    // CASCADE handles members, types, file_content, and trigrams
    this.db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
  }

  insertType(fileId, name, kind, parent, line) {
    this.db.prepare(`
      INSERT INTO types (file_id, name, kind, parent, line)
      VALUES (?, ?, ?, ?, ?)
    `).run(fileId, name, kind, parent, line);
  }

  insertTypes(fileId, types) {
    const stmt = this.db.prepare(`
      INSERT INTO types (file_id, name, kind, parent, line)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((items) => {
      for (const item of items) {
        stmt.run(fileId, item.name, item.kind, item.parent || null, item.line);
      }
    });

    insertMany(types);
  }

  clearTypesForFile(fileId) {
    this.db.prepare('DELETE FROM members WHERE file_id = ?').run(fileId);
    this.db.prepare('DELETE FROM types WHERE file_id = ?').run(fileId);
  }

  insertMembers(fileId, members) {
    const stmt = this.db.prepare(`
      INSERT INTO members (type_id, file_id, name, member_kind, line, is_static, specifiers)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((items) => {
      for (const item of items) {
        stmt.run(
          item.typeId || null,
          fileId,
          item.name,
          item.memberKind,
          item.line,
          item.isStatic ? 1 : 0,
          item.specifiers || null
        );
      }
    });

    insertMany(members);
  }

  clearMembersForFile(fileId) {
    this.db.prepare('DELETE FROM members WHERE file_id = ?').run(fileId);
  }

  getTypeIdsForFile(fileId) {
    return this.db.prepare('SELECT id, name FROM types WHERE file_id = ?').all(fileId);
  }

  findMember(name, options = {}) {
    const { fuzzy = false, containingType = null, memberKind = null, project = null, language = null, maxResults = 20 } = options;

    if (!fuzzy) {
      let sql = `
        SELECT m.*, t.name as type_name, t.kind as type_kind, f.path, f.project, f.module, f.language
        FROM members m
        LEFT JOIN types t ON m.type_id = t.id
        JOIN files f ON m.file_id = f.id
        WHERE m.name = ?
      `;
      const params = [name];

      if (containingType) {
        sql += ' AND t.name = ?';
        params.push(containingType);
      }
      if (memberKind) {
        sql += ' AND m.member_kind = ?';
        params.push(memberKind);
      }
      if (project) {
        sql += ' AND f.project = ?';
        params.push(project);
      }
      if (language && language !== 'all') {
        sql += ' AND f.language = ?';
        params.push(language);
      }

      sql += ' LIMIT ?';
      params.push(maxResults);

      return this.db.prepare(sql).all(...params);
    }

    const nameLower = name.toLowerCase();

    let sql = `
      SELECT m.*, t.name as type_name, t.kind as type_kind, f.path, f.project, f.module, f.language
      FROM members m
      LEFT JOIN types t ON m.type_id = t.id
      JOIN files f ON m.file_id = f.id
      WHERE (
        lower(m.name) LIKE ? OR
        lower(m.name) LIKE ?
      )
    `;
    const params = [`${nameLower}%`, `%${nameLower}%`];

    if (containingType) {
      sql += ' AND t.name = ?';
      params.push(containingType);
    }
    if (memberKind) {
      sql += ' AND m.member_kind = ?';
      params.push(memberKind);
    }
    if (project) {
      sql += ' AND f.project = ?';
      params.push(project);
    }
    if (language && language !== 'all') {
      sql += ' AND f.language = ?';
      params.push(language);
    }

    sql += ' LIMIT ?';
    params.push(maxResults * 3);

    const candidates = this.db.prepare(sql).all(...params);

    const scored = candidates.map(row => {
      const candidateLower = row.name.toLowerCase();
      let score = 0;

      if (candidateLower === nameLower) score = 1.0;
      else if (candidateLower.startsWith(nameLower)) score = 0.95;
      else if (candidateLower.includes(nameLower)) score = 0.85;
      else score = 0.5;

      return { ...row, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults);
  }

  listModules(parent = '', options = {}) {
    const { project = null, language = null, depth = 1 } = options;

    let sql = 'SELECT module FROM files WHERE 1=1';
    const params = [];

    if (parent) {
      sql += ' AND (module = ? OR module LIKE ?)';
      params.push(parent, `${parent}.%`);
    }

    if (project) {
      sql += ' AND project = ?';
      params.push(project);
    }

    if (language && language !== 'all') {
      sql += ' AND language = ?';
      params.push(language);
    }

    const rows = this.db.prepare(sql).all(...params);

    const moduleCounts = new Map();
    const parentDepth = parent ? parent.split('.').length : 0;
    const targetDepth = parentDepth + depth;

    for (const row of rows) {
      const parts = row.module.split('.');
      if (parts.length <= parentDepth) continue;

      const truncated = parts.slice(0, targetDepth).join('.');
      moduleCounts.set(truncated, (moduleCounts.get(truncated) || 0) + 1);
    }

    return Array.from(moduleCounts.entries())
      .map(([path, fileCount]) => ({ path, fileCount }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  findTypeByName(name, options = {}) {
    const { fuzzy = false, project = null, language = null, kind = null, maxResults = 10 } = options;

    const includeSourceTypes = !language || language === 'all' || language === 'angelscript' || language === 'cpp';
    const includeBlueprints = !language || language === 'all' || language === 'blueprint';

    if (!fuzzy) {
      let results = [];

      if (includeSourceTypes) {
        let sql = `
          SELECT t.*, f.path, f.project, f.module, f.language
          FROM types t
          JOIN files f ON t.file_id = f.id
          WHERE t.name = ?
        `;
        const params = [name];
        if (kind) { sql += ' AND t.kind = ?'; params.push(kind); }
        if (project) { sql += ' AND f.project = ?'; params.push(project); }
        if (language && language !== 'all' && language !== 'blueprint') {
          sql += ' AND f.language = ?'; params.push(language);
        }
        sql += ' LIMIT ?';
        params.push(maxResults);

        results = this.db.prepare(sql).all(...params);

        if (results.length === 0) {
          // Strategy 1: Try adding each UE prefix to the original name
          // Handles: "EmbarkGameMode" → finds "AEmbarkGameMode"
          for (const prefix of ['A', 'U', 'F', 'E', 'S', 'I']) {
            const tryName = prefix + name;
            if (tryName !== name) {
              params[0] = tryName;
              results = this.db.prepare(sql).all(...params);
              if (results.length > 0) break;
            }
          }

          // Strategy 2: Strip existing prefix and try alternatives
          // Handles: "UMyActor" → finds "AMyActor"
          if (results.length === 0) {
            const nameWithoutPrefix = name.replace(/^[UAFESI]/, '');
            if (nameWithoutPrefix !== name) {
              for (const prefix of ['A', 'U', 'F', 'E', 'S', 'I', '']) {
                const tryName = prefix + nameWithoutPrefix;
                if (tryName !== name) {
                  params[0] = tryName;
                  results = this.db.prepare(sql).all(...params);
                  if (results.length > 0) break;
                }
              }
            }
          }
        }
      }

      // Also search Blueprint assets
      if (includeBlueprints && results.length < maxResults) {
        let assetSql = `
          SELECT name, content_path as path, project, parent_class as parent, asset_class,
                 'blueprint' as language, 'class' as kind, folder as module, 0 as line
          FROM assets
          WHERE name = ? AND asset_class IS NOT NULL
        `;
        const assetParams = [name];
        if (project) { assetSql += ' AND project = ?'; assetParams.push(project); }
        assetSql += ' LIMIT ?';
        assetParams.push(maxResults - results.length);

        let assetResults = this.db.prepare(assetSql).all(...assetParams);

        // Try without _C suffix (BlueprintGeneratedClass names end in _C)
        if (assetResults.length === 0 && name.endsWith('_C')) {
          assetParams[0] = name.slice(0, -2);
          assetResults = this.db.prepare(assetSql).all(...assetParams);
        }

        results.push(...assetResults);
      }

      return dedupTypes(results);
    }

    const nameLower = name.toLowerCase();
    const nameStripped = name.replace(/^[UAFESI]/, '').toLowerCase();

    const candidates = [];

    if (includeSourceTypes) {
      let sql = `
        SELECT t.*, f.path, f.project, f.module, f.language
        FROM types t
        JOIN files f ON t.file_id = f.id
        WHERE (
          lower(t.name) LIKE ? OR
          lower(t.name) LIKE ? OR
          lower(t.name) LIKE ?
        )
      `;
      const params = [`${nameLower}%`, `%${nameLower}%`, `%${nameStripped}%`];
      if (kind) { sql += ' AND t.kind = ?'; params.push(kind); }
      if (project) { sql += ' AND f.project = ?'; params.push(project); }
      if (language && language !== 'all' && language !== 'blueprint') {
        sql += ' AND f.language = ?'; params.push(language);
      }
      sql += ' LIMIT ?';
      params.push(maxResults * 3);
      candidates.push(...this.db.prepare(sql).all(...params));
    }

    if (includeBlueprints) {
      let assetSql = `
        SELECT name, content_path as path, project, parent_class as parent, asset_class,
               'blueprint' as language, 'class' as kind, folder as module, 0 as line
        FROM assets
        WHERE (lower(name) LIKE ? OR lower(name) LIKE ?) AND asset_class IS NOT NULL
      `;
      const assetParams = [`${nameLower}%`, `%${nameLower}%`];
      if (project) { assetSql += ' AND project = ?'; assetParams.push(project); }
      assetSql += ' LIMIT ?';
      assetParams.push(maxResults * 2);
      candidates.push(...this.db.prepare(assetSql).all(...assetParams));
    }

    const scored = candidates.map(row => {
      const candidateLower = row.name.toLowerCase();
      const candidateStripped = row.name.replace(/^[UAFESI]/, '').toLowerCase();
      let score = 0;

      if (candidateLower === nameLower) score = 1.0;
      else if (candidateStripped === nameStripped) score = 0.98;
      else if (candidateLower.startsWith(nameLower)) score = 0.95;
      else if (candidateStripped.startsWith(nameStripped)) score = 0.93;
      else if (candidateLower.includes(nameLower)) score = 0.85;
      else if (candidateStripped.includes(nameStripped)) score = 0.80;
      else score = 0.5;

      return { ...row, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return dedupTypes(scored).slice(0, maxResults);
  }

  findChildrenOf(parentClass, options = {}) {
    const { recursive = true, project = null, language = null, maxResults = 50 } = options;

    const includeSourceTypes = !language || language === 'all' || language === 'angelscript' || language === 'cpp';
    const includeBlueprints = !language || language === 'all' || language === 'blueprint';

    const parentFound = !!(
      this.db.prepare('SELECT 1 FROM types WHERE name = ? LIMIT 1').get(parentClass) ||
      this.db.prepare('SELECT 1 FROM assets WHERE name = ? AND asset_class IS NOT NULL LIMIT 1').get(parentClass)
    );

    if (!recursive) {
      const results = [];

      if (includeSourceTypes) {
        let sql = `
          SELECT t.*, f.path, f.project, f.module, f.language
          FROM types t
          JOIN files f ON t.file_id = f.id
          WHERE t.parent = ? AND t.kind IN ('class', 'struct', 'interface')
        `;
        const params = [parentClass];
        if (project) { sql += ' AND f.project = ?'; params.push(project); }
        if (language && language !== 'all') { sql += ' AND f.language = ?'; params.push(language); }
        sql += ' LIMIT ?';
        params.push(maxResults);
        results.push(...this.db.prepare(sql).all(...params));
      }

      if (includeBlueprints && results.length < maxResults) {
        let assetSql = `
          SELECT name, content_path as path, project, parent_class as parent, asset_class,
                 'blueprint' as language, 'class' as kind, folder as module, 0 as line
          FROM assets
          WHERE parent_class = ? AND asset_class IS NOT NULL
        `;
        const assetParams = [parentClass];
        if (project) { assetSql += ' AND project = ?'; assetParams.push(project); }
        assetSql += ' LIMIT ?';
        assetParams.push(maxResults - results.length);
        results.push(...this.db.prepare(assetSql).all(...assetParams));
      }

      return { results, truncated: false, parentFound };
    }

    // Phase 1: Traverse full inheritance tree WITHOUT project/language filter
    // so cross-project inheritance chains are followed completely
    const children = new Set();
    const queue = [parentClass];
    const traversalStmt = this.db.prepare(`
      SELECT t.name FROM types t
      WHERE t.parent = ? AND t.kind IN ('class', 'struct', 'interface')
    `);
    const assetTraversalStmt = this.db.prepare(`
      SELECT name FROM assets WHERE parent_class = ? AND asset_class IS NOT NULL
    `);

    while (queue.length > 0) {
      const current = queue.shift();
      const directChildren = traversalStmt.all(current);
      for (const child of directChildren) {
        if (!children.has(child.name)) {
          children.add(child.name);
          queue.push(child.name);
        }
      }
      // Also check Blueprint assets for children
      const assetChildren = assetTraversalStmt.all(current);
      for (const child of assetChildren) {
        if (!children.has(child.name)) {
          children.add(child.name);
          queue.push(child.name);
        }
      }
    }

    if (children.size === 0) {
      return { results: [], truncated: false, totalChildren: 0, parentFound };
    }

    // Phase 2: Fetch full details, applying project/language filter to results only
    const results = [];
    const names = [...children];

    if (includeSourceTypes) {
      const placeholders = names.map(() => '?').join(',');
      let sql = `
        SELECT t.*, f.path, f.project, f.module, f.language
        FROM types t
        JOIN files f ON t.file_id = f.id
        WHERE t.name IN (${placeholders})
          AND t.kind IN ('class', 'struct', 'interface')
      `;
      const params = [...names];
      if (project) { sql += ' AND f.project = ?'; params.push(project); }
      if (language && language !== 'all' && language !== 'blueprint') {
        sql += ' AND f.language = ?'; params.push(language);
      }
      sql += ' LIMIT ?';
      params.push(maxResults);
      results.push(...this.db.prepare(sql).all(...params));
    }

    if (includeBlueprints && results.length < maxResults) {
      const placeholders = names.map(() => '?').join(',');
      let assetSql = `
        SELECT name, content_path as path, project, parent_class as parent, asset_class,
               'blueprint' as language, 'class' as kind, folder as module, 0 as line
        FROM assets
        WHERE name IN (${placeholders}) AND asset_class IS NOT NULL
      `;
      const assetParams = [...names];
      if (project) { assetSql += ' AND project = ?'; assetParams.push(project); }
      assetSql += ' LIMIT ?';
      assetParams.push(maxResults - results.length);
      results.push(...this.db.prepare(assetSql).all(...assetParams));
    }

    const totalChildren = children.size;
    const truncated = results.length >= maxResults;

    return { results, truncated, totalChildren, parentFound };
  }

  browseModule(modulePath, options = {}) {
    const { project = null, language = null, maxResults = 100 } = options;

    let sql = `
      SELECT t.*, f.path, f.project, f.module, f.language
      FROM types t
      JOIN files f ON t.file_id = f.id
      WHERE (f.module = ? OR f.module LIKE ?)
    `;
    const params = [modulePath, `${modulePath}.%`];

    if (project) {
      sql += ' AND f.project = ?';
      params.push(project);
    }

    if (language && language !== 'all') {
      sql += ' AND f.language = ?';
      params.push(language);
    }

    sql += ' LIMIT ?';
    params.push(maxResults + 1);

    const results = this.db.prepare(sql).all(...params);
    const truncated = results.length > maxResults;

    const files = [...new Set(results.map(r => r.path))];

    return {
      module: modulePath,
      types: results.slice(0, maxResults),
      files: files.slice(0, 50),
      truncated,
      totalFiles: files.length
    };
  }

  findFileByName(filename, options = {}) {
    const { project = null, language = null, maxResults = 20 } = options;
    const filenameLower = filename.toLowerCase().replace(/\.(as|h|cpp)$/, '');

    const exactFilePattern = `%/${filenameLower}.%`;
    const startsWithPattern = `%/${filenameLower}%`;
    const containsPattern = `%${filenameLower}%`;

    let sql = `
      SELECT f.*,
        CASE
          WHEN lower(f.path) LIKE ? THEN 1.0
          WHEN lower(f.path) LIKE ? THEN 0.85
          WHEN lower(f.path) LIKE ? THEN 0.7
          ELSE 0.5
        END + (CASE WHEN lower(f.path) LIKE '%.h' THEN 0.01 ELSE 0 END) as score
      FROM files f
      WHERE (
        lower(f.path) LIKE ? OR
        lower(f.path) LIKE ?
      )
    `;

    const params = [exactFilePattern, startsWithPattern, containsPattern, startsWithPattern, containsPattern];

    if (project) {
      sql += ' AND f.project = ?';
      params.push(project);
    }

    if (language && language !== 'all') {
      sql += ' AND f.language = ?';
      params.push(language);
    }

    sql += ' ORDER BY score DESC LIMIT ?';
    params.push(maxResults);

    const files = this.db.prepare(sql).all(...params);

    return files.map(f => {
      const types = this.db.prepare(`
        SELECT name, kind, line FROM types WHERE file_id = ? LIMIT 10
      `).all(f.id);

      return {
        file: f.path,
        project: f.project,
        module: f.module,
        language: f.language,
        score: f.score,
        types
      };
    });
  }

  getStats() {
    const totalFiles = this.db.prepare('SELECT COUNT(*) as count FROM files').get().count;
    const totalTypes = this.db.prepare('SELECT COUNT(*) as count FROM types').get().count;
    const totalMembers = this.db.prepare('SELECT COUNT(*) as count FROM members').get().count;

    const kindCounts = this.db.prepare(`
      SELECT kind, COUNT(*) as count FROM types GROUP BY kind
    `).all();

    const memberKindCounts = this.db.prepare(`
      SELECT member_kind, COUNT(*) as count FROM members GROUP BY member_kind
    `).all();

    // File counts per project/language (no JOIN needed)
    const fileCounts = this.db.prepare(`
      SELECT project, language, COUNT(*) as files FROM files GROUP BY project, language
    `).all();

    // Type counts per project/language (no JOIN needed)
    const typeCounts = this.db.prepare(`
      SELECT f.project, f.language, COUNT(*) as types
      FROM types t JOIN files f ON t.file_id = f.id
      GROUP BY f.project, f.language
    `).all();

    const stats = {
      totalFiles,
      totalTypes,
      totalMembers,
      byKind: {},
      byMemberKind: {},
      byLanguage: {},
      projects: {}
    };

    for (const { kind, count } of kindCounts) {
      stats.byKind[kind] = count;
    }

    for (const row of memberKindCounts) {
      stats.byMemberKind[row.member_kind] = row.count;
    }

    // Build projects map from file counts
    for (const row of fileCounts) {
      if (!stats.projects[row.project]) {
        stats.projects[row.project] = { files: 0, types: 0, language: row.language };
      }
      stats.projects[row.project].files += row.files;
    }

    // Add type counts to projects
    for (const row of typeCounts) {
      if (stats.projects[row.project]) {
        stats.projects[row.project].types += row.types;
      }
    }

    // Derive language counts from project data (no extra query)
    for (const row of fileCounts) {
      if (!stats.byLanguage[row.language]) {
        stats.byLanguage[row.language] = { files: 0, types: 0 };
      }
      stats.byLanguage[row.language].files += row.files;
    }
    for (const row of typeCounts) {
      if (stats.byLanguage[row.language]) {
        stats.byLanguage[row.language].types += row.types;
      }
    }

    return stats;
  }

  getAllTypeNames() {
    return this.db.prepare('SELECT DISTINCT name FROM types ORDER BY name').all().map(r => r.name);
  }

  setMetadata(key, value) {
    this.db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, JSON.stringify(value));
  }

  getMetadata(key) {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  }

  transaction(fn) {
    return this.db.transaction(fn)();
  }

  isEmpty() {
    return !this.db.prepare('SELECT 1 FROM files LIMIT 1').get();
  }

  isLanguageEmpty(language) {
    return !this.db.prepare('SELECT 1 FROM files WHERE language = ? LIMIT 1').get(language);
  }

  setIndexStatus(language, status, progressCurrent = 0, progressTotal = 0, errorMessage = null) {
    this.db.prepare(`
      INSERT INTO index_status (language, status, progress_current, progress_total, error_message, last_updated)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(language) DO UPDATE SET
        status = excluded.status,
        progress_current = excluded.progress_current,
        progress_total = excluded.progress_total,
        error_message = excluded.error_message,
        last_updated = excluded.last_updated
    `).run(language, status, progressCurrent, progressTotal, errorMessage, new Date().toISOString());
  }

  getIndexStatus(language) {
    const row = this.db.prepare('SELECT * FROM index_status WHERE language = ?').get(language);
    if (!row) {
      return { language, status: 'pending', progress_current: 0, progress_total: 0 };
    }
    return row;
  }

  getAllIndexStatus() {
    return this.db.prepare('SELECT * FROM index_status').all();
  }

  clearLanguage(language) {
    this.db.prepare('DELETE FROM files WHERE language = ?').run(language);
  }

  getFilesByLanguage(language) {
    return this.db.prepare('SELECT * FROM files WHERE language = ?').all(language);
  }

  insertTypesBatch(fileId, types) {
    const stmt = this.db.prepare(`
      INSERT INTO types (file_id, name, kind, parent, line)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((items) => {
      for (const item of items) {
        stmt.run(fileId, item.name, item.kind, item.parent || null, item.line);
      }
    });

    insertMany(types);
  }

  // --- Asset methods ---

  upsertAssetBatch(assets) {
    const stmt = this.db.prepare(`
      INSERT INTO assets (path, name, content_path, folder, project, extension, mtime, asset_class, parent_class)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        name = excluded.name,
        content_path = excluded.content_path,
        folder = excluded.folder,
        project = excluded.project,
        extension = excluded.extension,
        mtime = excluded.mtime,
        asset_class = excluded.asset_class,
        parent_class = excluded.parent_class
    `);

    const insertMany = this.db.transaction((items) => {
      for (const item of items) {
        stmt.run(item.path, item.name, item.contentPath, item.folder, item.project, item.extension, item.mtime,
          item.assetClass || null, item.parentClass || null);
      }
    });

    insertMany(assets);
  }

  deleteAsset(path) {
    return this.db.prepare('DELETE FROM assets WHERE path = ?').run(path).changes > 0;
  }

  clearAssets(project) {
    if (project) {
      this.db.prepare('DELETE FROM assets WHERE project = ?').run(project);
    } else {
      this.db.exec('DELETE FROM assets');
    }
  }

  isAssetIndexEmpty(project) {
    if (project) {
      return !this.db.prepare('SELECT 1 FROM assets WHERE project = ? LIMIT 1').get(project);
    }
    return !this.db.prepare('SELECT 1 FROM assets LIMIT 1').get();
  }

  findAssetByName(name, options = {}) {
    const { fuzzy = false, project = null, folder = null, maxResults = 20 } = options;

    if (!fuzzy) {
      let sql = 'SELECT * FROM assets WHERE name = ?';
      const params = [name];

      if (project) { sql += ' AND project = ?'; params.push(project); }
      if (folder) { sql += ' AND folder LIKE ?'; params.push(folder + '%'); }
      sql += ' LIMIT ?';
      params.push(maxResults);

      let results = this.db.prepare(sql).all(...params);

      if (results.length === 0) {
        // Try case-insensitive exact match
        sql = 'SELECT * FROM assets WHERE lower(name) = lower(?)';
        const params2 = [name];
        if (project) { sql += ' AND project = ?'; params2.push(project); }
        if (folder) { sql += ' AND folder LIKE ?'; params2.push(folder + '%'); }
        sql += ' LIMIT ?';
        params2.push(maxResults);
        results = this.db.prepare(sql).all(...params2);
      }

      return results;
    }

    const nameLower = name.toLowerCase();
    let sql = `
      SELECT *,
        CASE
          WHEN lower(name) = ? THEN 1.0
          WHEN lower(name) LIKE ? THEN 0.95
          WHEN lower(name) LIKE ? THEN 0.85
          WHEN lower(name) LIKE ? THEN 0.7
          ELSE 0.5
        END as score
      FROM assets
      WHERE (lower(name) LIKE ? OR lower(name) LIKE ?)
    `;
    const params = [
      nameLower,
      nameLower + '%',
      '%' + nameLower + '%',
      '%' + nameLower,
      nameLower + '%',
      '%' + nameLower + '%'
    ];

    if (project) { sql += ' AND project = ?'; params.push(project); }
    if (folder) { sql += ' AND folder LIKE ?'; params.push(folder + '%'); }
    sql += ' ORDER BY score DESC LIMIT ?';
    params.push(maxResults);

    return this.db.prepare(sql).all(...params);
  }

  browseAssetFolder(folder, options = {}) {
    const { project = null, maxResults = 100 } = options;

    let sql = 'SELECT * FROM assets WHERE folder = ?';
    const params = [folder];

    if (project) { sql += ' AND project = ?'; params.push(project); }
    sql += ' ORDER BY name LIMIT ?';
    params.push(maxResults + 1);

    const results = this.db.prepare(sql).all(...params);
    const truncated = results.length > maxResults;

    return { assets: results.slice(0, maxResults), truncated };
  }

  listAssetFolders(parent = '/Game', options = {}) {
    const { project = null, depth = 1 } = options;

    let sql = 'SELECT folder FROM assets WHERE folder LIKE ?';
    const params = [parent + '%'];

    if (project) { sql += ' AND project = ?'; params.push(project); }

    const rows = this.db.prepare(sql).all(...params);

    const parentDepth = parent === '/' ? 0 : parent.split('/').filter(Boolean).length;
    const targetDepth = parentDepth + depth;
    const folderCounts = new Map();

    for (const row of rows) {
      const parts = row.folder.split('/').filter(Boolean);
      if (parts.length <= parentDepth) continue;

      const truncated = '/' + parts.slice(0, targetDepth).join('/');
      folderCounts.set(truncated, (folderCounts.get(truncated) || 0) + 1);
    }

    return Array.from(folderCounts.entries())
      .map(([path, assetCount]) => ({ path, assetCount }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  getAssetStats() {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM assets').get().count;

    const byProject = this.db.prepare(`
      SELECT project, COUNT(*) as count FROM assets GROUP BY project
    `).all();

    const byExtension = this.db.prepare(`
      SELECT extension, COUNT(*) as count FROM assets GROUP BY extension
    `).all();

    const byAssetClass = this.db.prepare(`
      SELECT COALESCE(asset_class, 'Unknown') as asset_class, COUNT(*) as count
      FROM assets GROUP BY asset_class ORDER BY count DESC
    `).all();

    const blueprintCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM assets WHERE parent_class IS NOT NULL
    `).get().count;

    return { total, byProject, byExtension, byAssetClass, blueprintCount };
  }

  // --- Trigram index methods ---

  upsertFileContent(fileId, compressedContent, hash) {
    const existing = this.db.prepare('SELECT 1 FROM file_content WHERE file_id = ?').get(fileId);
    this.db.prepare(`
      INSERT INTO file_content (file_id, content, content_hash)
      VALUES (?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET
        content = excluded.content,
        content_hash = excluded.content_hash
    `).run(fileId, compressedContent, hash);
    if (!existing) {
      this._adjustTrigramFileCount(1);
    }
  }

  getFileContent(fileId) {
    return this.db.prepare('SELECT content, content_hash FROM file_content WHERE file_id = ?').get(fileId);
  }

  getFileContentBatch(fileIds) {
    if (fileIds.length === 0) return new Map();
    const placeholders = fileIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT file_id, content, content_hash FROM file_content WHERE file_id IN (${placeholders})`
    ).all(...fileIds);
    const map = new Map();
    for (const row of rows) {
      map.set(row.file_id, { content: row.content, content_hash: row.content_hash });
    }
    return map;
  }

  clearTrigramsForFile(fileId) {
    const count = this.db.prepare('SELECT COUNT(*) as count FROM trigrams WHERE file_id = ?').get(fileId).count;
    if (count > 0) {
      this.db.prepare('DELETE FROM trigrams WHERE file_id = ?').run(fileId);
      this._adjustTrigramCount(-count);
    }
  }

  insertTrigrams(fileId, trigrams) {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO trigrams (trigram, file_id) VALUES (?, ?)'
    );
    let inserted = 0;
    const insertMany = this.db.transaction((items) => {
      for (const tri of items) {
        const result = stmt.run(tri, fileId);
        inserted += result.changes;
      }
    });
    insertMany(trigrams);
    if (inserted > 0) {
      this._adjustTrigramCount(inserted);
    }
  }

  /**
   * Query trigram index for candidate files matching all given trigrams.
   * Returns array of { file_id, content, path, project, language }.
   * Applies project/language filters.
   */
  queryTrigramCandidates(trigrams, { project, language } = {}) {
    if (trigrams.length === 0) {
      // Unindexable query — signal caller to fall back to disk-based grep
      return null;
    }

    const placeholders = trigrams.map(() => '?').join(',');
    let sql = `
      SELECT fc.file_id, fc.content, f.path, f.project, f.language
      FROM trigrams t
      JOIN file_content fc ON t.file_id = fc.file_id
      JOIN files f ON f.id = fc.file_id
      WHERE t.trigram IN (${placeholders})
        AND f.language != 'content'
    `;
    const params = [...trigrams];
    if (project) { sql += ' AND f.project = ?'; params.push(project); }
    if (language && language !== 'all') { sql += ' AND f.language = ?'; params.push(language); }
    sql += ' GROUP BY t.file_id HAVING COUNT(DISTINCT t.trigram) = ?';
    params.push(trigrams.length);

    return this.db.prepare(sql).all(...params);
  }

  isTrigramIndexReady() {
    const needed = this.getMetadata('trigramBuildNeeded');
    return needed === false || needed === null;
  }

  hasTrigramTables() {
    if (this._hasTrigramTables !== undefined) return this._hasTrigramTables;
    this._hasTrigramTables = this.db.prepare(`
      SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='file_content'
    `).get().count > 0;
    return this._hasTrigramTables;
  }

  getTrigramStats() {
    if (!this.hasTrigramTables()) return null;
    const fileCount = this.getMetadata('trigramFileCount') || 0;
    const trigramCount = this.getMetadata('trigramCount') || 0;
    return { filesWithContent: fileCount, trigramRows: trigramCount };
  }

  _adjustTrigramCount(delta) {
    const current = this.getMetadata('trigramCount') || 0;
    this.setMetadata('trigramCount', current + delta);
  }

  _adjustTrigramFileCount(delta) {
    const current = this.getMetadata('trigramFileCount') || 0;
    this.setMetadata('trigramFileCount', current + delta);
  }

  recalculateTrigramCount() {
    const count = this.db.prepare('SELECT COUNT(*) as count FROM trigrams').get().count;
    const fileCount = this.db.prepare('SELECT COUNT(*) as count FROM file_content').get().count;
    this.setMetadata('trigramCount', count);
    this.setMetadata('trigramFileCount', fileCount);
    return count;
  }

  getFilesWithoutContent() {
    return this.db.prepare(`
      SELECT f.id, f.path, f.project, f.language
      FROM files f
      LEFT JOIN file_content fc ON f.id = fc.file_id
      WHERE fc.file_id IS NULL AND f.language NOT IN ('content', 'config')
    `).all();
  }
}

// Wrap key methods with slow-query timing
const methodsToTime = [
  'findTypeByName', 'findChildrenOf', 'findMember', 'findFileByName',
  'findAssetByName', 'getStats', 'getAssetStats', 'upsertAssetBatch',
  'queryTrigramCandidates'
];
for (const method of methodsToTime) {
  const original = IndexDatabase.prototype[method];
  IndexDatabase.prototype[method] = function (...args) {
    const start = performance.now();
    const result = original.apply(this, args);
    const ms = performance.now() - start;
    if (ms >= SLOW_QUERY_MS) {
      const arg0 = typeof args[0] === 'string' ? `"${args[0]}"` : Array.isArray(args[0]) ? `[${args[0].length} items]` : '';
      console.log(`[DB] ${method}(${arg0}) — ${ms.toFixed(1)}ms`);
    }
    return result;
  };
}
