import { crc32, deflateSync } from "node:zlib";

/**
 * Image encoders for G-code thumbnails, from 8-bit RGBA pixels (straight alpha, rows top to bottom).
 * PNG and QOI are what PrusaSlicer's printer profiles ask for ("16x16/QOI, 380x285/PNG"); the
 * bundled vendor profiles of 2.9.7 ask for nothing else.
 */

export interface Rgba {
  width: number;
  height: number;
  /** width * height * 4 bytes. */
  pixels: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** PNG, colour type 6 (RGBA), 8 bits, no interlace, filter 0 on every row. */
export function encodePng(image: Rgba): Buffer {
  const { width, height, pixels } = image;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}

const QOI_OP_INDEX = 0x00;
const QOI_OP_DIFF = 0x40;
const QOI_OP_LUMA = 0x80;
const QOI_OP_RUN = 0xc0;
const QOI_OP_RGB = 0xfe;
const QOI_OP_RGBA = 0xff;

/**
 * QOI (qoiformat.org), 4 channels, sRGB with linear alpha, written as the reference encoder
 * (qoi.h) writes it, which PrusaSlicer uses: the same pixels give the same bytes.
 */
export function encodeQoi(image: Rgba): Buffer {
  const { width, height, pixels } = image;
  const total = width * height;
  const out = Buffer.alloc(14 + total * 5 + 8);
  out.write("qoif", 0, "ascii");
  out.writeUInt32BE(width, 4);
  out.writeUInt32BE(height, 8);
  out[12] = 4;
  out[13] = 0;
  let at = 14;

  const index = new Uint32Array(64);
  let pr = 0;
  let pg = 0;
  let pb = 0;
  let pa = 255;
  let run = 0;
  for (let i = 0; i < total; i++) {
    const r = pixels[i * 4]!;
    const g = pixels[i * 4 + 1]!;
    const b = pixels[i * 4 + 2]!;
    const a = pixels[i * 4 + 3]!;
    if (r === pr && g === pg && b === pb && a === pa) {
      run++;
      if (run === 62 || i === total - 1) {
        out[at++] = QOI_OP_RUN | (run - 1);
        run = 0;
      }
      continue;
    }
    if (run > 0) {
      out[at++] = QOI_OP_RUN | (run - 1);
      run = 0;
    }
    const packed = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    const hash = (r * 3 + g * 5 + b * 7 + a * 11) % 64;
    if (index[hash] === packed) {
      out[at++] = QOI_OP_INDEX | hash;
    } else {
      index[hash] = packed;
      if (a === pa) {
        const vr = (((r - pr) << 24) >> 24);
        const vg = (((g - pg) << 24) >> 24);
        const vb = (((b - pb) << 24) >> 24);
        const vgr = vr - vg;
        const vgb = vb - vg;
        if (vr > -3 && vr < 2 && vg > -3 && vg < 2 && vb > -3 && vb < 2) {
          out[at++] = QOI_OP_DIFF | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2);
        } else if (vgr > -9 && vgr < 8 && vg > -33 && vg < 32 && vgb > -9 && vgb < 8) {
          out[at++] = QOI_OP_LUMA | (vg + 32);
          out[at++] = ((vgr + 8) << 4) | (vgb + 8);
        } else {
          out[at++] = QOI_OP_RGB;
          out[at++] = r;
          out[at++] = g;
          out[at++] = b;
        }
      } else {
        out[at++] = QOI_OP_RGBA;
        out[at++] = r;
        out[at++] = g;
        out[at++] = b;
        out[at++] = a;
      }
    }
    pr = r;
    pg = g;
    pb = b;
    pa = a;
  }
  for (let i = 0; i < 7; i++) out[at++] = 0;
  out[at++] = 1;
  return out.subarray(0, at);
}
