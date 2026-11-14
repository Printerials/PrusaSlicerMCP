import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { SettingInfo } from "../formats/help.ts";
import type { FlatConfig } from "../formats/ini.ts";
import { Refusal } from "../util/errors.ts";
import { suggest } from "../util/suggest.ts";
import { capList, json, MAX_TEXT, READ_ONLY, tool, type ToolDeps } from "./common.ts";

/** The settings shown when get_config is asked for no keys: what decides how a print turns out. */
const CORE_KEYS = [
  "printer_model",
  "nozzle_diameter",
  "bed_shape",
  "max_print_height",
  "gcode_flavor",
  "binary_gcode",
  "layer_height",
  "first_layer_height",
  "perimeters",
  "top_solid_layers",
  "bottom_solid_layers",
  "fill_density",
  "fill_pattern",
  "infill_anchor",
  "seam_position",
  "perimeter_generator",
  "support_material",
  "support_material_auto",
  "support_material_style",
  "support_material_buildplate_only",
  "brim_width",
  "skirts",
  "ironing",
  "perimeter_speed",
  "external_perimeter_speed",
  "infill_speed",
  "travel_speed",
  "max_volumetric_speed",
  "filament_type",
  "filament_vendor",
  "temperature",
  "first_layer_temperature",
  "bed_temperature",
  "first_layer_bed_temperature",
  "filament_max_volumetric_speed",
  "filament_density",
  "filament_cost",
  "retract_length",
  "fan_always_on",
  "max_fan_speed",
  "wipe_tower",
  "complete_objects",
];

const presetShape = {
  printer: z.string().describe("Printer preset name, exactly as list_printers shows it. Defaults to the one selected in PrusaSlicer."),
  print: z.string().describe("Print preset name, from list_profiles. Defaults to the selected one when it fits the printer."),
  filament: z.string().describe("Filament preset name, from list_profiles. Defaults to the selected one when it fits."),
};

