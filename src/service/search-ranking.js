// Search result ranking and grouping helpers for grep results.
// Extracted for testability — no Express or database dependencies in pure functions.

const DEFINITION_PATTERNS = [
  /^\s*(class|struct|enum)\s+\w+/,                    // class/struct/enum definition
  /^\s*UCLASS\s*\(/,                                   // UE macros
  /^\s*USTRUCT\s*\(/,
  /^\s*UENUM\s*\(/,
  /^\s*UFUNCTION\s*\(/,
  /^\s*UPROPERTY\s*\(/,
  /^\s*UINTERFACE\s*\(/,
  /^\s*(virtual\s+)?(void|int|float|bool|double|auto|const\s+\w+&?|[\w:]+\*?)\s+\w+::\w+\s*\(/,  // Method implementation
  /^\s*(void|int|float|bool|double|auto|FString|FName|FVector|TArray|TMap)\s+\w+\s*\(/,            // Function definition
  /^\s*#define\s+\w+/,                                  // Macro definition
  /^\s*(mixin\s+)?class\s+\w+/,                        // AngelScript class
  /^\s*(event\s+|delegate\s+)?\w+\s+\w+\s*\(/,         // AngelScript event/delegate
];

/**
 * Check if a match line looks like a symbol definition (class, function, macro, etc.)
 */
export function isDefinitionLine(line) {
  if (!line) return false;
  // Skip comments
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return false;
  return DEFINITION_PATTERNS.some(p => p.test(line));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Score file recency based on mtime. Returns 0-10.
 * @param {number} mtime - File modification time in milliseconds
 * @param {number} [now] - Current time (for testing)
 */
export function recencyScore(mtime, now) {
  if (!mtime) return 0;
  now = now || Date.now();
  const ageDays = (now - mtime) / DAY_MS;
  if (ageDays < 1) return 10;
  if (ageDays < 7) return 8;
  if (ageDays < 30) return 5;
  if (ageDays < 90) return 3;
  return 1;
}

/**
 * Rank grep results using multiple signals.
 * Mutates and returns the results array (sorted in-place).
 *
 * @param {Array} results - Flat grep results [{file, project, language, line, match, context?}]
 * @param {Map<string, number>} mtimeMap - Map of file path -> mtime (from database)
 * @returns {Array} Same array, sorted by relevance
 */
export function rankResults(results, mtimeMap) {
  if (!results || results.length === 0) return results;

  const now = Date.now();

  // Compute per-file scores
  const fileMatchCount = new Map();
  for (const r of results) {
    fileMatchCount.set(r.file, (fileMatchCount.get(r.file) || 0) + 1);
  }

  const fileScores = new Map();
  for (const [file, count] of fileMatchCount) {
    let score = count; // Match density

    // Header / Public boost
    if (file.endsWith('.h') || file.endsWith('.hpp')) score += 5;
    if (file.includes('/Public/')) score += 3;

    // Recency boost
    const mtime = mtimeMap ? mtimeMap.get(file) : undefined;
    score += recencyScore(mtime, now);

    fileScores.set(file, score);
  }

  // Per-result scoring: file score + definition boost
  results.sort((a, b) => {
    const sa = (fileScores.get(a.file) || 0) + (isDefinitionLine(a.match) ? 8 : 0);
    const sb = (fileScores.get(b.file) || 0) + (isDefinitionLine(b.match) ? 8 : 0);
    return sb - sa || a.line - b.line;
  });

  return results;
}

/**
 * Group flat grep results by file.
 *
 * @param {Array} results - Flat grep results [{file, project, language, line, match, context?}]
 * @returns {Array} Grouped results [{file, project, language, matches: [{line, match, context?}]}]
 */
export function groupResultsByFile(results) {
  if (!results || results.length === 0) return [];

  const fileMap = new Map();
  for (const r of results) {
    if (!fileMap.has(r.file)) {
      fileMap.set(r.file, {
        file: r.file,
        project: r.project,
        language: r.language,
        matches: []
      });
    }
    const entry = { line: r.line, match: r.match };
    if (r.context) entry.context = r.context;
    fileMap.get(r.file).matches.push(entry);
  }

  return Array.from(fileMap.values())
    .sort((a, b) => b.matches.length - a.matches.length);
}
