import { IndexDatabase } from './src/service/database.js';
import { extractTrigrams, contentHash } from './src/service/trigram.js';
import { deflateSync, inflateSync } from 'zlib';
import { join, dirname } from 'path';
import { unlinkSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const testDbPath = join(__dirname, 'data', 'test-trigram.db');

// Clean up from previous runs
try { unlinkSync(testDbPath); } catch {}

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

console.log('\nTrigram Database Integration Tests\n');

const db = new IndexDatabase(testDbPath);
db.open();

test('trigram tables exist', () => {
  assert(db.hasTrigramTables(), 'file_content table should exist');
});

test('trigramBuildNeeded flag is set on fresh db', () => {
  const needed = db.getMetadata('trigramBuildNeeded');
  assert(needed === true, `Expected true, got ${needed}`);
});

test('isTrigramIndexReady returns false when build needed', () => {
  assert(!db.isTrigramIndexReady(), 'Should not be ready');
});

// Insert a test file
const fileId = db.upsertFile('/test/foo.as', 'TestProject', 'TestProject.Foo', Date.now(), 'angelscript');

test('upsertFileContent works', () => {
  const content = 'class AMyActor : AActor\n{\n  void DestroyActor() {}\n}\n';
  const compressed = deflateSync(content);
  const hash = contentHash(content);
  db.upsertFileContent(fileId, compressed, hash);

  const stored = db.getFileContent(fileId);
  assert(stored, 'Should have stored content');
  const decompressed = inflateSync(stored.content).toString('utf-8');
  assert(decompressed === content, 'Content round-trip should match');
});

test('insertTrigrams works', () => {
  const content = 'class AMyActor : AActor\n{\n  void DestroyActor() {}\n}\n';
  const trigrams = [...extractTrigrams(content)];
  db.clearTrigramsForFile(fileId);
  db.insertTrigrams(fileId, trigrams);

  const stats = db.getTrigramStats();
  assert(stats.filesWithContent === 1, `Expected 1 file, got ${stats.filesWithContent}`);
  assert(stats.trigramRows > 0, `Expected trigram rows, got ${stats.trigramRows}`);
});

test('queryTrigramCandidates finds file by trigrams', () => {
  const searchTrigrams = [...extractTrigrams('destroyactor')];
  const candidates = db.queryTrigramCandidates(searchTrigrams, {});
  assert(candidates.length === 1, `Expected 1 candidate, got ${candidates.length}`);
  assert(candidates[0].path === '/test/foo.as', `Wrong path: ${candidates[0].path}`);
});

test('queryTrigramCandidates filters by project', () => {
  const searchTrigrams = [...extractTrigrams('destroyactor')];
  const candidates = db.queryTrigramCandidates(searchTrigrams, { project: 'TestProject' });
  assert(candidates.length === 1, `Expected 1, got ${candidates.length}`);

  const none = db.queryTrigramCandidates(searchTrigrams, { project: 'NoSuchProject' });
  assert(none.length === 0, `Expected 0, got ${none.length}`);
});

test('queryTrigramCandidates returns no candidates for non-matching trigrams', () => {
  const searchTrigrams = [...extractTrigrams('zzzzzzzzz')];
  const candidates = db.queryTrigramCandidates(searchTrigrams, {});
  assert(candidates.length === 0, `Expected 0, got ${candidates.length}`);
});

test('queryTrigramCandidates with empty trigrams returns null (fallback signal)', () => {
  const candidates = db.queryTrigramCandidates([], {});
  assert(candidates === null, `Expected null, got ${candidates}`);
});

// Insert a second file
const fileId2 = db.upsertFile('/test/bar.as', 'TestProject', 'TestProject.Bar', Date.now(), 'angelscript');
const content2 = 'class ABotPawn : APawn\n{\n  void UpdateAI() {}\n}\n';
const compressed2 = deflateSync(content2);
db.upsertFileContent(fileId2, compressed2, contentHash(content2));
db.insertTrigrams(fileId2, [...extractTrigrams(content2)]);

test('queryTrigramCandidates narrows to correct file', () => {
  const destroyTrigrams = [...extractTrigrams('destroyactor')];
  const candidates = db.queryTrigramCandidates(destroyTrigrams, {});
  assert(candidates.length === 1, `Expected 1 (only foo.as), got ${candidates.length}`);
  assert(candidates[0].path === '/test/foo.as', `Wrong file: ${candidates[0].path}`);
});

test('getFilesWithoutContent finds missing files', () => {
  db.upsertFile('/test/baz.as', 'TestProject', 'TestProject.Baz', Date.now(), 'angelscript');
  const missing = db.getFilesWithoutContent();
  assert(missing.length === 1, `Expected 1 missing, got ${missing.length}`);
  assert(missing[0].path === '/test/baz.as', `Wrong path: ${missing[0].path}`);
});

test('getFileContentBatch returns map', () => {
  const batch = db.getFileContentBatch([fileId, fileId2]);
  assert(batch.size === 2, `Expected 2 entries, got ${batch.size}`);
  assert(batch.has(fileId), 'Should have fileId');
  assert(batch.has(fileId2), 'Should have fileId2');
});

test('cascade delete removes content', () => {
  db.deleteFile('/test/foo.as');

  const content = db.getFileContent(fileId);
  assert(!content, 'file_content should be cascade deleted');

  const file = db.getFileByPath('/test/foo.as');
  assert(!file, 'File should be deleted');
});

test('setMetadata clears trigramBuildNeeded', () => {
  db.setMetadata('trigramBuildNeeded', false);
  assert(db.isTrigramIndexReady(), 'Should be ready after clearing flag');
});

db.close();

// Clean up
try { unlinkSync(testDbPath); } catch {}

console.log(`\n--- Results: ${passed}/${passed + failed} passed ---\n`);
process.exit(failed > 0 ? 1 : 0);
