import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
    const file = this.getFileByPath(path);
    if (file) {
      this.db.prepare('DELETE FROM members WHERE file_id = ?').run(file.id);
      this.db.prepare('DELETE FROM types WHERE file_id = ?').run(file.id);
      this.db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
      return true;
    }
    return false;
  }

  deleteFileById(fileId) {
    this.db.prepare('DELETE FROM members WHERE file_id = ?').run(fileId);
    this.db.prepare('DELETE FROM types WHERE file_id = ?').run(fileId);
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

    if (!fuzzy) {
      let sql = `
        SELECT t.*, f.path, f.project, f.module, f.language
        FROM types t
        JOIN files f ON t.file_id = f.id
        WHERE t.name = ?
      `;
      const params = [name];

      if (kind) {
        sql += ' AND t.kind = ?';
        params.push(kind);
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

      let results = this.db.prepare(sql).all(...params);

      if (results.length === 0) {
        const nameWithoutPrefix = name.replace(/^[UAFESI]/, '');
        for (const prefix of ['U', 'A', 'F', 'E', 'S', 'I', '']) {
          const tryName = prefix + nameWithoutPrefix;
          if (tryName !== name) {
            params[0] = tryName;
            results = this.db.prepare(sql).all(...params);
            if (results.length > 0) break;
          }
        }
      }

      return results;
    }

    const nameLower = name.toLowerCase();
    const nameStripped = name.replace(/^[UAFESI]/, '').toLowerCase();

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

    if (kind) {
      sql += ' AND t.kind = ?';
      params.push(kind);
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
    return scored.slice(0, maxResults);
  }

  findChildrenOf(parentClass, options = {}) {
    const { recursive = true, project = null, language = null, maxResults = 50 } = options;

    if (!recursive) {
      let sql = `
        SELECT t.*, f.path, f.project, f.module, f.language
        FROM types t
        JOIN files f ON t.file_id = f.id
        WHERE t.parent = ? AND t.kind IN ('class', 'struct', 'interface')
      `;
      const params = [parentClass];

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

      return { results: this.db.prepare(sql).all(...params), truncated: false };
    }

    const children = new Set();
    const queue = [parentClass];
    const results = [];

    while (queue.length > 0 && results.length < maxResults) {
      const current = queue.shift();

      let sql = `
        SELECT t.*, f.path, f.project, f.module, f.language
        FROM types t
        JOIN files f ON t.file_id = f.id
        WHERE t.parent = ? AND t.kind IN ('class', 'struct', 'interface')
      `;
      const params = [current];

      if (project) {
        sql += ' AND f.project = ?';
        params.push(project);
      }

      if (language && language !== 'all') {
        sql += ' AND f.language = ?';
        params.push(language);
      }

      const directChildren = this.db.prepare(sql).all(...params);

      for (const child of directChildren) {
        if (!children.has(child.name)) {
          children.add(child.name);
          results.push(child);
          queue.push(child.name);
        }
      }
    }

    const totalChildren = children.size;
    const truncated = results.length >= maxResults;

    return { results: results.slice(0, maxResults), truncated, totalChildren };
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

    let sql = `
      SELECT f.*,
        CASE
          WHEN lower(f.path) LIKE ? THEN 1.0
          WHEN lower(f.path) LIKE ? THEN 0.9
          WHEN lower(f.path) LIKE ? THEN 0.7
          ELSE 0.5
        END as score
      FROM files f
      WHERE (
        lower(f.path) LIKE ? OR
        lower(f.path) LIKE ?
      )
    `;

    const exactPattern = `%${filenameLower}.%`;
    const startsWithPattern = `%/${filenameLower}%`;
    const containsPattern = `%${filenameLower}%`;

    const params = [exactPattern, startsWithPattern, containsPattern, startsWithPattern, containsPattern];

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

    const kindCounts = this.db.prepare(`
      SELECT kind, COUNT(*) as count FROM types GROUP BY kind
    `).all();

    const projectCounts = this.db.prepare(`
      SELECT f.project, f.language, COUNT(DISTINCT f.id) as files, COUNT(t.id) as types
      FROM files f
      LEFT JOIN types t ON f.id = t.file_id
      GROUP BY f.project, f.language
    `).all();

    const languageCounts = this.db.prepare(`
      SELECT f.language, COUNT(DISTINCT f.id) as files, COUNT(t.id) as types
      FROM files f
      LEFT JOIN types t ON f.id = t.file_id
      GROUP BY f.language
    `).all();

    const totalMembers = this.db.prepare('SELECT COUNT(*) as count FROM members').get().count;

    const memberKindCounts = this.db.prepare(`
      SELECT member_kind, COUNT(*) as count FROM members GROUP BY member_kind
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

    for (const row of languageCounts) {
      stats.byLanguage[row.language] = { files: row.files, types: row.types };
    }

    for (const row of projectCounts) {
      if (!stats.projects[row.project]) {
        stats.projects[row.project] = { files: 0, types: 0, language: row.language };
      }
      stats.projects[row.project].files += row.files;
      stats.projects[row.project].types += row.types;
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
    return this.db.prepare('SELECT COUNT(*) as count FROM files').get().count === 0;
  }

  isLanguageEmpty(language) {
    return this.db.prepare('SELECT COUNT(*) as count FROM files WHERE language = ?').get(language).count === 0;
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
    this.db.exec(`DELETE FROM files WHERE language = '${language}'`);
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
}
