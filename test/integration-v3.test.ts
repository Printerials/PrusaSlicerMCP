/**
 * End to end against a PrusaSlicer 3.x, through a real MCP client over stdio. Runs only when the
 * located PrusaSlicer is 3.x (set PRUSASLICER_PATH to the 3.0 app). Writes only to a temporary
 * directory. Checked against 3.0.0-alpha14, where settings given as options are ignored without
 * an error: these tests would fail if the server went back to passing them that way.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { locateSlicer } from "../src/slicer/locate.ts";

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

  test("overrides reach the G-code, and are confirmed from its config block", async (t) => {
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

  test("binary G-code is refused where the CLI cannot write it, and no wrongly named file is left", async (t) => {
    if (!filament) return t.skip("no profiles");
    const output = join(dir, "binary.bgcode");
    const result = await call("slice", { inputs: [join(dir, "cube.stl")], printer, print, filament, output });
    if (!result.isError) return t.skip("this 3.x writes binary G-code");
    assert.match(result.text, /Binary G-code was asked for/);
    assert.equal(await stat(output).then(() => true, () => false), false);
  });

  test("no presets given: 3.0 keeps no selection, so it says so", async () => {
    const result = await call("slice", { inputs: [join(dir, "cube.stl")] });
    assert.equal(result.isError, true);
    assert.match(result.text, /does not keep its selected presets/);
  });
});
