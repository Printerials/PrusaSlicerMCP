import assert from "node:assert/strict";
import { test } from "node:test";
import { statedFromPrinterials, variantFromExternalId, type PrinterialsSlicer } from "../../src/printerials/client.ts";
import { FILAMENT_KEYS, planFilamentPreset, renderPreset, validPresetName } from "../../src/slicer/filament-preset.ts";
import { bundleFilamentValue, type Bundle } from "../../src/slicer/installed.ts";
import { prusaTypeOf, spoolPricePerKg, type SpoolmanSpool } from "../../src/spoolman/client.ts";
import { statedFromSpool } from "../../src/tools/filament.ts";

const PARENT = new Map([
  ["temperature", "250"],
  ["first_layer_temperature", "240"],
  ["bed_temperature", "85"],
  ["first_layer_bed_temperature", "85"],
  ["filament_type", "PETG"],
  ["filament_max_volumetric_speed", "21"],
  ["filament_density", "1.27"],
  ["filament_vendor", "Generic"],
  ["layer_height", "0.2"],
  ["compatible_printers_condition_cummulative", '"print";"filament"'],
]);
const COMPAT = { printersCondition: "printer_model=~/COREONE/", printsCondition: "", printers: "", prints: "" };

test("FILAMENT_KEYS is PrusaSlicer 2.9.2's filament option list", () => {
  assert.equal(FILAMENT_KEYS.length, 81);
  assert.equal(new Set(FILAMENT_KEYS).size, 81);
});

test("temperatures stay tuned inside a stated range and are clamped outside it", () => {
  const plan = planFilamentPreset(PARENT, "Generic PETG @COREONE HF0.4", COMPAT, {
    nozzle: { min: 220, max: 240 },
    bed: { min: 70, max: 90 },
  });
  // 250 is above 240: the bound. The first layer keeps the parent's -10 step.
  assert.equal(plan.values.get("temperature"), "240");
  assert.equal(plan.values.get("first_layer_temperature"), "230");
  // 85 lies in 70-90: kept.
  assert.equal(plan.values.get("bed_temperature"), "85");
  assert.equal(plan.values.get("first_layer_bed_temperature"), "85");
  assert.match(plan.decisions.find((d) => d.key === "temperature")!.reason, /above the stated 220–240/);
});

test("a single stated value wins; the rest comes from the parent, not from defaults", () => {
  const plan = planFilamentPreset(PARENT, "Generic PETG @COREONE HF0.4", COMPAT, {
    nozzle: { value: 235 },
    density: 1.25,
    costPerKg: 24.995,
    colour: "70fa00",
    vendor: "Buddy3d",
    notes: 'Printerials: https://printerials.com/x\nnozzle "230–250"',
  });
  assert.equal(plan.values.get("temperature"), "235");
  assert.equal(plan.values.get("first_layer_temperature"), "225");
  assert.equal(plan.values.get("filament_type"), "PETG");
  assert.equal(plan.values.get("filament_max_volumetric_speed"), "21");
  assert.equal(plan.values.get("filament_density"), "1.25");
  assert.equal(plan.values.get("filament_cost"), "25");
  assert.equal(plan.values.get("filament_colour"), "#70FA00");
  assert.equal(plan.values.get("filament_vendor"), "Buddy3d");
  assert.equal(plan.values.get("filament_notes"), '"Printerials: https://printerials.com/x\\nnozzle \\"230–250\\""');
  assert.equal(plan.values.get("inherits"), "Generic PETG @COREONE HF0.4");
  assert.equal(plan.values.get("compatible_printers_condition"), "printer_model=~/COREONE/");
  assert.ok(!plan.values.has("layer_height"), "a print setting is not a filament setting");
});

