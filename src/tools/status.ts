import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { matchRecentProjects, parseWindowTitle, windowState } from "../gui/index.ts";
import { json, READ_ONLY, tool, type ToolDeps } from "./common.ts";

export function registerStatus(server: McpServer, { slicer }: ToolDeps): void {
  tool(
    server,
    "slicer_status",
    {
      title: "PrusaSlicer status",
      description:
        "Start here. Which PrusaSlicer is installed (path, version, data directory), the printer/print/filament presets currently selected in it, " +
        "recent projects, and whether the GUI is running with which project open (and unsaved changes).",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => {
      const info = await slicer.info();
      const [state, window, physical] = await Promise.all([slicer.appState(), windowState(), slicer.userPresets("physical_printer")]);

      let project: { name: string | null; path: string | null; unsaved: boolean } | null = null;
      if (window.title) {
        const title = parseWindowTitle(window.title);
        const matches = title.name ? matchRecentProjects(title.name, state.recentProjects) : [];
        project = { name: title.name, path: matches[0] ?? null, unsaved: title.modified };
      }

      return json({
        slicer: {
          version: info.help.version,
          binary: info.binary.path,
          located_by: info.binary.source,
          backend: `${info.backend.major}.x${info.backend.experimental ? " (experimental: built from the 3.0 source, not yet verified against a 3.0 binary)" : ""}`,
          datadir: info.datadir,
        },
        selected_presets: state.presets,
        physical_printers: physical.map((preset) => preset.name),
        recent_projects: state.recentProjects.slice(0, 8),
        gui: {
          running: window.running,
          window_title: window.title,
          project,
          note: window.note,
        },
        queue: { slices_waiting: slicer.sliceQueue.pending },
      });
    },
  );
}
