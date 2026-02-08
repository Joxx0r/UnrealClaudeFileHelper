#!/usr/bin/env node

// Integration tests for web UI enhancements (issue #18)
// Requires the service to be running on port 3848 (with Zoekt)

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:3848';

async function serviceAvailable() {
  try {
    const resp = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

function skipIfNoService(t) {
  if (!serviceUp) {
    t.skip('Service not running on port 3848');
  }
}

let serviceUp = false;

before(async () => {
  serviceUp = await serviceAvailable();
  if (!serviceUp) {
    console.log('WARNING: Service not running on port 3848 — integration tests will be skipped');
  }
});

// ============================================================
// Static file content (checked from disk — the running service
// may serve old files if not restarted with this branch)
// ============================================================
describe('Web UI static file content (from disk)', () => {
  const publicDir = join(__dirname, '..', 'public');

  it('index.html should have live search with debounce', () => {
    const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
    assert.ok(html.includes('Unreal Index Search'), 'should contain page title');
    assert.ok(html.includes('debounceTimer'), 'should contain debounce logic');
    assert.ok(html.includes('AbortController'), 'should contain AbortController for cancellation');
    assert.ok(html.includes('selectedIndex'), 'should contain keyboard navigation state');
  });

  it('index.html should have keyboard navigation shortcuts', () => {
    const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
    assert.ok(html.includes("e.key === '/'"), 'should handle / key');
    assert.ok(html.includes("'ArrowDown'"), 'should handle ArrowDown');
    assert.ok(html.includes("'ArrowUp'"), 'should handle ArrowUp');
    assert.ok(html.includes('updateSelection'), 'should have selection update function');
    assert.ok(html.includes('.selected'), 'should have selected CSS class');
  });

  it('index.html should have loading indicator', () => {
    const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
    assert.ok(html.includes('id="loading"'), 'should have loading element');
    assert.ok(html.includes("'active'"), 'should toggle active class');
  });

  it('analytics.html should exist and have dashboard', () => {
    const html = readFileSync(join(publicDir, 'analytics.html'), 'utf8');
    assert.ok(html.includes('Search Analytics'), 'should contain analytics title');
    assert.ok(html.includes('/query-analytics?summary=true'), 'should fetch from analytics endpoint');
    assert.ok(html.includes('/health'), 'should fetch from health endpoint');
    assert.ok(html.includes('Slowest Queries'), 'should show slowest queries');
    assert.ok(html.includes('Queries by Endpoint'), 'should show queries by endpoint');
    assert.ok(html.includes('Service Health'), 'should show service health');
  });

  it('index.html should link to analytics', () => {
    const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
    assert.ok(html.includes('href="/analytics.html"'), 'should link to analytics page');
  });

  it('analytics.html should link back to search', () => {
    const html = readFileSync(join(publicDir, 'analytics.html'), 'utf8');
    assert.ok(html.includes('href="/"'), 'should link back to search');
  });

  it('index.html should handle filter changes with debounce', () => {
    const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
    assert.ok(html.includes("addEventListener('change'"), 'should listen for filter changes');
  });

  it('index.html should clear results when pattern is empty', () => {
    const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
    assert.ok(html.includes("if (!pattern)"), 'should check for empty pattern');
  });
});

// ============================================================
// Static file serving via HTTP
// ============================================================
describe('Web UI static file serving', () => {
  it('should serve index.html at /', async (t) => {
    skipIfNoService(t);
    const resp = await fetch(`${BASE}/`);
    assert.equal(resp.status, 200);
    const html = await resp.text();
    assert.ok(html.includes('Unreal Index Search'), 'should contain page title');
  });
});

// ============================================================
// Live search via /grep endpoint
// ============================================================
describe('Live search (/grep)', () => {
  it('should return results for a simple search', async (t) => {
    skipIfNoService(t);
    const params = new URLSearchParams({ pattern: 'AActor', maxResults: 5 });
    const resp = await fetch(`${BASE}/grep?${params}`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(data.results.length > 0, 'should have results');
    assert.equal(data.searchEngine, 'zoekt');
    assert.ok(typeof data.zoektDurationMs === 'number', 'should have duration');
  });

  it('should handle concurrent requests (simulating rapid typing)', async (t) => {
    skipIfNoService(t);
    // Simulate debounced search: fire 5 requests rapidly, all should succeed
    const queries = ['A', 'AA', 'AAc', 'AAct', 'AActor'];
    const results = await Promise.all(
      queries.map(q =>
        fetch(`${BASE}/grep?${new URLSearchParams({ pattern: q, maxResults: 5 })}`)
          .then(r => r.json())
          .then(data => ({ query: q, ok: true, count: data.results?.length || 0 }))
          .catch(err => ({ query: q, ok: false, error: err.message }))
      )
    );
    // All should succeed (server handles concurrency)
    for (const r of results) {
      assert.ok(r.ok, `Query "${r.query}" should succeed: ${r.error || ''}`);
    }
    // The final full query should have results
    const last = results[results.length - 1];
    assert.ok(last.count > 0, 'Full query "AActor" should have results');
  });

  it('should support AbortController cancellation', async (t) => {
    skipIfNoService(t);
    const controller = new AbortController();
    // Start a request then immediately cancel it
    const promise = fetch(
      `${BASE}/grep?${new URLSearchParams({ pattern: 'UObject', maxResults: 50 })}`,
      { signal: controller.signal }
    );
    controller.abort();
    await assert.rejects(promise, { name: 'AbortError' });
  });

  it('should return 400 for missing pattern', async (t) => {
    skipIfNoService(t);
    const resp = await fetch(`${BASE}/grep`);
    assert.equal(resp.status, 400);
    const data = await resp.json();
    assert.ok(data.error.includes('pattern'), 'error should mention pattern');
  });

  it('should return 400 for invalid regex', async (t) => {
    skipIfNoService(t);
    const params = new URLSearchParams({ pattern: '(unclosed' });
    const resp = await fetch(`${BASE}/grep?${params}`);
    assert.equal(resp.status, 400);
    const data = await resp.json();
    assert.ok(data.error.includes('regex'), 'error should mention regex');
  });

  it('should support case-insensitive search', async (t) => {
    skipIfNoService(t);
    const params = new URLSearchParams({ pattern: 'aactor', caseSensitive: 'false', maxResults: 5 });
    const resp = await fetch(`${BASE}/grep?${params}`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(data.results.length > 0, 'case-insensitive search should find results');
  });

  it('should support language filter', async (t) => {
    skipIfNoService(t);
    const params = new URLSearchParams({ pattern: 'class', language: 'angelscript', maxResults: 10 });
    const resp = await fetch(`${BASE}/grep?${params}`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    for (const r of data.results) {
      assert.ok(r.file.endsWith('.as'), `should be AngelScript file: ${r.file}`);
    }
  });

  it('should include context lines', async (t) => {
    skipIfNoService(t);
    const params = new URLSearchParams({ pattern: 'UCLASS', maxResults: 3, contextLines: 2 });
    const resp = await fetch(`${BASE}/grep?${params}`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    if (data.results.length > 0) {
      const r = data.results[0];
      assert.ok(r.context, 'should have context lines');
      assert.ok(r.context.length > 0, 'context should not be empty');
    }
  });

  it('should include asset results', async (t) => {
    skipIfNoService(t);
    // Search for something likely in both source and assets
    const params = new URLSearchParams({ pattern: 'Blueprint', maxResults: 10 });
    const resp = await fetch(`${BASE}/grep?${params}`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    // Assets may or may not be present depending on index state, just verify structure
    if (data.assets) {
      assert.ok(Array.isArray(data.assets), 'assets should be array');
      for (const a of data.assets) {
        assert.ok(a.file, 'asset should have file');
      }
    }
  });
});

// ============================================================
// Analytics endpoints
// ============================================================
describe('Analytics endpoints', () => {
  it('should return analytics summary', async (t) => {
    skipIfNoService(t);
    const resp = await fetch(`${BASE}/query-analytics?summary=true`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(typeof data.total === 'number', 'should have total count');
    assert.ok(Array.isArray(data.byMethod), 'should have byMethod array');
    assert.ok(Array.isArray(data.slowest), 'should have slowest array');

    // Validate byMethod structure
    for (const m of data.byMethod) {
      assert.ok(m.method, 'byMethod entry should have method name');
      assert.ok(typeof m.count === 'number', 'should have count');
      assert.ok(typeof m.avg_ms === 'number', 'should have avg_ms');
      assert.ok(typeof m.max_ms === 'number', 'should have max_ms');
    }

    // Validate slowest structure
    for (const s of data.slowest) {
      assert.ok(s.method, 'slowest entry should have method');
      assert.ok(typeof s.duration_ms === 'number', 'should have duration_ms');
      assert.ok(s.timestamp, 'should have timestamp');
    }
  });

  it('should return raw query analytics', async (t) => {
    skipIfNoService(t);
    const resp = await fetch(`${BASE}/query-analytics?limit=5`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data.queries), 'should have queries array');
    assert.ok(data.queries.length <= 5, 'should respect limit');
  });

  it('should filter by method', async (t) => {
    skipIfNoService(t);
    const resp = await fetch(`${BASE}/query-analytics?method=findTypeByName&limit=5`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    for (const q of data.queries) {
      assert.equal(q.method, 'findTypeByName', 'should only contain matching method');
    }
  });

  it('should filter by minimum duration', async (t) => {
    skipIfNoService(t);
    const resp = await fetch(`${BASE}/query-analytics?minDurationMs=1&limit=10`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    for (const q of data.queries) {
      assert.ok(q.duration_ms >= 1, `duration ${q.duration_ms} should be >= 1`);
    }
  });
});

// ============================================================
// Health endpoint (used by analytics dashboard)
// ============================================================
describe('Health endpoint (analytics dashboard dependency)', () => {
  it('should return health with zoekt status', async (t) => {
    skipIfNoService(t);
    const resp = await fetch(`${BASE}/health`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.status, 'ok');
    assert.ok(data.uptimeSeconds >= 0, 'should have uptime');
    assert.ok(data.memoryMB, 'should have memory info');
    assert.ok(typeof data.memoryMB.rss === 'number', 'should have RSS');
    assert.ok(typeof data.memoryMB.heapUsed === 'number', 'should have heap used');

    // Zoekt status (used by analytics dashboard)
    if (data.zoekt) {
      assert.ok(typeof data.zoekt.available === 'boolean', 'zoekt.available should be boolean');
    }
  });
});

// ============================================================
// Keyboard navigation support (result structure)
// ============================================================
describe('Search result structure for keyboard navigation', () => {
  it('should return results with file and line for VS Code links', async (t) => {
    skipIfNoService(t);
    const params = new URLSearchParams({ pattern: 'BeginPlay', maxResults: 5 });
    const resp = await fetch(`${BASE}/grep?${params}`);
    const data = await resp.json();

    for (const r of data.results) {
      assert.ok(r.file, 'result should have file path');
      assert.ok(typeof r.line === 'number', 'result should have line number');
      assert.ok(r.line > 0, 'line number should be positive');
      assert.ok(r.match, 'result should have match text');
    }
  });
});
