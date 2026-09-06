// Typo-tolerant matching used for "did you mean" suggestions (no deps).

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return Infinity;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[n];
}

export function fuzzyMatch(typed: string, candidate: string): boolean {
  if (candidate.includes(typed)) return true;
  return levenshtein(typed, candidate) <= Math.max(1, Math.floor(candidate.length / 3));
}

// Closest candidates for a typo'd name, best (lowest distance) first.
export function suggest(typed: string, candidates: string[]): string[] {
  const lower = String(typed || "").toLowerCase();
  if (!lower) return [];
  return candidates
    .map((c) => ({ c, lower: String(c).toLowerCase() }))
    .filter(({ lower: cl }) => fuzzyMatch(lower, cl))
    .sort((x, y) => levenshtein(lower, x.lower) - levenshtein(lower, y.lower))
    .map(({ c }) => c);
}
