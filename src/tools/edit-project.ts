import type { McpServer } from "@modelcontextprotocol/server";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Presets } from "../context.ts";
import { parseIniConfig, splitList, unescapeValue, type FlatConfig } from "../formats/ini.ts";
import { PROJECT_CONFIG, serializeValue, setConfigValues, writeProject } from "../formats/project-edit.ts";
import { readProject } from "../formats/threemf.ts";
import { ZipReader } from "../formats/zip.ts";
import { openInGui, windowState } from "../gui/index.ts";
import { describeFailure } from "../slicer/run.ts";
import { Refusal } from "../util/errors.ts";
import { commitFile, outputTarget, requireFile, stem, withStaging } from "../util/paths.ts";
import { suggest } from "../util/suggest.ts";
import { filamentShadows } from "./args.ts";
import { editV3Project } from "./edit-project-v3.ts";
import { V3_PROJECT_REFUSAL } from "./gui.ts";
import { json, tool, type ToolDeps } from "./common.ts";
import { freeName } from "./slice.ts";

/** Bookkeeping keys PrusaSlicer rewrites itself when it loads a project; not compared. */
const META = /^(inherits.*|compatible_.*|.*_settings_modified|physical_printer_settings_id)$/;

/** Keys a caller may not set: they run programs or name the presets. */
const BLOCKED = new Set(["post_process", "printer_settings_id", "print_settings_id", "filament_settings_id", "inherits"]);

