// Exhaustive stress test and validation for Zoekt-integrated grep service
const BASE = 'http://127.0.0.1:3848';
const results = { pass: 0, fail: 0, tests: [] };

function log(msg) { console.log(msg); }
function section(title) { log(`\n${'='.repeat(60)}\n  ${title}\n${'='.repeat(60)}`); }

async function query(endpoint, params = {}) {
  const url = `${BASE}${endpoint}?${new URLSearchParams(params)}`;
  const start = performance.now();
  const resp = await fetch(url);
  const data = await resp.json();
  const ms = performance.now() - start;
  return { data, ms, status: resp.status };
}

function record(category, name, passed, ms, detail = '') {
  results.tests.push({ category, name, passed, ms: Math.round(ms), detail });
  if (passed) results.pass++; else results.fail++;
  const icon = passed ? 'PASS' : '** FAIL **';
  const d = detail ? ` — ${detail}` : '';
  log(`  [${icon}] ${name} (${Math.round(ms)}ms)${d}`);
}

// ================================================================
// 1. HEALTH & AVAILABILITY
// ================================================================
async function testHealth() {
  section('1. Health & Availability');

  const { data, ms } = await query('/health');
  record('health', 'Health endpoint responds', data.status === 'ok', ms);

  // Zoekt status in health
  const hasZoekt = data.zoekt && typeof data.zoekt === 'object';
  record('health', 'Health includes Zoekt status', hasZoekt, 0,
    hasZoekt ? `available=${data.zoekt.available}, indexing=${data.zoekt.indexing}, port=${data.zoekt.port}` : 'missing');
  if (hasZoekt) {
    record('health', 'Zoekt is available', data.zoekt.available === true, 0);
  }

  const { data: stats, ms: ms2 } = await query('/stats');
  record('health', 'Stats endpoint responds', !!stats && !stats.error, ms2,
    `${stats.totalFiles || '?'} files`);

  const { data: status, ms: ms3 } = await query('/status');
  record('health', 'Status endpoint responds', !!status && !status.error, ms3);
}

// ================================================================
// 2. LITERAL SEARCHES
// ================================================================
async function testLiteralSearches() {
  section('2. Literal Searches');

  const cases = [
    { name: 'Common identifier (AActor)', params: { pattern: 'AActor', maxResults: 20 }, expectMin: 5 },
    { name: 'Function name (BeginPlay)', params: { pattern: 'BeginPlay', maxResults: 20 }, expectMin: 5 },
    { name: 'Macro (UPROPERTY)', params: { pattern: 'UPROPERTY', maxResults: 20 }, expectMin: 5 },
    { name: 'Rare identifier (FGameplayAbilitySpec)', params: { pattern: 'FGameplayAbilitySpec', maxResults: 20 }, expectMin: 1 },
    { name: 'Very common (return)', params: { pattern: 'return', maxResults: 10 }, expectMin: 5 },
    { name: 'Include directive (#include)', params: { pattern: '#include', maxResults: 10 }, expectMin: 5 },
    { name: 'Semicolon literal (;)', params: { pattern: ';', maxResults: 5 }, expectMin: 1 },
    { name: 'Angle bracket cast (Cast<AActor>)', params: { pattern: 'Cast<AActor>', maxResults: 10 }, expectMin: 1 },
    { name: 'Namespace (UE::)', params: { pattern: 'UE::', maxResults: 10 }, expectMin: 1 },
    { name: 'Long identifier (GetAbilitySystemComponent)', params: { pattern: 'GetAbilitySystemComponent', maxResults: 10 }, expectMin: 1 },
    { name: 'No results expected (xyzzy_nonexistent_identifier_42)', params: { pattern: 'xyzzy_nonexistent_identifier_42', maxResults: 5 }, expectMin: 0, expectMax: 0 },
  ];

  for (const c of cases) {
    const { data, ms, status } = await query('/grep', c.params);
    const count = data.results?.length || 0;
    const minOk = count >= (c.expectMin || 0);
    const maxOk = c.expectMax === undefined || count <= c.expectMax;
    const engineOk = data.searchEngine === 'zoekt';
    const passed = status === 200 && minOk && maxOk && engineOk;
    record('literal', c.name, passed, ms,
      `${count} results, engine=${data.searchEngine}, zoekt=${data.zoektDurationMs}ms`);
  }
}

