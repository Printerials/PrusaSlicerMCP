import type { McpServer } from "@modelcontextprotocol/server";
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Presets } from "../context.ts";
import { splitList, unescapeValue } from "../formats/ini.ts";
import { planFilamentPreset, renderPreset, validPresetName, type StatedFilament } from "../slicer/filament-preset.ts";
import { bundleFilamentValue } from "../slicer/installed.ts";
import type { PrinterialsAccount } from "../printerials/account.ts";
import { PrinterialsClient, statedFromPrinterials, variantFromExternalId } from "../printerials/client.ts";
import { prusaTypeOf, spoolLabel, SpoolmanClient, SpoolmanError, spoolPricePerKg, type SpoolmanSpool } from "../spoolman/client.ts";
import { readGcode } from "../formats/gcode.ts";
import { Refusal } from "../util/errors.ts";
import { requireFile } from "../util/paths.ts";
import { suggest } from "../util/suggest.ts";
import { capList, json, READ_ONLY, tool, type ToolDeps } from "./common.ts";

const figure = z.union([z.number(), z.tuple([z.number(), z.number()])]);

/** SPOOLMAN_URL when set (explicit configuration goes first), else the connected Printerials account. */
export async function spoolman(account: PrinterialsAccount): Promise<SpoolmanClient> {
  const fromEnv = SpoolmanClient.fromEnv();
  if (fromEnv) return fromEnv;
  if (await account.isConnected()) return new SpoolmanClient(account.spoolmanBase, { auth: account, via: "Printerials account" });
  throw new Refusal(
    "No spools to read: connect_printerials links the user's Printerials account (sign-in in the browser). " +
      "A self-hosted Spoolman: set SPOOLMAN_URL (http://host:7912) in this MCP server's environment.",
  );
}

/** What a spool tells about its filament, in the source-independent form. */
export function statedFromSpool(spool: SpoolmanSpool): StatedFilament {
  const f = spool.filament;
  return {
    vendor: f.vendor?.name,
    type: prusaTypeOf(f.material),
    colour: f.color_hex ? `#${f.color_hex.replace(/^#/, "").slice(0, 6)}` : undefined,
    diameter: f.diameter,
    density: f.density,
    nozzle: f.settings_extruder_temp ? { value: f.settings_extruder_temp, source: "spool" } : undefined,
    bed: f.settings_bed_temp ? { value: f.settings_bed_temp, source: "spool" } : undefined,
    costPerKg: spoolPricePerKg(spool),
    spoolWeight: spool.spool_weight ?? f.spool_weight,
    notes: `From Spoolman spool ${spool.id}${f.external_id ? ` (${f.external_id})` : ""}.`,
  };
}

