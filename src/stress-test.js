#!/usr/bin/env node

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
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

// ============================================================
// C++ Parser Tests
// ============================================================
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

  // New tests for features #1, #2, #3, #4, #6, #7

  it('should detect I-prefix classes as interfaces (#6)', () => {
    const result = parseCppContent(`
class IMyInterface
{
};
`);
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0].name, 'IMyInterface');
    assert.equal(result.classes[0].kind, 'interface');
  });

  it('should detect non-I classes as class kind (#6)', () => {
    const result = parseCppContent(`
UCLASS()
class AActor : public UObject
{
};
`);
    assert.equal(result.classes[0].kind, 'class');
  });

  it('should parse struct with parent (#4)', () => {
    const result = parseCppContent(`
USTRUCT()
struct FChildStruct : public FParentStruct
{
  GENERATED_BODY()
};
`);
    assert.equal(result.structs.length, 1);
    assert.equal(result.structs[0].name, 'FChildStruct');
    assert.equal(result.structs[0].parent, 'FParentStruct');
  });

  it('should parse DECLARE_DYNAMIC_MULTICAST_DELEGATE (#7)', () => {
    const result = parseCppContent(`
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnHealthChanged, float, NewHealth);
DECLARE_DELEGATE_RetVal(bool, FCanActivate);
DECLARE_MULTICAST_DELEGATE(FOnDestroyed);
DECLARE_EVENT(AActor, FOnActorDestroyed);
`);
    assert.ok(result.delegates.length >= 3, `Expected >= 3 delegates, got ${result.delegates.length}`);
    assert.ok(result.delegates.some(d => d.name === 'FOnHealthChanged'));
    assert.ok(result.delegates.some(d => d.name === 'FCanActivate'));
    assert.ok(result.delegates.some(d => d.name === 'FOnDestroyed'));
  });

  it('should parse UFUNCTION members (#1)', () => {
    const result = parseCppContent(`
UCLASS()
class AActor : public UObject
{
  GENERATED_BODY()

  UFUNCTION(BlueprintCallable)
  void BeginPlay();

  UFUNCTION(BlueprintPure)
  float GetHealth() const;
};
`);
    assert.ok(result.members.length >= 2, `Expected >= 2 members, got ${result.members.length}`);
    const beginPlay = result.members.find(m => m.name === 'BeginPlay');
    assert.ok(beginPlay);
    assert.equal(beginPlay.memberKind, 'function');
    assert.equal(beginPlay.ownerName, 'AActor');

    const getHealth = result.members.find(m => m.name === 'GetHealth');
    assert.ok(getHealth);
    assert.equal(getHealth.memberKind, 'function');
  });

  it('should parse UPROPERTY members (#3)', () => {
    const result = parseCppContent(`
UCLASS()
class AActor : public UObject
{
  GENERATED_BODY()

  UPROPERTY(EditAnywhere)
  float MaxHealth;

  UPROPERTY(BlueprintReadOnly)
  int32 CurrentLevel;
};
`);
    assert.ok(result.members.length >= 2, `Expected >= 2 members, got ${result.members.length}`);
    const maxHealth = result.members.find(m => m.name === 'MaxHealth');
    assert.ok(maxHealth);
    assert.equal(maxHealth.memberKind, 'property');
    assert.equal(maxHealth.ownerName, 'AActor');
  });

  it('should parse enum values (#2)', () => {
    const result = parseCppContent(`
UENUM(BlueprintType)
enum class EGameState
{
  Idle,
  Playing,
  Paused,
  GameOver
};
`);
    assert.ok(result.members.length >= 4, `Expected >= 4 enum values, got ${result.members.length}`);
    assert.ok(result.members.some(m => m.name === 'Idle' && m.memberKind === 'enum_value'));
    assert.ok(result.members.some(m => m.name === 'Playing' && m.memberKind === 'enum_value'));
    assert.ok(result.members.some(m => m.name === 'GameOver' && m.memberKind === 'enum_value'));
    assert.equal(result.members[0].ownerName, 'EGameState');
  });
});

