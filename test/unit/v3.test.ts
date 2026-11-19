import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfigSchema, parseHelpFff, type SettingInfo } from "../../src/formats/help.ts";
import { splitList, unescapeValue } from "../../src/formats/ini.ts";
import { assertPresetsUsed } from "../../src/context.ts";
import { checkPatched, patchSavedConfig } from "../../src/slicer/v3-config.ts";
import { filamentShadows } from "../../src/tools/args.ts";
import { stabilityOf } from "../../src/tools/slice.ts";
import { backupName, readV3OpenProjects, readV3PhysicalPrinters, readV3UserPresets } from "../../src/slicer/v3-userdata.ts";
import { existingIds, renderV3FilamentPreset, sameSetting, v3PresetTarget, v3Values, writeChecked } from "../../src/slicer/filament-preset-v3.ts";
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

test("stability: the warning codes in alpha14's trace log", () => {
  // As 3.0.0-alpha14 logs them at --loglevel 5 (SlicingInteractor.cpp:216).
  const line = (codes: string) =>
    `[2026-11-19 15:56:21.403] [trace] [SlicingInteractor.cpp:216] {project_id: 0, bed_id: 23}: status_update: {code: Updating, clear_errors: 0, , errors_to_append: [], clear_warnings: 0, warnings_to_append: [${codes}], clear_progress: 0, progress: }`;
  const flagged = stabilityOf([line(""), line("7"), line("")].join("\n"));
  assert.equal(flagged.issues_found, true);
  assert.deepEqual(flagged.warnings, [{ code: 7, name: "StabilityIssues" }]);
  const clean = stabilityOf([line(""), line("")].join("\n"));
  assert.equal(clean.issues_found, false);
  assert.deepEqual(clean.warnings, []);
  assert.deepEqual(stabilityOf(line("1, 7")).warnings.map((w) => w.name), ["BedTempsDiffer", "StabilityIssues"]);
});

test("3.0 filament preset: where it goes, what it applies to, and its typed values", async () => {
  const target = v3PresetTarget(await read("saved-config.json"), "/data", "My PLA @COREONE HF0.4");
  assert.equal(target.file, "/data/presets/user/prusa-research-fff/PrusaResearch/filament-My PLA @COREONE HF0.4.yaml");
  // The parent's evaluated id: a hash for Prusament PLA, "Generic PLA" for the generic.
  assert.equal(target.parentId, "9ql4eJIDTX+KVNeIbbae2g");
  assert.equal(target.condition, 'printer.base_model == "COREONE" and tool.nozzle_diameter == 0.4 and tool.nozzle_high_flow');
  const values = v3Values(
    [
      { key: "temperature", value: "215" },
      { key: "filament_density", value: "1.24" },
      { key: "filament_colour", value: "#FF8000" },
      { key: "filament_vendor", value: "Acme" },
      { key: "filament_notes", value: '"line one\\nwith \\"quotes\\""' },
    ],
    await catalog(),
  );
  assert.deepEqual(values, { temperature: 215, filament_density: 1.24, filament_colour: "#FF8000", filament_vendor: "Acme", filament_notes: 'line one\nwith "quotes"' });
  const yaml = renderV3FilamentPreset({ name: "My PLA", condition: target.condition, parentId: "Generic PLA", values, comment: "test", ids: { root: "r-1", variant: "v-1" } });
  assert.match(yaml, /^kind: filament$/m);
  assert.match(yaml, /^    unconditional_inherits: \["Generic PLA"\]$/m);
  assert.match(yaml, /^      filament_notes: "line one\\nwith \\"quotes\\""$/m);
  assert.match(yaml, /^      temperature: 215$/m);
});

