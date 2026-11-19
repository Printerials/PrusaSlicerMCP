import { basename, dirname, join } from "node:path";
import type { Presets, SlicerContext } from "../context.ts";
import { writeProject } from "../formats/project-edit.ts";
import { ZipReader } from "../formats/zip.ts";
import { presetNames } from "../slicer/v3.ts";
import { patchSavedConfig, type Json, type PatchTarget } from "../slicer/v3-config.ts";
import { Refusal } from "../util/errors.ts";
import { commitFile, outputTarget, stem, withStaging } from "../util/paths.ts";
import { checkOverrides } from "./args.ts";
import { freeName } from "./slice.ts";

export const PROJECT_JSON = "Metadata/PrusaSlicer3_project.json";

/** The settings sections a preset fills; project_settings (colours, wiping volumes) belongs to the project. */
const PRESET_SECTIONS = ["print_settings", "printer_settings", "filament_settings", "toolprint_settings"];

type Section = Record<string, Json>;
interface Container {
  preset?: unknown;
  configuration?: Record<string, Section>;
  [key: string]: unknown;
}
interface ProjectJson {
  objects?: Array<{ id?: unknown; object_settings?: Section; volumes?: Array<{ volume_settings?: Section }>; ranges?: Array<{ configuration?: Section; zRange?: unknown }> }>;
  config_containers?: Container[];
  [key: string]: unknown;
}

export interface EditArgs {
  filament?: string;
  print?: string;
  settings?: Record<string, string | number | boolean>;
  output?: string;
  overwrite: boolean;
}

/**
 * edit_project for a PrusaSlicer 3.0 project. Only Metadata/PrusaSlicer3_project.json is rewritten;
 * geometry, painting (Slic3r_facets_annotation.json), thumbnails and the rest are copied as stored.
 *
 * Measured and read for 3.0.0-alpha14 (2026-11-19):
 * - The config lives in config_containers[] (one per bed), each with "preset" and "configuration"
 *   in the --save format, so the same patching applies as for a slice (v3-config.ts).
 * - Invalid values are not refused on load but replaced by the built-in default (source
 *   ConfigLoad.cpp), so the result is loaded by PrusaSlicer and every value read back.
 * - The GUI keeps no "modified" flag: presets whose values differ from the installed ones open as
 *   "(From 3mf) <name>" (source PresetInteractor.cpp).
 * - Per-object, per-volume and per-range settings win over the project's for that part.
 */
