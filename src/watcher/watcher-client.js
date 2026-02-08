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

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return res.json();
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
    return { path: filePath, project: project.name, module, mtime, language, relativePath, types: [], members: [] };
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
      } catch (err) {
        console.error(`[Watcher] POST failed, re-queuing: ${err.message}`);
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

  // Determine which languages need full scan
  const configuredLanguages = [...new Set(config.projects.map(p => p.language))];
  const emptyLanguages = configuredLanguages.filter(lang => !status.counts[lang]);

  if (emptyLanguages.length > 0) {
    await fullScan(emptyLanguages);
  } else {
    console.log('[Watcher] All languages populated, skipping full scan');
  }

  startWatcher();
}

main().catch(err => {
  console.error('[Watcher] Fatal error:', err);
  process.exit(1);
});
