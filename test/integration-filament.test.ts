/**
 * Filament presets from Spoolman and Printerials, end to end through an MCP client, against the
 * installed PrusaSlicer, on a copy of its datadir. Spoolman and Printerials are fakes on
 * 127.0.0.1 that answer as the real ones do (Spoolman v0.22; Printerials' slicer route as agreed
 * on 2026-11-16). Skipped without PrusaSlicer or a selected printer.
 */
import assert from "node:assert/strict";
import { copyFile, cp, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { locateSlicer } from "../src/slicer/locate.ts";
import { v2Backend } from "../src/slicer/v2.ts";

const root = join(import.meta.dirname, "..");
const located = locateSlicer();
const datadir = v2Backend.defaultDatadir();
const skip = "error" in located ? "PrusaSlicer not found" : !datadir ? "no PrusaSlicer datadir" : false;

const TOKEN = "pra_secret_test_token";

describe("filament presets from Spoolman and Printerials", { skip }, () => {
  let dir: string;
  let fake: Server;
  let port: number;
  let client: Client;
  const used: number[] = [];
  const agents = new Set<string>();
  const spool = {
    id: 1,
    remaining_weight: 2,
    initial_weight: 1000,
    spool_weight: 180,
    price: 20,
    filament: { id: 5, name: "PETG Black", material: "PETG", density: 1.27, diameter: 1.75, weight: 1000, color_hex: "000000", external_id: "printerials:variant/7767" },
  };
  const slicerData = (country: string | null) => ({
    variantId: 7767,
    materialId: 1132,
    material: { slug: "buddy3d-petg", name: "Buddy3d PETG", brand: "Buddy3d", type: { slug: "petg", name: "PETG" }, url: "https://printerials.com/materials/buddy3d-petg" },
    colour: { slug: "black", name: "Black", hex: "#000000", measured: false, url: "https://printerials.com/materials/buddy3d-petg/black" },
    diameters: [1.75],
    base: { prusaType: "PETG", orca: "Generic PETG @System" },
    stated: {
      nozzleTempC: { value: null, min: 220, max: 240, source: "Buddy3d", sourceUrl: null, method: null },
      bedTempC: { value: null, min: 70, max: 80, source: "Buddy3d", sourceUrl: null, method: null },
      densityGcm3: { value: 1.27, min: null, max: null, source: "Buddy3d", sourceUrl: null, method: null },
      chamberTempC: null,
      dryTempMaxC: null,
    },
    community: [],
    profiles: [],
    price: { country, currency: "EUR", headline: null, noHeadline: null, perKg: country ? 19.99 : null },
  });

  let printer: string;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("\n");
    assert.ok(!text.includes(TOKEN), `${name} leaked the Spoolman token`);
    return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "prusaslicer-mcp-filament-"));
    await copyFile(join(root, "test", "fixtures", "cube.stl"), join(dir, "cube.stl"));
    await cp(datadir!, join(dir, "datadir"), { recursive: true, filter: (source) => !source.endsWith(".lock") });

    fake = createServer((request, response) => {
      agents.add(request.headers["user-agent"] ?? "");
      const url = new URL(request.url ?? "/", "http://fake");
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const base = `/spoolman/${TOKEN}/api/v1/`;
        if (url.pathname === `${base}spool` && request.method === "GET") return send(200, [spool]);
        if (url.pathname === `${base}spool/1` && request.method === "GET") return send(200, spool);
        if (url.pathname === `${base}spool/1/use` && request.method === "PUT") {
          const grams = JSON.parse(body).use_weight as number;
          used.push(grams);
          spool.remaining_weight -= grams;
          return send(200, spool);
        }
        if (url.pathname === "/api/app/v1/catalogue/variants/7767/slicer") return send(200, slicerData(url.searchParams.get("to")));
        send(404, { message: "Not found" });
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    port = (fake.address() as { port: number }).port;

    client = new Client({ name: "integration-filament", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(root, "src", "index.ts")],
        stderr: "ignore",
        cwd: root,
        env: {
          ...(process.env as Record<string, string>),
          PRUSASLICER_DATADIR: join(dir, "datadir"),
          SPOOLMAN_URL: `http://127.0.0.1:${port}/spoolman/${TOKEN}`,
          PRINTERIALS_URL: `http://127.0.0.1:${port}`,
          PRINTERIALS_COUNTRY: "NL",
        },
      }),
    );
  });

  after(async () => {
    await client?.close();
    await new Promise((resolve) => fake?.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  test("status and spools, without the token", async (t) => {
    const status = await call("slicer_status");
    assert.deepEqual(status.data.spoolman, { configured: true, host: `127.0.0.1:${port}`, via: "SPOOLMAN_URL" });
    printer = status.data.selected_presets.printer;
    if (!printer) return t.skip("no printer selected");
    const spools = await call("list_spools");
    assert.equal(spools.data.spools[0].remaining_g, 2);
    assert.equal(spools.data.spools[0].catalogue_id, "printerials:variant/7767");
  });

  test("a preset from a spool linked to Printerials: the parent's config, the stated range, the spool's price", async (t) => {
    if (!printer) return t.skip("no printer selected");
    const dry = await call("create_filament_preset", { spool_id: 1, dry_run: true });
    if (dry.isError && /No "Generic PETG" profile fits/.test(dry.text)) return t.skip("no Generic PETG for this printer");
    assert.equal(dry.isError, false, dry.text);
    const name: string = dry.data.name;
    assert.match(name, /^Buddy3d PETG Black @/);
    assert.equal(dry.data.from.printerials.variant_id, 7767);

    const made = await call("create_filament_preset", { spool_id: 1 });
    assert.equal(made.isError, false, made.text);

    const keys = ["temperature", "bed_temperature", "filament_type", "filament_cost", "filament_max_volumetric_speed", "filament_vendor", "filament_density"];
    const parent = await call("get_config", { printer, filament: made.data.parent, keys });
    const ours = await call("get_config", { printer, filament: name, keys });
    assert.equal(ours.isError, false, ours.text);
    const clamp = (value: number, min: number, max: number) => String(Math.min(max, Math.max(min, value)));
    assert.equal(ours.data.values.temperature, clamp(Number(parent.data.values.temperature), 220, 240));
    assert.equal(ours.data.values.bed_temperature, clamp(Number(parent.data.values.bed_temperature), 70, 80));
    assert.equal(ours.data.values.filament_type, "PETG", "from the parent, not PrusaSlicer's default PLA");
    assert.equal(ours.data.values.filament_max_volumetric_speed, parent.data.values.filament_max_volumetric_speed);
    assert.equal(ours.data.values.filament_cost, "20", "what the spool cost beats the market price");
    assert.equal(ours.data.values.filament_vendor, "Buddy3d");

    const again = await call("create_filament_preset", { spool_id: 1 });
    assert.equal(again.isError, true);
    assert.match(again.text, /exists already/);

    // Slice with it from the spool: 2 g is not enough for a 20 mm cube.
    const sliced = await call("slice", { inputs: [join(dir, "cube.stl")], printer, filament: name, print: parent.data.presets.print, spool_id: 1 });
    assert.equal(sliced.isError, false, sliced.text);
    assert.equal(sliced.data.result.presets.filament[0], name);
    assert.equal(sliced.data.spool.enough, false);
    assert.match(sliced.data.messages[0], /has 2 g left; this print needs/);

    const recorded = await call("record_spool_usage", { spool_id: 1, grams: 1.5 });
    assert.equal(recorded.isError, false, recorded.text);
    assert.deepEqual(used, [1.5]);
    assert.ok([...agents].every((agent) => agent.startsWith("PrusaSlicerMCP/")), [...agents].join(", "));
  });
});
