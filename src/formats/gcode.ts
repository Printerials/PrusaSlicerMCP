import { stat } from "node:fs/promises";
import { analyzeAsciiGcode, type GcodeEvent } from "./gcode-ascii.ts";
import { isBgcodeFile, readBgcodeMetadata, type Thumbnail } from "./bgcode.ts";
import { firstOf, splitList, type FlatConfig } from "./ini.ts";

/** What a G-code file says about its print, the same shape for ASCII and binary G-code. */
export interface GcodeReport {
  format: "ascii" | "binary";
  size_bytes: number;
  generator: string | null;
  printer_model: string | null;
  presets: { printer: string | null; print: string | null; filament: string[] };
  time: {
    normal: string | null;
    silent: string | null;
    normal_seconds: number | null;
    first_layer_normal: string | null;
  };
  filament: {
    used_mm: number[];
    used_cm3: number[];
    used_g: number[];
    total_g: number | null;
    total_cost: number | null;
    wipe_tower_g: number | null;
    types: string[];
  };
  toolchanges: number | null;
  layers: { count: number | null; first_layer_height: number | null; layer_height: number | null; heights: number[]; max_z: number | null };
  objects: string[];
  /** ASCII only: net filament per feature type, largest first. */
  features?: Array<{ type: string; filament_mm: number; share: number }>;
  /** ASCII only: pauses, colour and tool changes with their layer. */
  events?: GcodeEvent[];
  thumbnails: Array<{ format: string; width: number; height: number }>;
  note?: string;
}

export interface GcodeRead {
  report: GcodeReport;
  config: FlatConfig;
  thumbnails: Thumbnail[];
}

export async function readGcode(path: string): Promise<GcodeRead> {
  const size = (await stat(path)).size;
  if (await isBgcodeFile(path)) {
    const meta = await readBgcodeMetadata(path);
    // The print block repeats the summary; the printer block adds the model and the key settings.
    const stats = new Map([...meta.printer, ...meta.print]);
    const config = meta.slicer.size > 0 ? meta.slicer : meta.printer;
    const report = buildReport("binary", size, meta.file.get("Producer") ?? null, stats, config);
    report.layers.max_z = num(meta.printer.get("max_layer_z")) ?? report.layers.max_z;
    report.thumbnails = meta.thumbnails.map(({ format, width, height }) => ({ format, width, height }));
    report.note = "Binary G-code: layer, feature and pause details need an ASCII export (gcode_format: ascii).";
    return { report, config, thumbnails: meta.thumbnails };
  }

  const scan = await analyzeAsciiGcode(path);
  const config = scan.config.size > 0 ? scan.config : flattenJsonConfig(scan.jsonConfig);
  const report = buildReport("ascii", size, scan.generator, scan.stats, config);
  report.layers.count = scan.layers.count;
  report.layers.heights = scan.layers.heights;
  report.layers.max_z = scan.layers.maxZ;
  const extruded = [...scan.features.entries()].filter(([, mm]) => mm > 0.01);
  const total = extruded.reduce((sum, [, mm]) => sum + mm, 0);
  report.features = extruded
    .sort((a, b) => b[1] - a[1])
    .map(([type, mm]) => ({ type, filament_mm: round(mm, 1), share: total > 0 ? round(mm / total, 3) : 0 }));
  report.events = scan.events;
  report.thumbnails = scan.thumbnails.map(({ format, width, height }) => ({ format, width, height }));
  if (scan.config.size === 0 && !scan.jsonConfig) report.note = "No PrusaSlicer config block found: this G-code may not come from PrusaSlicer.";
  return { report, config, thumbnails: scan.thumbnails };
}

function buildReport(format: "ascii" | "binary", size: number, generator: string | null, stats: FlatConfig, config: FlatConfig): GcodeReport {
  const get = (key: string) => stats.get(key) ?? config.get(key);
  const nums = (key: string) => {
    const value = stats.get(key);
    return value === undefined ? [] : value.split(",").map(Number).filter(Number.isFinite);
  };
  const normal = stats.get("estimated printing time (normal mode)") ?? null;
  return {
    format,
    size_bytes: size,
    generator,
    printer_model: get("printer_model") || null,
    presets: {
      printer: config.get("printer_settings_id") || null,
      print: config.get("print_settings_id") || null,
      filament: config.has("filament_settings_id") ? splitList(config.get("filament_settings_id")!) : [],
    },
    time: {
      normal,
      silent: stats.get("estimated printing time (silent mode)") ?? null,
      normal_seconds: normal ? durationSeconds(normal) : null,
      first_layer_normal: stats.get("estimated first layer printing time (normal mode)") ?? null,
    },
    filament: {
      used_mm: nums("filament used [mm]"),
      used_cm3: nums("filament used [cm3]"),
      used_g: nums("filament used [g]"),
      total_g: num(stats.get("total filament used [g]")) ?? sum(nums("filament used [g]")),
      total_cost: num(stats.get("total filament cost")) ?? sum(nums("filament cost")),
      wipe_tower_g: num(stats.get("total filament used for wipe tower [g]")),
      types: config.has("filament_type") ? splitList(config.get("filament_type")!) : [],
    },
    toolchanges: num(stats.get("total toolchanges")),
    layers: {
      count: null,
      first_layer_height: num(config.get("first_layer_height")),
      layer_height: num(firstOf(config.get("layer_height"))),
      heights: [],
      max_z: num(stats.get("max_layer_z")),
    },
    objects: objectNames(stats.get("objects_info")),
    thumbnails: [],
  };
}

function objectNames(objectsInfo: string | undefined): string[] {
  if (!objectsInfo) return [];
  try {
    const data = JSON.parse(objectsInfo) as { objects?: Array<{ name?: string }> };
    return (data.objects ?? []).map((object) => object.name ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

/** 3.0 writes the config as JSON with "config" holding the settings boxes. */
function flattenJsonConfig(json: unknown): FlatConfig {
  const config: FlatConfig = new Map();
  if (!json || typeof json !== "object") return config;
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (inner && typeof inner === "object" && !Array.isArray(inner)) visit(inner);
      else if (!config.has(key)) config.set(key, Array.isArray(inner) ? inner.map(String).join(",") : String(inner));
    }
  };
  visit((json as { config?: unknown }).config ?? json);
  return config;
}

/** "1d 2h 3m 4s" -> seconds. */
export function durationSeconds(text: string): number {
  let total = 0;
  for (const [, value, unit] of text.matchAll(/(\d+)\s*([dhms])/g)) {
    total += Number(value) * ({ d: 86400, h: 3600, m: 60, s: 1 } as Record<string, number>)[unit!]!;
  }
  return total;
}

function num(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sum(values: number[]): number | null {
  return values.length ? round(values.reduce((a, b) => a + b, 0), 2) : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
