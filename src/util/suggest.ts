/**
 * Closest names for a mistyped preset. Models drop or reorder the "@COREONE HF0.4" suffixes,
 * so the score combines shared words with edit distance.
 */
export function suggest(query: string, candidates: Iterable<string>, limit = 5): string[] {
  const q = normalize(query);
  const qTokens = new Set(tokens(q));
  const scored: Array<{ name: string; score: number }> = [];
  for (const name of new Set(candidates)) {
    const n = normalize(name);
    const nTokens = tokens(n);
    const shared = nTokens.filter((token) => qTokens.has(token)).length;
    const overlap = shared / Math.max(qTokens.size, nTokens.length, 1);
    const distance = levenshtein(q, n) / Math.max(q.length, n.length, 1);
    const contains = n.includes(q) || q.includes(n) ? 0.3 : 0;
    scored.push({ name, score: overlap + contains + (1 - distance) * 0.5 });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.name);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokens(text: string): string[] {
  return text.split(/[^a-z0-9.]+/).filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}
