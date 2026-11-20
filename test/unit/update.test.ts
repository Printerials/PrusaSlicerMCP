import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, newestFor, parseBundleIndex } from "../../src/slicer/bundle-index.ts";
import { parseUpdaterJson } from "../../src/tools/update.ts";

// The head of PrusaResearch.idx as 3.0.0-alpha14 keeps it (2026-11-20).
const V3_INDEX = `min_slic3r_version = 3.0.0-alpha14
1.0.25 General fixes and improvements.
1.0.24 Added 0.25/0.6/0.8 nozzles for INDX. Added 0.30mm preset for INDX 0.4.
1.0.22 Introduced deprecated IDs
max_slic3r_version = 3.0.0-alpha13
min_slic3r_version = 3.0.0-alpha13
1.0.21 Updated profiles for alpha13.
min_slic3r_version = 3.0.0-alpha0
1.0.20 Updated layer_gcode script (INDX).
`;

test("compareVersions orders releases and pre-releases", () => {
  assert.equal(compareVersions("2.9.7", "2.9.6"), 1);
  assert.equal(compareVersions("2.5.16", "2.5.16"), 0);
  assert.equal(compareVersions("2.10.0", "2.9.9"), 1);
  assert.equal(compareVersions("3.0.0-alpha14", "3.0.0"), -1);
  assert.equal(compareVersions("3.0.0-alpha14", "3.0.0-alpha2"), 1);
  assert.equal(compareVersions("3.0.0-beta1", "3.0.0-alpha14"), 1);
  assert.equal(compareVersions("2.9.7+flathub.org", "2.9.7"), 0);
  assert.equal(compareVersions("2.9.7+flathub.org", "2.9.8"), -1);
});

test("parseBundleIndex keeps each min/max bound until the next of its kind", () => {
  const entries = parseBundleIndex(V3_INDEX);
  assert.deepEqual(
    entries.map((entry) => [entry.version, entry.minSlicer, entry.maxSlicer]),
    [
      ["1.0.25", "3.0.0-alpha14", null],
      ["1.0.24", "3.0.0-alpha14", null],
      ["1.0.22", "3.0.0-alpha14", null],
      ["1.0.21", "3.0.0-alpha13", "3.0.0-alpha13"],
      ["1.0.20", "3.0.0-alpha0", "3.0.0-alpha13"],
    ],
  );
  assert.equal(entries[0]!.comment, "General fixes and improvements.");
});

test("newestFor picks the newest bundle the running PrusaSlicer may use", () => {
  const entries = parseBundleIndex(V3_INDEX);
  assert.equal(newestFor(entries, "3.0.0-alpha14")?.version, "1.0.25");
  assert.equal(newestFor(entries, "3.0.0-alpha13")?.version, "1.0.21");
  assert.equal(newestFor(entries, "3.0.0-alpha5")?.version, "1.0.20");
  assert.equal(newestFor(parseBundleIndex("min_slic3r_version = 2.9.6\n2.5.16 Updated FW version notification.\n"), "2.9.7")?.version, "2.5.16");
  assert.equal(newestFor(parseBundleIndex("min_slic3r_version = 2.9.8\n2.5.17 Later.\n"), "2.9.7"), null);
});

test("parseUpdaterJson reads the object after PrusaSlicer's log lines", () => {
  const out = `[2026-11-20 01:32:08.756] [error] [PhysicalPrinterStorage.cpp:42] Failed to load Physical Printer Configurations\n{\n    "result": {\n        "regular_updates": []\n    }\n}\n`;
  assert.deepEqual(parseUpdaterJson(out), { result: { regular_updates: [] } });
  assert.deepEqual(parseUpdaterJson('{"error":"no network"}\n'), { error: "no network" });
  assert.equal(parseUpdaterJson(""), null);
  assert.equal(parseUpdaterJson("{ not json"), null);
});
