#!/usr/bin/env node

/**
 * Thin Windows-side file watcher.
 * Watches P4 directories for changes, reads + parses files, and POSTs
 * batched updates to the WSL-hosted unreal-index service.
 *
 * Usage: node src/watcher/watcher-client.js [config.json]
 */

import chokidar from 'chokidar';
import { readFile, stat } from 'fs/promises';
import { readdirSync, statSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { parseFile } from '../parser.js';
import { parseCppContent } from '../parsers/cpp-parser.js';
import { parseUAssetHeader } from '../parsers/uasset-parser.js';

// --- Config ---

const configPath = process.argv[2] || join(import.meta.dirname, '..', '..', 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));
const SERVICE_URL = config.service?.url || `http://${config.service?.host || '127.0.0.1'}:${config.service?.port || 3847}`;
const DEBOUNCE_MS = config.watcher?.debounceMs || 100;
const MAX_CONCURRENT = 10;
const BATCH_SIZE = 50;
const HEARTBEAT_INTERVAL_MS = 15000;
const RECONCILE_INTERVAL_MS = (config.watcher?.reconcileIntervalMinutes || 10) * 60 * 1000;

// --- Watcher telemetry ---

import { hostname } from 'os';
import { execSync } from 'child_process';
const startupTimestamp = new Date().toISOString();
const watcherId = `${hostname()}-${process.pid}`;

// Version info for mismatch detection
let watcherVersion = 'unknown';
let watcherGitHash = 'unknown';
try {
  const pkgPath = join(import.meta.dirname, '..', '..', 'package.json');
  watcherVersion = JSON.parse(readFileSync(pkgPath, 'utf-8')).version || 'unknown';
} catch {}
try {
  watcherGitHash = execSync('git rev-parse --short HEAD', { cwd: join(import.meta.dirname, '..', '..'), encoding: 'utf-8' }).trim();
} catch {}
let totalFilesIngested = 0;
let totalAssetsIngested = 0;
let totalDeletes = 0;
let totalErrors = 0;
let lastIngestTimestamp = null;
let lastReconcileTimestamp = null;
let nextReconcileTimestamp = null;

// --- Utility functions ---

function findProjectForPath(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  for (const project of config.projects) {
    for (const basePath of project.paths) {
      if (normalized.startsWith(basePath.replace(/\\/g, '/').toLowerCase())) {
        return project;
      }
    }
  }
  return null;
}

function findBasePathForFile(filePath, project) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  for (const basePath of project.paths) {
    if (normalized.startsWith(basePath.replace(/\\/g, '/').toLowerCase())) {
      return basePath;
    }
  }
  return null;
}

function hasMatchingExtension(filePath, project) {
  const extensions = project.extensions || (project.language === 'cpp' ? ['.h', '.cpp'] : ['.as']);
  return extensions.some(ext => filePath.endsWith(ext));
}

function deriveModule(relativePath, projectName) {
  const parts = relativePath.replace(/\.(as|h|cpp)$/, '').split('/');
  parts.pop();
  return [projectName, ...parts].join('.');
}

function shouldExclude(path) {
  const normalized = path.replace(/\\/g, '/');
  for (const pattern of config.exclude || []) {
    if (pattern.includes('**')) {
      const regex = new RegExp(pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'));
      if (regex.test(normalized)) return true;
    } else if (normalized.includes(pattern.replace(/\*/g, ''))) {
      return true;
    }
  }
  return false;
}

function collectFiles(dirPath, projectName, extensions, language) {
  const files = [];
  const scanDir = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldExclude(fullPath)) continue;
        scanDir(fullPath);
      } else if (entry.isFile()) {
        if (!extensions.some(ext => entry.name.endsWith(ext))) continue;
        if (shouldExclude(fullPath)) continue;
        try {
          const mtime = Math.floor(statSync(fullPath).mtimeMs);
          const relativePath = relative(dirPath, fullPath).replace(/\\/g, '/');
          const module = deriveModule(relativePath, projectName);
          files.push({ path: fullPath, project: projectName, module, mtime, basePath: dirPath, language });
        } catch {}
      }
    }
  };
  scanDir(dirPath);
  return files;
}

// --- HTTP helpers ---

