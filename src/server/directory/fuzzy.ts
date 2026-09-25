/**
 * Levenshtein edit distance for typo-tolerant matching.
 *
 * Real pilot showed "Munbai - goregaon" failing the substring match because
 * "Munbai" isn't a substring of any directory entry. One missing char
 * shouldn't kill the dispatch path. This module provides the helper.
 *
 * For tokens of length ≥ 4, we accept a Levenshtein distance of up to 2.
 * Shorter tokens are too prone to false positives (3 chars × distance 2 =
 * any short word matches anything).
 */

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Two-row DP for memory efficiency.
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(
        prev[j] + 1, // deletion
        cur[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/**
 * Check whether `query` matches `target` within an acceptable edit
 * distance, given their lengths. Conservative thresholds:
 *   - lengths < 4: exact match only
 *   - lengths 4-6: distance ≤ 1
 *   - lengths ≥ 7: distance ≤ 2
 */
export function fuzzyEqual(query: string, target: string): boolean {
  if (query === target) return true;
  const len = Math.max(query.length, target.length);
  if (len < 4) return false;
  const threshold = len < 7 ? 1 : 2;
  return levenshtein(query, target) <= threshold;
}
