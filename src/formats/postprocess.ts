import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { once } from "node:events";
import { Refusal } from "../util/errors.ts";
import { readLines } from "../util/lines.ts";

/**
 * Inserting G-code at layer changes of an ASCII G-code file from PrusaSlicer.
 *
 * PrusaSlicer writes a layer change as:
 *   ;LAYER_CHANGE  ;Z:0.6  ;HEIGHT:0.2  <before_layer_gcode>  retract, travel, Z move
 *   ;AFTER_LAYER_CHANGE  ;0.6           <layer_gcode>
 *   travel, unretract, ;TYPE:Perimeter ...
 * Code goes in after the layer_gcode echo: the nozzle is at the new height and still retracted.
 * Without a ;AFTER_LAYER_CHANGE marker it goes before the layer's first ;TYPE: line.
 */

export interface Insert {
  /** 1-based layer number. */
  layer?: number;
  /** The first layer printed at or above this height. */
  z?: number;
  gcode: string;
  label: string;
}

interface LayerMark {
  layer: number;
  z: number | null;
  /** Line number (1-based) before which the code goes. */
  insertBefore: number | null;
}

export interface PostprocessResult {
  inserted: Array<{ label: string; layer: number; z: number | null; line: number }>;
  layers: number;
}

async function detectEol(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes("\r\n") ? "\r\n" : "\n";
  } finally {
    await handle.close();
  }
}

async function scanLayers(path: string): Promise<LayerMark[]> {
  const layers: LayerMark[] = [];
  let current: LayerMark | null = null;
  let afterMarker = 0;
  let lineNo = 0;
  for await (const raw of readLines(path)) {
    lineNo++;
    const line = raw.trim();
    if (line === ";LAYER_CHANGE") {
      current = { layer: layers.length + 1, z: null, insertBefore: null };
      layers.push(current);
      afterMarker = 0;
      continue;
    }
    if (!current) continue;
    if (current.z === null && line.startsWith(";Z:")) {
      current.z = Number(line.slice(3));
      continue;
    }
    if (current.insertBefore !== null) continue;
    if (afterMarker > 0) {
      // The layer_gcode template echoes the height (";[layer_z]" -> ";0.6"): keep it with the marker.
      current.insertBefore = /^;-?\d*\.?\d+$/.test(line) ? lineNo + 1 : lineNo;
      continue;
    }
    if (line === ";AFTER_LAYER_CHANGE") {
      afterMarker = lineNo;
      continue;
    }
    if (line.startsWith(";TYPE:")) current.insertBefore = lineNo;
  }
  return layers;
}

export async function insertAtLayers(input: string, output: string, inserts: Insert[]): Promise<PostprocessResult> {
  const layers = await scanLayers(input);
  if (layers.length === 0) throw new Refusal("No ;LAYER_CHANGE markers found: this does not look like G-code from PrusaSlicer.");

  const byLine = new Map<number, string[]>();
  const placed: PostprocessResult["inserted"] = [];
  for (const insert of inserts) {
    let target: LayerMark | undefined;
    if (insert.layer !== undefined) {
      target = layers[insert.layer - 1];
      if (!target) throw new Refusal(`Layer ${insert.layer} does not exist; the print has ${layers.length} layers.`);
    } else if (insert.z !== undefined) {
      target = layers.find((layer) => layer.z !== null && layer.z >= insert.z! - 1e-6);
      const top = layers[layers.length - 1]?.z;
      if (!target) throw new Refusal(`No layer at or above Z ${insert.z} mm; the print ends at ${top} mm.`);
    } else {
      throw new Refusal("Every insert needs a layer or a z.");
    }
    if (target.insertBefore === null) throw new Refusal(`Layer ${target.layer} has no point to insert at (no extrusion found).`);
    const block = [`; prusaslicer-mcp: ${insert.label} at layer ${target.layer} (Z ${target.z})`, ...insert.gcode.split(/\r?\n/)];
    byLine.set(target.insertBefore, [...(byLine.get(target.insertBefore) ?? []), ...block]);
    placed.push({ label: insert.label, layer: target.layer, z: target.z, line: target.insertBefore });
  }

  const eol = await detectEol(input);
  const out = createWriteStream(output, { encoding: "utf8" });
  const write = async (text: string) => {
    if (!out.write(text)) await once(out, "drain");
  };
  try {
    let lineNo = 0;
    for await (const line of readLines(input)) {
      lineNo++;
      const block = byLine.get(lineNo);
      if (block) await write(block.join(eol) + eol);
      await write(line + eol);
    }
  } finally {
    out.end();
    await once(out, "close");
  }
  return { inserted: placed.sort((a, b) => a.line - b.line), layers: layers.length };
}
