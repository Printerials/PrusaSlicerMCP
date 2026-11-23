import type { McpServer } from "@modelcontextprotocol/server";
import { mkdir, mkdtemp, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import { needsBedCopy, occupiedBeds, writeBedCopy, type BedsInfo } from "../formats/beds.ts";
import { readGcode } from "../formats/gcode.ts";
import { readProject } from "../formats/threemf.ts";
import { splitList } from "../formats/ini.ts";
import { spoolLabel, spoolPricePerKg } from "../spoolman/client.ts";
import { spoolman } from "./filament.ts";
import { flattenConfiguration } from "../slicer/v3.ts";
import { runPostProcess, scriptFailure, scriptsOf, type PostProcessResult } from "../slicer/post-process.ts";
import { describeFailure } from "../slicer/run.ts";
import type { AppliedCheck } from "../slicer/verify.ts";
import { Refusal } from "../util/errors.ts";
import { commitFile, exists, expandHome, outputTarget, requireFile, stem, withStaging } from "../util/paths.ts";
import { checkOverrides, filamentShadows, MERGE_CRASH, overrideArgs, overridesSchema, transformArgs, transformsSchema } from "./args.ts";
import { json, progressReporter, tool, WRITES_NEW_FILES, type ToolDeps } from "./common.ts";
import { addThumbnails } from "./thumbnails.ts";
import { FORCED_UPDATE_BLOCK } from "./update.ts";

export const MODEL_EXTENSIONS = [".stl", ".3mf", ".obj", ".step", ".stp", ".amf"];

/** PrusaSlicer's console noise that says nothing about the print. */
const NOISE = /^(\d{1,3} => |Slicing result exported|File exported|PrusaSlicer-\d|\[\d{4}-\d\d-\d\d )/;

/**
 * The warning codes 3.0 sends to the GUI (libslic3r/include/libslic3r/SlicingStatus.hpp,
 * WarningCode). Only 7 is confirmed against the 3.0.0-alpha14 binary: it appeared for a project
 * the GUI flagged with "Long bridging extrusions". The source read is newer than that binary.
 */
const WARNING_CODES = [
  "None", "BedTempsDiffer", "BedTempsChanged", "FilamentShrinkageDiffer", "WipeTowerNozzleDiameterDiffer",
  "SupportNozzleDiameterDiffer", "SupportsTurnedOff", "StabilityIssues", "EmptyLayers", "CustomGCodeReservedKeywords",
  "InvalidToolchange", "CloseToPrimingRegions", "ToolpathOutsideBuildVolume", "GCodeConflict",
  "XYSizeCompensationIgnoredMultiMaterialPainting", "XYSizeCompensationIgnoredFuzzySkinPainting", "VirtualExtruderMixesFilamentTypes",
];

export function registerSlice(server: McpServer, { slicer, account }: ToolDeps): void {
  tool(
    server,
    "slice",
    {
      title: "Slice to G-code",
      description:
        "Slice models with PrusaSlicer and return the output path, print time, filament use and PrusaSlicer's warnings. Presets: the ones given; " +
        "otherwise a PrusaSlicer 3MF project's own config; otherwise the presets selected in PrusaSlicer. Missing preset names are refused with suggestions. " +
        "A project with objects on more than one bed is sliced one bed per call (bed). " +
        "The output never replaces an existing file unless overwrite is set. Post-processing scripts from presets or projects do not run unless allow_post_process is set " +
          "and the user enabled it for the server (PRUSASLICER_MCP_ALLOW_POST_PROCESS=1).",
      inputSchema: z.object({
        inputs: z.array(z.string()).min(1).max(50).describe("Absolute paths of STL, 3MF, OBJ, STEP or AMF files."),
        printer: z.string().optional().describe("Printer preset (list_printers)."),
        print: z.string().optional().describe("Print preset (list_profiles)."),
        filament: z.string().optional().describe("Filament preset (list_profiles)."),
        overrides: overridesSchema.optional(),
        transforms: transformsSchema.optional(),
        bed: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "For a 3MF project with objects on more than one bed: the bed to slice, numbered as project_info lists them. " +
              "PrusaSlicer's command line slices one bed per G-code; without bed such a project is refused with its beds listed.",
          ),
        gcode_format: z
          .enum(["auto", "ascii", "binary"])
          .default("auto")
          .describe("auto follows the printer preset (Prusa MK4/CORE One/XL use binary). ascii is needed for postprocess_gcode and per-layer analysis."),
        output: z
          .string()
          .optional()
          .describe("Absolute output file (.gcode/.bgcode) or existing directory. Default: next to the first input, named by the preset's output_filename_format."),
        overwrite: z.boolean().default(false),
        allow_post_process: z
          .boolean()
          .default(false)
          .describe(
            "Run the post_process scripts the presets or the project define (2.x: PrusaSlicer runs them; 3.x, whose command line does not, " +
              "this server runs them as 2.9 does). A failing script leaves no G-code. Works only when the user started the server with " +
              "PRUSASLICER_MCP_ALLOW_POST_PROCESS=1; otherwise the slice is refused.",
          ),
        spool_id: z.number().int().optional().describe("A spool (list_spools) to print from: checks that enough is left on it and prices the print at what it cost."),
        stability_check: z
          .boolean()
          .default(false)
          .describe(
            "PrusaSlicer 3.x: say whether PrusaSlicer's own print stability check found issues (long bridging extrusions, collapsing overhangs, " +
              "loose extrusions, low bed adhesion). Which issue it was, only the GUI shows. Objects that get supports are not checked. " +
              "Slices with trace logging, which adds thousands of lines to PrusaSlicer's log.txt.",
          ),
        thumbnails: z
          .boolean()
          .default(true)
          .describe(
            "Preview images for the printer's display, in the sizes and formats (PNG, QOI) the printer preset asks for. PrusaSlicer's command line " +
              "draws none, so this server draws them from the model, seen as PrusaSlicer shows it. A 3MF with its own thumbnail gets PrusaSlicer's.",
          ),
      }),
      annotations: WRITES_NEW_FILES,
    },
    async (args, ctx) => {
      const inputs = await Promise.all(args.inputs.map((input) => requireFile(input, MODEL_EXTENSIONS)));
      // Measured with 2.9.7 and 3.0.0-alpha14: without --merge every input becomes its own G-code.
      if (inputs.length > 1 && !args.transforms?.merge) {
        throw new Refusal(
          "PrusaSlicer slices each input file to a G-code of its own unless they are merged, and slice returns one G-code. " +
            "Slice the files one call each, or set transforms.merge to put them on one plate (PrusaSlicer 3.x; 2.9.7's command line crashes on --merge).",
        );
      }

      // Which config: explicit presets, a PrusaSlicer project's own, or the GUI selection.
      const explicit = Boolean(args.printer || args.print || args.filament);
      const projects = await Promise.all(
        inputs.filter((input) => extname(input).toLowerCase() === ".3mf").map((input) => readProject(input).catch(() => null)),
      );
      const projectIndex = projects.findIndex((p) => p && (p.kind === "prusaslicer-2" || p.kind === "prusaslicer-3") && p.config.size > 0);
      const project = projectIndex === -1 ? null : projects[projectIndex]!;
      const projectFile = projectIndex === -1 ? null : inputs.filter((input) => extname(input).toLowerCase() === ".3mf")[projectIndex]!;
      const beds = inputs.length === 1 ? (projects[0]?.beds ?? null) : null;
      const bed = chooseBed(beds, args.bed);

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
      if (args.allow_post_process && !slicer.postProcessAllowed) {
        throw new Refusal(
          "Post-processing scripts run programs on this computer, and a downloaded project can carry one. allow_post_process works only when the " +
            "user runs this server with PRUSASLICER_MCP_ALLOW_POST_PROCESS=1 in its environment (the MCP configuration). Without it, slice keeps scripts off.",
        );
      }
      if (args.stability_check && !info.backend.patchConfig) {
        throw new Refusal(
          "stability_check needs PrusaSlicer 3.x. 2.9's CLI runs the check but reports nothing, not even in its trace log; only the GUI shows it.",
        );
      }
      const catalog = await slicer.catalog();
      const requestedOverrides = checkOverrides(args.overrides, catalog);
      // 2.x: a filament's filament_<key> wins over <key>; the value asked for must be the one that slices.
      const shadows =
        info.backend.patchConfig || requestedOverrides.size === 0
          ? { extra: new Map<string, string>(), notes: [] }
          : filamentShadows(requestedOverrides, requested ? await slicer.resolveConfig(requested) : project!.config, catalog);
      const overrides = overrideArgs({ ...args.overrides, ...Object.fromEntries(shadows.extra) }, catalog);

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
      if (baseConfig) {
        // 3.0 picks ASCII or binary by the extension of output_filename_format; binary_gcode and
        // --binary-gcode do not count (3.0.0-alpha14: a ".bgcode" name gave GCDE, binary_gcode true
        // with Prusa's ".gcode" name gave ASCII). "auto" follows the printer's binary_gcode, as 2.x does.
        const saved = (JSON.parse(baseConfig) as { configuration?: Record<string, Record<string, unknown>> }).configuration ?? {};
        const binary = format === "binary" || (format === "auto" && saved.printer_settings?.binary_gcode === true);
        const name = projectStem ? "project" : String(saved.print_settings?.output_filename_format ?? "{input_filename_base}").replace(/\.b?gcode$/i, "");
        fixed.set("output_filename_format", `${name}${binary ? ".bgcode" : ".gcode"}`);
        fixed.set("binary_gcode", binary ? "1" : "0");
      }
      const changes = new Map([...requestedOverrides, ...fixed]);
      const patch = patchConfig && baseConfig ? patchConfig(baseConfig, changes, catalog) : null;
      const patchedConfig = patch?.config ?? null;

      // 3.0 ignores what it does not take, without an error. Before slicing, PrusaSlicer loads the
      // written config and saves it back; every value must come back as written, in every layer.
      let applied: AppliedCheck | undefined;
      if (patch && info.backend.checkPatched) {
        const dir = await mkdtemp(join(tmpdir(), "prusaslicer-mcp-"));
        try {
          const written = join(dir, "written.json");
          await writeFile(written, patch.config);
          applied = info.backend.checkPatched(await slicer.savedConfigText(["--load", written]), patch.targets);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
        if (applied.rejected.length) {
          throw new Refusal("PrusaSlicer did not accept these values, so nothing was sliced.", {
            rejected: Object.fromEntries(
              applied.rejected.map((entry) => [
                `${entry.key} (${entry.layer})`,
                { given: entry.expected, prusaslicer_used: entry.found, allowed: catalog.get(entry.key)?.values },
              ]),
            ),
          });
        }
      }

      await slicer.assertOutsideDatadir(destDir);
      const result = await withStaging(destDir, async (staging) => {
        // A bed other than the first, or a 2.9 project with several beds: a copy PrusaSlicer slices
        // as that bed (beds.ts), named as the project so the output name stays the project's.
        let sliceInputs = inputs;
        if (beds && bed && needsBedCopy(beds, bed.number)) {
          const copyDir = join(staging, "bed");
          await mkdir(copyDir);
          sliceInputs = [join(copyDir, basename(inputs[0]!))];
          await writeBedCopy(inputs[0]!, sliceInputs[0]!, beds, bed.number);
        }
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
              args.stability_check ? "5" : "2",
              "--output",
              staging,
              ...sliceInputs,
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
        if (produced.length === 0 && FORCED_UPDATE_BLOCK.test(run.stderr)) {
          throw new Refusal(
            "PrusaSlicer will not slice until its forced profile updates are installed (\"Pending forced preset reconfigurations\"). " +
              "update_profiles lists them and installs them with install: true, after the user agrees.",
          );
        }
        if (produced.length === 0) throw new Refusal(describeFailure(run, "Slicing", args.transforms?.merge ? MERGE_CRASH : undefined));
        // 2.9 runs the scripts itself; a failed one leaves its G-code in place and exits 1, which is not trusted.
        const failed = args.allow_post_process ? scriptFailure(run.stderr + run.stdout) : null;
        if (failed) throw new Refusal(`The post-processing script failed, so no G-code was kept.\n${failed}`);
        if (produced.length > 1) throw new Refusal(`PrusaSlicer wrote ${produced.length} G-code files (${produced.join(", ")}) where one was expected; none was kept.`);
        const staged = join(staging, produced[0]!);
        let thumbnails: string | undefined;
        if (args.thumbnails) {
          try {
            thumbnails = await addThumbnails(slicer, staged, sliceInputs, args.transforms, ctx.mcpReq.signal, beds?.area);
          } catch (error) {
            thumbnails = `none: ${error instanceof Error ? error.message.split("\n")[0] : String(error)} (the G-code is as sliced)`;
          }
        }
        // 3.0's CLI runs no script: this server runs them as 2.9 does, on the G-code with its thumbnails.
        let postProcess: PostProcessResult | undefined;
        const scripts = args.allow_post_process && patchedConfig ? scriptsOf(configurationOf(patchedConfig).print_settings?.post_process) : [];
        if (scripts.length) {
          try {
            postProcess = await runPostProcess(scripts, staged, flattenConfiguration(configurationOf(patchedConfig!)), {
              timeoutMs: slicer.sliceTimeoutMs,
              signal: ctx.mcpReq.signal,
            });
          } catch (error) {
            throw new Refusal(`The post-processing script failed, so no G-code was kept.\n${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const sliced = projectStem ? `${projectStem}${extname(produced[0]!)}` : produced[0]!;
        // One G-code per bed: bed 2 of part.3mf becomes part-bed2.gcode.
        const name = bed?.several ? `${sliced.slice(0, -extname(sliced).length)}-bed${bed.number}${extname(sliced)}` : sliced;
        const final = fileName ? join(destDir, fileName) : args.overwrite ? join(destDir, name) : await freeName(destDir, name);
        await commitFile(staged, final, args.overwrite);
        return { final, run, thumbnails, postProcess };
      });

      const { report } = await readGcode(result.final);
      // 3.0.0-alpha14's CLI writes ASCII G-code whatever binary_gcode, --binary-gcode or the file
      // name say. A file that is not what was asked for is removed, not handed over under a wrong name.
      if (format === "binary" && report.format !== "binary") {
        await unlink(result.final).catch(() => undefined);
        throw new Refusal(
          `Binary G-code was asked for, but ${info.help.version} wrote ${report.format} G-code. Use gcode_format "ascii" (or "auto"). The file was removed.`,
        );
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
      messages.push(...shadows.notes, ...(patch?.notes ?? []));
      if (beds?.outside.length) {
        messages.push(`On no bed, so PrusaSlicer left out: ${beds.outside.map((item) => item.name).join(", ")}.`);
      }
      if (result.postProcess) {
        messages.push(
          `PrusaSlicer 3.0.0-alpha14's command line runs no post-processing script, so this server ran ${result.postProcess.scripts.length === 1 ? "it" : `all ${result.postProcess.scripts.length}`} as PrusaSlicer 2.9 does, after the thumbnails: ${result.postProcess.scripts.join("; ")}.`,
        );
        if (result.postProcess.renameAsked) {
          messages.push(`A script asked for the output to be named "${result.postProcess.renameAsked}"; PrusaSlicer's command line does not rename, and neither does this server.`);
        }
      }
      if (applied?.missing.length) {
        messages.push(`Not found in the config PrusaSlicer loaded, so not confirmed: ${applied.missing.join(", ")}.`);
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
        overrides_confirmed: applied ? applied.confirmed.filter((key) => requestedOverrides.has(key)) : undefined,
        transforms: args.transforms,
        bed: bed && (bed.several || bed.number !== 1) ? { sliced: bed.number, of: beds!.beds.length, objects: bed.objects, note: bed.note } : undefined,
        post_process: args.allow_post_process ? "allowed" : "disabled",
        messages: messages.length ? messages : undefined,
        spool,
        stability: args.stability_check ? stabilityOf(result.run.stdout + result.run.stderr) : undefined,
        thumbnails: result.thumbnails,
        result: report,
      });
    },
  );
}

/** The configuration of a config PrusaSlicer 3.x saved ({preset, configuration}). */
function configurationOf(text: string): Record<string, Record<string, unknown>> {
  return (JSON.parse(text) as { configuration?: Record<string, Record<string, unknown>> }).configuration ?? {};
}

/**
 * Which bed of a project to slice. PrusaSlicer's CLI slices one and drops the rest without a word,
 * so a project with objects on several beds needs `bed`; one with a single bed in use gets that one,
 * also when it is not the first.
 */
function chooseBed(
  beds: BedsInfo | null,
  asked: number | undefined,
): { number: number; several: boolean; objects: string[]; note?: string } | null {
  if (!beds) {
    if (asked !== undefined) throw new Refusal("bed applies to a PrusaSlicer 3MF project given as the only input.");
    return null;
  }
  if (beds.containers > 1) {
    throw new Refusal(
      `This project has ${beds.containers} printers (config containers). PrusaSlicer's command line slices one bed of the first; ` +
        "this server does not slice such projects yet. Slice it in PrusaSlicer, or save one printer's part as a project of its own.",
    );
  }
  const used = occupiedBeds(beds);
  const listing = beds.beds.map((entry) => ({ bed: entry.bed, objects: entry.items.map((item) => (item.printable ? item.name : `${item.name} (not printable)`)) }));
  const objectsOn = (number: number) => beds.beds[number - 1]!.items.filter((item) => item.printable).map((item) => item.name);
  if (asked === undefined) {
    if (used.length > 1) {
      throw new Refusal(
        `This project has objects on ${used.length} beds, and PrusaSlicer's command line slices one bed per G-code (it leaves the others out without a word). ` +
          `Slice them one call each with bed (${used.map((entry) => entry.bed).join(", ")}).`,
        { beds: listing },
      );
    }
    const only = used[0]?.bed ?? 1;
    return { number: only, several: false, objects: objectsOn(only), note: only !== 1 ? `Bed ${only} is the only one with objects; PrusaSlicer's command line would have sliced the empty bed 1.` : undefined };
  }
  if (asked > beds.beds.length || !used.some((entry) => entry.bed === asked)) {
    throw new Refusal(`Bed ${asked} has nothing to print on it.`, { beds: listing });
  }
  return { number: asked, several: used.length > 1, objects: objectsOn(asked) };
}

/**
 * The warnings PrusaSlicer 3.0 sent while slicing, from its trace log: the only place the CLI
 * leaves them ("status_update: {... warnings_to_append: [7] ...}"). The text of the warning is
 * not in the log, only its code.
 */
export function stabilityOf(log: string): { issues_found: boolean; warnings: Array<{ code: number; name: string }>; note: string } {
  const codes = new Set<number>();
  for (const match of log.matchAll(/warnings_to_append: \[([\d, ]*)\]/g)) {
    for (const code of match[1]!.split(",").map((part) => part.trim()).filter(Boolean)) codes.add(Number(code));
  }
  codes.delete(0);
  const warnings = [...codes].sort((a, b) => a - b).map((code) => ({ code, name: WARNING_CODES[code] ?? "unknown" }));
  return {
    issues_found: codes.has(7),
    warnings,
    note: codes.has(7)
      ? "PrusaSlicer's stability check found issues. Which ones (long bridges, overhangs, loose extrusions, bed adhesion) only the GUI shows: slice there and look, or screenshot_prusaslicer."
      : "PrusaSlicer's stability check found no issues. Objects that get supports are not checked.",
  };
}

/** "name.bgcode", or "name-2.bgcode" when that exists, and so on. */
export async function freeName(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = join(dir, name);
  for (let n = 2; await exists(candidate); n++) candidate = join(dir, `${base}-${n}${ext}`);
  return candidate;
}

