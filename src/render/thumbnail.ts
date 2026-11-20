import type { Rgba } from "../formats/image.ts";

/**
 * A preview of a mesh as PrusaSlicer draws its G-code thumbnails, in software: PrusaSlicer's CLI
 * renders none (2.9.7 and 3.0.0-alpha14 embed one only from a 3MF that holds Metadata/thumbnail.png).
 *
 * Taken from PrusaSlicer:
 * - The view: from the front left and above, azimuth 45 and zenith 135 degrees, Z up, fitted to the
 *   parts (3.0 source ScopedThumbnailSceneCustomizerBase.cpp, CameraTrackballController.cpp).
 * - The background is transparent; only printable parts are drawn.
 * - The light: the two lights and ambient term of PrusaSlicer 2.x's Gouraud shader, in eye space.
 * The projection here is orthographic, and each face is lit by its own normal.
 */

/** Unit view direction (camera to target), and the camera's right and up vectors. */
const VIEW = [0.5, 0.5, -Math.SQRT1_2] as const;
const RIGHT = [Math.SQRT1_2, -Math.SQRT1_2, 0] as const;
const UP = [0.5, 0.5, Math.SQRT1_2] as const;

const LIGHT_TOP = normalize([-0.4574957, 0.4574957, 0.7624929]);
const LIGHT_FRONT = normalize([0.6985074, 0.1397015, 0.6985074]);
const AMBIENT = 0.3;
const TOP_DIFFUSE = 0.8 * 0.6;
const TOP_SPECULAR = 0.125 * 0.6;
const SHININESS = 20;
const FRONT_DIFFUSE = 0.3 * 0.6;

export type Colour = [number, number, number];

