import { z } from "zod";
import type { SettingInfo } from "../formats/help.ts";
import { splitList, type FlatConfig } from "../formats/ini.ts";
import { Refusal } from "../util/errors.ts";
import { suggest } from "../util/suggest.ts";

/**
 * Turning tool input into PrusaSlicer arguments. Valued options go as "--key=value": a value
 * that starts with "-" then cannot pass for an option. An empty value goes as two arguments,
 * "--key" "": PrusaSlicer 2.9 reads "--key=" as "take the next argument as the value", which
 * once made the model file the post-processing script.
 */

const xy = z.tuple([z.number(), z.number()]);

export const transformsSchema = z
  .object({
    rotate_z: z.number().optional().describe("Rotation around Z in degrees."),
    rotate_x: z.number().optional().describe("Rotation around X in degrees."),
    rotate_y: z.number().optional().describe("Rotation around Y in degrees."),
    scale: z.union([z.number().positive(), z.string().regex(/^\d+(\.\d+)?%$/)]).optional().describe("Factor (1.5) or percentage (\"150%\")."),
    scale_to_fit: z.tuple([z.number(), z.number(), z.number()]).optional().describe("Scale uniformly to fit this box, in mm."),
    center: xy.optional().describe("Center the print around this XY point, in mm."),
    align_xy: xy.optional().describe("Align the model to this XY point, in mm."),
    duplicate: z.number().int().min(1).max(500).optional().describe("Number of copies."),
    duplicate_grid: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional().describe("Copies in a grid of X by Y."),
    merge: z.boolean().optional().describe("Arrange all inputs on one plate as a single model."),
    split: z.boolean().optional().describe("Split unconnected parts into separate objects."),
    dont_arrange: z.boolean().optional().describe("Keep the original XY positions instead of arranging."),
    ensure_on_bed: z.boolean().optional().describe("Lift parts that are below the bed (default true)."),
  })
  .strict();

export type Transforms = z.infer<typeof transformsSchema>;

export function transformArgs(t: Transforms | undefined): string[] {
  if (!t) return [];
  const args: string[] = [];
  const valued = (name: string, value: string | number) => args.push(`--${name}=${value}`);
  if (t.rotate_z !== undefined) valued("rotate", t.rotate_z);
  if (t.rotate_x !== undefined) valued("rotate-x", t.rotate_x);
  if (t.rotate_y !== undefined) valued("rotate-y", t.rotate_y);
  if (t.scale !== undefined) valued("scale", t.scale);
  if (t.scale_to_fit) valued("scale-to-fit", t.scale_to_fit.join(","));
  if (t.center) valued("center", t.center.join(","));
  if (t.align_xy) valued("align-xy", t.align_xy.join(","));
  if (t.duplicate !== undefined && t.duplicate > 1) valued("duplicate", t.duplicate);
  if (t.duplicate_grid) valued("duplicate-grid", t.duplicate_grid.join(","));
  if (t.merge) args.push("--merge");
  if (t.split) args.push("--split");
  if (t.dont_arrange) args.push("--dont-arrange");
  if (t.ensure_on_bed === false) args.push("--no-ensure-on-bed");
  return args;
}

export const overridesSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .describe(
    "Settings to change for this run only, as config key to value: { \"fill_density\": \"25%\", \"brim_width\": 5, \"support_material\": true }. " +
      "Keys are those describe_setting knows. Lists (per extruder) are comma-separated. " +
      "When the filament profile overrides a key (filament_<key>), its override is set to the same value, as it would win otherwise; " +
      "filament_<key> sets only the filament's override.",
  );

export type Overrides = z.infer<typeof overridesSchema>;

/** Settings that run programs or change where output goes: never through overrides. */
const BLOCKED = new Set(["post_process", "output_filename_format"]);

/** Checks every key against PrusaSlicer's own catalogue, so a typo is caught before the CLI rejects it. */
export function checkOverrides(overrides: Overrides | undefined, catalog: ReadonlyMap<string, SettingInfo>): Map<string, string> {
  const checked = new Map<string, string>();
  for (const [rawKey, rawValue] of Object.entries(overrides ?? {})) {
    const key = rawKey.trim().replace(/^--/, "").replace(/-/g, "_");
    if (BLOCKED.has(key)) {
      throw new Refusal(`${key} cannot be set through overrides.${key === "post_process" ? " Post-processing scripts stay off unless allow_post_process is set, and then come from the presets." : ""}`);
    }
    if (!catalog.has(key)) throw new Refusal(`Unknown setting "${rawKey}".`, { did_you_mean: suggest(key, catalog.keys()) });
    // Values are left to PrusaSlicer to judge: some enums (filament_type) accept custom values.
    checked.set(key, typeof rawValue === "boolean" ? (rawValue ? "1" : "0") : String(rawValue));
  }
  return checked;
}

/** The overrides as 2.x command line options. 3.0 ignores those: see patchSavedConfig. */
export function overrideArgs(overrides: Overrides | undefined, catalog: ReadonlyMap<string, SettingInfo>): { args: string[]; keys: string[] } {
  const args: string[] = [];
  const checked = checkOverrides(overrides, catalog);
  for (const [key, value] of checked) {
    const cli = key.replace(/_/g, "-");
    if (value === "") args.push(`--${cli}`, "");
    else args.push(`--${cli}=${value}`);
  }
  return { args, keys: [...checked.keys()] };
}

/**
 * 2.x: a filament profile overrides some print and printer settings with filament_<key>, and a
 * value that is not "nil" wins. Buddy3D PETG @COREONE HF0.4 has filament_travel_ramping_lift = 1,
 * so --travel-ramping-lift=0 alone still slices with ramping lifts (2.9.7, 2026-11-19). An
 * override of <key> therefore also goes to filament_<key> when the resolved config has one set.
 */
export function filamentShadows(
  checked: ReadonlyMap<string, string>,
  config: FlatConfig,
  catalog: ReadonlyMap<string, SettingInfo>,
): { extra: Map<string, string>; notes: string[] } {
  const extra = new Map<string, string>();
  const notes: string[] = [];
  for (const [key, value] of checked) {
    const shadow = `filament_${key}`;
    if (key.startsWith("filament_") || checked.has(shadow) || !catalog.has(shadow)) continue;
    const current = config.get(shadow);
    if (current === undefined || splitList(current).every((item) => item === "nil" || item === "")) continue;
    extra.set(shadow, value);
    notes.push(`${key}: the filament profile overrides it (${shadow} = ${current}), so ${shadow} was set too.`);
  }
  return { extra, notes };
}
