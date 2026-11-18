import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseHelpFff } from "../../src/formats/help.ts";
import { insertAtLayers } from "../../src/formats/postprocess.ts";
import { matchRecentProjects, parseWindowTitle } from "../../src/gui/index.ts";
import { flattenConfiguration, v3Backend } from "../../src/slicer/v3.ts";
import { describeFailure, type RunResult } from "../../src/slicer/run.ts";
import { overrideArgs, transformArgs } from "../../src/tools/args.ts";
import { Refusal } from "../../src/util/errors.ts";
import { suggest } from "../../src/util/suggest.ts";

const fixtures = join(import.meta.dirname, "..", "fixtures");
let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "prusaslicer-mcp-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("overrides: checked against the catalogue, empty values as two arguments", async () => {
  const catalog = new Map(parseHelpFff(await readFile(join(fixtures, "help-fff-2.9.7.txt"), "utf8")).map((e) => [e.key, e]));
  const { args, keys } = overrideArgs({ fill_density: "25%", "brim-width": 5, support_material: true, z_offset: -0.1, start_gcode: "" }, catalog);
  assert.deepEqual(args, ["--fill-density=25%", "--brim-width=5", "--support-material=1", "--z-offset=-0.1", "--start-gcode", ""]);
  assert.deepEqual(keys, ["fill_density", "brim_width", "support_material", "z_offset", "start_gcode"]);

  assert.throws(() => overrideArgs({ fill_patern: "gyroid" }, catalog), (error: unknown) => {
    assert.ok(error instanceof Refusal);
    assert.equal((error.details?.did_you_mean as string[])[0], "fill_pattern");
    return true;
  });
  assert.throws(() => overrideArgs({ post_process: "/bin/evil" }, catalog), Refusal);
});

test("transforms", () => {
  assert.deepEqual(transformArgs({ rotate_z: -45, scale: "150%", duplicate: 3, center: [125, 110], ensure_on_bed: false, merge: true }), [
    "--rotate=-45",
    "--scale=150%",
    "--center=125,110",
    "--duplicate=3",
    "--merge",
    "--no-ensure-on-bed",
  ]);
  assert.deepEqual(transformArgs(undefined), []);
});

test("suggest: mistyped preset names", () => {
  const names = ["0.20mm SPEED @COREONE HF0.4", "0.20mm BALANCED @COREONE HF0.4", "0.15mm SPEED @COREONE HF0.4", "0.28mm DRAFT @COREONE HF0.4"];
  assert.equal(suggest("0.20mm SPEED", names)[0], "0.20mm SPEED @COREONE HF0.4");
  assert.equal(suggest("0.28 draft coreone", names)[0], "0.28mm DRAFT @COREONE HF0.4");
});

test("window title: project, unsaved changes, untitled", () => {
  assert.deepEqual(parseWindowTitle("bracket - PrusaSlicer-2.9.7 based on Slic3r"), { name: "bracket", modified: false });
  assert.deepEqual(parseWindowTitle("*bracket - PrusaSlicer-2.9.7 gebaseerd op Slic3r"), { name: "bracket", modified: true });
  assert.deepEqual(parseWindowTitle("*Naamloos - PrusaSlicer-2.9.7 gebaseerd op Slic3r"), { name: null, modified: true });
  assert.deepEqual(parseWindowTitle("PrusaSlicer-2.9.7 based on Slic3r"), { name: null, modified: false });
  assert.deepEqual(matchRecentProjects("bracket", ["/x/other.3mf", "/y/bracket.3mf", "/z/bracket.stl"]), ["/y/bracket.3mf", "/z/bracket.stl"]);
});

test("crash and silent failures are explained", () => {
  const base: RunResult = { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false };
  assert.match(describeFailure({ ...base, exitCode: 139 }, "Resolving"), /segmentation fault/);
  assert.match(describeFailure({ ...base, stderr: "All objects are outside of the print volume.\n" }, "Slicing"), /produced no output\.\nAll objects/);
  assert.match(describeFailure({ ...base, aborted: true }, "Slicing"), /cancelled/);
});

test("3.0 config boxes flatten like 2.x vectors", () => {
  const config = flattenConfiguration({
    printer: { nozzle_diameter: [0.4, 0.6], printer_model: "XL" },
    print: { layer_height: 0.2, ironing: true },
    material_slots: [{ temperature: 215 }, { temperature: 240 }],
  });
  assert.equal(config.get("nozzle_diameter"), "0.4,0.6");
  assert.equal(config.get("ironing"), "1");
  assert.equal(config.get("temperature"), "215,240");
  // 3.0 stores percentages as {"value", "is_percent"}: they are values, not named boxes.
  const percent = flattenConfiguration({ print_settings: { fill_density: { value: 15, is_percent: true }, infill_anchor: { value: 2, is_percent: false } } });
  assert.equal(percent.get("fill_density"), "15%");
  assert.equal(percent.get("infill_anchor"), "2");
});

test("postprocess: pause after the layer change, before the unretract", async () => {
  const input = join(dir, "cube5.gcode");
  const output = join(dir, "cube5-edited.gcode");
  await copyFile(join(fixtures, "cube5.gcode"), input);
  const result = await insertAtLayers(input, output, [
    { layer: 3, gcode: "M601", label: "pause" },
    { z: 4, gcode: "M600\nG1 E0.3 F1500", label: "color change" },
  ]);
  assert.equal(result.layers, 25);
  assert.deepEqual(
    result.inserted.map((insert) => [insert.layer, insert.z]),
    [
      [3, 0.6],
      [20, 4],
    ],
  );

  const lines = (await readFile(output, "utf8")).split("\n");
  const at = lines.indexOf("; prusaslicer-mcp: pause at layer 3 (Z 0.6)");
  assert.ok(at > 0);
  assert.equal(lines[at - 2], ";AFTER_LAYER_CHANGE");
  assert.equal(lines[at - 1], ";0.6");
  assert.equal(lines[at + 1], "M601");
  const original = (await readFile(input, "utf8")).split("\n");
  assert.equal(lines.length, original.length + 2 + 3);

  await assert.rejects(insertAtLayers(input, join(dir, "x.gcode"), [{ layer: 99, gcode: "M601", label: "pause" }]), /does not exist; the print has 25 layers/);
});

test("profile query: user filament presets come in their own list (2.9.7)", async () => {
  const { v2Backend } = await import("../../src/slicer/v2.ts");
  const listing = v2Backend.parseProfilesQuery({
    printer_profile: "P",
    print_profiles: [{ name: "0.20mm", filament_profiles: ["Generic PETG @P"], user_filament_profiles: ["My PETG @P"] }],
  });
  assert.deepEqual(listing.prints[0]!.filaments, ["Generic PETG @P", "My PETG @P"]);
});
