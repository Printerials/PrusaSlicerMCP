/**
 * A vendor bundle's index (<Vendor>.idx), as PrusaSlicer 2.x and 3.0 write it:
 *
 *   min_slic3r_version = 2.9.6
 *   2.5.16 Updated FW version notification.
 *   max_slic3r_version = 2.9.5
 *   2.5.10 ...
 *
 * Newest first. A min_ or max_slic3r_version line holds for the versions below it until another
 * line of the same kind replaces it.
 */

export interface IndexEntry {
  version: string;
  minSlicer: string | null;
  maxSlicer: string | null;
  comment: string;
}

export function parseBundleIndex(text: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  let minSlicer: string | null = null;
  let maxSlicer: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const bound = /^(min|max)_slic3r_version\s*=\s*(\S+)/.exec(line);
    if (bound) {
      if (bound[1] === "min") minSlicer = bound[2]!;
      else maxSlicer = bound[2]!;
      continue;
    }
    const entry = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*(.*)$/.exec(line);
    if (entry) entries.push({ version: entry[1]!, minSlicer, maxSlicer, comment: entry[2]! });
  }
  return entries;
}

/** -1, 0 or 1. A pre-release sorts before its release; "alpha14" after "alpha2". */
export function compareVersions(a: string, b: string): number {
  const [coreA = "", preA] = splitVersion(a);
  const [coreB = "", preB] = splitVersion(b);
  const numbersA = coreA.split(".").map(Number);
  const numbersB = coreB.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (numbersA[i] ?? 0) - (numbersB[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (preA === undefined || preB === undefined) return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const partsA = preA.match(/\d+|\D+/g) ?? [];
  const partsB = preB.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i];
    const y = partsB[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const difference = numeric ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function splitVersion(version: string): [string, string | undefined] {
  const dash = version.indexOf("-");
  return dash === -1 ? [version, undefined] : [version.slice(0, dash), version.slice(dash + 1)];
}

/** The newest bundle version the given PrusaSlicer version may use, or null. */
export function newestFor(entries: IndexEntry[], slicerVersion: string): IndexEntry | null {
  let best: IndexEntry | null = null;
  for (const entry of entries) {
    if (entry.minSlicer && compareVersions(slicerVersion, entry.minSlicer) < 0) continue;
    if (entry.maxSlicer && compareVersions(slicerVersion, entry.maxSlicer) > 0) continue;
    if (!best || compareVersions(entry.version, best.version) > 0) best = entry;
  }
  return best;
}