// ============================================================
// AngelScript Parser Tests
// ============================================================
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

  // New tests for features #1, #2, #3, #4, #6

  it('should detect I-prefix classes as interfaces (#6)', () => {
    const result = parseAngelscriptContent(`
class IMyInterface : UInterface
{
};
`);
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0].name, 'IMyInterface');
    assert.equal(result.classes[0].kind, 'interface');
  });

  it('should detect F-prefix classes (#6)', () => {
    const result = parseAngelscriptContent(`
class FMyHelper
{
};
`);
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0].name, 'FMyHelper');
    assert.equal(result.classes[0].kind, 'class');
  });

  it('should parse struct with parent (#4)', () => {
    const result = parseAngelscriptContent(`
struct FChildData : FParentData
{
  int Extra = 0;
};
`);
    assert.equal(result.structs.length, 1);
    assert.equal(result.structs[0].name, 'FChildData');
    assert.equal(result.structs[0].parent, 'FParentData');
  });

  it('should parse class members - functions and properties (#1, #3)', () => {
    const result = parseAngelscriptContent(`
class UMyActor : AActor
{
  UPROPERTY()
  float MaxHealth = 100.0f;

  int CurrentLevel;

  UFUNCTION()
  void BeginPlay()
  {
  }

  float GetHealth()
  {
    return MaxHealth;
  }
};
`);
    const functions = result.members.filter(m => m.memberKind === 'function');
    const properties = result.members.filter(m => m.memberKind === 'property');

    assert.ok(functions.length >= 2, `Expected >= 2 functions, got ${functions.length}`);
    assert.ok(properties.length >= 1, `Expected >= 1 properties, got ${properties.length}`);

    assert.ok(functions.some(f => f.name === 'BeginPlay'));
    assert.ok(functions.some(f => f.name === 'GetHealth'));
    assert.ok(properties.some(p => p.name === 'MaxHealth'));
  });

  it('should parse enum values (#2)', () => {
    const result = parseAngelscriptContent(`
enum EGameState
{
  Idle,
  Playing,
  Paused
};
`);
    const enumValues = result.members.filter(m => m.memberKind === 'enum_value');
    assert.ok(enumValues.length >= 3, `Expected >= 3 enum values, got ${enumValues.length}`);
    assert.ok(enumValues.some(v => v.name === 'Idle'));
    assert.ok(enumValues.some(v => v.name === 'Playing'));
    assert.ok(enumValues.some(v => v.name === 'Paused'));
    assert.equal(enumValues[0].ownerName, 'EGameState');
  });
});

