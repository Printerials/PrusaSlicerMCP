import { open, type FileHandle } from "node:fs/promises";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * A minimal ZIP reader for 3MF: the central directory, stored and deflated entries, ZIP64 sizes
 * and offsets. Only the entries asked for are read, so a 200 MB project costs a few small reads.
 */

export interface ZipEntry {
  name: string;
  method: number;
  crc32: number;
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

  /** The entry's data as stored (compressed), for copying it into another archive unchanged. */
  async readRaw(name: string): Promise<{ entry: ZipEntry; data: Buffer } | null> {
    const entry = this.find(name);
    if (!entry) return null;
    if (entry.compressedSize > MAX_ENTRY) throw new Error(`${name} is too large to read (${entry.compressedSize} bytes).`);
    const header = await readAt(this.handle, entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== LOCAL) throw new Error(`Corrupt ZIP: no local header for ${name}.`);
    const dataStart = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    return { entry, data: await readAt(this.handle, dataStart, entry.compressedSize) };
  }

  async read(name: string): Promise<Buffer | null> {
    const raw = await this.readRaw(name);
    if (!raw) return null;
    const { entry, data } = raw;
    if (entry.size > MAX_ENTRY) throw new Error(`${name} is too large to read (${entry.size} bytes).`);
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
    const crc32 = cd.readUInt32LE(p + 16);
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

    entries.set(name, { name, method, crc32, compressedSize, size: uncompressed, localHeaderOffset: offset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Writes a ZIP archive entry by entry: raw entries (copied, still compressed, with their CRC) and
 * new ones (deflated here). No ZIP64: entries and the archive stay under 4 GB.
 */
export class ZipWriter {
  private readonly central: Buffer[] = [];
  private offset = 0;
  private count = 0;
  private readonly handle: FileHandle;

  private constructor(handle: FileHandle) {
    this.handle = handle;
  }

  static async create(path: string): Promise<ZipWriter> {
    return new ZipWriter(await open(path, "wx"));
  }

  async addRaw(name: string, method: number, crc32: number, size: number, compressed: Buffer): Promise<void> {
    if (size > 0xffffffff || compressed.length > 0xffffffff || this.offset > 0xffffffff) {
      throw new Error("The archive is too large to write without ZIP64.");
    }
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32 >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32 >>> 0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(this.offset, 42);
    this.central.push(central, nameBytes);

    await this.handle.write(Buffer.concat([local, nameBytes]));
    await this.handle.write(compressed);
    this.offset += 30 + nameBytes.length + compressed.length;
    this.count++;
  }

  async add(name: string, content: Buffer | string): Promise<void> {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    await this.addRaw(name, 8, crc32(data), data.length, deflateRawSync(data));
  }

  async close(): Promise<void> {
    try {
      const cd = Buffer.concat(this.central);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(EOCD, 0);
      end.writeUInt16LE(this.count, 8);
      end.writeUInt16LE(this.count, 10);
      end.writeUInt32LE(cd.length, 12);
      end.writeUInt32LE(this.offset, 16);
      await this.handle.write(Buffer.concat([cd, end]));
    } finally {
      await this.handle.close();
    }
  }
}
