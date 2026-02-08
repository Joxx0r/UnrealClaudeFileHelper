#!/usr/bin/env node

import * as p from '@clack/prompts';
import { existsSync, readdirSync, unlinkSync } from 'fs';
import { writeFile, readFile } from 'fs/promises';
import { join, dirname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const CONFIG_PATH = join(ROOT, 'config.json');
const EXAMPLE_PATH = join(ROOT, 'config.example.json');
const DB_PATH = join(ROOT, 'data', 'index.db');

// ── Utilities ──────────────────────────────────────────────

function fwd(path) {
  return path.replace(/\\/g, '/');
}

function cleanPath(input) {
  return resolve(input.trim().replace(/^["']|["']$/g, ''));
}

function cancelGuard(value) {
  if (p.isCancel(value)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }
  return value;
}

function findUProjectFile(dir) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.uproject')) {
        return join(dir, entry.name);
      }
    }
  } catch { /* */ }
  return null;
}

// ── Config I/O ─────────────────────────────────────────────

async function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

async function saveConfig(config) {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function ensureDefaults(config) {
  if (!config.port) config.port = 3847;
  if (!config.projects) config.projects = [];
  if (!config.exclude) {
    config.exclude = [
      '**/Intermediate/**',
      '**/Binaries/**',
      '**/.git/**',
      '**/node_modules/**',
    ];
  }
  return config;
}

// ── Service status ─────────────────────────────────────────

function checkService(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/status`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ running: true, status: JSON.parse(data) });
        } catch {
          resolve({ running: true, status: null });
        }
      });
    });
    req.on('error', () => resolve({ running: false }));
    req.setTimeout(1000, () => { req.destroy(); resolve({ running: false }); });
  });
}

// ── Detection ──────────────────────────────────────────────

function detectDirectories(projectRoot) {
  const candidates = [];
  const checks = [
    { subdir: 'Script', language: 'angelscript', label: 'Script/' },
    { subdir: 'Source', language: 'cpp', label: 'Source/' },
    { subdir: 'Plugins', language: 'cpp', label: 'Plugins/' },
    { subdir: 'Content', language: 'content', label: 'Content/' },
    { subdir: 'Config', language: 'config', label: 'Config/' },
  ];
  for (const check of checks) {
    const dir = join(projectRoot, check.subdir);
    if (existsSync(dir)) {
      candidates.push({ dir: fwd(dir), label: check.label, language: check.language });
    }
  }
  return candidates;
}

function detectEngineRoot(projectRoot) {
  let dir = dirname(projectRoot);
  for (let i = 0; i < 5; i++) {
    const engineSource = join(dir, 'Engine', 'Source');
    if (existsSync(engineSource)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function detectEngineDirectories(engineRoot) {
  const candidates = [];
  for (const sub of [join('Engine', 'Source'), join('Engine', 'Plugins')]) {
    const dir = join(engineRoot, sub);
    if (existsSync(dir)) {
      candidates.push({ dir: fwd(dir), label: sub.replace(/\\/g, '/'), language: 'cpp' });
    }
  }
  return candidates;
}

// ── Display helpers ────────────────────────────────────────

function formatConfigPreview(config) {
  const lines = [`Port: ${config.port}`, ''];
  for (const proj of config.projects) {
    lines.push(`${proj.name} (${proj.language})`);
    for (const path of proj.paths) {
      const ok = existsSync(path) ? '✓' : '✗';
      lines.push(`  ${ok} ${path}`);
    }
  }
  if (config.exclude?.length > 0) {
    lines.push('', `Exclude: ${config.exclude.join(', ')}`);
  }
  return lines.join('\n');
}

function buildProjectsFromSelections(selections, projectName) {
  const byLanguage = {};
  for (const sel of selections) {
    if (!byLanguage[sel.language]) byLanguage[sel.language] = [];
    byLanguage[sel.language].push(sel.dir);
  }

  const projects = [];
  if (byLanguage.angelscript) {
    projects.push({ name: projectName, paths: byLanguage.angelscript, language: 'angelscript' });
  }
  if (byLanguage.cpp) {
    projects.push({ name: `${projectName}-Cpp`, paths: byLanguage.cpp, language: 'cpp' });
  }
  if (byLanguage.content) {
    projects.push({
      name: `${projectName}-Content`, paths: byLanguage.content, language: 'content',
      contentRoot: byLanguage.content[0], extensions: ['.uasset', '.umap'],
    });
  }
  if (byLanguage.config) {
    projects.push({
      name: `${projectName}-Config`, paths: byLanguage.config, language: 'config',
      extensions: ['.ini'],
    });
  }
  return projects;
}

// ── Menu actions ───────────────────────────────────────────

async function actionViewConfig(config) {
  if (!config || !config.projects?.length) {
    p.log.warn('No config found. Run "Full setup" first.');
    return;
  }
  p.note(formatConfigPreview(config), 'Current config');
}

async function actionAddPaths(config) {
  if (!config || !config.projects?.length) {
    p.log.warn('No config found. Run "Full setup" first.');
    return null;
  }

  const projects = config.projects;
  let changed = false;

  let addMore = true;
  while (addMore) {
    const language = cancelGuard(await p.select({
      message: 'Language type for new path:',
      options: [
        { value: 'angelscript', label: 'AngelScript', hint: '.as files' },
        { value: 'cpp', label: 'C++', hint: '.h/.cpp files' },
        { value: 'content', label: 'Content', hint: '.uasset/.umap files' },
        { value: 'config', label: 'Config', hint: '.ini files' },
      ],
    }));

    const extraPath = cancelGuard(await p.text({
      message: 'Path to directory:',
      validate: (value) => {
        if (!value.trim()) return 'Please enter a path.';
        const resolved = cleanPath(value);
        if (!existsSync(resolved)) return `Path does not exist: ${resolved}`;
      },
    }));

    const resolved = fwd(cleanPath(extraPath));
    const dirName = basename(resolved);

    // Offer to merge into existing project of same language
    const sameLanguage = projects.filter(proj => proj.language === language);
    let targetProject = null;

    if (sameLanguage.length > 0) {
      const mergeChoice = cancelGuard(await p.select({
        message: 'Add to existing project or create new?',
        options: [
          ...sameLanguage.map(proj => ({
            value: proj.name,
            label: `Add to "${proj.name}"`,
            hint: proj.paths.join(', '),
          })),
          { value: '__new__', label: 'Create new project' },
        ],
      }));
      if (mergeChoice !== '__new__') {
        targetProject = projects.find(proj => proj.name === mergeChoice);
      }
    }

    if (targetProject) {
      if (!targetProject.paths.includes(resolved)) {
        targetProject.paths.push(resolved);
        changed = true;
      }
      p.log.success(`Added ${resolved} to "${targetProject.name}"`);
    } else {
      const name = cancelGuard(await p.text({
        message: 'Name for new project:',
        defaultValue: dirName,
        placeholder: dirName,
      }));

      const newProject = { name, paths: [resolved], language };
      if (language === 'content') {
        newProject.contentRoot = resolved;
        newProject.extensions = ['.uasset', '.umap'];
      } else if (language === 'config') {
        newProject.extensions = ['.ini'];
      }
      projects.push(newProject);
      changed = true;
      p.log.success(`Created project "${name}" (${language}) → ${resolved}`);
    }

    addMore = cancelGuard(await p.confirm({
      message: 'Add another path?',
      initialValue: true,
    }));
  }

  if (changed) {
    p.note(formatConfigPreview(config), 'Updated config');
    const writeIt = cancelGuard(await p.confirm({ message: 'Save changes?', initialValue: true }));
    if (writeIt) {
      await saveConfig(config);
      clearDatabase();
      p.log.success('Config saved.');
      return config;
    }
  }

  return null;
}

async function actionFullSetup() {
  // State for each stage
  let projectRoot = null;
  let projectName = null;
  let selectedDirs = [];
  let extraPaths = [];
  let engineSelections = [];

  // Stage functions — each can be re-run to redo that step

  async function stageProject() {
    const inputRaw = cancelGuard(await p.text({
      message: 'Path to .uproject file or project directory:',
      placeholder: 'D:/Code/UE/MyProject/MyGame.uproject',
      validate: (value) => {
        if (!value.trim()) return 'Please enter a path.';
        const resolved = cleanPath(value);
        if (!existsSync(resolved)) return `Path does not exist: ${resolved}`;
      },
    }));

    const inputPath = cleanPath(inputRaw);
    if (inputPath.endsWith('.uproject')) {
      projectRoot = dirname(inputPath);
      projectName = basename(inputPath, '.uproject');
    } else {
      projectRoot = inputPath;
      const uproject = findUProjectFile(inputPath);
      projectName = uproject ? basename(uproject, '.uproject') : basename(inputPath);
    }

    // Reset downstream stages when project changes
    selectedDirs = [];
    extraPaths = [];
    engineSelections = [];
  }

  async function stageDirectories() {
    const candidates = detectDirectories(projectRoot);
    if (candidates.length === 0) {
      p.log.error('No Script/, Source/, Plugins/, Content/, or Config/ directories found.');
      return;
    }
    selectedDirs = cancelGuard(await p.multiselect({
      message: 'Select directories to index:',
      options: candidates.map(c => ({ value: c, label: c.label, hint: c.language })),
      initialValues: candidates,
      required: true,
    }));
  }

  async function stageExtraPaths() {
    extraPaths = [];
    let addMore = cancelGuard(await p.confirm({
      message: 'Add additional paths to index?',
      initialValue: false,
    }));
    while (addMore) {
      const language = cancelGuard(await p.select({
        message: 'Language type:',
        options: [
          { value: 'angelscript', label: 'AngelScript', hint: '.as files' },
          { value: 'cpp', label: 'C++', hint: '.h/.cpp files' },
          { value: 'content', label: 'Content', hint: '.uasset/.umap files' },
          { value: 'config', label: 'Config', hint: '.ini files' },
        ],
      }));
      const extraPath = cancelGuard(await p.text({
        message: 'Path to directory:',
        validate: (value) => {
          if (!value.trim()) return 'Please enter a path.';
          const resolved = cleanPath(value);
          if (!existsSync(resolved)) return `Path does not exist: ${resolved}`;
        },
      }));
      const resolved = cleanPath(extraPath);
      extraPaths.push({ dir: fwd(resolved), label: `${basename(resolved)}/`, language });
      p.log.success(`Added: ${basename(resolved)}/ (${language})`);
      addMore = cancelGuard(await p.confirm({ message: 'Add another path?', initialValue: true }));
    }
  }

  async function stageEngine() {
    engineSelections = [];
    const engineRoot = detectEngineRoot(projectRoot);
    if (engineRoot) {
      const engineCandidates = detectEngineDirectories(engineRoot);
      if (engineCandidates.length > 0) {
        const selected = cancelGuard(await p.multiselect({
          message: 'Engine directories detected. Select which to index:',
          options: [
            ...engineCandidates.map(c => ({ value: c, label: c.label, hint: 'cpp' })),
            { value: 'none', label: 'Skip engine indexing' },
          ],
          initialValues: engineCandidates,
          required: true,
        }));
        for (const sel of selected) {
          if (sel !== 'none') engineSelections.push(sel);
        }
      }
    } else {
      const addEngine = cancelGuard(await p.confirm({
        message: 'Add engine source path manually?',
        initialValue: false,
      }));
      if (addEngine) {
        const enginePath = cancelGuard(await p.text({
          message: 'Engine root directory (containing Engine/Source):',
          validate: (value) => {
            if (!value.trim()) return 'Please enter a path.';
            const resolved = cleanPath(value);
            if (!existsSync(resolved)) return `Path does not exist: ${resolved}`;
            if (!existsSync(join(resolved, 'Engine', 'Source'))) return 'No Engine/Source found at this path.';
          },
        }));
        const resolved = cleanPath(enginePath);
        const engineCandidates = detectEngineDirectories(resolved);
        if (engineCandidates.length > 0) {
          const selected = cancelGuard(await p.multiselect({
            message: 'Select engine directories to index:',
            options: engineCandidates.map(c => ({ value: c, label: c.label, hint: 'cpp' })),
            initialValues: engineCandidates,
            required: true,
          }));
          engineSelections.push(...selected);
        }
      }
    }
  }

  function buildSummary() {
    const lines = [];
    if (projectName) lines.push(`Project: ${projectName} (${projectRoot})`);
    if (selectedDirs.length > 0) {
      lines.push(`Directories: ${selectedDirs.map(d => d.label).join(', ')}`);
    }
    if (extraPaths.length > 0) {
      lines.push(`Extra paths: ${extraPaths.map(d => `${d.label} (${d.language})`).join(', ')}`);
    }
    if (engineSelections.length > 0) {
      lines.push(`Engine: ${engineSelections.map(e => e.label).join(', ')}`);
    }
    return lines.join('\n') || 'Nothing configured yet.';
  }

  // Run stages sequentially first time
  await stageProject();
  p.log.info(`Project: ${projectName} (${projectRoot})`);
  await stageDirectories();
  await stageExtraPaths();
  await stageEngine();

  // Review loop — show summary, let user redo any step or save
  while (true) {
    p.note(buildSummary(), 'Setup summary');

    const reviewAction = cancelGuard(await p.select({
      message: 'What next?',
      options: [
        { value: 'save', label: 'Save config', hint: 'write and finish' },
        { value: 'project', label: 'Change project path', hint: projectName || 'not set' },
        { value: 'dirs', label: 'Redo directory selection', hint: `${selectedDirs.length} selected` },
        { value: 'extra', label: 'Redo extra paths', hint: `${extraPaths.length} added` },
        { value: 'engine', label: 'Redo engine selection', hint: `${engineSelections.length} selected` },
        { value: 'cancel', label: 'Cancel', hint: 'back to main menu' },
      ],
    }));

    switch (reviewAction) {
      case 'project':
        await stageProject();
        p.log.info(`Project: ${projectName} (${projectRoot})`);
        await stageDirectories(); // re-detect after project change
        break;
      case 'dirs':
        await stageDirectories();
        break;
      case 'extra':
        await stageExtraPaths();
        break;
      case 'engine':
        await stageEngine();
        break;
      case 'cancel':
        p.log.warn('Setup cancelled.');
        return null;
      case 'save': {
        const allSelections = [...selectedDirs, ...extraPaths];
        const projects = buildProjectsFromSelections(allSelections, projectName);
        if (engineSelections.length > 0) {
          projects.push({ name: 'Engine', paths: engineSelections.map(s => s.dir), language: 'cpp' });
        }
        const config = ensureDefaults({ port: 3847, projects });

        p.note(formatConfigPreview(config), 'Final config');
        const writeIt = cancelGuard(await p.confirm({ message: 'Write this config?', initialValue: true }));
        if (!writeIt) continue; // back to review loop

        await saveConfig(config);
        clearDatabase();
        p.log.success('Config saved.');

        // Auto-check Zoekt prerequisites so users know what to expect
        await actionCheckPrerequisites();

        return config;
      }
    }
  }
}

async function actionStartService(port) {
  const { running } = await checkService(port);
  if (running) {
    p.log.warn(`Service is already running on port ${port}.`);
    return;
  }

  p.log.info('Starting service...');

  const child = spawn('node', [join(ROOT, 'src', 'service', 'index.js')], {
    cwd: ROOT,
    stdio: 'inherit',
    detached: true,
    shell: true,
  });

  child.unref();

  // Wait briefly to see if it starts
  await new Promise(r => setTimeout(r, 2000));
  const check = await checkService(port);
  if (check.running) {
    p.log.success(`Service started on port ${port}.`);
  } else {
    p.log.info('Service is starting up (check console output above).');
  }
}

function clearDatabase() {
  if (existsSync(DB_PATH)) {
    try {
      unlinkSync(DB_PATH);
      p.log.info('Cleared database (will rebuild on next start).');
    } catch (err) {
      p.log.warn(`Could not delete database: ${err.message}`);
    }
  }
}

// ── Prerequisites check ───────────────────────────────────

function checkPrerequisites() {
  const results = { go: false, zoekt: false, wsl: false, goVersion: null, zoektLocation: null };

  // Check Go
  try {
    const goVer = execSync('go version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }).trim();
    results.go = true;
    results.goVersion = goVer;
  } catch {}

  // Check Zoekt binaries — native PATH
  const ext = process.platform === 'win32' ? '.exe' : '';
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const found = execSync(`${which} zoekt-index`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }).trim().split('\n')[0].trim();
    if (found) { results.zoekt = true; results.zoektLocation = 'PATH'; }
  } catch {}

  // Check GOPATH/bin
  if (!results.zoekt) {
    const gopath = process.env.GOPATH || join(process.env.USERPROFILE || process.env.HOME || '', 'go');
    const binPath = join(gopath, 'bin', `zoekt-index${ext}`);
    if (existsSync(binPath)) {
      results.zoekt = true;
      results.zoektLocation = join(gopath, 'bin');
    }
  }

  // Check WSL (Windows only, fallback for Zoekt)
  if (process.platform === 'win32' && !results.zoekt) {
    try {
      const wslResult = execSync(
        'wsl -d Ubuntu -- bash -c "export PATH=/usr/local/go/bin:$HOME/go/bin:$PATH && which zoekt-index 2>/dev/null"',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
      ).trim();
      if (wslResult) {
        results.wsl = true;
        results.zoekt = true;
        results.zoektLocation = 'WSL2 (Ubuntu)';
      }
    } catch {}
  }

  return results;
}

async function actionCheckPrerequisites() {
  const s = p.spinner();
  s.start('Checking prerequisites...');
  const prereqs = checkPrerequisites();
  s.stop('Prerequisites checked.');

  const lines = [];

  // Go
  if (prereqs.go) {
    lines.push(`  Go:    OK (${prereqs.goVersion})`);
  } else {
    lines.push('  Go:    NOT FOUND');
    lines.push('         Install from https://go.dev/dl/');
  }

  // Zoekt
  if (prereqs.zoekt) {
    lines.push(`  Zoekt: OK (${prereqs.zoektLocation})`);
  } else if (prereqs.go) {
    lines.push('  Zoekt: NOT FOUND');
    lines.push('         Run: go install github.com/sourcegraph/zoekt/cmd/...@latest');
  } else if (process.platform === 'win32') {
    lines.push('  Zoekt: NOT FOUND');
    lines.push('         Option 1: Install Go + run: go install github.com/sourcegraph/zoekt/cmd/...@latest');
    lines.push('         Option 2: Install WSL2 (wsl --install -d Ubuntu), then install Go + Zoekt inside WSL');
  } else {
    lines.push('  Zoekt: NOT FOUND (install Go first)');
  }

  // Summary
  if (prereqs.zoekt) {
    lines.push('');
    lines.push('  Zoekt code search will be enabled for fast /grep queries.');
  } else {
    lines.push('');
    lines.push('  Without Zoekt, /grep will use slower SQLite trigram search.');
  }

  p.note(lines.join('\n'), 'Prerequisites');
  return prereqs;
}

// ── Main menu loop ─────────────────────────────────────────

async function main() {
  p.intro('Unreal Index Manager');

  let config = await loadConfig();
  if (config) {
    ensureDefaults(config);
  } else {
    p.log.warn('No config.json found. Run "Full setup" to create one.');
    if (existsSync(EXAMPLE_PATH)) {
      p.log.info('See config.example.json for reference.');
    }
  }

  let running = false;

  while (true) {
    // Check service status
    const port = config?.port || 3847;
    const serviceCheck = await checkService(port);
    running = serviceCheck.running;

    const statusLine = running
      ? `● Service running on port ${port}`
      : `○ Service not running`;

    const configLine = config?.projects?.length
      ? `${config.projects.length} project(s) configured`
      : 'No config';

    p.log.message(`${statusLine}  |  ${configLine}`);

    const action = cancelGuard(await p.select({
      message: 'What would you like to do?',
      options: [
        ...(config?.projects?.length
          ? [{ value: 'view', label: 'View config', hint: 'show current setup' }]
          : []),
        { value: 'full', label: 'Full setup', hint: 'configure from scratch' },
        ...(config?.projects?.length
          ? [{ value: 'add', label: 'Add paths', hint: 'add to existing config' }]
          : []),
        ...(config?.projects?.length
          ? [{
              value: 'start',
              label: running ? 'Service status' : 'Start service',
              hint: running ? `running on port ${port}` : 'launch the index service',
            }]
          : []),
        { value: 'prereqs', label: 'Check prerequisites', hint: 'Go, Zoekt, WSL status' },
        { value: 'exit', label: 'Exit' },
      ],
    }));

    switch (action) {
      case 'view':
        await actionViewConfig(config);
        break;

      case 'full': {
        const newConfig = await actionFullSetup();
        if (newConfig) config = newConfig;
        break;
      }

      case 'add': {
        const updated = await actionAddPaths(config);
        if (updated) config = updated;
        break;
      }

      case 'start':
        if (running) {
          if (serviceCheck.status && typeof serviceCheck.status === 'object') {
            const statusLines = [];
            for (const [lang, info] of Object.entries(serviceCheck.status)) {
              const state = info.status || 'unknown';
              const progress = info.progress ? ` (${info.progress})` : '';
              statusLines.push(`${lang}: ${state}${progress}`);
            }
            if (statusLines.length > 0) {
              p.note(statusLines.join('\n'), `Service on port ${port}`);
            } else {
              p.log.info(`Service is running on port ${port}.`);
            }
          } else {
            p.log.info(`Service is running on port ${port}.`);
          }
        } else {
          await actionStartService(port);
        }
        break;

      case 'prereqs':
        await actionCheckPrerequisites();
        break;

      case 'exit':
        p.outro('Goodbye!');
        return;
    }
  }
}

main().catch(err => {
  p.cancel(`Failed: ${err.message}`);
  process.exit(1);
});
