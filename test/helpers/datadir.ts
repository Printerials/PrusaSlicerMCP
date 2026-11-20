/**
 * The data directory the integration tests run on. By default a fresh one in the test's own
 * temporary directory, so the tests do not depend on how PrusaSlicer is set up on this machine and
 * run the same on one where it was never started:
 * - 3.x fills an empty data directory itself from the bundles it ships (3.0.0-alpha14, measured
 *   2026-11-20: presets/local, shared_runtime and the rest appear on the first call).
 * - 2.x does not. With an empty one every call fails with "Configuration wasn't found" and exit 0.
 *   It needs a vendor bundle in vendor/ and a model enabled in PrusaSlicer.ini (2.9.7, measured
 *   2026-11-20); filaments that are not listed there still slice from the CLI. The bundle is the
 *   one an updated 2.9 has (PrusaResearch 2.5.16, pinned, see models.ts), or, offline, the older
 *   one PrusaSlicer ships (2.4.14 in 2.9.7), which prints a 3DBenchy with 6 % more filament.
 *
 * PRUSASLICER_TEST_DATADIR=user runs on PrusaSlicer's own data directory instead. The tests only
 * read it; the ones that change a data directory work on a copy.
 */
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseHelp } from "../../src/formats/help.ts";
import { compareVersions } from "../../src/slicer/bundle-index.ts";
import { slicerCommand, type LocatedBinary } from "../../src/slicer/locate.ts";
import { cached, PRUSA_BUNDLE_2X } from "./models.ts";

/**
 * The version as the server reads it, from --help: 2.9.7 has no --version (it says "Unknown
 * option" and prints the help), and 3.0 prints its version where it likes.
 */
export function versionOf(located: LocatedBinary): string {
  const command = slicerCommand(located, ["--help"]);
  const result = spawnSync(command.file, command.args, { encoding: "utf8", timeout: 60_000, env: { ...process.env, SLIC3R_LOGLEVEL: "0" } });
  try {
    return parseHelp(`${result.stdout ?? ""}${result.stderr ?? ""}`).version;
  } catch {
    return "";
  }
}

/** What the 2.x data directory enables: a CORE One HF0.4, which every suite slices with. */
const V2_PRINTER = "Prusa CORE One HF0.4 nozzle";
const V2_PRINT = "0.20mm SPEED @COREONE HF0.4";
const V2_FILAMENTS = [
  "Prusament PLA @COREONE HF0.4",
  "Generic PLA @COREONE HF0.4",
  "Prusament PETG @COREONE HF0.4",
  "Generic PETG @COREONE HF0.4",
  // Overrides the travel lift in its filament profile; the Benchy suite needs that.
  "Buddy3D PETG @COREONE HF0.4",
];

export function usesOwnDatadir(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PRUSASLICER_TEST_DATADIR !== "user";
}

export interface TestDatadir {
  /** PRUSASLICER_DATADIR pointing at a fresh data directory, or nothing with PRUSASLICER_TEST_DATADIR=user. */
  env: Record<string, string>;
  /** "PrusaResearch 2.5.16 (pinned)", "PrusaResearch 2.4.14 (shipped with PrusaSlicer, offline)"; null for 3.x and the user's own. */
  profiles: string | null;
}

export async function testDatadirEnv(located: LocatedBinary, version: string, parent: string): Promise<TestDatadir> {
  if (!usesOwnDatadir()) return { env: {}, profiles: null };
  const datadir = join(parent, `datadir-${version.replace(/[^0-9A-Za-z.-]/g, "_")}`);
  await mkdir(datadir, { recursive: true });
  const profiles = /^3\./.test(version) ? null : await seedV2(datadir, located, version);
  return { env: { PRUSASLICER_DATADIR: datadir }, profiles };
}

async function seedV2(datadir: string, located: LocatedBinary, version: string): Promise<string> {
  const shipped = bundledProfiles(located);
  if (!shipped) throw new Error(`The profiles PrusaSlicer ships were not found next to ${located.path}; set PRUSASLICER_TEST_DATADIR=user.`);
  await mkdir(join(datadir, "vendor"), { recursive: true });
  await mkdir(join(datadir, "cache"), { recursive: true });
  let bundle = join(shipped, "PrusaResearch.ini");
  let index = join(shipped, "PrusaResearch.idx");
  let profiles = "PrusaResearch, shipped with PrusaSlicer";
  if (compareVersions(version, PRUSA_BUNDLE_2X.minSlicer) >= 0) {
    const pinnedBundle = await cached(PRUSA_BUNDLE_2X.bundle);
    const pinnedIndex = await cached(PRUSA_BUNDLE_2X.index);
    if ("path" in pinnedBundle && "path" in pinnedIndex) {
      bundle = pinnedBundle.path;
      index = pinnedIndex.path;
      profiles = `PrusaResearch ${PRUSA_BUNDLE_2X.version} (pinned)`;
    } else {
      profiles += ` (${"skip" in pinnedBundle ? pinnedBundle.skip : (pinnedIndex as { skip: string }).skip})`;
    }
  }
  await copyFile(bundle, join(datadir, "vendor", "PrusaResearch.ini"));
  await copyFile(index, join(datadir, "vendor", "PrusaResearch.idx"));
  // The index the GUI would have downloaded, for update_profiles to compare against.
  await copyFile(index, join(datadir, "cache", "PrusaResearch.idx"));
  await writeFile(
    join(datadir, "PrusaSlicer.ini"),
    [
      "[filaments]",
      ...V2_FILAMENTS.map((name) => `${name} = 1`),
      "",
      "[presets]",
      `filament = ${V2_FILAMENTS[0]}`,
      `print = ${V2_PRINT}`,
      `printer = ${V2_PRINTER}`,
      "",
      "[vendor:PrusaResearch]",
      "model:COREONE = HF0.4",
      "",
    ].join("\n"),
  );
  return profiles;
}

/** The profiles the located PrusaSlicer ships: in the .app on macOS, in the Flatpak's /app, next to the binary elsewhere. */
function bundledProfiles(located: LocatedBinary): string | null {
  const candidates = located.flatpak
    ? [join(located.flatpak.files, "share", "PrusaSlicer", "profiles")]
    : located.appBundle
      ? [join(located.appBundle, "Contents", "Resources", "profiles")]
      : [join(dirname(located.path), "resources", "profiles"), join(dirname(located.path), "..", "share", "PrusaSlicer", "profiles")];
  return candidates.find((dir) => existsSync(join(dir, "PrusaResearch.ini"))) ?? null;
}