/** "#FF8000" -> [255, 128, 0]; null for anything else. */
export function parseColour(text: string | undefined | null): Colour | null {
  const match = /^#?([0-9a-f]{6})$/i.exec((text ?? "").trim());
  if (!match) return null;
  const value = parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Renders triangles (9 floats each: three vertices x, y, z in mm) at width x height, the parts
 * filling the image less a margin. Returns null when there is nothing to draw.
 */
export function renderThumbnail(triangles: Float32Array, width: number, height: number, colour: Colour): Rgba | null {
  const count = Math.floor(triangles.length / 9);
  if (count === 0 || width < 1 || height < 1) return null;

  // Samples per pixel side: edges are smoothed by averaging, more for the tiny sizes.
  const ss = Math.min(width, height) < 64 ? 4 : 2;
  const sw = width * ss;
  const sh = height * ss;

  // Projected bounds of the parts: the view is fitted to them.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count * 9; i += 3) {
    const x = triangles[i]! * RIGHT[0] + triangles[i + 1]! * RIGHT[1] + triangles[i + 2]! * RIGHT[2];
    const y = triangles[i]! * UP[0] + triangles[i + 1]! * UP[1] + triangles[i + 2]! * UP[2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const margin = Math.max(ss, Math.round(Math.min(sw, sh) * 0.04));
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((sw - 2 * margin) / spanX, (sh - 2 * margin) / spanY);
  if (!(scale > 0)) return null;
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;

  const depth = new Float32Array(sw * sh).fill(Infinity);
  const shade = new Uint8Array(sw * sh * 3);
  const px = [0, 0, 0];
  const py = [0, 0, 0];
  const pz = [0, 0, 0];

  for (let t = 0; t < count; t++) {
    const o = t * 9;
    for (let v = 0; v < 3; v++) {
      const x = triangles[o + v * 3]!;
      const y = triangles[o + v * 3 + 1]!;
      const z = triangles[o + v * 3 + 2]!;
      px[v] = (x * RIGHT[0] + y * RIGHT[1] + z * RIGHT[2] - centreX) * scale + sw / 2;
      py[v] = sh / 2 - (x * UP[0] + y * UP[1] + z * UP[2] - centreY) * scale;
      pz[v] = x * VIEW[0] + y * VIEW[1] + z * VIEW[2];
    }

    // The face's colour: its normal in eye space (x right, y up, z towards the viewer).
    const ax = triangles[o + 3]! - triangles[o]!;
    const ay = triangles[o + 4]! - triangles[o + 1]!;
    const az = triangles[o + 5]! - triangles[o + 2]!;
    const bx = triangles[o + 6]! - triangles[o]!;
    const by = triangles[o + 7]! - triangles[o + 1]!;
    const bz = triangles[o + 8]! - triangles[o + 2]!;
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const length = Math.hypot(nx, ny, nz);
    if (length === 0) continue;
    let ex = (nx * RIGHT[0] + ny * RIGHT[1] + nz * RIGHT[2]) / length;
    let ey = (nx * UP[0] + ny * UP[1] + nz * UP[2]) / length;
    let ez = -(nx * VIEW[0] + ny * VIEW[1] + nz * VIEW[2]) / length;
    // Lit from the side that is seen, so a mesh with inverted faces still shows its shape.
    if (ez < 0) {
      ex = -ex;
      ey = -ey;
      ez = -ez;
    }
    const top = Math.max(0, ex * LIGHT_TOP[0] + ey * LIGHT_TOP[1] + ez * LIGHT_TOP[2]);
    const front = Math.max(0, ex * LIGHT_FRONT[0] + ey * LIGHT_FRONT[1] + ez * LIGHT_FRONT[2]);
    // Reflection of the top light about the normal, against the view direction (0, 0, 1).
    const reflectedZ = 2 * top * ez - LIGHT_TOP[2];
    const specular = top > 0 ? TOP_SPECULAR * Math.pow(Math.max(0, reflectedZ), SHININESS) : 0;
    const diffuse = AMBIENT + TOP_DIFFUSE * top + FRONT_DIFFUSE * front;
    const r = Math.min(255, Math.round(colour[0] * diffuse + 255 * specular));
    const g = Math.min(255, Math.round(colour[1] * diffuse + 255 * specular));
    const b = Math.min(255, Math.round(colour[2] * diffuse + 255 * specular));

    // Fill the samples whose centres lie inside the triangle, keeping the nearest.
    const area = (px[1]! - px[0]!) * (py[2]! - py[0]!) - (py[1]! - py[0]!) * (px[2]! - px[0]!);
    if (area === 0) continue;
    const x0 = Math.max(0, Math.floor(Math.min(px[0]!, px[1]!, px[2]!)));
    const x1 = Math.min(sw - 1, Math.ceil(Math.max(px[0]!, px[1]!, px[2]!)));
    const y0 = Math.max(0, Math.floor(Math.min(py[0]!, py[1]!, py[2]!)));
    const y1 = Math.min(sh - 1, Math.ceil(Math.max(py[0]!, py[1]!, py[2]!)));
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const cx = x + 0.5;
        const w0 = ((px[1]! - cx) * (py[2]! - cy) - (py[1]! - cy) * (px[2]! - cx)) / area;
        const w1 = ((px[2]! - cx) * (py[0]! - cy) - (py[2]! - cy) * (px[0]! - cx)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * pz[0]! + w1 * pz[1]! + w2 * pz[2]!;
        const at = y * sw + x;
        if (d >= depth[at]!) continue;
        depth[at] = d;
        shade[at * 3] = r;
        shade[at * 3 + 1] = g;
        shade[at * 3 + 2] = b;
      }
    }
  }

  // Average the samples of each pixel: coverage becomes alpha, the covered samples the colour.
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let covered = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const at = (y * ss + dy) * sw + x * ss + dx;
          if (depth[at] === Infinity) continue;
          covered++;
          r += shade[at * 3]!;
          g += shade[at * 3 + 1]!;
          b += shade[at * 3 + 2]!;
        }
      }
      if (covered === 0) continue;
      const out = (y * width + x) * 4;
      pixels[out] = Math.round(r / covered);
      pixels[out + 1] = Math.round(g / covered);
      pixels[out + 2] = Math.round(b / covered);
      pixels[out + 3] = Math.round((covered * 255) / (ss * ss));
    }
  }
  return { width, height, pixels };
}

function normalize(v: [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}
