import { open, type FileHandle } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

/**
 * A minimal ZIP reader for 3MF: the central directory, stored and deflated entries, ZIP64 sizes
 * and offsets. Only the entries asked for are read, so a 200 MB project costs a few small reads.
 */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRY = 256 * 1024 * 1024;

export class ZipReader {
  private readonly handle: FileHandle;
  readonly entries: Map<string, ZipEntry>;

  private constructor(handle: FileHandle, entries: Map<string, ZipEntry>) {
    this.handle = handle;
    this.entries = entries;
  }

  static async open(path: string): Promise<ZipReader> {
    const handle = await open(path, "r");
    try {
      return new ZipReader(handle, await readCentralDirectory(handle));
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Case-insensitive lookup, as PrusaSlicer does for its metadata files. */
  find(name: string): ZipEntry | undefined {
    const exact = this.entries.get(name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    for (const [key, entry] of this.entries) if (key.toLowerCase() === lower) return entry;
    return undefined;
  }

  async read(name: string): Promise<Buffer | null> {
    const entry = this.find(name);
    if (!entry) return null;
    if (entry.size > MAX_ENTRY) throw new Error(`${name} is too large to read (${entry.size} bytes).`);
    const header = await readAt(this.handle, entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== LOCAL) throw new Error(`Corrupt ZIP: no local header for ${name}.`);
    const dataStart = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const data = await readAt(this.handle, dataStart, entry.compressedSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRawSync(data);
    throw new Error(`${name} uses ZIP compression method ${entry.method}, which is not supported.`);
  }

  async readText(name: string): Promise<string | null> {
    const data = await this.read(name);
    return data ? data.toString("utf8") : null;
  }
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
    if (bytesRead === 0) throw new Error("Unexpected end of ZIP file.");
    read += bytesRead;
  }
  return buffer;
}

async function readCentralDirectory(handle: FileHandle): Promise<Map<string, ZipEntry>> {
  const { size } = await handle.stat();
  const tailSize = Math.min(size, 65_557);
  const tail = await readAt(handle, size - tailSize, tailSize);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("Not a ZIP file (no end of central directory).");

  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  const locator = eocd - 20;
  if (locator >= 0 && tail.readUInt32LE(locator) === EOCD64_LOCATOR) {
    const eocd64Offset = Number(tail.readBigUInt64LE(locator + 8));
    const record = await readAt(handle, eocd64Offset, 56);
    if (record.readUInt32LE(0) === EOCD64) {
      count = Number(record.readBigUInt64LE(32));
      cdSize = Number(record.readBigUInt64LE(40));
      cdOffset = Number(record.readBigUInt64LE(48));
    }
  }

  const cd = await readAt(handle, cdOffset, cdSize);
  const entries = new Map<string, ZipEntry>();
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== CENTRAL) throw new Error("Corrupt ZIP central directory.");
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    let uncompressed = cd.readUInt32LE(p + 24);
    const nameLength = cd.readUInt16LE(p + 28);
    const extraLength = cd.readUInt16LE(p + 30);
    const commentLength = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const name = cd.toString("utf8", p + 46, p + 46 + nameLength).replace(/^\/+/, "");

    // ZIP64: the real values are in extra field 0x0001, in this order, for each field that is 0xFFFFFFFF.
    let e = p + 46 + nameLength;
    const extraEnd = e + extraLength;
    while (e + 4 <= extraEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncompressed === 0xffffffff) {
          uncompressed = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
        if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(q));
      }
      e += 4 + len;
    }

    entries.set(name, { name, method, compressedSize, size: uncompressed, localHeaderOffset: offset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
