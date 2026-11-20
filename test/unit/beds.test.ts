import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bedOrigins2x,
  customGcodesForEveryBed,
  findBeds,
  gridCoords,
  moveItems,
  needsBedCopy,
  occupiedBeds,
  parseBedShape,
  swapBedData,
  wipeTowerForEveryBed,
} from "../../src/formats/beds.ts";
import { within } from "../../src/tools/thumbnails.ts";

/** A 3MF model: one 20 mm cube (vertices 0..20) and an item per position. */
function model(positions: Array<[number, number]>, objectIds = positions.map(() => "1")): string {
  const vertices = [0, 20].flatMap((x) => [0, 20].flatMap((y) => [0, 20].map((z) => `<vertex x="${x}" y="${y}" z="${z}"/>`))).join("");
  const objects = [...new Set(objectIds)].map((id) => `<object id="${id}" type="model"><mesh><vertices>${vertices}</vertices><triangles/></mesh></object>`).join("");
  const items = positions.map(([x, y], index) => `<item objectid="${objectIds[index]}" transform="1 0 0 0 1 0 0 0 1 ${x} ${y} 0" printable="1"/>`).join("\n");
  return `<?xml version="1.0"?><model><resources>${objects}</resources><build>\n${items}\n</build></model>`;
}

const CORE_ONE = "0x0,250x0,250x220,0x220";

test("2.9's bed grid: index to grid, and the gap for a CORE One (source 2.9.7 MultipleBeds.cpp)", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(gridCoords), [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [2, 1], [0, 2], [1, 2], [2, 2]]);
  const origins = bedOrigins2x(parseBedShape(CORE_ONE)!);
  const gap = Math.hypot(250, 220) * 0.3; // 99.9, under the 100 mm cap
  assert.equal(origins.length, 9);
  assert.deepEqual(origins[1], [250 + gap, 0]);
  assert.deepEqual(origins[2], [0, 220 + gap]);
  // A large bed hits the cap.
  assert.deepEqual(bedOrigins2x(parseBedShape("0x0,360x0,360x360,0x360")!)[1], [460, 0]);
});

test("parseBedShape takes 2.x's text and 3.0's points", () => {
  assert.deepEqual(parseBedShape(CORE_ONE), { minX: 0, maxX: 250, minY: 0, maxY: 220 });
  assert.deepEqual(parseBedShape([[0, -4], [180, -4], [180, 180], [0, 180]]), { minX: 0, maxX: 180, minY: -4, maxY: 180 });
  assert.equal(parseBedShape(undefined), null);
  assert.equal(parseBedShape("nonsense"), null);
});

test("findBeds, 2.x: each cube on the bed it lies wholly inside; one across a gap is on none", () => {
  const origins = bedOrigins2x(parseBedShape(CORE_ONE)!);
  const xml = model([[10, 10], [origins[1]![0] + 10, 10], [origins[2]![0] + 10, origins[2]![1] + 10], [240, 10]], ["1", "2", "3", "4"]);
  const info = findBeds({ kind: "prusaslicer-2", modelXml: xml, bedShape: CORE_ONE, beds3: null, containers: 1, names: new Map([["1", "a"], ["2", "b"], ["3", "c"]]) })!;
  assert.deepEqual(info.beds.map((bed) => bed.items.map((item) => item.name)), [["a"], ["b"], ["c"]]);
  assert.deepEqual(info.outside.map((item) => item.name), ["object 4"]);
  assert.equal(occupiedBeds(info).length, 3);
  assert.equal(needsBedCopy(info, 1), true, "2.9.7's CLI takes bed 2's colour changes when several beds are in use");
});

test("findBeds, 3.0: the beds the project lists; instances of one object are told apart", () => {
  const xml = model([[55, 40], [325, 40]]);
  const info = findBeds({
    kind: "prusaslicer-3",
    modelXml: xml,
    bedShape: [[0, 0], [250, 0], [250, 220], [0, 220]],
    beds3: [{ position_x: 0, position_y: 0 }, { position_x: 270, position_y: 0 }, { position_x: 540, position_y: 0 }],
    containers: 1,
    names: new Map([["1", "cube"]]),
  })!;
  assert.deepEqual(info.beds.map((bed) => bed.items.map((item) => item.name)), [["cube (instance 1)"], ["cube (instance 2)"], []]);
  assert.equal(needsBedCopy(info, 1), false);
  assert.equal(needsBedCopy(info, 2), true);
  // One bed in use: 2.9 copies nothing either.
  const single = findBeds({ kind: "prusaslicer-2", modelXml: model([[10, 10]]), bedShape: CORE_ONE, beds3: null, containers: 1, names: new Map() })!;
  assert.equal(single.beds.length, 1);
  assert.equal(needsBedCopy(single, 1), false);
});

