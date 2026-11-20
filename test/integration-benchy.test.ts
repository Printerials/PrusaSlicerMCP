/**
 * A real model through a real MCP client, for every PrusaSlicer this machine has: the located one
 * (PRUSASLICER_PATH or auto-detection) and, with PRUSASLICER_PATH_3, a 3.x next to it, after which
 * the two are compared on the same mesh. 3DBenchy is downloaded once and cached (see
 * helpers/models.ts). Writes only to a temporary directory.
 *
 * Measured 2026-11-19 on a CORE One with 0.15mm BALANCED and Prusament PLA: 2.9.7 11.12 g and
 * 52m35s, 3.0.0-alpha14 11.13 g and 52m41s, with the same travel lifts.
 */
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readBgcodeMetadata } from "../src/formats/bgcode.ts";
import { analyzeAsciiGcode } from "../src/formats/gcode-ascii.ts";
import { checkBgcode } from "../src/formats/gcode-thumbnails.ts";
import { encodePng, encodeQoi } from "../src/formats/image.ts";
import { ZipReader } from "../src/formats/zip.ts";
import { locateSlicer, type LocatedBinary } from "../src/slicer/locate.ts";
import { testDatadirEnv, versionOf } from "./helpers/datadir.ts";
import { decodePng, decodeQoi } from "./helpers/images.ts";
import { benchy, liftedMoves, lifts, movedStl } from "./helpers/models.ts";
import { writeZip } from "./helpers/zip.ts";

const root = join(import.meta.dirname, "..");
const CORE_ONE_THUMBNAILS = ["16x16/QOI", "313x173/QOI", "480x240/QOI", "380x285/PNG"];
type Thumb = { width: number; height: number; format: string };

interface Target {
  located: LocatedBinary;
  version: string;
  /** What the server gets to find this PrusaSlicer: PRUSASLICER_PATH as given, or nothing for the auto-detected one. */
  env: Record<string, string>;
}

const targets: Target[] = [];
for (const env of [process.env, process.env.PRUSASLICER_PATH_3 ? { PRUSASLICER_PATH: process.env.PRUSASLICER_PATH_3 } : null]) {
  if (!env) continue;
  const located = locateSlicer(env as NodeJS.ProcessEnv);
  if ("error" in located || targets.some((target) => target.located.path === located.path && target.located.flatpak?.id === located.flatpak?.id)) continue;
  const version = versionOf(located);
  if (version) targets.push({ located, version, env: env.PRUSASLICER_PATH ? { PRUSASLICER_PATH: env.PRUSASLICER_PATH } : {} });
}

const model = await benchy();
const skip = "skip" in model ? model.skip : targets.length === 0 ? "PrusaSlicer not found" : false;

/** What each version made of the same Benchy, for the comparison at the end. */
const sliced = new Map<string, { grams: number; seconds: number; lifts: number }>();
/** The profiles each version's data directory got (test/helpers/datadir.ts). */
const profilesUsed = new Map<string, string | null>();

