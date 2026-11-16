/**
 * Parsers for `--help` (version and the options this binary accepts) and `--help-fff` (the
 * catalogue of print settings that the CLI accepts as overrides).
 */

export interface HelpInfo {
  /** "2.9.7", "3.0.0-alpha14". */
  version: string;
  major: number;
  minor: number;
  /** Every option name the help lists, without dashes: "export-gcode", "query-printer-models". */
  options: Set<string>;
}

export interface SettingInfo {
  /** The config key: "fill_pattern". */
  key: string;
  /** The help section: "Infill", "Speed", "Misc". */
  category: string;
  /**
   * From the help's metavar. PrusaSlicer prints none for flags, enums and per-extruder vectors:
   * a list of allowed values marks an enum, a "%" default a percentage, another default that is
   * not 0 or 1 a vector.
   */
  type: "bool" | "number" | "string" | "point" | "points" | "enum" | "percent" | "list";
  description: string;
  unit?: string;
  values?: string[];
  default?: string;
}

const VERSION = /PrusaSlicer-(\d+)\.(\d+)\.(\d+[^\s]*)/;

export function parseHelp(text: string): HelpInfo {
  const match = VERSION.exec(text);
  if (!match) throw new Error(`Unrecognized PrusaSlicer help output: ${text.slice(0, 200)}`);
  const options = new Set<string>();
  for (const opt of text.matchAll(/^ {1,2}(?:-\w, )?--([a-z0-9][a-z0-9-]*)/gm)) options.add(opt[1]!);
  return {
    version: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    options,
  };
}

const METAVARS: Record<string, SettingInfo["type"]> = {
  N: "number",
  ABCD: "string",
  "ABCD,": "string",
  "X,Y": "point",
  "X,Y,Z": "points",
};

/** " --key-name [METAVAR]" at the start of a line; the description may follow on the same line. */
const OPTION_HEAD = /^ --([a-z0-9][a-z0-9-]*)(?: (N|ABCD,?|X,Y,Z|X,Y)(?= |$))?/;
const SECTION = /^([A-Z][A-Za-z ]*?)(?: options)?:$/;

export function parseHelpFff(text: string): SettingInfo[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^Misc options:$/.test(line));
  if (start === -1) return [];

  const entries: Array<{ cli: string; metavar?: string; category: string; text: string[] }> = [];
  let category = "Misc";
  for (const line of lines.slice(start)) {
    const section = SECTION.exec(line);
    if (section) {
      category = section[1]!;
      continue;
    }
    const head = OPTION_HEAD.exec(line);
    if (head) {
      const rest = line.slice(head[0].length).trim();
      entries.push({ cli: head[1]!, metavar: head[2], category, text: rest ? [rest] : [] });
      continue;
    }
    const last = entries[entries.length - 1];
    if (last && /^\s{10,}\S/.test(line)) last.text.push(line.trim());
  }

  return entries.map(({ cli, metavar, category, text }) => {
    const info: SettingInfo = {
      key: cli.replace(/-/g, "_"),
      category,
      type: metavar ? (METAVARS[metavar] ?? "string") : "bool",
      description: text.join(" "),
    };
    splitTrailer(info);
    if (!metavar && info.values) info.type = "enum";
    else if (!metavar && (info.unit === "%" || info.default?.endsWith("%"))) info.type = "percent";
    else if (!metavar && info.default !== undefined && info.default !== "0" && info.default !== "1") info.type = "list";
    return info;
  });
}

/**
 * The description ends with "(unit, default: X)" or "(a, b, c; default: X)". A list before a
 * semicolon is the set of allowed values; a single word before a comma is the unit.
 */
function splitTrailer(info: SettingInfo): void {
  const text = info.description;
  if (!text.endsWith(")")) return;
  const at = text.lastIndexOf("default: ");
  if (at === -1) return;
  const open = text.lastIndexOf("(", at);
  if (open === -1 || text.slice(open + 1, at).includes(")")) return;

  info.default = text.slice(at + "default: ".length, -1);
  const before = text.slice(open + 1, at).trim();
  info.description = text.slice(0, open).trim();
  if (!before) return;
  if (before.endsWith(";")) {
    info.values = before.slice(0, -1).split(",").map((value) => value.trim()).filter(Boolean);
  } else if (before.endsWith(",")) {
    info.unit = before.slice(0, -1).trim();
  }
}
