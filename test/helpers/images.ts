/**
 * Decoders for the tests: QOI (all ops, as the reference decoder) and PNG as encodePng writes it
 * (RGBA, 8 bits, filter 0). Enough to check what the encoders produce and to re-encode
 * PrusaSlicer's own thumbnails.
 */
import { inflateSync } from "node:zlib";
import type { Rgba } from "../../src/formats/image.ts";

export function decodeQoi(data: Buffer): Rgba {
  if (data.toString("ascii", 0, 4) !== "qoif") throw new Error("not QOI");
  const width = data.readUInt32BE(4);
  const height = data.readUInt32BE(8);
  const pixels = new Uint8Array(width * height * 4);
  const index = new Uint8Array(64 * 4);
  let [r, g, b, a] = [0, 0, 0, 255];
  let at = 14;
  let run = 0;
  for (let i = 0; i < width * height; i++) {
    if (run > 0) {
      run--;
    } else {
      const op = data[at++]!;
      if (op === 0xfe) {
        [r, g, b] = [data[at++]!, data[at++]!, data[at++]!];
      } else if (op === 0xff) {
        [r, g, b, a] = [data[at++]!, data[at++]!, data[at++]!, data[at++]!];
      } else if ((op & 0xc0) === 0x00) {
        const h = (op & 0x3f) * 4;
        [r, g, b, a] = [index[h]!, index[h + 1]!, index[h + 2]!, index[h + 3]!];
      } else if ((op & 0xc0) === 0x40) {
        r = (r + ((op >> 4) & 3) - 2) & 255;
        g = (g + ((op >> 2) & 3) - 2) & 255;
        b = (b + (op & 3) - 2) & 255;
      } else if ((op & 0xc0) === 0x80) {
        const second = data[at++]!;
        const vg = (op & 0x3f) - 32;
        r = (r + vg - 8 + ((second >> 4) & 15)) & 255;
        g = (g + vg) & 255;
        b = (b + vg - 8 + (second & 15)) & 255;
      } else {
        run = op & 0x3f;
      }
      const h = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4;
      index.set([r, g, b, a], h);
    }
    pixels.set([r, g, b, a], i * 4);
  }
  return { width, height, pixels };
}

export function decodePng(data: Buffer): Rgba {
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (at < data.length) {
    const length = data.readUInt32BE(at);
    const type = data.toString("ascii", at + 4, at + 8);
    const body = data.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6) throw new Error("only 8-bit RGBA");
    } else if (type === "IDAT") {
      idat.push(body);
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (raw[y * (width * 4 + 1)] !== 0) throw new Error("only filter 0");
    pixels.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { width, height, pixels };
}
