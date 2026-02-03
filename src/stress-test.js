#!/usr/bin/env node

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'fs';
import { IndexDatabase } from './service/database.js';
import { parseCppContent } from './parsers/cpp-parser.js';
import { parseContent as parseAngelscriptContent } from './parsers/angelscript-parser.js';

const TEST_DIR = join(tmpdir(), 'unreal-index-stress-test');
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

describe('C++ Parser', () => {
  it('should parse UCLASS with parent', () => {
    const result = parseCppContent(`
UCLASS(BlueprintType, Blueprintable)
class ENGINE_API AActor : public UObject
{
  GENERATED_BODY()
};
`);
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0].name, 'AActor');
    assert.equal(result.classes[0].parent, 'UObject');
    assert.equal(result.classes[0].reflected, true);
    assert.deepEqual(result.classes[0].specifiers, ['BlueprintType', 'Blueprintable']);
  });

  it('should skip forward declarations', () => {
    const result = parseCppContent(`
class AActor;
class UObject;
struct FVector;
enum class EResult : uint8;
`);
    assert.equal(result.classes.length, 0);
    assert.equal(result.structs.length, 0);
    assert.equal(result.enums.length, 0);
  });

  it('should parse real definitions after forward declarations', () => {
    const result = parseCppContent(`
class AActor;
struct FVector;
enum class EResult : uint8;

UCLASS()
class AActor : public UObject
{
};

USTRUCT()
struct FVector
{
};

UENUM()
enum class EResult
{
};
`);
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0].name, 'AActor');
    assert.equal(result.classes[0].parent, 'UObject');
    assert.equal(result.structs.length, 1);
    assert.equal(result.structs[0].name, 'FVector');
    assert.equal(result.enums.length, 1);
    assert.equal(result.enums[0].name, 'EResult');
  });

  it('should parse non-reflected classes with U/A/F/I prefix', () => {
    const result = parseCppContent(`
class UMyComponent : public UActorComponent
{
};

class AMyActor : public AActor
{
};

class FMyHelper
{
};

class IMyInterface
{
};

class SomeOtherClass
{
};
`);
    assert.equal(result.classes.length, 4);
    assert.equal(result.classes[0].name, 'UMyComponent');
    assert.equal(result.classes[1].name, 'AMyActor');
    assert.equal(result.classes[2].name, 'FMyHelper');
    assert.equal(result.classes[3].name, 'IMyInterface');
  });

  it('should parse non-reflected F-structs', () => {
    const result = parseCppContent(`
struct FHitResult
{
  float Distance;
};

struct NotCaptured
{
};
`);
    assert.equal(result.structs.length, 1);
    assert.equal(result.structs[0].name, 'FHitResult');
    assert.equal(result.structs[0].reflected, false);
  });

  it('should parse non-reflected E-enums', () => {
    const result = parseCppContent(`
enum class ECollisionChannel
{
  Default,
  Static
};

enum NotCaptured
{
  A, B
};
`);
    assert.equal(result.enums.length, 1);
    assert.equal(result.enums[0].name, 'ECollisionChannel');
  });

  it('should handle UCLASS on line before class (gap <= 3)', () => {
    const result = parseCppContent(`
UCLASS(Abstract)

class UBaseComponent : public UActorComponent
{
};
`);
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0].reflected, true);
    assert.deepEqual(result.classes[0].specifiers, ['Abstract']);
  });

  it('should handle class with final keyword', () => {
    const result = parseCppContent(`
UCLASS()
class ENGINE_API UMyWidget final : public UWidget
{
};
`);
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0].name, 'UMyWidget');
    assert.equal(result.classes[0].parent, 'UWidget');
  });

  it('should extract specifiers from USTRUCT and UENUM', () => {
    const result = parseCppContent(`
USTRUCT(BlueprintType)
struct FMyStruct
{
};

UENUM(BlueprintType)
enum class EMyEnum
{
};
`);
    assert.equal(result.structs.length, 1);
    assert.equal(result.structs[0].reflected, true);
    assert.deepEqual(result.structs[0].specifiers, ['BlueprintType']);
    assert.equal(result.enums.length, 1);
    assert.equal(result.enums[0].reflected, true);
    assert.deepEqual(result.enums[0].specifiers, ['BlueprintType']);
  });

  it('should handle mixed forward declarations and definitions in real header', () => {
    const result = parseCppContent(`
#pragma once

#include "CoreMinimal.h"

class AActor;
class UWorld;
class UActorComponent;
struct FHitResult;
enum class ECollisionChannel : uint8;

UCLASS(BlueprintType)
class ENGINE_API UMyComponent : public UActorComponent
{
  GENERATED_BODY()

public:
  UPROPERTY()
  AActor* Owner;

  UFUNCTION()
  void DoSomething();
};

USTRUCT()
struct FMyData
{
  GENERATED_BODY()

  UPROPERTY()
  int32 Value;
};
`);
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0].name, 'UMyComponent');
    assert.equal(result.structs.length, 1);
    assert.equal(result.structs[0].name, 'FMyData');
    assert.equal(result.enums.length, 0);
  });
});

