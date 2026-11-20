import { readFile } from "node:fs/promises";

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * The bounding box of an STL file's vertices, binary or ASCII. Arithmetic only: the mesh is read
 * by PrusaSlicer everywhere else. Used where PrusaSlicer 3.0.0-alpha14's --info reports a box
 * that includes the origin (a model at x 115..135 comes back as 0..135).
 */
export async function stlBounds(path: string): Promise<Bounds | null> {
  const data = await readFile(path);
  const box: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const add = (x: number, y: number, z: number) => {
    const point = [x, y, z];
    for (let axis = 0; axis < 3; axis++) {
      if (point[axis]! < box.min[axis]!) box.min[axis] = point[axis]!;
      if (point[axis]! > box.max[axis]!) box.max[axis] = point[axis]!;
    }
  };

  const count = data.length >= 84 ? data.readUInt32LE(80) : -1;
  if (count >= 0 && data.length === 84 + count * 50) {
    for (let facet = 0; facet < count; facet++) {
      // 12 bytes of normal, then three vertices of three floats.
      const offset = 84 + facet * 50 + 12;
      for (let vertex = 0; vertex < 3; vertex++) {
        const at = offset + vertex * 12;
        add(data.readFloatLE(at), data.readFloatLE(at + 4), data.readFloatLE(at + 8));
      }
    }
  } else {
    const text = data.toString("latin1");
    for (const match of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) add(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  return Number.isFinite(box.min[0]) ? box : null;
}

/** An STL file's triangles, binary or ASCII, as 9 floats each (three vertices). For drawing only. */
export async function readStlTriangles(path: string): Promise<Float32Array> {
  const data = await readFile(path);
  const count = data.length >= 84 ? data.readUInt32LE(80) : -1;
  if (count >= 0 && data.length === 84 + count * 50) {
    const triangles = new Float32Array(count * 9);
    for (let facet = 0; facet < count; facet++) {
      const offset = 84 + facet * 50 + 12;
      for (let i = 0; i < 9; i++) triangles[facet * 9 + i] = data.readFloatLE(offset + i * 4);
    }
    return triangles;
  }
  const values: number[] = [];
  for (const match of data.toString("latin1").matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) values.push(Number(match[1]), Number(match[2]), Number(match[3]));
  return Float32Array.from(values.slice(0, values.length - (values.length % 9)));
}
