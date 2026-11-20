/**
 * Real models and profiles for the integration tests, fetched once and cached, never committed.
 *
 * 3DBenchy (CreativeTools/3DBenchy on GitHub, Single-part/3DBenchy.stl) is in the public domain
 * under CC0 since 14 February 2025 (NTI Group, with its creator). It is 11 MB, so it is downloaded
 * instead of kept in the repository, and pinned by its SHA-256 so every run slices the same mesh.
 *
 * The PrusaResearch bundle 2.5.16 is what PrusaSlicer 2.9.6 and later update to (the newest for
 * 2.9.7 on 2026-11-20); 2.9.7 itself ships 2.4.14. It comes from Prusa's profile repository on
 * GitHub, pinned by commit and SHA-256.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface Download {
  /** What it is called in messages. */
  title: string;
  name: string;
  url: string;
  sha256: string;
}

const BENCHY: Download = {
  title: "3DBenchy",
  name: "3DBenchy.stl",
  url: "https://raw.githubusercontent.com/CreativeTools/3DBenchy/master/Single-part/3DBenchy.stl",
  sha256: "6ab57f1c3f8e86bc3cbd302c6fa6270acf06277c6335454e922419c25d42e97e",
};

export const PRUSA_BUNDLE_2X = {
  version: "2.5.16",
  /** Its index entry: min_slic3r_version = 2.9.6. */
  minSlicer: "2.9.6",
  bundle: {
    title: "PrusaResearch bundle 2.5.16",
    name: "PrusaResearch-2.5.16.ini",
    url: "https://raw.githubusercontent.com/prusa3d/PrusaSlicer-settings-prusa-fff/0f0548d5fa09add2c105136c4d421205767d98ee/PrusaResearch/2.5.16.ini",
    sha256: "b15dbe25bd1822dfc60419132297d22fc28ade4158066775ce8f7106d0d16546",
  } satisfies Download,
  /** The index at that commit, newest 2.5.16: what the GUI would have downloaded. */
  index: {
    title: "PrusaResearch index at 2.5.16",
    name: "PrusaResearch-2.5.16.idx",
    url: "https://raw.githubusercontent.com/prusa3d/PrusaSlicer-settings-prusa-fff/0f0548d5fa09add2c105136c4d421205767d98ee/PrusaResearch/index.idx",
    sha256: "b9cd78ef4fdf03d9f104da12f6d6672d670886defcb9a62df5348425e082c87e",
  } satisfies Download,
};

function cacheDir(): string {
  if (process.env.PRUSASLICER_MCP_TEST_CACHE) return process.env.PRUSASLICER_MCP_TEST_CACHE;
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : process.platform === "win32"
        ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
        : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "PrusaSlicerMCP", "test-models");
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** The path of the cached 3DBenchy, downloading it when it is not there. */
export function benchy(): Promise<{ path: string } | { skip: string }> {
  return cached(BENCHY);
}

/**
 * The path of a cached download, fetching it when it is not there. Returns a reason instead when
 * it cannot be had (offline); a file with another hash is an error, not a skip.
 */
export async function cached(file: Download): Promise<{ path: string } | { skip: string }> {
  const dir = cacheDir();
  const path = join(dir, file.name);
  if (existsSync(path)) {
    const hash = sha256(await readFile(path));
    if (hash === file.sha256) return { path };
    throw new Error(`${path} has SHA-256 ${hash}, expected ${file.sha256}. Delete it to download it again.`);
  }
  let data: Buffer;
  try {
    const response = await fetch(file.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) return { skip: `${file.title} download failed: HTTP ${response.status}` };
    data = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return { skip: `${file.title} could not be downloaded (${error instanceof Error ? error.message : String(error)})` };
  }
  const hash = sha256(data);
  if (hash !== file.sha256) throw new Error(`The downloaded ${file.title} has SHA-256 ${hash}, expected ${file.sha256}.`);
  await mkdir(dir, { recursive: true });
  // The test files run in parallel and may fetch the same file at once: each writes its own part,
  // and the rename, atomic, leaves one whole file either way.
  const part = `${path}.${process.pid}-${randomUUID()}.part`;
  await writeFile(part, data);
  await rename(part, path);
  return { path };
}

/** A copy of a binary STL moved by dx, dy (mm). */
export async function movedStl(source: string, target: string, dx: number, dy: number): Promise<void> {
  const data = Buffer.from(await readFile(source));
  const count = data.readUInt32LE(80);
  if (data.length !== 84 + count * 50) throw new Error(`${source} is not a binary STL`);
  for (let facet = 0; facet < count; facet++) {
    for (let vertex = 0; vertex < 3; vertex++) {
      const at = 84 + facet * 50 + 12 + vertex * 12;
      data.writeFloatLE(data.readFloatLE(at) + dx, at);
      data.writeFloatLE(data.readFloatLE(at + 4) + dy, at + 4);
    }
  }
  await writeFile(target, data);
}

/**
 * Moves that end above the current layer's height in ASCII G-code (";Z:" comments): travel lifts,
 * ramped or not. The G-code header is no judge of lifting in 3.0.0-alpha14.
 */
export function liftedMoves(gcode: string): number {
  return [...lifts(gcode).values()].reduce((sum, count) => sum + count, 0);
}

/** Lifted moves by height above the layer, in mm rounded to 0.01. */
export function lifts(gcode: string): Map<number, number> {
  let layer: number | null = null;
  const heights = new Map<number, number>();
  for (const line of gcode.split("\n")) {
    if (line.startsWith(";Z:")) {
      layer = Number(line.slice(3));
      continue;
    }
    if (layer === null || !line.startsWith("G1 ")) continue;
    const z = / Z(-?[\d.]+)/.exec(line);
    if (!z || Number(z[1]) - layer <= 0.001) continue;
    const height = Math.round((Number(z[1]) - layer) * 100) / 100;
    heights.set(height, (heights.get(height) ?? 0) + 1);
  }
  return heights;
}