export function registerFilament(server: McpServer, { slicer, account }: ToolDeps): void {
  const printerials = new PrinterialsClient();

  tool(
    server,
    "find_printerials_filament",
    {
      title: "Find a filament on Printerials",
      description:
        "Search Printerials' catalogue of filaments (printerials.com): lines and their colours, with the variant id that create_filament_preset " +
        "takes to build a PrusaSlicer profile from the maker's stated temperatures and density (and, with a country, the price delivered there).",
      inputSchema: z.object({
        search: z.string().min(2).describe("Brand and line, such as 'buddy3d petg' or 'polymaker polylite pla'."),
        colour: z.string().optional().describe("Only colours whose name contains this text."),
        include_discontinued: z.boolean().default(false),
        lines: z.number().int().min(1).max(10).default(3).describe("How many matching lines to expand into colours."),
      }),
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    async ({ search, colour, include_discontinued, lines }) => {
      const found = await printerials.searchLines(search);
      const wanted = colour?.toLowerCase();
      const expanded = await Promise.all(
        found.slice(0, lines).map(async (line) => {
          const colours = (await printerials.colours(line.id))
            .filter((c) => include_discontinued || !c.isDiscontinued)
            .filter((c) => !wanted || c.colour.toLowerCase().includes(wanted))
            .map((c) => ({ variant_id: c.variantId, colour: c.colour, hex: c.measuredHex ?? c.hex, discontinued: c.isDiscontinued || undefined }));
          return { material_id: line.id, name: line.name, brand: line.brand, type: line.type, colours };
        }),
      );
      return json({
        source: new URL(printerials.base).host,
        lines: expanded,
        more_lines: found.length > lines ? found.slice(lines).map((line) => ({ material_id: line.id, name: line.name, type: line.type })) : undefined,
      });
    },
  );
  tool(
    server,
    "list_spools",
    {
      title: "List spools",
      description:
        "The user's spools: from their Printerials shelf (connect_printerials) or a Spoolman server (SPOOLMAN_URL). Filament, colour, grams left " +
        "(as weighed, for a Printerials Scale), price per kg and location.",
      inputSchema: z.object({
        search: z.string().optional().describe("Words that must all appear in vendor, filament, material, colour or location."),
        include_archived: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    async ({ search, include_archived, limit }) => {
      const client = await spoolman(account);
      const words = (search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const rows = (await client.listSpools(include_archived))
        .map((spool) => ({
          id: spool.id,
          filament: spoolLabel(spool),
          material: spool.filament.material,
          colour: spool.filament.color_hex ? `#${spool.filament.color_hex.replace(/^#/, "")}` : undefined,
          remaining_g: spool.remaining_weight !== undefined ? Math.round(spool.remaining_weight) : undefined,
          used_g: spool.used_weight !== undefined ? Math.round(spool.used_weight) : undefined,
          price_per_kg: spoolPricePerKg(spool),
          diameter: spool.filament.diameter,
          location: spool.location,
          last_used: spool.last_used,
          archived: spool.archived || undefined,
          catalogue_id: spool.filament.external_id,
        }))
        .filter((row) => words.every((word) => JSON.stringify(row).toLowerCase().includes(word)));
      const capped = capList(rows, limit);
      return json({ source: { host: client.host, via: client.via }, spools: capped.items, total: capped.total, truncated: capped.truncated || undefined });
    },
  );

  tool(
    server,
    "create_filament_preset",
    {
      title: "Create a filament preset",
      description:
        "Create a PrusaSlicer filament preset for a filament without an official profile: from a Spoolman spool, or from values you give " +
        "(temperatures, density, diameter, price, colour). It is the full config of the matching Prusa profile for the printer " +
        "(Generic <type> for that nozzle), with the stated values laid over it; temperatures keep the tuned value when it lies in a stated range. " +
        "PrusaSlicer checks the result before it is kept. Usable at once by slice; the GUI shows it after a restart.",
      inputSchema: z.object({
        printer: z.string().optional().describe("Printer preset to make it for. Defaults to the selected one."),
        spool_id: z.number().int().optional().describe("Take the filament from this Spoolman spool."),
        printerials_variant_id: z.number().int().optional().describe("Take the filament from Printerials (find_printerials_filament gives the id)."),
        country: z.string().length(2).optional().describe("Delivery country for a Printerials price. Default: PRINTERIALS_COUNTRY."),
        currency: z.string().length(3).optional().describe("Currency for that price. Default: PRINTERIALS_CURRENCY, else EUR."),
        type: z.string().optional().describe("PrusaSlicer filament_type (PLA, PETG, ABS, ASA, FLEX, PC, PA...), when no spool says it."),
        parent: z.string().optional().describe("The filament preset to build on. Default: Generic <type> for the printer."),
        name: z.string().optional().describe("Preset name. Default: <vendor> <filament> @<printer part of the parent's name>."),
        values: z
          .object({
            vendor: z.string().optional(),
            colour: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
            diameter: z.number().positive().optional(),
            density: z.number().positive().optional(),
            nozzle_temp: figure.optional().describe("°C, or [min, max] as the maker states it."),
            first_layer_nozzle_temp: figure.optional(),
            bed_temp: figure.optional(),
            first_layer_bed_temp: figure.optional(),
            chamber_temp: figure.optional(),
            max_volumetric_speed: z.number().positive().optional(),
            cost_per_kg: z.number().nonnegative().optional(),
            notes: z.string().max(2000).optional(),
          })
          .optional()
          .describe("Stated values; they win over the spool's."),
        overwrite: z.boolean().default(false),
        dry_run: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const info = await slicer.info();
      if (info.backend.major >= 3) throw new Refusal("Creating filament presets is supported for PrusaSlicer 2.x only, so far.");
      if (!info.datadir) throw new Refusal("PrusaSlicer's data directory was not found.");

      const state = await slicer.appState();
      const printer = args.printer ?? state.presets.printer;
      if (!printer) throw new Refusal("Give a printer: none is selected in PrusaSlicer.");

      // What the sources state, weakest first: Printerials' catalogue (stated by makers, with
      // sources and ranges), then the spool (what this user has: diameter, colour, what it cost),
      // then the caller's values. A spool linked to Printerials brings its catalogue entry along.
      const spools = args.spool_id !== undefined ? await spoolman(account) : null;
      const spool = spools ? await spools.getSpool(args.spool_id!) : null;
      const variantId = args.printerials_variant_id ?? variantFromExternalId(spool?.filament.external_id);
      const country = args.country ?? process.env.PRINTERIALS_COUNTRY;
      const currency = args.currency ?? process.env.PRINTERIALS_CURRENCY ?? "EUR";
      const catalogue = variantId !== null ? await printerials.slicer(variantId, country, currency) : null;
      if (catalogue && !catalogue.base) {
        throw new Refusal(`Printerials has no slicer basis for ${catalogue.material.name} (type ${catalogue.material.type?.name ?? "unknown"}): no profile is made for it.`);
      }
      const stated: StatedFilament = {
        ...(catalogue ? statedFromPrinterials(catalogue, spool?.filament.diameter, Boolean(country)) : {}),
      };
      if (spool) {
        const fromSpool = statedFromSpool(spool);
        for (const [key, value] of Object.entries(fromSpool) as Array<[keyof StatedFilament, unknown]>) {
          if (value === undefined) continue;
          // With a catalogue entry, its sourced temperatures and density stand; the spool adds the rest.
          if (catalogue && ["nozzle", "bed", "density", "type", "vendor"].includes(key) && stated[key] !== undefined) continue;
          if (key === "notes" && stated.notes) {
            stated.notes = `${stated.notes}\n${value as string}`;
            continue;
          }
          (stated as Record<string, unknown>)[key] = value;
        }
      }
      const v = args.values ?? {};
      const asFigure = (value: number | [number, number] | undefined) =>
        value === undefined ? undefined : Array.isArray(value) ? { min: Math.min(...value), max: Math.max(...value) } : { value };
      Object.assign(
        stated,
        Object.fromEntries(
          Object.entries({
            vendor: v.vendor,
            colour: v.colour,
            diameter: v.diameter,
            density: v.density,
            nozzle: asFigure(v.nozzle_temp),
            firstLayerNozzle: asFigure(v.first_layer_nozzle_temp),
            bed: asFigure(v.bed_temp),
            firstLayerBed: asFigure(v.first_layer_bed_temp),
            chamber: asFigure(v.chamber_temp),
            maxVolumetricSpeed: v.max_volumetric_speed,
            costPerKg: v.cost_per_kg,
            notes: v.notes,
            type: args.type?.toUpperCase(),
          }).filter(([, value]) => value !== undefined),
        ),
      );

      // The parent: the generic of that polymer fitting this printer, as PrusaSlicer decides fitting.
      const fitting = await slicer.availableFilaments(printer);
      let parent = args.parent;
      if (!parent) {
        if (!stated.type) throw new Refusal("Say which polymer it is (type: PLA, PETG, ...), or name a parent preset.");
        const escaped = stated.type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const candidates = fitting.filter((name) => new RegExp(`^Generic ${escaped}( @|$)`, "i").test(name));
        parent = candidates.find((name) => !/@Template$/.test(name)) ?? candidates[0];
        if (!parent) {
          throw new Refusal(`No "Generic ${stated.type}" profile fits ${printer}. Name a parent preset.`, {
            generics_that_fit: fitting.filter((name) => name.startsWith("Generic ")).slice(0, 30),
          });
        }
      } else if (!fitting.includes(parent)) {
        throw new Refusal(`"${parent}" is not a filament profile that fits ${printer}.`, { did_you_mean: suggest(parent, fitting) });
      }

      // The parent's full config for this printer. It must be installed to resolve against the real datadir.
      const listing = await slicer.profiles(printer);
      if (!listing.prints.some((p) => p.filaments.includes(parent!))) {
        throw new Refusal(`The parent "${parent}" is not installed. install_profiles can enable it (PrusaSlicer closed), then call again.`);
      }
      const print = listing.prints.find((p) => p.name === state.presets.print && p.filaments.includes(parent!))?.name ?? listing.prints.find((p) => p.filaments.includes(parent!))?.name;
      if (!print) throw new Refusal(`No print profile of ${printer} fits "${parent}".`);
      const parentConfig = await slicer.resolveConfig({ printer, print, filament: parent });

      const bundles = await slicer.bundles();
      const bundle = bundles.find((b) => b.filamentSections.has(parent!));
      const fromBundle = (key: string) => (bundle ? (bundleFilamentValue(bundle, parent!, key) ?? "") : "");
      const cumulative = splitList(parentConfig.get("compatible_printers_condition_cummulative") ?? "");
      const compat = {
        // The bundle has the parent's own condition; the resolved config only as the second entry
        // of compatible_printers_condition_cummulative (print first, filament second).
        printersCondition: fromBundle("compatible_printers_condition") || (cumulative[1] ?? ""),
        printsCondition: fromBundle("compatible_prints_condition"),
        printers: fromBundle("compatible_printers"),
        prints: fromBundle("compatible_prints"),
      };

      const plan = planFilamentPreset(parentConfig, parent, compat, stated);
      const suffix = parent.includes("@") ? parent.slice(parent.indexOf("@")) : `@${printer}`;
      const base = catalogue
        ? [catalogue.material.name, catalogue.colour?.name].filter(Boolean).join(" ")
        : [stated.vendor, spool?.filament.name ?? (stated.type ? `${stated.type}` : undefined)].filter(Boolean).join(" ");
      const name = args.name ?? `${base || "Custom filament"} ${suffix}`.replace(/\s+/g, " ").trim();
      if (!validPresetName(name)) throw new Refusal(`"${name}" cannot be a preset name: no / \\ : * ? " < > | and no trailing dot.`);
      if (bundles.some((b) => b.filaments.has(name))) throw new Refusal(`"${name}" is the name of an official profile. Choose another name.`);

      const dir = join(info.datadir, "filament");
      const file = join(dir, `${name}.ini`);
      const exists = existsSync(file);
      if (exists && !args.overwrite) throw new Refusal(`A filament preset "${name}" exists already. Pass overwrite: true to replace it, or another name.`);

      const summary = {
        name,
        printer,
        parent,
        file,
        from: {
          spool: spool ? { id: spool.id, filament: spoolLabel(spool), source: spools!.via } : undefined,
          printerials: catalogue
            ? {
                variant_id: catalogue.variantId,
                url: catalogue.colour?.url ?? catalogue.material.url,
                price: country && catalogue.price?.perKg != null ? { per_kg: catalogue.price.perKg, currency: catalogue.price.currency, country: catalogue.price.country } : undefined,
                community: catalogue.community?.length ? catalogue.community : undefined,
              }
            : undefined,
          values: args.values ? Object.keys(args.values) : undefined,
        },
        set: plan.decisions,
        note_price: catalogue && !country ? "No price: set PRINTERIALS_COUNTRY (or give country) for the price delivered in your country." : undefined,
      };
      if (args.dry_run) return json({ dry_run: true, ...summary });

      await mkdir(dir, { recursive: true });
      const origin = [catalogue ? `Printerials variant ${catalogue.variantId}` : null, spool ? `Spoolman spool ${spool.id}` : null].filter(Boolean).join(" and ") || "stated values";
      await writeFile(file, renderPreset(plan.values, `generated by prusaslicer-mcp from ${origin} on ${parent}`), "utf8");
      slicer.invalidate();

      // PrusaSlicer has to find it, fit it to the printer, and read back what was set.
      try {
        const check: Presets = { printer, print, filament: name };
        const completed = await slicer.completePresets(check);
        const resolved = await slicer.resolveConfig(completed);
        const off = plan.decisions.filter(({ key, value }) => {
          const got = resolved.get(key);
          return got !== undefined && unescapeValue(got) !== unescapeValue(value);
        });
        if (off.length) throw new Refusal("PrusaSlicer read other values than were written.", { mismatches: off.map(({ key, value }) => ({ key, written: value, read: resolved.get(key) })) });
      } catch (error) {
        if (!exists) await unlink(file).catch(() => undefined);
        throw error;
      }

      return json({ ...summary, note: "slice can use it now. PrusaSlicer's GUI lists it after a restart." });
    },
  );

  tool(
    server,
    "record_spool_usage",
    {
      title: "Record filament used",
      description:
        "Subtract the filament a print used from a spool (Printerials shelf or Spoolman), from a G-code file's own figure or a number of grams. " +
        "Only after the user confirmed the print was actually made: it changes their inventory.",
      inputSchema: z.object({
        spool_id: z.number().int(),
        grams: z.number().positive().max(10_000).optional(),
        gcode: z.string().optional().describe("Absolute path of the printed G-code; its total filament weight is used."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ spool_id, grams, gcode }) => {
      if ((grams === undefined) === (gcode === undefined)) throw new Refusal("Give either grams or gcode.");
      let used = grams;
      if (gcode) {
        const { report } = await readGcode(await requireFile(gcode, [".gcode", ".bgcode", ".gco", ".g"]));
        used = report.filament.total_g ?? undefined;
        if (!used) throw new Refusal("The G-code does not say how much filament it uses.");
      }
      const client = await spoolman(account);
      // Reading the spool first needs shelf:read; a Printerials connection may have only usage:write.
      const before = await client.getSpool(spool_id).catch((error: unknown) => {
        if (error instanceof SpoolmanError && error.status === 403) return null;
        throw error;
      });
      const after = await client.useSpool(spool_id, used!);
      const left = (spool: SpoolmanSpool | null) => (spool?.remaining_weight !== undefined ? Math.round(spool.remaining_weight) : null);
      return json({
        spool: spool_id,
        filament: (after ?? before ? spoolLabel((after ?? before)!) : "") || undefined,
        used_g: used,
        remaining_g: { before: left(before), after: left(after) },
        source: { host: client.host, via: client.via },
      });
    },
  );
}