for (const target of targets) {
  describe(`3DBenchy with PrusaSlicer ${target.version}`, { skip }, () => {
    let client: Client;
    let dir: string;
    let input: string;
    let presets: { printer: string; print: string; filament: string } | null = null;

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ type: string; text?: string }>).filter((part) => part.type === "text").map((part) => part.text).join("\n");
      let data: any = null;
      try {
        data = JSON.parse(text);
      } catch {
        // a refusal is plain text
      }
      return { isError: Boolean(result.isError), text, data };
    };

    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "prusaslicer-mcp-benchy-"));
      input = join(dir, "3DBenchy.stl");
      await copyFile((model as { path: string }).path, input);
      const datadir = await testDatadirEnv(target.located, target.version, dir);
      profilesUsed.set(target.version, datadir.profiles);
      client = new Client({ name: "integration-benchy", version: "0" });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [join(root, "src", "index.ts")],
          stderr: "ignore",
          cwd: root,
          env: { ...(process.env as Record<string, string>), ...target.env, ...datadir.env },
        }),
      );
    });

    after(async () => {
      await client?.close();
      await rm(dir, { recursive: true, force: true });
    });

    test("a CORE One with 0.15mm BALANCED and Prusament PLA", async (t) => {
      const status = await call("slicer_status");
      assert.equal(status.data.slicer.version, target.version);
      const printers = await call("list_printers");
      const names: string[] = printers.data.models.flatMap((m: any) => m.variants.flatMap((v: any) => v.presets.map((p: any) => p.name)));
      // 2.9: "Prusa CORE One HF0.4 nozzle"; 3.0: "Prusa CORE One & One+ 0.4 HF".
      const printer = names.find((name) => /^Prusa CORE One (HF0\.4 nozzle|& One\+ 0\.4 HF)$/.test(name));
      if (!printer) return t.skip("no CORE One 0.4 HF printer installed");
      const profiles = await call("list_profiles", { printer });
      const print = profiles.data.print_profiles.map((p: { name: string }) => p.name).find((name: string) => /^0\.15mm BALANCED/.test(name));
      const filament = (profiles.data.filament_profiles_for_all_prints as string[]).find((name) => /^Prusament PLA @/.test(name));
      if (!print || !filament) return t.skip("0.15mm BALANCED or Prusament PLA is not installed");
      presets = { printer, print, filament };
    });

    test("model_info: PrusaSlicer's own measurements", async () => {
      const info = await call("model_info", { inputs: [input] });
      assert.equal(info.isError, false, info.text);
      const [m] = info.data.models;
      assert.deepEqual(m.size.map((value: number) => Math.round(value * 10) / 10), [60, 31, 48]);
      assert.equal(m.manifold, true);
    });

    test("model_info of a Benchy lying at positive X and Y has the same size", async () => {
      // 3.0.0-alpha14's --info includes the origin: this one would come back 130 x 116 mm.
      const moved = join(dir, "moved.stl");
      await movedStl(input, moved, 100, 100);
      const info = await call("model_info", { inputs: [moved] });
      assert.equal(info.isError, false, info.text);
      const [m] = info.data.models;
      assert.deepEqual(m.size.slice(0, 2).map((value: number) => Math.round(value * 10) / 10), [60, 31]);
      assert.ok(Math.abs(m.min[0] - 70.824) < 0.01, `min_x ${m.min[0]}`);
    });

    test("slice with an override: bridges, lifts, and the override in the G-code", async (t) => {
      if (!presets) return t.skip("no presets");
      const output = join(dir, "benchy.gcode");
      const result = await call("slice", { inputs: [input], ...presets, gcode_format: "ascii", output, overrides: { thick_bridges: true } });
      assert.equal(result.isError, false, result.text);
      const report = result.data.result;
      assert.ok(report.filament.total_g > 9 && report.filament.total_g < 14, `${report.filament.total_g} g`);
      assert.ok(report.layers.count > 300, `${report.layers.count} layers`);
      assert.ok(report.features.some((feature: { type: string }) => feature.type === "Bridge infill"), "no bridge infill");
      if (result.data.overrides_confirmed) assert.deepEqual(result.data.overrides_confirmed, ["thick_bridges"]);
      const gcode = await readFile(output, "utf8");
      assert.match(gcode, /^; thick_bridges = 1$/m);
      const lifts = liftedMoves(gcode);
      assert.ok(lifts > 1000, `only ${lifts} lifted moves`);
      sliced.set(target.version, { grams: report.filament.total_g, seconds: report.time.normal_seconds, lifts });
      // The CORE One asks for 16x16/QOI, 313x173/QOI, 480x240/QOI, 380x285/PNG; the CLI draws none.
      assert.deepEqual(report.thumbnails.map((t: Thumb) => `${t.width}x${t.height}/${t.format.toUpperCase()}`), CORE_ONE_THUMBNAILS);
      assert.match(result.data.thumbnails, /drawn by this server/);
    });

    test("thumbnails: binary G-code, the image itself, and a 3MF's own thumbnail through PrusaSlicer", async (t) => {
      if (!presets) return t.skip("no presets");
      const binary = join(dir, "benchy.bgcode");
      const sliced = await call("slice", { inputs: [input], ...presets, gcode_format: "binary", output: binary });
      assert.equal(sliced.isError, false, sliced.text);
      assert.deepEqual(sliced.data.result.thumbnails.map((t: Thumb) => `${t.width}x${t.height}/${t.format.toUpperCase()}`), CORE_ONE_THUMBNAILS);
      assert.equal(await checkBgcode(binary), null);
      const meta = await readBgcodeMetadata(binary);
      const png = decodePng(meta.thumbnails.find((thumb) => thumb.format === "png")!.data);
      assert.deepEqual([png.width, png.height], [380, 285]);
      const opaque = png.pixels.filter((_, i) => i % 4 === 3 && png.pixels[i] === 255).length;
      assert.ok(opaque > 0.15 * 380 * 285 && opaque < 0.85 * 380 * 285, `${opaque} opaque pixels: the boat should fill part of the image`);
      assert.equal(png.pixels[3], 0, "the background is transparent");

      // A 3MF that holds Metadata/thumbnail.png: PrusaSlicer embeds that one itself, as QOI and PNG.
      const geometry = join(dir, "benchy-geometry.3mf");
      // 2.9 keeps a 3MF's positions when slicing (no arranging), and this mesh lies around the origin.
      const exported = await call("export_model", { inputs: [input], format: "3mf", output: geometry, transforms: { center: [125, 110] } });
      assert.equal(exported.isError, false, exported.text);
      const zip = await ZipReader.open(geometry);
      const files: Record<string, Buffer> = {};
      try {
        for (const name of zip.entries.keys()) files[name] = (await zip.read(name))!;
      } finally {
        await zip.close();
      }
      files["Metadata/thumbnail.png"] = encodePng(png);
      const withThumbnail = join(dir, "benchy-thumbnail.3mf");
      await writeZip(withThumbnail, files);
      const fromProject = await call("slice", { inputs: [withThumbnail], ...presets, gcode_format: "ascii", output: join(dir, "benchy-3mf.gcode") });
      assert.equal(fromProject.isError, false, fromProject.text);
      assert.match(fromProject.data.thumbnails, /embedded by PrusaSlicer/);
      const own = await analyzeAsciiGcode(join(dir, "benchy-3mf.gcode"));
      assert.deepEqual(own.thumbnails.map((thumb) => `${thumb.width}x${thumb.height}/${thumb.format.toUpperCase()}`), CORE_ONE_THUMBNAILS);
      // PrusaSlicer's QOI of these sizes, decoded and encoded again here, gives the same bytes.
      for (const thumb of own.thumbnails.filter((thumb) => thumb.format === "qoi")) {
        assert.deepEqual(encodeQoi(decodeQoi(thumb.data)), thumb.data, `QOI ${thumb.width}x${thumb.height}`);
      }
    });

    test("several inputs: refused without merge; merged on 3.x, a clear crash report on 2.9", async (t) => {
      if (!presets) return t.skip("no presets");
      const a = join(dir, "a.stl");
      const b = join(dir, "b.stl");
      await copyFile(join(root, "test", "fixtures", "cube.stl"), a);
      await copyFile(join(root, "test", "fixtures", "cube.stl"), b);
      const unmerged = await call("slice", { inputs: [a, b], ...presets, output: join(dir, "two.gcode") });
      assert.equal(unmerged.isError, true);
      assert.match(unmerged.text, /one call each/);
      const merged = await call("slice", { inputs: [a, b], ...presets, gcode_format: "ascii", output: join(dir, "merged.gcode"), transforms: { merge: true } });
      if (target.version.startsWith("2.")) {
        // 2.9.7 exits on SIGSEGV with --merge, even with one file (measured 2026-11-20).
        assert.equal(merged.isError, true);
        assert.match(merged.text, /crashes on --merge/);
        return;
      }
      assert.equal(merged.isError, false, merged.text);
      assert.match(merged.data.thumbnails, /drawn by this server/);
      const single = await call("slice", { inputs: [a], ...presets, gcode_format: "ascii", output: join(dir, "single.gcode") });
      assert.equal(single.isError, false, single.text);
      const ratio = merged.data.result.filament.total_g / single.data.result.filament.total_g;
      assert.ok(ratio > 1.8 && ratio < 2.2, `two cubes use ${ratio.toFixed(2)} times one cube's filament`);
    });

    test("lift settings reach the G-code past the filament's own overrides", async (t) => {
      if (!presets) return t.skip("no presets");
      // Buddy3D PETG overrides the travel lift settings in its filament profile (ramping lift on),
      // and that override wins over the print setting: the server has to set both.
      const profiles = await call("list_profiles", { printer: presets.printer });
      const buddy = (profiles.data.filament_profiles_for_all_prints as string[]).find((name) => /^Buddy3D PETG ?@/.test(name));
      if (!buddy) return t.skip("Buddy3D PETG is not installed");
      const share04 = (gcode: string) => {
        const heights = lifts(gcode);
        const total = [...heights.values()].reduce((sum, count) => sum + count, 0);
        return (heights.get(0.4) ?? 0) / total;
      };
      const plain = join(dir, "buddy.gcode");
      const viaPrint = await call("slice", { inputs: [input], ...presets, filament: buddy, gcode_format: "ascii", output: plain, overrides: { travel_ramping_lift: false, retract_lift: 0.4 } });
      assert.equal(viaPrint.isError, false, viaPrint.text);
      assert.ok((viaPrint.data.messages ?? []).some((line: string) => /travel_ramping_lift: the filament profile overrides it/.test(line)), JSON.stringify(viaPrint.data.messages));
      assert.ok(share04(await readFile(plain, "utf8")) > 0.95, "the lifts are not 0.4 mm: the filament's ramping lift won");
      const named = join(dir, "buddy-filament-keys.gcode");
      const viaFilament = await call("slice", {
        inputs: [input], ...presets, filament: buddy, gcode_format: "ascii", output: named,
        overrides: { filament_travel_ramping_lift: false, filament_retract_lift: 0.4 },
      });
      assert.equal(viaFilament.isError, false, viaFilament.text);
      assert.ok(share04(await readFile(named, "utf8")) > 0.95, "filament_* overrides did not reach the G-code");
    });

    test("stability_check: 3.x reports PrusaSlicer's own finding, 2.x refuses", async (t) => {
      if (!presets) return t.skip("no presets");
      const result = await call("slice", { inputs: [input], ...presets, gcode_format: "ascii", output: join(dir, "stability.gcode"), stability_check: true });
      if (target.version.startsWith("2.")) {
        assert.equal(result.isError, true);
        assert.match(result.text, /needs PrusaSlicer 3\.x/);
        return;
      }
      assert.equal(result.isError, false, result.text);
      // 3.0.0-alpha14 flags a 3DBenchy (code 7, StabilityIssues); not compared with what its GUI says.
      assert.equal(result.data.stability.issues_found, true);
    });

    test("postprocess_gcode: a pause at layer 50", async (t) => {
      if (!sliced.has(target.version)) return t.skip("not sliced");
      const result = await call("postprocess_gcode", { path: join(dir, "benchy.gcode"), inserts: [{ layer: 50, action: "pause" }], output: join(dir, "benchy-pause.gcode") });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.data.inserted[0].layer, 50);
      const before = (await readFile(join(dir, "benchy.gcode"), "utf8")).split("\n").length;
      const afterPause = (await readFile(join(dir, "benchy-pause.gcode"), "utf8")).split("\n").length;
      assert.ok(afterPause > before, "nothing was inserted");
      const paused = await analyzeAsciiGcode(join(dir, "benchy-pause.gcode"));
      assert.equal(paused.thumbnails.length, CORE_ONE_THUMBNAILS.length, "the thumbnails survive the pause");
    });
  });
}

