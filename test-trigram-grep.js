/**
 * End-to-end test for the trigram-powered grep flow.
 * Tests: trigram extraction in worker -> DB insert -> query candidates -> grep worker -> results
 */
import { IndexDatabase } from './src/service/database.js';
import { extractTrigrams, contentHash, patternToTrigrams } from './src/service/trigram.js';
import { deflateSync, inflateSync } from 'zlib';
import { Worker } from 'worker_threads';
import { join, dirname } from 'path';
import { unlinkSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const testDbPath = join(__dirname, 'data', 'test-grep.db');
try { unlinkSync(testDbPath); } catch {}

let passed = 0;
let failed = 0;

function test(name, fn) {
  return fn().then(() => {
    console.log(`  [PASS] ${name}`);
    passed++;
  }).catch(e => {
    console.log(`  [FAIL] ${name}: ${e.message}`);
    failed++;
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function runGrepWorker(workerData) {
  return new Promise((resolve, reject) => {
    const workerPath = join(__dirname, 'src', 'service', 'grep-worker.js');
    const worker = new Worker(workerPath, { workerData });
    worker.on('message', msg => {
      if (msg.type === 'complete') resolve(msg);
    });
    worker.on('error', reject);
  });
}

console.log('\nTrigram Grep End-to-End Tests\n');

const db = new IndexDatabase(testDbPath);
db.open();

// Mark trigram index as ready
db.setMetadata('trigramBuildNeeded', false);

// Create test files with realistic content
const files = [
  {
    path: '/test/PlayerCharacter.as',
    project: 'TestProject',
    language: 'angelscript',
    content: `class APlayerCharacter : ACharacter
{
  UPROPERTY(EditAnywhere)
  float MaxHealth = 100.0f;

  void DestroyActor()
  {
    // Custom destroy logic
    Super::DestroyActor();
  }

  void SetTimer(float Duration)
  {
    FTimerHandle Handle;
    System::SetTimer(Handle, Duration, false);
  }
}
`
  },
  {
    path: '/test/EnemyPawn.as',
    project: 'TestProject',
    language: 'angelscript',
    content: `class AEnemyPawn : APawn
{
  void DestroyPawn()
  {
    // Custom pawn removal logic
    Destroy();
  }
}
`
  },
  {
    path: '/test/GameMode.as',
    project: 'TestProject',
    language: 'angelscript',
    content: `class AMyGameMode : AGameModeBase
{
  void StartGame()
  {
    Print("Game started!");
  }
}
`
  }
];

// Index all files
for (const file of files) {
  const fileId = db.upsertFile(file.path, file.project, `${file.project}.Test`, Date.now(), file.language);
  const compressed = deflateSync(file.content);
  const hash = contentHash(file.content);
  const trigrams = [...extractTrigrams(file.content)];

  db.upsertFileContent(fileId, compressed, hash);
  db.insertTrigrams(fileId, trigrams);
}

await test('patternToTrigrams handles alternation with no common trigrams', async () => {
  // 4 branches with very different content — intersection is empty (unindexable)
  const trigrams = patternToTrigrams('DestroyActor|DestroyPawn|SetTimer|FTimerHandle', true);
  assert(trigrams.length === 0, `Expected 0 (unindexable alternation), got ${trigrams.length}`);

  // 2 branches with common prefix — should find common trigrams
  const trigrams2 = patternToTrigrams('DestroyActor|DestroyPawn', true);
  assert(trigrams2.length > 0, `Expected common trigrams from Destroy*, got ${trigrams2.length}`);
});

await test('queryTrigramCandidates with DestroyActor finds correct files', async () => {
  const trigrams = patternToTrigrams('DestroyActor', true);
  const candidates = db.queryTrigramCandidates(trigrams, {});
  assert(candidates.length === 1, `Expected 1 candidate, got ${candidates.length}`);
  assert(candidates[0].path === '/test/PlayerCharacter.as', `Wrong file: ${candidates[0].path}`);
});

await test('grep worker finds matches from compressed content', async () => {
  const trigrams = patternToTrigrams('DestroyActor', true);
  const candidates = db.queryTrigramCandidates(trigrams, {});

  const result = await runGrepWorker({
    candidates: candidates.map(c => ({
      content: c.content,
      path: c.path,
      project: c.project,
      language: c.language
    })),
    pattern: 'DestroyActor',
    flags: '',
    maxResults: 50,
    contextLines: 2,
    literals: null
  });

  assert(result.results.length > 0, `Expected matches, got ${result.results.length}`);
  assert(result.results[0].file === '/test/PlayerCharacter.as', `Wrong file: ${result.results[0].file}`);
  assert(result.filesSearched === 1, `Expected 1 file searched, got ${result.filesSearched}`);
});

await test('alternation pattern query returns correct candidates', async () => {
  const trigrams = patternToTrigrams('DestroyActor|DestroyPawn', true);
  const candidates = db.queryTrigramCandidates(trigrams, {});
  // Both alternatives share "estroy" trigrams; both files should match
  // But "destroyactor" only appears in PlayerCharacter, "destroypawn" only in EnemyPawn
  // The trigram intersection of the branches should find common trigrams
  // If the pattern extracts common trigrams like "des", "est", "str", "tro", "roy"
  // then both files containing "destroy*" should be candidates
  assert(candidates.length >= 1, `Expected at least 1 candidate, got ${candidates.length}`);
});

await test('grep worker with alternation finds matches in both files', async () => {
  // For the alternation, use empty trigrams to get all files (worst case),
  // then let the worker filter
  const trigrams = patternToTrigrams('DestroyActor|DestroyPawn', true);
  const candidates = db.queryTrigramCandidates(trigrams, {});

  const result = await runGrepWorker({
    candidates: candidates.map(c => ({
      content: c.content,
      path: c.path,
      project: c.project,
      language: c.language
    })),
    pattern: 'DestroyActor|DestroyPawn',
    flags: '',
    maxResults: 50,
    contextLines: 2,
    literals: null
  });

  const matchFiles = new Set(result.results.map(r => r.file));
  assert(matchFiles.has('/test/PlayerCharacter.as'), 'Should find PlayerCharacter.as');
  assert(matchFiles.has('/test/EnemyPawn.as'), 'Should find EnemyPawn.as');
  assert(!matchFiles.has('/test/GameMode.as'), 'Should NOT find GameMode.as');
});

await test('grep worker case-insensitive', async () => {
  const trigrams = patternToTrigrams('destroyactor', true);
  const candidates = db.queryTrigramCandidates(trigrams, {});

  const result = await runGrepWorker({
    candidates: candidates.map(c => ({
      content: c.content,
      path: c.path,
      project: c.project,
      language: c.language
    })),
    pattern: 'destroyactor',
    flags: 'i',
    maxResults: 50,
    contextLines: 2,
    literals: null
  });

  assert(result.results.length > 0, 'Case-insensitive search should find matches');
});

await test('unindexable pattern returns null (signals disk fallback)', async () => {
  const trigrams = patternToTrigrams('.*', true);
  assert(trigrams.length === 0, 'Should be unindexable');

  const candidates = db.queryTrigramCandidates(trigrams, {});
  assert(candidates === null, `Should return null for unindexable pattern, got ${candidates}`);
});

await test('project filter works with trigram query', async () => {
  const trigrams = patternToTrigrams('DestroyActor', true);
  const candidates = db.queryTrigramCandidates(trigrams, { project: 'NoSuchProject' });
  assert(candidates.length === 0, `Expected 0, got ${candidates.length}`);
});

await test('grep worker fallback mode (files) still works', async () => {
  // This tests the non-trigram path where files are read from disk
  // We can't test actual disk reads without real files, but we test
  // that the worker handles the empty files array gracefully
  const result = await runGrepWorker({
    files: [],
    pattern: 'test',
    flags: '',
    maxResults: 50,
    contextLines: 2,
    literals: null
  });

  assert(result.results.length === 0, 'Empty files should yield no results');
  assert(result.filesSearched === 0, 'Should search 0 files');
});

db.close();
try { unlinkSync(testDbPath); } catch {}

console.log(`\n--- Results: ${passed}/${passed + failed} passed ---\n`);
process.exit(failed > 0 ? 1 : 0);