// ================================================================
// 3. REGEX SEARCHES
// ================================================================
async function testRegexSearches() {
  section('3. Regex Searches');

  const cases = [
    { name: 'Wildcard (void.*BeginPlay)', params: { pattern: 'void.*BeginPlay', maxResults: 10 }, expectMin: 1 },
    { name: 'Character class (class\\s+\\w+Component)', params: { pattern: 'class\\s+\\w+Component', maxResults: 10 }, expectMin: 1 },
    { name: 'Alternation ((float|int)\\s+\\w+Speed)', params: { pattern: '(float|int)\\s+\\w+Speed', maxResults: 10 }, expectMin: 1 },
    { name: 'Anchored (^#include)', params: { pattern: '^#include', maxResults: 10 }, expectMin: 1 },
    { name: 'Quantifier (UFUNCTION\\(.*BlueprintCallable)', params: { pattern: 'UFUNCTION\\(.*BlueprintCallable', maxResults: 10 }, expectMin: 1 },
    { name: 'Negated class ([^a-z]Actor[^a-z])', params: { pattern: '[^a-z]Actor[^a-z]', maxResults: 10 }, expectMin: 1 },
    { name: 'Optional (colou?r)', params: { pattern: 'colou?r', maxResults: 10 }, expectMin: 1 },
    { name: 'Repetition (/{2,})', params: { pattern: '/{2,}', maxResults: 10 }, expectMin: 1 },
    { name: 'Dot-star greedy (virtual.*override)', params: { pattern: 'virtual.*override', maxResults: 10 }, expectMin: 1 },
  ];

  for (const c of cases) {
    const { data, ms, status } = await query('/grep', c.params);
    const count = data.results?.length || 0;
    const passed = status === 200 && count >= c.expectMin && data.searchEngine === 'zoekt';
    record('regex', c.name, passed, ms,
      `${count} results, zoekt=${data.zoektDurationMs}ms`);
  }

  // Invalid regex should return 400
  const { data: badData, ms: badMs, status: badStatus } = await query('/grep', { pattern: '(unclosed' });
  record('regex', 'Invalid regex returns 400', badStatus === 400, badMs, badData.error || '');
}

// ================================================================
// 4. FILTERS (project, language, case sensitivity)
// ================================================================
async function testFilters() {
  section('4. Filters');

  // Project filter
  const { data: disc, ms: ms1 } = await query('/grep', { pattern: 'FVector', project: 'Discovery', maxResults: 10 });
  const allDisc = (disc.results || []).every(r => r.project === 'Discovery' || r.file?.startsWith('Discovery/'));
  record('filter', 'Project: Discovery only', allDisc && disc.results?.length > 0, ms1,
    `${disc.results?.length} results`);

  const { data: eng, ms: ms2 } = await query('/grep', { pattern: 'FVector', project: 'Engine', maxResults: 10 });
  const allEng = (eng.results || []).every(r => r.project === 'Engine' || r.file?.startsWith('Engine/'));
  record('filter', 'Project: Engine only', allEng && eng.results?.length > 0, ms2,
    `${eng.results?.length} results`);

  // Language filter
  const { data: cpp, ms: ms3 } = await query('/grep', { pattern: 'UPROPERTY', language: 'cpp', maxResults: 10 });
  const allCpp = (cpp.results || []).every(r => r.language === 'cpp');
  record('filter', 'Language: cpp only', allCpp && cpp.results?.length > 0, ms3,
    `${cpp.results?.length} results`);

  const { data: as, ms: ms4 } = await query('/grep', { pattern: 'UPROPERTY', language: 'angelscript', maxResults: 10 });
  const allAs = (as.results || []).every(r => r.language === 'angelscript');
  record('filter', 'Language: angelscript only', allAs && as.results?.length > 0, ms4,
    `${as.results?.length} results`);

  // Case sensitivity
  const { data: csOn, ms: ms5 } = await query('/grep', { pattern: 'beginplay', caseSensitive: 'true', maxResults: 10 });
  const { data: csOff, ms: ms6 } = await query('/grep', { pattern: 'beginplay', caseSensitive: 'false', maxResults: 10 });
  record('filter', 'Case sensitive: lowercase "beginplay"', csOn.results?.length >= 0, ms5,
    `${csOn.results?.length} results (case sensitive)`);
  record('filter', 'Case insensitive: "beginplay"', (csOff.results?.length || 0) > (csOn.results?.length || 0), ms6,
    `${csOff.results?.length} results (case insensitive, should be more)`);

  // Bad project
  const { data: badProj, ms: ms7, status: st7 } = await query('/grep', { pattern: 'test', project: 'NonExistentProject_XYZ' });
  record('filter', 'Unknown project returns 400', st7 === 400, ms7, badProj.error || '');
}