async function fetchJson(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    } catch (err) {
      if (attempt < retries && (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.message.includes('ECONNRESET') || err.message.includes('fetch failed'))) {
        const delay = attempt * 2000;
        console.warn(`[Watcher] GET failed (${err.code || err.message}), retry ${attempt}/${retries} in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

async function postJson(url, body, retries = 3) {
  const payload = JSON.stringify(body);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
      }
      return res.json();
    } catch (err) {
      if (attempt < retries && (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'UND_ERR_SOCKET' || err.message.includes('ECONNRESET'))) {
        const delay = attempt * 2000;
        console.warn(`[Watcher] POST failed (${err.code || err.message}), retry ${attempt}/${retries} in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        // If service crashed, wait for it to come back
        try { await fetchJson(`${url.replace(/\/internal\/.*/, '')}/health`); } catch {
          console.log(`[Watcher] Service unavailable, waiting...`);
          await waitForService();
        }
        continue;
      }
      throw err;
    }
  }
}

// --- File reading + parsing ---

async function readAndParseSource(filePath, project, language) {
  const basePath = findBasePathForFile(filePath, project);
  if (!basePath) return null;

  const fileStat = await stat(filePath);
  const mtime = Math.floor(fileStat.mtimeMs);
  const relativePath = relative(basePath, filePath).replace(/\\/g, '/');
  const module = deriveModule(relativePath, project.name);

  if (language === 'config') {
    const content = await readFile(filePath, 'utf-8');
    return { path: filePath, project: project.name, module, mtime, language, relativePath, content, types: [], members: [] };
  }

  const content = await readFile(filePath, 'utf-8');
  let parsed;
  if (language === 'cpp') {
    parsed = parseCppContent(content, filePath);
  } else {
    parsed = await parseFile(filePath);
  }

  const types = [];
  for (const cls of parsed.classes || []) types.push({ name: cls.name, kind: cls.kind || 'class', parent: cls.parent, line: cls.line });
  for (const s of parsed.structs || []) types.push({ name: s.name, kind: 'struct', parent: s.parent || null, line: s.line });
  for (const e of parsed.enums || []) types.push({ name: e.name, kind: 'enum', parent: null, line: e.line });
  if (language === 'angelscript') {
    for (const ev of parsed.events || []) types.push({ name: ev.name, kind: 'event', parent: null, line: ev.line });
    for (const d of parsed.delegates || []) types.push({ name: d.name, kind: 'delegate', parent: null, line: d.line });
    for (const ns of parsed.namespaces || []) types.push({ name: ns.name, kind: 'namespace', parent: null, line: ns.line });
  }
  if (language === 'cpp') {
    for (const d of parsed.delegates || []) types.push({ name: d.name, kind: 'delegate', parent: null, line: d.line });
  }

  return {
    path: filePath, project: project.name, module, mtime, language, content,
    relativePath,
    types, members: parsed.members || []
  };
}

function parseAsset(filePath, project) {
  const contentRoot = project.contentRoot || project.paths[0];
  const mtime = Math.floor(statSync(filePath).mtimeMs);
  const relativePath = relative(contentRoot, filePath).replace(/\\/g, '/');
  const ext = relativePath.match(/\.[^.]+$/)?.[0] || '';
  const contentPath = '/Game/' + relativePath.replace(/\.[^.]+$/, '');
  const name = relativePath.split('/').pop().replace(/\.[^.]+$/, '');
  const folder = '/Game/' + relativePath.split('/').slice(0, -1).join('/');

  let assetClass = null;
  let parentClass = null;
  if (ext === '.uasset') {
    try {
      const info = parseUAssetHeader(filePath);
      assetClass = info.assetClass;
      parentClass = info.parentClass;
    } catch {}
  }

  return {
    path: filePath, name, contentPath, folder: folder || '/Game',
    project: project.name, extension: ext, mtime, assetClass, parentClass
  };
}

// --- Health check ---

