import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readBgcodeMetadata } from "../../src/formats/bgcode.ts";
import { analyzeAsciiGcode } from "../../src/formats/gcode-ascii.ts";
import {
  asciiThumbnailBlock,
  bgcodeThumbnailBlock,
  checkBgcode,
  insertThumbnails,
  parseThumbnailSpec,
  type EncodedThumbnail,
} from "../../src/formats/gcode-thumbnails.ts";
import { encodePng, encodeQoi } from "../../src/formats/image.ts";
import { readStlTriangles } from "../../src/formats/stl.ts";
import { parseColour, renderThumbnail } from "../../src/render/thumbnail.ts";
import { decodePng, decodeQoi } from "../helpers/images.ts";

const fixtures = new URL("../fixtures/", import.meta.url).pathname;

// PrusaSlicer 2.9.7, 2026-11-20: a 3MF holding Metadata/thumbnail.png (a colour gradient made for
// the test) sliced for a CORE One, ASCII and binary. These are its 16x16 QOI blocks.
const asciiBlock = await readFile(join(fixtures, "thumbnails-2.9.7", "ascii-16x16-qoi.txt"), "latin1");
const binaryBlock = await readFile(join(fixtures, "thumbnails-2.9.7", "bgcode-16x16-qoi.bin"));
const qoiFromAscii = Buffer.from(
  asciiBlock
    .split("\n")
    .filter((line) => /^; [A-Za-z0-9+/=]+$/.test(line))
    .map((line) => line.slice(2))
    .join(""),
  "base64",
);

test("encodeQoi writes PrusaSlicer's QOI bytes for the same pixels", () => {
  const image = decodeQoi(qoiFromAscii);
  assert.equal(image.width, 16);
  assert.deepEqual(encodeQoi(image), qoiFromAscii);
  const fromBinary = binaryBlock.subarray(14, binaryBlock.length - 4);
  assert.deepEqual(encodeQoi(decodeQoi(fromBinary)), fromBinary);
});

test("encodeQoi round-trips runs, alpha changes and large jumps", () => {
  const pixels = new Uint8Array(70 * 3 * 4);
  for (let i = 0; i < 70 * 3; i++) {
    const solid = i < 70; // a run longer than 62
    pixels.set(solid ? [10, 20, 30, 255] : [(i * 37) & 255, (i * 91) & 255, (i * 13) & 255, i % 5 === 0 ? 128 : 255], i * 4);
  }
  const image = { width: 70, height: 3, pixels };
  assert.deepEqual(decodeQoi(encodeQoi(image)).pixels, pixels);
});

test("encodePng round-trips RGBA", () => {
  const pixels = new Uint8Array(5 * 4 * 4).map((_, i) => (i * 29) & 255);
  const decoded = decodePng(encodePng({ width: 5, height: 4, pixels }));
  assert.equal(decoded.width, 5);
  assert.equal(decoded.height, 4);
  assert.deepEqual(decoded.pixels, pixels);
});

test("asciiThumbnailBlock and bgcodeThumbnailBlock match PrusaSlicer's blocks", () => {
  const thumbnail: EncodedThumbnail = { format: "qoi", width: 16, height: 16, data: qoiFromAscii };
  assert.equal(asciiThumbnailBlock(thumbnail), asciiBlock);
  const fromBinary = binaryBlock.subarray(14, binaryBlock.length - 4);
  assert.deepEqual(bgcodeThumbnailBlock({ format: "qoi", width: 16, height: 16, data: fromBinary }, true), binaryBlock);
});

