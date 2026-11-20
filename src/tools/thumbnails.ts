import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { SlicerContext } from "../context.ts";
import type { Footprint } from "../formats/beds.ts";
import { readGcode } from "../formats/gcode.ts";
import { insertThumbnails, parseThumbnailSpec, type EncodedThumbnail, type ThumbnailSpec } from "../formats/gcode-thumbnails.ts";
import { encodePng, encodeQoi } from "../formats/image.ts";
import { firstOf } from "../formats/ini.ts";
import { readStlTriangles } from "../formats/stl.ts";
import { parseColour, renderThumbnail, type Colour } from "../render/thumbnail.ts";
import { describeFailure } from "../slicer/run.ts";
import { exists } from "../util/paths.ts";
import { transformArgs, type Transforms } from "./args.ts";

/** Larger than any printer display; bounds the time and memory a render takes. */
const MAX_SIDE = 2048;
/** PrusaSlicer's default for a filament without a colour. */
const DEFAULT_COLOUR: Colour = [255, 128, 0];

const label = (spec: ThumbnailSpec) => `${spec.width}x${spec.height}/${spec.format}`;

/**
 * Gives G-code that PrusaSlicer wrote without thumbnails the ones its printer preset asks for, drawn
 * from the model. PrusaSlicer's CLI (2.9.7, 3.0.0-alpha14) renders none: it only embeds a 3MF's
 * Metadata/thumbnail.png, so G-code sliced from an STL showed no preview on the printer.
 *
 * The model is the input itself for a single STL without transforms; otherwise PrusaSlicer exports
 * it as STL with the same transforms. Several objects are drawn where the export puts them, which
 * need not be where the slice arranged them. With `area`, only what lies within it is drawn: the
 * bed a project's G-code is for (its other beds are in the export too). Returns what the G-code
 * holds now; throws when it could not be done, leaving the G-code as sliced.
 */
export async function addThumbnails(
  slicer: SlicerContext,
  gcode: string,
  inputs: string[],
  transforms: Transforms | undefined,
  signal?: AbortSignal,
  area?: Footprint,
): Promise<string> {
  const { report, config } = await readGcode(gcode);
  if (report.thumbnails.length) return "from the 3MF's own thumbnail, embedded by PrusaSlicer";
  const specs = parseThumbnailSpec(config.get("thumbnails"), config.get("thumbnails_format"));
  if (specs.length === 0) return "none: the printer preset asks for no thumbnails";
  const writable = specs.filter((spec) => (spec.format === "PNG" || spec.format === "QOI") && spec.width <= MAX_SIDE && spec.height <= MAX_SIDE);
  const skipped = specs.filter((spec) => !writable.includes(spec));
  if (writable.length === 0) return `none: the printer asks for ${specs.map(label).join(", ")}; this server writes PNG and QOI up to ${MAX_SIDE} px`;

  const mesh = await meshOf(slicer, inputs, transforms, signal);
  const triangles = area ? within(mesh, area) : mesh;
  if (triangles.length === 0) throw new Error(area && mesh.length ? "nothing of the model lies on the bed that was sliced" : "the model has no triangles to draw");
  const colour = parseColour(firstOf(config.get("extruder_colour"))) ?? parseColour(firstOf(config.get("filament_colour"))) ?? DEFAULT_COLOUR;
  const thumbnails: EncodedThumbnail[] = [];
  for (const spec of writable) {
    const image = renderThumbnail(triangles, spec.width, spec.height, colour);
    if (!image) throw new Error(`nothing to draw at ${label(spec)}`);
    thumbnails.push(
      spec.format === "QOI"
        ? { format: "qoi", width: spec.width, height: spec.height, data: encodeQoi(image) }
        : { format: "png", width: spec.width, height: spec.height, data: encodePng(image) },
    );
  }
  await insertThumbnails(gcode, thumbnails, report.format === "binary");
  return (
    `${writable.map(label).join(", ")}, drawn by this server from the model as PrusaSlicer draws them (PrusaSlicer's CLI renders none)` +
    (skipped.length ? `; not written: ${skipped.map(label).join(", ")} (PNG and QOI up to ${MAX_SIDE} px only)` : "")
  );
}

/** The triangles that lie wholly within the area, in X and Y (with 1 mm to spare). */
export function within(triangles: Float32Array, area: Footprint): Float32Array {
  const kept: number[] = [];
  for (let t = 0; t + 9 <= triangles.length; t += 9) {
    let inside = true;
    for (let v = t; v < t + 9 && inside; v += 3) {
      inside = triangles[v]! >= area.minX - 1 && triangles[v]! <= area.maxX + 1 && triangles[v + 1]! >= area.minY - 1 && triangles[v + 1]! <= area.maxY + 1;
    }
    if (inside) for (let i = t; i < t + 9; i++) kept.push(triangles[i]!);
  }
  return Float32Array.from(kept);
}

async function meshOf(slicer: SlicerContext, inputs: string[], transforms: Transforms | undefined, signal?: AbortSignal): Promise<Float32Array> {
  const moved = transformArgs(transforms);
  if (inputs.length === 1 && extname(inputs[0]!).toLowerCase() === ".stl" && moved.length === 0) return readStlTriangles(inputs[0]!);
  const dir = await mkdtemp(join(tmpdir(), "prusaslicer-mcp-mesh-"));
  try {
    const out = join(dir, "model.stl");
    const run = await slicer.run(["--export-stl", ...moved, "--output", out, ...inputs], { signal, timeoutMs: slicer.sliceTimeoutMs });
    if (!(await exists(out))) throw new Error(describeFailure(run, "Exporting the model for its thumbnails"));
    return await readStlTriangles(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
