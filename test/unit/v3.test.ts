import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfigSchema, parseHelpFff, type SettingInfo } from "../../src/formats/help.ts";
import { splitList, unescapeValue } from "../../src/formats/ini.ts";
import { assertPresetsUsed } from "../../src/context.ts";
import { checkPatched, patchSavedConfig } from "../../src/slicer/v3-config.ts";
import { filamentShadows } from "../../src/tools/args.ts";
import { v3Backend } from "../../src/slicer/v3.ts";
import { stlBounds } from "../../src/formats/stl.ts";
import { readProject } from "../../src/formats/threemf.ts";
import { writeZip } from "../helpers/zip.ts";
import { Refusal } from "../../src/util/errors.ts";

// Made with PrusaSlicer 3.0.0-alpha14 on macOS, 2026-11-17.
const fixtures = join(import.meta.dirname, "..", "fixtures", "3.0.0-alpha14");
const read = (name: string) => readFile(join(fixtures, name), "utf8");

async function catalog(): Promise<Map<string, SettingInfo>> {
  return new Map(parseConfigSchema(await read("config-schema.json")).map((entry) => [entry.key, entry]));
}

function section(config: string | { config: string }, name: string): Record<string, unknown> {
  const text = typeof config === "string" ? config : config.config;
  return (JSON.parse(text) as { configuration: Record<string, Record<string, unknown>> }).configuration[name]!;
}

test("schema export: the settings catalogue of 3.0", async () => {
  const settings = await catalog();
  assert.equal(settings.get("thick_bridges")?.type, "bool");
  assert.equal(settings.get("thick_bridges")?.location, "print_settings");
  assert.equal(settings.get("top_solid_min_thickness")?.type, "number");
  assert.equal(settings.get("top_solid_min_thickness")?.min, 0);
  assert.equal(settings.get("fill_density")?.type, "percent");
  assert.equal(settings.get("fill_pattern")?.type, "enum");
  assert.ok(settings.get("fill_pattern")?.values?.includes("gyroid"));
  assert.equal(settings.get("post_process")?.type, "list");
  assert.equal(settings.get("temperature")?.location, "filament_settings");
  assert.equal(settings.get("binary_gcode")?.location, "printer_settings");
});

test("patch: a bool, a number and a percentage land in the right section, in the shape 3.0 saves", async () => {
  const saved = await read("saved-config.json");
  const patched = patchSavedConfig(
    saved,
    new Map([
      ["thick_bridges", "1"],
      ["top_solid_min_thickness", "3.2"],
      ["fill_density", "25%"],
      ["layer_height", "0.1"],
    ]),
    await catalog(),
  );
  const print = section(patched, "print_settings");
  assert.equal(print.thick_bridges, true);
  assert.equal(print.top_solid_min_thickness, 3.2);
  assert.deepEqual(print.fill_density, { value: 25, is_percent: true });
  assert.equal(print.layer_height, 0.1);
  // A plain number for a Percentage setting is a percentage too.
  assert.deepEqual(section(patchSavedConfig(saved, new Map([["fill_density", "40"]]), await catalog()), "print_settings").fill_density, { value: 40, is_percent: true });
  // Nothing else moved.
  assert.equal(section(patched, "print_settings").perimeter_speed, section(saved, "print_settings").perimeter_speed);
});

test("patch: filament settings are lists per tool; an empty value empties a list", async () => {
  const saved = await read("saved-config.json");
  const patched = patchSavedConfig(saved, new Map([["temperature", "215"], ["post_process", ""], ["binary_gcode", "0"]]), await catalog());
  assert.deepEqual(section(patched, "filament_settings").temperature, [215]);
  assert.deepEqual(section(patched, "print_settings").post_process, []);
  assert.equal(section(patched, "printer_settings").binary_gcode, false);
});

test("patch: wrong values are refused, not passed on", async () => {
  const saved = await read("saved-config.json");
  const settings = await catalog();
  const refused = (key: string, value: string, pattern: RegExp) =>
    assert.throws(() => patchSavedConfig(saved, new Map([[key, value]]), settings), (error) => error instanceof Refusal && pattern.test(error.message));
  refused("thick_bridges", "maybe", /true\/false/);
  refused("top_solid_min_thickness", "thick", /a number/);
  refused("top_solid_min_thickness", "-1", /at least 0/);
  refused("fill_pattern", "lightnin", /one of rectilinear/);
  refused("fill_density", "lots", /percentage/);
  refused("not_a_setting", "1", /not part of the configuration/);
});