describe('AngelScript Parser', () => {
  it('should parse classes with parent', () => {
    const result = parseAngelscriptContent(`
UCLASS()
class UMyWidget : UWidget
{
};
`);
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0].name, 'UMyWidget');
    assert.equal(result.classes[0].parent, 'UWidget');
  });

  it('should parse structs, enums, events, delegates, namespaces', () => {
    const result = parseAngelscriptContent(`
struct FMyData
{
  int Value = 0;
};

enum EMyState
{
  Idle,
  Active
};

event void FOnActivated(AActor Actor);

delegate bool FCanActivate(AActor Actor);

namespace MyNamespace
{
};
`);
    assert.equal(result.structs.length, 1);
    assert.equal(result.structs[0].name, 'FMyData');
    assert.equal(result.enums.length, 1);
    assert.equal(result.enums[0].name, 'EMyState');
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].name, 'FOnActivated');
    assert.equal(result.delegates.length, 1);
    assert.equal(result.delegates[0].name, 'FCanActivate');
    assert.equal(result.namespaces.length, 1);
    assert.equal(result.namespaces[0].name, 'MyNamespace');
  });

  it('should deduplicate namespaces', () => {
    const result = parseAngelscriptContent(`
namespace Tags
{
  const FName SomeTag = n"SomeTag";
};

namespace Tags
{
  const FName OtherTag = n"OtherTag";
};
`);
    assert.equal(result.namespaces.length, 1);
  });
});

