import type { McpServer } from "@modelcontextprotocol/server";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { captureWindow, importIntoV3Gui, openInGui, windowState } from "../gui/index.ts";
import { readProject } from "../formats/threemf.ts";
import { Refusal } from "../util/errors.ts";
import { requireFile } from "../util/paths.ts";
import { json, READ_ONLY, tool, type ToolDeps } from "./common.ts";
import { MODEL_EXTENSIONS } from "./slice.ts";

/** Why a 3.0 project cannot be opened from here, checked against 3.0.0-alpha14 on 2026-11-19. */
export const V3_PROJECT_REFUSAL =
  "PrusaSlicer 3.0 cannot be told to open a project from outside: macOS's open (and Finder's Open With) gives an empty project, " +
  "and its single-instance channel imports only the geometry, without the project's settings. Open the file in PrusaSlicer with Open project.";

export function registerGui(server: McpServer, { slicer }: ToolDeps): void {
  tool(
    server,
    "open_in_prusaslicer",
    {
      title: "Open in PrusaSlicer",
      description:
        "Open model, project or G-code files in the running PrusaSlicer, or start it with them. PrusaSlicer may ask the user whether to load a 3MF " +
        "as a project or import only its geometry; that dialog stays for the user to answer. PrusaSlicer 3.0 takes only models from outside, " +
        "imported into its open project; a 3.0 or 2.x project has to be opened in PrusaSlicer itself, and the answer says so.",
      inputSchema: z.object({ paths: z.array(z.string()).min(1).max(20).describe("Absolute paths.") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ paths }) => {
      const files = await Promise.all(paths.map((path) => requireFile(path, [...MODEL_EXTENSIONS, ".gcode", ".bgcode"])));
      const info = await slicer.info();
      if (info.backend.major >= 3) {
        const projects: string[] = [];
        for (const file of files) {
          if (/\.b?gcode$/i.test(file)) throw new Refusal("PrusaSlicer 3.0 cannot be sent G-code to view from outside. gcode_info reads it here.");
          if (extname(file).toLowerCase() === ".3mf") {
            const kind = (await readProject(file).catch(() => null))?.kind;
            if (kind === "prusaslicer-3" || kind === "prusaslicer-2") projects.push(file);
          }
        }
        if (projects.length) throw new Refusal(V3_PROJECT_REFUSAL, { open_in_prusaslicer_yourself: projects });
        const { started } = await importIntoV3Gui(info.binary, files);
        return json({
          imported: files,
          started_prusaslicer: started || undefined,
          note: "Imported into the project open in PrusaSlicer 3.0, as objects. Its window title does not change, so check with screenshot_prusaslicer.",
        });
      }
      const before = await windowState();
      await openInGui(info.binary, files);
      // Give PrusaSlicer a moment to load, so the title reflects the result.
      await sleep(before.running ? 1500 : 4000);
      const after = await windowState();
      return json({ opened: files, was_running: before.running, running: after.running, window_title: after.title, note: after.note });
    },
  );

  tool(
    server,
    "screenshot_prusaslicer",
    {
      title: "Screenshot of PrusaSlicer",
      description:
        "A PNG of the PrusaSlicer window as the user sees it (plater, preview or settings), also when it is behind other windows. " +
        "macOS and Windows. On macOS the app running this server needs Screen Recording permission.",
      inputSchema: z.object({
        max_size: z.number().int().min(400).max(4000).default(1600).describe("Longest edge in pixels."),
      }),
      annotations: READ_ONLY,
    },
    async ({ max_size }) => {
      const dir = await mkdtemp(join(tmpdir(), "prusaslicer-mcp-shot-"));
      try {
        const file = join(dir, "window.png");
        const result = await captureWindow(file, max_size);
        if (!result.ok) throw new Refusal(result.reason);
        const data = await readFile(file);
        const state = await windowState();
        const response = json({ window_title: state.title, bytes: data.length });
        response.content.push({ type: "image", data: data.toString("base64"), mimeType: "image/png" });
        return response;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}