// ============================================================
// Database Tests
// ============================================================
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

  it('should filter types by kind (#6)', () => {
    // Insert an interface type
    const fid = db.upsertFile('/test/Interface.as', 'Discovery', 'Discovery.Core', 9000, 'angelscript');
    db.insertTypes(fid, [
      { name: 'IMyInterface', kind: 'interface', parent: 'UInterface', line: 1 },
      { name: 'URegularClass', kind: 'class', parent: 'UObject', line: 20 }
    ]);

    const interfaces = db.findTypeByName('IMyInterface', { kind: 'interface' });
    assert.equal(interfaces.length, 1);
    assert.equal(interfaces[0].kind, 'interface');

    const classes = db.findTypeByName('IMyInterface', { kind: 'class' });
    assert.equal(classes.length, 0);
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

  it('should find children of structs (#4)', () => {
    const f1 = db.upsertFile('/test/StructBase.h', 'Engine', 'Engine.Runtime', 3010, 'cpp');
    db.insertTypes(f1, [
      { name: 'FBaseStruct', kind: 'struct', parent: null, line: 1 }
    ]);

    const f2 = db.upsertFile('/test/StructChild.h', 'Engine', 'Engine.Runtime', 3011, 'cpp');
    db.insertTypes(f2, [
      { name: 'FChildStruct', kind: 'struct', parent: 'FBaseStruct', line: 1 }
    ]);

    const children = db.findChildrenOf('FBaseStruct', { recursive: true });
    assert.ok(children.results.length >= 1);
    assert.ok(children.results.some(r => r.name === 'FChildStruct'));
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
    assert.ok('totalMembers' in stats);
    assert.ok('byMemberKind' in stats);
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

  // New member-related database tests

  it('should insert and query members (#1)', () => {
    const fid = db.upsertFile('/test/Members.as', 'Discovery', 'Discovery.Player', 7000, 'angelscript');
    db.insertTypes(fid, [
      { name: 'UPlayerClass', kind: 'class', parent: 'AActor', line: 1 }
    ]);

    const typeIds = db.getTypeIdsForFile(fid);
    const typeId = typeIds.find(t => t.name === 'UPlayerClass').id;

    db.insertMembers(fid, [
      { typeId, name: 'BeginPlay', memberKind: 'function', line: 10, isStatic: false, specifiers: 'UFUNCTION' },
      { typeId, name: 'MaxHealth', memberKind: 'property', line: 5, isStatic: false, specifiers: 'UPROPERTY' },
      { typeId, name: 'TakeDamage', memberKind: 'function', line: 20, isStatic: false, specifiers: null }
    ]);

    const results = db.findMember('BeginPlay');
    assert.ok(results.length >= 1);
    assert.equal(results[0].name, 'BeginPlay');
    assert.equal(results[0].member_kind, 'function');
    assert.equal(results[0].type_name, 'UPlayerClass');
  });

  it('should find members by containing type (#1)', () => {
    const results = db.findMember('MaxHealth', { containingType: 'UPlayerClass' });
    assert.ok(results.length >= 1);
    assert.equal(results[0].name, 'MaxHealth');

    const wrong = db.findMember('MaxHealth', { containingType: 'UNonExistent' });
    assert.equal(wrong.length, 0);
  });

  it('should find members with fuzzy search (#1)', () => {
    const results = db.findMember('Health', { fuzzy: true });
    assert.ok(results.length >= 1);
    assert.ok(results.some(r => r.name === 'MaxHealth'));
  });

  it('should filter members by kind (#1)', () => {
    const functions = db.findMember('BeginPlay', { memberKind: 'function' });
    assert.ok(functions.length >= 1);

    const properties = db.findMember('BeginPlay', { memberKind: 'property' });
    assert.equal(properties.length, 0);
  });

  it('should cascade delete members with file (#1)', () => {
    const fid = db.upsertFile('/test/MembersToDelete.h', 'Engine', 'Engine.Runtime', 8000, 'cpp');
    db.insertTypes(fid, [
      { name: 'UDelClass', kind: 'class', parent: null, line: 1 }
    ]);
    const typeIds = db.getTypeIdsForFile(fid);
    db.insertMembers(fid, [
      { typeId: typeIds[0].id, name: 'SomeFunc', memberKind: 'function', line: 5, isStatic: false, specifiers: null }
    ]);

    const before = db.findMember('SomeFunc');
    assert.ok(before.length >= 1);

    db.deleteFile('/test/MembersToDelete.h');

    const after = db.findMember('SomeFunc');
    assert.equal(after.length, 0);
  });

  it('should list modules (#5)', () => {
    const modules = db.listModules('', { depth: 1 });
    assert.ok(modules.length > 0);
    assert.ok(modules.some(m => m.path === 'Engine'));
    assert.ok(modules.some(m => m.path === 'Discovery'));

    const subModules = db.listModules('Discovery', { depth: 1 });
    assert.ok(subModules.length > 0);
  });
});

// ============================================================
// Database Stress Tests
// ============================================================
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

  it('should handle 10,000 files with types and members', () => {
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

        // Insert some members for the first type
        if (i % 10 === 0) {
          const typeIds = db.getTypeIdsForFile(fileId);
          if (typeIds.length > 0) {
            db.insertMembers(fileId, [
              { typeId: typeIds[0].id, name: `Func_${i}`, memberKind: 'function', line: 5, isStatic: false, specifiers: null },
              { typeId: typeIds[0].id, name: `Prop_${i}`, memberKind: 'property', line: 3, isStatic: false, specifiers: null }
            ]);
          }
        }
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
    assert.ok(stats.totalMembers >= 0);
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

    // Member query performance
    const memberStart = Date.now();
    const members = db.findMember('Func_100');
    const memberTime = Date.now() - memberStart;
    console.log(`  Member find: ${memberTime}ms`);
    assert.ok(members.length >= 1);
    assert.ok(memberTime < 100, `Member find took ${memberTime}ms, expected < 100ms`);

    const fuzzyMemberStart = Date.now();
    const fuzzyMembers = db.findMember('Func', { fuzzy: true, maxResults: 10 });
    const fuzzyMemberTime = Date.now() - fuzzyMemberStart;
    console.log(`  Fuzzy member find: ${fuzzyMemberTime}ms (found ${fuzzyMembers.length})`);
    assert.ok(fuzzyMembers.length > 0);
    assert.ok(fuzzyMemberTime < 5000, `Fuzzy member took ${fuzzyMemberTime}ms, expected < 5s`);
  });
});

