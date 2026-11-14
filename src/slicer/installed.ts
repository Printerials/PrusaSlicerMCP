import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Which vendor profiles PrusaSlicer 2.x shows: what the Configuration Wizard sets in PrusaSlicer.ini.
 *
 *   [filaments]                        installed filament presets, "name = 1"
 *   Buddy3D PETG @COREONE HF0.4 = 1
 *   [vendor:PrusaResearch]             installed printer variants per model
 *   model:COREONE = HF0.4;"HT Hotend 0.4"
 *
 * Variants are written as PrusaSlicer's escape_strings_cstyle does: separated by ";", quoted when
 * they contain spaces. An unquoted "HT Hotend 0.4" makes PrusaSlicer drop the whole model, and a
 * duplicate key makes it reject the whole file as corrupt; both were seen with 2.9.7.
 * On Windows the file ends with "# MD5 checksum <hex>" (AppConfig.cpp, 2.9.2). A missing or wrong
 * checksum is only logged and the file is read as usual, so the line is dropped rather than
 * recomputed in a format that cannot be verified here; PrusaSlicer writes a fresh one on its next save.
 */

export interface PrinterModelInfo {
  id: string;
  name: string;
  variants: string[];
  technology: string;
}

export interface Bundle {
  vendorId: string;
  name: string;
  filaments: Set<string>;
  slaMaterials: Set<string>;
  models: Map<string, PrinterModelInfo>;
}

export interface Installed {
  filaments: Set<string>;
  /** vendor id -> model id -> variants */
  vendors: Map<string, Map<string, string[]>>;
}

const SECTION = /^\[(.+)\]\s*$/;

/** The vendor bundles installed in the datadir (vendor/*.ini), the source the wizard installs from. */
export async function readBundles(datadir: string): Promise<Bundle[]> {
  const dir = join(datadir, "vendor");
  if (!existsSync(dir)) return [];
  const bundles: Bundle[] = [];
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".ini")).sort()) {
    bundles.push(await readBundle(join(dir, file), file.slice(0, -4)));
  }
  return bundles;
}

const bundleCache = new Map<string, { mtime: number; bundle: Bundle }>();

async function readBundle(path: string, vendorId: string): Promise<Bundle> {
  const mtime = (await stat(path)).mtimeMs;
  const hit = bundleCache.get(path);
  if (hit && hit.mtime === mtime) return hit.bundle;

  const bundle: Bundle = { vendorId, name: vendorId, filaments: new Set(), slaMaterials: new Set(), models: new Map() };
  let kind = "";
  let name = "";
  let model: PrinterModelInfo | null = null;
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    const section = SECTION.exec(line);
    if (section) {
      const header = section[1]!;
      const colon = header.indexOf(":");
      kind = colon === -1 ? header : header.slice(0, colon);
      name = colon === -1 ? "" : header.slice(colon + 1);
      model = null;
      // "*name*" presets are abstract parents, never shown.
      const abstract = name.startsWith("*") && name.endsWith("*");
      if (kind === "filament" && !abstract) bundle.filaments.add(name);
      else if (kind === "sla_material" && !abstract) bundle.slaMaterials.add(name);
      else if (kind === "printer_model") {
        model = { id: name, name, variants: [], technology: "FFF" };
        bundle.models.set(name, model);
      }
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (kind === "vendor" && key === "name") bundle.name = value;
    else if (model && key === "name") model.name = value;
    else if (model && key === "variants") model.variants = value.split(";").map((v) => v.trim()).filter(Boolean);
    else if (model && key === "technology") model.technology = value;
  }
  bundleCache.set(path, { mtime, bundle });
  return bundle;
}

/** Variants as PrusaSlicer's unescape_strings_cstyle reads them: ";"-separated, optionally quoted. */
export function parseVariants(value: string): string[] {
  const variants: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (value[i] === " " || value[i] === ";") i++;
    if (i >= value.length) break;
    if (value[i] === '"') {
      let out = "";
      i++;
      while (i < value.length && value[i] !== '"') {
        if (value[i] === "\\" && i + 1 < value.length) i++;
        out += value[i];
        i++;
      }
      i++;
      variants.push(out);
    } else {
      const end = value.indexOf(";", i);
      variants.push(value.slice(i, end === -1 ? value.length : end).trim());
      i = end === -1 ? value.length : end;
    }
  }
  return variants.filter(Boolean);
}

export function escapeVariants(variants: string[]): string {
  return variants
    .map((variant) => (/[\s;"\\]/.test(variant) ? `"${variant.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : variant))
    .join(";");
}

export function parseInstalled(ini: string): Installed {
  const installed: Installed = { filaments: new Set(), vendors: new Map() };
  let section = "";
  for (const line of ini.split(/\r?\n/)) {
    const header = SECTION.exec(line);
    if (header) {
      section = header[1]!;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1 || line.startsWith("#")) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (section === "filaments" && value === "1") installed.filaments.add(key);
    else if (section.startsWith("vendor:") && key.startsWith("model:")) {
      const vendor = section.slice("vendor:".length);
      const models = installed.vendors.get(vendor) ?? new Map<string, string[]>();
      models.set(key.slice("model:".length), parseVariants(value));
      installed.vendors.set(vendor, models);
    }
  }
  return installed;
}

/**
 * Rewrites the [filaments] and [vendor:*] sections of PrusaSlicer.ini for the wanted state, each
 * in its old place, and leaves every other line as it was. New sections go at the end. Keys are
 * sorted, as PrusaSlicer writes them.
 */
export function writeInstalled(ini: string, wanted: Installed): string {
  const eol = ini.includes("\r\n") ? "\r\n" : "\n";
  let lines = ini.split(/\r?\n/);
  const checksumAt = lines.findIndex((line) => line.startsWith("# MD5 checksum "));
  if (checksumAt !== -1) lines = lines.slice(0, checksumAt);

  const blocks = new Map<string, string[]>();
  if (wanted.filaments.size) blocks.set("filaments", [...wanted.filaments].sort().map((name) => `${name} = 1`));
  for (const vendor of [...wanted.vendors.keys()].sort()) {
    const entries = [...wanted.vendors.get(vendor)!.entries()]
      .filter(([, variants]) => variants.length > 0)
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length) blocks.set(`vendor:${vendor}`, entries.map(([model, variants]) => `model:${model} = ${escapeVariants(variants)}`));
  }

  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = SECTION.exec(line);
    if (header) {
      const name = header[1]!;
      skipping = name === "filaments" || name.startsWith("vendor:");
      if (skipping) {
        const body = blocks.get(name);
        blocks.delete(name);
        if (body) out.push(line, ...body, "");
        continue;
      }
    }
    if (!skipping) out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [name, body] of blocks) out.push("", `[${name}]`, ...body);
  return out.join(eol) + eol;
}
