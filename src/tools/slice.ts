import type { McpServer } from "@modelcontextprotocol/server";
import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import { readGcode } from "../formats/gcode.ts";
import { readProject } from "../formats/threemf.ts";
import { splitList } from "../formats/ini.ts";
import { spoolLabel, spoolPricePerKg } from "../spoolman/client.ts";
import { spoolman } from "./filament.ts";
import { describeFailure } from "../slicer/run.ts";
import { checkOverrides as compareOverrides } from "../slicer/verify.ts";
import { Refusal } from "../util/errors.ts";
import { commitFile, exists, expandHome, outputTarget, requireFile, stem, withStaging } from "../util/paths.ts";
import { checkOverrides, overrideArgs, overridesSchema, transformArgs, transformsSchema } from "./args.ts";
import { json, progressReporter, tool, WRITES_NEW_FILES, type ToolDeps } from "./common.ts";

export const MODEL_EXTENSIONS = [".stl", ".3mf", ".obj", ".step", ".stp", ".amf"];

/** PrusaSlicer's console noise that says nothing about the print. */
const NOISE = /^(\d{1,3} => |Slicing result exported|File exported|PrusaSlicer-\d)/;

export function registerSlice(server: McpServer, { slicer, account }: ToolDeps): void {
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
        spool_id: z.number().int().optional().describe("A spool (list_spools) to print from: checks that enough is left on it and prices the print at what it cost."),
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
      const projectIndex = projects.findIndex((p) => p && (p.kind === "prusaslicer-2" || p.kind === "prusaslicer-3") && p.config.size > 0);
      const project = projectIndex === -1 ? null : projects[projectIndex]!;
      const projectFile = projectIndex === -1 ? null : inputs.filter((input) => extname(input).toLowerCase() === ".3mf")[projectIndex]!;

      let presetArgs: string[] = [];
      let projectStem: string | null = null;
      let presets: Record<string, unknown>;
      let requested: { printer: string; print: string; filament: string } | null = null;
      if (explicit || !project) {
        const chosen = await slicer.completePresets({ printer: args.printer, print: args.print, filament: args.filament });
        presetArgs = slicer.presetArgs(chosen);
        requested = chosen;
        presets = {
          source: explicit ? "arguments" : "prusaslicer_selection",
          printer: chosen.printer,
          print: chosen.print,
          filament: chosen.filament,
          filled_in_from_selection: chosen.filledIn.length ? chosen.filledIn : undefined,
        };
      } else {
        presets = { source: "project", printer: project.presets.printer, print: project.presets.print, filament: project.presets.filament };
        // A project's own output_filename_format is the file's, not the user's: PrusaSlicer 2.9.7
        // follows "../" in it out of the output directory and replaces whatever file is there.
        // A fixed name instead, without placeholders (PrusaSlicer turns .gcode into .bgcode itself);
        // the result is named after the project file below.
        presetArgs = ["--output-filename-format", "project.gcode"];
        projectStem = stem(inputs[0]!);
      }

      const info = await slicer.info();
      const catalog = await slicer.catalog();
      const overrides = overrideArgs(args.overrides, catalog);
      const requestedOverrides = checkOverrides(args.overrides, catalog);

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

      // 2.x takes settings as command line options. 3.0 ignores them: everything goes into one
      // config file, made from the presets (or the project) with the changes in it.
      const patchConfig = info.backend.patchConfig;
      const baseConfig = patchConfig
        ? await slicer.savedConfigText(projectFile && !explicit ? [projectFile] : slicer.presetArgs(requested!))
        : null;
      const fixed = new Map<string, string>();
      if (!args.allow_post_process) fixed.set("post_process", "");
      if (format !== "auto") fixed.set("binary_gcode", format === "binary" ? "1" : "0");
      if (projectStem) fixed.set("output_filename_format", "project.gcode");
      const patchedConfig = patchConfig && baseConfig ? patchConfig(baseConfig, new Map([...requestedOverrides, ...fixed]), catalog) : null;

      const result = await withStaging(destDir, async (staging) => {
        const configPath = join(staging, "slice-config.json");
        if (patchedConfig) await writeFile(configPath, patchedConfig);
        const settingArgs = patchedConfig ? ["--load", configPath] : [...presetArgs, ...overrides.args, ...formatArgs, ...postProcessArgs];
        const run = await slicer.sliceQueue.run(() =>
          slicer.run(
            [
              "--export-gcode",
              ...settingArgs,
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
        const name = projectStem ? `${projectStem}${extname(produced[0]!)}` : produced[0]!;
        const final = fileName ? join(destDir, fileName) : args.overwrite ? join(destDir, name) : await freeName(destDir, name);
        await commitFile(staged, final, args.overwrite);
        return { final, run };
      });

      const { report, config: gcodeConfig } = await readGcode(result.final);
      // 3.0 ignores settings it does not take, without an error or a changed exit code. Every
      // override is read back from the G-code's own config block.
      // 3.0.0-alpha14's CLI writes ASCII G-code whatever binary_gcode, --binary-gcode or the file
      // name say. A file that is not what was asked for is removed, not handed over under a wrong name.
      if (format === "binary" && report.format !== "binary") {
        await unlink(result.final).catch(() => undefined);
        throw new Refusal(
          `Binary G-code was asked for, but ${info.help.version} wrote ${report.format} G-code. Use gcode_format "ascii" (or "auto"). The file was removed.`,
        );
      }
      let overrideCheck: ReturnType<typeof compareOverrides> | undefined;
      if (baseConfig && requestedOverrides.size) {
        overrideCheck = compareOverrides(requestedOverrides, info.backend.parseSavedConfig(baseConfig), gcodeConfig);
        if (overrideCheck.ignored.length) {
          await unlink(result.final).catch(() => undefined);
          throw new Refusal(
            `PrusaSlicer did not apply ${overrideCheck.ignored.map((entry) => `${entry.key} (asked ${entry.requested}, G-code has ${entry.found})`).join("; ")}. The G-code was removed.`,
          );
        }
      }
      // PrusaSlicer 2.9 silently slices with the GUI's selection when a preset cannot be used.
      if (requested) {
        const used = { printer: report.presets.printer, print: report.presets.print, filament: report.presets.filament[0] ?? null };
        const wrong = (["printer", "print", "filament"] as const).filter((kind) => used[kind] !== null && used[kind] !== requested![kind]);
        if (wrong.length) {
          await unlink(result.final).catch(() => undefined);
          throw new Refusal(
            `PrusaSlicer sliced with other presets than asked (${wrong.map((kind) => `${kind}: "${used[kind]}" instead of "${requested![kind]}"`).join("; ")}). The G-code was removed.`,
          );
        }
      }
      const messages = result.run.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !NOISE.test(line))
        .slice(0, 30);
      if (overrideCheck?.unverified.length) {
        messages.push(
          `Not confirmed in the G-code config: ${overrideCheck.unverified.map((entry) => `${entry.key} (asked ${entry.requested}, G-code has ${entry.found ?? "no such key"})`).join("; ")}.`,
        );
      }
      let spool: Record<string, unknown> | undefined;
      if (args.spool_id !== undefined) {
        const found = await (await spoolman(account)).getSpool(args.spool_id);
        const needed = report.filament.total_g;
        const left = found.remaining_weight;
        const perKg = spoolPricePerKg(found);
        spool = {
          id: found.id,
          filament: spoolLabel(found),
          remaining_g: left !== undefined ? Math.round(left) : null,
          needed_g: needed,
          enough: needed !== null && left !== undefined ? left >= needed : null,
          cost_at_spool_price: perKg !== undefined && needed !== null ? Math.round(((perKg * needed) / 1000) * 100) / 100 : null,
        };
        if (spool.enough === false) messages.unshift(`Spool ${found.id} (${spoolLabel(found)}) has ${Math.round(left!)} g left; this print needs ${needed} g.`);
        if (found.filament.diameter && report.filament.used_mm.length) {
          const sliced = Number(splitList((await readGcode(result.final)).config.get("filament_diameter") ?? "")[0]);
          if (Number.isFinite(sliced) && Math.abs(sliced - found.filament.diameter) > 0.1) {
            messages.unshift(`Spool ${found.id} is ${found.filament.diameter} mm filament; this G-code is sliced for ${sliced} mm.`);
          }
        }
      }

      return json({
        output: result.final,
        presets,
        overrides: overrides.keys.length ? overrides.keys : undefined,
        overrides_confirmed: overrideCheck ? overrideCheck.confirmed : undefined,
        transforms: args.transforms,
        post_process: args.allow_post_process ? "allowed" : "disabled",
        messages: messages.length ? messages : undefined,
        spool,
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