async function waitForService() {
  console.log(`[Watcher] Waiting for service at ${SERVICE_URL}...`);
  while (true) {
    try {
      const status = await fetchJson(`${SERVICE_URL}/internal/status`);
      console.log(`[Watcher] Service connected. DB counts:`, status.counts);
      return status;
    } catch {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// --- Reconciliation (warm restart) ---

async function reconcile(project) {
  const language = project.language;
  const extensions = project.extensions || (language === 'cpp' ? ['.h', '.cpp'] : ['.as']);

  for (const basePath of project.paths) {
    // Step 1: Get stored mtimes from service
    const endpoint = language === 'content'
      ? `${SERVICE_URL}/internal/asset-mtimes?project=${encodeURIComponent(project.name)}`
      : `${SERVICE_URL}/internal/file-mtimes?language=${encodeURIComponent(language)}&project=${encodeURIComponent(project.name)}`;

    const storedMtimes = await fetchJson(endpoint);

    // Step 2: Scan disk (stat only, no reads)
    const collectStart = performance.now();
    const diskFiles = collectFiles(basePath, project.name, extensions, language);
    const diskMap = new Map(diskFiles.map(f => [f.path, f]));
    const collectMs = (performance.now() - collectStart).toFixed(0);

    // Step 3: Diff
    const changed = [];
    const deleted = [];

    for (const f of diskFiles) {
      const storedMtime = storedMtimes[f.path];
      if (storedMtime === undefined || storedMtime !== f.mtime) {
        changed.push(f);
      }
    }

    for (const storedPath of Object.keys(storedMtimes)) {
      if (!diskMap.has(storedPath)) {
        deleted.push(storedPath);
      }
    }

    if (changed.length === 0 && deleted.length === 0) {
      console.log(`[Watcher] ${project.name}: up to date (${diskFiles.length} files, scan ${collectMs}ms)`);
      continue;
    }

    console.log(`[Watcher] ${project.name}: ${changed.length} changed, ${deleted.length} deleted (of ${diskFiles.length} on disk, scan ${collectMs}ms)`);

    // Step 4: Send deletes
    if (deleted.length > 0) {
      for (let i = 0; i < deleted.length; i += BATCH_SIZE) {
        const batch = deleted.slice(i, i + BATCH_SIZE);
        await postJson(`${SERVICE_URL}/internal/ingest`, { deletes: batch });
      }
    }

    // Step 5: Re-ingest changed files
    if (language === 'content') {
      for (let i = 0; i < changed.length; i += BATCH_SIZE * 10) {
        const batch = changed.slice(i, i + BATCH_SIZE * 10);
        const assets = [];
        for (const f of batch) {
          try { assets.push(parseAsset(f.path, project)); } catch {}
        }
        if (assets.length > 0) {
          await postJson(`${SERVICE_URL}/internal/ingest`, { assets });
        }
        if ((i + batch.length) % 5000 < BATCH_SIZE * 10) {
          console.log(`[Watcher] ${project.name}: ${i + batch.length}/${changed.length} assets reconciled`);
        }
      }
    } else {
      for (let i = 0; i < changed.length; i += BATCH_SIZE) {
        const batch = changed.slice(i, i + BATCH_SIZE);
        const parsed = [];
        for (let j = 0; j < batch.length; j += MAX_CONCURRENT) {
          const concurrent = batch.slice(j, j + MAX_CONCURRENT);
          const results = await Promise.all(concurrent.map(async (f) => {
            try {
              return await readAndParseSource(f.path, project, language);
            } catch (err) {
              console.warn(`[Watcher] Error parsing ${f.path}: ${err.message}`);
              return null;
            }
          }));
          parsed.push(...results.filter(Boolean));
        }
        if (parsed.length > 0) {
          await postJson(`${SERVICE_URL}/internal/ingest`, { files: parsed });
        }
        if ((i + batch.length) % 500 < BATCH_SIZE) {
          console.log(`[Watcher] ${project.name}: ${i + batch.length}/${changed.length} files reconciled`);
        }
      }
    }
  }
}

// --- Full scan ---

async function fullScan(languages) {
  console.log(`[Watcher] Starting full scan for empty languages: ${languages.join(', ')}`);
  const scanStart = performance.now();

  for (const project of config.projects) {
    if (!languages.includes(project.language)) continue;
    const extensions = project.extensions || (project.language === 'cpp' ? ['.h', '.cpp'] : ['.as']);

    for (const basePath of project.paths) {
      const collectStart = performance.now();
      const files = collectFiles(basePath, project.name, extensions, project.language);
      const collectMs = (performance.now() - collectStart).toFixed(0);
      console.log(`[Watcher] Collected ${files.length} files from ${project.name} (${collectMs}ms)`);

      if (project.language === 'content') {
        // Asset batches
        for (let i = 0; i < files.length; i += BATCH_SIZE * 10) {
          const batch = files.slice(i, i + BATCH_SIZE * 10);
          const assets = [];
          for (const f of batch) {
            try { assets.push(parseAsset(f.path, project)); } catch {}
          }
          if (assets.length > 0) {
            await postJson(`${SERVICE_URL}/internal/ingest`, { assets });
          }
          if ((i + batch.length) % 5000 < BATCH_SIZE * 10) {
            console.log(`[Watcher] ${project.name}: ${i + batch.length}/${files.length} assets`);
          }
        }
      } else {
        // Source file batches with parallel reads
        for (let i = 0; i < files.length; i += BATCH_SIZE) {
          const batch = files.slice(i, i + BATCH_SIZE);
          const parsed = [];

          // Read + parse with bounded concurrency
          for (let j = 0; j < batch.length; j += MAX_CONCURRENT) {
            const concurrent = batch.slice(j, j + MAX_CONCURRENT);
            const results = await Promise.all(concurrent.map(async (f) => {
              try {
                return await readAndParseSource(f.path, project, project.language);
              } catch (err) {
                console.warn(`[Watcher] Error parsing ${f.path}: ${err.message}`);
                return null;
              }
            }));
            parsed.push(...results.filter(Boolean));
          }

          if (parsed.length > 0) {
            await postJson(`${SERVICE_URL}/internal/ingest`, { files: parsed });
          }
          if ((i + batch.length) % 500 < BATCH_SIZE) {
            console.log(`[Watcher] ${project.name}: ${i + batch.length}/${files.length} files`);
          }
        }
      }
    }
  }

  const totalS = ((performance.now() - scanStart) / 1000).toFixed(1);
  console.log(`[Watcher] Full scan complete (${totalS}s)`);
}

// --- Incremental watcher ---

function startWatcher() {
  const watchPaths = [];
  for (const project of config.projects) {
    for (const basePath of project.paths) {
      watchPaths.push(basePath);
    }
  }

  const pendingUpdates = new Map();
  let debounceTimer = null;

  const watcher = chokidar.watch(watchPaths, {
    ignored: [
      /(^|[\/\\])\../,
      ...(config.exclude || []).map(p => new RegExp(p.replace(/\*\*/g, '.*').replace(/\*/g, '[^/\\\\]*')))
    ],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
  });

  const processUpdates = async () => {
    const updates = new Map(pendingUpdates);
    pendingUpdates.clear();
    const start = performance.now();

    const files = [];
    const assets = [];
    const deletes = [];

    for (const [filePath, eventType] of updates) {
      const project = findProjectForPath(filePath);
      if (!project && eventType !== 'unlink') continue;

      if (eventType === 'unlink') {
        deletes.push(filePath);
        continue;
      }

      if (!hasMatchingExtension(filePath, project)) continue;

      try {
        if (project.language === 'content') {
          assets.push(parseAsset(filePath, project));
        } else {
          const parsed = await readAndParseSource(filePath, project, project.language);
          if (parsed) files.push(parsed);
        }
      } catch (err) {
        console.warn(`[Watcher] Error processing ${filePath}: ${err.message}`);
      }
    }

    if (files.length > 0 || assets.length > 0 || deletes.length > 0) {
      try {
        const result = await postJson(`${SERVICE_URL}/internal/ingest`, { files, assets, deletes });
        const ms = (performance.now() - start).toFixed(1);
        console.log(`[Watcher] +${files.length} assets:${assets.length} -${deletes.length} → ${result.processed} processed (${ms}ms)`);
        // Update telemetry counters
        totalFilesIngested += files.length;
        totalAssetsIngested += assets.length;
        totalDeletes += deletes.length;
        lastIngestTimestamp = new Date().toISOString();
      } catch (err) {
        console.error(`[Watcher] POST failed, re-queuing: ${err.message}`);
        totalErrors++;
        // Re-queue for retry
        for (const [k, v] of updates) pendingUpdates.set(k, v);
        debounceTimer = setTimeout(processUpdates, 5000);
      }
    }
  };

  const queueUpdate = (filePath, eventType) => {
    const project = findProjectForPath(filePath);
    if (!project) return;
    if (eventType !== 'unlink' && !hasMatchingExtension(filePath, project)) return;

    pendingUpdates.set(filePath, eventType);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processUpdates, DEBOUNCE_MS);
  };

  watcher.on('add', path => queueUpdate(path, 'add'));
  watcher.on('change', path => queueUpdate(path, 'change'));
  watcher.on('unlink', path => queueUpdate(path, 'unlink'));
  watcher.on('error', err => console.error('[Watcher] Error:', err));

  console.log(`[Watcher] Watching ${watchPaths.length} paths for changes`);
  return watcher;
}

// --- Main ---

async function main() {
  console.log(`[Watcher] Config: ${config.projects.length} projects, service: ${SERVICE_URL}`);

  const status = await waitForService();

  // Determine which languages need full scan vs reconciliation
  const configuredLanguages = [...new Set(config.projects.map(p => p.language))];
  const emptyLanguages = configuredLanguages.filter(lang => !status.counts[lang]);
  const populatedLanguages = configuredLanguages.filter(lang => status.counts[lang]);

  if (emptyLanguages.length > 0) {
    await fullScan(emptyLanguages);
  }

  // Reconcile populated languages: compare disk mtimes vs DB, re-ingest only changes
  if (populatedLanguages.length > 0) {
    console.log(`[Watcher] Reconciling populated languages: ${populatedLanguages.join(', ')}`);
    const reconcileStart = performance.now();
    for (const project of config.projects) {
      if (!populatedLanguages.includes(project.language)) continue;
      try {
        await reconcile(project);
      } catch (err) {
        console.error(`[Watcher] Reconcile failed for ${project.name}: ${err.message}`);
      }
    }
    const reconcileS = ((performance.now() - reconcileStart) / 1000).toFixed(1);
    console.log(`[Watcher] Reconciliation complete (${reconcileS}s)`);
  }

  startWatcher();

  // --- Heartbeat: send watcher status to service every 15s ---

  async function sendHeartbeat() {
    try {
      await postJson(`${SERVICE_URL}/internal/heartbeat`, {
        watcherId,
        version: watcherVersion,
        gitHash: watcherGitHash,
        startedAt: startupTimestamp,
        watchedPaths: config.projects.reduce((n, p) => n + p.paths.length, 0),
        projects: config.projects.map(p => ({
          name: p.name,
          language: p.language,
          pathCount: p.paths.length
        })),
        counters: {
          filesIngested: totalFilesIngested,
          assetsIngested: totalAssetsIngested,
          deletesProcessed: totalDeletes,
          errorsCount: totalErrors,
          lastIngestAt: lastIngestTimestamp
        },
        reconciliation: {
          lastRunAt: lastReconcileTimestamp,
          nextRunAt: nextReconcileTimestamp
        }
      });
    } catch {
      // Fire-and-forget — don't log noise for missed heartbeats
    }
  }

  sendHeartbeat();
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  console.log(`[Watcher] Heartbeat started (every ${HEARTBEAT_INTERVAL_MS / 1000}s)`);

  // --- Periodic reconciliation: catch missed file changes ---

  lastReconcileTimestamp = new Date().toISOString();
  nextReconcileTimestamp = new Date(Date.now() + RECONCILE_INTERVAL_MS).toISOString();

  async function periodicReconcile() {
    console.log(`[Watcher] Starting periodic reconciliation...`);
    const start = performance.now();
    for (const project of config.projects) {
      try {
        await reconcile(project);
      } catch (err) {
        console.error(`[Watcher] Periodic reconcile failed for ${project.name}: ${err.message}`);
      }
    }
    const s = ((performance.now() - start) / 1000).toFixed(1);
    console.log(`[Watcher] Periodic reconciliation complete (${s}s)`);
    lastReconcileTimestamp = new Date().toISOString();
    nextReconcileTimestamp = new Date(Date.now() + RECONCILE_INTERVAL_MS).toISOString();
  }

  setInterval(periodicReconcile, RECONCILE_INTERVAL_MS);
  console.log(`[Watcher] Periodic reconciliation scheduled (every ${RECONCILE_INTERVAL_MS / 60000}min)`);
}

main().catch(err => {
  console.error('[Watcher] Fatal error:', err);
  process.exit(1);
});
