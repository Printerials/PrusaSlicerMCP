import { ZipReader, ZipWriter } from "./zip.ts";

/**
 * The beds of a PrusaSlicer project, and what stands on each.
 *
 * PrusaSlicer's command line slices one bed and leaves the others out without a word: a project
 * with a cube on each of three beds gave the G-code of the first, exit 0 (2.9.7 and
 * 3.0.0-alpha14, measured 2026-11-20). Moving the objects of bed N onto bed 1, and those of bed 1
 * onto bed N, made both slice bed N; that is what writeBedCopy does.
 *
 * - 2.9 keeps the beds implicit (source 2.9.7 MultipleBeds.cpp). Bed i lies at grid(i) times the
 *   bed's size plus a gap of min(100 mm, 0.3 x the diagonal of the bed), at most 9 beds, and an
 *   instance belongs to the bed it lies wholly inside. Per-bed colour changes and wipe towers carry
 *   bed_idx in their metadata files. 2.9.7's CLI applies them wrongly: with more than one bed in
 *   use it gave bed 1 the pauses of bed 2 (bed_idx 1), and none when bed 2 had none; with one bed
 *   in use, bed 1's (measured with pauses per bed in five projects).
 * - 3.0 lists each config container's beds in Metadata/PrusaSlicer3_project.json, with position_x
 *   and position_y. The CLI slices the bed at the first position, also with the list reordered
 *   (measured). Its per-bed colour changes and pauses go with the bed: bed 1 got its own, and so
 *   did bed 2 once the beds had changed places (measured).
 */

export interface Footprint {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface BuildItem {
  /** Position among the build items of 3D/3dmodel.model. */
  index: number;
  objectId: string;
  /** The object's name, with the instance when the object has more than one. */
  name: string;
  printable: boolean;
  /** Where its mesh lies on the plate, or null when it has none. */
  footprint: Footprint | null;
}

export interface BedsInfo {
  kind: "prusaslicer-2" | "prusaslicer-3";
  /** Every bed, first the one PrusaSlicer's CLI slices; origin is its offset from bed 1. */
  beds: Array<{ bed: number; origin: [number, number]; items: BuildItem[] }>;
  /** Items wholly on no bed: PrusaSlicer leaves them out. */
  outside: BuildItem[];
  /** The area of bed 1 on the plate. */
  area: Footprint;
  /** 3.0: how many printers (config containers) the project has; only the first one's beds are read. */
  containers: number;
}

const MAX_BEDS_2X = 9;
const EPSILON = 0.01;

type Matrix = number[]; // 3MF order: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32
const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

interface ObjectGeometry {
  name: string | null;
  vertices: Float64Array | null;
  components: Array<{ objectId: string; transform: Matrix }>;
}

interface RawItem {
  objectId: string;
  transform: Matrix;
  printable: boolean;
}

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attrs)?.[1];
}

function parseMatrix(text: string | undefined): Matrix {
  if (!text) return [...IDENTITY];
  const numbers = text.trim().split(/\s+/).map(Number);
  return numbers.length === 12 && numbers.every(Number.isFinite) ? numbers : [...IDENTITY];
}

/** First a, then b. */
function compose(a: Matrix, b: Matrix): Matrix {
  const out = new Array<number>(12);
  for (let column = 0; column < 3; column++) {
    for (let row = 0; row < 3; row++) {
      out[row * 3 + column] = a[row * 3]! * b[column]! + a[row * 3 + 1]! * b[3 + column]! + a[row * 3 + 2]! * b[6 + column]!;
    }
    out[9 + column] = a[9]! * b[column]! + a[10]! * b[3 + column]! + a[11]! * b[6 + column]! + b[9 + column]!;
  }
  return out;
}

