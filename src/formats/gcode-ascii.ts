import { readLines } from "../util/lines.ts";
import type { FlatConfig } from "./ini.ts";
import type { Thumbnail } from "./bgcode.ts";

/**
 * One streaming pass over an ASCII G-code file from PrusaSlicer. It reads what PrusaSlicer writes
 * about the print (summary comments, the config block, objects_info, thumbnails) and what the
 * G-code itself shows (layers, extrusion per feature, pauses, colour and tool changes).
 *
 * Markers relied on, all written by PrusaSlicer itself:
 *   ;LAYER_CHANGE, ;Z:<z>, ;HEIGHT:<h>, ;TYPE:<feature>
 *   ; prusaslicer_config = begin / end          (2.x INI block)
 *   ; prusaslicer_json_config = begin / end     (3.0 JSON block)
 *   ; thumbnail[_PNG|_JPG|_QOI] begin WxH len / end
 *   ;PAUSE_PRINT, then the message as M117 <text> before the M601 (2.x), and since 3.0.0-alpha15
 *     also ;PAUSE_PRINT_MESSAGE:<text>
 *   ;CUSTOM_GCODE before custom G-code or a template; since 3.0.0-alpha15 its lines are wrapped in
 *     ;CUSTOM_GCODE_START / _END, or ;CUSTOM_TEMPLATE_START / _END (measured 2026-11-25)
 */

export interface GcodeEvent {
  kind: "color_change" | "pause" | "tool_change" | "custom";
  code: string;
  layer: number;
  z: number | null;
  line: number;
  /** A pause's message, shown on the printer. */
  message?: string;
  /** A custom block's lines (3.0.0-alpha15 and later mark where they end), clipped. */
  gcode?: string;
  /** The custom block is the printer's template_custom_gcode. */
  template?: boolean;
}

export interface AsciiAnalysis {
  generator: string | null;
  /** "; key = value" lines outside the config block: the summary and the extrusion widths. */
  stats: FlatConfig;
  config: FlatConfig;
  jsonConfig: unknown;
  /** Layer heights are the steps between consecutive ;Z: values (;HEIGHT: is per feature). */
  layers: { count: number; heights: number[]; maxZ: number | null };
  /** Net extrusion (filament length, mm) per feature type. */
  features: Map<string, number>;
  events: GcodeEvent[];
  thumbnails: Thumbnail[];
  lines: number;
}

const ENTRY = /^;\s*([A-Za-z0-9_][A-Za-z0-9_ \[\]().%-]*?)\s*=\s?(.*?)\s*$/;
const MOVE = /^G[0-3](?:\s|$)/;
const E_WORD = /\bE(-?\d*\.?\d+)/;
const THUMB_BEGIN = /^; thumbnail(?:_(PNG|JPG|QOI))? begin (\d+)x(\d+) \d+/;
const MAX_EVENTS = 500;
const MAX_CUSTOM_TEXT = 400;

