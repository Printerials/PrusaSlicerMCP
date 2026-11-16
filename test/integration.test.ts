/**
 * End to end against the PrusaSlicer installed on this machine, through a real MCP client over
 * stdio. Skipped when PrusaSlicer is not found or has no printer selected. Writes only to a
 * temporary directory; the GUI is not touched (open_in_prusaslicer is left out on purpose).
 */
import assert from "node:assert/strict";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { locateSlicer } from "../src/slicer/locate.ts";
import { writeZip } from "./helpers/zip.ts";

const root = join(import.meta.dirname, "..");
const located = locateSlicer();
const skip = "error" in located ? `PrusaSlicer not found: ${located.error}` : false;

interface ToolResult {
  isError: boolean;
  text: string;
  data: any;
  images: number;
}

describe("against the installed PrusaSlicer", { skip }, () => {
  let client: Client;
  let dir: string;
  let printer: string;
  let prints: string[];
  let filament: string;

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const result = await client.callTool({ name, arguments: args });
    const parts = result.content as Array<{ type: string; text?: string }>;
    const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      // a refusal is plain text, optionally followed by a JSON line
    }
    return { isError: Boolean(result.isError), text, data, images: parts.filter((part) => part.type === "image").length };
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "prusaslicer-mcp-it-"));
    await copyFile(join(root, "test", "fixtures", "cube.stl"), join(dir, "cube.stl"));
    client = new Client({ name: "integration-test", version: "0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [join(root, "src", "index.ts")], stderr: "ignore", cwd: root }),
    );
  });

  after(async () => {
    await client?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("lists all tools with annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "connect_printerials",
      "create_filament_preset",
      "describe_setting",
      "disconnect_printerials",
      "edit_project",
      "export_model",
      "find_printerials_filament",
      "find_profiles",
      "gcode_info",
      "get_config",
      "install_profiles",
      "list_printers",
      "list_profiles",
      "list_spools",
      "model_info",
      "open_in_prusaslicer",
      "postprocess_gcode",
      "project_info",
      "record_spool_usage",
      "screenshot_prusaslicer",
      "slice",
      "slicer_status",
    ]);
    for (const tool of tools) assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
  });

  test("status, printers and profiles", async (t) => {
    const status = await call("slicer_status");
    assert.equal(status.isError, false, status.text);
    assert.match(status.data.slicer.version, /^\d+\.\d+\.\d+/);
    printer = status.data.selected_presets.printer;
    if (!printer) return t.skip("no printer selected in PrusaSlicer");

    const printers = await call("list_printers");
    assert.ok(printers.data.models.length > 0);

    const profiles = await call("list_profiles", { printer });
    assert.equal(profiles.isError, false, profiles.text);
    prints = profiles.data.print_profiles.map((print: { name: string }) => print.name);
    filament = profiles.data.filament_profiles_for_all_prints[0];
    assert.ok(prints.length > 1 && filament, "needs two print profiles and a shared filament");
  });

  test("get_config resolves and compares preset sets", async (t) => {
    if (!prints) return t.skip("no profiles");
    const byHeight = new Map(prints.map((name) => [name.match(/^(\d+\.\d+)mm/)?.[1], name]));
    const [a, b] = [...byHeight.values()];
    if (!a || !b) return t.skip("no two prints with different layer heights");

    const single = await call("get_config", { printer, print: a, filament, keys: ["layer_height", "nozzle_diameter"] });
    assert.equal(single.isError, false, single.text);
    assert.ok(single.data.total_keys > 300);
    assert.equal(single.data.values.layer_height, a.match(/^(\d+\.\d+)mm/)![1]!.replace(/0+$/, ""));

    const diff = await call("get_config", { printer, print: a, filament, compare_to: { print: b } });
    assert.ok(diff.data.differences.some((d: { key: string }) => d.key === "layer_height"));
  });

  test("a mistyped preset is refused with suggestions", async (t) => {
    if (!prints) return t.skip("no profiles");
    const result = await call("get_config", { printer, print: prints[0]!.replace(/ @.*/, "") + "X", filament });
    assert.equal(result.isError, true);
    assert.match(result.text, /did_you_mean/);
  });

  test("slice, analyse, insert a pause, keep existing files", async (t) => {
    if (!prints) return t.skip("no profiles");
    const output = join(dir, "cube.gcode");
    const sliced = await call("slice", {
      inputs: [join(dir, "cube.stl")],
      printer,
      print: prints[0],
      filament,
      gcode_format: "ascii",
      output,
      overrides: { fill_density: "30%" },
    });
    assert.equal(sliced.isError, false, sliced.text);
    assert.equal(sliced.data.output, output);
    assert.ok(sliced.data.result.time.normal_seconds > 0);
    assert.ok(sliced.data.result.layers.count > 10);

    const again = await call("slice", { inputs: [join(dir, "cube.stl")], printer, print: prints[0], filament, output });
    assert.equal(again.isError, true, "an existing output must not be replaced");
    assert.match(again.text, /already exists/);

    const edited = await call("postprocess_gcode", { path: output, inserts: [{ layer: 5, action: "pause" }] });
    assert.equal(edited.isError, false, edited.text);
    const info = await call("gcode_info", { path: edited.data.output, keys: ["fill_density"] });
    assert.equal(info.data.settings.fill_density, "30%");
    assert.deepEqual(info.data.events.map((e: { kind: string; layer: number }) => [e.kind, e.layer]), [["pause", 5]]);
  });

  test("a project's post-processing script does not run unless allowed", { skip: process.platform === "win32" }, async (t) => {
    if (!prints) return t.skip("no profiles");
    const marker = join(dir, "script-ran");
    const script = join(dir, "script.sh");
    await writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`);
    await chmod(script, 0o755);

    const config = await call("get_config", { printer, print: prints[0], filament, search: "post_process" });
    assert.equal(config.isError, false, config.text);
    const exported = await call("export_model", { inputs: [join(dir, "cube.stl")], format: "3mf", output: join(dir, "geometry.3mf") });
    assert.equal(exported.isError, false, exported.text);

    // A PrusaSlicer project: the exported geometry plus a print config that sets the script.
    const { ZipReader } = await import("../src/formats/zip.ts");
    const zip = await ZipReader.open(join(dir, "geometry.3mf"));
    const files: Record<string, Buffer | string> = {};
    for (const name of zip.entries.keys()) files[name] = (await zip.read(name))!;
    await zip.close();
    files["Metadata/Slic3r_PE.config"] = [
      `; printer_settings_id = ${printer}`,
      `; print_settings_id = ${prints[0]}`,
      `; filament_settings_id = "${filament}"`,
      `; post_process = ${script}`,
      "",
    ].join("\n");
    await writeZip(join(dir, "project.3mf"), files);

    const info = await call("project_info", { path: join(dir, "project.3mf") });
    assert.match(info.data.warning, /post-processing script/);

    const guarded = await call("slice", { inputs: [join(dir, "project.3mf")], output: join(dir, "project.gcode") });
    assert.equal(guarded.isError, false, guarded.text);
    assert.equal(guarded.data.presets.source, "project");
    assert.equal(existsSync(marker), false, "the script ran although it was not allowed");

    const allowed = await call("slice", { inputs: [join(dir, "project.3mf")], output: join(dir, "project2.gcode"), allow_post_process: true });
    assert.equal(allowed.isError, false, allowed.text);
    assert.equal(existsSync(marker), true, "allow_post_process did not run the script");

    // A project whose output_filename_format climbs out of the output directory. PrusaSlicer 2.9.7
    // follows it and replaces whatever file is there (verified with ../../victim.txt).
    await mkdir(join(dir, "downloads"), { recursive: true });
    await writeFile(join(dir, "victim.txt"), "my notes\n");
    files["Metadata/Slic3r_PE.config"] = [
      `; printer_settings_id = ${printer}`,
      `; print_settings_id = ${prints[0]}`,
      `; filament_settings_id = "${filament}"`,
      "; output_filename_format = ../../victim.txt",
      "",
    ].join("\n");
    await writeZip(join(dir, "downloads", "escape.3mf"), files);
    const escaped = await call("slice", { inputs: [join(dir, "downloads", "escape.3mf")] });
    assert.equal(escaped.isError, false, escaped.text);
    assert.equal(await readFile(join(dir, "victim.txt"), "utf8"), "my notes\n", "the project's output_filename_format wrote outside the output directory");
    assert.match(escaped.data.output, /\/downloads\/escape\.b?gcode$/);
  });

  test("find and install a profile, on a copy of the datadir", async (t) => {
    const status = await call("slicer_status");
    const datadir: string | null = status.data.slicer.datadir;
    if (!datadir || !printer) return t.skip("no datadir or no printer selected");

    // A second server on a copy: the real datadir and the GUI are not touched.
    const copy = join(dir, "datadir");
    await cp(datadir, copy, { recursive: true, filter: (source) => !source.endsWith(".lock") });
    const other = new Client({ name: "integration-test-copy", version: "0" });
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
      const found = await callCopy("find_profiles", { kind: "filament", printer, only_not_installed: true, limit: 1 });
      assert.equal(found.isError, false, found.text);
      const candidate: string | undefined = found.data.matches[0]?.name;
      if (!candidate) return t.skip("every fitting filament is installed already");

      const refused = await callCopy("get_config", { printer, filament: candidate, print: prints[0] });
      assert.equal(refused.isError, true);
      assert.match(refused.text, /not installed/);

      const dry = await callCopy("install_profiles", { install: [candidate], dry_run: true });
      assert.deepEqual(dry.data.installed, [candidate]);

      const done = await callCopy("install_profiles", { install: [candidate] });
      assert.equal(done.isError, false, done.text);
      assert.match(done.data.verified[candidate], /^listed for /);
      const listed = await callCopy("list_profiles", { printer, filter: candidate });
      assert.ok(JSON.stringify(listed.data).includes(candidate));

      // Switch a project to the new filament and change settings, as a user would in the GUI.
      const exported = await call("export_model", { inputs: [join(dir, "cube.stl")], format: "3mf", output: join(dir, "edit-geometry.3mf") });
      assert.equal(exported.isError, false, exported.text);
      const { ZipReader } = await import("../src/formats/zip.ts");
      const zip = await ZipReader.open(join(dir, "edit-geometry.3mf"));
      const files: Record<string, Buffer | string> = {};
      for (const name of zip.entries.keys()) files[name] = (await zip.read(name))!;
      await zip.close();
      const base = await callCopy("get_config", { printer, print: prints[0], filament, search: "fill" });
      files["Metadata/Slic3r_PE.config"] = [
        `; printer_settings_id = ${printer}`,
        `; print_settings_id = ${prints[0]}`,
        `; filament_settings_id = "${filament}"`,
        ...Object.entries(base.data.values as Record<string, string>).map(([key, value]) => `; ${key} = ${value}`),
        "",
      ].join("\n");
      await writeZip(join(dir, "edit.3mf"), files);

      const edited = await callCopy("edit_project", {
        path: join(dir, "edit.3mf"),
        filament: candidate,
        settings: { fill_density: "10%", fill_pattern: "lightning", infill_every_layers: 2, ensure_vertical_shell_thickness: "disabled" },
      });
      assert.equal(edited.isError, false, edited.text);
      assert.equal(edited.data.presets.after.filament, candidate);
      const sliced = await callCopy("slice", { inputs: [edited.data.output], output: join(dir, "edit.gcode") });
      assert.equal(sliced.isError, false, sliced.text);
      const settings = (await callCopy("gcode_info", { path: join(dir, "edit.gcode"), keys: ["fill_density", "fill_pattern", "infill_every_layers"] })).data.settings;
      assert.deepEqual(settings, { fill_density: "10%", fill_pattern: "lightning", infill_every_layers: "2" });

      const bad = await callCopy("edit_project", { path: join(dir, "edit.3mf"), settings: { fill_pattern: "lightnin" } });
      assert.equal(bad.isError, true, "a value PrusaSlicer replaces must be refused");
      assert.match(bad.text, /did not accept/);

      const removed = await callCopy("install_profiles", { uninstall: [candidate] });
      assert.deepEqual(removed.data.uninstalled, [candidate]);
      assert.equal(existsSync(join(copy, "PrusaSlicer.ini.mcp-backup")), true);
    } finally {
      await other.close();
    }
  });

  test("model_info and export_model", async () => {
    const info = await call("model_info", { inputs: [join(dir, "cube.stl")] });
    assert.deepEqual(info.data.models[0].size, [20, 20, 20]);
    const exported = await call("export_model", { inputs: [join(dir, "cube.stl")], format: "stl", transforms: { scale: "50%" } });
    assert.equal(exported.isError, false, exported.text);
    assert.deepEqual(exported.data.models[0].size, [10, 10, 10]);
    assert.notEqual(exported.data.outputs[0], join(dir, "cube.stl"), "must not replace the input");
    assert.ok((await readFile(join(dir, "cube.stl"))).length > 0);
  });
});
