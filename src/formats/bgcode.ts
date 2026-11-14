import { open, type FileHandle } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { parseIniConfig, type FlatConfig } from "./ini.ts";

/**
 * Prusa binary G-code (libbgcode format v1), metadata and thumbnails only.
 *
 * File header: "GCDE", version (u32), checksum type (u16: 0 none, 1 CRC32). Then blocks:
 *   type (u16), compression (u16: 0 none, 1 deflate, 2 heatshrink 11/4, 3 heatshrink 12/4),
 *   uncompressed size (u32), compressed size (u32, only when compressed),
 *   parameters (u16 encoding; thumbnails: u16 format, u16 width, u16 height),
 *   data, checksum (4 bytes with CRC32).
 * Block types: 0 file, 1 G-code, 2 slicer (the full config), 3 printer, 4 print, 5 thumbnail.
 * Metadata is "key=value" lines. G-code blocks (heatshrink and MeatPack) are skipped, so layer
 * and feature statistics need an ASCII export.
 */

export const BGCODE_MAGIC = "GCDE";

export interface Thumbnail {
  format: "png" | "jpg" | "qoi" | "unknown";
  width: number;
  height: number;
  data: Buffer;
}

export interface BgcodeMetadata {
  version: number;
  file: FlatConfig;
  printer: FlatConfig;
  print: FlatConfig;
  slicer: FlatConfig;
  thumbnails: Thumbnail[];
  gcodeBlocks: number;
}

const THUMBNAIL_FORMATS = ["png", "jpg", "qoi"] as const;

export async function isBgcodeFile(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    return bytesRead === 4 && head.toString("ascii") === BGCODE_MAGIC;
  } finally {
    await handle.close();
  }
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

export async function readBgcodeMetadata(path: string): Promise<BgcodeMetadata> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const header = await readAt(handle, 0, 10);
    if (header.length < 10 || header.toString("ascii", 0, 4) !== BGCODE_MAGIC) throw new Error("Not a binary G-code file.");
    const checksumSize = header.readUInt16LE(8) === 1 ? 4 : 0;
    const meta: BgcodeMetadata = {
      version: header.readUInt32LE(4),
      file: new Map(),
      printer: new Map(),
      print: new Map(),
      slicer: new Map(),
      thumbnails: [],
      gcodeBlocks: 0,
    };

    let offset = 10;
    while (offset + 8 <= size) {
      const block = await readAt(handle, offset, 12);
      const type = block.readUInt16LE(0);
      const compression = block.readUInt16LE(2);
      const uncompressedSize = block.readUInt32LE(4);
      const headerSize = compression === 0 ? 8 : 12;
      const dataSize = compression === 0 ? uncompressedSize : block.readUInt32LE(8);
      const paramsSize = type === 5 ? 6 : 2;
      const paramsStart = offset + headerSize;
      const dataStart = paramsStart + paramsSize;

      if (type === 1) {
        meta.gcodeBlocks++;
      } else if (type === 5) {
        const params = await readAt(handle, paramsStart, 6);
        meta.thumbnails.push({
          format: THUMBNAIL_FORMATS[params.readUInt16LE(0)] ?? "unknown",
          width: params.readUInt16LE(2),
          height: params.readUInt16LE(4),
          data: await readAt(handle, dataStart, dataSize),
        });
      } else if (type <= 4 && (compression === 0 || compression === 1)) {
        const raw = await readAt(handle, dataStart, dataSize);
        const text = (compression === 1 ? inflateSync(raw) : raw).toString("utf8");
        const target = type === 0 ? meta.file : type === 2 ? meta.slicer : type === 3 ? meta.printer : meta.print;
        for (const [key, value] of parseKeyValueLines(text)) target.set(key, value);
      }
      offset = dataStart + dataSize + checksumSize;
    }
    return meta;
  } finally {
    await handle.close();
  }
}

/** "key=value" without spaces around "=", as bgcode metadata stores it. */
function parseKeyValueLines(text: string): FlatConfig {
  const map: FlatConfig = new Map();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  // Fall back to the "key = value" form should a writer use it.
  return map.size > 0 ? map : parseIniConfig(text);
}
