#!/usr/bin/env node

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import Database from 'better-sqlite3';
import { IndexDatabase } from './service/database.js';
import { parseUAssetHeader, parseBuffer } from './parsers/uasset-parser.js';

const TEST_DIR = join(tmpdir(), 'unreal-index-blueprint-test');
const TEST_DB = join(TEST_DIR, 'test.db');

function setup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

// ===== .uasset Parser Tests =====

describe('uasset-parser', () => {
  it('returns null for non-uasset files', () => {
    const buf = Buffer.from('not a uasset file');
    const result = parseBuffer(buf);
    assert.equal(result.assetClass, null);
    assert.equal(result.parentClass, null);
  });

  it('returns null for too-small buffer', () => {
    const result = parseBuffer(Buffer.alloc(10));
    assert.equal(result.assetClass, null);
  });

  it('returns null for wrong magic number', () => {
    const buf = Buffer.alloc(64);
    buf.writeUInt32LE(0xDEADBEEF, 0);
    const result = parseBuffer(buf);
    assert.equal(result.assetClass, null);
  });

  it('returns null for unsupported legacy version', () => {
    const buf = Buffer.alloc(64);
    buf.writeUInt32LE(0x9E2A83C1, 0);
    buf.writeInt32LE(-5, 4); // unsupported version
    const result = parseBuffer(buf);
    assert.equal(result.assetClass, null);
  });

  it('parses a real BP_ .uasset file if available', () => {
    const testPath = 'D:/p4/games/Games/Discovery/Content/Developers/joakimolsson/DamageGlitchEffect/BP_DamageGlitchEffect_TestWall.uasset';
    if (!existsSync(testPath)) {
      console.log('  (skipping - test file not available)');
      return;
    }

    const result = parseUAssetHeader(testPath);
    assert.equal(result.assetClass, 'BlueprintGeneratedClass');
    assert.equal(result.parentClass, 'EmbarkActor');
  });

  it('handles graceful failure for missing files', () => {
    const result = parseUAssetHeader('/nonexistent/path/foo.uasset');
    assert.equal(result.assetClass, null);
    assert.equal(result.parentClass, null);
  });
});

// ===== Database Migration Tests =====

