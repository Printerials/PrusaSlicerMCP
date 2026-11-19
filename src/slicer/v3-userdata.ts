import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { readProject } from "../formats/threemf.ts";

/**
 * What PrusaSlicer 3.0 keeps of the user's own in its data directory (3.0.0-alpha14, 2026-11-19):
 * - User presets: YAML in presets/user/<repo>/<vendor>/, named printer-, print-, tool- or
 *   filament-<name>.yaml (source Preset/IO/PresetSaver.cpp), one variant name per preset.
 * - Physical printers: physical_printer/<uuid>.json. They hold host, API key, user and password in
 *   plain text (source PhysicalPrinterJson.cpp); only the name is read here.
 * - Unsaved projects: the GUI writes a full 3MF of each to backup_projects/<instance>_<id>_<name>.3mf
 *   on every change and removes it once the project is saved (source BackupStore.cpp; a backup of
 *   the open project was seen there, with its objects and settings).
 */

export interface V3UserPreset {
  name: string;
  inherits: string | null;
  file: string;
}

export interface OpenProject {
  /** The project's name as the GUI shows it. */
  name: string;
  /** The backup 3MF: project_info, slice and edit_project can read it. */
  path: string;
  modified: string;
  objects: number;
  presets: { printer: string | null; print: string | null; filament: string[] };
}

const PREFIX: Record<string, string> = { printer: "printer-", print: "print-", filament: "filament-" };

export async function readV3UserPresets(datadir: string, kind: "printer" | "print" | "filament"): Promise<V3UserPreset[]> {
  const presets: V3UserPreset[] = [];
  for (const file of await yamlFiles(join(datadir, "presets", "user"), 3)) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const declared = /^kind:\s*"?([\w-]+)"?/m.exec(text)?.[1];
    const fileKind = Object.entries(PREFIX).find(([, prefix]) => file.split("/").pop()!.startsWith(prefix))?.[0];
    if ((declared ?? fileKind) !== kind) continue;
    const inherits = /unconditional_inherits:\s*\[\s*("(?:[^"\\]|\\.)*"|[^,\]]+)/.exec(text)?.[1] ?? /^\s+inherits:\s*\[?\s*("(?:[^"\\]|\\.)*"|[^,\]\n]+)/m.exec(text)?.[1];
    for (const match of text.matchAll(/^\s+(?:-\s+)?name:\s*(.+?)\s*$/gm)) {
      presets.push({ name: unquote(match[1]!), inherits: inherits ? unquote(inherits.trim()) : null, file });
    }
  }
  return presets.sort((a, b) => a.name.localeCompare(b.name));
}

/** The names of the physical printers, nothing else of them. */
export async function readV3PhysicalPrinters(datadir: string): Promise<string[]> {
  const dir = join(datadir, "physical_printer");
  const names: string[] = [];
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    if (!entry.endsWith(".json")) continue;
    try {
      const data = JSON.parse(await readFile(join(dir, entry), "utf8")) as { physical_printer_user_given_name?: unknown };
      if (typeof data.physical_printer_user_given_name === "string" && data.physical_printer_user_given_name) names.push(data.physical_printer_user_given_name);
    } catch {
      // an unreadable file is left out
    }
  }
  return names.sort();
}

/** The GUI's backups of unsaved projects, newest first. */
export async function readV3OpenProjects(datadir: string): Promise<OpenProject[]> {
  const dir = join(datadir, "backup_projects");
  const projects: OpenProject[] = [];
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    if (!entry.toLowerCase().endsWith(".3mf")) continue;
    const path = join(dir, entry);
    try {
      const [info, project] = await Promise.all([stat(path), readProject(path)]);
      projects.push({
        name: backupName(entry),
        path,
        modified: info.mtime.toISOString(),
        objects: project.objects.length,
        presets: project.presets,
      });
    } catch {
      // a backup being written or damaged is left out
    }
  }
  return projects.sort((a, b) => b.modified.localeCompare(a.modified));
}

/** "a1b2c3_d4e5f6_bracket.3mf" -> "bracket": <instance>_<id>_<name>.3mf. */
export function backupName(file: string): string {
  const stemmed = file.replace(/\.3mf$/i, "");
  const match = /^[^_]+_[^_]+_(.+)$/.exec(stemmed);
  return match ? match[1]! : stemmed;
}

async function yamlFiles(dir: string, depth: number): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) found.push(...(await yamlFiles(path, depth - 1)));
    else if (entry.isFile() && entry.name.endsWith(".yaml") && entry.name !== "vendor.yaml") found.push(path);
  }
  return found;
}

function unquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed.replace(/^'(.*)'$/, "$1");
}