/** The objects and build items of 3D/3dmodel.model, as PrusaSlicer writes it. */
export function parseModelGeometry(xml: string): { objects: Map<string, ObjectGeometry>; items: RawItem[] } {
  const objects = new Map<string, ObjectGeometry>();
  for (const match of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = attr(match[1]!, "id");
    if (!id) continue;
    const body = match[2]!;
    const coordinates: number[] = [];
    for (const vertex of body.matchAll(/<vertex\b([^>]*)\/?>/g)) {
      const fast = /x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"/.exec(vertex[1]!);
      const [x, y, z] = fast ? [fast[1], fast[2], fast[3]] : [attr(vertex[1]!, "x"), attr(vertex[1]!, "y"), attr(vertex[1]!, "z")];
      coordinates.push(Number(x), Number(y), Number(z));
    }
    const components = [...body.matchAll(/<component\b([^>]*)\/?>/g)].flatMap((component) => {
      const objectId = attr(component[1]!, "objectid");
      return objectId ? [{ objectId, transform: parseMatrix(attr(component[1]!, "transform")) }] : [];
    });
    objects.set(id, { name: attr(match[1]!, "name") ?? null, vertices: coordinates.length ? Float64Array.from(coordinates) : null, components });
  }
  const build = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml)?.[1] ?? "";
  const items = [...build.matchAll(/<item\b([^>]*)\/?>/g)].flatMap((item) => {
    const objectId = attr(item[1]!, "objectid");
    return objectId ? [{ objectId, transform: parseMatrix(attr(item[1]!, "transform")), printable: attr(item[1]!, "printable") !== "0" }] : [];
  });
  return { objects, items };
}

function footprintOf(objects: Map<string, ObjectGeometry>, objectId: string, transform: Matrix, depth = 0): Footprint | null {
  const object = objects.get(objectId);
  if (!object || depth > 16) return null;
  let result: Footprint | null = null;
  const merge = (other: Footprint | null) => {
    if (!other) return;
    result = result
      ? { minX: Math.min(result.minX, other.minX), maxX: Math.max(result.maxX, other.maxX), minY: Math.min(result.minY, other.minY), maxY: Math.max(result.maxY, other.maxY) }
      : other;
  };
  if (object.vertices) {
    const v = object.vertices;
    const m = transform;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i]! * m[0]! + v[i + 1]! * m[3]! + v[i + 2]! * m[6]! + m[9]!;
      const y = v[i]! * m[1]! + v[i + 1]! * m[4]! + v[i + 2]! * m[7]! + m[10]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    merge({ minX, maxX, minY, maxY });
  }
  for (const component of object.components) merge(footprintOf(objects, component.objectId, compose(component.transform, transform), depth + 1));
  return result;
}

