#!/usr/bin/env node

/**
 * Comprehensive stress test for the query worker pool and parallelism.
 * Tests: basic routes, parallel speedup, health responsiveness, concurrent grep,
 * high concurrency bursts, sustained load, /summary caching, mixed workloads.
 */

const BASE_URL = 'http://127.0.0.1:3847';

async function fetchJson(path) {
  const resp = await fetch(`${BASE_URL}${path}`);
  return { status: resp.status, data: await resp.json() };
}

async function timedFetch(path) {
  const start = performance.now();
  const result = await fetchJson(path);
  return { ...result, ms: performance.now() - start };
}

async function runTest(name, fn) {
  try {
    const result = await fn();
    console.log(`  PASS: ${name}`);
    return { name, passed: true, ...result };
  } catch (err) {
    console.log(`  FAIL: ${name} — ${err.message}`);
    return { name, passed: false, error: err.message };
  }
}

async function main() {
  console.log('=== Comprehensive Parallelism Stress Test ===\n');

  // Check service is running
  try {
    const { status } = await fetchJson('/health');
    if (status !== 200) throw new Error('Service not healthy');
  } catch {
    console.error('Service not running at port 3847. Start with: npm start');
    process.exit(1);
  }

  const results = [];

  // ======================================================================
  // TEST 1: Basic route functionality
  // ======================================================================
  console.log('1. Basic route functionality:');
  const routes = [
    '/health',
    '/stats',
    '/summary',
    '/find-type?name=AActor&language=cpp',
    '/find-type?name=Widget&fuzzy=true&maxResults=5',
    '/find-children?parent=AActor&maxResults=3',
    '/find-member?name=BeginPlay&fuzzy=true&maxResults=5',
    '/browse-module?module=Engine&maxResults=5',
    '/find-file?filename=Actor.h&maxResults=3',
    '/list-modules?depth=1',
    '/find-asset?name=BP_&fuzzy=true&maxResults=3',
    '/grep?pattern=GetHealth&maxResults=5',
    '/grep?pattern=BeginPlay&maxResults=5',
    '/grep?pattern=UPROPERTY&maxResults=5',
  ];

  for (const route of routes) {
    results.push(await runTest(route, async () => {
      const { status, data } = await fetchJson(route);
      if (status !== 200) throw new Error(`Status ${status}: ${JSON.stringify(data).slice(0, 100)}`);
      return {};
    }));
  }

  // ======================================================================
  // TEST 2: Grep results correctness
  // ======================================================================
  console.log('\n2. Grep results correctness:');
  results.push(await runTest('grep returns actual matches', async () => {
    const { status, data } = await fetchJson('/grep?pattern=BeginPlay&maxResults=10');
    if (status !== 200) throw new Error(`Status ${status}`);
    if (!data.results || data.results.length === 0) throw new Error('No grep results returned');
    // Verify result structure
    const r = data.results[0];
    if (!r.file || !r.line || !r.match) throw new Error('Missing fields in grep result');
    if (!r.match.includes('BeginPlay')) throw new Error(`Match doesn't contain pattern: ${r.match}`);
    console.log(`    Found ${data.results.length} matches across ${data.filesSearched} files`);
    return {};
  }));

  results.push(await runTest('grep respects maxResults', async () => {
    const { data: d3 } = await fetchJson('/grep?pattern=void&maxResults=3');
    const { data: d10 } = await fetchJson('/grep?pattern=void&maxResults=10');
    if (d3.results.length > 3) throw new Error(`maxResults=3 returned ${d3.results.length}`);
    if (d10.results.length > 10) throw new Error(`maxResults=10 returned ${d10.results.length}`);
    return {};
  }));

  results.push(await runTest('grep with project filter', async () => {
    const { status, data } = await fetchJson('/grep?pattern=UCLASS&project=Engine&maxResults=5');
    if (status !== 200) throw new Error(`Status ${status}`);
    for (const r of data.results) {
      if (r.project !== 'Engine') throw new Error(`Result from wrong project: ${r.project}`);
    }
    return {};
  }));

  results.push(await runTest('grep case insensitive', async () => {
    const { data } = await fetchJson('/grep?pattern=beginplay&caseSensitive=false&maxResults=5');
    if (data.results.length === 0) throw new Error('No case-insensitive matches found');
    return {};
  }));

  // ======================================================================
  // TEST 3: /summary caching
  // ======================================================================
  console.log('\n3. /summary caching:');
  results.push(await runTest('/summary is fast (cached)', async () => {
    // Warm up
    await fetchJson('/summary');
    // Measure
    const { ms } = await timedFetch('/summary');
    console.log(`    /summary responded in ${ms.toFixed(1)}ms`);
    if (ms > 50) throw new Error(`/summary took ${ms.toFixed(0)}ms, expected < 50ms (should use cache)`);
    return {};
  }));

  results.push(await runTest('/summary returns valid data', async () => {
    const { data } = await fetchJson('/summary');
    if (!data.stats) throw new Error('Missing stats');
    if (!data.projects || data.projects.length === 0) throw new Error('No projects');
    if (!data.languages || data.languages.length === 0) throw new Error('No languages');
    return {};
  }));

  // ======================================================================
  // TEST 4: Concurrent fuzzy queries — parallel speedup
  // ======================================================================
  console.log('\n4. Concurrent fuzzy queries (5 workers should give better speedup):');
  const fuzzyQueries = [
    '/find-type?name=GameState&fuzzy=true&maxResults=10',
    '/find-type?name=WidgetComponent&fuzzy=true&maxResults=10',
    '/find-type?name=PlayerController&fuzzy=true&maxResults=10',
    '/find-member?name=BeginPlay&fuzzy=true&maxResults=10',
    '/find-member?name=TakeDamage&fuzzy=true&maxResults=10',
    '/find-type?name=HealthComponent&fuzzy=true&maxResults=10',
    '/find-member?name=GetOwner&fuzzy=true&maxResults=10',
    '/find-type?name=CharacterMovement&fuzzy=true&maxResults=10',
  ];

  // Sequential
  let sequentialMs = 0;
  const seqTimes = [];
  for (const q of fuzzyQueries) {
    const { ms } = await timedFetch(q);
    sequentialMs += ms;
    seqTimes.push(ms.toFixed(0));
  }
  console.log(`  Sequential total: ${sequentialMs.toFixed(0)}ms (individual: ${seqTimes.join(', ')}ms)`);

  // Parallel
  const parallelStart = performance.now();
  const parallelResults = await Promise.all(fuzzyQueries.map(q => timedFetch(q)));
  const parallelMs = performance.now() - parallelStart;
  const parTimes = parallelResults.map(r => r.ms.toFixed(0));
  console.log(`  Parallel total:   ${parallelMs.toFixed(0)}ms (individual: ${parTimes.join(', ')}ms)`);

  const speedup = sequentialMs / parallelMs;
  console.log(`  Speedup: ${speedup.toFixed(1)}x`);

  results.push(await runTest('parallel speedup > 1.3x', async () => {
    if (speedup < 1.3) throw new Error(`Only ${speedup.toFixed(1)}x`);
    return {};
  }));

  results.push(await runTest('all parallel queries succeeded', async () => {
    const failures = parallelResults.filter(r => r.status !== 200);
    if (failures.length > 0) throw new Error(`${failures.length} queries failed`);
    return {};
  }));

  // ======================================================================
  // TEST 5: Concurrent grep — full pipeline offloaded to workers
  // ======================================================================
  console.log('\n5. Concurrent grep (full pipeline in workers):');

  // Sequential grep
  const grepQueries = [
    '/grep?pattern=BeginPlay&maxResults=10',
    '/grep?pattern=GetHealth&maxResults=10',
    '/grep?pattern=UPROPERTY&maxResults=10',
    '/grep?pattern=TakeDamage&maxResults=10',
    '/grep?pattern=UFUNCTION&maxResults=10',
  ];

  let grepSeqMs = 0;
  const grepSeqTimes = [];
  for (const q of grepQueries) {
    const { ms } = await timedFetch(q);
    grepSeqMs += ms;
    grepSeqTimes.push(ms.toFixed(0));
  }
  console.log(`  Sequential grep: ${grepSeqMs.toFixed(0)}ms (individual: ${grepSeqTimes.join(', ')}ms)`);

  // Parallel grep
  const grepParStart = performance.now();
  const grepParResults = await Promise.all(grepQueries.map(q => timedFetch(q)));
  const grepParMs = performance.now() - grepParStart;
  const grepParTimes = grepParResults.map(r => r.ms.toFixed(0));
  console.log(`  Parallel grep:   ${grepParMs.toFixed(0)}ms (individual: ${grepParTimes.join(', ')}ms)`);

  const grepSpeedup = grepSeqMs / grepParMs;
  console.log(`  Grep speedup: ${grepSpeedup.toFixed(1)}x`);

  results.push(await runTest('concurrent greps all succeed', async () => {
    const failures = grepParResults.filter(r => r.status !== 200);
    if (failures.length > 0) throw new Error(`${failures.length} grep queries failed`);
    return {};
  }));

  results.push(await runTest('concurrent greps return results', async () => {
    for (const r of grepParResults) {
      if (!r.data.results || r.data.results.length === 0) {
        throw new Error('Empty grep results in parallel run');
      }
    }
    return {};
  }));

  // ======================================================================
  // TEST 6: /health stays responsive during heavy load
  // ======================================================================
  console.log('\n6. Health responsiveness under heavy load:');
  results.push(await runTest('/health responds < 200ms during concurrent greps + queries', async () => {
    // Fire off heavy mixed workload
    const heavyQueries = [
      ...Array.from({ length: 4 }, (_, i) => fetchJson(`/find-type?name=Component${i}&fuzzy=true&maxResults=20`)),
      ...Array.from({ length: 3 }, (_, i) => fetchJson(`/grep?pattern=Pattern${i}&maxResults=10`)),
    ];

    await new Promise(r => setTimeout(r, 30));
    const healthStart = performance.now();
    const { status } = await fetchJson('/health');
    const healthMs = performance.now() - healthStart;

    await Promise.allSettled(heavyQueries);

    if (status !== 200) throw new Error(`Health status ${status}`);
    if (healthMs > 200) throw new Error(`Health took ${healthMs.toFixed(0)}ms`);
    console.log(`    /health responded in ${healthMs.toFixed(0)}ms`);
    return {};
  }));

  // ======================================================================
  // TEST 7: High concurrency burst — 30 simultaneous queries
  // ======================================================================
  console.log('\n7. High concurrency burst (30 simultaneous queries):');
  results.push(await runTest('30 concurrent queries complete successfully', async () => {
    const queries = [
      ...Array.from({ length: 6 }, (_, i) => `/find-type?name=Actor${i}&fuzzy=true&maxResults=5`),
      ...Array.from({ length: 6 }, (_, i) => `/find-member?name=Health${i}&fuzzy=true&maxResults=5`),
      ...Array.from({ length: 6 }, (_, i) => `/find-file?filename=Component${i}&maxResults=3`),
      ...Array.from({ length: 6 }, (_, i) => `/find-children?parent=AActor&maxResults=3`),
      ...Array.from({ length: 3 }, (_, i) => `/grep?pattern=UCLASS${i}&maxResults=5`),
      ...Array.from({ length: 3 }, (_, i) => `/browse-module?module=Engine&maxResults=5`),
    ];

    const start = performance.now();
    const allResults = await Promise.all(queries.map(q => timedFetch(q)));
    const elapsed = performance.now() - start;

    const failures = allResults.filter(r => r.status !== 200);
    if (failures.length > 0) throw new Error(`${failures.length}/${queries.length} failed`);

    const maxMs = Math.max(...allResults.map(r => r.ms));
    const avgMs = (allResults.reduce((s, r) => s + r.ms, 0) / allResults.length).toFixed(0);
    console.log(`    All ${queries.length} completed in ${elapsed.toFixed(0)}ms wall time (avg: ${avgMs}ms, max: ${maxMs.toFixed(0)}ms)`);
    return {};
  }));

  // ======================================================================
  // TEST 8: Sustained load — 200 queries
  // ======================================================================
  console.log('\n8. Sustained load (200 queries in batches of 10):');
  results.push(await runTest('200 queries with no errors', async () => {
    const queryTypes = [
      '/find-type?name=Actor&fuzzy=true&maxResults=3',
      '/find-member?name=Play&fuzzy=true&maxResults=3',
      '/find-file?filename=Widget&maxResults=3',
      '/find-children?parent=UObject&maxResults=3',
      '/browse-module?module=Engine&maxResults=5',
      '/grep?pattern=UPROPERTY&maxResults=3',
      '/grep?pattern=BeginPlay&maxResults=3',
      '/find-type?name=Component&fuzzy=true&maxResults=3',
      '/summary',
      '/stats',
    ];

    let errors = 0;
    let totalMs = 0;
    const TOTAL = 200;
    const BATCH = 10;

    for (let i = 0; i < TOTAL; i += BATCH) {
      const batch = Array.from({ length: BATCH }, (_, j) =>
        timedFetch(queryTypes[(i + j) % queryTypes.length])
      );
      const batchResults = await Promise.all(batch);
      errors += batchResults.filter(r => r.status !== 200).length;
      totalMs += batchResults.reduce((sum, r) => sum + r.ms, 0);
    }

    const avgMs = (totalMs / TOTAL).toFixed(0);
    console.log(`    ${TOTAL} queries: ${errors} errors, avg ${avgMs}ms per query`);

    if (errors > 0) throw new Error(`${errors} errors out of ${TOTAL} queries`);
    return {};
  }));

  // ======================================================================
  // TEST 9: Mixed workload simulation (realistic MCP agent pattern)
  // ======================================================================
  console.log('\n9. Mixed workload simulation (3 concurrent agents):');
  results.push(await runTest('3 agents making diverse queries simultaneously', async () => {
    // Simulate 3 agents each making a sequence of requests
    const agent1 = async () => {
      const results = [];
      results.push(await timedFetch('/find-type?name=ADiscoveryCharacter&fuzzy=true'));
      results.push(await timedFetch('/find-children?parent=ACharacter&maxResults=10'));
      results.push(await timedFetch('/find-member?name=MovementComponent&fuzzy=true'));
      results.push(await timedFetch('/grep?pattern=ADiscoveryCharacter&maxResults=5'));
      return results;
    };
    const agent2 = async () => {
      const results = [];
      results.push(await timedFetch('/find-type?name=UDiscoveryWidget&fuzzy=true'));
      results.push(await timedFetch('/browse-module?module=Discovery&maxResults=20'));
      results.push(await timedFetch('/find-file?filename=Widget&maxResults=5'));
      results.push(await timedFetch('/grep?pattern=UWidget&maxResults=5'));
      return results;
    };
    const agent3 = async () => {
      const results = [];
      results.push(await timedFetch('/find-type?name=FVector&language=cpp'));
      results.push(await timedFetch('/find-member?name=Normalize&fuzzy=true'));
      results.push(await timedFetch('/find-children?parent=UActorComponent&maxResults=10'));
      results.push(await timedFetch('/grep?pattern=FVector&maxResults=5'));
      return results;
    };

    const start = performance.now();
    const [r1, r2, r3] = await Promise.all([agent1(), agent2(), agent3()]);
    const elapsed = performance.now() - start;

    const allResults = [...r1, ...r2, ...r3];
    const failures = allResults.filter(r => r.status !== 200);
    if (failures.length > 0) throw new Error(`${failures.length}/12 queries failed`);

    const seqEstimate = allResults.reduce((s, r) => s + r.ms, 0);
    const agentSpeedup = seqEstimate / elapsed;
    console.log(`    12 queries across 3 agents in ${elapsed.toFixed(0)}ms wall time`);
    console.log(`    Sequential estimate: ${seqEstimate.toFixed(0)}ms, effective speedup: ${agentSpeedup.toFixed(1)}x`);
    return {};
  }));

  // ======================================================================
  // TEST 10: No main thread blocking during grep
  // ======================================================================
  console.log('\n10. Main thread non-blocking during grep:');
  results.push(await runTest('/health stays fast while grep runs', async () => {
    // Fire off a heavy grep (many matches)
    const grepPromise = timedFetch('/grep?pattern=void&maxResults=50');

    // Immediately check health multiple times
    const healthChecks = [];
    for (let i = 0; i < 5; i++) {
      healthChecks.push(timedFetch('/health'));
      await new Promise(r => setTimeout(r, 10));
    }

    const healthResults = await Promise.all(healthChecks);
    const grepResult = await grepPromise;

    const maxHealthMs = Math.max(...healthResults.map(r => r.ms));
    const avgHealthMs = (healthResults.reduce((s, r) => s + r.ms, 0) / healthResults.length).toFixed(0);

    console.log(`    Grep took ${grepResult.ms.toFixed(0)}ms`);
    console.log(`    5 health checks during grep: avg=${avgHealthMs}ms, max=${maxHealthMs.toFixed(0)}ms`);

    if (maxHealthMs > 200) throw new Error(`Health max was ${maxHealthMs.toFixed(0)}ms during grep`);
    return {};
  }));

  // ======================================================================
  // SUMMARY
  // ======================================================================
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`${passed} passed, ${failed} failed out of ${results.length} tests`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }

  console.log('\nAll tests passed!');
}

main().catch(err => {
  console.error('Stress test failed:', err);
  process.exit(1);
});