test("a rotated item's footprint is that of its turned mesh", () => {
  // 90° about Z: x' = -y, y' = x, then moved to (100, 10). The cube spans x 80..100, y 10..30.
  const xml = model([[0, 0]]).replace(/transform="[^"]*"/, 'transform="0 1 0 -1 0 0 0 0 1 100 10 0"');
  const info = findBeds({ kind: "prusaslicer-2", modelXml: xml, bedShape: CORE_ONE, beds3: null, containers: 1, names: new Map() })!;
  assert.deepEqual(info.beds[0]!.items[0]!.footprint, { minX: 80, maxX: 100, minY: 10, maxY: 30 });
});

test("moveItems moves the chosen build items in X and Y and leaves the rest as written", () => {
  const xml = model([[55, 40], [325, 40], [600, 40]]);
  const moved = moveItems(xml, new Map([[0, [270, 0]], [1, [-270, 0]]]));
  const transforms = [...moved.matchAll(/transform="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(transforms, ["1 0 0 0 1 0 0 0 1 325 40 0", "1 0 0 0 1 0 0 0 1 55 40 0", "1 0 0 0 1 0 0 0 1 600 40 0"]);
  // An item without a transform gets one.
  assert.match(moveItems('<model><build><item objectid="1"/></build></model>', new Map([[0, [5, 6]]])), /transform="1 0 0 0 1 0 0 0 1 5 6 0"/);
});

test("2.9's per-bed colour changes and wipe towers: the chosen bed's on every bed", () => {
  const custom =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<custom_gcodes_per_print_z bed_idx="0"><code print_z="10" type="1"/><mode value="SingleExtruder"/></custom_gcodes_per_print_z>\n' +
    '<custom_gcodes_per_print_z bed_idx="1"><code print_z="20" type="1"/><mode value="SingleExtruder"/></custom_gcodes_per_print_z>\n';
  const forBed2 = customGcodesForEveryBed(custom, 1, 3);
  assert.equal(forBed2.match(/print_z="20"/g)?.length, 3);
  assert.doesNotMatch(forBed2, /print_z="10"/);
  assert.deepEqual([...forBed2.matchAll(/bed_idx="(\d)"/g)].map((match) => match[1]), ["0", "1", "2"]);
  // A bed without any: every bed gets none, with the mode kept.
  const forBed3 = customGcodesForEveryBed(custom, 2, 3);
  assert.doesNotMatch(forBed3, /<code/);
  assert.equal(forBed3.match(/<mode value="SingleExtruder"\/>/g)?.length, 3);

  const towers =
    '<?xml version="1.0" encoding="utf-8"?>\n<wipe_tower_information bed_idx="0" position_x="180" position_y="140" rotation_deg="0"/>\n' +
    '<wipe_tower_information bed_idx="1" position_x="20" position_y="30" rotation_deg="90"/>\n';
  const moved = wipeTowerForEveryBed(towers, 1, 2);
  assert.deepEqual([...moved.matchAll(/bed_idx="(\d)" position_x="(\d+)"/g)].map((match) => [match[1], match[2]]), [["0", "20"], ["1", "20"]]);
});

test("3.0: two beds change everything but their position", () => {
  const text = JSON.stringify({
    config_containers: [
      {
        beds: [
          { position_x: 0, position_y: 0, custom_gcode: { gcodes: [{ gcode: { print_z: 10 } }] }, wipe_tower: null },
          { position_x: 270, position_y: 0, custom_gcode: { gcodes: [{ gcode: { print_z: 20 } }] }, wipe_tower: { x: 5, y: 6 } },
        ],
      },
    ],
  });
  const beds = JSON.parse(swapBedData(text, 0, 1)).config_containers[0].beds;
  assert.deepEqual([beds[0].position_x, beds[0].custom_gcode.gcodes[0].gcode.print_z, beds[0].wipe_tower], [0, 20, { x: 5, y: 6 }]);
  assert.deepEqual([beds[1].position_x, beds[1].custom_gcode.gcodes[0].gcode.print_z, beds[1].wipe_tower], [270, 10, null]);
});

test("within keeps the triangles that lie on the bed", () => {
  const triangles = Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0, 300, 0, 0, 310, 0, 0, 300, 10, 0]);
  assert.deepEqual([...within(triangles, { minX: 0, maxX: 250, minY: 0, maxY: 220 })], [0, 0, 0, 10, 0, 0, 0, 10, 0]);
});
