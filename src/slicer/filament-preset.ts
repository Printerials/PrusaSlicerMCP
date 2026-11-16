import { splitList, type FlatConfig } from "../formats/ini.ts";

/**
 * Building a PrusaSlicer 2.x user filament preset from stated material data.
 *
 * A user preset file (datadir/filament/<name>.ini) inherits nothing: PresetCollection::load_presets
 * lays it over default_preset().config, not over its `inherits` (PrusaSlicer 2.9.2 source; with
 * 2.9.7 a file holding only a temperature sliced with bed 0 °C and type PLA). So the preset is
 * the complete filament config of a parent PrusaSlicer resolved for the user's printer, with the
 * stated values laid over it, and `inherits` naming the parent so the GUI shows where it came from.
 */

/** Preset::filament_options() in PrusaSlicer 2.9.2 (src/libslic3r/Preset.cpp), in its order. */
export const FILAMENT_KEYS = [
  "filament_colour", "filament_diameter", "filament_type", "filament_soluble", "filament_abrasive", "filament_notes",
  "filament_max_volumetric_speed", "filament_infill_max_speed", "filament_infill_max_crossing_speed", "extrusion_multiplier",
  "filament_density", "filament_cost", "filament_spool_weight", "filament_loading_speed", "filament_loading_speed_start",
  "filament_load_time", "filament_unloading_speed", "filament_unloading_speed_start", "filament_unload_time",
  "filament_toolchange_delay", "filament_cooling_moves", "filament_stamping_loading_speed", "filament_stamping_distance",
  "filament_cooling_initial_speed", "filament_purge_multiplier", "filament_cooling_final_speed", "filament_ramming_parameters",
  "filament_minimal_purge_on_wipe_tower", "filament_multitool_ramming", "filament_multitool_ramming_volume",
  "filament_multitool_ramming_flow", "temperature", "idle_temperature", "first_layer_temperature", "bed_temperature",
  "first_layer_bed_temperature", "fan_always_on", "cooling", "min_fan_speed", "max_fan_speed", "bridge_fan_speed",
  "disable_fan_first_layers", "full_fan_speed_layer", "fan_below_layer_time", "slowdown_below_layer_time", "min_print_speed",
  "start_filament_gcode", "end_filament_gcode", "enable_dynamic_fan_speeds", "chamber_temperature", "chamber_minimal_temperature",
  "overhang_fan_speed_0", "overhang_fan_speed_1", "overhang_fan_speed_2", "overhang_fan_speed_3", "filament_retract_length",
  "filament_retract_lift", "filament_retract_lift_above", "filament_retract_lift_below", "filament_retract_speed",
  "filament_deretract_speed", "filament_retract_restart_extra", "filament_retract_before_travel", "filament_retract_layer_change",
  "filament_wipe", "filament_retract_before_wipe", "filament_retract_length_toolchange", "filament_retract_restart_extra_toolchange",
  "filament_travel_ramping_lift", "filament_travel_slope", "filament_travel_max_lift", "filament_travel_lift_before_obstacle",
  "filament_vendor", "compatible_prints", "compatible_prints_condition", "compatible_printers", "compatible_printers_condition",
  "inherits", "filament_shrinkage_compensation_xy", "filament_shrinkage_compensation_z", "filament_seam_gap_distance",
] as const;

/** A figure as a source states it: one value, a range, or both. */
export interface StatedFigure {
  value?: number;
  min?: number;
  max?: number;
  /** Who states the range, or the value when there is no range. */
  source?: string;
  /** Who states the value, when that is another source than the range's. */
  valueSource?: string;
}

/** What a source says about a filament, independent of the source (a Spoolman spool, Printerials, the user). */
export interface StatedFilament {
  vendor?: string;
  /** PrusaSlicer's filament_type: PLA, PETG, ABS, ASA, FLEX, PC, PA, HIPS, PP... */
  type?: string;
  colour?: string;
  diameter?: number;
  density?: number;
  nozzle?: StatedFigure;
  firstLayerNozzle?: StatedFigure;
  bed?: StatedFigure;
  firstLayerBed?: StatedFigure;
  chamber?: StatedFigure;
  maxVolumetricSpeed?: number;
  costPerKg?: number;
  spoolWeight?: number;
  notes?: string;
}

export interface Compatibility {
  printersCondition: string;
  printsCondition: string;
  printers: string;
  prints: string;
}

export interface PresetPlan {
  values: Map<string, string>;
  /** Key -> what was set and why, for the answer to the model. */
  decisions: Array<{ key: string; value: string; reason: string }>;
}

const first = (value: string | undefined): number | null => {
  if (value === undefined || value === "") return null;
  const n = Number(splitList(value)[0]);
  return Number.isFinite(n) ? n : null;
};

/** Per-extruder vectors keep their length: "250,250" for two extruders gets the value twice. */
function likeParent(parent: string | undefined, value: string | number): string {
  const count = parent ? Math.max(1, splitList(parent).length) : 1;
  return Array.from({ length: count }, () => String(value)).join(",");
}

function quoted(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
}

const by = (source: string | undefined) => (source ? ` (${source})` : "");

