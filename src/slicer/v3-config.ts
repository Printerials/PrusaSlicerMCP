import type { SettingInfo } from "../formats/help.ts";
import { Refusal } from "../util/errors.ts";
import { sameJson, type AppliedCheck } from "./verify.ts";

/**
 * Changing settings for PrusaSlicer 3.0.
 *
 * Verified against 3.0.0-alpha14 (2026-11-17): the CLI ignores settings given as options
 * (--thick-bridges=1 exits 0 and changes nothing), and ignores a second --load or one next to
 * presets. What works is one complete config in the format --save writes, given with --load.
 * So the server saves the config of the presets (or of the project), changes values in it and
 * slices with that file.
 *
 * Value shapes in that file (seen in alpha14):
 * - Percentage and FloatOrPercentage: {"value": 15.0, "is_percent": true}.
 * - Filament settings are lists with one value per tool, whatever the schema says ("temperature": [230]).
 * - print_settings and printer_settings hold plain values; list settings are arrays.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Section = Record<string, Json>;

const SECTIONS = ["print_settings", "printer_settings", "filament_settings", "toolprint_settings"];

/** One value written into one section of the saved config. */
export interface PatchTarget {
  section: string;
  key: string;
  value: Json;
  /** What the section held before; undefined when the key was added. */
  previous: Json | undefined;
}

export interface PatchResult {
  config: string;
  /** Per requested key, every place its value was written. */
  targets: Map<string, PatchTarget[]>;
  /** What the caller should be told: layers changed besides the one asked for. */
  notes: string[];
}

/**
 * A change goes to every layer that holds the setting, so the value asked for is the one that
 * slices. In 3.0 a filament (or tool) profile overrides a print setting by keeping the same key in
 * filament_settings, and that override wins: with Buddy3D PETG, travel_ramping_lift false in
 * print_settings alone still sliced with ramping lifts, because filament_settings had [true]
 * (measured with a 3DBenchy, 2026-11-19). "filament_<key>", the 2.x name, sets the filament layer
 * only, and adds the key there when the filament did not override it.
 */
export function patchSavedConfig(
  savedConfig: string,
  changes: ReadonlyMap<string, string>,
  catalog: ReadonlyMap<string, SettingInfo>,
): PatchResult {
  const saved = JSON.parse(savedConfig) as { configuration?: Record<string, Section> };
  const configuration = saved.configuration;
  if (!configuration) throw new Refusal("PrusaSlicer saved a configuration without a \"configuration\" section.");

  const targets = new Map<string, PatchTarget[]>();
  const notes: string[] = [];
  for (const [requested, text] of changes) {
    const info = catalog.get(requested);
    const key = info?.aliasOf ?? requested;
    const layers = info?.aliasOf ? ["filament_settings"] : layersOf(configuration, key, info);
    if (layers.length === 0) {
      throw new Refusal(`"${requested}" is not part of the configuration PrusaSlicer 3.0 resolved for these presets, so it cannot be set here.`);
    }
    const written: PatchTarget[] = [];
    for (const name of layers) {
      const section = (configuration[name] ??= {});
      const previous = section[key];
      const value = convert(requested, text, previous ?? perTool(configuration, info), info);
      section[key] = value;
      written.push({ section: name, key, value, previous });
      if (!info?.aliasOf && name !== info?.location && previous !== undefined) {
        notes.push(`${key}: the ${name.replace("_settings", "").replace("toolprint", "tool")} profile overrides it (it had ${JSON.stringify(previous)}), so it was set there too.`);
      }
    }
    targets.set(requested, written);
  }
  return { config: JSON.stringify(saved), targets, notes };
}

/** The setting's own section first, then every override layer that holds it. */
function layersOf(configuration: Record<string, Section>, key: string, info: SettingInfo | undefined): string[] {
  const layers: string[] = [];
  if (info?.location && configuration[info.location] && key in configuration[info.location]!) layers.push(info.location);
  for (const name of SECTIONS) if (!layers.includes(name) && configuration[name] && key in configuration[name]!) layers.push(name);
  return layers;
}