// ============================================================
// API Integration Tests (Live Service)
// ============================================================
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
  });

  it('should find AngelScript types', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/find-type?name=UWidget&language=angelscript&fuzzy=true&maxResults=5');
    assert.equal(status, 200);
  });

  it('should browse Engine module', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/browse-module?module=Engine&language=cpp&maxResults=10');
    assert.equal(status, 200);
    assert.ok(data.types.length > 0);
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

    const { status: s5 } = await fetchJson('/find-member');
    assert.equal(s5, 400);
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
      '/browse-module?module=Engine&maxResults=5',
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

  // New integration tests for features #1-#7

  it('should find members via /find-member (#1)', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/find-member?name=BeginPlay&fuzzy=true&maxResults=5');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.results));
  });

  it('should find members with containingType filter (#1)', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/find-member?name=Health&fuzzy=true&containingType=AActor&maxResults=5');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.results));
  });

  it('should find enum values via /find-member (#2)', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/find-member?name=Default&memberKind=enum_value&fuzzy=true&maxResults=5');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.results));
  });

  it('should list modules via /list-modules (#5)', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/list-modules?depth=1');
    assert.equal(status, 200);
    assert.ok(data.results.length > 0, 'Should return at least one module');
    assert.ok(data.results[0].path, 'Each module should have a path');
    assert.ok(data.results[0].fileCount >= 0, 'Each module should have a fileCount');
  });

  it('should list child modules (#5)', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/list-modules?parent=Engine&depth=1');
    assert.equal(status, 200);
    assert.ok(data.results.length > 0, 'Engine should have child modules');
  });

  it('should filter types by kind (#6)', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/find-type?name=F&fuzzy=true&kind=delegate&maxResults=5');
    assert.equal(status, 200);
    // After re-index, all results should be delegates
    for (const r of data.results) {
      assert.equal(r.kind, 'delegate', `Expected delegate kind but got ${r.kind} for ${r.name}`);
    }
  });

  it('should find delegates via kind filter (#7)', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/find-type?name=On&fuzzy=true&kind=delegate&maxResults=5');
    assert.equal(status, 200);
    for (const r of data.results) {
      assert.equal(r.kind, 'delegate');
    }
  });

  it('should include member stats in /stats (#1)', async (t) => {
    skipIfNoService(t);
    const { status, data } = await fetchJson('/stats');
    assert.equal(status, 200);
    assert.ok('totalMembers' in data, 'Stats should include totalMembers');
    assert.ok('byMemberKind' in data, 'Stats should include byMemberKind');
  });

  it('should handle concurrent member queries (#1)', async (t) => {
    skipIfNoService(t);
    const queries = Array.from({ length: 10 }, (_, i) =>
      `/find-member?name=Func${i}&fuzzy=true&maxResults=3`
    );

    const start = Date.now();
    const results = await Promise.all(queries.map(q => fetchJson(q)));
    const elapsed = Date.now() - start;

    console.log(`  10 concurrent member queries: ${elapsed}ms`);
    assert.ok(results.every(r => r.status === 200));
    assert.ok(elapsed < 10000);
  });
});
