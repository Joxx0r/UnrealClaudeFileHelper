import { parentPort, workerData } from 'worker_threads';
import { IndexDatabase } from './database.js';

const { dbPath } = workerData;

// Open read-only database connection (skips schema creation)
const database = new IndexDatabase(dbPath).open(true);

// Methods that can be dispatched to this worker (all read-only)
const ALLOWED_METHODS = new Set([
  'findTypeByName',
  'findChildrenOf',
  'findMember',
  'findFileByName',
  'findAssetByName',
  'browseModule',
  'listModules',
  'browseAssetFolder',
  'listAssetFolders',
  'getStats',
  'getAssetStats'
]);

parentPort.on('message', (msg) => {
  const { id, method, args } = msg;

  if (method === '_warmup') {
    const start = performance.now();
    try {
      // Light queries to populate SQLite page cache for key tables
      // These are fast (<100ms total) and touch the most-used B-tree pages
      database.findTypeByName('AActor', { maxResults: 1 });           // types + files indexes
      database.findTypeByName('Actor', { fuzzy: true, maxResults: 5 }); // name_trigrams index
      database.findMember('BeginPlay', { maxResults: 1 });            // members index
      database.findChildrenOf('AActor', { maxResults: 3 });           // types parent index
      database.findFileByName('Actor.h', { maxResults: 1 });          // files index
      database.listModules({ depth: 1 });                             // module aggregation
      const durationMs = performance.now() - start;
      parentPort.postMessage({ id, result: { warmed: true, durationMs }, durationMs });
    } catch (err) {
      parentPort.postMessage({ id, result: { warmed: false, error: err.message }, durationMs: performance.now() - start });
    }
    return;
  }

  if (!ALLOWED_METHODS.has(method)) {
    parentPort.postMessage({ id, error: `Method not allowed: ${method}` });
    return;
  }

  const start = performance.now();
  try {
    const result = database[method](...args);
    const durationMs = performance.now() - start;
    parentPort.postMessage({ id, result, durationMs });
  } catch (err) {
    const durationMs = performance.now() - start;
    parentPort.postMessage({ id, error: err.message, durationMs });
  }
});

parentPort.postMessage({ type: 'ready' });