describe('database migration - asset_class columns', () => {
  let db;

  before(() => {
    setup();
  });

  after(() => {
    if (db) db.close();
    teardown();
  });

  it('creates assets table with new columns on fresh database', () => {
    db = new IndexDatabase(TEST_DB);
    db.open();

    // Verify columns exist
    const columns = db.db.prepare(`SELECT name FROM pragma_table_info('assets')`).all().map(r => r.name);
    assert.ok(columns.includes('asset_class'), 'asset_class column should exist');
    assert.ok(columns.includes('parent_class'), 'parent_class column should exist');
    db.close();
    db = null;
  });

  it('migrates existing database without new columns', () => {
    // Create a database with the OLD schema (no asset_class/parent_class)
    const oldDbPath = join(TEST_DIR, 'old.db');
    const rawDb = new Database(oldDbPath);
    rawDb.exec(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        module TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'angelscript',
        mtime INTEGER NOT NULL
      );
      CREATE TABLE types (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        parent TEXT,
        line INTEGER NOT NULL
      );
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
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE index_status (
        language TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        progress_current INTEGER DEFAULT 0,
        progress_total INTEGER DEFAULT 0,
        error_message TEXT,
        last_updated TEXT
      );
    `);

    // Insert some old assets without the new columns
    rawDb.prepare(`INSERT INTO assets (path, name, content_path, folder, project, extension, mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('/old/BP_Old.uasset', 'BP_Old', '/Game/BP_Old', '/Game', 'Test', '.uasset', 1000);
    rawDb.prepare(`INSERT INTO index_status (language, status) VALUES ('content', 'ready')`).run();
    rawDb.close();

    // Now open with IndexDatabase - migration should add columns and clear assets
    db = new IndexDatabase(oldDbPath);
    db.open();

    const columns = db.db.prepare(`SELECT name FROM pragma_table_info('assets')`).all().map(r => r.name);
    assert.ok(columns.includes('asset_class'), 'asset_class column should exist after migration');
    assert.ok(columns.includes('parent_class'), 'parent_class column should exist after migration');

    // Assets should be cleared to trigger re-index
    const assetCount = db.db.prepare('SELECT COUNT(*) as count FROM assets').get().count;
    assert.equal(assetCount, 0, 'assets should be cleared after migration');

    // Content index status should be cleared
    const status = db.getIndexStatus('content');
    assert.equal(status.status, 'pending', 'content index status should be reset');

    db.close();
    db = null;
  });
});

// ===== Database Query Tests =====

describe('findChildrenOf with Blueprint assets', () => {
  let db;

  before(() => {
    setup();
    db = new IndexDatabase(join(TEST_DIR, 'query.db'));
    db.open();

    // Insert source code types
    const fileId = db.upsertFile('/test/Actor.h', 'Engine', 'Engine.Core', Date.now(), 'cpp');
    db.insertTypes(fileId, [
      { name: 'Actor', kind: 'class', parent: null, line: 10 },
    ]);
    const fileId2 = db.upsertFile('/test/EmbarkActor.as', 'Discovery', 'Discovery.Core', Date.now(), 'angelscript');
    db.insertTypes(fileId2, [
      { name: 'EmbarkActor', kind: 'class', parent: 'Actor', line: 5 },
    ]);

    // Insert Blueprint assets
    db.upsertAssetBatch([
      { path: '/c/BP_TestActor.uasset', name: 'BP_TestActor', contentPath: '/Game/BP_TestActor', folder: '/Game', project: 'DiscoveryContent', extension: '.uasset', mtime: 1000, assetClass: 'BlueprintGeneratedClass', parentClass: 'EmbarkActor' },
      { path: '/c/BP_ChildActor.uasset', name: 'BP_ChildActor', contentPath: '/Game/BP_ChildActor', folder: '/Game', project: 'DiscoveryContent', extension: '.uasset', mtime: 1000, assetClass: 'BlueprintGeneratedClass', parentClass: 'BP_TestActor' },
      { path: '/c/M_Material.uasset', name: 'M_Material', contentPath: '/Game/M_Material', folder: '/Game', project: 'DiscoveryContent', extension: '.uasset', mtime: 1000, assetClass: 'Material', parentClass: null },
      { path: '/c/WBP_Widget.uasset', name: 'WBP_Widget', contentPath: '/Game/WBP_Widget', folder: '/Game', project: 'DiscoveryContent', extension: '.uasset', mtime: 1000, assetClass: 'WidgetBlueprintGeneratedClass', parentClass: 'UserWidget' },
    ]);
  });

  after(() => {
    if (db) db.close();
    teardown();
  });

  it('finds Blueprint children recursively from a source type', () => {
    const result = db.findChildrenOf('Actor', { recursive: true });
    const names = result.results.map(r => r.name).sort();
    assert.ok(names.includes('EmbarkActor'), 'should find AS child');
    assert.ok(names.includes('BP_TestActor'), 'should find Blueprint child');
    assert.ok(names.includes('BP_ChildActor'), 'should find transitive Blueprint child');
    assert.equal(result.totalChildren, 3);
  });

  it('finds Blueprint-to-Blueprint children', () => {
    const result = db.findChildrenOf('BP_TestActor', { recursive: true });
    const names = result.results.map(r => r.name);
    assert.ok(names.includes('BP_ChildActor'));
    assert.equal(result.totalChildren, 1);
  });

  it('returns Blueprint results with correct shape', () => {
    const result = db.findChildrenOf('EmbarkActor', { recursive: false });
    const bp = result.results.find(r => r.name === 'BP_TestActor');
    assert.ok(bp, 'should find BP_TestActor');
    assert.equal(bp.language, 'blueprint');
    assert.equal(bp.kind, 'class');
    assert.equal(bp.path, '/Game/BP_TestActor');
    assert.equal(bp.parent, 'EmbarkActor');
  });

  it('filters by language=blueprint', () => {
    const result = db.findChildrenOf('Actor', { language: 'blueprint' });
    for (const r of result.results) {
      assert.equal(r.language, 'blueprint', 'all results should be blueprint');
    }
    assert.ok(result.results.length >= 2, 'should have at least 2 Blueprint children');
  });

  it('filters by language=angelscript excludes blueprints', () => {
    const result = db.findChildrenOf('Actor', { language: 'angelscript' });
    const names = result.results.map(r => r.name);
    assert.ok(names.includes('EmbarkActor'));
    assert.ok(!names.includes('BP_TestActor'), 'should not include Blueprint');
  });

  it('does not include non-Blueprint assets', () => {
    const result = db.findChildrenOf('Actor', { recursive: true });
    const names = result.results.map(r => r.name);
    assert.ok(!names.includes('M_Material'), 'should not include Material');
  });
});

describe('findTypeByName with Blueprint assets', () => {
  let db;

  before(() => {
    setup();
    db = new IndexDatabase(join(TEST_DIR, 'type-query.db'));
    db.open();

    const fileId = db.upsertFile('/test/Actor.h', 'Engine', 'Engine.Core', Date.now(), 'cpp');
    db.insertTypes(fileId, [{ name: 'Actor', kind: 'class', parent: null, line: 10 }]);

    db.upsertAssetBatch([
      { path: '/c/BP_TestActor.uasset', name: 'BP_TestActor', contentPath: '/Game/BP_TestActor', folder: '/Game', project: 'DiscoveryContent', extension: '.uasset', mtime: 1000, assetClass: 'BlueprintGeneratedClass', parentClass: 'Actor' },
    ]);
  });

  after(() => {
    if (db) db.close();
    teardown();
  });

  it('finds Blueprint by exact name', () => {
    const results = db.findTypeByName('BP_TestActor');
    assert.ok(results.length > 0, 'should find BP_TestActor');
    assert.equal(results[0].name, 'BP_TestActor');
    assert.equal(results[0].language, 'blueprint');
  });

  it('finds Blueprint by fuzzy search', () => {
    const results = db.findTypeByName('BP_Test', { fuzzy: true });
    assert.ok(results.length > 0);
    assert.equal(results[0].name, 'BP_TestActor');
  });

  it('finds source type alongside Blueprint', () => {
    const results = db.findTypeByName('Actor');
    assert.ok(results.some(r => r.language === 'cpp'), 'should find C++ Actor');
  });

  it('filters Blueprint results with language=blueprint', () => {
    const results = db.findTypeByName('BP_TestActor', { language: 'blueprint' });
    assert.ok(results.length > 0);
    for (const r of results) {
      assert.equal(r.language, 'blueprint');
    }
  });

  it('excludes Blueprint with language=cpp', () => {
    const results = db.findTypeByName('BP_TestActor', { language: 'cpp' });
    assert.equal(results.length, 0, 'should not find Blueprint when filtering to cpp');
  });

  it('finds Blueprint class by _C suffix name', () => {
    const results = db.findTypeByName('BP_TestActor_C');
    assert.ok(results.length > 0, 'should find by _C suffix');
    assert.equal(results[0].name, 'BP_TestActor');
  });
});

describe('getAssetStats with Blueprint info', () => {
  let db;

  before(() => {
    setup();
    db = new IndexDatabase(join(TEST_DIR, 'stats.db'));
    db.open();

    db.upsertAssetBatch([
      { path: '/c/BP_A.uasset', name: 'BP_A', contentPath: '/Game/BP_A', folder: '/Game', project: 'Test', extension: '.uasset', mtime: 1000, assetClass: 'BlueprintGeneratedClass', parentClass: 'Actor' },
      { path: '/c/BP_B.uasset', name: 'BP_B', contentPath: '/Game/BP_B', folder: '/Game', project: 'Test', extension: '.uasset', mtime: 1000, assetClass: 'BlueprintGeneratedClass', parentClass: 'Actor' },
      { path: '/c/M_C.uasset', name: 'M_C', contentPath: '/Game/M_C', folder: '/Game', project: 'Test', extension: '.uasset', mtime: 1000, assetClass: 'Material', parentClass: null },
    ]);
  });

  after(() => {
    if (db) db.close();
    teardown();
  });

  it('reports asset class breakdown', () => {
    const stats = db.getAssetStats();
    assert.equal(stats.total, 3);
    assert.equal(stats.blueprintCount, 2);
    assert.ok(stats.byAssetClass.some(r => r.asset_class === 'BlueprintGeneratedClass' && r.count === 2));
    assert.ok(stats.byAssetClass.some(r => r.asset_class === 'Material' && r.count === 1));
  });
});