test("parseThumbnailSpec reads both forms of the printer's thumbnails", () => {
  assert.deepEqual(parseThumbnailSpec("16x16/QOI, 313x173/QOI,380x285/PNG"), [
    { width: 16, height: 16, format: "QOI" },
    { width: 313, height: 173, format: "QOI" },
    { width: 380, height: 285, format: "PNG" },
  ]);
  assert.deepEqual(parseThumbnailSpec("16x16,220x124", "QOI"), [
    { width: 16, height: 16, format: "QOI" },
    { width: 220, height: 124, format: "QOI" },
  ]);
  assert.deepEqual(parseThumbnailSpec("160x120"), [{ width: 160, height: 120, format: "PNG" }]);
  assert.deepEqual(parseThumbnailSpec(""), []);
  assert.deepEqual(parseThumbnailSpec("300x300/JPG"), [{ width: 300, height: 300, format: "JPG" }]);
});

test("renderThumbnail draws the cube on a transparent background, three faces lit differently", async () => {
  const triangles = await readStlTriangles(join(fixtures, "cube.stl"));
  assert.equal(triangles.length, 12 * 9);
  const image = renderThumbnail(triangles, 64, 48, parseColour("#FF8000")!)!;
  const at = (x: number, y: number) => Array.from(image.pixels.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
  assert.equal(at(0, 0)[3], 0, "corner is transparent");
  assert.equal(at(32, 24)[3], 255, "centre is covered");
  // Seen from the front left and above: the top, the front (-Y) and the left (-X) faces.
  const shades = new Set([at(32, 10), at(22, 34), at(42, 34)].map((pixel) => pixel.join(",")));
  assert.equal(shades.size, 3, `three different shades: ${[...shades].join(" | ")}`);
  for (const pixel of [at(32, 10), at(22, 34), at(42, 34)]) assert.ok(pixel[0]! > pixel[2]!, "orange, not grey");
});

test("insertThumbnails puts blocks where PrusaSlicer does, ASCII and binary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prusaslicer-mcp-thumbs-"));
  try {
    const image = renderThumbnail(await readStlTriangles(join(fixtures, "cube.stl")), 32, 24, [255, 128, 0])!;
    const thumbnails: EncodedThumbnail[] = [
      { format: "qoi", width: 32, height: 24, data: encodeQoi(image) },
      { format: "png", width: 32, height: 24, data: encodePng(image) },
    ];

    const ascii = join(dir, "cube.gcode");
    await copyFile(join(fixtures, "cube5.gcode"), ascii);
    const before = await readFile(ascii, "latin1");
    await insertThumbnails(ascii, thumbnails, false);
    const after = await readFile(ascii, "latin1");
    const inserted = thumbnails.map((thumbnail) => asciiThumbnailBlock(thumbnail)).join("");
    const split = before.indexOf("\n", before.indexOf("\n") + 1) + 1;
    assert.equal(after, before.slice(0, split) + inserted + before.slice(split));
    const analysis = await analyzeAsciiGcode(ascii);
    assert.deepEqual(analysis.thumbnails.map((t) => `${t.format} ${t.width}x${t.height}`), ["qoi 32x24", "png 32x24"]);
    await assert.rejects(insertThumbnails(ascii, thumbnails, false), /already holds thumbnails/);

    const binary = join(dir, "cube.bgcode");
    await copyFile(join(fixtures, "cube5.bgcode"), binary);
    assert.equal(await checkBgcode(binary), null, "PrusaSlicer's own file passes the checksum check");
    const plain = await readBgcodeMetadata(binary);
    await insertThumbnails(binary, thumbnails, true);
    assert.equal(await checkBgcode(binary), null);
    const meta = await readBgcodeMetadata(binary);
    assert.deepEqual(meta.thumbnails.map((t) => `${t.format} ${t.width}x${t.height}`), ["qoi 32x24", "png 32x24"]);
    assert.deepEqual(meta.thumbnails[1]!.data, thumbnails[1]!.data);
    assert.equal(meta.gcodeBlocks, plain.gcodeBlocks);
    assert.deepEqual(meta.slicer, plain.slicer);
    await assert.rejects(insertThumbnails(binary, thumbnails, true), /already holds thumbnails/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