test("saved config: preset names come back under the 2.x keys, so a wrong preset is noticed", async () => {
  const backend = v3Backend(true);
  const config = backend.parseSavedConfig(await read("saved-config.json"));
  assert.equal(unescapeValue(config.get("printer_settings_id")!), "Prusa CORE One & One+ 0.4 HF");
  assert.equal(unescapeValue(config.get("print_settings_id")!), "0.15mm BALANCED @COREONE 0.4HF");
  assert.deepEqual(splitList(config.get("filament_settings_id")!), ["Prusament PLA @COREONE HF0.4@COREONE 0.4"]);
  assert.equal(config.get("fill_density"), "15%");
  assert.equal(config.get("thick_bridges"), "0");
  const presets = { printer: "Prusa CORE One & One+ 0.4 HF", print: "0.15mm BALANCED @COREONE 0.4HF", filament: "Prusament PLA @COREONE HF0.4@COREONE 0.4" };
  assert.doesNotThrow(() => assertPresetsUsed(config, presets, backend));
  assert.throws(() => assertPresetsUsed(config, { ...presets, print: "0.20mm SPEED @COREONE 0.4HF" }, backend), /print preset/);
});

test("profile and model queries of alpha14 parse", async () => {
  const backend = v3Backend(true);
  const listing = backend.parseProfilesQuery(JSON.parse(await read("print-filament-profiles.json")));
  // alpha14 names the printer model here, not the profile that was asked for.
  assert.equal(listing.printer, "Prusa CORE One & One+ & One+ (Gen2)");
  assert.equal(listing.prints[0]!.name, "0.10mm FAST DETAIL @COREONE 0.4HF");
  assert.equal(listing.prints[0]!.filaments.length, 4);
});

test("filament layer: an override goes wherever the setting is held, since the filament's wins", async () => {
  // Prusament PLA in alpha14 overrides travel_ramping_lift, travel_max_lift and travel_slope.
  const saved = await read("saved-config.json");
  const settings = await catalog();
  assert.deepEqual(section(saved, "filament_settings").travel_ramping_lift, [true]);
  const patched = patchSavedConfig(saved, new Map([["travel_ramping_lift", "0"], ["retract_lift", "0.4"]]), settings);
  assert.equal(section(patched, "print_settings").travel_ramping_lift, false);
  assert.deepEqual(section(patched, "filament_settings").travel_ramping_lift, [false]);
  // retract_lift is not overridden by this filament: the print setting alone decides.
  assert.equal(section(patched, "print_settings").retract_lift, 0.4);
  assert.equal(section(patched, "filament_settings").retract_lift, undefined);
  assert.deepEqual(patched.targets.get("travel_ramping_lift")!.map((target) => target.section), ["print_settings", "filament_settings"]);
  assert.equal(patched.notes.length, 1);
  assert.match(patched.notes[0]!, /travel_ramping_lift: the filament profile overrides it \(it had \[true\]\)/);
});

test("filament_<key>, the 2.x name, sets or adds the filament override only", async () => {
  const saved = await read("saved-config.json");
  const settings = await catalog();
  assert.equal(settings.get("filament_retract_lift")?.aliasOf, "retract_lift");
  assert.equal(settings.has("filament_temperature"), false, "a filament setting has no alias");
  const patched = patchSavedConfig(saved, new Map([["filament_retract_lift", "0.4"], ["filament_travel_ramping_lift", "false"]]), settings);
  assert.deepEqual(section(patched, "filament_settings").retract_lift, [0.4]);
  assert.deepEqual(section(patched, "filament_settings").travel_ramping_lift, [false]);
  assert.equal(section(patched, "print_settings").retract_lift, 0.2, "the print setting stays");
  assert.deepEqual(patched.notes, []);
});

