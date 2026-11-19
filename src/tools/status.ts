import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { matchRecentProjects, parseWindowTitle, windowState } from "../gui/index.ts";
import { SpoolmanClient } from "../spoolman/client.ts";
import { json, READ_ONLY, tool, type ToolDeps } from "./common.ts";

export function registerStatus(server: McpServer, { slicer, account }: ToolDeps): void {
  tool(
    server,
    "slicer_status",
    {
      title: "PrusaSlicer status",
      description:
        "Start here. Which PrusaSlicer is installed (path, version, data directory), the printer/print/filament presets currently selected in it, " +
        "recent projects, whether the GUI is running with which project open (and unsaved changes), and where spools come from (Printerials account or Spoolman). " +
          "PrusaSlicer 3.0 keeps no selection and shows no project name; there the unsaved project open in its GUI is read from its own backup, and its presets count as the selection.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => {
      const info = await slicer.info();
      const [state, window, physical, printerials] = await Promise.all([
        slicer.appState(),
        windowState(),
        slicer.userPresets("physical_printer"),
        account.state().catch((error: unknown) => ({ status: "unknown", problem: error instanceof Error ? error.message : String(error) })),
      ]);

      let project: { name: string | null; path: string | null; unsaved: boolean; objects?: number; modified?: string; note?: string } | null = null;
      if (state.openProjects) {
        // 3.0: the title is always the build id. The GUI's backup of the unsaved project tells what is open.
        const open = window.running ? state.openProjects[0] : undefined;
        project = open
          ? {
              name: open.name,
              path: open.path,
              unsaved: true,
              objects: open.objects,
              modified: open.modified,
              note: "PrusaSlicer 3.0's backup of the unsaved project open in its window; project_info and slice read it. A project without unsaved changes has no backup.",
            }
          : null;
      } else if (window.title) {
        const title = parseWindowTitle(window.title);
        const matches = title.name ? matchRecentProjects(title.name, state.recentProjects) : [];
        project = { name: title.name, path: matches[0] ?? null, unsaved: title.modified };
      }

      return json({
        slicer: {
          version: info.help.version,
          binary: info.binary.path,
          located_by: info.binary.source,
          backend: `${info.backend.major}.x${info.backend.experimental ? " (experimental: checked against 3.0.0-alpha14 only. Settings go through a --load config, as 3.0 ignores them as options. Known alpha14 quirks, handled here: the G-code format follows the output name; the G-code header shows empty preset ids and lift settings as 0 though the G-code lifts; --info includes the origin in bounding boxes; no selected presets in its app config. See PRUSASLICER3.md)" : ""}`,
          datadir: info.datadir,
        },
        selected_presets: state.presets,
        selected_presets_from: state.presetsFrom,
        open_projects: state.openProjects && state.openProjects.length > 1 ? state.openProjects.slice(0, 5).map(({ name, path, modified }) => ({ name, path, modified })) : undefined,
        physical_printers: physical.map((preset) => preset.name),
        recent_projects: state.recentProjects.slice(0, 8),
        gui: {
          running: window.running,
          window_title: window.title,
          project,
          note: window.note,
        },
        printerials: { account: account.host, ...printerials },
        spoolman: (() => {
          try {
            const client = SpoolmanClient.fromEnv();
            if (client) return { configured: true, host: client.host, via: client.via };
            return printerials.status === "connected" ? { configured: true, host: account.host, via: "Printerials account" } : { configured: false };
          } catch (error) {
            return { configured: false, problem: error instanceof Error ? error.message : String(error) };
          }
        })(),
        queue: { slices_waiting: slicer.sliceQueue.pending },
      });
    },
  );
}
