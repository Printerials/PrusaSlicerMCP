import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parseInfo } from "../formats/info.ts";
import { readProject } from "../formats/threemf.ts";
import { describeFailure } from "../slicer/run.ts";
import { Refusal } from "../util/errors.ts";
import { commitFile, outputTarget, requireFile, stem, withStaging } from "../util/paths.ts";
import { transformArgs, transformsSchema } from "./args.ts";
import { json, READ_ONLY, tool, WRITES_NEW_FILES, type ToolDeps } from "./common.ts";
import { freeName, MODEL_EXTENSIONS } from "./slice.ts";

const IGNORED_IN_DIFF = /^(printer_settings_id|print_settings_id|filament_settings_id|physical_printer_settings_id|inherits.*|compatible_.*|.*_settings_modified)$/;

export function registerModel(server: McpServer, { slicer }: ToolDeps): void {
  tool(
    server,
    "model_info",
    {
      title: "Model geometry",
      description:
        "PrusaSlicer's own analysis of model files (--info): size, bounding box, volume, facets, number of parts and whether the mesh is manifold. " +
        "Works for STL, 3MF, OBJ, STEP and AMF.",
      inputSchema: z.object({ inputs: z.array(z.string()).min(1).max(20).describe("Absolute paths.") }),
      annotations: READ_ONLY,
    },
    async ({ inputs }) => {
      const files = await Promise.all(inputs.map((input) => requireFile(input, MODEL_EXTENSIONS)));
      const result = await slicer.run(["--info", ...files], { timeoutMs: slicer.sliceTimeoutMs });
      const models = parseInfo(result.stdout);
      if (models.length === 0) throw new Refusal(describeFailure(result, "Reading the model"));
      return json({ models });
    },
  );

  tool(
    server,
    "project_info",
    {
      title: "3MF project contents",
      description:
        "What a 3MF project holds besides geometry: the presets it was made with, the settings it changes compared to those presets " +
        "(when they are installed here), per-object and per-height-range settings, colour changes and pauses, and the thumbnail. " +
        "Recognizes PrusaSlicer 2.x and 3.x projects; Bambu Studio and OrcaSlicer projects are identified but their settings are not PrusaSlicer's.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to a .3mf file."),
        include_thumbnail: z.boolean().default(false).describe("Return the project's thumbnail image."),
      }),
      annotations: READ_ONLY,
    },
    async ({ path, include_thumbnail }) => {
      const file = await requireFile(path, [".3mf"]);
      const project = await readProject(file);

      let changed: Record<string, { project: string; preset: string | null }> | undefined;
      let comparison: string | undefined;
      const { printer, print, filament } = project.presets;
      if (project.config.size > 0 && printer && print && filament[0]) {
        try {
          const presets = await slicer.completePresets({ printer, print, filament: filament[0] });
          const base = await slicer.resolveConfig(presets);
          changed = {};
          for (const [key, value] of project.config) {
            if (IGNORED_IN_DIFF.test(key)) continue;
            const preset = base.get(key) ?? null;
            if (preset !== value) changed[key] = { project: clip(value), preset: preset === null ? null : clip(preset) };
          }
          comparison = `Compared with the installed presets ${presets.printer} / ${presets.print} / ${presets.filament}.`;
        } catch (error) {
          comparison = `Not compared with presets: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
        }
      }

      const script = project.config.get("post_process")?.trim();
      const body = {
        path: file,
        kind: project.kind,
        warning: script
          ? `This project sets a post-processing script that PrusaSlicer runs after slicing: ${clip(script)}. slice keeps it off unless allow_post_process is set.`
          : undefined,
        application: project.application,
        title: project.title,
        presets: project.presets,
        changed_settings: changed,
        comparison,
        objects: project.objects.map((object) => ({
          id: object.id,
          name: object.name,
          instances: object.instances,
          overrides: nonEmpty(object.overrides),
          volumes: object.volumes.length > 1 || object.volumes.some((v) => Object.keys(v.overrides).length)
            ? object.volumes.map((v) => ({ name: v.name, type: v.type, overrides: nonEmpty(v.overrides) }))
            : undefined,
          layer_ranges: object.layer_ranges.length ? object.layer_ranges : undefined,
        })),
        custom_gcodes: project.custom_gcodes.length ? project.custom_gcodes : undefined,
        variable_layer_height: project.variable_layer_height || undefined,
        has_thumbnail: project.thumbnail !== null,
        note:
          project.kind === "bambu-orca"
            ? "Bambu Studio / OrcaSlicer project: PrusaSlicer imports the geometry, not these settings. Slice with explicit presets."
            : project.kind === "plain-3mf"
              ? "No print settings inside (geometry only, as the CLI exports it). Slicing uses explicit presets or the selection in PrusaSlicer."
              : undefined,
      };
      const result: CallToolResult = json(body);
      if (include_thumbnail && project.thumbnail) {
        result.content.push({ type: "image", data: project.thumbnail.toString("base64"), mimeType: "image/png" });
      }
      return result;
    },
  );

  tool(
    server,
    "export_model",
    {
      title: "Transform and export a model",
      description:
        "Arrange, rotate, scale, duplicate, split or cut models with PrusaSlicer and write the result as 3MF, STL or OBJ. " +
        "The CLI's 3MF export holds geometry only, no print settings. The output never replaces an existing file unless overwrite is set.",
      inputSchema: z.object({
        inputs: z.array(z.string()).min(1).max(50).describe("Absolute paths."),
        format: z.enum(["3mf", "stl", "obj"]),
        transforms: transformsSchema.optional(),
        cut_z: z.number().positive().optional().describe("Cut at this height (mm); STL output only."),
        output: z.string().optional().describe("Absolute output file. Default: next to the first input."),
        overwrite: z.boolean().default(false),
      }),
      annotations: WRITES_NEW_FILES,
    },
    async ({ inputs, format, transforms, cut_z, output, overwrite }) => {
      const files = await Promise.all(inputs.map((input) => requireFile(input, MODEL_EXTENSIONS)));
      if (cut_z !== undefined && format !== "stl") throw new Refusal("cut_z works with STL output only.");
      const target = output ? await outputTarget(output, dirname(files[0]!), "") : null;
      if (target && !target.toLowerCase().endsWith(`.${format}`)) throw new Refusal(`The output name must end in .${format}.`);
      const destDir = target ? dirname(target) : dirname(files[0]!);

      const written = await withStaging(destDir, async (staging) => {
        const run = await slicer.sliceQueue.run(() =>
          slicer.run(
            [
              `--export-${format}`,
              ...transformArgs(transforms),
              ...(cut_z !== undefined ? [`--cut=${cut_z}`] : []),
              "--output",
              staging,
              ...files,
            ],
            { timeoutMs: slicer.sliceTimeoutMs },
          ),
        );
        const produced = (await readdir(staging)).sort();
        if (produced.length === 0) throw new Refusal(describeFailure(run, "Exporting"));
        const finals: string[] = [];
        for (const [index, name] of produced.entries()) {
          const final =
            target && produced.length === 1
              ? target
              : target
                ? join(destDir, `${stem(target)}-${index + 1}.${format}`)
                : overwrite
                  ? join(destDir, name)
                  : await freeName(destDir, name);
          await commitFile(join(staging, name), final, overwrite);
          finals.push(final);
        }
        return finals;
      });

      const info = format === "obj" ? null : parseInfo((await slicer.run(["--info", ...written])).stdout);
      return json({ outputs: written, models: info ?? undefined });
    },
  );
}

function nonEmpty(record: Record<string, string>): Record<string, string> | undefined {
  return Object.keys(record).length ? record : undefined;
}

function clip(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max)}… (${value.length} chars)`;
}
