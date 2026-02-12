#!/usr/bin/env node

// Standalone installer for unreal-index PreToolUse hooks.
// Deploys the proxy binary (Go or Node.js fallback) to a project's .claude/hooks/,
// updates .claude/settings.json with hook config, and adds search instructions to CLAUDE.local.md.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Platform detection ───────────────────────────────────────

const isWSL = process.platform === 'linux' && (() => {
  try { return readFileSync('/proc/version', 'utf-8').toLowerCase().includes('microsoft'); } catch { return false; }
})();

/** Convert a Windows path (D:\foo\bar) to WSL path (/mnt/d/foo/bar) when running in WSL. */
function toNativePath(p) {
  if (isWSL && /^[A-Za-z]:[\\\/]/.test(p)) {
    const drive = p[0].toLowerCase();
    return `/mnt/${drive}${p.slice(2).replace(/\\/g, '/')}`;
  }
  return p;
}

/** Ensure a path uses Windows backslash format for use in settings.json. */
function toWindowsPath(p) {
  if (isWSL && p.startsWith('/mnt/')) {
    const match = p.match(/^\/mnt\/([a-z])(\/.*)/);
    if (match) return `${match[1].toUpperCase()}:${match[2].replace(/\//g, '\\')}`;
  }
  // On Windows, normalize forward slashes to backslashes
  if (process.platform === 'win32') {
    return p.replace(/\//g, '\\');
  }
  return p;
}

// ── Main install function ────────────────────────────────────

export async function installHooks(projectDir, { silent = false, tryGo = true } = {}) {
  // Convert to native path for filesystem operations
  const nativeDir = toNativePath(projectDir);
  const claudeDir = join(nativeDir, '.claude');
  const hooksDir = join(claudeDir, 'hooks');
  const settingsPath = join(claudeDir, 'settings.json');
  const claudeLocalMdPath = join(claudeDir, 'CLAUDE.local.md');

  // The command path in settings.json must use the original (Windows) path format
  const winProjectDir = /^[A-Za-z]:[\\\/]/.test(projectDir) ? projectDir : toWindowsPath(nativeDir);
  const winHooksDir = join(winProjectDir, '.claude', 'hooks').replace(/\//g, '\\');

  mkdirSync(hooksDir, { recursive: true });

  // ── Compile or copy proxy ──────────────────────────────────

  let proxyCommand;
  let compiled = false;
  const goSource = join(__dirname, 'unreal-index-proxy.go');

  if (tryGo) {
    try {
      execSync('go version', { stdio: 'pipe', timeout: 5000 });

      const targetExe = join(hooksDir, 'unreal-index-proxy.exe');
      // Cross-compile for Windows when running from WSL
      const envPrefix = isWSL ? 'GOOS=windows GOARCH=amd64 ' : '';
      execSync(`${envPrefix}go build -o "${targetExe}" "${goSource}"`, {
        stdio: 'pipe',
        timeout: 60000,
        cwd: __dirname,
      });
      compiled = true;
      proxyCommand = join(winHooksDir, 'unreal-index-proxy.exe');
      if (!silent) console.log('  Compiled Go proxy binary.');
    } catch (err) {
      if (!silent) console.log(`  Go compilation skipped: ${err.message?.split('\n')[0] || 'not available'}`);
    }
  }

  if (!compiled) {
    // Fall back to Node.js version
    const mjsSource = join(__dirname, 'unreal-index-proxy.mjs');
    const mjsDest = join(hooksDir, 'unreal-index-proxy.mjs');
    copyFileSync(mjsSource, mjsDest);
    proxyCommand = `node "${join(winHooksDir, 'unreal-index-proxy.mjs')}"`;
    if (!silent) console.log('  Installed Node.js proxy (Go not available).');
  }

  // ── Update settings.json ───────────────────────────────────

  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch {}
  }

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

  // Remove any existing unreal-index-proxy hooks (update in place)
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(h =>
    !(h.matcher === 'Grep|Glob|Bash' &&
      h.hooks?.some(hh => (hh.command || '').includes('unreal-index-proxy')))
  );

  // Add the new hook
  settings.hooks.PreToolUse.push({
    matcher: 'Grep|Glob|Bash',
    hooks: [{ type: 'command', command: proxyCommand }],
  });

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  if (!silent) console.log(`  Updated ${settingsPath}`);

  // ── Update CLAUDE.local.md ─────────────────────────────────

  const searchInstructions = readFileSync(join(__dirname, 'search-instructions.md'), 'utf-8');

  if (existsSync(claudeLocalMdPath)) {
    const existing = readFileSync(claudeLocalMdPath, 'utf-8');
    if (!existing.includes('USE UNREAL INDEX MCP TOOLS')) {
      writeFileSync(claudeLocalMdPath, existing.trimEnd() + '\n\n' + searchInstructions + '\n');
      if (!silent) console.log(`  Appended search instructions to ${claudeLocalMdPath}`);
    } else {
      if (!silent) console.log('  CLAUDE.local.md already has search instructions.');
    }
  } else {
    writeFileSync(claudeLocalMdPath, '# Claude Code Local Instructions\n\n' + searchInstructions + '\n');
    if (!silent) console.log(`  Created ${claudeLocalMdPath}`);
  }

  return { compiled, proxyCommand, hooksDir: winHooksDir, settingsPath, claudeLocalMdPath };
}

// ── CLI entry point ──────────────────────────────────────────

const isCLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isCLI) {
  const projectDir = process.argv[2];
  if (!projectDir) {
    console.error('Usage: node install.js <project-directory>');
    console.error('');
    console.error('  project-directory  Path to your project root (the directory');
    console.error('                     where .claude/ exists or will be created)');
    console.error('');
    console.error('Example:');
    console.error('  node install.js D:\\p4\\games\\Games\\MyProject\\Script');
    process.exit(1);
  }

  const resolved = resolve(projectDir);
  console.log(`\nInstalling unreal-index hooks to: ${resolved}\n`);

  try {
    const result = await installHooks(resolved);
    console.log('');
    console.log('Hooks installed successfully!');
    console.log(`  Proxy: ${result.compiled ? 'Go binary (compiled)' : 'Node.js (.mjs fallback)'}`);
    console.log(`  Hooks dir: ${result.hooksDir}`);
    console.log('');
    console.log('Restart Claude Code to activate the hooks.');
  } catch (err) {
    console.error(`\nFailed to install hooks: ${err.message}`);
    process.exit(1);
  }
}
