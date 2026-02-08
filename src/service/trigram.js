import { createHash } from 'crypto';

/**
 * Encode three characters into a 24-bit integer trigram.
 */
export function encodeTrigram(c1, c2, c3) {
  return (c1 << 16) | (c2 << 8) | c3;
}

/**
 * Extract all unique trigrams from file content.
 * Content is lowercased before extraction (case-insensitive index).
 * Returns a Set of integer-encoded trigrams.
 */
export function extractTrigrams(content) {
  const lower = content.toLowerCase();
  const trigrams = new Set();
  const len = lower.length - 2;

  for (let i = 0; i < len; i++) {
    const c1 = lower.charCodeAt(i);
    const c2 = lower.charCodeAt(i + 1);
    const c3 = lower.charCodeAt(i + 2);

    // Skip trigrams containing newlines, carriage returns, or null bytes
    if (c1 === 10 || c1 === 13 || c1 === 0) continue;
    if (c2 === 10 || c2 === 13 || c2 === 0) continue;
    if (c3 === 10 || c3 === 13 || c3 === 0) continue;

    trigrams.add((c1 << 16) | (c2 << 8) | c3);
  }

  return trigrams;
}

/**
 * Compute a 64-bit content hash for change detection.
 * Uses the first 8 bytes of an MD5 hash, read as a BigInt.
 */
export function contentHash(content) {
  const hash = createHash('md5').update(content).digest();
  // Read first 8 bytes as a signed 64-bit integer (SQLite stores as INTEGER)
  return hash.readBigInt64LE(0);
}