describe('Database', () => {
  let db;

  before(() => {
    setup();
    db = new IndexDatabase(TEST_DB).open();
  });

  after(() => {
    db.close();
    teardown();
  });

  it('should insert and query files', () => {
    const fileId = db.upsertFile('/test/Actor.h', 'Engine', 'Engine.Runtime', 1000, 'cpp');
    assert.ok(fileId > 0);

    const file = db.getFileByPath('/test/Actor.h');
    assert.equal(file.project, 'Engine');
    assert.equal(file.language, 'cpp');
  });

  it('should insert and find types', () => {
    const fileId = db.upsertFile('/test/Widget.as', 'Discovery', 'Discovery.UI', 2000, 'angelscript');
    db.insertTypes(fileId, [
      { name: 'UMyWidget', kind: 'class', parent: 'UWidget', line: 10 },
      { name: 'FMyData', kind: 'struct', parent: null, line: 50 },
      { name: 'EMyState', kind: 'enum', parent: null, line: 80 }
    ]);

    const results = db.findTypeByName('UMyWidget');
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'UMyWidget');
    assert.equal(results[0].parent, 'UWidget');
    assert.equal(results[0].kind, 'class');
  });

  it('should find types with prefix fallback', () => {
    const results = db.findTypeByName('MyWidget');
    assert.ok(results.length > 0);
    assert.equal(results[0].name, 'UMyWidget');
  });

  it('should find types with fuzzy search', () => {
    const results = db.findTypeByName('Widget', { fuzzy: true });
    assert.ok(results.length > 0);
    assert.ok(results.some(r => r.name === 'UMyWidget'));
  });

  it('should filter by language', () => {
    const cppResults = db.findTypeByName('UMyWidget', { language: 'cpp' });
    assert.equal(cppResults.length, 0);

    const asResults = db.findTypeByName('UMyWidget', { language: 'angelscript' });
    assert.equal(asResults.length, 1);
  });

  it('should filter by project', () => {
    const results = db.findTypeByName('UMyWidget', { project: 'Engine' });
    assert.equal(results.length, 0);

    const correct = db.findTypeByName('UMyWidget', { project: 'Discovery' });
    assert.equal(correct.length, 1);
  });

  it('should find children', () => {
    const f1 = db.upsertFile('/test/Base.h', 'Engine', 'Engine.Runtime', 3000, 'cpp');
    db.insertTypes(f1, [
      { name: 'UBase', kind: 'class', parent: 'UObject', line: 10 }
    ]);

    const f2 = db.upsertFile('/test/Child.h', 'Engine', 'Engine.Runtime', 3001, 'cpp');
    db.insertTypes(f2, [
      { name: 'UChild', kind: 'class', parent: 'UBase', line: 10 }
    ]);

    const f3 = db.upsertFile('/test/GrandChild.h', 'Engine', 'Engine.Runtime', 3002, 'cpp');
    db.insertTypes(f3, [
      { name: 'UGrandChild', kind: 'class', parent: 'UChild', line: 10 }
    ]);

    const direct = db.findChildrenOf('UBase', { recursive: false });
    assert.equal(direct.results.length, 1);
    assert.equal(direct.results[0].name, 'UChild');

    const recursive = db.findChildrenOf('UBase', { recursive: true });
    assert.equal(recursive.results.length, 2);
    assert.ok(recursive.results.some(r => r.name === 'UChild'));
    assert.ok(recursive.results.some(r => r.name === 'UGrandChild'));
  });

  it('should browse modules', () => {
    const result = db.browseModule('Discovery.UI');
    assert.ok(result.types.length > 0);
    assert.equal(result.module, 'Discovery.UI');
  });

  it('should find files by name', () => {
    const results = db.findFileByName('Widget');
    assert.ok(results.length > 0);
    assert.ok(results.some(r => r.file === '/test/Widget.as'));
  });

  it('should return correct stats', () => {
    const stats = db.getStats();
    assert.ok(stats.totalFiles > 0);
    assert.ok(stats.totalTypes > 0);
    assert.ok(stats.byKind.class > 0);
    assert.ok(stats.byLanguage.cpp);
    assert.ok(stats.byLanguage.angelscript);
    assert.ok(stats.projects.Engine);
    assert.ok(stats.projects.Discovery);
  });

  it('should handle metadata', () => {
    db.setMetadata('testKey', { foo: 'bar', count: 42 });
    const value = db.getMetadata('testKey');
    assert.deepEqual(value, { foo: 'bar', count: 42 });
  });

  it('should handle index status', () => {
    db.setIndexStatus('cpp', 'indexing', 500, 1000);
    const status = db.getIndexStatus('cpp');
    assert.equal(status.status, 'indexing');
    assert.equal(status.progress_current, 500);
    assert.equal(status.progress_total, 1000);
  });

  it('should upsert files without duplicates', () => {
    const id1 = db.upsertFile('/test/Upsert.h', 'Engine', 'Engine.Runtime', 1000, 'cpp');
    const id2 = db.upsertFile('/test/Upsert.h', 'Engine', 'Engine.Runtime', 2000, 'cpp');
    assert.equal(id1, id2);
  });

  it('should delete files and cascade types', () => {
    const fid = db.upsertFile('/test/ToDelete.h', 'Engine', 'Engine.Runtime', 5000, 'cpp');
    db.insertTypes(fid, [
      { name: 'UToDelete', kind: 'class', parent: null, line: 1 }
    ]);

    const before = db.findTypeByName('UToDelete');
    assert.equal(before.length, 1);

    db.deleteFile('/test/ToDelete.h');

    const after = db.findTypeByName('UToDelete');
    assert.equal(after.length, 0);
  });

  it('should clear types for file on re-index', () => {
    const fid = db.upsertFile('/test/Reindex.h', 'Engine', 'Engine.Runtime', 6000, 'cpp');
    db.insertTypes(fid, [
      { name: 'UOldType', kind: 'class', parent: null, line: 1 }
    ]);

    db.clearTypesForFile(fid);
    db.insertTypes(fid, [
      { name: 'UNewType', kind: 'class', parent: null, line: 1 }
    ]);

    const old = db.findTypeByName('UOldType');
    assert.equal(old.length, 0);

    const newer = db.findTypeByName('UNewType');
    assert.equal(newer.length, 1);
  });
});

