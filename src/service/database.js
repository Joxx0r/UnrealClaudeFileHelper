import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';
import { deflateSync } from 'zlib';
import { extractTrigrams, contentHash } from './trigram.js';

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
    this.readOnly = false;
  }

  open(readOnly = false) {
    if (readOnly) {
      this.db = new Database(this.dbPath, { readonly: true });
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('cache_size = -262144'); // 256MB page cache per connection
      this.readOnly = true;
      return this;
    }

    const dataDir = dirname(this.dbPath);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('cache_size = -262144'); // 256MB page cache
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
      CREATE INDEX IF NOT EXISTS idx_types_parent_kind ON types(parent, kind);
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
      CREATE INDEX IF NOT EXISTS idx_assets_parent_class ON assets(parent_class);

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

    // Migrate files table to include relative_path column
    const hasRelativePathColumn = this.db.prepare(`
      SELECT COUNT(*) as count FROM pragma_table_info('files') WHERE name = 'relative_path'
    `).get().count > 0;
    if (!hasRelativePathColumn) {
      this.db.exec(`ALTER TABLE files ADD COLUMN relative_path TEXT`);
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

    // Query analytics table for tracking slow queries
    const hasQueryAnalyticsTable = this.db.prepare(`
      SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='query_analytics'
    `).get().count > 0;

    if (!hasQueryAnalyticsTable) {
      this.db.exec(`
        CREATE TABLE query_analytics (
          id INTEGER PRIMARY KEY,
          timestamp TEXT NOT NULL,
          method TEXT NOT NULL,
          args TEXT,
          duration_ms REAL NOT NULL,
          result_count INTEGER,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX idx_query_analytics_method ON query_analytics(method);
        CREATE INDEX idx_query_analytics_duration ON query_analytics(duration_ms DESC);
        CREATE INDEX idx_query_analytics_timestamp ON query_analytics(timestamp);
      `);
    }

    // Name trigrams table for fast fuzzy type/member search
    const hasNameTrigramsTable = this.db.prepare(`
      SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='name_trigrams'
    `).get().count > 0;

    if (!hasNameTrigramsTable) {
      this.db.exec(`
        CREATE TABLE name_trigrams (
          trigram INTEGER NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id INTEGER NOT NULL,
          PRIMARY KEY (trigram, entity_type, entity_id)
        ) WITHOUT ROWID;
        CREATE INDEX idx_name_trigrams_entity ON name_trigrams(entity_type, entity_id);
      `);
      // Flag that name trigram index needs building from existing types/members
      this.setMetadata('nameTrigramBuildNeeded', true);
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
    let sql = "SELECT * FROM files WHERE language NOT IN ('content', 'asset')";
    const params = [];
    if (project) { sql += ' AND project = ?'; params.push(project); }
    if (language && language !== 'all') { sql += ' AND language = ?'; params.push(language); }
    return this.db.prepare(sql).all(...params);
  }

  getFilesMtime(filePaths) {
    if (!filePaths || filePaths.length === 0) return new Map();
    // Batch query — SQLite max variable limit is 999, chunk if needed
    const result = new Map();
    const chunkSize = 900;
    for (let i = 0; i < filePaths.length; i += chunkSize) {
      const chunk = filePaths.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT path, mtime FROM files WHERE path IN (${placeholders})`
      ).all(...chunk);
      for (const row of rows) {
        result.set(row.path, row.mtime);
      }
    }
    return result;
  }

  upsertFile(path, project, module, mtime, language = 'angelscript', relativePath = null) {
    const stmt = this.db.prepare(`
      INSERT INTO files (path, project, module, mtime, language, relative_path)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        project = excluded.project,
        module = excluded.module,
        mtime = excluded.mtime,
        language = excluded.language,
        relative_path = COALESCE(excluded.relative_path, relative_path)
      RETURNING id
    `);
    return stmt.get(path, project, module, mtime, language, relativePath).id;
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
    const typeStmt = this.db.prepare(`
      INSERT INTO types (file_id, name, kind, parent, line)
      VALUES (?, ?, ?, ?, ?)
    `);
    const trigramStmt = this.db.prepare(`
      INSERT OR IGNORE INTO name_trigrams (trigram, entity_type, entity_id)
      VALUES (?, 'type', ?)
    `);

    const insertMany = this.db.transaction((items) => {
      for (const item of items) {
        const result = typeStmt.run(fileId, item.name, item.kind, item.parent || null, item.line);
        const typeId = result.lastInsertRowid;

        // Insert name trigrams for fast fuzzy search
        const trigrams = extractTrigrams(item.name);
        for (const tri of trigrams) {
          trigramStmt.run(tri, typeId);
        }
      }
    });

    insertMany(types);
  }

  clearTypesForFile(fileId) {
    // Get type IDs before deletion for trigram cleanup
    const typeIds = this.db.prepare('SELECT id FROM types WHERE file_id = ?').all(fileId).map(r => r.id);
    const memberIds = this.db.prepare('SELECT id FROM members WHERE file_id = ?').all(fileId).map(r => r.id);

    // Delete name trigrams
    if (typeIds.length > 0) {
      const placeholders = typeIds.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM name_trigrams WHERE entity_type = 'type' AND entity_id IN (${placeholders})`).run(...typeIds);
    }
    if (memberIds.length > 0) {
      const placeholders = memberIds.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM name_trigrams WHERE entity_type = 'member' AND entity_id IN (${placeholders})`).run(...memberIds);
    }

    this.db.prepare('DELETE FROM members WHERE file_id = ?').run(fileId);
    this.db.prepare('DELETE FROM types WHERE file_id = ?').run(fileId);
  }

  insertMembers(fileId, members) {
    const memberStmt = this.db.prepare(`
      INSERT INTO members (type_id, file_id, name, member_kind, line, is_static, specifiers)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const trigramStmt = this.db.prepare(`
      INSERT OR IGNORE INTO name_trigrams (trigram, entity_type, entity_id)
      VALUES (?, 'member', ?)
    `);

    const insertMany = this.db.transaction((items) => {
      for (const item of items) {
        const result = memberStmt.run(
          item.typeId || null,
          fileId,
          item.name,
          item.memberKind,
          item.line,
          item.isStatic ? 1 : 0,
          item.specifiers || null
        );
        const memberId = result.lastInsertRowid;

        // Insert name trigrams for fast fuzzy search
        const trigrams = extractTrigrams(item.name);
        for (const tri of trigrams) {
          trigramStmt.run(tri, memberId);
        }
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
        SELECT m.id, m.name, m.member_kind, m.line, m.specifiers, t.name as type_name, t.kind as type_kind, f.path, f.project
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

      return this.db.prepare(sql).all(...params).map(({ id, ...rest }) => rest);
    }

    const nameLower = name.toLowerCase();
    const candidates = [];

    // Step 1: prefix match (fast, uses index)
    let sql = `
      SELECT m.id, m.name, m.member_kind, m.line, m.specifiers, t.name as type_name, t.kind as type_kind, f.path, f.project
      FROM members m
      LEFT JOIN types t ON m.type_id = t.id
      JOIN files f ON m.file_id = f.id
      WHERE lower(m.name) LIKE ?
    `;
    const params = [`${nameLower}%`];

    if (containingType) { sql += ' AND t.name = ?'; params.push(containingType); }
    if (memberKind) { sql += ' AND m.member_kind = ?'; params.push(memberKind); }
    if (project) { sql += ' AND f.project = ?'; params.push(project); }
    if (language && language !== 'all') { sql += ' AND f.language = ?'; params.push(language); }
    sql += ' LIMIT ?';
    params.push(maxResults * 3);
    candidates.push(...this.db.prepare(sql).all(...params));

    // Step 2: trigram search for substring/reordered matches
    if (candidates.length < maxResults && nameLower.length >= 3) {
      const trigrams = [...extractTrigrams(nameLower)];
      if (trigrams.length >= 3) {
        const placeholders = trigrams.map(() => '?').join(',');
        const minMatch = Math.max(3, Math.ceil(trigrams.length * 0.75));
        const trigramSql = `
          SELECT nt.entity_id
          FROM name_trigrams nt
          WHERE nt.entity_type = 'member' AND nt.trigram IN (${placeholders})
          GROUP BY nt.entity_id
          HAVING COUNT(DISTINCT nt.trigram) >= ?
        `;
        const candidateIds = this.db.prepare(trigramSql).all(...trigrams, minMatch).map(r => r.entity_id);

        if (candidateIds.length > 0 && candidateIds.length < 1000) {
          const existingIds = new Set(candidates.map(c => c.id));
          const newIds = candidateIds.filter(id => !existingIds.has(id));

          if (newIds.length > 0) {
            const idPlaceholders = newIds.map(() => '?').join(',');
            let trigramMemberSql = `
              SELECT m.id, m.name, m.member_kind, m.line, m.specifiers, t.name as type_name, t.kind as type_kind, f.path, f.project
              FROM members m
              LEFT JOIN types t ON m.type_id = t.id
              JOIN files f ON m.file_id = f.id
              WHERE m.id IN (${idPlaceholders})
            `;
            const trigramParams = [...newIds];
            if (containingType) { trigramMemberSql += ' AND t.name = ?'; trigramParams.push(containingType); }
            if (memberKind) { trigramMemberSql += ' AND m.member_kind = ?'; trigramParams.push(memberKind); }
            if (project) { trigramMemberSql += ' AND f.project = ?'; trigramParams.push(project); }
            if (language && language !== 'all') { trigramMemberSql += ' AND f.language = ?'; trigramParams.push(language); }
            trigramMemberSql += ' LIMIT ?';
            trigramParams.push(maxResults * 2);
            candidates.push(...this.db.prepare(trigramMemberSql).all(...trigramParams));
          }
        }
      }
    }

    const searchTrigrams = nameLower.length >= 3 ? new Set(extractTrigrams(nameLower)) : null;

    const scored = candidates.map(row => {
      const candidateLower = row.name.toLowerCase();
      let score = 0;

      if (candidateLower === nameLower) score = 1.0;
      else if (candidateLower.startsWith(nameLower)) score = 0.95;
      else if (candidateLower.includes(nameLower)) score = 0.85;
      else if (nameLower.includes(candidateLower)) score = 0.8;
      else if (searchTrigrams) {
        // Trigram similarity: Jaccard coefficient
        const candidateTrigrams = new Set(extractTrigrams(candidateLower));
        let intersection = 0;
        for (const t of searchTrigrams) {
          if (candidateTrigrams.has(t)) intersection++;
        }
        const union = searchTrigrams.size + candidateTrigrams.size - intersection;
        score = union > 0 ? (intersection / union) * 0.7 : 0;
      }

      return { ...row, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const MIN_SCORE = 0.15;
    return scored.filter(r => r.score >= MIN_SCORE).slice(0, maxResults).map(({ id, ...rest }) => rest);
  }

  listModules(parent = '', options = {}) {
    const { project = null, language = null, depth = 1 } = options;

    // Use GROUP BY at SQL level for efficiency (avoids fetching all rows)
    let sql = "SELECT module, COUNT(*) as file_count FROM files WHERE language != 'asset'";
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

    sql += ' GROUP BY module';

    const rows = this.db.prepare(sql).all(...params);

    // Truncate modules to requested depth and aggregate counts
    const moduleCounts = new Map();
    const parentDepth = parent ? parent.split('.').length : 0;
    const targetDepth = parentDepth + depth;

    for (const row of rows) {
      const parts = row.module.split('.');
      if (parts.length <= parentDepth) continue;

      const truncated = parts.slice(0, targetDepth).join('.');
      moduleCounts.set(truncated, (moduleCounts.get(truncated) || 0) + row.file_count);
    }

    return Array.from(moduleCounts.entries())
      .map(([path, fileCount]) => ({ path, fileCount }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  findTypeByName(name, options = {}) {
    const { fuzzy = false, project = null, language = null, kind = null, maxResults = 10, includeAssets } = options;

    const includeSourceTypes = !language || language === 'all' || language === 'angelscript' || language === 'cpp';
    // For fuzzy mode, assets are opt-in (default false) UNLESS language is explicitly "blueprint".
    const assetsDefault = !fuzzy;
    const includeBlueprints = (includeAssets !== undefined ? includeAssets : (language === 'blueprint' || assetsDefault))
      && (!language || language === 'all' || language === 'blueprint');

    if (!fuzzy) {
      let results = [];

      if (includeSourceTypes) {
        let sql = `
          SELECT t.name, t.kind, t.parent, t.line, f.path, f.project
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
          // Batch prefix fallback: try all UE prefix variants in a single query
          // Strategy 1: Add each prefix (EmbarkGameMode → AEmbarkGameMode)
          // Strategy 2: Swap prefix (UMyActor → AMyActor)
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

          if (candidates.size > 0) {
            const placeholders = [...candidates].map(() => '?').join(',');
            let batchSql = `
              SELECT t.name, t.kind, t.parent, t.line, f.path, f.project
              FROM types t
              JOIN files f ON t.file_id = f.id
              WHERE t.name IN (${placeholders})
            `;
            const batchParams = [...candidates];
            if (kind) { batchSql += ' AND t.kind = ?'; batchParams.push(kind); }
            if (project) { batchSql += ' AND f.project = ?'; batchParams.push(project); }
            if (language && language !== 'all' && language !== 'blueprint') {
              batchSql += ' AND f.language = ?'; batchParams.push(language);
            }
            batchSql += ' LIMIT ?';
            batchParams.push(maxResults);
            results = this.db.prepare(batchSql).all(...batchParams);
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
      // Strategy: prefix match first (uses index), then substring match (slower)
      // This avoids full table scans for common cases

      // Step 1: Try prefix match (fast, uses idx_types_name_lower)
      let sql = `
        SELECT t.id, t.name, t.kind, t.parent, t.line, f.path, f.project
        FROM types t
        JOIN files f ON t.file_id = f.id
        WHERE lower(t.name) LIKE ?
      `;
      let params = [`${nameLower}%`];
      if (kind) { sql += ' AND t.kind = ?'; params.push(kind); }
      if (project) { sql += ' AND f.project = ?'; params.push(project); }
      if (language && language !== 'all' && language !== 'blueprint') {
        sql += ' AND f.language = ?'; params.push(language);
      }
      sql += ' LIMIT ?';
      params.push(maxResults * 3);
      candidates.push(...this.db.prepare(sql).all(...params));

      // Step 2: If not enough results and name is long enough for trigrams, use trigram index
      let usedTrigramSearch = false;
      if (candidates.length < maxResults && nameLower.length >= 3) {
        const trigrams = [...extractTrigrams(nameLower)];

        if (trigrams.length >= 3) {
          usedTrigramSearch = true;
          // Use trigram index to find candidates - require 75% match to handle word reordering
          // (e.g., "PushGameState" vs "GameStatePush" shares ~82% of trigrams)
          const placeholders = trigrams.map(() => '?').join(',');
          const minMatch = Math.max(3, Math.ceil(trigrams.length * 0.75));
          const trigramSql = `
            SELECT nt.entity_id
            FROM name_trigrams nt
            WHERE nt.entity_type = 'type' AND nt.trigram IN (${placeholders})
            GROUP BY nt.entity_id
            HAVING COUNT(DISTINCT nt.trigram) >= ?
          `;
          const candidateIds = this.db.prepare(trigramSql).all(...trigrams, minMatch).map(r => r.entity_id);

          if (candidateIds.length > 0 && candidateIds.length < 1000) {
            // Only use trigram results if reasonable number of candidates
            const existingIds = new Set(candidates.map(c => c.id));
            const newIds = candidateIds.filter(id => !existingIds.has(id));

            if (newIds.length > 0) {
              const idPlaceholders = newIds.map(() => '?').join(',');
              let trigramTypeSql = `
                SELECT t.id, t.name, t.kind, t.parent, t.line, f.path, f.project
                FROM types t
                JOIN files f ON t.file_id = f.id
                WHERE t.id IN (${idPlaceholders})
              `;
              const trigramParams = [...newIds];
              if (kind) { trigramTypeSql += ' AND t.kind = ?'; trigramParams.push(kind); }
              if (project) { trigramTypeSql += ' AND f.project = ?'; trigramParams.push(project); }
              if (language && language !== 'all' && language !== 'blueprint') {
                trigramTypeSql += ' AND f.language = ?'; trigramParams.push(language);
              }
              trigramTypeSql += ' LIMIT ?';
              trigramParams.push(maxResults * 2);
              candidates.push(...this.db.prepare(trigramTypeSql).all(...trigramParams));
            }
          }
        }
      }

      // Step 3: Fall back to substring LIKE only if trigram search wasn't used (short search terms)
      // Skip this if trigram search ran - trigrams are complete (if name contains search term, trigrams match)
      if (!usedTrigramSearch && candidates.length < maxResults) {
        const existingIds = new Set(candidates.map(c => c.id));
        const notInClause = existingIds.size > 0 ? [...existingIds].map(() => '?').join(',') : '-1';
        let substringsSql = `
          SELECT t.id, t.name, t.kind, t.parent, t.line, f.path, f.project
          FROM types t
          JOIN files f ON t.file_id = f.id
          WHERE lower(t.name) LIKE ? AND t.id NOT IN (${notInClause})
        `;
        const substringParams = [`%${nameLower}%`, ...(existingIds.size > 0 ? [...existingIds] : [])];
        if (kind) { substringsSql += ' AND t.kind = ?'; substringParams.push(kind); }
        if (project) { substringsSql += ' AND f.project = ?'; substringParams.push(project); }
        if (language && language !== 'all' && language !== 'blueprint') {
          substringsSql += ' AND f.language = ?'; substringParams.push(language);
        }
        substringsSql += ' LIMIT ?';
        substringParams.push(maxResults * 2);
        candidates.push(...this.db.prepare(substringsSql).all(...substringParams));
      }

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

    // Split search term into camelCase words for word-level matching
    const searchWords = name.replace(/^[UAFESI](?=[A-Z])/, '').split(/(?=[A-Z])/).map(w => w.toLowerCase()).filter(w => w.length > 0);

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
      else if (searchWords.length >= 2) {
        // Word-level match: check how many search words appear in the candidate
        const matchedWords = searchWords.filter(w => candidateLower.includes(w));
        const wordRatio = matchedWords.length / searchWords.length;
        if (wordRatio === 1) score = 0.7;       // all words match (different order)
        else if (wordRatio >= 0.66) score = 0.5; // most words match
        else score = 0.3;                         // few words match (likely false positive)
      } else {
        score = 0.3; // trigram match but no substring/word match
      }

      return { ...row, score };
    });

    // Filter out low-quality trigram matches
    const filtered = scored.filter(r => r.score >= 0.4);
    filtered.sort((a, b) => b.score - a.score);
    return dedupTypes(filtered).slice(0, maxResults).map(({ id, file_id, ...rest }) => rest);
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
          SELECT t.name, t.kind, t.parent, t.line, f.path, f.project
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

      if (includeBlueprints) {
        // Build asset lookup names: both prefixed ("AActor") and stripped ("Actor")
        // because uasset parser stores parent_class without UE type prefix
        const assetNames = [parentClass];
        const stripped = parentClass.replace(/^[AUFESI](?=[A-Z])/, '');
        if (stripped !== parentClass) assetNames.push(stripped);
        const assetPlaceholders = assetNames.map(() => '?').join(',');

        let assetSql = `
          SELECT name, content_path as path, project, parent_class as parent, asset_class,
                 'blueprint' as language, 'class' as kind, folder as module, 0 as line
          FROM assets
          WHERE parent_class IN (${assetPlaceholders}) AND asset_class IS NOT NULL
        `;
        const assetParams = [...assetNames];
        if (project) { assetSql += ' AND project = ?'; assetParams.push(project); }
        assetSql += ' LIMIT ?';
        assetParams.push(maxResults);
        results.push(...this.db.prepare(assetSql).all(...assetParams));
      }

      if (results.length > maxResults) results.length = maxResults;
      return { results, truncated: results.length >= maxResults, totalChildren: results.length, parentFound };
    }

    // Phase 1: Traverse full inheritance tree WITHOUT project/language filter
    // so cross-project inheritance chains are followed completely
    // Uses level-at-a-time BFS: query all parents in current frontier with WHERE IN (...)
    const children = new Set();
    let frontier = [parentClass];

    while (frontier.length > 0) {
      const placeholders = frontier.map(() => '?').join(',');

      const directChildren = this.db.prepare(`
        SELECT t.name FROM types t
        WHERE t.parent IN (${placeholders}) AND t.kind IN ('class', 'struct', 'interface')
      `).all(...frontier);

      // Build asset lookup names: both prefixed and stripped variants
      // because uasset parser stores parent_class without UE type prefix (e.g., "Actor" not "AActor")
      const assetNames = [];
      for (const name of frontier) {
        assetNames.push(name);
        const stripped = name.replace(/^[AUFESI](?=[A-Z])/, '');
        if (stripped !== name) assetNames.push(stripped);
      }
      const assetPlaceholders = assetNames.map(() => '?').join(',');

      const assetChildren = this.db.prepare(`
        SELECT name FROM assets WHERE parent_class IN (${assetPlaceholders}) AND asset_class IS NOT NULL
      `).all(...assetNames);

      const nextFrontier = [];
      for (const child of directChildren) {
        if (!children.has(child.name)) {
          children.add(child.name);
          nextFrontier.push(child.name);
        }
      }
      for (const child of assetChildren) {
        if (!children.has(child.name)) {
          children.add(child.name);
          nextFrontier.push(child.name);
        }
      }
      frontier = nextFrontier;
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
        SELECT t.name, t.kind, t.parent, t.line, f.path, f.project
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

    if (includeBlueprints) {
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
      assetParams.push(maxResults);
      results.push(...this.db.prepare(assetSql).all(...assetParams));
    }

    if (results.length > maxResults) results.length = maxResults;
    const truncated = results.length >= maxResults;

    return { results, truncated, totalChildren: results.length, parentFound };
  }

  browseModule(modulePath, options = {}) {
    const { project = null, language = null, maxResults = 100 } = options;

    let sql = `
      SELECT t.name, t.kind, t.parent, t.line, f.path, f.project, f.module
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

    // If no types found (e.g., config files have no types), list files directly
    if (results.length === 0) {
      let filesSql = "SELECT path, project, language FROM files WHERE (module = ? OR module LIKE ?) AND language != 'asset'";
      const filesParams = [modulePath, `${modulePath}.%`];
      if (project) { filesSql += ' AND project = ?'; filesParams.push(project); }
      if (language && language !== 'all') { filesSql += ' AND language = ?'; filesParams.push(language); }
      filesSql += ' LIMIT ?';
      filesParams.push(maxResults + 1);
      const fileResults = this.db.prepare(filesSql).all(...filesParams);
      return {
        module: modulePath,
        types: [],
        files: fileResults.slice(0, maxResults).map(f => f.path),
        truncated: fileResults.length > maxResults,
        totalFiles: fileResults.length
      };
    }

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
      SELECT f.id, f.path, f.project, f.language,
        CASE
          WHEN lower(f.path) LIKE ? THEN 1.0
          WHEN lower(f.path) LIKE ? THEN 0.85
          WHEN lower(f.path) LIKE ? THEN 0.7
          ELSE 0.5
        END + (CASE WHEN lower(f.path) LIKE '%.h' THEN 0.01 ELSE 0 END) as score
      FROM files f
      WHERE f.language != 'asset' AND (
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

    if (files.length === 0) {
      return [];
    }

    // Batch query for all types (avoids N+1 queries)
    const fileIds = files.map(f => f.id);
    const placeholders = fileIds.map(() => '?').join(',');
    const allTypes = this.db.prepare(`
      SELECT file_id, name, kind, line FROM types WHERE file_id IN (${placeholders})
    `).all(...fileIds);

    // Group types by file_id
    const typesByFile = new Map();
    for (const t of allTypes) {
      if (!typesByFile.has(t.file_id)) {
        typesByFile.set(t.file_id, []);
      }
      const arr = typesByFile.get(t.file_id);
      if (arr.length < 10) {  // Limit to 10 types per file
        arr.push({ name: t.name, kind: t.kind, line: t.line });
      }
    }

    return files.map(f => ({
      file: f.path,
      project: f.project,
      language: f.language,
      score: f.score,
      types: typesByFile.get(f.id) || []
    }));
  }

  getStats() {
    const totalFiles = this.db.prepare("SELECT COUNT(*) as count FROM files WHERE language != 'asset'").get().count;
    const totalTypes = this.db.prepare('SELECT COUNT(*) as count FROM types').get().count;
    const totalMembers = this.db.prepare('SELECT COUNT(*) as count FROM members').get().count;

    const kindCounts = this.db.prepare(`
      SELECT kind, COUNT(*) as count FROM types GROUP BY kind
    `).all();

    const memberKindCounts = this.db.prepare(`
      SELECT member_kind, COUNT(*) as count FROM members GROUP BY member_kind
    `).all();

    // File counts per project/language (no JOIN needed, exclude synthetic asset entries)
    const fileCounts = this.db.prepare(`
      SELECT project, language, COUNT(*) as files FROM files WHERE language != 'asset' GROUP BY project, language
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
    const asset = this.db.prepare('SELECT content_path FROM assets WHERE path = ?').get(path);
    const deleted = this.db.prepare('DELETE FROM assets WHERE path = ?').run(path).changes > 0;
    if (deleted && asset) {
      this.deleteAssetContent(asset.content_path);
    }
    return deleted;
  }

  /**
   * Create synthetic files + file_content + trigrams entries for assets,
   * so grep can find them via the trigram index.
   */
  indexAssetContent(assets) {
    const upsertFile = this.db.prepare(`
      INSERT INTO files (path, project, module, language, mtime)
      VALUES (?, ?, ?, 'asset', ?)
      ON CONFLICT(path) DO UPDATE SET project=excluded.project, module=excluded.module, mtime=excluded.mtime
    `);
    const getFileId = this.db.prepare('SELECT id FROM files WHERE path = ?');

    const insertBatch = this.db.transaction((batch) => {
      for (const asset of batch) {
        const content = [asset.name, asset.contentPath, asset.assetClass || '', asset.parentClass || ''].join('\n');
        const compressed = deflateSync(Buffer.from(content));
        const hash = contentHash(content);

        upsertFile.run(asset.contentPath, asset.project, asset.folder, asset.mtime);
        const row = getFileId.get(asset.contentPath);
        if (!row) continue;

        this.upsertFileContent(row.id, compressed, hash);
      }
    });

    insertBatch(assets);
  }

  deleteAssetContent(contentPath) {
    this.db.prepare("DELETE FROM files WHERE path = ? AND language = 'asset'").run(contentPath);
  }

  clearAssets(project) {
    // Also clear synthetic file entries for assets (CASCADE cleans file_content + trigrams)
    if (project) {
      this.db.prepare("DELETE FROM files WHERE language = 'asset' AND project = ?").run(project);
      this.db.prepare('DELETE FROM assets WHERE project = ?').run(project);
    } else {
      this.db.prepare("DELETE FROM files WHERE language = 'asset'").run();
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

    const assetCols = 'name, content_path, project, asset_class, parent_class';

    if (!fuzzy) {
      let sql = `SELECT ${assetCols} FROM assets WHERE name = ?`;
      const params = [name];

      if (project) { sql += ' AND project = ?'; params.push(project); }
      if (folder) { sql += ' AND folder LIKE ?'; params.push(folder + '%'); }
      sql += ' LIMIT ?';
      params.push(maxResults);

      let results = this.db.prepare(sql).all(...params);

      if (results.length === 0) {
        // Try case-insensitive exact match
        sql = `SELECT ${assetCols} FROM assets WHERE lower(name) = lower(?)`;
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
      SELECT ${assetCols},
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

    let sql = 'SELECT name, content_path, project, asset_class, parent_class FROM assets WHERE folder = ?';
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

  // --- Name Trigram Index Methods ---

  isNameTrigramIndexReady() {
    return !this.getMetadata('nameTrigramBuildNeeded');
  }

  getNameTrigramStats() {
    // Use cached counts from metadata table to avoid expensive COUNT on WITHOUT ROWID table
    const typeCount = this.getMetadata('nameTrigramTypeCount') || 0;
    const memberCount = this.getMetadata('nameTrigramMemberCount') || 0;
    const totalRows = this.getMetadata('nameTrigramTotalRows') || 0;
    return { typeCount, memberCount, totalRows, ready: this.isNameTrigramIndexReady() };
  }

  buildNameTrigramIndex(progressCallback = null) {
    const BATCH_SIZE = 1000;

    // Build trigrams for types
    const totalTypes = this.db.prepare('SELECT COUNT(*) as count FROM types').get().count;
    let processedTypes = 0;

    const trigramStmt = this.db.prepare(`
      INSERT OR IGNORE INTO name_trigrams (trigram, entity_type, entity_id)
      VALUES (?, ?, ?)
    `);

    // Process types in batches
    let offset = 0;
    while (offset < totalTypes) {
      const types = this.db.prepare(`SELECT id, name FROM types LIMIT ? OFFSET ?`).all(BATCH_SIZE, offset);
      if (types.length === 0) break;

      this.db.transaction(() => {
        for (const type of types) {
          const trigrams = extractTrigrams(type.name);
          for (const tri of trigrams) {
            trigramStmt.run(tri, 'type', type.id);
          }
        }
      })();

      processedTypes += types.length;
      offset += BATCH_SIZE;
      if (progressCallback) progressCallback('type', processedTypes, totalTypes);
    }

    // Build trigrams for members
    const totalMembers = this.db.prepare('SELECT COUNT(*) as count FROM members').get().count;
    let processedMembers = 0;

    offset = 0;
    while (offset < totalMembers) {
      const members = this.db.prepare(`SELECT id, name FROM members LIMIT ? OFFSET ?`).all(BATCH_SIZE, offset);
      if (members.length === 0) break;

      this.db.transaction(() => {
        for (const member of members) {
          const trigrams = extractTrigrams(member.name);
          for (const tri of trigrams) {
            trigramStmt.run(tri, 'member', member.id);
          }
        }
      })();

      processedMembers += members.length;
      offset += BATCH_SIZE;
      if (progressCallback) progressCallback('member', processedMembers, totalMembers);
    }

    // Cache counts in metadata to avoid expensive COUNT queries on WITHOUT ROWID table
    this.setMetadata('nameTrigramTypeCount', processedTypes);
    this.setMetadata('nameTrigramMemberCount', processedMembers);
    const totalRows = this.db.prepare('SELECT COUNT(*) as count FROM name_trigrams').get().count;
    this.setMetadata('nameTrigramTotalRows', totalRows);

    // Mark index as ready
    this.setMetadata('nameTrigramBuildNeeded', false);

    return { types: processedTypes, members: processedMembers };
  }

  getFilesWithoutContent() {
    return this.db.prepare(`
      SELECT f.id, f.path, f.project, f.language
      FROM files f
      LEFT JOIN file_content fc ON f.id = fc.file_id
      WHERE fc.file_id IS NULL AND f.language NOT IN ('content', 'config')
    `).all();
  }

  // --- Query Analytics Methods ---

  _logSlowQuery(method, args, durationMs, resultCount = null) {
    try {
      const argsJson = JSON.stringify(args.map(a =>
        typeof a === 'string' ? a :
        Array.isArray(a) ? `[${a.length} items]` :
        typeof a === 'object' ? '{...}' : a
      ));
      this.db.prepare(`
        INSERT INTO query_analytics (timestamp, method, args, duration_ms, result_count)
        VALUES (?, ?, ?, ?, ?)
      `).run(new Date().toISOString(), method, argsJson, durationMs, resultCount);
    } catch (err) {
      // Don't let analytics logging break queries
      console.error('[QueryAnalytics] Error logging slow query:', err.message);
    }
  }

  getQueryAnalytics(options = {}) {
    const { method = null, minDurationMs = null, limit = 100, since = null } = options;

    let sql = 'SELECT * FROM query_analytics WHERE 1=1';
    const params = [];

    if (method) {
      sql += ' AND method = ?';
      params.push(method);
    }
    if (minDurationMs) {
      sql += ' AND duration_ms >= ?';
      params.push(minDurationMs);
    }
    if (since) {
      sql += ' AND timestamp >= ?';
      params.push(since);
    }

    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params);
  }

  getQueryAnalyticsSummary() {
    const byMethod = this.db.prepare(`
      SELECT method, COUNT(*) as count, AVG(duration_ms) as avg_ms, MAX(duration_ms) as max_ms
      FROM query_analytics
      GROUP BY method
      ORDER BY count DESC
    `).all();

    const slowest = this.db.prepare(`
      SELECT method, args, duration_ms, timestamp
      FROM query_analytics
      ORDER BY duration_ms DESC
      LIMIT 10
    `).all();

    const total = this.db.prepare('SELECT COUNT(*) as count FROM query_analytics').get().count;

    return { total, byMethod, slowest };
  }

  cleanupOldAnalytics(daysOld = 7) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);
    const result = this.db.prepare(`
      DELETE FROM query_analytics WHERE timestamp < ?
    `).run(cutoff.toISOString());
    return result.changes;
  }
}

// Wrap key methods with slow-query timing and analytics logging
const methodsToTime = [
  'findTypeByName', 'findChildrenOf', 'findMember', 'findFileByName',
  'findAssetByName', 'getStats', 'getAssetStats', 'upsertAssetBatch',
];
for (const method of methodsToTime) {
  const original = IndexDatabase.prototype[method];
  IndexDatabase.prototype[method] = function (...args) {
    const start = performance.now();
    const result = original.apply(this, args);
    const ms = performance.now() - start;
    if (ms >= SLOW_QUERY_MS) {
      const arg0 = typeof args[0] === 'string' ? `"${args[0]}"` : Array.isArray(args[0]) ? `[${args[0].length} items]` : '';
      console.log(`[${new Date().toISOString()}] [DB] ${method}(${arg0}) — ${ms.toFixed(1)}ms`);

      // Log to analytics table (skip on read-only connections)
      if (!this.readOnly) {
        const resultCount = Array.isArray(result) ? result.length :
          result?.results ? result.results.length : null;
        this._logSlowQuery(method, args, ms, resultCount);
      }
    }
    return result;
  };
}