describe("3DBenchy: 2.x and 3.x give the same print", { skip: skip || (new Set(targets.map((t) => t.version[0])).size < 2 ? "needs a 2.x and a 3.x (set PRUSASLICER_PATH_3)" : false) }, () => {
  test("filament, time and lifts within a few percent", (t) => {
    const results = [...sliced.entries()];
    if (results.length < 2) return t.skip("one of the slices did not run");
    // 2.9.7's own bundle (2.4.14) is older than what an updated 2.9 and 3.0 slice with.
    const older = [...profilesUsed.values()].find((profiles) => profiles?.includes("shipped"));
    if (older) return t.skip(`2.x ran on ${older}; the comparison needs the bundle an updated 2.9 has`);
    const [versionA, a] = results[0]!;
    const [versionB, b] = results[1]!;
    const within = (x: number, y: number, share: number) => Math.abs(x - y) <= share * Math.max(x, y);
    assert.ok(within(a.grams, b.grams, 0.02), `filament ${versionA} ${a.grams} g, ${versionB} ${b.grams} g`);
    assert.ok(within(a.seconds, b.seconds, 0.02), `time ${versionA} ${a.seconds} s, ${versionB} ${b.seconds} s`);
    assert.ok(within(a.lifts, b.lifts, 0.05), `lifts ${versionA} ${a.lifts}, ${versionB} ${b.lifts}`);
  });
});
