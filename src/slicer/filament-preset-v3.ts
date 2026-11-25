import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SettingInfo } from "../formats/help.ts";
import { splitList, unescapeValue } from "../formats/ini.ts";
import { Refusal } from "../util/errors.ts";
import { schemaValue, type Json } from "./v3-config.ts";

/**
 * A user filament preset for PrusaSlicer 3.0, as its GUI writes one (source
 * slic3r-shared/.../Preset/IO/PresetSaver.cpp; checked against the 3.0.0-alpha14 CLI on a copy of
 * the data directory, 2026-11-19): YAML in presets/user/<repo>/<vendor>/filament-<name>.yaml, one
 * variant with a name, a condition, unconditional_inherits naming the parent's evaluated id, and
 * only the values that differ from the parent. The parent's own variants still apply per printer
 * and nozzle.
 *
 * Two ways such a file breaks PrusaSlicer, both seen on a copy: an unknown variable in the
 * condition makes almost every printer of the vendor disappear, and a parent id that does not exist
 * made every CLI call of alpha14 abort (exit 134); alpha15 leaves that preset out instead and logs
 * "Preset with id '…' not found" (measured 2026-11-25). The caller validates after writing (the
 * preset must resolve) and rolls back either way.
 */

interface SavedPreset {
  hw_config?: {
    repo_id?: string;
    vendor_id?: string;
    base_model?: string;
    tools?: Record<string, { features?: { nozzle_diameter?: number; nozzle_high_flow?: boolean } }>;
  };
  materials?: Array<{ id?: string; name?: string }>;
}

export interface V3PresetTarget {
  /** <datadir>/presets/user/<repo>/<vendor>/filament-<name>.yaml */
  file: string;
  /** The parent's evaluated id (preset.materials[0].id in --save), e.g. "Generic PLA". */
  parentId: string;
  /** For this printer model and nozzle only, as 2.x presets were. */
  condition: string;
}

/** Where the preset goes and what it applies to, from the --save output of printer + print + parent. */
export function v3PresetTarget(savedParent: string, datadir: string, name: string): V3PresetTarget {
  const preset = (JSON.parse(savedParent) as { preset?: SavedPreset }).preset ?? {};
  const hw = preset.hw_config ?? {};
  const parentId = preset.materials?.[0]?.id;
  if (!parentId || !hw.repo_id || !hw.vendor_id || !hw.base_model) {
    throw new Refusal("PrusaSlicer's saved config does not name the parent's id, the vendor or the printer model, so no 3.0 preset can be made from it.");
  }
  const tool = Object.values(hw.tools ?? {})[0]?.features ?? {};
  const parts = [`printer.base_model == ${JSON.stringify(hw.base_model)}`];
  if (typeof tool.nozzle_diameter === "number") parts.push(`tool.nozzle_diameter == ${tool.nozzle_diameter}`);
  if (typeof tool.nozzle_high_flow === "boolean") parts.push(tool.nozzle_high_flow ? "tool.nozzle_high_flow" : "! tool.nozzle_high_flow");
  return {
    file: join(datadir, "presets", "user", hw.repo_id, hw.vendor_id, `filament-${name}.yaml`),
    parentId,
    condition: parts.join(" and "),
  };
}

/** The decisions (2.x value text) as typed 3.0 values: the first of a per-extruder list, notes unquoted. */
export function v3Values(decisions: Array<{ key: string; value: string }>, catalog: ReadonlyMap<string, SettingInfo>): Record<string, Json> {
  const values: Record<string, Json> = {};
  for (const { key, value } of decisions) {
    const info = catalog.get(key);
    if (!info) throw new Refusal(`PrusaSlicer 3.0 has no filament setting "${key}".`);
    const text = info.type === "string" ? unescapeValue(value) : (splitList(value)[0] ?? value);
    values[key] = info.type === "string" ? text : schemaValue(key, text, info);
  }
  return values;
}

/** The ids of an existing preset file, kept when it is overwritten (favourites refer to them). */
export async function existingIds(file: string): Promise<{ root: string; variant: string } | null> {
  try {
    const text = await readFile(file, "utf8");
    const root = /^id:\s*(\S+)/m.exec(text)?.[1];
    const variant = /^\s*-\s*id:\s*(\S+)/m.exec(text)?.[1];
    return root && variant ? { root: unquote(root), variant: unquote(variant) } : null;
  } catch {
    return null;
  }
}

/** JSON scalars are valid YAML scalars, so values are written as JSON: no YAML library needed. */
export function renderV3FilamentPreset(input: {
  name: string;
  condition: string;
  parentId: string;
  values: Record<string, Json>;
  comment: string;
  ids?: { root: string; variant: string };
}): string {
  const ids = input.ids ?? { root: randomUUID(), variant: randomUUID() };
  const lines = [
    `# ${input.comment.replace(/\r?\n/g, " ")}`,
    "kind: filament",
    `id: ${JSON.stringify(ids.root)}`,
    "variants:",
    `  - id: ${JSON.stringify(ids.variant)}`,
    `    name: ${JSON.stringify(input.name)}`,
    `    condition: ${JSON.stringify(input.condition)}`,
    `    unconditional_inherits: [${JSON.stringify(input.parentId)}]`,
    "    values:",
    ...Object.entries(input.values)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`),
  ];
  return `${lines.join("\n")}\n`;
}

function unquote(text: string): string {
  return text.startsWith('"') ? (JSON.parse(text) as string) : text;
}

/**
 * Writes the preset, runs the check, and puts back what was there (or removes the file) when the
 * check fails. "changed" runs after every write so cached listings are dropped.
 */
export async function writeChecked(file: string, content: string, check: () => Promise<void>, changed: () => void): Promise<void> {
  let previous: string | null = null;
  try {
    previous = await readFile(file, "utf8");
  } catch {
    // a new preset
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  changed();
  try {
    await check();
  } catch (error) {
    if (previous !== null) await writeFile(file, previous, "utf8");
    else await unlink(file).catch(() => undefined);
    changed();
    throw error;
  }
}

/**
 * A value PrusaSlicer resolved against the 2.x text the plan wrote. Text is compared whole first:
 * notes and names may hold "," or ";", which would otherwise split them like a per-extruder list
 * (a note "…; safe to delete" was refused that way). Then the first entry of a list, numbers by value.
 */
export function sameSetting(resolved: string, written: string): boolean {
  if (unescapeValue(resolved.trim()) === unescapeValue(written.trim())) return true;
  const a = unescapeValue(splitList(resolved)[0] ?? resolved).trim();
  const b = unescapeValue(splitList(written)[0] ?? written).trim();
  if (a === b) return true;
  const x = Number(a);
  const y = Number(b);
  return a !== "" && b !== "" && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1e-9;
}
