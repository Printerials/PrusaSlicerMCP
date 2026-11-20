/**
 * End to end against a PrusaSlicer 3.x, through a real MCP client over stdio. Runs only when the
 * located PrusaSlicer is 3.x (set PRUSASLICER_PATH to the 3.0 app). Writes only to a temporary
 * directory. Checked against 3.0.0-alpha14, where settings given as options are ignored without
 * an error: these tests would fail if the server went back to passing them that way.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { locateSlicer } from "../src/slicer/locate.ts";
import { ZipReader } from "../src/formats/zip.ts";
import { writeZip } from "./helpers/zip.ts";
import { lifts } from "./helpers/models.ts";

const root = join(import.meta.dirname, "..");
const located = locateSlicer();

function versionOf(path: string): string {
  // The version goes to stderr in some builds, to stdout in others.
  const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 20_000 });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

const skip = "error" in located ? "PrusaSlicer not found" : /(^|\n)3\./.test(versionOf(located.path)) ? false : "the located PrusaSlicer is not 3.x";

describe("against PrusaSlicer 3.x", { skip }, () => {
  let client: Client;
  let dir: string;
  let printer: string;
  let print: string;
  let filament: string;

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

  const header = async (path: string, key: string) => (await readFile(path, "utf8")).match(new RegExp(`^; ${key} = (.*)$`, "m"))?.[1];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "prusaslicer-mcp-it3-"));
    await copyFile(join(root, "test", "fixtures", "cube.stl"), join(dir, "cube.stl"));
    client = new Client({ name: "integration-test-3", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "src", "index.ts")], stderr: "ignore", cwd: root, env: process.env as Record<string, string> }));
  });

  after(async () => {
    await client?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("status, printers and profiles", async () => {
    const status = await call("slicer_status");
    assert.match(status.data.slicer.version, /^3\./);
    const printers = await call("list_printers");
    assert.equal(printers.isError, false, printers.text);
    const names: string[] = printers.data.models.flatMap((model: any) => model.variants.flatMap((variant: any) => variant.presets.map((preset: any) => preset.name)));
    printer = names.find((name) => /^Prusa CORE One & One\+ 0\.4 HF$/.test(name)) ?? names[0]!;
    const profiles = await call("list_profiles", { printer });
    assert.equal(profiles.isError, false, profiles.text);
    print = profiles.data.print_profiles[0].name;
    filament = profiles.data.filament_profiles_for_all_prints[0];
    assert.ok(printer && print && filament);
  });

  test("the settings catalogue comes from the schema export", async () => {
    const setting = await call("describe_setting", { key: "thick_bridges" });
    assert.equal(setting.isError, false, setting.text);
    assert.equal(setting.data.type, "bool");
    assert.equal(setting.data.location, "print_settings");
  });

  test("overrides reach the G-code, and are confirmed from what PrusaSlicer loaded", async (t) => {
    if (!filament) return t.skip("no profiles");
    const plain = join(dir, "plain.gcode");
    const changed = join(dir, "changed.gcode");
    const base = { inputs: [join(dir, "cube.stl")], printer, print, filament, gcode_format: "ascii" };
    const first = await call("slice", { ...base, output: plain });
    assert.equal(first.isError, false, first.text);
    const second = await call("slice", { ...base, output: changed, overrides: { thick_bridges: true, top_solid_min_thickness: 3.2 } });
    assert.equal(second.isError, false, second.text);
    assert.equal(await header(changed, "thick_bridges"), "1");
    assert.equal(await header(changed, "top_solid_min_thickness"), "3.2");
    assert.deepEqual([...second.data.overrides_confirmed].sort(), ["thick_bridges", "top_solid_min_thickness"]);
    assert.notEqual((await stat(plain)).size, (await stat(changed)).size, "the overrides changed nothing");
  });

  test("a percentage override and an enum override", async (t) => {
    if (!filament) return t.skip("no profiles");
    const output = join(dir, "infill.gcode");
    const sliced = await call("slice", {
      inputs: [join(dir, "cube.stl")], printer, print, filament, gcode_format: "ascii", output,
      overrides: { fill_density: "33%", fill_pattern: "gyroid" },
    });
    assert.equal(sliced.isError, false, sliced.text);
    assert.equal(await header(output, "fill_density"), "33%");
    assert.equal(await header(output, "fill_pattern"), "gyroid");
  });

  test("a lift override is confirmed, although the alpha14 header shows lift settings as 0", async (t) => {
    if (!filament) return t.skip("no profiles");
    const output = join(dir, "lift.gcode");
    const sliced = await call("slice", {
      inputs: [join(dir, "cube.stl")], printer, print, filament, gcode_format: "ascii", output,
      overrides: { retract_lift_above: 5, travel_max_lift: 1 },
    });
    assert.equal(sliced.isError, false, sliced.text);
    assert.deepEqual([...sliced.data.overrides_confirmed].sort(), ["retract_lift_above", "travel_max_lift"]);
  });

  test("bad input is refused before anything is sliced", async (t) => {
    if (!filament) return t.skip("no profiles");
    const base = { inputs: [join(dir, "cube.stl")], printer, print, filament, output: join(dir, "never.gcode") };
    assert.equal((await call("slice", { ...base, overrides: { thick_bridgez: true } })).isError, true);
    const badEnum = await call("slice", { ...base, overrides: { fill_pattern: "lightnin" } });
    assert.equal(badEnum.isError, true);
    assert.match(badEnum.text, /one of/);
    assert.equal((await call("slice", { ...base, printer: "No such printer" })).isError, true);
    assert.equal(await stat(join(dir, "never.gcode")).then(() => true, () => false), false);
  });

  test("binary G-code: a .bgcode output is real binary, and auto follows the printer's binary_gcode", async (t) => {
    if (!filament) return t.skip("no profiles");
    // 3.0.0-alpha14 picks the format by the extension of output_filename_format, not by binary_gcode.
    const magic = async (path: string) => (await readFile(path)).subarray(0, 4).toString("latin1");
    const output = join(dir, "binary.bgcode");
    const named = await call("slice", { inputs: [join(dir, "cube.stl")], printer, print, filament, output });
    assert.equal(named.isError, false, named.text);
    assert.equal(await magic(output), "GCDE");
    assert.equal(named.data.result.format, "binary");
    const auto = await call("slice", { inputs: [join(dir, "cube.stl")], printer, print, filament, output: dir });
    assert.equal(auto.isError, false, auto.text);
    const config = await call("get_config", { printer, print, filament, keys: ["binary_gcode"] });
    const expected = config.data.values.binary_gcode === "1" ? ".bgcode" : ".gcode";
    assert.ok(auto.data.output.endsWith(expected), `${auto.data.output}, binary_gcode ${config.data.values.binary_gcode}`);
  });

  test("stability_check: PrusaSlicer's own check, a cube passes", async (t) => {
    if (!filament) return t.skip("no profiles");
    const result = await call("slice", { inputs: [join(dir, "cube.stl")], printer, print, filament, gcode_format: "ascii", output: join(dir, "stable.gcode"), stability_check: true });
    assert.equal(result.isError, false, result.text);
    assert.equal(result.data.stability.issues_found, false);
    const messages: string[] = result.data.messages ?? [];
    assert.ok(!messages.some((line) => line.startsWith("[20")), `trace lines leaked into messages: ${JSON.stringify(messages)}`);
  });

  /** A 3.0 project: the cube's geometry as PrusaSlicer exports it, with the project config alpha14 wrote for it. */
  const project = async (name: string, change?: (json: any) => void) => {
    const geometry = join(dir, `${name}-geometry.3mf`);
    const exported = await call("export_model", { inputs: [join(dir, "cube.stl")], format: "3mf", output: geometry });
    assert.equal(exported.isError, false, exported.text);
    const zip = await ZipReader.open(geometry);
    const files: Record<string, Buffer | string> = {};
    for (const entry of zip.entries.keys()) files[entry] = (await zip.read(entry))!;
    await zip.close();
    const json = JSON.parse(await readFile(join(root, "test", "fixtures", "3.0.0-alpha14", "project.json"), "utf8"));
    change?.(json);
    files["Metadata/PrusaSlicer3_project.json"] = JSON.stringify(json);
    const path = join(dir, `${name}.3mf`);
    await writeZip(path, files);
    return path;
  };

  test("edit_project on a 3.0 project: values in every layer, read back, and they slice", async () => {
    const path = await project("bracket");
    const edited = await call("edit_project", { path, settings: { fill_density: "20%", travel_ramping_lift: false, retract_lift: 0.4 } });
    assert.equal(edited.isError, false, edited.text);
    assert.deepEqual(Object.keys(edited.data.changed).sort(), ["fill_density", "retract_lift", "travel_ramping_lift"]);
    assert.match(edited.data.also_set[0], /travel_ramping_lift: the filament profile overrides it/);
    assert.equal(edited.data.presets.after.print, "0.15mm BALANCED @COREONE 0.4HF");
    const sliced = await call("slice", { inputs: [edited.data.output], gcode_format: "ascii", output: join(dir, "edited.gcode") });
    assert.equal(sliced.isError, false, sliced.text);
    const heights = lifts(await readFile(join(dir, "edited.gcode"), "utf8"));
    const total = [...heights.values()].reduce((sum, count) => sum + count, 0);
    assert.ok((heights.get(0.4) ?? 0) / total > 0.95, `lifts ${JSON.stringify([...heights])}`);
  });

  test("edit_project on a 3.0 project: a preset switch, a bad value, a part that keeps its own", async () => {
    const path = await project("switch");
    const switched = await call("edit_project", { path, print: "0.20mm SPEED @COREONE 0.4HF", output: join(dir, "switched.3mf") });
    assert.equal(switched.isError, false, switched.text);
    assert.equal(switched.data.presets.after.print, "0.20mm SPEED @COREONE 0.4HF");
    const bad = await call("edit_project", { path, settings: { fill_pattern: "lightnin" }, output: join(dir, "bad.3mf") });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /one of rectilinear/);
    assert.equal(await stat(join(dir, "bad.3mf")).then(() => true, () => false), false);
    const own = await project("own", (json) => (json.objects[0].object_settings.fill_density = { value: 40, is_percent: true }));
    const kept = await call("edit_project", { path: own, settings: { fill_density: "20%" } });
    assert.equal(kept.isError, false, kept.text);
    assert.match(kept.data.kept_by_objects[0], /object 1 sets fill_density/);
  });

  test("create_filament_preset on 3.0: a YAML preset on its parent, sliced with, overwritten in place", async (t) => {
    if (!filament) return t.skip("no profiles");
    // On a copy of the data directory: the real one is only read.
    const status = await call("slicer_status");
    const datadir: string | null = status.data.slicer.datadir;
    if (!datadir) return t.skip("no 3.0 data directory");
    const copy = join(dir, "datadir");
    await cp(datadir, copy, { recursive: true, filter: (source) => !source.endsWith(".lock") });
    const other = new Client({ name: "integration-test-3-presets", version: "0" });
    await other.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(root, "src", "index.ts")],
        stderr: "ignore",
        cwd: root,
        env: { ...(process.env as Record<string, string>), PRUSASLICER_DATADIR: copy },
      }),
    );
    const callCopy = async (name: string, args: Record<string, unknown>) => {
      const result = await other.callTool({ name, arguments: args });
      const text = (result.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("\n");
      return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
    };
    try {
      const request = { printer, type: "PLA", name: "Integration PLA", values: { vendor: "Acme", nozzle_temp: 214, density: 1.23 } };
      const dry = await callCopy("create_filament_preset", { ...request, dry_run: true });
      assert.equal(dry.isError, false, dry.text);
      assert.match(dry.data.parent, /^Generic PLA ?@/);
      assert.equal(await stat(dry.data.file).then(() => true, () => false), false, "a dry run writes nothing");
      const made = await callCopy("create_filament_preset", request);
      assert.equal(made.isError, false, made.text);
      assert.ok(made.data.file.startsWith(copy), "written into the copy");
      const yaml = await readFile(made.data.file, "utf8");
      assert.match(yaml, /^    unconditional_inherits: \[/m);
      const rootId = /^id: (\S+)/m.exec(yaml)![1];

      const output = join(dir, "integration-pla.gcode");
      const sliced = await callCopy("slice", { inputs: [join(dir, "cube.stl")], printer, print, filament: "Integration PLA", gcode_format: "ascii", output });
      assert.equal(sliced.isError, false, sliced.text);
      assert.match(await readFile(output, "utf8"), /^; temperature = 214$/m);

      assert.equal((await callCopy("create_filament_preset", request)).isError, true, "no overwrite without overwrite: true");
      const again = await callCopy("create_filament_preset", { ...request, values: { ...request.values, nozzle_temp: 219 }, overwrite: true });
      assert.equal(again.isError, false, again.text);
      const rewritten = await readFile(again.data.file, "utf8");
      assert.match(rewritten, /^      temperature: 219$/m);
      assert.equal(/^id: (\S+)/m.exec(rewritten)![1], rootId, "the preset keeps its id");

      // A project inside the data directory (as the GUI's backup of an unsaved project is): read, never written next to.
      const backups = join(copy, "backup_projects");
      await cp(await project("backup"), join(backups, "inst_id_backup.3mf"));
      const info = await callCopy("project_info", { path: join(backups, "inst_id_backup.3mf") });
      assert.equal(info.isError, false, info.text);
      for (const [name, args] of [
        ["slice", { inputs: [join(backups, "inst_id_backup.3mf")] }],
        ["edit_project", { path: join(backups, "inst_id_backup.3mf"), settings: { fill_density: "20%" } }],
      ] as const) {
        const refused = await callCopy(name, args);
        assert.equal(refused.isError, true, `${name} wrote next to the backup`);
        assert.match(refused.text, /inside PrusaSlicer's data directory/);
      }
    } finally {
      await other.close();
    }
  });

  test("open_in_prusaslicer refuses a 3.0 project instead of reporting it opened", async () => {
    // Checked with the 3.0.0-alpha14 GUI: open -a gives an empty project, --single-instance drops the settings.
    const path = await project("to-open");
    const result = await call("open_in_prusaslicer", { paths: [path] });
    assert.equal(result.isError, true);
    assert.match(result.text, /cannot be told to open a project from outside/);
    assert.match(result.text, /to-open\.3mf/);
  });

  test("update_profiles on 3.0: an outdated bundle is listed and installed, on a copy of the data directory", async (t) => {
    const status = await call("slicer_status");
    const datadir: string | null = status.data.slicer.datadir;
    if (!datadir) return t.skip("no 3.0 data directory");
    const online = await fetch("https://preset-repo-api.prusa3d.com/", { signal: AbortSignal.timeout(10_000) }).then(() => true, () => false);
    if (!online) return t.skip("Prusa's preset repository cannot be reached");
    const copy = join(dir, "datadir-update");
    await cp(datadir, copy, { recursive: true, filter: (source) => !source.endsWith(".lock") && !source.includes("backup_projects") });
    // Set the Prusa bundle back one version, as if it were not updated yet.
    const vendorFile = join(copy, "presets", "local", "prusa-research-fff", "PrusaResearch", "vendor.yaml");
    const vendor = await readFile(vendorFile, "utf8").catch(() => null);
    const current = vendor && /^version: (\S+)$/m.exec(vendor)?.[1];
    if (!vendor || !current) return t.skip("no local Prusa FFF bundle");
    const versions = [...(await readFile(join(copy, "presets", "local", "prusa-research-fff", "PrusaResearch.idx"), "utf8")).matchAll(/^(\d+\.\d+\.\d+)\s/gm)].map((m) => m[1]!);
    const older = versions[versions.indexOf(current) + 1];
    if (!older) return t.skip("no older bundle version in the index");
    await writeFile(vendorFile, vendor.replace(/^version: \S+$/m, `version: ${older}`));

    const other = new Client({ name: "integration-test-3-update", version: "0" });
    await other.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(root, "src", "index.ts")],
        stderr: "ignore",
        cwd: root,
        env: { ...(process.env as Record<string, string>), PRUSASLICER_DATADIR: copy },
      }),
    );
    const callCopy = async (name: string, args: Record<string, unknown>) => {
      const result = await other.callTool({ name, arguments: args });
      const text = (result.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("\n");
      return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
    };
    try {
      const check = await callCopy("update_profiles", {});
      assert.equal(check.isError, false, check.text);
      assert.equal(check.data.up_to_date, false);
      const prusa = check.data.regular_updates.find((entry: { vendor: string }) => entry.vendor === "PrusaResearch");
      assert.deepEqual([prusa.installed, prusa.recommended], [older, current]);

      const installed = await callCopy("update_profiles", { install: true });
      assert.equal(installed.isError, false, installed.text);
      assert.ok(installed.data.installed.includes(`PrusaResearch ${older} -> ${current} (regular_updates)`), JSON.stringify(installed.data));
      assert.equal(installed.data.still_pending, undefined);
      assert.match(await readFile(vendorFile, "utf8"), new RegExp(`^version: ${current.replace(/\./g, "\\.")}$`, "m"));
      assert.equal((await callCopy("update_profiles", {})).data.up_to_date, true);
    } finally {
      await other.close();
    }
  });

  test("no presets given: the open project's presets, or a refusal that says why", async () => {
    // 3.0 keeps no selection; an unsaved project open in its GUI (backup_projects) stands in for it.
    const status = await call("slicer_status");
    const result = await call("slice", { inputs: [join(dir, "cube.stl")], gcode_format: "ascii", output: join(dir, "no-presets.gcode") });
    if (status.data.selected_presets_from) {
      assert.equal(result.isError, false, result.text);
      assert.deepEqual(result.data.presets.filled_in_from_selection, ["printer", "print", "filament"]);
    } else {
      assert.equal(result.isError, true);
      assert.match(result.text, /keeps no selected presets/);
    }
  });

});
