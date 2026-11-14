/**
 * Parser for `--info`: one "[file]" section per input, with PrusaSlicer's own mesh statistics.
 *
 *   [cube.stl]
 *   size_x = 20.000000
 *   manifold = yes
 *   number_of_parts =  1
 *   volume = 8000.000488
 */

export interface ModelInfo {
  file: string;
  size: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  volume?: number;
  facets?: number;
  parts?: number;
  manifold?: boolean;
  /** Repair statistics and anything else PrusaSlicer reports, as written. */
  other: Record<string, string>;
}

const AXES = ["x", "y", "z"] as const;
const KNOWN = new Set(["volume", "number_of_facets", "number_of_parts", "manifold"]);

export function parseInfo(text: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  let current: Map<string, string> | null = null;
  let file = "";

  const flush = () => {
    if (!current) return;
    const num = (key: string) => {
      const value = current!.get(key);
      return value === undefined ? undefined : Number(value);
    };
    const triple = (prefix: string) => AXES.map((axis) => round(num(`${prefix}_${axis}`) ?? 0)) as [number, number, number];
    const other: Record<string, string> = {};
    for (const [key, value] of current) {
      if (!KNOWN.has(key) && !/^(size|min|max)_[xyz]$/.test(key)) other[key] = value;
    }
    const volume = num("volume");
    models.push({
      file,
      size: triple("size"),
      min: triple("min"),
      max: triple("max"),
      volume: volume === undefined ? undefined : round(volume, 2),
      facets: num("number_of_facets"),
      parts: num("number_of_parts"),
      manifold: current.has("manifold") ? current.get("manifold") === "yes" : undefined,
      other,
    });
  };

  for (const line of text.split(/\r?\n/)) {
    const header = /^\[(.+)\]$/.exec(line.trim());
    if (header) {
      flush();
      file = header[1]!;
      current = new Map();
      continue;
    }
    const entry = /^([a-z_]+)\s*=\s*(.*?)\s*$/.exec(line.trim());
    if (entry && current) current.set(entry[1]!, entry[2]!);
  }
  flush();
  return models;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