/** bed_shape as 2.x writes it ("0x0,250x0,250x220,0x220") or as 3.0 does ([[0, 0], [250, 0], ...]). */
export function parseBedShape(value: unknown): Footprint | null {
  const points: Array<[number, number]> = [];
  if (typeof value === "string") {
    for (const point of value.split(",")) {
      const [x, y] = point.trim().split("x").map(Number);
      if (Number.isFinite(x) && Number.isFinite(y)) points.push([x!, y!]);
    }
  } else if (Array.isArray(value)) {
    for (const point of value) if (Array.isArray(point) && point.length >= 2) points.push([Number(point[0]), Number(point[1])]);
  }
  if (points.length < 3 || points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null;
  return {
    minX: Math.min(...points.map(([x]) => x)),
    maxX: Math.max(...points.map(([x]) => x)),
    minY: Math.min(...points.map(([, y]) => y)),
    maxY: Math.max(...points.map(([, y]) => y)),
  };
}

/** 2.9.7's BedsGrid::index2grid_coords, first quadrant: 0 (0,0), 1 (1,0), 2 (0,1), 3 (1,1), 4 (2,0), ... */
export function gridCoords(index: number): [number, number] {
  if (index === 0) return [0, 0];
  let id = index + 1;
  let a = 1;
  while ((a + 1) * (a + 1) < id) a++;
  id -= a * a;
  return id <= a ? [a, id - 1] : [id - a - 1, a];
}

/** The offsets of 2.9's beds from bed 1 (MultipleBeds::get_bed_translation, current layout). */
export function bedOrigins2x(area: Footprint): Array<[number, number]> {
  const width = area.maxX - area.minX;
  const depth = area.maxY - area.minY;
  const gap = Math.min(100, Math.hypot(width, depth) * 0.3);
  return Array.from({ length: MAX_BEDS_2X }, (_, index) => {
    const [x, y] = gridCoords(index);
    return [x * (width + gap), y * (depth + gap)];
  });
}

function inside(footprint: Footprint, area: Footprint, origin: [number, number]): boolean {
  return (
    footprint.minX >= area.minX + origin[0] - EPSILON &&
    footprint.maxX <= area.maxX + origin[0] + EPSILON &&
    footprint.minY >= area.minY + origin[1] - EPSILON &&
    footprint.maxY <= area.maxY + origin[1] + EPSILON
  );
}

export interface BedsInput {
  kind: "prusaslicer-2" | "prusaslicer-3";
  modelXml: string;
  /** The project's bed_shape. */
  bedShape: unknown;
  /** 3.0: config_containers[0].beds; null for 2.x. */
  beds3: Array<{ position_x?: number; position_y?: number }> | null;
  containers: number;
  /** Object names by 3MF object id, where the project keeps them apart from the model. */
  names: Map<string, string>;
}

export function findBeds(input: BedsInput): BedsInfo | null {
  const area = parseBedShape(input.bedShape);
  if (!area) return null;
  const { objects, items } = parseModelGeometry(input.modelXml);
  const perObject = new Map<string, number>();
  for (const item of items) perObject.set(item.objectId, (perObject.get(item.objectId) ?? 0) + 1);
  const seen = new Map<string, number>();
  const built: BuildItem[] = items.map((item, index) => {
    const base = input.names.get(item.objectId) ?? objects.get(item.objectId)?.name ?? `object ${item.objectId}`;
    const instance = (seen.get(item.objectId) ?? 0) + 1;
    seen.set(item.objectId, instance);
    return {
      index,
      objectId: item.objectId,
      name: (perObject.get(item.objectId) ?? 1) > 1 ? `${base} (instance ${instance})` : base,
      printable: item.printable,
      footprint: footprintOf(objects, item.objectId, item.transform),
    };
  });

  const origins: Array<[number, number]> =
    input.kind === "prusaslicer-3" && input.beds3?.length
      ? input.beds3.map((bed) => [Number(bed.position_x ?? 0), Number(bed.position_y ?? 0)])
      : input.kind === "prusaslicer-3"
        ? [[0, 0]]
        : bedOrigins2x(area);
  const beds = origins.map((origin, index) => ({ bed: index + 1, origin, items: [] as BuildItem[] }));
  const outside: BuildItem[] = [];
  for (const item of built) {
    const bed = item.footprint ? beds.find((candidate) => inside(item.footprint!, area, candidate.origin)) : undefined;
    if (bed) bed.items.push(item);
    else if (item.footprint) outside.push(item);
  }
  // 2.9 has as many beds as the highest one in use; 3.0 lists its own.
  if (input.kind === "prusaslicer-2") {
    const last = beds.reduce((highest, bed, index) => (bed.items.length ? index : highest), 0);
    beds.length = last + 1;
  }
  return { kind: input.kind, beds, outside, area, containers: input.containers };
}

/** The beds that have something to print on them. */
export function occupiedBeds(info: BedsInfo): BedsInfo["beds"] {
  return info.beds.filter((bed) => bed.items.some((item) => item.printable));
}

/**
 * Whether slicing `bed` takes a copy of the project: another bed than the first, or a 2.9 project
 * with more than one bed in use, whose per-bed colour changes 2.9.7's CLI would take from bed 2.
 */
export function needsBedCopy(info: BedsInfo, bed: number): boolean {
  return bed !== 1 || (info.kind === "prusaslicer-2" && occupiedBeds(info).length > 1);
}

/**
 * A copy of the project that PrusaSlicer's CLI slices as bed `bed` (1-based). That bed and bed 1
 * change places: their objects move by the difference of the two beds' offsets.
 * - 3.0: their colour changes, pauses and wipe towers change places with them.
 * - 2.9: every bed gets the colour changes, pauses and wipe tower of `bed`, so the CLI applies
 *   them whichever bed's it reads.
 * Every other entry is copied as stored, except the thumbnail, which shows bed 1 (the slice gets
 * one drawn from what it slices). The output must not exist yet.
 */
export async function writeBedCopy(input: string, output: string, info: BedsInfo, bed: number): Promise<void> {
  const target = info.beds[bed - 1];
  const first = info.beds[0];
  if (!target || !first) throw new Error(`The project has no bed ${bed}.`);
  const dx = target.origin[0] - first.origin[0];
  const dy = target.origin[1] - first.origin[1];
  const shift = new Map<number, [number, number]>();
  for (const item of first.items) shift.set(item.index, [dx, dy]);
  for (const item of target.items) shift.set(item.index, [-dx, -dy]);

  const source = await ZipReader.open(input);
  try {
    const writer = await ZipWriter.create(output);
    try {
      for (const name of source.entries.keys()) {
        const lower = name.toLowerCase();
        if (lower === "metadata/thumbnail.png" && bed !== 1) continue;
        if (lower === "3d/3dmodel.model") {
          await writer.add(name, moveItems((await source.readText(name)) ?? "", shift));
        } else if (info.kind === "prusaslicer-2" && lower === "metadata/prusa_slicer_custom_gcode_per_print_z.xml") {
          await writer.add(name, customGcodesForEveryBed((await source.readText(name)) ?? "", bed - 1, info.beds.length));
        } else if (info.kind === "prusaslicer-2" && lower === "metadata/prusa_slicer_wipe_tower_information.xml") {
          await writer.add(name, wipeTowerForEveryBed((await source.readText(name)) ?? "", bed - 1, info.beds.length));
        } else if (info.kind === "prusaslicer-3" && lower === "metadata/prusaslicer3_project.json") {
          await writer.add(name, swapBedData((await source.readText(name)) ?? "", 0, bed - 1));
        } else {
          const raw = (await source.readRaw(name))!;
          await writer.addRaw(name, raw.entry.method, raw.entry.crc32, raw.entry.size, raw.data);
        }
      }
    } finally {
      await writer.close();
    }
  } finally {
    await source.close();
  }
}

/** The model with the given build items (by position) moved in X and Y. */
export function moveItems(xml: string, shift: Map<number, [number, number]>): string {
  const build = /<build\b[^>]*>[\s\S]*?<\/build>/.exec(xml);
  if (!build) return xml;
  let index = 0;
  const moved = build[0].replace(/<item\b([^>]*?)(\/?)>/g, (whole, attrs: string, slash: string) => {
    const by = shift.get(index++);
    if (!by) return whole;
    const matrix = parseMatrix(attr(attrs, "transform"));
    matrix[9] = matrix[9]! + by[0];
    matrix[10] = matrix[10]! + by[1];
    const transform = matrix.map((value) => String(value)).join(" ");
    const rest = /(?:^|\s)transform\s*=\s*"[^"]*"/.test(attrs) ? attrs.replace(/((?:^|\s)transform\s*=\s*)"[^"]*"/, `$1"${transform}"`) : `${attrs} transform="${transform}"`;
    return `<item${rest}${slash}>`;
  });
  return xml.slice(0, build.index) + moved + xml.slice(build.index + build[0].length);
}

