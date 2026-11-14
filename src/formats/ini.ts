/**
 * PrusaSlicer's config serialization (2.x): "key = value" lines, optionally behind "; " in G-code
 * and in a 3MF's Slic3r_PE.config, and "[section]" headers in PrusaSlicer.ini and vendor bundles.
 * Values stay as PrusaSlicer wrote them; unescape only where the text itself is needed (G-code).
 */

/** A flat config: key to the value exactly as serialized. */
export type FlatConfig = Map<string, string>;

const ENTRY = /^\s*([A-Za-z0-9_][A-Za-z0-9_ \[\]().%-]*?)\s*=\s?(.*?)\s*$/;

/** Section name ("" before the first header) to its entries. */
export function parseIniSections(text: string): Map<string, FlatConfig> {
  const sections = new Map<string, FlatConfig>([["", new Map()]]);
  let current = sections.get("")!;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(line)) continue;
    const header = /^\s*\[(.+)\]\s*$/.exec(line);
    if (header) {
      const name = header[1]!;
      current = sections.get(name) ?? new Map();
      sections.set(name, current);
      continue;
    }
    const entry = ENTRY.exec(line);
    if (entry) current.set(entry[1]!, entry[2]!);
  }
  return sections;
}

/** The output of `--save` in 2.x and the contents of a user preset file. */
export function parseIniConfig(text: string): FlatConfig {
  return parseIniSections(text).get("") ?? new Map();
}

/** "; key = value" lines, as in the config block of a G-code file and in Slic3r_PE.config. */
export function parseCommentedConfig(text: string): FlatConfig {
  const config: FlatConfig = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(";")) continue;
    const entry = ENTRY.exec(line.slice(1));
    if (entry) config.set(entry[1]!, entry[2]!);
  }
  return config;
}

/** Undoes PrusaSlicer's C-style escaping of string values: \n, \r, \t, \\ and \". */
export function unescapeValue(value: string): string {
  let unquoted = value;
  if (unquoted.length >= 2 && unquoted.startsWith('"') && unquoted.endsWith('"')) unquoted = unquoted.slice(1, -1);
  return unquoted.replace(/\\(.)/g, (_, char: string) => {
    switch (char) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return char;
    }
  });
}

/**
 * A vector of strings, serialized as "a";"b" (quoted, separated by ;). Plain vectors use ","
 * ("0.4,0.4"). A single unquoted value is a one-element list.
 */
export function splitList(value: string): string[] {
  if (value.startsWith('"')) {
    const items: string[] = [];
    const re = /"((?:[^"\\]|\\.)*)"/g;
    for (const match of value.matchAll(re)) items.push(unescapeValue(`"${match[1]}"`));
    return items;
  }
  if (value === "") return [];
  return value.split(/[,;]/).map((part) => part.trim());
}

/** The first element of a list value: the setting of extruder 1. */
export function firstOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return splitList(value)[0] ?? value;
}