test("3.0 filament preset: a failed check puts back what was there", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preset3-"));
  try {
    const file = join(dir, "presets", "user", "filament-x.yaml");
    let changes = 0;
    const changed = () => changes++;
    const fail = async () => {
      throw new Refusal("check failed");
    };
    await assert.rejects(writeChecked(file, "new", fail, changed), /check failed/);
    await assert.rejects(readFile(file, "utf8"), /ENOENT/, "a new preset that fails its check is removed");
    await writeChecked(file, 'kind: filament\nid: "root-1"\nvariants:\n  - id: "variant-1"\n', async () => {}, changed);
    assert.deepEqual(await existingIds(file), { root: "root-1", variant: "variant-1" });
    await assert.rejects(writeChecked(file, "broken", fail, changed), /check failed/);
    assert.match(await readFile(file, "utf8"), /root-1/, "an overwritten preset is restored");
    assert.equal(changes, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("3.0 filament preset: resolved values against what was written", () => {
  // A note with ";" was refused once: it was split like a per-extruder list.
  assert.equal(sameSetting("test preset; safe to delete", '"test preset; safe to delete"'), true);
  assert.equal(sameSetting("Acme, Inc.", "Acme, Inc."), true);
  assert.equal(sameSetting("215", "215"), true);
  assert.equal(sameSetting("215,215", "215"), true);
  assert.equal(sameSetting("1.240", "1.24"), true);
  assert.equal(sameSetting("220", "215"), false);
  assert.equal(sameSetting("other note", '"test note"'), false);
});

test("3.0 user data: own presets, physical printer names only, and the GUI's backups of unsaved projects", async () => {
  const datadir = await mkdtemp(join(tmpdir(), "datadir3-"));
  try {
    const vendor = join(datadir, "presets", "user", "prusa-research-fff", "PrusaResearch");
    await mkdir(vendor, { recursive: true });
    await writeFile(
      join(vendor, "filament-My PLA.yaml"),
      renderV3FilamentPreset({ name: "My PLA", condition: "true", parentId: "Generic PLA", values: { temperature: 215 }, comment: "test" }),
    );
    // As the GUI writes a printer preset: unquoted scalars, variant name under "- id".
    await writeFile(join(vendor, "printer-My CORE One.yaml"), "kind: printer\nid: abc\nvariants:\n- id: def\n  name: My CORE One\n  inherits: [COREONE]\n  values: {}\n");
    assert.deepEqual(
      (await readV3UserPresets(datadir, "filament")).map(({ name, inherits }) => ({ name, inherits })),
      [{ name: "My PLA", inherits: "Generic PLA" }],
    );
    assert.deepEqual((await readV3UserPresets(datadir, "printer")).map((preset) => preset.name), ["My CORE One"]);
    assert.deepEqual(await readV3UserPresets(datadir, "print"), []);

    const physical = join(datadir, "physical_printer");
    await mkdir(physical);
    await writeFile(
      join(physical, "0b6c.json"),
      JSON.stringify({ physical_printer_user_given_name: "Workshop CORE One", physical_printer_host: "192.0.2.10", physical_printer_api_key: "secret", physical_printer_password: "secret" }),
    );
    assert.deepEqual(await readV3PhysicalPrinters(datadir), ["Workshop CORE One"]);

    const backups = join(datadir, "backup_projects");
    await mkdir(backups);
    await writeZip(join(backups, "a1b2c3_d4e5f6_bracket.3mf"), { "Metadata/PrusaSlicer3_project.json": await read("project.json") });
    const open = await readV3OpenProjects(datadir);
    assert.equal(open.length, 1);
    assert.equal(open[0]!.name, "bracket");
    assert.equal(open[0]!.objects, 1);
    assert.deepEqual(open[0]!.presets, { printer: "Prusa CORE One & One+ 0.4 HF", print: "0.15mm BALANCED @COREONE 0.4HF", filament: ["Prusament PLA @COREONE HF0.4@COREONE 0.4"] });
    assert.equal(backupName("a1b2c3_d4e5f6_my_project_v2.3mf"), "my_project_v2");
  } finally {
    await rm(datadir, { recursive: true, force: true });
  }
});