export async function editV3Project(slicer: SlicerContext, file: string, args: EditArgs): Promise<Record<string, unknown>> {
  const zip = await ZipReader.open(file);
  let text: string | null;
  try {
    text = await zip.readText(PROJECT_JSON);
  } finally {
    await zip.close();
  }
  if (!text) throw new Refusal("This 3MF holds no PrusaSlicer 3.0 project config (Metadata/PrusaSlicer3_project.json).");
  const project = JSON.parse(text) as ProjectJson;
  const containers = project.config_containers ?? [];
  if (containers.length === 0 || !containers.every((container) => container.configuration && container.preset)) {
    throw new Refusal("The project's config_containers are missing or incomplete, so it cannot be edited safely.");
  }

  const before = presetsOf(containers[0]!);
  const catalog = await slicer.catalog();
  const notes = new Set<string>();
  const replaced = new Set<string>();
  let after = before;

  // A preset switch takes the new presets' values, as the GUI does when another preset is picked
  // and the changes are discarded. The project's own changes to those presets are reported.
  if (args.filament || args.print) {
    if (args.filament && presetNames(containers[0]!.preset).filaments.length > 1) {
      throw new Refusal("Switching filaments in a multi-material project is not supported yet.");
    }
    if (!before.printer || !before.print || !before.filament) throw new Refusal("The project does not name its printer, print and filament presets.");
    const chosen = await slicer.completePresets({ printer: before.printer, print: args.print ?? before.print, filament: args.filament ?? before.filament });
    after = { printer: chosen.printer, print: chosen.print, filament: chosen.filament };
    const oldSaved = await savedJson(slicer, before as Presets).catch((error: unknown) => {
      throw new Refusal(
        `The project's own presets (${before.print} / ${before.filament}) are not available here, so the switch cannot be computed. ` +
          `(${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
      );
    });
    const newSaved = await savedJson(slicer, after as Presets);
    for (const container of containers) {
      for (const section of PRESET_SECTIONS) {
        for (const [key, value] of Object.entries(container.configuration![section] ?? {})) {
          const old = oldSaved.configuration?.[section]?.[key];
          if (old !== undefined && JSON.stringify(old) !== JSON.stringify(value)) replaced.add(key);
        }
        container.configuration![section] = structuredClone(newSaved.configuration?.[section] ?? {});
      }
      container.preset = structuredClone(newSaved.preset);
    }
  }

  // Settings on top, in every layer that holds them (a filament's override wins over the print setting).
  let targets = new Map<string, PatchTarget[]>();
  const changes = args.settings ? checkOverrides(args.settings, catalog) : new Map<string, string>();
  for (const key of changes.keys()) if (/_settings_id$|^inherits$/.test(key)) throw new Refusal(`${key} cannot be set here. Use filament or print to switch presets.`);
  for (const [index, container] of containers.entries()) {
    if (changes.size === 0) break;
    const patched = patchSavedConfig(JSON.stringify(container), changes, catalog);
    containers[index] = JSON.parse(patched.config) as Container;
    if (index === 0) targets = patched.targets;
    for (const note of patched.notes) notes.add(note);
  }
  project.config_containers = containers;

  // Parts of the model that set the same keys themselves keep their own value.
  const shadowed = shadowsInObjects(project, [...changes.keys()].map((key) => catalog.get(key)?.aliasOf ?? key));

  const target = args.output ? await outputTarget(args.output, dirname(file), "") : await freeName(dirname(file), `${stem(file)}-edited.3mf`);
  await slicer.assertOutsideDatadir(dirname(target));
  if (!target.toLowerCase().endsWith(".3mf")) throw new Refusal("The output name must end in .3mf.");
  if (target === file) throw new Refusal("Write the edited project to another file; the original stays as it is.");

  const loadedPresets = await withStaging(dirname(target), async (staging) => {
    const staged = join(staging, basename(target));
    await writeProject(file, staged, JSON.stringify(project), PROJECT_JSON);
    // PrusaSlicer loads the result: a value it does not take comes back as its default.
    const info = await slicer.info();
    const loaded = await slicer.savedConfigText([staged]);
    if (changes.size && info.backend.checkPatched) {
      const check = info.backend.checkPatched(loaded, targets);
      if (check.rejected.length || check.missing.length) {
        throw new Refusal("PrusaSlicer did not accept these values, so nothing was written.", {
          rejected: Object.fromEntries(
            check.rejected.map((entry) => [`${entry.key} (${entry.layer})`, { given: entry.expected, prusaslicer_used: entry.found, allowed: catalog.get(entry.key)?.values }]),
          ),
          missing: check.missing.length ? check.missing : undefined,
        });
      }
    }
    const names = presetNames((JSON.parse(loaded) as { preset?: unknown }).preset);
    if (args.filament || args.print) {
      const wrong = (["printer", "print", "filament"] as const).filter((kind) => (kind === "filament" ? names.filaments[0] : names[kind]) !== after[kind]);
      if (wrong.length) throw new Refusal(`PrusaSlicer loaded other presets than were written (${wrong.join(", ")}), so nothing was written.`);
    }
    await commitFile(staged, target, args.overwrite);
    return { printer: names.printer, print: names.print, filament: names.filaments[0] ?? null };
  });

  return {
    output: target,
    presets: { before, after: loadedPresets },
    changed: changes.size ? Object.fromEntries([...targets].map(([key, written]) => [key, written.map((entry) => `${entry.section}: ${JSON.stringify(entry.previous ?? null)} -> ${JSON.stringify(entry.value)}`)])) : undefined,
    also_set: notes.size ? [...notes] : undefined,
    replaced_project_modifications: replaced.size ? [...replaced].sort() : undefined,
    kept_by_objects: shadowed.length ? shadowed : undefined,
    beds: containers.length > 1 ? `Changed on all ${containers.length} beds; PrusaSlicer's check read back the first.` : undefined,
    note:
      "The original project is unchanged. PrusaSlicer 3.0 keeps no 'modified' flag: in the GUI, presets whose values now differ from the installed ones " +
      "show as \"(From 3mf) <preset name>\" holding these values.",
  };
}

function presetsOf(container: Container): { printer: string | null; print: string | null; filament: string | null } {
  const names = presetNames(container.preset);
  return { printer: names.printer, print: names.print, filament: names.filaments[0] ?? null };
}

async function savedJson(slicer: SlicerContext, presets: Presets): Promise<{ preset?: unknown; configuration?: Record<string, Section> }> {
  return JSON.parse(await slicer.savedConfigText(slicer.presetArgs(presets)));
}

/** "object 2 sets fill_density (20%)": object, volume (modifier) and height-range settings that win over the project's. */
function shadowsInObjects(project: ProjectJson, keys: string[]): string[] {
  const found: string[] = [];
  const look = (where: string, settings: Section | undefined) => {
    for (const key of keys) {
      const value = settings?.[key];
      if (value !== undefined && value !== null) found.push(`${where} sets ${key} (${JSON.stringify(value)}), which wins there`);
    }
  };
  for (const [n, object] of (project.objects ?? []).entries()) {
    look(`object ${n + 1}`, object.object_settings);
    for (const [m, volume] of (object.volumes ?? []).entries()) look(`object ${n + 1}, part ${m + 1}`, volume.volume_settings);
    for (const range of object.ranges ?? []) look(`object ${n + 1}, height range ${JSON.stringify(range.zRange ?? "?")}`, range.configuration);
  }
  return found;
}