describe('Database Stress', () => {
  let db;

  before(() => {
    setup();
    db = new IndexDatabase(TEST_DB).open();
  });

  after(() => {
    db.close();
    teardown();
  });

  it('should handle 10,000 files with types', () => {
    const FILE_COUNT = 10000;
    const TYPES_PER_FILE = 3;

    const start = Date.now();

    db.transaction(() => {
      for (let i = 0; i < FILE_COUNT; i++) {
        const fileId = db.upsertFile(
          `/stress/File${i}.h`,
          i % 2 === 0 ? 'Engine' : 'EnginePlugins',
          `Module${i % 50}`,
          Date.now(),
          'cpp'
        );

        const types = [];
        for (let t = 0; t < TYPES_PER_FILE; t++) {
          types.push({
            name: `UType_${i}_${t}`,
            kind: t === 0 ? 'class' : t === 1 ? 'struct' : 'enum',
            parent: t === 0 ? 'UObject' : null,
            line: (t + 1) * 10
          });
        }
        db.insertTypes(fileId, types);
      }
    });

    const insertTime = Date.now() - start;
    console.log(`  Inserted ${FILE_COUNT} files with ${FILE_COUNT * TYPES_PER_FILE} types in ${insertTime}ms`);
    assert.ok(insertTime < 30000, `Insert took ${insertTime}ms, expected < 30s`);

    const queryStart = Date.now();
    const stats = db.getStats();
    const statsTime = Date.now() - queryStart;
    console.log(`  Stats query: ${statsTime}ms`);
    assert.ok(stats.totalFiles >= FILE_COUNT);
    assert.ok(stats.totalTypes >= FILE_COUNT * TYPES_PER_FILE);
    assert.ok(statsTime < 5000, `Stats took ${statsTime}ms, expected < 5s`);

    const findStart = Date.now();
    const found = db.findTypeByName('UType_5000_0');
    const findTime = Date.now() - findStart;
    console.log(`  Exact find: ${findTime}ms`);
    assert.equal(found.length, 1);
    assert.ok(findTime < 100, `Find took ${findTime}ms, expected < 100ms`);

    const fuzzyStart = Date.now();
    const fuzzy = db.findTypeByName('Type_5000', { fuzzy: true, maxResults: 10 });
    const fuzzyTime = Date.now() - fuzzyStart;
    console.log(`  Fuzzy find: ${fuzzyTime}ms`);
    assert.ok(fuzzy.length > 0);
    assert.ok(fuzzyTime < 5000, `Fuzzy took ${fuzzyTime}ms, expected < 5s`);

    const childStart = Date.now();
    const children = db.findChildrenOf('UObject', { recursive: false, maxResults: 100 });
    const childTime = Date.now() - childStart;
    console.log(`  Children query: ${childTime}ms (found ${children.results.length})`);
    assert.ok(children.results.length > 0);
    assert.ok(childTime < 2000, `Children took ${childTime}ms, expected < 2s`);
  });
});

