/**
 * Real models for the integration tests, fetched once and cached, never committed.
 *
 * 3DBenchy (CreativeTools/3DBenchy on GitHub, Single-part/3DBenchy.stl) is in the public domain
 * under CC0 since 14 February 2025 (NTI Group, with its creator). It is 11 MB, so it is downloaded
 * instead of kept in the repository, and pinned by its SHA-256 so every run slices the same mesh.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const BENCHY = {
  name: "3DBenchy.stl",
  url: "https://raw.githubusercontent.com/CreativeTools/3DBenchy/master/Single-part/3DBenchy.stl",
  sha256: "6ab57f1c3f8e86bc3cbd302c6fa6270acf06277c6335454e922419c25d42e97e",
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

/**
 * The path of the cached 3DBenchy, downloading it when it is not there. Returns a reason instead
 * when it cannot be had (offline); a file with another hash is an error, not a skip.
 */
export async function benchy(): Promise<{ path: string } | { skip: string }> {
  const dir = cacheDir();
  const path = join(dir, BENCHY.name);
  if (existsSync(path)) {
    const hash = sha256(await readFile(path));
    if (hash === BENCHY.sha256) return { path };
    throw new Error(`${path} has SHA-256 ${hash}, expected ${BENCHY.sha256}. Delete it to download it again.`);
  }
  let data: Buffer;
  try {
    const response = await fetch(BENCHY.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) return { skip: `3DBenchy download failed: HTTP ${response.status}` };
    data = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return { skip: `3DBenchy could not be downloaded (${error instanceof Error ? error.message : String(error)})` };
  }
  const hash = sha256(data);
  if (hash !== BENCHY.sha256) throw new Error(`The downloaded 3DBenchy has SHA-256 ${hash}, expected ${BENCHY.sha256}.`);
  await mkdir(dir, { recursive: true });
  await writeFile(`${path}.part`, data);
  await rename(`${path}.part`, path);
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
  let layer: number | null = null;
  let lifted = 0;
  for (const line of gcode.split("\n")) {
    if (line.startsWith(";Z:")) {
      layer = Number(line.slice(3));
      continue;
    }
    if (layer === null || !line.startsWith("G1 ")) continue;
    const z = / Z(-?[\d.]+)/.exec(line);
    if (z && Number(z[1]) - layer > 0.001) lifted++;
  }
  return lifted;
}