export function registerEditProject(server: McpServer, { slicer }: ToolDeps): void {
  tool(
    server,
    "edit_project",
    {
      title: "Change a project's settings",
      description:
        "Change the settings of a PrusaSlicer 3MF project instead of asking the user to click: switch its filament or print preset, and set settings " +
        "(fill_density, fill_pattern, infill_every_layers, ...). Writes a copy next to the project, has PrusaSlicer load it to check every value, and " +
        "can open it in PrusaSlicer, where the changes show as modified settings (in PrusaSlicer 3.0 as a preset named '(From 3mf) <name>'). For the project open in the GUI, take its path from slicer_status. " +
        "The running GUI itself cannot be changed: PrusaSlicer has no API for that.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path of a .3mf project saved by PrusaSlicer 2.x."),
        filament: z.string().optional().describe("Filament preset to switch to. Its settings replace the old filament's; must be installed and fit."),
        print: z.string().optional().describe("Print preset to switch to, the same way."),
        settings: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('Settings to set on top, as config key to value: { "fill_density": "10%", "fill_pattern": "lightning" }.'),
        output: z.string().optional().describe("Absolute output path. Default: <name>-edited.3mf next to the project."),
        overwrite: z.boolean().default(false),
        open: z.boolean().default(false).describe("Open the result in PrusaSlicer afterwards. PrusaSlicer may ask the user about unsaved changes."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      if (!args.filament && !args.print && !args.settings) throw new Refusal("Give a filament, a print preset or settings to change.");
      const file = await requireFile(args.path, [".3mf"]);
      const project = await readProject(file);
      if ((await slicer.info()).backend.major >= 3) {
        if (project.kind === "prusaslicer-2") {
          throw new Refusal(
            "This is a PrusaSlicer 2.x project and the server runs 3.x. PrusaSlicer 3.0 opens it with its presets and values; saved there it becomes a 3.0 project " +
              "that edit_project can change. Or run the server with 2.9 (PRUSASLICER_PATH) to edit it as it is.",
          );
        }
        if (project.kind !== "prusaslicer-3") throw new Refusal("This 3MF holds no PrusaSlicer settings. Slice it with presets and overrides instead.");
        const edited = await editV3Project(slicer, file, args);
        return json({ ...edited, opened: args.open ? { opened: false, note: V3_PROJECT_REFUSAL, path: edited.output } : undefined });
      }
      if (project.kind !== "prusaslicer-2" || project.config.size === 0) {
        throw new Refusal(
          project.kind === "prusaslicer-3"
            ? "PrusaSlicer 3.0 projects are not supported for editing yet."
            : "This 3MF holds no PrusaSlicer 2.x settings. Slice it with presets and overrides instead.",
        );
      }
      const { printer, print, filament } = project.presets;
      if (!printer || !print || !filament[0]) throw new Refusal("The project does not name its printer, print and filament presets.");
      if (args.filament && filament.length > 1) throw new Refusal("Switching filaments in a multi-material project is not supported yet.");
      const before: Presets = { printer, print, filament: filament[0] };

      const changes = new Map<string, string>();
      const shadowNotes: string[] = [];
      const replacedModifications: string[] = [];

      // A preset switch takes over every value in which the new preset differs from the old one,
      // as the GUI does when you pick another preset and discard the changes.
      if (args.filament || args.print) {
        const after = await slicer.completePresets({ printer, print: args.print ?? print, filament: args.filament ?? filament[0] });
        const oldConfig = await slicer.resolveConfig(before).catch((error: unknown) => {
          throw new Refusal(
            `The project's own presets (${before.print} / ${before.filament}) are not installed here, so the switch cannot be computed. ` +
              `install_profiles can enable them. (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
          );
        });
        const newConfig = await slicer.resolveConfig(after);
        for (const key of new Set([...oldConfig.keys(), ...newConfig.keys()])) {
          const from = oldConfig.get(key);
          const to = newConfig.get(key);
          if (from === to || to === undefined) continue;
          changes.set(key, to);
          if (project.config.has(key) && project.config.get(key) !== from) replacedModifications.push(key);
        }
      }

      if (args.settings) {
        const catalog = await slicer.catalog();
        for (const [rawKey, rawValue] of Object.entries(args.settings)) {
          const key = rawKey.trim().replace(/^--/, "").replace(/-/g, "_");
          if (BLOCKED.has(key)) throw new Refusal(`${key} cannot be set here.${key.endsWith("_settings_id") ? " Use filament or print to switch presets." : ""}`);
          if (!catalog.has(key) && !project.config.has(key)) {
            throw new Refusal(`Unknown setting "${rawKey}".`, { did_you_mean: suggest(key, [...catalog.keys(), ...project.config.keys()]) });
          }
          changes.set(key, serializeValue(rawValue));
        }
        // A filament's filament_<key> wins over <key>: set it too, so the value asked for is the one that slices.
        const effective: FlatConfig = new Map([...project.config, ...changes]);
        const asked = new Map(Object.keys(args.settings).map((rawKey) => {
          const key = rawKey.trim().replace(/^--/, "").replace(/-/g, "_");
          return [key, changes.get(key)!] as const;
        }));
        const shadows = filamentShadows(asked, effective, catalog);
        for (const [key, value] of shadows.extra) changes.set(key, value);
        shadowNotes.push(...shadows.notes);
      }

      const configText = await (async () => {
        const zip = await ZipReader.open(file);
        try {
          return (await zip.readText(PROJECT_CONFIG)) ?? "";
        } finally {
          await zip.close();
        }
      })();
      const nextConfig = setConfigValues(configText, changes);

      const target = args.output ? await outputTarget(args.output, dirname(file), "") : await freeName(dirname(file), `${stem(file)}-edited.3mf`);
      await slicer.assertOutsideDatadir(dirname(target));
      if (!target.toLowerCase().endsWith(".3mf")) throw new Refusal("The output name must end in .3mf.");
      if (target === file) throw new Refusal("Write the edited project to another file; the original stays as it is.");

      const check = await withStaging(dirname(target), async (staging) => {
        const staged = join(staging, basename(target));
        await writeProject(file, staged, nextConfig);

        // Let PrusaSlicer read the result: it reports bad numbers, and replaces bad enum values by
        // their default without a word, so every changed value is compared with what it loaded.
        const saved = join(staging, "check.ini");
        const run = await slicer.run([staged, "--post-process", "", "--save", saved]);
        if (!existsSync(saved)) throw new Refusal(describeFailure(run, "Checking the edited project"));
        const loaded = parseIniConfig(await readFile(saved, "utf8"));
        const rejected = [...changes].filter(
          ([key, value]) => !META.test(key) && loaded.has(key) && normalize(loaded.get(key)!) !== normalize(value),
        );
        if (rejected.length) {
          const catalog = await slicer.catalog().catch(() => new Map());
          throw new Refusal("PrusaSlicer did not accept these values, so nothing was written.", {
            rejected: Object.fromEntries(
              rejected.map(([key, value]) => [key, { given: value, prusaslicer_used: loaded.get(key), allowed: catalog.get(key)?.values }]),
            ),
          });
        }
        await commitFile(staged, target, args.overwrite);
        return loaded;
      });

      const opened = args.open ? await openResult(slicer, target) : undefined;

      const filamentNow = splitList(check.get("filament_settings_id") ?? "")[0] ?? null;
      return json({
        output: target,
        presets: {
          before,
          after: { printer: unescapeValue(check.get("printer_settings_id") ?? ""), print: unescapeValue(check.get("print_settings_id") ?? ""), filament: filamentNow },
        },
        changed: describeChanges(changes, project.config),
        replaced_project_modifications: replacedModifications.length ? replacedModifications : undefined,
        opened,
        also_set: shadowNotes.length ? shadowNotes : undefined,
        note: "The original project is unchanged. In PrusaSlicer the new values show as modified settings of the presets.",
      });
    },
  );
}

/** Opens the result in PrusaSlicer and says what the window shows afterwards. */
async function openResult(slicer: ToolDeps["slicer"], path: string): Promise<Record<string, unknown>> {
  const info = await slicer.info();
  const wasRunning = (await windowState()).running;
  await openInGui(info.binary, [path]);
  await sleep(wasRunning ? 1500 : 4000);
  const state = await windowState();
  return {
    was_running: wasRunning,
    window_title: state.title,
    note: state.note,
  };
}

function normalize(value: string): string {
  return unescapeValue(value).trim();
}

function describeChanges(changes: Map<string, string>, before: FlatConfig): Record<string, { from: string | null; to: string }> | { count: number; keys: string[] } {
  if (changes.size > 60) return { count: changes.size, keys: [...changes.keys()].sort() };
  const clip = (value: string) => (value.length > 160 ? `${value.slice(0, 160)}… (${value.length} chars)` : value);
  return Object.fromEntries(
    [...changes].sort((a, b) => a[0].localeCompare(b[0])).map(([key, to]) => [key, { from: before.has(key) ? clip(before.get(key)!) : null, to: clip(to) }]),
  );
}