// ================================================================
// 5. CONTEXT LINES
// ================================================================
async function testContextLines() {
  section('5. Context Lines');

  for (const ctx of [0, 1, 2, 3, 5]) {
    const { data, ms } = await query('/grep', { pattern: 'BeginPlay', contextLines: ctx, maxResults: 3 });
    const hasContext = ctx === 0 ? true : (data.results || []).some(r => r.context && r.context.length > 0);
    record('context', `Context lines = ${ctx}`, data.results?.length > 0 && (ctx === 0 || hasContext), ms,
      `${data.results?.length} results, first has ${data.results?.[0]?.context?.length || 0} context lines`);
  }
}

// ================================================================
// 6. RESULT FORMAT VALIDATION
// ================================================================
async function testResultFormat() {
  section('6. Result Format Validation');

  const { data, ms } = await query('/grep', { pattern: 'BeginPlay', maxResults: 5, contextLines: 2 });

  // Check top-level fields
  const hasFields = 'results' in data && 'totalMatches' in data && 'searchEngine' in data && 'zoektDurationMs' in data;
  record('format', 'Response has required top-level fields', hasFields, ms,
    `keys: ${Object.keys(data).join(', ')}`);

  // Check result item fields
  if (data.results?.length > 0) {
    const r = data.results[0];
    const hasResultFields = 'file' in r && 'line' in r && 'match' in r && 'project' in r && 'language' in r;
    record('format', 'Result item has required fields', hasResultFields, 0,
      `keys: ${Object.keys(r).join(', ')}`);

    // file should be a relative path (no absolute paths leaked)
    const noAbsPath = !r.file.includes(':\\') && !r.file.startsWith('/mnt/') && !r.file.startsWith('/home/');
    record('format', 'File paths are relative (no absolute paths)', noAbsPath, 0, r.file);

    // line should be a positive integer
    record('format', 'Line number is positive integer', Number.isInteger(r.line) && r.line > 0, 0, `line=${r.line}`);

    // match should be a readable string (not base64)
    const isReadable = typeof r.match === 'string' && !r.match.includes('\u0000') && r.match.length > 0;
    record('format', 'Match is readable string (not base64)', isReadable, 0, `"${r.match.slice(0, 80)}"`);

    // context lines should be readable
    if (r.context && r.context.length > 0) {
      const ctxReadable = r.context.every(c => typeof c === 'string');
      record('format', 'Context lines are readable strings', ctxReadable, 0,
        `${r.context.length} lines, first: "${(r.context[0] || '').slice(0, 60)}"`);
    }
  }

  // Asset results format
  if (data.assets?.length > 0) {
    const a = data.assets[0];
    record('format', 'Asset result has required fields', 'file' in a && 'match' in a, 0,
      `asset: ${a.file}`);
  }
}

