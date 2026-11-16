import { ZipReader, ZipWriter } from "./zip.ts";

/**
 * Editing the settings of a PrusaSlicer 2.x project: Metadata/Slic3r_PE.config is "; key = value"
 * lines, values serialized the way `--save` writes them. Everything else in the archive (meshes,
 * object settings, thumbnail) is copied unchanged, still compressed.
 */

export const PROJECT_CONFIG = "Metadata/Slic3r_PE.config";

/** A value from a caller, in PrusaSlicer's serialization: booleans as 1/0, line breaks escaped. */
export function serializeValue(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  const text = String(value);
  return /[\r\n]/.test(text) ? text.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n") : text;
}

/** Sets values in the config text in place; keys it does not have yet are added at the end. */
export function setConfigValues(text: string, values: Map<string, string>): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const pending = new Map(values);
  const lines = text.split(/\r?\n/).map((line) => {
    const match = /^;\s*([A-Za-z0-9_]+)\s*=/.exec(line);
    if (!match || !pending.has(match[1]!)) return line;
    const key = match[1]!;
    const value = pending.get(key)!;
    pending.delete(key);
    return `; ${key} = ${value}`;
  });
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const [key, value] of pending) lines.push(`; ${key} = ${value}`);
  return lines.join(eol) + eol;
}

/** A copy of the project with a new config; the output must not exist yet. */
export async function writeProject(input: string, output: string, configText: string): Promise<void> {
  const source = await ZipReader.open(input);
  try {
    const target = await ZipWriter.create(output);
    try {
      let replaced = false;
      for (const name of source.entries.keys()) {
        if (name.toLowerCase() === PROJECT_CONFIG.toLowerCase()) {
          await target.add(name, configText);
          replaced = true;
          continue;
        }
        const raw = (await source.readRaw(name))!;
        await target.addRaw(name, raw.entry.method, raw.entry.crc32, raw.entry.size, raw.data);
      }
      if (!replaced) await target.add(PROJECT_CONFIG, configText);
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}