test("read back per layer: a merged view would have called a shadowed value confirmed", async () => {
  const saved = await read("saved-config.json");
  const patched = patchSavedConfig(saved, new Map([["travel_ramping_lift", "0"], ["fill_density", "25%"], ["post_process", ""]]), await catalog());
  assert.deepEqual(checkPatched(patched.config, patched.targets), { confirmed: ["travel_ramping_lift", "fill_density", "post_process"], rejected: [], missing: [] });
  // As if PrusaSlicer kept the filament's override and replaced fill_density.
  const loaded = JSON.parse(patched.config);
  loaded.configuration.filament_settings.travel_ramping_lift = [true];
  loaded.configuration.print_settings.fill_density = { value: 15, is_percent: true };
  delete loaded.configuration.print_settings.post_process;
  const check = checkPatched(JSON.stringify(loaded), patched.targets);
  assert.deepEqual(check.confirmed, []);
  assert.deepEqual(check.rejected.map((entry) => `${entry.key} ${entry.layer} ${entry.found}`), [
    "travel_ramping_lift filament_settings [true]",
    "fill_density print_settings {\"value\":15,\"is_percent\":true}",
  ]);
  assert.deepEqual(check.missing, ["post_process (print_settings)"]);
});

test("2.x: an override also sets filament_<key> when the filament profile overrides it", async () => {
  const fff = new Map(parseHelpFff(await readFile(join(import.meta.dirname, "..", "fixtures", "help-fff-2.9.7.txt"), "utf8")).map((e) => [e.key, e]));
  // As Buddy3D PETG @COREONE HF0.4 resolves in 2.9.7.
  const config = new Map([
    ["travel_ramping_lift", "1"],
    ["filament_travel_ramping_lift", "1"],
    ["retract_lift", "0.2"],
    ["filament_retract_lift", "nil"],
  ]);
  const shadows = filamentShadows(new Map([["travel_ramping_lift", "0"], ["retract_lift", "0.4"], ["fill_density", "20%"]]), config, fff);
  assert.deepEqual([...shadows.extra], [["filament_travel_ramping_lift", "0"]]);
  assert.match(shadows.notes[0]!, /filament_travel_ramping_lift = 1/);
  // Given explicitly, it is left alone.
  assert.equal(filamentShadows(new Map([["travel_ramping_lift", "0"], ["filament_travel_ramping_lift", "1"]]), config, fff).extra.size, 0);
});

test("STL bounds: binary and ASCII, at any position", async () => {
  const cube = join(import.meta.dirname, "..", "fixtures", "cube.stl");
  assert.deepEqual(await stlBounds(cube), { min: [0, 0, 0], max: [20, 20, 20] });
  const dir = await mkdtemp(join(tmpdir(), "stl-"));
  try {
    // The same cube moved to x 115..135, y 100..120: where alpha14's --info says 0..135.
    const data = Buffer.from(await readFile(cube));
    const count = data.readUInt32LE(80);
    for (let facet = 0; facet < count; facet++) {
      for (let vertex = 0; vertex < 3; vertex++) {
        const at = 84 + facet * 50 + 12 + vertex * 12;
        data.writeFloatLE(data.readFloatLE(at) + 115, at);
        data.writeFloatLE(data.readFloatLE(at + 4) + 100, at + 4);
      }
    }
    await writeFile(join(dir, "moved.stl"), data);
    assert.deepEqual(await stlBounds(join(dir, "moved.stl")), { min: [115, 100, 0], max: [135, 120, 20] });
    await writeFile(join(dir, "ascii.stl"), "solid t\nfacet normal 0 0 1\nouter loop\nvertex -1 2 3\nvertex 4 -5 6\nvertex 0 0 -7\nendloop\nendfacet\nendsolid t\n");
    assert.deepEqual(await stlBounds(join(dir, "ascii.stl")), { min: [-1, -5, -7], max: [4, 2, 6] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("3.0 project: preset names come from the config container's preset block", async () => {
  const dir = await mkdtemp(join(tmpdir(), "project3-"));
  try {
    const file = join(dir, "bracket.3mf");
    await writeZip(file, { "Metadata/PrusaSlicer3_project.json": await read("project.json") });
    const project = await readProject(file);
    assert.equal(project.kind, "prusaslicer-3");
    assert.deepEqual(project.presets, {
      printer: "Prusa CORE One & One+ 0.4 HF",
      print: "0.15mm BALANCED @COREONE 0.4HF",
      filament: ["Prusament PLA @COREONE HF0.4@COREONE 0.4"],
    });
    assert.equal(project.config.get("fill_density"), "15%");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