// ================================================================
// 7. ASSET SEARCH VALIDATION
// ================================================================
async function testAssetSearch() {
  section('7. Asset Search');

  // Patterns likely to match assets
  const cases = [
    { name: 'Asset: Blueprint keyword', params: { pattern: 'Blueprint', maxResults: 10 } },
    { name: 'Asset: Actor keyword', params: { pattern: 'Actor', maxResults: 10 } },
    { name: 'Asset: Material keyword', params: { pattern: 'Material', maxResults: 10 } },
  ];

  for (const c of cases) {
    const { data, ms } = await query('/grep', c.params);
    const assetCount = data.assets?.length || 0;
    record('asset', c.name, data.results?.length >= 0, ms,
      `source=${data.results?.length}, assets=${assetCount}`);
  }

  // Asset deduplication: each asset should appear only once
  const { data: dedupData, ms: dedupMs } = await query('/grep', { pattern: 'Blueprint', maxResults: 50 });
  if (dedupData.assets?.length > 0) {
    const assetFiles = dedupData.assets.map(a => a.file);
    const uniqueFiles = new Set(assetFiles);
    record('asset', 'Assets are deduplicated (no duplicate files)', uniqueFiles.size === assetFiles.length, dedupMs,
      `${assetFiles.length} results, ${uniqueFiles.size} unique files`);

    // Check matchedFields is set
    const hasMatchedFields = dedupData.assets.some(a => a.matchedFields && a.matchedFields >= 1);
    record('asset', 'Assets have matchedFields count', hasMatchedFields, 0,
      dedupData.assets[0]?.matchedFields ? `first asset: matchedFields=${dedupData.assets[0].matchedFields}` : 'missing');
  }
}

// ================================================================
// 7b. RESULT RANKING VALIDATION
// ================================================================
async function testResultRanking() {
  section('7b. Result Ranking');

  // Search for a common term and verify that .h files are ranked higher than .cpp
  const { data, ms } = await query('/grep', { pattern: 'AActor', maxResults: 50, caseSensitive: 'true' });
  if (data.results?.length >= 10) {
    const top10 = data.results.slice(0, 10);
    const bottom10 = data.results.slice(-10);
    const topHeaders = top10.filter(r => r.file.endsWith('.h') || r.file.endsWith('.hpp')).length;
    const bottomHeaders = bottom10.filter(r => r.file.endsWith('.h') || r.file.endsWith('.hpp')).length;
    record('ranking', 'Header files ranked higher than implementation', topHeaders >= bottomHeaders, ms,
      `top10 headers=${topHeaders}, bottom10 headers=${bottomHeaders}`);

    // Verify results with more matches per file appear first
    const fileCounts = new Map();
    for (const r of data.results) {
      fileCounts.set(r.file, (fileCounts.get(r.file) || 0) + 1);
    }
    if (fileCounts.size >= 2) {
      const firstFileCount = fileCounts.get(data.results[0].file) || 0;
      const lastFileCount = fileCounts.get(data.results[data.results.length - 1].file) || 0;
      record('ranking', 'Higher match density files ranked first', firstFileCount >= lastFileCount, 0,
        `first file: ${firstFileCount} matches, last file: ${lastFileCount} matches`);
    }
  } else {
    record('ranking', 'Header files ranked higher (insufficient results)', false, ms, `only ${data.results?.length} results`);
  }
}

// ================================================================
// 7c. WEB UI VALIDATION
// ================================================================
async function testWebUI() {
  section('7c. Web UI');

  try {
    const resp = await fetch(`${BASE}/`);
    const html = await resp.text();
    const hasTitle = html.includes('Unreal Index Search');
    const hasSearchInput = html.includes('id="pattern"');
    const hasScript = html.includes('doSearch');
    record('webui', 'Web UI serves at /', resp.status === 200, 0, `${html.length} bytes`);
    record('webui', 'Web UI has search elements', hasTitle && hasSearchInput && hasScript, 0);
  } catch (err) {
    record('webui', 'Web UI accessible', false, 0, err.message);
  }
}

