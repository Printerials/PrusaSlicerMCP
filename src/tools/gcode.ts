import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { isBgcodeFile } from "../formats/bgcode.ts";
import { readGcode } from "../formats/gcode.ts";
import { unescapeValue } from "../formats/ini.ts";
import { insertAtLayers, type Insert } from "../formats/postprocess.ts";
import { Refusal } from "../util/errors.ts";
import { commitFile, outputTarget, requireFile, stem, withStaging } from "../util/paths.ts";
import { json, READ_ONLY, tool, WRITES_NEW_FILES, type ToolDeps } from "./common.ts";
import { freeName } from "./slice.ts";

const GCODE_EXTENSIONS = [".gcode", ".bgcode", ".gco", ".g"];

export function registerGcode(server: McpServer, _deps: ToolDeps): void {
  tool(
    server,
    "gcode_info",
    {
      title: "G-code summary",
      description:
        "What a G-code file from PrusaSlicer says about its print: print time, filament per extruder, cost, printer model, presets, layers and objects. " +
        "ASCII G-code also gives filament per feature (perimeters, infill, supports) and the layers of pauses, colour and tool changes. " +
        "Reads .gcode and binary .bgcode. Ask for config keys to see the settings it was sliced with.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to a .gcode or .bgcode file."),
        keys: z.array(z.string()).optional().describe("Config keys to return from the embedded config, such as layer_height or temperature."),
        include_thumbnail: z.boolean().default(false).describe("Return the largest PNG thumbnail embedded in the file."),
      }),
      annotations: READ_ONLY,
    },
    async ({ path, keys, include_thumbnail }) => {
      const file = await requireFile(path, GCODE_EXTENSIONS);
      const { report, config, thumbnails } = await readGcode(file);
      const settings = keys?.length ? Object.fromEntries(keys.map((key) => [key, config.get(key) ?? null])) : undefined;
      const result: CallToolResult = json({ path: file, ...report, settings });
      if (include_thumbnail) {
        const png = thumbnails.filter((t) => t.format === "png").sort((a, b) => b.width * b.height - a.width * a.height)[0];
        if (png) result.content.push({ type: "image", data: png.data.toString("base64"), mimeType: "image/png" });
      }
      return result;
    },
  );

  tool(
    server,
    "postprocess_gcode",
    {
      title: "Insert a pause or colour change",
      description:
        "Insert a pause, a colour change or your own G-code at the start of given layers of an ASCII G-code file, using the printer's own " +
        "pause_print_gcode and color_change_gcode from the config embedded in the file. Writes a new file next to the input; binary G-code " +
        "must be sliced again with gcode_format ascii first.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to an ASCII .gcode file from PrusaSlicer."),
        inserts: z
          .array(
            z
              .object({
                layer: z.number().int().min(1).optional().describe("1-based layer number."),
                z: z.number().positive().optional().describe("Height in mm: the first layer at or above it."),
                action: z.enum(["pause", "color_change", "custom"]),
                gcode: z.string().optional().describe("The G-code for action custom."),
              })
              .refine((insert) => (insert.layer === undefined) !== (insert.z === undefined), "Give either layer or z."),
          )
          .min(1)
          .max(100),
        output: z.string().optional().describe("Absolute output path. Default: <name>-edited.gcode next to the input."),
        overwrite: z.boolean().default(false),
      }),
      annotations: WRITES_NEW_FILES,
    },
    async ({ path, inserts, output, overwrite }) => {
      const file = await requireFile(path, [".gcode", ".gco", ".g"]);
      if (await isBgcodeFile(file)) throw new Refusal("This is binary G-code. Slice again with gcode_format: ascii, then insert.");
      const { config } = await readGcode(file);

      const templates: Record<string, string | undefined> = {
        pause: config.get("pause_print_gcode"),
        color_change: config.get("color_change_gcode"),
      };
      const prepared: Insert[] = inserts.map((insert) => {
        let gcode: string;
        if (insert.action === "custom") {
          if (!insert.gcode?.trim()) throw new Refusal("action custom needs gcode.");
          gcode = insert.gcode;
        } else {
          const raw = templates[insert.action];
          const key = insert.action === "pause" ? "pause_print_gcode" : "color_change_gcode";
          if (!raw || !unescapeValue(raw).trim()) {
            throw new Refusal(`The printer preset in this file has no ${key}. Use action custom with the G-code your firmware expects.`);
          }
          gcode = unescapeValue(raw);
          // PrusaSlicer expands placeholders while slicing; a raw template would reach the printer as text.
          if (/[{[]/.test(gcode)) {
            throw new Refusal(`${key} contains placeholders that only PrusaSlicer can expand. Use action custom with the expanded G-code.`, {
              template: gcode,
            });
          }
        }
        return { layer: insert.layer, z: insert.z, gcode, label: insert.action.replace("_", " ") };
      });

      const target = output ? await outputTarget(output, dirname(file), "") : null;
      const destDir = target ? dirname(target) : dirname(file);
      const final = target ?? (await freeName(destDir, `${stem(file)}-edited.gcode`));
      const placed = await withStaging(destDir, async (staging) => {
        const staged = join(staging, basename(final));
        const result = await insertAtLayers(file, staged, prepared);
        await commitFile(staged, final, overwrite);
        return result;
      });
      return json({
        output: final,
        inserted: placed.inserted,
        layers: placed.layers,
        note: "Print time estimates in the file do not include the time a pause takes.",
      });
    },
  );
}
