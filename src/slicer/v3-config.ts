import type { SettingInfo } from "../formats/help.ts";
import { Refusal } from "../util/errors.ts";

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

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Section = Record<string, Json>;

const SECTIONS = ["print_settings", "printer_settings", "filament_settings", "toolprint_settings"];

export function patchSavedConfig(
  savedConfig: string,
  changes: ReadonlyMap<string, string>,
  catalog: ReadonlyMap<string, SettingInfo>,
): string {
  const saved = JSON.parse(savedConfig) as { configuration?: Record<string, Section> };
  const configuration = saved.configuration;
  if (!configuration) throw new Refusal("PrusaSlicer saved a configuration without a \"configuration\" section.");

  for (const [key, text] of changes) {
    const info = catalog.get(key);
    const section = findSection(configuration, key, info);
    if (!section) {
      throw new Refusal(
        `"${key}" is not part of the configuration PrusaSlicer 3.0 resolved for these presets, so it cannot be set here.`,
      );
    }
    section[key] = convert(key, text, section[key]!, info);
  }
  return JSON.stringify(saved);
}

/** The schema says where a setting lives; fall back to looking for it when the schema is silent. */
function findSection(configuration: Record<string, Section>, key: string, info: SettingInfo | undefined): Section | null {
  if (info?.location && configuration[info.location] && key in configuration[info.location]!) return configuration[info.location]!;
  for (const name of SECTIONS) if (configuration[name] && key in configuration[name]!) return configuration[name]!;
  return null;
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