// ================================================================
// 8. CONCURRENT LOAD TEST
// ================================================================
async function testConcurrentLoad() {
  section('8. Concurrent Load Test');

  const patterns = ['AActor', 'BeginPlay', 'FVector', 'UPROPERTY', 'void.*BeginPlay',
    'USceneComponent', 'FString', 'TArray', 'GetWorld', 'IsValid'];

  // 10 concurrent requests
  const start10 = performance.now();
  const concurrent10 = await Promise.all(
    patterns.map(p => query('/grep', { pattern: p, maxResults: 5 }))
  );
  const time10 = performance.now() - start10;
  const all10Ok = concurrent10.every(r => r.status === 200 && r.data.results?.length >= 0);
  const max10 = Math.max(...concurrent10.map(r => r.ms));
  const min10 = Math.min(...concurrent10.map(r => r.ms));
  const avg10 = concurrent10.reduce((s, r) => s + r.ms, 0) / concurrent10.length;
  record('concurrent', '10 concurrent queries', all10Ok, time10,
    `wall=${Math.round(time10)}ms, avg=${Math.round(avg10)}ms, min=${Math.round(min10)}ms, max=${Math.round(max10)}ms`);

  // 20 concurrent requests (same patterns x2)
  const start20 = performance.now();
  const concurrent20 = await Promise.all(
    [...patterns, ...patterns].map(p => query('/grep', { pattern: p, maxResults: 5 }))
  );
  const time20 = performance.now() - start20;
  const all20Ok = concurrent20.every(r => r.status === 200 && r.data.results?.length >= 0);
  const max20 = Math.max(...concurrent20.map(r => r.ms));
  const avg20 = concurrent20.reduce((s, r) => s + r.ms, 0) / concurrent20.length;
  record('concurrent', '20 concurrent queries', all20Ok, time20,
    `wall=${Math.round(time20)}ms, avg=${Math.round(avg20)}ms, max=${Math.round(max20)}ms`);

  // 5 concurrent heavy regex queries
  const heavyPatterns = ['void.*BeginPlay', 'class\\s+\\w+Component', '(float|int)\\s+\\w+Speed',
    'virtual.*override', 'UFUNCTION\\(.*BlueprintCallable'];
  const startHeavy = performance.now();
  const concurrentHeavy = await Promise.all(
    heavyPatterns.map(p => query('/grep', { pattern: p, maxResults: 10 }))
  );
  const timeHeavy = performance.now() - startHeavy;
  const allHeavyOk = concurrentHeavy.every(r => r.status === 200);
  const maxHeavy = Math.max(...concurrentHeavy.map(r => r.ms));
  record('concurrent', '5 concurrent heavy regex', allHeavyOk, timeHeavy,
    `wall=${Math.round(timeHeavy)}ms, max=${Math.round(maxHeavy)}ms`);
}

