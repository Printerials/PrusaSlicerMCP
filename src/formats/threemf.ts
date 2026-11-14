import { parseCommentedConfig, splitList, type FlatConfig } from "./ini.ts";
import { flattenConfiguration } from "../slicer/v3.ts";
import { ZipReader } from "./zip.ts";

/**
 * What a 3MF project holds besides geometry.
 *
 * PrusaSlicer 2.x: Metadata/Slic3r_PE.config ("; key = value", the project config),
 * Metadata/Slic3r_PE_model.config (objects, volumes and their per-object settings),
 * Metadata/Prusa_Slicer_layer_config_ranges.xml (settings per height range),
 * Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml (colour changes and pauses),
 * Metadata/thumbnail.png.
 * PrusaSlicer 3.0: Metadata/PrusaSlicer3_project.json ({objects, project, config_containers}).
 * Bambu Studio and OrcaSlicer: Metadata/project_settings.config (JSON), not PrusaSlicer presets.
 */

export type ProjectKind = "prusaslicer-2" | "prusaslicer-3" | "bambu-orca" | "plain-3mf";

export interface ObjectInfo {
  id: string;
  name: string | null;
  instances: number | null;
  /** Settings changed for this object, as key to serialized value. */
  overrides: Record<string, string>;
  volumes: Array<{ name: string | null; type: string | null; overrides: Record<string, string> }>;
  layer_ranges: Array<{ min_z: number; max_z: number; overrides: Record<string, string> }>;
}

export interface CustomGcode {
  print_z: number;
  type: string;
  extruder: number | null;
  color: string | null;
  gcode: string | null;
}

export interface ProjectRead {
  kind: ProjectKind;
  application: string | null;
  title: string | null;
  config: FlatConfig;
  presets: { printer: string | null; print: string | null; filament: string[] };
  objects: ObjectInfo[];
  custom_gcodes: CustomGcode[];
  variable_layer_height: boolean;
  thumbnail: Buffer | null;
  entries: string[];
}

/** Volume and object metadata that describe the mesh, not print settings. */
const NON_SETTING_KEYS = new Set([
  "name",
  "volume_type",
  "matrix",
  "source_file",
  "source_object_id",
  "source_volume_id",
  "source_offset_x",
  "source_offset_y",
  "source_offset_z",
  "source_in_inches",
  "source_in_meters",
  "modifier",
]);

/** CustomGCode::Type, in enum order (slic3r-domain CustomGCode.hpp; same order in 2.x). */
const CUSTOM_GCODE_TYPES = ["color_change", "pause", "tool_change", "template", "custom"];

export async function readProject(path: string): Promise<ProjectRead> {
  const zip = await ZipReader.open(path);
  try {
    const model = (await zip.readText("3D/3dmodel.model")) ?? "";
    const result: ProjectRead = {
      kind: "plain-3mf",
      application: modelMetadata(model, "Application"),
      title: modelMetadata(model, "Title"),
      config: new Map(),
      presets: { printer: null, print: null, filament: [] },
      objects: [],
      custom_gcodes: [],
      variable_layer_height: zip.find("Metadata/Slic3r_PE_layer_heights_profile.txt") !== undefined,
      thumbnail: await zip.read("Metadata/thumbnail.png"),
      entries: [...zip.entries.keys()],
    };

    const v3 = await zip.readText("Metadata/PrusaSlicer3_project.json");
    const v2 = await zip.readText("Metadata/Slic3r_PE.config");
    if (v3) {
      result.kind = "prusaslicer-3";
      readV3Project(v3, result);
    } else if (v2 !== null) {
      result.kind = "prusaslicer-2";
      result.config = parseCommentedConfig(v2);
    } else if (zip.find("Metadata/project_settings.config")) {
      result.kind = "bambu-orca";
    }

    if (result.kind !== "prusaslicer-3") {
      result.presets = {
        printer: result.config.get("printer_settings_id") || null,
        print: result.config.get("print_settings_id") || null,
        filament: result.config.has("filament_settings_id") ? splitList(result.config.get("filament_settings_id")!) : [],
      };
      const modelConfig = await zip.readText("Metadata/Slic3r_PE_model.config");
      if (modelConfig) result.objects = parseModelConfig(modelConfig);
      const ranges = await zip.readText("Metadata/Prusa_Slicer_layer_config_ranges.xml");
      if (ranges) attachLayerRanges(ranges, result.objects);
      const custom = await zip.readText("Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml");
      if (custom) result.custom_gcodes = parseCustomGcodes(custom);
    }
    return result;
  } finally {
    await zip.close();
  }
}