/** A per-tool list to fill when a filament override is added: as long as the filament's other lists. */
function perTool(configuration: Record<string, Section>, info: SettingInfo | undefined): Json {
  const lengths = Object.values(configuration.filament_settings ?? {}).filter(Array.isArray).map((list) => (list as Json[]).length);
  const tools = Math.max(1, ...lengths.filter((length) => length > 0));
  const sample: Json =
    info?.schemaType === "Bool" ? false : info?.type === "number" ? 0 : info?.type === "percent" ? { value: 0, is_percent: false } : "";
  return Array.from({ length: tools }, () => sample);
}

/**
 * What PrusaSlicer saved back after loading the patched config (--load patched --save check),
 * compared per section with what was written. A merged view would hide the override layers.
 */
export function checkPatched(loadedConfig: string, targets: ReadonlyMap<string, PatchTarget[]>): AppliedCheck {
  const loaded = (JSON.parse(loadedConfig) as { configuration?: Record<string, Section> }).configuration ?? {};
  const check: AppliedCheck = { confirmed: [], rejected: [], missing: [] };
  for (const [requested, written] of targets) {
    let ok = true;
    for (const target of written) {
      const found = loaded[target.section]?.[target.key];
      if (found === undefined) {
        check.missing.push(`${requested} (${target.section})`);
        ok = false;
      } else if (!sameJson(found, target.value)) {
        check.rejected.push({ key: requested, layer: target.section, expected: JSON.stringify(target.value), found: JSON.stringify(found) });
        ok = false;
      }
    }
    if (ok) check.confirmed.push(requested);
  }
  return check;
}

function convert(key: string, text: string, current: Json, info: SettingInfo | undefined): Json {
  if (Array.isArray(current)) return convertList(key, text, current, info);
  return convertScalar(key, text.trim(), current, info);
}

/** Per-tool and list settings. One value is repeated for every tool; "" empties the list. */
function convertList(key: string, text: string, current: Json[], info: SettingInfo | undefined): Json[] {
  if (text.trim() === "") return [];
  const parts = text.split(",").map((part) => part.trim());
  const values = parts.map((part) => convertScalar(key, part, current[0] ?? elementSample(info), info));
  return values.length === 1 && current.length > 1 ? current.map(() => values[0]!) : values;
}

/** An empty list has no element to copy the type from: the schema's type decides. */
function elementSample(info: SettingInfo | undefined): Json {
  return info?.type === "number" || info?.schemaType === "Int" || info?.schemaType === "Float" ? 0 : "";
}

function convertScalar(key: string, text: string, current: Json, info: SettingInfo | undefined): Json {
  const schema = info?.schemaType;

  if (isPercentValue(current) || schema === "Percentage" || schema === "FloatOrPercentage") {
    const percent = text.endsWith("%");
    const number = Number(percent ? text.slice(0, -1) : text);
    if (text === "" || !Number.isFinite(number)) throw bad(key, text, "a number, or a percentage such as 25%");
    if (schema === "Percentage" && !percent) return { value: number, is_percent: true };
    return { value: number, is_percent: percent };
  }
  if (typeof current === "boolean" || schema === "Bool") {
    if (text === "1" || text.toLowerCase() === "true") return true;
    if (text === "0" || text.toLowerCase() === "false") return false;
    throw bad(key, text, "true/false (or 1/0)");
  }
  if (typeof current === "number" || schema === "Float" || schema === "Int" || schema === "OptInt") {
    const number = Number(text);
    if (text === "" || !Number.isFinite(number)) throw bad(key, text, "a number");
    if ((schema === "Int" || schema === "OptInt") && !Number.isInteger(number)) throw bad(key, text, "a whole number");
    if (info?.min !== undefined && number < info.min) throw bad(key, text, `at least ${info.min}`);
    if (info?.max !== undefined && number > info.max) throw bad(key, text, `at most ${info.max}`);
    return number;
  }
  if (info?.values && !info.values.includes(text)) throw bad(key, text, `one of ${info.values.join(", ")}`);
  return text;
}

function isPercentValue(value: Json): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "is_percent" in value;
}

function bad(key: string, text: string, expected: string): Refusal {
  return new Refusal(`"${text}" is not a valid value for ${key}: expected ${expected}.`);
}