describe('API Integration', async () => {
  const BASE_URL = 'http://127.0.0.1:3847';
  let serviceAvailable = false;

  before(async () => {
    try {
      const resp = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
      serviceAvailable = resp.ok;
    } catch {
      serviceAvailable = false;
    }
    if (!serviceAvailable) {
      console.log('  ⚠ Service not running at port 3847 — skipping API tests. Start with: npm start');
    }
  });

  async function fetchJson(path) {
    const resp = await fetch(`${BASE_URL}${path}`);
    return { status: resp.status, data: await resp.json() };
  }

  function skipIfNoService(t) {
    if (!serviceAvailable) {
      t.skip('Service not running');
    }
  }

  it('should respond to /health', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/health');
    assert.equal(status, 200);
    assert.equal(data.status, 'ok');
  });

  it('should respond to /status', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/status');
    assert.equal(status, 200);
    assert.ok(data.angelscript || data.cpp);
  });

  it('should respond to /stats with valid structure', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/stats');
    assert.equal(status, 200);
    assert.ok(data.totalFiles > 0);
    assert.ok(data.totalTypes > 0);
    assert.ok(data.byKind);
    assert.ok(data.byLanguage);
    assert.ok(data.projects);
  });

  it('should find AActor in C++ index', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/find-type?name=AActor&language=cpp&maxResults=5');
    assert.equal(status, 200);
    assert.ok(data.results.length > 0);
    const withParent = data.results.find(r => r.parent === 'UObject');
    assert.ok(withParent, 'Should find AActor with UObject parent');
  });

  it('should find children of AActor', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/find-children?parent=AActor&language=cpp&maxResults=5');
    assert.equal(status, 200);
    assert.ok(data.results.length > 0);
    assert.ok(data.results.every(r => r.kind === 'class'));
  });

  it('should find AngelScript types', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/find-type?name=UWidget&language=angelscript&fuzzy=true&maxResults=5');
    assert.equal(status, 200);
  });

  it('should browse Engine.Runtime module', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/browse-module?module=Engine.Runtime&language=cpp&maxResults=10');
    assert.equal(status, 200);
    assert.ok(data.types.length > 0);
    assert.equal(data.module, 'Engine.Runtime');
  });

  it('should find files by name', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/find-file?filename=Actor.h&language=cpp&maxResults=5');
    assert.equal(status, 200);
    assert.ok(data.results.length > 0);
  });

  it('should return 400 for missing required params', async (t) => {
    skipIfNoService(t);
    const { status: s1 } = await fetchJson('/find-type');
    assert.equal(s1, 400);

    const { status: s2 } = await fetchJson('/find-children');
    assert.equal(s2, 400);

    const { status: s3 } = await fetchJson('/browse-module');
    assert.equal(s3, 400);

    const { status: s4 } = await fetchJson('/find-file');
    assert.equal(s4, 400);
  });

  it('should return /summary', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/summary');
    assert.equal(status, 200);
    assert.ok(data.stats);
    assert.ok(data.projects.length > 0);
  });

  it('should handle concurrent requests', async (t) => {
    skipIfNoService(t);
    const queries = [
      '/health',
      '/stats',
      '/find-type?name=AActor&language=cpp',
      '/find-type?name=UWidget&fuzzy=true',
      '/find-children?parent=AActor&maxResults=3',
      '/browse-module?module=Engine.Runtime&maxResults=5',
      '/find-file?filename=Actor.h&maxResults=3',
      '/status',
      '/summary',
      '/find-type?name=FVector&language=cpp'
    ];

    const start = Date.now();
    const results = await Promise.all(queries.map(q => fetchJson(q)));
    const elapsed = Date.now() - start;

    console.log(`  ${queries.length} concurrent requests: ${elapsed}ms`);
    assert.ok(results.every(r => r.status === 200));
    assert.ok(elapsed < 10000, `Concurrent requests took ${elapsed}ms, expected < 10s`);
  });

  it('should handle rapid sequential queries', async (t) => {
    skipIfNoService(t);
    const start = Date.now();
    for (let i = 0; i < 50; i++) {
      await fetchJson(`/find-type?name=UType${i}&fuzzy=true&maxResults=3`);
    }
    const elapsed = Date.now() - start;
    console.log(`  50 sequential fuzzy queries: ${elapsed}ms`);
    assert.ok(elapsed < 30000, `Sequential queries took ${elapsed}ms, expected < 30s`);
  });
});
