import type { McpServer } from "@modelcontextprotocol/server";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import { readGcode } from "../formats/gcode.ts";
import { readProject } from "../formats/threemf.ts";
import { describeFailure } from "../slicer/run.ts";
import { Refusal } from "../util/errors.ts";
import { commitFile, exists, expandHome, outputTarget, requireFile, withStaging } from "../util/paths.ts";
import { overrideArgs, overridesSchema, transformArgs, transformsSchema } from "./args.ts";
import { json, progressReporter, tool, WRITES_NEW_FILES, type ToolDeps } from "./common.ts";

export const MODEL_EXTENSIONS = [".stl", ".3mf", ".obj", ".step", ".stp", ".amf"];

/** PrusaSlicer's console noise that says nothing about the print. */
const NOISE = /^(\d{1,3} => |Slicing result exported|File exported|PrusaSlicer-\d)/;

export function registerSlice(server: McpServer, { slicer }: ToolDeps): void {
  tool(
    server,
    "slice",
    {
      title: "Slice to G-code",
      description:
        "Slice models with PrusaSlicer and return the output path, print time, filament use and PrusaSlicer's warnings. Presets: the ones given; " +
        "otherwise a PrusaSlicer 3MF project's own config; otherwise the presets selected in PrusaSlicer. Missing preset names are refused with suggestions. " +
        "The output never replaces an existing file unless overwrite is set. Post-processing scripts from presets or projects do not run unless allow_post_process is set.",
      inputSchema: z.object({
        inputs: z.array(z.string()).min(1).max(50).describe("Absolute paths of STL, 3MF, OBJ, STEP or AMF files."),
        printer: z.string().optional().describe("Printer preset (list_printers)."),
        print: z.string().optional().describe("Print preset (list_profiles)."),
        filament: z.string().optional().describe("Filament preset (list_profiles)."),
        overrides: overridesSchema.optional(),
        transforms: transformsSchema.optional(),
        gcode_format: z
          .enum(["auto", "ascii", "binary"])
          .default("auto")
          .describe("auto follows the printer preset (Prusa MK4/CORE One/XL use binary). ascii is needed for postprocess_gcode and per-layer analysis."),
        output: z
          .string()
          .optional()
          .describe("Absolute output file (.gcode/.bgcode) or existing directory. Default: next to the first input, named by the preset's output_filename_format."),
        overwrite: z.boolean().default(false),
        allow_post_process: z.boolean().default(false).describe("Run the post_process scripts the presets or the project define."),
      }),
      annotations: WRITES_NEW_FILES,
    },
    async (args, ctx) => {
      const inputs = await Promise.all(args.inputs.map((input) => requireFile(input, MODEL_EXTENSIONS)));

      // Which config: explicit presets, a PrusaSlicer project's own, or the GUI selection.
      const explicit = Boolean(args.printer || args.print || args.filament);
      const projects = await Promise.all(
        inputs.filter((input) => extname(input).toLowerCase() === ".3mf").map((input) => readProject(input).catch(() => null)),
      );
      const project = projects.find((p) => p && (p.kind === "prusaslicer-2" || p.kind === "prusaslicer-3") && p.config.size > 0) ?? null;

      let presetArgs: string[] = [];
      let presets: Record<string, unknown>;
      if (explicit || !project) {
        const chosen = await slicer.completePresets({ printer: args.printer, print: args.print, filament: args.filament });
        presetArgs = slicer.presetArgs(chosen);
        presets = {
          source: explicit ? "arguments" : "prusaslicer_selection",
          printer: chosen.printer,
          print: chosen.print,
          filament: chosen.filament,
          filled_in_from_selection: chosen.filledIn.length ? chosen.filledIn : undefined,
        };
      } else {
        presets = { source: "project", printer: project.presets.printer, print: project.presets.print, filament: project.presets.filament };
      }

      const catalog = await slicer.catalog();
      const overrides = overrideArgs(args.overrides, catalog);

      // Output: a file name we pick, or the name PrusaSlicer derives from output_filename_format.
      let destDir = dirname(inputs[0]!);
      let fileName: string | null = null;
      let format = args.gcode_format;
      if (args.output) {
        const expanded = expandHome(args.output);
        const isDir = await stat(expanded).then((info) => info.isDirectory(), () => false);
        if (isDir) {
          destDir = expanded;
        } else {
          const target = await outputTarget(args.output, destDir, "");
          const ext = extname(target).toLowerCase();
          if (ext !== ".gcode" && ext !== ".bgcode") throw new Refusal("The output file must end in .gcode or .bgcode, or be an existing directory.");
          const implied = ext === ".bgcode" ? "binary" : "ascii";
          if (format !== "auto" && format !== implied) throw new Refusal(`gcode_format ${format} conflicts with the ${ext} output name.`);
          format = implied;
          destDir = dirname(target);
          fileName = basename(target);
        }
      }
      const formatArgs = format === "binary" ? ["--binary-gcode=1"] : format === "ascii" ? ["--binary-gcode=0"] : [];
      const postProcessArgs = args.allow_post_process ? [] : ["--post-process", ""];

      const result = await withStaging(destDir, async (staging) => {
        const run = await slicer.sliceQueue.run(() =>
          slicer.run(
            [
              "--export-gcode",
              ...presetArgs,
              ...overrides.args,
              ...formatArgs,
              ...postProcessArgs,
              ...transformArgs(args.transforms),
              "--loglevel",
              "2",
              "--output",
              staging,
              ...inputs,
            ],
            {
              timeoutMs: slicer.sliceTimeoutMs,
              signal: ctx.mcpReq.signal,
              onProgress: progressReporter(ctx),
              stdin: args.allow_post_process ? "Y\n" : undefined,
            },
          ),
        );
        const produced = (await readdir(staging)).filter((name) => /\.b?gcode$/i.test(name));
        if (produced.length === 0) throw new Refusal(describeFailure(run, "Slicing"));
        const staged = join(staging, produced[0]!);
        const final = fileName
          ? join(destDir, fileName)
          : args.overwrite
            ? join(destDir, produced[0]!)
            : await freeName(destDir, produced[0]!);
        await commitFile(staged, final, args.overwrite);
        return { final, run };
      });

      const { report } = await readGcode(result.final);
      const messages = result.run.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !NOISE.test(line))
        .slice(0, 30);
      return json({
        output: result.final,
        presets,
        overrides: overrides.keys.length ? overrides.keys : undefined,
        transforms: args.transforms,
        post_process: args.allow_post_process ? "allowed" : "disabled",
        messages: messages.length ? messages : undefined,
        result: report,
      });
    },
  );
}

/** "name.bgcode", or "name-2.bgcode" when that exists, and so on. */
export async function freeName(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = join(dir, name);
  for (let n = 2; await exists(candidate); n++) candidate = join(dir, `${base}-${n}${ext}`);
  return candidate;
}