export function registerProfiles(server: McpServer, { slicer }: ToolDeps): void {
  tool(
    server,
    "list_printers",
    {
      title: "List printers",
      description:
        "Printer presets installed in PrusaSlicer: vendor models with their variants (nozzles) and bed size, plus your own printer presets " +
        "and physical printers. Only what was installed through the Configuration Wizard is listed.",
      inputSchema: z.object({
        technology: z.enum(["FFF", "SLA"]).default("FFF").describe("FFF (filament) or SLA (resin)."),
      }),
      annotations: READ_ONLY,
    },
    async ({ technology }) => {
      const [models, user, physical] = await Promise.all([
        slicer.printerModels(technology),
        slicer.userPresets("printer"),
        slicer.userPresets("physical_printer"),
      ]);
      return json({
        models: models.map((model) => ({
          vendor: model.vendor,
          model: model.name,
          id: model.id,
          variants: model.variants.map((variant) => ({
            variant: variant.name || undefined,
            presets: variant.profiles.map((profile) => ({
              name: profile.name,
              extruders: profile.extruders,
              bed: profile.bed ? `${profile.bed.width}x${profile.bed.height}x${profile.bed.maxHeight} mm` : undefined,
            })),
          })),
        })),
        user_printer_presets: user.map((preset) => ({ name: preset.name, inherits: preset.inherits })),
        physical_printers: physical.map((preset) => preset.name),
      });
    },
  );

  tool(
    server,
    "list_profiles",
    {
      title: "List print and filament profiles",
      description:
        "The print profiles (layer height and quality) and filament profiles compatible with one printer preset, as PrusaSlicer itself decides " +
        "compatibility. Includes your own presets.",
      inputSchema: z.object({ printer: presetShape.printer.optional(), filter: z.string().optional().describe("Only names containing this text (case-insensitive).") }),
      annotations: READ_ONLY,
    },
    async ({ printer, filter }) => {
      const state = await slicer.appState();
      const name = printer ?? state.presets.printer;
      if (!name) throw new Refusal("No printer given and none is selected in PrusaSlicer. list_printers shows the installed ones.");
      const printers = await slicer.printerNames();
      if (!printers.includes(name)) {
        throw new Refusal(`Printer preset "${name}" is not installed.`, { did_you_mean: suggest(name, printers) });
      }
      const listing = await slicer.profiles(name);
      const match = (value: string) => !filter || value.toLowerCase().includes(filter.toLowerCase());

      // Most prints share one filament list; only the exceptions get their own.
      const counts = new Map<string, number>();
      for (const print of listing.prints) for (const filament of print.filaments) counts.set(filament, (counts.get(filament) ?? 0) + 1);
      const common = [...counts.entries()].filter(([, count]) => count === listing.prints.length).map(([filament]) => filament);
      const commonSet = new Set(common);

      const prints = listing.prints
        .filter((print) => match(print.name) || print.filaments.some(match))
        .map((print) => {
          const extra = print.filaments.filter((filament) => !commonSet.has(filament));
          return extra.length ? { name: print.name, also_filaments: extra.filter(match) } : { name: print.name };
        });
      return json({
        printer: name,
        print_profiles: prints,
        filament_profiles_for_all_prints: common.filter(match),
        selected: state.presets.printer === name ? { print: state.presets.print, filament: state.presets.filament } : undefined,
      });
    },
  );

  tool(
    server,
    "get_config",
    {
      title: "Resolved configuration",
      description:
        "The complete configuration PrusaSlicer builds from a printer, print and filament preset (inheritance and conditions resolved by PrusaSlicer). " +
        "Without keys or search: the settings that matter most. With compare_to: only the settings that differ between the two sets, " +
        "for example two print profiles or two filaments.",
      inputSchema: z.object({
        printer: presetShape.printer.optional(),
        print: presetShape.print.optional(),
        filament: presetShape.filament.optional(),
        keys: z.array(z.string()).optional().describe("Config keys to return, such as layer_height or fill_density."),
        search: z.string().optional().describe("Return the keys whose name or description contains this text, such as 'seam' or 'bridge'."),
        compare_to: z
          .object({ printer: z.string().optional(), print: z.string().optional(), filament: z.string().optional() })
          .optional()
          .describe("A second preset set; fields left out are the same as the first."),
      }),
      annotations: READ_ONLY,
    },
    async ({ printer, print, filament, keys, search, compare_to }) => {
      const a = await slicer.completePresets({ printer, print, filament });
      const configA = await slicer.resolveConfig(a);

      if (compare_to) {
        const b = await slicer.completePresets({
          printer: compare_to.printer ?? a.printer,
          print: compare_to.print ?? (compare_to.printer ? undefined : a.print),
          filament: compare_to.filament ?? (compare_to.printer ? undefined : a.filament),
        });
        const configB = await slicer.resolveConfig(b);
        const ignore = new Set(["printer_settings_id", "print_settings_id", "filament_settings_id", "inherits", "inherits_cummulative"]);
        const diff: Array<{ key: string; a: string | null; b: string | null }> = [];
        for (const key of new Set([...configA.keys(), ...configB.keys()])) {
          if (ignore.has(key) || key.startsWith("compatible_")) continue;
          const va = configA.get(key) ?? null;
          const vb = configB.get(key) ?? null;
          if (va !== vb && (!keys || keys.includes(key))) diff.push({ key, a: clip(va), b: clip(vb) });
        }
        diff.sort((x, y) => x.key.localeCompare(y.key));
        const capped = capList(diff, 150);
        return json({
          a: { printer: a.printer, print: a.print, filament: a.filament },
          b: { printer: b.printer, print: b.print, filament: b.filament },
          differences: capped.items,
          total_differences: capped.total,
          truncated: capped.truncated || undefined,
        });
      }

      let selected: string[];
      if (keys?.length) {
        selected = keys;
      } else if (search) {
        const catalog = await slicer.catalog().catch(() => new Map<string, SettingInfo>());
        const needle = search.toLowerCase();
        selected = [...configA.keys()].filter(
          (key) => key.includes(needle.replace(/\s+/g, "_")) || catalog.get(key)?.description.toLowerCase().includes(needle),
        );
      } else {
        selected = CORE_KEYS.filter((key) => configA.has(key));
      }

      const values = pick(configA, selected);
      const unknown = keys?.filter((key) => !configA.has(key));
      return json({
        presets: { printer: a.printer, print: a.print, filament: a.filament, filled_in_from_selection: a.filledIn.length ? a.filledIn : undefined },
        total_keys: configA.size,
        values: values.values,
        truncated: values.truncated || undefined,
        unknown_keys: unknown?.length ? unknown : undefined,
      });
    },
  );

  tool(
    server,
    "describe_setting",
    {
      title: "Describe a setting",
      description:
        "What a PrusaSlicer setting does: category, type, unit, allowed values, default and PrusaSlicer's own description. " +
        "Look up a key, or search the descriptions ('which setting controls the seam?'). Covers every setting slice accepts as an override.",
      inputSchema: z.object({
        key: z.string().optional().describe("Config key, such as fill_pattern."),
        search: z.string().optional().describe("Text to find in keys and descriptions."),
      }),
      annotations: READ_ONLY,
    },
    async ({ key, search }) => {
      const catalog = await slicer.catalog();
      if (key) {
        const entry = catalog.get(key.trim().replace(/^--/, "").replace(/-/g, "_"));
        if (entry) return json(entry);
        const near = [...catalog.keys()].filter((candidate) => candidate.includes(key) || key.includes(candidate)).slice(0, 10);
        return json({ error: `No setting "${key}" in PrusaSlicer's catalogue.`, similar_keys: near });
      }
      if (!search) return json({ categories: [...new Set([...catalog.values()].map((entry) => entry.category))], total: catalog.size });
      const words = search.toLowerCase().split(/\s+/).filter(Boolean);
      const scored = [...catalog.values()]
        .map((entry) => {
          const haystack = `${entry.key} ${entry.description}`.toLowerCase();
          const score = words.reduce((sum, word) => sum + (entry.key.includes(word) ? 3 : 0) + (haystack.includes(word) ? 1 : 0), 0);
          return { entry, score };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score);
      const capped = capList(scored.map(({ entry }) => entry), 15);
      return json({ matches: capped.items, total: capped.total, truncated: capped.truncated || undefined });
    },
  );
}

function clip(value: string | null, max = 300): string | null {
  if (value === null || value.length <= max) return value;
  return `${value.slice(0, max)}… (${value.length} chars)`;
}

/** The requested keys with their values, kept under the size limit. */
function pick(config: FlatConfig, keys: string[]): { values: Record<string, string>; truncated: boolean } {
  const values: Record<string, string> = {};
  let size = 0;
  for (const key of keys) {
    const value = config.get(key);
    if (value === undefined) continue;
    const shown = clip(value, keys.length > 20 ? 300 : 4000)!;
    size += key.length + shown.length + 6;
    if (size > MAX_TEXT) return { values, truncated: true };
    values[key] = shown;
  }
  return { values, truncated: false };
}