/**
 * 2.9's custom G-code file with bed `from`'s block (0-based) copied to every bed. 2.9 writes the
 * blocks side by side, each <custom_gcodes_per_print_z bed_idx="k"> with its codes and mode; one
 * without bed_idx is bed 0 (older projects).
 */
export function customGcodesForEveryBed(xml: string, from: number, beds: number): string {
  const blocks = [...xml.matchAll(/<custom_gcodes_per_print_z\b([^>]*)>([\s\S]*?)<\/custom_gcodes_per_print_z>/g)];
  if (!blocks.length) return xml;
  const bedOf = (attrs: string) => Number(attr(attrs, "bed_idx") ?? 0);
  const chosen = blocks.find((block) => bedOf(block[1]!) === from);
  const mode = /<mode\b[^>]*\/>/.exec(blocks[0]![2]!)?.[0] ?? "";
  const inner = chosen ? chosen[2]! : mode;
  const head = xml.slice(0, blocks[0]!.index);
  return head + Array.from({ length: beds }, (_, bed) => `<custom_gcodes_per_print_z bed_idx="${bed}">${inner}</custom_gcodes_per_print_z>\n`).join("");
}

/** 2.9's wipe tower file with bed `from`'s position and rotation (0-based) on every bed. */
export function wipeTowerForEveryBed(xml: string, from: number, beds: number): string {
  const towers = [...xml.matchAll(/<wipe_tower_information\b([^>]*?)\/?>/g)];
  if (!towers.length) return xml;
  const chosen = towers.find((tower) => Number(attr(tower[1]!, "bed_idx") ?? 0) === from) ?? towers[0]!;
  const rest = chosen[1]!.replace(/\s*bed_idx\s*=\s*"[^"]*"/, "");
  const head = xml.slice(0, towers[0]!.index);
  return head + Array.from({ length: beds }, (_, bed) => `<wipe_tower_information bed_idx="${bed}"${rest}/>\n`).join("");
}

/** 3.0: the first container's beds a and b exchange everything but their position. */
export function swapBedData(text: string, a: number, b: number): string {
  const data = JSON.parse(text) as { config_containers?: Array<{ beds?: Array<Record<string, unknown>> }> };
  const beds = data.config_containers?.[0]?.beds;
  if (!beds?.[a] || !beds[b]) return text;
  const keep = (bed: Record<string, unknown>) => ({ position_x: bed.position_x, position_y: bed.position_y });
  const [first, second] = [beds[a]!, beds[b]!];
  beds[a] = { ...second, ...keep(first) };
  beds[b] = { ...first, ...keep(second) };
  return JSON.stringify(data);
}