// ================================================================
// 9. SEQUENTIAL LATENCY (warmup, sustained, p95)
// ================================================================
async function testSequentialLatency() {
  section('9. Sequential Latency Profiling');

  // Warmup: 3 throwaway requests
  for (let i = 0; i < 3; i++) await query('/grep', { pattern: 'AActor', maxResults: 5 });

  // 20 sequential requests — measure distribution
  const patterns = ['AActor', 'BeginPlay', 'FVector', 'UPROPERTY', 'return',
    'void.*BeginPlay', 'GetWorld', 'TArray', 'UObject', 'FName',
    'AActor', 'Cast<', 'nullptr', 'IsValid', 'Super::',
    'virtual', '#include', 'UCLASS', 'USTRUCT', 'UENUM'];

  const times = [];
  const zoektTimes = [];
  for (const p of patterns) {
    const { data, ms } = await query('/grep', { pattern: p, maxResults: 10 });
    times.push(ms);
    zoektTimes.push(data.zoektDurationMs || 0);
  }

  times.sort((a, b) => a - b);
  zoektTimes.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const p99 = times[times.length - 1];
  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  const zAvg = zoektTimes.reduce((s, t) => s + t, 0) / zoektTimes.length;
  const zP95 = zoektTimes[Math.floor(zoektTimes.length * 0.95)];

  record('latency', 'p50 total latency', p50 < 2000, p50, `${Math.round(p50)}ms`);
  record('latency', 'p95 total latency', p95 < 3000, p95, `${Math.round(p95)}ms`);
  record('latency', 'p99/max total latency', p99 < 5000, p99, `${Math.round(p99)}ms`);
  record('latency', 'Average total latency', true, avg, `${Math.round(avg)}ms`);
  record('latency', 'Zoekt avg query time', zAvg < 100, zAvg, `${Math.round(zAvg)}ms`);
  record('latency', 'Zoekt p95 query time', zP95 < 500, zP95, `${Math.round(zP95)}ms`);

  return { times, zoektTimes, p50, p95, p99, avg, zAvg, zP95 };
}

// ================================================================
// 10. STABILITY — rapid-fire queries
// ================================================================
async function testStability() {
  section('10. Stability — 50 Rapid-Fire Sequential Queries');

  const patterns = ['AActor', 'BeginPlay', 'FVector', 'UPROPERTY', 'return',
    'void.*BeginPlay', 'FString', 'TArray', 'IsValid', 'GetWorld'];

  let errors = 0;
  let totalMs = 0;
  const times = [];
  for (let i = 0; i < 50; i++) {
    const p = patterns[i % patterns.length];
    try {
      const { data, ms, status } = await query('/grep', { pattern: p, maxResults: 5 });
      if (status !== 200 || !data.results) errors++;
      times.push(ms);
      totalMs += ms;
    } catch (e) {
      errors++;
      times.push(0);
    }
  }

  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)];

  record('stability', '50 rapid-fire queries', errors === 0, totalMs,
    `${errors} errors, total=${Math.round(totalMs)}ms, p50=${Math.round(p50)}ms, p95=${Math.round(p95)}ms`);

  // Check server health after barrage
  const { data: health, ms: hMs } = await query('/health');
  record('stability', 'Health check after barrage', health.status === 'ok', hMs,
    `heap=${health.memoryMB?.heapUsed}MB, rss=${health.memoryMB?.rss}MB`);

  return { errors, times };
}

// ================================================================
// 11. OTHER ENDPOINTS (non-grep structural queries)
// ================================================================
async function testStructuralQueries() {
  section('11. Structural Query Endpoints');

  const { data: ft, ms: ms1 } = await query('/find-type', { name: 'AActor', maxResults: 5 });
  record('structural', 'find-type AActor', ft.results?.length > 0, ms1, `${ft.results?.length} results`);

  const { data: ft2, ms: ms2 } = await query('/find-type', { name: 'Actor', fuzzy: 'true', maxResults: 10 });
  record('structural', 'find-type fuzzy "Actor"', ft2.results?.length > 0, ms2, `${ft2.results?.length} results`);

  const { data: fc, ms: ms3 } = await query('/find-children', { parent: 'AActor', maxResults: 10 });
  record('structural', 'find-children of AActor', fc.children?.length > 0 || fc.results?.length > 0, ms3,
    `${fc.children?.length || fc.results?.length || 0} children`);

  const { data: fm, ms: ms4 } = await query('/find-member', { name: 'BeginPlay', maxResults: 10 });
  record('structural', 'find-member BeginPlay', fm.results?.length > 0, ms4, `${fm.results?.length} results`);

  const { data: ff, ms: ms5 } = await query('/find-file', { filename: 'Actor.h', maxResults: 5 });
  record('structural', 'find-file Actor.h', ff.results?.length > 0, ms5, `${ff.results?.length} results`);

  const { data: lm, ms: ms6 } = await query('/list-modules', { depth: 1 });
  record('structural', 'list-modules depth=1', lm.results?.length > 0, ms6, `${lm.results?.length} modules`);

  const { data: bm, ms: ms7 } = await query('/browse-module', { module: 'Engine' });
  record('structural', 'browse-module Engine', bm.types?.length > 0 || bm.results?.length > 0, ms7);

  const { data: fa, ms: ms8 } = await query('/find-asset', { name: 'PlayerCharacter', maxResults: 5 });
  record('structural', 'find-asset PlayerCharacter', fa.results?.length >= 0, ms8, `${fa.results?.length} results`);
}