export async function analyzeAsciiGcode(path: string): Promise<AsciiAnalysis> {
  const result: AsciiAnalysis = {
    generator: null,
    stats: new Map(),
    config: new Map(),
    jsonConfig: null,
    layers: { count: 0, heights: [], maxZ: null },
    features: new Map(),
    events: [],
    thumbnails: [],
    lines: 0,
  };

  let block: "none" | "config" | "json" | "thumbnail" = "none";
  let json: string[] = [];
  let thumb: { format: Thumbnail["format"]; width: number; height: number; data: string[] } | null = null;
  let relativeE = false;
  let lastE = 0;
  let feature = "Unknown";
  let layer = 0;
  let z: number | null = null;
  const heights = new Set<number>();

  let previousZ = 0;
  // A pause under way: its message comes before the M601.
  let pause: { message: string | null } | null = null;
  // The custom block being read, while its lines are collected.
  let custom: GcodeEvent | null = null;
  let collecting = false;
  for await (const raw of readLines(path)) {
    result.lines++;
    const line = raw.trimEnd();
    if (line === "") continue;

    if (block === "thumbnail") {
      if (/^; thumbnail(?:_\w+)? end/.test(line)) {
        if (thumb) {
          result.thumbnails.push({ format: thumb.format, width: thumb.width, height: thumb.height, data: Buffer.from(thumb.data.join(""), "base64") });
        }
        thumb = null;
        block = "none";
      } else if (thumb) {
        thumb.data.push(line.replace(/^;\s?/, ""));
      }
      continue;
    }
    if (block === "config") {
      if (line === "; prusaslicer_config = end") {
        block = "none";
        continue;
      }
      const entry = ENTRY.exec(line);
      if (entry) result.config.set(entry[1]!, entry[2]!);
      continue;
    }
    if (block === "json") {
      if (line === "; prusaslicer_json_config = end") {
        block = "none";
        try {
          result.jsonConfig = JSON.parse(json.join("\n"));
        } catch {
          result.jsonConfig = null;
        }
        json = [];
      } else {
        json.push(line.replace(/^;\s?/, ""));
      }
      continue;
    }

    if (collecting && custom) {
      if (line === ";CUSTOM_GCODE_END" || line === ";CUSTOM_TEMPLATE_END") {
        collecting = false;
        custom = null;
        continue;
      }
      // The lines stay G-code: they are counted below as any other.
      if ((custom.gcode ?? "").length < MAX_CUSTOM_TEXT) custom.gcode = (custom.gcode ? `${custom.gcode}\n` : "") + line;
    }

    if (line.startsWith(";")) {
      if (line === ";PAUSE_PRINT") {
        pause = { message: null };
        continue;
      }
      if (line.startsWith(";PAUSE_PRINT_MESSAGE:")) {
        if (pause) pause.message = line.slice(";PAUSE_PRINT_MESSAGE:".length);
        continue;
      }
      if (line === ";CUSTOM_GCODE") {
        custom = { kind: "custom", code: line, layer, z, line: result.lines };
        pushEvent(result, custom);
        continue;
      }
      if ((line === ";CUSTOM_GCODE_START" || line === ";CUSTOM_TEMPLATE_START") && custom && !collecting) {
        collecting = true;
        if (line === ";CUSTOM_TEMPLATE_START") custom.template = true;
        continue;
      }
      if (line === ";LAYER_CHANGE") {
        layer++;
        continue;
      }
      if (line.startsWith(";Z:")) {
        z = Number(line.slice(3));
        if (Number.isFinite(z)) {
          const step = Math.round((z - previousZ) * 1000) / 1000;
          if (step > 0 && heights.size < 64) heights.add(step);
          previousZ = z;
          if (result.layers.maxZ === null || z > result.layers.maxZ) result.layers.maxZ = z;
        }
        continue;
      }
      if (line.startsWith(";TYPE:")) {
        feature = line.slice(6);
        continue;
      }
      if (line === "; prusaslicer_config = begin") {
        block = "config";
        continue;
      }
      if (line === "; prusaslicer_json_config = begin") {
        block = "json";
        continue;
      }
      const thumbBegin = THUMB_BEGIN.exec(line);
      if (thumbBegin) {
        const format = (thumbBegin[1]?.toLowerCase() ?? "png") as Thumbnail["format"];
        thumb = { format, width: Number(thumbBegin[2]), height: Number(thumbBegin[3]), data: [] };
        block = "thumbnail";
        continue;
      }
      if (!result.generator) {
        const generated = /^; generated by (.+?) on /.exec(line);
        if (generated) {
          result.generator = generated[1]!;
          continue;
        }
      }
      const entry = ENTRY.exec(line);
      if (entry) result.stats.set(entry[1]!, entry[2]!);
      continue;
    }

    // G-code proper. Strip a trailing comment for parsing, keep it for event reporting.
    const semicolon = line.indexOf(";");
    const code = (semicolon === -1 ? line : line.slice(0, semicolon)).trim();
    if (code === "") continue;
    const first = code.charCodeAt(0);

    if (first === 71 /* G */) {
      if (MOVE.test(code)) {
        const e = E_WORD.exec(code);
        if (e) {
          const value = Number(e[1]);
          const delta = relativeE ? value : value - lastE;
          if (!relativeE) lastE = value;
          result.features.set(feature, (result.features.get(feature) ?? 0) + delta);
        }
      } else if (code.startsWith("G92")) {
        const e = E_WORD.exec(code);
        if (e) lastE = Number(e[1]);
      }
      continue;
    }
    if (first === 77 /* M */) {
      if (code === "M82" || code.startsWith("M82 ")) relativeE = false;
      else if (code === "M83" || code.startsWith("M83 ")) relativeE = true;
      else if (/^M600\b/.test(code)) pushEvent(result, { kind: "color_change", code: line, layer, z, line: result.lines });
      else if (/^M117\b/.test(code) && pause && pause.message === null) pause.message = line.replace(/^M117\s?/, "");
      else if (/^M(601|0|1|25)\b/.test(code)) {
        pushEvent(result, { kind: "pause", code: line, layer, z, line: result.lines, ...(pause?.message ? { message: pause.message } : {}) });
        pause = null;
      }
      continue;
    }
    if (first === 84 /* T */ && /^T\d+\b/.test(code) && layer > 0) {
      pushEvent(result, { kind: "tool_change", code: line, layer, z, line: result.lines });
    }
  }

  result.layers.count = layer;
  result.layers.heights = [...heights].sort((a, b) => a - b);
  return result;
}

function pushEvent(result: AsciiAnalysis, event: GcodeEvent): void {
  if (result.events.length < MAX_EVENTS) result.events.push(event);
}
