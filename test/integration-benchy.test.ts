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
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { locateSlicer } from "../src/slicer/locate.ts";
import { benchy, liftedMoves, lifts, movedStl } from "./helpers/models.ts";

const root = join(import.meta.dirname, "..");

interface Target {
  path: string;
  version: string;
}

function versionOf(path: string): string {
  const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 20_000 });
  return /(\d+\.\d+\.\d+\S*)/.exec(`${result.stdout ?? ""}${result.stderr ?? ""}`)?.[1] ?? "";
}

const targets: Target[] = [];
for (const env of [process.env, process.env.PRUSASLICER_PATH_3 ? { PRUSASLICER_PATH: process.env.PRUSASLICER_PATH_3 } : null]) {
  if (!env) continue;
  const located = locateSlicer(env as NodeJS.ProcessEnv);
  if ("error" in located || targets.some((target) => target.path === located.path)) continue;
  const version = versionOf(located.path);
  if (version) targets.push({ path: located.path, version });
}

const model = await benchy();
const skip = "skip" in model ? model.skip : targets.length === 0 ? "PrusaSlicer not found" : false;

/** What each version made of the same Benchy, for the comparison at the end. */
const sliced = new Map<string, { grams: number; seconds: number; lifts: number }>();

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
      client = new Client({ name: "integration-benchy", version: "0" });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [join(root, "src", "index.ts")],
          stderr: "ignore",
          cwd: root,
          env: { ...(process.env as Record<string, string>), PRUSASLICER_PATH: target.path },
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
    });
  });
}

describe("3DBenchy: 2.x and 3.x give the same print", { skip: skip || (new Set(targets.map((t) => t.version[0])).size < 2 ? "needs a 2.x and a 3.x (set PRUSASLICER_PATH_3)" : false) }, () => {
  test("filament, time and lifts within a few percent", (t) => {
    const results = [...sliced.entries()];
    if (results.length < 2) return t.skip("one of the slices did not run");
    const [versionA, a] = results[0]!;
    const [versionB, b] = results[1]!;
    const within = (x: number, y: number, share: number) => Math.abs(x - y) <= share * Math.max(x, y);
    assert.ok(within(a.grams, b.grams, 0.02), `filament ${versionA} ${a.grams} g, ${versionB} ${b.grams} g`);
    assert.ok(within(a.seconds, b.seconds, 0.02), `time ${versionA} ${a.seconds} s, ${versionB} ${b.seconds} s`);
    assert.ok(within(a.lifts, b.lifts, 0.05), `lifts ${versionA} ${a.lifts}, ${versionB} ${b.lifts}`);
  });
});
