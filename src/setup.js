#!/usr/bin/env node

import { createInterface } from 'readline';
import { existsSync, readdirSync, unlinkSync } from 'fs';
import { writeFile, readFile } from 'fs/promises';
import { join, dirname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function log(msg = '') {
  console.log(msg);
}

function fwd(p) {
  return p.replace(/\\/g, '/');
}

function cleanPath(input) {
  return resolve(input.trim().replace(/^["']|["']$/g, ''));
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

function detectProjects(projectRoot, projectName) {
  const projects = [];
  const detected = [];

  const scriptDir = join(projectRoot, 'Script');
  if (existsSync(scriptDir)) {
    projects.push({
      name: projectName,
      paths: [fwd(scriptDir)],
      language: 'angelscript'
    });
    detected.push(`  AngelScript: ${scriptDir}`);
  }

  const sourceDir = join(projectRoot, 'Source');
  if (existsSync(sourceDir)) {
    projects.push({
      name: `${projectName}-Cpp`,
      paths: [fwd(sourceDir)],
      language: 'cpp'
    });
    detected.push(`  C++:         ${sourceDir}`);
  }

  const contentDir = join(projectRoot, 'Content');
  if (existsSync(contentDir)) {
    projects.push({
      name: `${projectName}-Content`,
      paths: [fwd(contentDir)],
      language: 'content',
      contentRoot: fwd(contentDir),
      extensions: ['.uasset', '.umap']
    });
    detected.push(`  Content:     ${contentDir}`);
  }

  const configDir = join(projectRoot, 'Config');
  if (existsSync(configDir)) {
    projects.push({
      name: `${projectName}-Config`,
      paths: [fwd(configDir)],
      language: 'config',
      extensions: ['.ini']
    });
    detected.push(`  Config:      ${configDir}`);
  }

  return { projects, detected };
}

function detectEngineRoot(projectRoot) {
  let dir = dirname(projectRoot);
  for (let i = 0; i < 5; i++) {
    const engineSource = join(dir, 'Engine', 'Source');
    if (existsSync(engineSource)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function validateExistingConfig(config) {
  if (!config.projects || !Array.isArray(config.projects) || config.projects.length === 0) {
    return false;
  }
  // At least one project must have paths that exist
  for (const p of config.projects) {
    if (p.paths && p.paths.some(path => existsSync(path))) {
      return true;
    }
  }
  return false;
}

function printConfig(config) {
  log(`  Port: ${config.port || 3847}`);
  for (const p of config.projects || []) {
    const lang = p.language || 'angelscript';
    const paths = (p.paths || []).join(', ');
    const exists = (p.paths || []).every(path => existsSync(path));
    log(`    ${p.name} (${lang})${exists ? '' : ' [WARNING: path missing]'}`);
    for (const path of p.paths || []) {
      log(`      ${path}`);
    }
  }
  if (config.exclude && config.exclude.length > 0) {
    log(`  Exclude: ${config.exclude.join(', ')}`);
  }
}

async function main() {
  log('=== Unreal Index Setup ===');
  log();

  const configPath = join(ROOT, 'config.json');

  // Check for existing config and offer to keep it
  if (existsSync(configPath)) {
    try {
      const existing = JSON.parse(await readFile(configPath, 'utf-8'));
      if (validateExistingConfig(existing)) {
        log('Current config:');
        printConfig(existing);
        log();
        const keep = await ask('Use this config? (Y/n): ');
        if (keep.trim().toLowerCase() !== 'n') {
          log('Keeping existing config.');
          rl.close();
          return;
        }
        log();
      } else {
        log('Existing config.json has issues (missing paths or no projects).');
        log();
      }
    } catch {
      log('Existing config.json could not be parsed, starting fresh.');
      log();
    }
  }

  // Ask for project path
  const input = await ask('Path to .uproject file or project directory: ');
  const inputPath = cleanPath(input);

  if (!existsSync(inputPath)) {
    log(`Error: Path does not exist: ${inputPath}`);
    rl.close();
    process.exit(1);
  }

  // Resolve project root
  let projectRoot;
  let projectName;

  if (inputPath.endsWith('.uproject')) {
    projectRoot = dirname(inputPath);
    projectName = basename(inputPath, '.uproject');
  } else {
    projectRoot = inputPath;
    const uproject = findUProjectFile(inputPath);
    if (uproject) {
      projectName = basename(uproject, '.uproject');
    } else {
      projectName = basename(inputPath);
    }
  }

  log();
  log(`Project root: ${projectRoot}`);
  log(`Project name: ${projectName}`);
  log();

  // Detect project structure
  const { projects, detected } = detectProjects(projectRoot, projectName);

  if (detected.length > 0) {
    log('Detected:');
    for (const d of detected) {
      log(d);
    }
    log();
  }

  if (projects.length === 0) {
    log('No Script/, Source/, Content/, or Config/ directories found.');
    log('Please check the path and try again.');
    rl.close();
    process.exit(1);
  }

  // Allow adding extra AngelScript directories
  log('Add additional AngelScript script directories? (e.g. Plugins/Shared/Script)');
  log('Enter paths one at a time, or press Enter to continue.');
  let extraCount = 0;
  while (true) {
    const extra = await ask('  Additional script path (empty to continue): ');
    const trimmed = extra.trim();
    if (!trimmed) break;

    const resolved = cleanPath(trimmed);
    if (!existsSync(resolved)) {
      log(`    Path does not exist: ${resolved}`);
      continue;
    }

    extraCount++;
    const extraName = basename(resolved);

    // Check if there's already an angelscript project we can add the path to,
    // or create a new one
    const addToExisting = await ask(`    Name for this project (default: "${extraName}"): `);
    const name = addToExisting.trim() || extraName;

    projects.push({
      name,
      paths: [fwd(resolved)],
      language: 'angelscript'
    });
    log(`    Added: ${name} -> ${resolved}`);
  }

  if (extraCount > 0) log();

  // Ask about engine source
  const engineRoot = detectEngineRoot(projectRoot);
  if (engineRoot) {
    const engineSource = fwd(join(engineRoot, 'Engine', 'Source'));
    const addEngine = await ask(`Engine source detected at ${engineSource}\nIndex engine C++ headers? (y/N): `);
    if (addEngine.trim().toLowerCase() === 'y') {
      projects.push({
        name: 'Engine',
        paths: [engineSource],
        language: 'cpp'
      });
      log('  Added Engine C++ project.');
    }
  } else {
    const enginePath = await ask('Engine source path (leave empty to skip): ');
    const trimmed = enginePath.trim();
    if (trimmed) {
      const resolved = cleanPath(trimmed);
      if (existsSync(resolved)) {
        projects.push({
          name: 'Engine',
          paths: [fwd(resolved)],
          language: 'cpp'
        });
        log('  Added Engine C++ project.');
      } else {
        log(`  Warning: Path does not exist: ${resolved}, skipping.`);
      }
    }
  }

  log();

  // Build config
  const config = {
    port: 3847,
    projects,
    exclude: [
      '**/Intermediate/**',
      '**/Binaries/**',
      '**/.git/**',
      '**/node_modules/**'
    ]
  };

  // Show final config
  log('Final config:');
  printConfig(config);
  log();

  const confirm = await ask('Write this config? (Y/n): ');
  if (confirm.trim().toLowerCase() === 'n') {
    log('Aborted. No changes made.');
    rl.close();
    process.exit(0);
  }

  // Write config
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  log(`Config written to ${configPath}`);

  // Clear database so fresh index is built
  const dbPath = join(ROOT, 'data', 'index.db');
  if (existsSync(dbPath)) {
    try {
      unlinkSync(dbPath);
      log('Cleared existing database (will rebuild on next start).');
    } catch (err) {
      log(`Warning: Could not delete database: ${err.message}`);
    }
  }

  log();
  log('Setup complete! Run start.bat or npm start to launch the service.');

  rl.close();
}

main().catch(err => {
  console.error('Setup failed:', err);
  rl.close();
  process.exit(1);
});
