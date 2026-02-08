import { isDefinitionLine, recencyScore, rankResults, groupResultsByFile } from './src/service/search-ranking.js';
import { ZoektClient } from './src/service/zoekt-client.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (e) {
    console.log(`  [FAIL] ${name}: ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(a, b, msg) {
  assert(a === b, `${msg || 'assertEq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// --- isDefinitionLine ---

console.log('\n=== isDefinitionLine Tests ===\n');

test('detects class definition', () => {
  assert(isDefinitionLine('class MyClass : public UObject'), 'should detect class');
});

test('detects struct definition', () => {
  assert(isDefinitionLine('struct FMyStruct'), 'should detect struct');
});

test('detects enum definition', () => {
  assert(isDefinitionLine('enum class EMyEnum'), 'should detect enum');
});

test('detects UCLASS macro', () => {
  assert(isDefinitionLine('UCLASS(BlueprintType)'), 'should detect UCLASS');
});

test('detects USTRUCT macro', () => {
  assert(isDefinitionLine('USTRUCT()'), 'should detect USTRUCT');
});

test('detects UFUNCTION macro', () => {
  assert(isDefinitionLine('  UFUNCTION(BlueprintCallable)'), 'should detect UFUNCTION with indent');
});

test('detects UPROPERTY macro', () => {
  assert(isDefinitionLine('  UPROPERTY(EditAnywhere)'), 'should detect UPROPERTY');
});

test('detects UENUM macro', () => {
  assert(isDefinitionLine('UENUM(BlueprintType)'), 'should detect UENUM');
});

test('detects method implementation', () => {
  assert(isDefinitionLine('void AMyActor::BeginPlay('), 'should detect method impl');
});

test('detects function definition', () => {
  assert(isDefinitionLine('bool IsPlayerAlive(int32 PlayerId)'), 'should detect function');
});

test('detects #define macro', () => {
  assert(isDefinitionLine('#define MY_MACRO(x) ((x) * 2)'), 'should detect #define');
});

test('rejects comment lines', () => {
  assert(!isDefinitionLine('// class MyClass'), 'should reject // comment');
  assert(!isDefinitionLine('/* class Foo */'), 'should reject /* comment');
  assert(!isDefinitionLine(' * class inside block comment'), 'should reject * comment');
});

test('rejects plain usage', () => {
  assert(!isDefinitionLine('  x = new Foo();'), 'should reject new expression');
  assert(!isDefinitionLine('  int x = 5;'), 'should reject variable assignment');
  assert(!isDefinitionLine('  return result;'), 'should reject return');
});

test('rejects null/empty', () => {
  assert(!isDefinitionLine(null), 'should handle null');
  assert(!isDefinitionLine(''), 'should handle empty');
  assert(!isDefinitionLine('   '), 'should handle whitespace');
});

// --- recencyScore ---

console.log('\n=== recencyScore Tests ===\n');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

test('returns 10 for files modified today', () => {
  assertEq(recencyScore(NOW - 1000, NOW), 10, 'very recent');
});

test('returns 8 for files modified this week', () => {
  assertEq(recencyScore(NOW - 3 * DAY_MS, NOW), 8, '3 days old');
});

test('returns 5 for files modified this month', () => {
  assertEq(recencyScore(NOW - 15 * DAY_MS, NOW), 5, '15 days old');
});

test('returns 3 for files modified within 90 days', () => {
  assertEq(recencyScore(NOW - 60 * DAY_MS, NOW), 3, '60 days old');
});

test('returns 1 for very old files', () => {
  assertEq(recencyScore(NOW - 365 * DAY_MS, NOW), 1, '1 year old');
});

test('returns 0 for null/undefined mtime', () => {
  assertEq(recencyScore(null, NOW), 0, 'null mtime');
  assertEq(recencyScore(undefined, NOW), 0, 'undefined mtime');
  assertEq(recencyScore(0, NOW), 0, 'zero mtime');
});

// --- rankResults ---

console.log('\n=== rankResults Tests ===\n');

test('returns empty array unchanged', () => {
  const result = rankResults([], new Map());
  assertEq(result.length, 0, 'empty');
});

test('header file with definition ranks above cpp with plain usage', () => {
  const results = [
    { file: 'src/Player.cpp', line: 10, match: '  Player->DoStuff();', project: 'P', language: 'cpp' },
    { file: 'src/Player.h', line: 5, match: 'class APlayer : public AActor', project: 'P', language: 'cpp' },
  ];
  rankResults(results, new Map());
  assertEq(results[0].file, 'src/Player.h', 'header with definition should be first');
});

test('file with more matches ranks higher', () => {
  const results = [
    { file: 'a.cpp', line: 1, match: 'foo', project: 'P', language: 'cpp' },
    { file: 'b.cpp', line: 1, match: 'foo', project: 'P', language: 'cpp' },
    { file: 'b.cpp', line: 2, match: 'foo', project: 'P', language: 'cpp' },
    { file: 'b.cpp', line: 3, match: 'foo', project: 'P', language: 'cpp' },
    { file: 'b.cpp', line: 4, match: 'foo', project: 'P', language: 'cpp' },
    { file: 'b.cpp', line: 5, match: 'foo', project: 'P', language: 'cpp' },
  ];
  rankResults(results, new Map());
  assertEq(results[0].file, 'b.cpp', 'file with 5 matches should rank first');
});

test('recent file ranks above old file (all else equal)', () => {
  const results = [
    { file: 'old.as', line: 1, match: 'foo', project: 'P', language: 'angelscript' },
    { file: 'new.as', line: 1, match: 'foo', project: 'P', language: 'angelscript' },
  ];
  const mtimeMap = new Map([
    ['old.as', NOW - 365 * DAY_MS],
    ['new.as', NOW - 1000],
  ]);
  rankResults(results, mtimeMap);
  assertEq(results[0].file, 'new.as', 'recently modified file should rank first');
});

test('preserves line order within same file', () => {
  const results = [
    { file: 'a.h', line: 50, match: 'foo', project: 'P', language: 'cpp' },
    { file: 'a.h', line: 10, match: 'foo', project: 'P', language: 'cpp' },
    { file: 'a.h', line: 30, match: 'foo', project: 'P', language: 'cpp' },
  ];
  rankResults(results, new Map());
  assertEq(results[0].line, 10, 'line 10 first');
  assertEq(results[1].line, 30, 'line 30 second');
  assertEq(results[2].line, 50, 'line 50 third');
});

test('/Public/ path gets boost', () => {
  const results = [
    { file: 'src/Private/Impl.h', line: 1, match: 'class X', project: 'P', language: 'cpp' },
    { file: 'src/Public/API.h', line: 1, match: 'class X', project: 'P', language: 'cpp' },
  ];
  rankResults(results, new Map());
  assertEq(results[0].file, 'src/Public/API.h', 'Public header should rank first');
});

test('handles null mtimeMap gracefully', () => {
  const results = [
    { file: 'a.cpp', line: 1, match: 'foo', project: 'P', language: 'cpp' },
  ];
  rankResults(results, null);
  assertEq(results.length, 1, 'should not crash');
});

// --- groupResultsByFile ---

console.log('\n=== groupResultsByFile Tests ===\n');

test('returns empty array for empty input', () => {
  assertEq(groupResultsByFile([]).length, 0, 'empty');
  assertEq(groupResultsByFile(null).length, 0, 'null');
});

test('groups results by file', () => {
  const results = [
    { file: 'a.cpp', project: 'P', language: 'cpp', line: 1, match: 'foo' },
    { file: 'b.cpp', project: 'P', language: 'cpp', line: 5, match: 'bar' },
    { file: 'a.cpp', project: 'P', language: 'cpp', line: 10, match: 'baz' },
  ];
  const groups = groupResultsByFile(results);
  assertEq(groups.length, 2, 'should have 2 groups');
  // a.cpp has 2 matches, should be first (sorted by match count)
  assertEq(groups[0].file, 'a.cpp', 'a.cpp first (more matches)');
  assertEq(groups[0].matches.length, 2, 'a.cpp has 2 matches');
  assertEq(groups[1].file, 'b.cpp', 'b.cpp second');
  assertEq(groups[1].matches.length, 1, 'b.cpp has 1 match');
});

test('single file with multiple matches produces one group', () => {
  const results = [
    { file: 'x.h', project: 'P', language: 'cpp', line: 1, match: 'a' },
    { file: 'x.h', project: 'P', language: 'cpp', line: 5, match: 'b' },
    { file: 'x.h', project: 'P', language: 'cpp', line: 10, match: 'c' },
  ];
  const groups = groupResultsByFile(results);
  assertEq(groups.length, 1, 'one group');
  assertEq(groups[0].file, 'x.h', 'correct file');
  assertEq(groups[0].matches.length, 3, '3 matches');
});

test('preserves context in grouped matches', () => {
  const results = [
    { file: 'a.cpp', project: 'P', language: 'cpp', line: 1, match: 'foo', context: ['before', 'after'] },
  ];
  const groups = groupResultsByFile(results);
  assert(groups[0].matches[0].context, 'context should be present');
  assertEq(groups[0].matches[0].context.length, 2, '2 context lines');
});

test('omits context when not present', () => {
  const results = [
    { file: 'a.cpp', project: 'P', language: 'cpp', line: 1, match: 'foo' },
  ];
  const groups = groupResultsByFile(results);
  assertEq(groups[0].matches[0].context, undefined, 'no context');
});

test('group has correct shape', () => {
  const results = [
    { file: 'a.cpp', project: 'MyProject', language: 'cpp', line: 1, match: 'foo' },
  ];
  const groups = groupResultsByFile(results);
  assertEq(groups[0].file, 'a.cpp', 'file');
  assertEq(groups[0].project, 'MyProject', 'project');
  assertEq(groups[0].language, 'cpp', 'language');
  assert(Array.isArray(groups[0].matches), 'matches is array');
});

test('groups sorted by match count descending', () => {
  const results = [
    { file: 'one.cpp', project: 'P', language: 'cpp', line: 1, match: 'x' },
    { file: 'three.cpp', project: 'P', language: 'cpp', line: 1, match: 'x' },
    { file: 'three.cpp', project: 'P', language: 'cpp', line: 2, match: 'x' },
    { file: 'three.cpp', project: 'P', language: 'cpp', line: 3, match: 'x' },
    { file: 'two.cpp', project: 'P', language: 'cpp', line: 1, match: 'x' },
    { file: 'two.cpp', project: 'P', language: 'cpp', line: 2, match: 'x' },
  ];
  const groups = groupResultsByFile(results);
  assertEq(groups[0].file, 'three.cpp', 'three.cpp first (3 matches)');
  assertEq(groups[1].file, 'two.cpp', 'two.cpp second (2 matches)');
  assertEq(groups[2].file, 'one.cpp', 'one.cpp third (1 match)');
});

// --- ZoektClient.searchSymbols ---

console.log('\n=== ZoektClient.searchSymbols Tests ===\n');

test('searchSymbols builds correct query with sym: prefix', async () => {
  const client = new ZoektClient(9999);
  let capturedQuery = '';
  // Override _executeQuery to capture the query
  client._executeQuery = async (query) => {
    capturedQuery = query;
    return { results: [], totalMatches: 0, matchedFiles: 0, filesSearched: 0, searchEngine: 'zoekt', zoektDurationMs: 0 };
  };
  await client.searchSymbols('APlayerController');
  assert(capturedQuery.includes('sym:APlayerController'), `query should contain sym: prefix, got: ${capturedQuery}`);
  assert(capturedQuery.includes('case:yes'), 'should be case sensitive by default');
  assert(capturedQuery.includes('-file:^_assets/'), 'should exclude assets');
});

test('searchSymbols applies project filter', async () => {
  const client = new ZoektClient(9999);
  let capturedQuery = '';
  client._executeQuery = async (query) => {
    capturedQuery = query;
    return { results: [], totalMatches: 0, matchedFiles: 0, filesSearched: 0, searchEngine: 'zoekt', zoektDurationMs: 0 };
  };
  await client.searchSymbols('Foo', { project: 'MyProject' });
  assert(capturedQuery.includes('file:MyProject/'), `should have project filter, got: ${capturedQuery}`);
});

test('searchSymbols applies language filter', async () => {
  const client = new ZoektClient(9999);
  let capturedQuery = '';
  client._executeQuery = async (query) => {
    capturedQuery = query;
    return { results: [], totalMatches: 0, matchedFiles: 0, filesSearched: 0, searchEngine: 'zoekt', zoektDurationMs: 0 };
  };
  await client.searchSymbols('Foo', { language: 'cpp' });
  assert(capturedQuery.includes('file:\\.'), `should have language file filter, got: ${capturedQuery}`);
});

test('searchSymbols respects caseSensitive=false', async () => {
  const client = new ZoektClient(9999);
  let capturedQuery = '';
  client._executeQuery = async (query) => {
    capturedQuery = query;
    return { results: [], totalMatches: 0, matchedFiles: 0, filesSearched: 0, searchEngine: 'zoekt', zoektDurationMs: 0 };
  };
  await client.searchSymbols('Foo', { caseSensitive: false });
  assert(capturedQuery.includes('case:no'), `should be case insensitive, got: ${capturedQuery}`);
});

// --- Summary ---

console.log(`\n====================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`====================================\n`);

process.exit(failed > 0 ? 1 : 0);