// ================================================================
// REPORT
// ================================================================
function printReport(latencyData, stabilityData) {
  section('PERFORMANCE & STABILITY REPORT');

  log('\n--- Test Summary ---');
  log(`  Total tests:  ${results.pass + results.fail}`);
  log(`  Passed:       ${results.pass}`);
  log(`  Failed:       ${results.fail}`);

  // Group by category
  const categories = {};
  for (const t of results.tests) {
    if (!categories[t.category]) categories[t.category] = { pass: 0, fail: 0, tests: [] };
    categories[t.category].tests.push(t);
    if (t.passed) categories[t.category].pass++; else categories[t.category].fail++;
  }

  log('\n--- Results by Category ---');
  for (const [cat, data] of Object.entries(categories)) {
    const status = data.fail === 0 ? 'ALL PASS' : `${data.fail} FAILED`;
    log(`  ${cat.padEnd(15)} ${data.pass}/${data.pass + data.fail} (${status})`);
  }

  if (latencyData) {
    log('\n--- Latency Distribution (20 sequential queries) ---');
    log(`  Zoekt query:    avg=${Math.round(latencyData.zAvg)}ms, p95=${Math.round(latencyData.zP95)}ms`);
    log(`  Total endpoint: avg=${Math.round(latencyData.avg)}ms, p50=${Math.round(latencyData.p50)}ms, p95=${Math.round(latencyData.p95)}ms, max=${Math.round(latencyData.p99)}ms`);
  }

  if (stabilityData) {
    const stab = stabilityData.times;
    stab.sort((a, b) => a - b);
    log('\n--- Stability (50 rapid-fire queries) ---');
    log(`  Errors:   ${stabilityData.errors}`);
    log(`  p50:      ${Math.round(stab[Math.floor(stab.length * 0.5)])}ms`);
    log(`  p95:      ${Math.round(stab[Math.floor(stab.length * 0.95)])}ms`);
    log(`  max:      ${Math.round(stab[stab.length - 1])}ms`);
    log(`  total:    ${Math.round(stab.reduce((s, t) => s + t, 0))}ms`);
  }

  // List failures
  const failures = results.tests.filter(t => !t.passed);
  if (failures.length > 0) {
    log('\n--- FAILURES ---');
    for (const f of failures) {
      log(`  [FAIL] ${f.category}/${f.name}: ${f.detail}`);
    }
  }

  log('\n--- Bottleneck Analysis ---');
  // Find slowest tests
  const sorted = [...results.tests].sort((a, b) => b.ms - a.ms);
  log('  Slowest 5 operations:');
  for (const t of sorted.slice(0, 5)) {
    log(`    ${Math.round(t.ms).toString().padStart(6)}ms  ${t.category}/${t.name}`);
  }

  log('');
}

// ================================================================
// RUN ALL
// ================================================================
try {
  await testHealth();
  await testLiteralSearches();
  await testRegexSearches();
  await testFilters();
  await testContextLines();
  await testResultFormat();
  await testAssetSearch();
  await testResultRanking();
  await testWebUI();
  await testConcurrentLoad();
  const latencyData = await testSequentialLatency();
  const stabilityData = await testStability();
  await testStructuralQueries();
  printReport(latencyData, stabilityData);
} catch (err) {
  console.error('FATAL:', err);
  process.exit(1);
}
