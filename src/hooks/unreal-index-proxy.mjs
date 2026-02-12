// PreToolUse hook: intercepts ALL Grep/Glob calls and proxies to unreal-index.
// Falls through to native Grep/Glob if service is unavailable or returns no results.

import { readFileSync } from 'node:fs';

const SERVICE_URL = 'http://localhost:3847';

// File extensions that indicate a specific file (skip — unreal-index greps whole project)
const FILE_EXT = /\.(as|cpp|h|hpp|cs|py|ini|json|xml|yaml|yml|toml|md|txt)$/i;

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const { tool_name, tool_input } = input;

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    }
  }));
  process.exit(0);
}

function allow() {
  process.exit(0);
}

function inferLanguage(glob, type) {
  const src = glob || type || '';
  if (/\.as\b/.test(src) || type === 'as') return 'angelscript';
  if (/\.(cpp|h|hpp)\b/.test(src) || type === 'cpp') return 'cpp';
  if (/\.(ini|cfg)\b/.test(src)) return 'config';
  return null;
}

// ── Grep handler ─────────────────────────────────────────────
async function handleGrep() {
  const {
    pattern, path, output_mode, glob, type,
    '-i': ci, '-C': ctxC, context: ctxP,
    head_limit,
  } = tool_input;

  if (FILE_EXT.test(path || '')) { allow(); return; }   // specific file
  if (!pattern || pattern.length < 2) { allow(); return; }

  try {
    const url = new URL('/grep', SERVICE_URL);
    url.searchParams.set('pattern', pattern);
    url.searchParams.set('maxResults', String(head_limit || 30));
    url.searchParams.set('grouped', 'false');
    if (ci) url.searchParams.set('caseSensitive', 'false');
    const ctx = ctxC || ctxP || 0;
    if (ctx > 0) url.searchParams.set('contextLines', String(ctx));
    const lang = inferLanguage(glob, type);
    if (lang) url.searchParams.set('language', lang);

    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) { allow(); return; }

    const data = await res.json();
    if (data.error || !data.results?.length) { allow(); return; }

    const mode = output_mode || 'files_with_matches';
    let formatted;

    if (mode === 'files_with_matches') {
      formatted = [...new Set(data.results.map(r => r.file))].join('\n');
    } else if (mode === 'count') {
      const counts = {};
      for (const r of data.results) counts[r.file] = (counts[r.file] || 0) + 1;
      formatted = Object.entries(counts).map(([f, c]) => `${f}: ${c}`).join('\n');
    } else {
      formatted = data.results.map(r => {
        let ln = `${r.file}:${r.line}: ${r.match}`;
        if (r.context?.length) ln += '\n' + r.context.map(c => `  ${c}`).join('\n');
        return ln;
      }).join('\n');
    }

    const trunc = data.truncated
      ? ` (${data.results.length} of ${data.totalMatches})`
      : '';

    deny(
      `[unreal-index] Grep intercepted — indexed results for "${pattern}"${trunc}:\n\n` +
      formatted +
      '\n\nResults from pre-built index. To search a specific file use Read. ' +
      'To search outside the indexed project, ask the user to allow direct Grep.'
    );
  } catch {
    allow();
  }
}

// ── Glob handler ─────────────────────────────────────────────
async function handleGlob() {
  const { pattern, path } = tool_input;

  // Extract meaningful filename from glob — skip pure-extension patterns
  const basename = (pattern || '').split('/').pop().split('\\').pop();
  const cleaned = basename.replace(/\*/g, '').replace(/\?/g, '').replace(/\.[^.]+$/, '');
  if (cleaned.length < 3) { allow(); return; }

  try {
    const url = new URL('/find-file', SERVICE_URL);
    url.searchParams.set('filename', cleaned);
    url.searchParams.set('maxResults', '30');

    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) { allow(); return; }

    const data = await res.json();
    if (data.error || !data.results?.length) { allow(); return; }

    const formatted = data.results.map(r => r.file).join('\n');
    deny(
      `[unreal-index] Glob intercepted — indexed results for "${pattern}":\n\n` +
      formatted +
      '\n\nResults from pre-built index. ' +
      'To search outside the indexed project, ask the user to allow direct Glob.'
    );
  } catch {
    allow();
  }
}

// ── Dispatch ─────────────────────────────────────────────────
if (tool_name === 'Grep')      await handleGrep();
else if (tool_name === 'Glob') await handleGlob();
else                           allow();