/**
 * A temperature inside what the source states. The parent's value is tuned for the printer and
 * nozzle, so it stays when it lies in the stated range; otherwise the nearest bound. A value stated
 * next to a range is a general recommendation (a material table), used only without a parent value.
 * A value stated alone wins.
 */
function settle(parent: number | null, stated: StatedFigure): { value: number; reason: string } | null {
  const { min, max } = stated;
  const valueBy = by(stated.valueSource ?? stated.source);
  if (min === undefined && max === undefined) {
    return stated.value !== undefined ? { value: Math.round(stated.value), reason: `as stated${valueBy}` } : null;
  }
  const range = `${min ?? "…"}–${max ?? "…"}${by(stated.source)}`;
  if (parent === null) {
    if (stated.value !== undefined) return { value: Math.round(stated.value), reason: `stated ${stated.value}${valueBy}, no parent value; range ${range}` };
    const middle = min !== undefined && max !== undefined ? (min + max) / 2 : (min ?? max)!;
    return { value: Math.round(middle), reason: `middle of the stated ${range}` };
  }
  if (min !== undefined && parent < min) return { value: min, reason: `parent's ${parent} is below the stated ${range}` };
  if (max !== undefined && parent > max) return { value: max, reason: `parent's ${parent} is above the stated ${range}` };
  return { value: parent, reason: `parent's ${parent} lies in the stated ${range}` };
}

export function planFilamentPreset(parent: FlatConfig, parentName: string, compat: Compatibility, stated: StatedFilament): PresetPlan {
  const values = new Map<string, string>();
  for (const key of FILAMENT_KEYS) {
    const value = parent.get(key);
    if (value !== undefined) values.set(key, value);
  }
  values.set("inherits", parentName);
  values.set("compatible_printers_condition", compat.printersCondition);
  values.set("compatible_prints_condition", compat.printsCondition);
  values.set("compatible_printers", compat.printers);
  values.set("compatible_prints", compat.prints);

  const decisions: PresetPlan["decisions"] = [];
  const set = (key: string, value: string | number, reason: string, vector = true) => {
    const text = vector ? likeParent(parent.get(key), value) : String(value);
    values.set(key, text);
    decisions.push({ key, value: text, reason });
  };

  const temperature = (key: string, firstKey: string, main?: StatedFigure, firstLayer?: StatedFigure) => {
    const parentMain = first(parent.get(key));
    const parentFirst = first(parent.get(firstKey));
    const settled = main ? settle(parentMain, main) : null;
    if (settled) set(key, settled.value, settled.reason);
    const firstSettled = firstLayer ? settle(parentFirst, firstLayer) : null;
    if (firstSettled) {
      set(firstKey, firstSettled.value, `first layer: ${firstSettled.reason}`);
    } else if (settled && parentMain !== null && parentFirst !== null && main) {
      // No first-layer figure: keep the parent's step between first layer and the rest, inside the range.
      const step = parentFirst - parentMain;
      let value = settled.value + step;
      if (main.min !== undefined) value = Math.max(value, main.min);
      if (main.max !== undefined) value = Math.min(value, main.max);
      const held = value !== settled.value + step ? `, held at the stated ${value < settled.value + step ? "maximum" : "minimum"} ${value}` : "";
      set(firstKey, value, `parent's first-layer step (${step >= 0 ? "+" : ""}${step}) on ${settled.value}${held}`);
    }
  };

  temperature("temperature", "first_layer_temperature", stated.nozzle, stated.firstLayerNozzle);
  temperature("bed_temperature", "first_layer_bed_temperature", stated.bed, stated.firstLayerBed);
  if (stated.chamber) {
    const settled = settle(first(parent.get("chamber_temperature")), stated.chamber);
    if (settled) set("chamber_temperature", settled.value, `chamber: ${settled.reason}`);
  }
  if (stated.density !== undefined) set("filament_density", stated.density, "as stated");
  if (stated.diameter !== undefined) set("filament_diameter", stated.diameter, "as stated");
  if (stated.maxVolumetricSpeed !== undefined) set("filament_max_volumetric_speed", stated.maxVolumetricSpeed, "as stated");
  if (stated.costPerKg !== undefined) set("filament_cost", Math.round(stated.costPerKg * 100) / 100, "price per kg");
  if (stated.spoolWeight !== undefined) set("filament_spool_weight", Math.round(stated.spoolWeight), "empty spool weight");
  if (stated.colour) set("filament_colour", stated.colour.startsWith("#") ? stated.colour.toUpperCase() : `#${stated.colour.toUpperCase()}`, "as stated");
  if (stated.vendor) set("filament_vendor", stated.vendor, "as stated", false);
  if (stated.notes) set("filament_notes", quoted(stated.notes), "provenance", false);
  return { values, decisions };
}

/** The preset file as PrusaSlicer writes one: a comment line, then "key = value" sorted by key. */
export function renderPreset(values: Map<string, string>, comment: string): string {
  const lines = [...values.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, value]) => `${key} = ${value}`);
  return `# ${comment}\n${lines.join("\n")}\n`;
}

/** A preset name that is also a valid file name on every platform. */
export function validPresetName(name: string): boolean {
  return name.trim() === name && name.length > 0 && name.length <= 200 && !/[\\/:*?"<>|\u0000-\u001f]/.test(name) && !name.endsWith(".");
}
