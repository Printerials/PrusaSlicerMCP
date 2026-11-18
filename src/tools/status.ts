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
        "recent projects, whether the GUI is running with which project open (and unsaved changes), and where spools come from (Printerials account or Spoolman).",
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
          backend: `${info.backend.major}.x${info.backend.experimental ? " (experimental: checked against 3.0.0-alpha14 only. Settings go through a --load config, as 3.0 ignores them as options. Known alpha14 quirks: ASCII G-code only, empty preset ids and retract_lift 0 in the G-code header, no selected presets in its app config)" : ""}`,
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