test("a value stated next to a range: the parent's tuned value stays inside it; sources are named", () => {
  const data: PrinterialsSlicer = {
    variantId: 18925,
    materialId: 2531,
    material: { slug: "prusament-pla", name: "Prusament PLA", brand: "Prusament", type: { slug: "pla", name: "PLA" }, url: "https://printerials.com/materials/prusament-pla" },
    colour: { slug: "galaxy-black", name: "Galaxy Black", hex: "#3D3E3C", measured: true, url: "https://printerials.com/materials/prusament-pla?colour=galaxy-black" },
    diameters: [1.75],
    base: { prusaType: "PLA" },
    // As the live route answered on 2026-11-16 (d17b98f9).
    stated: {
      nozzleTempC: { value: 215, min: 205, max: 225, source: "open-filament-database", method: null, valueFrom: { source: "prusa-material-table" } },
      bedTempC: { value: 60, min: 40, max: 60, source: "open-filament-database", method: null, valueFrom: null },
      densityGcm3: { value: 1.24, min: null, max: null, source: "open-filament-database", valueFrom: null },
    },
  };
  const stated = statedFromPrinterials(data, undefined, false);
  assert.deepEqual(stated.nozzle, { value: 215, min: 205, max: 225, source: "open-filament-database", valueSource: "prusa-material-table" });
  assert.match(stated.notes!, /nozzle 205–225 °C \(open-filament-database\), typical 215 °C \(prusa-material-table\)/);

  const parent = new Map([...PARENT, ["temperature", "220"], ["first_layer_temperature", "220"], ["bed_temperature", "65"], ["first_layer_bed_temperature", "65"]]);
  const plan = planFilamentPreset(parent, "Generic PLA @COREONE HF0.4", COMPAT, stated);
  assert.equal(plan.values.get("temperature"), "220");
  assert.equal(plan.values.get("bed_temperature"), "60");
  assert.match(plan.decisions.find((d) => d.key === "temperature")!.reason, /parent's 220 lies in the stated 205–225 \(open-filament-database\)/);
  assert.match(plan.decisions.find((d) => d.key === "filament_density")!.reason, /as stated/);
});

test("per-extruder vectors keep their length", () => {
  const plan = planFilamentPreset(new Map([...PARENT, ["temperature", "250,250"]]), "P", COMPAT, { nozzle: { value: 230 } });
  assert.equal(plan.values.get("temperature"), "230,230");
});

test("rendered as PrusaSlicer writes a preset; names that are valid files", () => {
  assert.equal(renderPreset(new Map([["b", "2"], ["a", "1"]]), "made here"), "# made here\na = 1\nb = 2\n");
  assert.ok(validPresetName("Buddy3d PETG Black @COREONE HF0.4"));
  assert.ok(!validPresetName("a/b"));
  assert.ok(!validPresetName(" padded"));
});

test("bundle values follow the inherits chain, later parents first", () => {
  const sections = new Map<string, Map<string, string>>([
    ["*common*", new Map([["compatible_prints_condition", "common"]])],
    ["*PET*", new Map([["inherits", "*common*"], ["compatible_printers_condition", "pet"]])],
    ["*HF*", new Map([["compatible_printers_condition", "hf"]])],
    ["Generic PETG @HF", new Map([["inherits", "*PET*; *HF*"]])],
  ]);
  const bundle: Bundle = { vendorId: "X", name: "X", filaments: new Set(), filamentSections: sections, slaMaterials: new Set(), models: new Map() };
  assert.equal(bundleFilamentValue(bundle, "Generic PETG @HF", "compatible_printers_condition"), "hf");
  assert.equal(bundleFilamentValue(bundle, "Generic PETG @HF", "compatible_prints_condition"), "common");
  assert.equal(bundleFilamentValue(bundle, "Generic PETG @HF", "nothing"), undefined);
});

test("a Spoolman spool in stated form", () => {
  const spool: SpoolmanSpool = {
    id: 3,
    remaining_weight: 412,
    initial_weight: 1000,
    price: 22.5,
    spool_weight: 180,
    filament: { id: 9, name: "PETG Black", vendor: { id: 1, name: "Buddy3d" }, material: "PETG", density: 1.27, diameter: 1.75, weight: 1000, settings_extruder_temp: 235, color_hex: "000000", external_id: "printerials:variant/7767" },
  };
  const stated = statedFromSpool(spool);
  assert.equal(stated.type, "PETG");
  assert.deepEqual(stated.nozzle, { value: 235, source: "spool" });
  assert.equal(stated.costPerKg, 22.5);
  assert.equal(stated.colour, "#000000");
  assert.equal(stated.spoolWeight, 180);
  assert.equal(prusaTypeOf("TPU"), "FLEX");
  assert.equal(prusaTypeOf("PA-CF"), "PA");
  assert.equal(spoolPricePerKg({ ...spool, price: undefined, filament: { ...spool.filament, price: 30, weight: 750 }, initial_weight: undefined }), 40);
  assert.equal(variantFromExternalId(spool.filament.external_id), 7767);
  assert.equal(variantFromExternalId("spoolmandb:abc"), null);
});

test("Printerials slicer data in stated form; a price only with a country", () => {
  const data: PrinterialsSlicer = {
    variantId: 7767,
    materialId: 1132,
    material: { slug: "buddy3d-petg", name: "Buddy3d PETG", brand: "Buddy3d", type: { slug: "petg", name: "PETG" }, url: "https://printerials.com/materials/buddy3d-petg" },
    colour: { slug: "black", name: "Black", hex: "#000000", measured: false, url: "https://printerials.com/materials/buddy3d-petg/black" },
    diameters: [1.75, 2.85],
    base: { prusaType: "PETG" },
    stated: {
      nozzleTempC: { value: null, min: 230, max: 250, source: "Buddy3d", method: null },
      bedTempC: { value: 80, min: 80, max: 80, source: "Buddy3d" },
      densityGcm3: { value: 1.27, source: "Buddy3d" },
    },
    price: { country: "NL", currency: "EUR", headline: null, perKg: 19.99 },
  };
  const withPrice = statedFromPrinterials(data, undefined, true);
  assert.deepEqual(withPrice.nozzle, { min: 230, max: 250, source: "Buddy3d" });
  assert.equal(withPrice.bed?.value, 80);
  assert.equal(withPrice.diameter, 1.75);
  assert.equal(withPrice.costPerKg, 19.99);
  assert.match(withPrice.notes!, /^Printerials: https:\/\/printerials\.com\/materials\/buddy3d-petg\/black\nnozzle 230–250 °C/);
  assert.equal(statedFromPrinterials(data, 2.85, false).costPerKg, undefined);
  assert.equal(statedFromPrinterials(data, 2.85, false).diameter, 2.85);
});