function readV3Project(text: string, result: ProjectRead): void {
  const data = JSON.parse(text) as {
    objects?: unknown;
    config_containers?: Array<{ preset?: Record<string, unknown>; configuration?: Record<string, unknown> }>;
  };
  const container = data.config_containers?.[0];
  if (container?.configuration) result.config = flattenConfiguration(container.configuration);
  const preset = container?.preset ?? {};
  const pick = (...keys: string[]) => {
    for (const key of keys) if (typeof preset[key] === "string") return preset[key] as string;
    return null;
  };
  result.presets = {
    printer: pick("printer", "printer_preset", "printer_name") ?? result.config.get("printer_settings_id") ?? null,
    print: pick("print", "print_preset", "print_name") ?? result.config.get("print_settings_id") ?? null,
    filament: result.config.has("filament_settings_id") ? splitList(result.config.get("filament_settings_id")!) : [],
  };
  if (Array.isArray(data.objects)) {
    result.objects = data.objects.map((raw, index) => {
      const object = (raw ?? {}) as { name?: string; instances?: unknown[] };
      return {
        id: String(index + 1),
        name: object.name ?? null,
        instances: Array.isArray(object.instances) ? object.instances.length : null,
        overrides: {},
        volumes: [],
        layer_ranges: [],
      };
    });
  }
}

// ─── A small XML tokenizer, enough for PrusaSlicer's flat metadata files ─────

interface Tag {
  name: string;
  attrs: Record<string, string>;
  closing: boolean;
  selfClosing: boolean;
  /** Text right after this tag, up to the next one. */
  text: string;
}

function* tags(xml: string): Generator<Tag> {
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>([^<]*)/g;
  for (const match of xml.matchAll(re)) {
    const attrs: Record<string, string> = {};
    for (const attr of match[3]!.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[attr[1]!] = decodeEntities(attr[2] ?? attr[3] ?? "");
    }
    yield { name: match[2]!, attrs, closing: match[1] === "/", selfClosing: match[4] === "/", text: decodeEntities(match[5] ?? "") };
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos);/gi, (_, entity: string) => {
    switch (entity.toLowerCase()) {
      case "quot":
        return '"';
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "apos":
        return "'";
      default:
        return String.fromCodePoint(entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
    }
  });
}

function modelMetadata(model: string, name: string): string | null {
  const head = model.slice(0, 8192);
  for (const tag of tags(head)) {
    if (tag.name === "metadata" && tag.attrs.name === name && !tag.closing) return tag.text.trim() || null;
    if (tag.name === "resources") break;
  }
  return null;
}

export function parseModelConfig(xml: string): ObjectInfo[] {
  const objects: ObjectInfo[] = [];
  let object: ObjectInfo | null = null;
  let volume: ObjectInfo["volumes"][number] | null = null;
  for (const tag of tags(xml)) {
    if (tag.name === "object") {
      if (tag.closing) {
        object = null;
        continue;
      }
      object = {
        id: tag.attrs.id ?? String(objects.length + 1),
        name: null,
        instances: tag.attrs.instances_count ? Number(tag.attrs.instances_count) : null,
        overrides: {},
        volumes: [],
        layer_ranges: [],
      };
      objects.push(object);
    } else if (tag.name === "volume" && object) {
      if (tag.closing) {
        volume = null;
        continue;
      }
      volume = { name: null, type: null, overrides: {} };
      object.volumes.push(volume);
      if (tag.selfClosing) volume = null;
    } else if (tag.name === "metadata" && object && !tag.closing) {
      const key = tag.attrs.key ?? "";
      const value = tag.attrs.value ?? "";
      if (tag.attrs.type === "volume" && volume) {
        if (key === "name") volume.name = value;
        else if (key === "volume_type") volume.type = value;
        else if (!NON_SETTING_KEYS.has(key)) volume.overrides[key] = value;
      } else if (tag.attrs.type === "object") {
        if (key === "name") object.name = value;
        else if (!NON_SETTING_KEYS.has(key)) object.overrides[key] = value;
      }
    }
  }
  return objects;
}

function attachLayerRanges(xml: string, objects: ObjectInfo[]): void {
  let object: ObjectInfo | undefined;
  let range: ObjectInfo["layer_ranges"][number] | null = null;
  for (const tag of tags(xml)) {
    if (tag.closing) {
      if (tag.name === "range") range = null;
      continue;
    }
    if (tag.name === "object") object = objects.find((candidate) => candidate.id === tag.attrs.id);
    else if (tag.name === "range" && object) {
      range = { min_z: Number(tag.attrs.min_z), max_z: Number(tag.attrs.max_z), overrides: {} };
      object.layer_ranges.push(range);
    } else if (tag.name === "option" && range && tag.attrs.opt_key) {
      range.overrides[tag.attrs.opt_key] = tag.text.trim();
    }
  }
}

function parseCustomGcodes(xml: string): CustomGcode[] {
  const codes: CustomGcode[] = [];
  for (const tag of tags(xml)) {
    if (tag.name !== "code" || tag.closing) continue;
    const type = Number(tag.attrs.type);
    codes.push({
      print_z: Number(tag.attrs.print_z),
      type: CUSTOM_GCODE_TYPES[type] ?? tag.attrs.type ?? "unknown",
      extruder: tag.attrs.extruder ? Number(tag.attrs.extruder) : null,
      color: tag.attrs.color || null,
      gcode: tag.attrs.gcode || tag.attrs.extra || null,
    });
  }
  return codes.sort((a, b) => a.print_z - b.print_z);
}
