import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfigSchema, type SettingInfo } from "../../src/formats/help.ts";
import { splitList, unescapeValue } from "../../src/formats/ini.ts";
import { assertPresetsUsed } from "../../src/context.ts";
import { patchSavedConfig } from "../../src/slicer/v3-config.ts";
import { v3Backend } from "../../src/slicer/v3.ts";
import { checkApplied } from "../../src/slicer/verify.ts";
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

function section(config: string, name: string): Record<string, unknown> {
  return (JSON.parse(config) as { configuration: Record<string, Record<string, unknown>> }).configuration[name]!;
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

test("applied check: what PrusaSlicer saves back after loading the written config", async () => {
  const backend = v3Backend(true);
  const saved = await read("saved-config.json");
  const settings = await catalog();
  const changes = new Map([
    ["thick_bridges", "1"],
    ["fill_density", "25"],
    ["retract_lift", "0.4"],
    ["post_process", ""],
  ]);
  const written = backend.parseSavedConfig(patchSavedConfig(saved, changes, settings));
  // As if PrusaSlicer loaded it all, but replaced fill_density.
  const loaded = new Map(written);
  loaded.set("fill_density", "15%");
  loaded.delete("retract_lift");
  const check = checkApplied(changes.keys(), written, loaded);
  assert.deepEqual(check.confirmed, ["thick_bridges", "post_process"]);
  assert.deepEqual(check.rejected, [{ key: "fill_density", expected: "25%", found: "15%" }]);
  assert.deepEqual(check.missing, ["retract_lift"]);
  // A value that equals the old one is fine when it was asked for: the G-code header was no judge.
  const same = backend.parseSavedConfig(patchSavedConfig(saved, new Map([["retract_lift", "0.2"]]), settings));
  assert.deepEqual(checkApplied(["retract_lift"], same, same).confirmed, ["retract_lift"]);
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
