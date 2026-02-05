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
  'getAssetStats',
  'queryTrigramCandidates',
  'grepInline'
]);

parentPort.on('message', (msg) => {
  const { id, method, args } = msg;

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
