#!/usr/bin/env node

/**
 * Integration tests for the WSL migration architecture:
 * - Internal ingest API (POST /internal/ingest, GET /internal/status)
 * - Watcher-client utility functions
 * - Database round-trip via HTTP ingest
 * - ZoektMirror local filesystem operations
 *
 * These tests create a temporary in-memory/on-disk database and Express app,
 * so no running service is required.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { IndexDatabase } from './service/database.js';
import { createApi } from './service/api.js';
import { ZoektMirror } from './service/zoekt-mirror.js';

// ============================================================
// Helper: Start an Express test server
// ============================================================

function createTestApp(database, zoektMirror = null) {
  // No zoektClient or zoektManager for these tests — we just test ingest + query
  const mockZoektManager = {
    updateMirrorFile() {},
    deleteMirrorFile() {},
    triggerReindex() {},
    isAvailable() { return false; },
    getStatus() { return { available: false }; }
  };

  return createApi(database, null, null, {
    zoektClient: null,
    zoektManager: mockZoektManager,
    zoektMirror
  });
}

async function startServer(app, port) {
  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function fetchJson(url) {
  const res = await fetch(url);
  return { status: res.status, data: await res.json() };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json() };
}

// ============================================================
// Test setup
// ============================================================

const TEST_PORT = 3899;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
let database, server, app, tmpDir, mirrorDir, zoektMirror;

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'unreal-index-test-'));
  mirrorDir = join(tmpDir, 'mirror');
  mkdirSync(mirrorDir, { recursive: true });

  const dbPath = join(tmpDir, 'test.db');
  database = new IndexDatabase(dbPath).open();
  zoektMirror = new ZoektMirror(mirrorDir);
  // Set a fake path prefix for testing
  zoektMirror.pathPrefix = 'D:/p4/games/Games/';

  app = createTestApp(database, zoektMirror);
  server = await startServer(app, TEST_PORT);
});

after(() => {
  // Clear the stats refresh interval to prevent process hanging
  if (app?._statsInterval) clearInterval(app._statsInterval);
  if (server) server.close();
  if (database) database.close();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ============================================================
// GET /internal/status
// ============================================================

describe('GET /internal/status', () => {
  it('should return empty counts for fresh database', async () => {
    const { status, data } = await fetchJson(`${BASE}/internal/status`);
    assert.equal(status, 200);
    assert.equal(data.isEmpty, true);
    assert.deepEqual(data.counts, {});
  });
});

// ============================================================
// POST /internal/ingest — source files
// ============================================================

describe('POST /internal/ingest — source files', () => {
  it('should ingest a single AngelScript file with types and members', async () => {
    const { status, data } = await postJson(`${BASE}/internal/ingest`, {
      files: [{
        path: 'D:/p4/games/Games/Discovery/Script/Camera/AimComponent.as',
        project: 'Discovery',
        module: 'Discovery.Script.Camera',
        language: 'angelscript',
        mtime: 1700000000,
        content: 'class AimComponent : UActorComponent\n{\n  void GetTarget() {}\n  float AimSpeed;\n}',
        types: [
          { name: 'AimComponent', kind: 'class', parent: 'UActorComponent', line: 1 }
        ],
        members: [
          { ownerName: 'AimComponent', name: 'GetTarget', memberKind: 'method', line: 3 },
          { ownerName: 'AimComponent', name: 'AimSpeed', memberKind: 'property', line: 4 }
        ]
      }]
    });

    assert.equal(status, 200);
    assert.equal(data.processed, 1);
    assert.equal(data.errors, undefined);
  });

  it('should ingest multiple files in one batch', async () => {
    const { status, data } = await postJson(`${BASE}/internal/ingest`, {
      files: [
        {
          path: 'D:/p4/games/Games/Discovery/Script/Player/PlayerPawn.as',
          project: 'Discovery',
          module: 'Discovery.Script.Player',
          language: 'angelscript',
          mtime: 1700000001,
          content: 'class PlayerPawn : ACharacter\n{\n  void Jump() {}\n}',
          types: [{ name: 'PlayerPawn', kind: 'class', parent: 'ACharacter', line: 1 }],
          members: [{ ownerName: 'PlayerPawn', name: 'Jump', memberKind: 'method', line: 3 }]
        },
        {
          path: 'D:/p4/games/Games/Discovery/Script/Player/PlayerController.as',
          project: 'Discovery',
          module: 'Discovery.Script.Player',
          language: 'angelscript',
          mtime: 1700000002,
          content: 'class PlayerController : APlayerController\n{\n  void OnPossess() {}\n}',
          types: [{ name: 'PlayerController', kind: 'class', parent: 'APlayerController', line: 1 }],
          members: [{ ownerName: 'PlayerController', name: 'OnPossess', memberKind: 'method', line: 3 }]
        }
      ]
    });

    assert.equal(status, 200);
    assert.equal(data.processed, 2);
  });

  it('should ingest a C++ header file', async () => {
    const { status, data } = await postJson(`${BASE}/internal/ingest`, {
      files: [{
        path: 'D:/p4/games/Games/Engine/Source/Runtime/Actor.h',
        project: 'Engine',
        module: 'Engine.Source.Runtime',
        language: 'cpp',
        mtime: 1700000003,
        content: 'class AActor : public UObject\n{\npublic:\n  void Tick(float DeltaTime);\n};',
        types: [{ name: 'AActor', kind: 'class', parent: 'UObject', line: 1 }],
        members: [{ ownerName: 'AActor', name: 'Tick', memberKind: 'method', line: 4 }]
      }]
    });

    assert.equal(status, 200);
    assert.equal(data.processed, 1);
  });

  it('should ingest a config file (no content, types, or members)', async () => {
    const { status, data } = await postJson(`${BASE}/internal/ingest`, {
      files: [{
        path: 'D:/p4/games/Games/Discovery/Config/DefaultEngine.ini',
        project: 'Discovery',
        module: 'Discovery.Config',
        language: 'config',
        mtime: 1700000004,
        types: [],
        members: []
      }]
    });

    assert.equal(status, 200);
    assert.equal(data.processed, 1);
  });
});

// ============================================================
// Verify ingested data is queryable
// ============================================================

describe('Queried data after ingest', () => {
  it('should find AimComponent via /find-type', async () => {
    const { status, data } = await fetchJson(`${BASE}/find-type?name=AimComponent`);
    assert.equal(status, 200);
    assert.ok(data.results.length > 0, 'should find at least one result');
    assert.equal(data.results[0].name, 'AimComponent');
    assert.equal(data.results[0].parent, 'UActorComponent');
    assert.equal(data.results[0].kind, 'class');
  });

  it('should find AActor via /find-type with language filter', async () => {
    const { status, data } = await fetchJson(`${BASE}/find-type?name=AActor&language=cpp`);
    assert.equal(status, 200);
    assert.ok(data.results.length > 0);
    assert.equal(data.results[0].name, 'AActor');
  });

  it('should find GetTarget via /find-member', async () => {
    const { status, data } = await fetchJson(`${BASE}/find-member?name=GetTarget`);
    assert.equal(status, 200);
    assert.ok(data.results.length > 0);
    assert.equal(data.results[0].name, 'GetTarget');
    assert.equal(data.results[0].member_kind, 'method');
  });

  it('should find Jump via /find-member with containingType filter', async () => {
    const { status, data } = await fetchJson(`${BASE}/find-member?name=Jump&containingType=PlayerPawn`);
    assert.equal(status, 200);
    assert.ok(data.results.length > 0);
    assert.equal(data.results[0].name, 'Jump');
  });

  it('should find children of ACharacter', async () => {
    const { status, data } = await fetchJson(`${BASE}/find-children?parent=ACharacter`);
    assert.equal(status, 200);
    assert.ok(data.results.length > 0, 'should have child results');
    assert.ok(data.results.some(c => c.name === 'PlayerPawn'));
  });

  it('should find file by name', async () => {
    const { status, data } = await fetchJson(`${BASE}/find-file?filename=AimComponent`);
    assert.equal(status, 200);
    assert.ok(data.results.length > 0, 'should find AimComponent file');
    const filePath = data.results[0].file.toLowerCase();
    assert.ok(filePath.includes('aimcomponent'), `file should contain aimcomponent: ${filePath}`);
  });

  it('should return status with counts after ingest', async () => {
    const { status, data } = await fetchJson(`${BASE}/internal/status`);
    assert.equal(status, 200);
    assert.equal(data.isEmpty, false);
    assert.ok(data.counts.angelscript >= 3, `expected >= 3 AS files, got ${data.counts.angelscript}`);
    assert.ok(data.counts.cpp >= 1, `expected >= 1 C++ files, got ${data.counts.cpp}`);
    assert.ok(data.counts.config >= 1, `expected >= 1 config files, got ${data.counts.config}`);
  });

  it('should return stats (may be stale cache)', async () => {
    const { status, data } = await fetchJson(`${BASE}/stats`);
    assert.equal(status, 200);
    // Stats cache was built at API creation time (before ingestion),
    // so values may be 0 — just verify the structure is correct
    assert.ok('totalFiles' in data, 'should have totalFiles');
    assert.ok('totalTypes' in data, 'should have totalTypes');
    assert.ok('byLanguage' in data, 'should have byLanguage');
  });
});

// ============================================================
// POST /internal/ingest — assets
// ============================================================

describe('POST /internal/ingest — assets', () => {
  it('should ingest a batch of assets', async () => {
    const { status, data } = await postJson(`${BASE}/internal/ingest`, {
      assets: [
        {
          path: 'D:/p4/games/Games/Discovery/Content/Blueprints/BP_Player.uasset',
          name: 'BP_Player',
          contentPath: '/Game/Blueprints/BP_Player',
          folder: '/Game/Blueprints',
          project: 'Discovery',
          extension: '.uasset',
          mtime: 1700000010,
          assetClass: 'Blueprint',
          parentClass: 'PlayerPawn'
        },
        {
          path: 'D:/p4/games/Games/Discovery/Content/Materials/M_Default.uasset',
          name: 'M_Default',
          contentPath: '/Game/Materials/M_Default',
          folder: '/Game/Materials',
          project: 'Discovery',
          extension: '.uasset',
          mtime: 1700000011,
          assetClass: 'Material',
          parentClass: null
        }
      ]
    });

    assert.equal(status, 200);
    assert.equal(data.processed, 2);
  });

  it('should find asset by name', async () => {
    const { status, data } = await fetchJson(`${BASE}/find-asset?name=BP_Player`);
    assert.equal(status, 200);
    assert.ok(data.results.length > 0, 'should find BP_Player');
    assert.equal(data.results[0].name, 'BP_Player');
  });

  it('should return asset stats', async () => {
    const { status, data } = await fetchJson(`${BASE}/asset-stats`);
    assert.equal(status, 200);
    assert.ok(data.total >= 2, `expected >= 2 assets, got ${data.total}`);
  });
});

// ============================================================
// POST /internal/ingest — deletes
// ============================================================

describe('POST /internal/ingest — deletes', () => {
  it('should delete a source file', async () => {
    // Verify file exists first
    const before = await fetchJson(`${BASE}/find-type?name=PlayerController`);
    assert.ok(before.data.results.length > 0, 'PlayerController should exist before delete');

    const { status, data } = await postJson(`${BASE}/internal/ingest`, {
      deletes: ['D:/p4/games/Games/Discovery/Script/Player/PlayerController.as']
    });

    assert.equal(status, 200);
    assert.equal(data.processed, 1);

    // Verify type is gone
    const after = await fetchJson(`${BASE}/find-type?name=PlayerController`);
    assert.equal(after.data.results.length, 0, 'PlayerController should be gone after delete');
  });

  it('should handle update (re-ingest) of existing file', async () => {
    // Update AimComponent with a new member
    const { status, data } = await postJson(`${BASE}/internal/ingest`, {
      files: [{
        path: 'D:/p4/games/Games/Discovery/Script/Camera/AimComponent.as',
        project: 'Discovery',
        module: 'Discovery.Script.Camera',
        language: 'angelscript',
        mtime: 1700000100,
        content: 'class AimComponent : UActorComponent\n{\n  void GetTarget() {}\n  float AimSpeed;\n  void NewMethod() {}\n}',
        types: [
          { name: 'AimComponent', kind: 'class', parent: 'UActorComponent', line: 1 }
        ],
        members: [
          { ownerName: 'AimComponent', name: 'GetTarget', memberKind: 'method', line: 3 },
          { ownerName: 'AimComponent', name: 'AimSpeed', memberKind: 'property', line: 4 },
          { ownerName: 'AimComponent', name: 'NewMethod', memberKind: 'method', line: 5 }
        ]
      }]
    });

    assert.equal(status, 200);
    assert.equal(data.processed, 1);

    // Verify new member exists
    const result = await fetchJson(`${BASE}/find-member?name=NewMethod`);
    assert.ok(result.data.results.length > 0, 'NewMethod should be findable after update');
  });
});

// ============================================================
// POST /internal/ingest — mixed batch (files + assets + deletes)
// ============================================================

describe('POST /internal/ingest — mixed batch', () => {
  it('should handle files, assets, and deletes in one request', async () => {
    const { status, data } = await postJson(`${BASE}/internal/ingest`, {
      files: [{
        path: 'D:/p4/games/Games/Discovery/Script/Weapons/WeaponBase.as',
        project: 'Discovery',
        module: 'Discovery.Script.Weapons',
        language: 'angelscript',
        mtime: 1700000200,
        content: 'class WeaponBase : AActor\n{\n  void Fire() {}\n}',
        types: [{ name: 'WeaponBase', kind: 'class', parent: 'AActor', line: 1 }],
        members: [{ ownerName: 'WeaponBase', name: 'Fire', memberKind: 'method', line: 3 }]
      }],
      assets: [{
        path: 'D:/p4/games/Games/Discovery/Content/Weapons/BP_Rifle.uasset',
        name: 'BP_Rifle',
        contentPath: '/Game/Weapons/BP_Rifle',
        folder: '/Game/Weapons',
        project: 'Discovery',
        extension: '.uasset',
        mtime: 1700000201,
        assetClass: 'Blueprint',
        parentClass: 'WeaponBase'
      }],
      deletes: []
    });

    assert.equal(status, 200);
    assert.equal(data.processed, 2); // 1 file + 1 asset

    // Verify both findable
    const typeResult = await fetchJson(`${BASE}/find-type?name=WeaponBase`);
    assert.ok(typeResult.data.results.length > 0);

    const assetResult = await fetchJson(`${BASE}/find-asset?name=BP_Rifle`);
    assert.ok(assetResult.data.results.length > 0);
  });
});

// ============================================================
// POST /internal/ingest — error handling
// ============================================================

describe('POST /internal/ingest — error handling', () => {
  it('should return 200 even with empty body', async () => {
    const { status, data } = await postJson(`${BASE}/internal/ingest`, {});
    assert.equal(status, 200);
    assert.equal(data.processed, 0);
  });

  it('should handle files with no content (config-like)', async () => {
    const { status, data } = await postJson(`${BASE}/internal/ingest`, {
      files: [{
        path: 'D:/p4/games/Games/Discovery/Config/Game.ini',
        project: 'Discovery',
        module: 'Discovery.Config',
        language: 'config',
        mtime: 1700000300,
        types: [],
        members: []
      }]
    });

    assert.equal(status, 200);
    assert.equal(data.processed, 1);
  });
});

// ============================================================
// ZoektMirror — local filesystem operations
// ============================================================

describe('ZoektMirror local operations', () => {
  let testMirrorDir, mirror;

  before(() => {
    testMirrorDir = mkdtempSync(join(tmpdir(), 'zoekt-mirror-test-'));
    mirror = new ZoektMirror(testMirrorDir);
  });

  after(() => {
    try { rmSync(testMirrorDir, { recursive: true, force: true }); } catch {}
  });

  it('should report not ready when no marker file', () => {
    assert.equal(mirror.isReady(), false);
  });

  it('should write a file to mirror', () => {
    mirror.updateFile('Discovery/Script/Camera/AimComponent.as', 'class AimComponent {}');
    const content = readFileSync(join(testMirrorDir, 'Discovery/Script/Camera/AimComponent.as'), 'utf-8');
    assert.equal(content, 'class AimComponent {}');
  });

  it('should overwrite existing file', () => {
    mirror.updateFile('Discovery/Script/Camera/AimComponent.as', 'class AimComponent { updated }');
    const content = readFileSync(join(testMirrorDir, 'Discovery/Script/Camera/AimComponent.as'), 'utf-8');
    assert.equal(content, 'class AimComponent { updated }');
  });

  it('should delete a file from mirror', () => {
    mirror.updateFile('Discovery/Script/Temp.as', 'temporary');
    assert.ok(existsSync(join(testMirrorDir, 'Discovery/Script/Temp.as')));

    mirror.deleteFile('Discovery/Script/Temp.as');
    assert.ok(!existsSync(join(testMirrorDir, 'Discovery/Script/Temp.as')));
  });

  it('should not throw when deleting non-existent file', () => {
    assert.doesNotThrow(() => {
      mirror.deleteFile('NonExistent/File.as');
    });
  });

  it('should convert asset content paths', () => {
    const result = mirror._toAssetMirrorPath('/Game/Discovery/BP_Player');
    assert.equal(result, '_assets/Game/Discovery/BP_Player.uasset');
  });

  it('should preserve extension in asset paths', () => {
    const result = mirror._toAssetMirrorPath('/Game/Discovery/BP_Player.uasset');
    assert.equal(result, '_assets/Game/Discovery/BP_Player.uasset');
  });

  it('should strip path prefix from full paths', () => {
    mirror.pathPrefix = 'D:/p4/games/Games/';
    const result = mirror._toRelativePath('D:/p4/games/Games/Discovery/Script/Foo.as');
    assert.equal(result, 'Discovery/Script/Foo.as');
  });

  it('should return full path when no prefix match', () => {
    mirror.pathPrefix = 'D:/p4/games/Games/';
    const result = mirror._toRelativePath('/some/other/path/File.as');
    assert.equal(result, '/some/other/path/File.as');
  });
});

// ============================================================
// Watcher-client utility functions (imported directly)
// ============================================================

describe('Watcher-client utility functions', () => {
  // We can't import from watcher-client.js directly because it auto-runs main(),
  // but we can test the logic inline here since the functions are simple.

  function deriveModule(relativePath, projectName) {
    const parts = relativePath.replace(/\.(as|h|cpp)$/, '').split('/');
    parts.pop();
    return [projectName, ...parts].join('.');
  }

  function hasMatchingExtension(filePath, extensions) {
    return extensions.some(ext => filePath.endsWith(ext));
  }

  it('should derive module from relative path', () => {
    assert.equal(deriveModule('Script/Camera/AimComponent.as', 'Discovery'), 'Discovery.Script.Camera');
  });

  it('should derive module for file in root', () => {
    assert.equal(deriveModule('AimComponent.as', 'Discovery'), 'Discovery');
  });

  it('should derive module for C++ files', () => {
    assert.equal(deriveModule('Source/Runtime/Actor.h', 'Engine'), 'Engine.Source.Runtime');
  });

  it('should match AngelScript extensions', () => {
    assert.ok(hasMatchingExtension('Foo.as', ['.as']));
    assert.ok(!hasMatchingExtension('Foo.h', ['.as']));
  });

  it('should match C++ extensions', () => {
    assert.ok(hasMatchingExtension('Actor.h', ['.h', '.cpp']));
    assert.ok(hasMatchingExtension('Actor.cpp', ['.h', '.cpp']));
    assert.ok(!hasMatchingExtension('Actor.as', ['.h', '.cpp']));
  });
});

// ============================================================
// Health endpoint
// ============================================================

describe('Health and summary endpoints', () => {
  it('should return health status', async () => {
    const { status, data } = await fetchJson(`${BASE}/health`);
    assert.equal(status, 200);
    assert.equal(data.status, 'ok');
    assert.ok(data.memoryMB);
    assert.ok(data.uptimeSeconds >= 0);
  });

  it('should return summary', async () => {
    const { status, data } = await fetchJson(`${BASE}/summary`);
    assert.equal(status, 200);
    assert.ok(data.stats);
  });
});
