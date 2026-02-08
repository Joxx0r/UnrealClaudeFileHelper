#!/usr/bin/env node

// Unit tests for web UI enhancements (issue #18)
// Tests: ZoektClient connection pooling, API static file serving

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ZoektClient } from './service/zoekt-client.js';
import { rankResults } from './service/search-ranking.js';

// ============================================================
// ZoektClient Connection Pooling
// ============================================================
describe('ZoektClient connection pooling', () => {
  it('should create dispatcher (undici Agent) in constructor', () => {
    const client = new ZoektClient(9999);
    assert.ok(client.dispatcher, 'dispatcher should be set');
    assert.ok(typeof client.dispatcher.dispatch === 'function', 'dispatcher should have dispatch method');
  });

  it('should set default timeout', () => {
    const client = new ZoektClient(9999);
    assert.equal(client.timeoutMs, 10000);
  });

  it('should allow custom timeout', () => {
    const client = new ZoektClient(9999, { timeoutMs: 5000 });
    assert.equal(client.timeoutMs, 5000);
  });

  it('should set correct base URL', () => {
    const client = new ZoektClient(6070);
    assert.equal(client.baseUrl, 'http://127.0.0.1:6070');
  });
});

// ============================================================
// ZoektClient query building
// ============================================================
describe('ZoektClient query building', () => {
  let client;

  before(() => {
    client = new ZoektClient(9999);
  });

  it('should build case-sensitive query', () => {
    const q = client._buildQuery('FooBar', { caseSensitive: true });
    assert.ok(q.includes('case:yes'), 'should include case:yes');
    assert.ok(q.includes('FooBar'), 'should include pattern');
  });

  it('should build case-insensitive query', () => {
    const q = client._buildQuery('foobar', { caseSensitive: false });
    assert.ok(q.includes('case:no'), 'should include case:no');
  });

  it('should add language filter', () => {
    const q = client._buildQuery('test', { caseSensitive: true, language: 'cpp' });
    assert.ok(q.includes('file:'), 'should have file filter');
    // Language filter uses regex pattern like \\.(cpp|h|hpp|cc|inl)$
    assert.ok(q.includes('cpp') && q.includes('h'), 'should filter for cpp extensions');
  });

  it('should exclude assets when requested', () => {
    const q = client._buildQuery('test', { caseSensitive: true, excludeAssets: true });
    assert.ok(q.includes('-file:^_assets/'), 'should exclude _assets/');
  });

  it('should add project filter', () => {
    const q = client._buildQuery('test', { caseSensitive: true, project: 'MyProject' });
    assert.ok(q.includes('repo:^MyProject$'), 'should filter by project repo');
  });

  it('should detect regex metacharacters', () => {
    assert.equal(client._hasRegexMeta('FooBar'), false);
    assert.equal(client._hasRegexMeta('Foo.*Bar'), true);
    assert.equal(client._hasRegexMeta('Foo|Bar'), true);
    assert.equal(client._hasRegexMeta('Foo\\|Bar'), false, 'escaped pipe should not count');
    assert.equal(client._hasRegexMeta('(group)'), true);
    assert.equal(client._hasRegexMeta('[class]'), true);
    assert.equal(client._hasRegexMeta('simple_name'), false);
  });

  it('should use regex: prefix for regex patterns', () => {
    const q = client._buildQuery('Foo.*Bar', { caseSensitive: true });
    assert.ok(q.includes('regex:Foo.*Bar'), 'should have regex: prefix');
  });

  it('should not use regex: prefix for literal patterns', () => {
    const q = client._buildQuery('FooBar', { caseSensitive: true });
    assert.ok(!q.includes('regex:'), 'should not have regex: prefix');
  });
});

// ============================================================
// ZoektClient response mapping
// ============================================================
describe('ZoektClient response mapping', () => {
  let client;

  before(() => {
    client = new ZoektClient(9999);
  });

  it('should map empty response', () => {
    const result = client._mapResponse({ Result: { Files: [], Stats: {} } }, 5);
    assert.equal(result.results.length, 0);
    assert.equal(result.searchEngine, 'zoekt');
    assert.equal(result.zoektDurationMs, 5);
  });

  it('should map files with line matches', () => {
    const data = {
      Result: {
        Files: [{
          FileName: 'MyProject/src/Actor.cpp',
          LineMatches: [{
            LineNumber: 9,
            Line: Buffer.from('class AActor : public UObject').toString('base64')
          }]
        }],
        Stats: { MatchCount: 1, FileCount: 1, FilesConsidered: 100 }
      }
    };
    const result = client._mapResponse(data, 3);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].file, 'MyProject/src/Actor.cpp');
    assert.equal(result.results[0].project, 'MyProject');
    assert.equal(result.results[0].language, 'cpp');
    assert.equal(result.results[0].line, 10); // 0-based -> 1-based
    assert.ok(result.results[0].match.includes('AActor'));
    assert.equal(result.totalMatches, 1);
    assert.equal(result.matchedFiles, 1);
  });

  it('should decode base64 context lines', () => {
    const before = Buffer.from('line1\nline2').toString('base64');
    const after = Buffer.from('line3\nline4').toString('base64');
    const data = {
      Result: {
        Files: [{
          FileName: 'test/file.as',
          LineMatches: [{
            LineNumber: 5,
            Line: Buffer.from('matched line').toString('base64'),
            Before: before,
            After: after
          }]
        }],
        Stats: {}
      }
    };
    const result = client._mapResponse(data, 2);
    assert.ok(result.results[0].context, 'should have context');
    assert.ok(result.results[0].context.length >= 2, 'should have context lines');
  });

  it('should infer language from extension', () => {
    assert.equal(client._inferLanguage('foo/bar.as'), 'angelscript');
    assert.equal(client._inferLanguage('foo/bar.cpp'), 'cpp');
    assert.equal(client._inferLanguage('foo/bar.h'), 'cpp');
    assert.equal(client._inferLanguage('foo/bar.ini'), 'config');
    assert.equal(client._inferLanguage('foo/bar.xyz'), 'unknown');
  });

  it('should infer project from first path segment', () => {
    assert.equal(client._inferProject('MyProject/Source/file.cpp'), 'MyProject');
    assert.equal(client._inferProject('singlefile.cpp'), '');
  });

  it('should rank header files higher via rankResults', () => {
    // Ranking happens in search-ranking.js, not in _mapResponse
    const results = [
      { file: 'Proj/Source/Actor.cpp', project: 'Proj', language: 'cpp', line: 1, match: 'match' },
      { file: 'Proj/Source/Actor.h', project: 'Proj', language: 'cpp', line: 1, match: 'match' }
    ];
    const ranked = rankResults(results, new Map());
    assert.equal(ranked[0].file, 'Proj/Source/Actor.h', 'header file should rank first');
  });
});
