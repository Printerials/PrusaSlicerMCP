import { McpServer } from "@modelcontextprotocol/server";
import { SlicerContext } from "./context.ts";
import { registerGcode } from "./tools/gcode.ts";
import { registerGui } from "./tools/gui.ts";
import { registerModel } from "./tools/model.ts";
import { registerProfiles } from "./tools/profiles.ts";
import { registerSlice } from "./tools/slice.ts";
import { registerStatus } from "./tools/status.ts";
import { VERSION } from "./version.ts";

const INSTRUCTIONS = `PrusaSlicer on this machine, with PrusaSlicer itself as the source of truth for profiles, slicing and geometry.
- Start with slicer_status: version, selected presets, the project open in the GUI.
- Preset names must be exact. list_printers and list_profiles give them; a wrong name is refused with suggestions.
- get_config shows what a preset set resolves to and compares two sets; describe_setting explains a setting.
- slice writes G-code next to the input and never replaces a file unless overwrite is set. Use gcode_format ascii when you want postprocess_gcode or per-layer details from gcode_info.
- Paths are absolute. On macOS, Downloads, Documents and Desktop need Files and Folders permission for the app that runs this server.`;

/** One server per connection; the slicer context (caches, the slice queue) is shared. */
export function createServer(slicer: SlicerContext): McpServer {
  const server = new McpServer({ name: "prusaslicer-mcp", version: VERSION }, { instructions: INSTRUCTIONS, capabilities: { tools: {} } });
  const deps = { slicer };
  registerStatus(server, deps);
  registerProfiles(server, deps);
  registerSlice(server, deps);
  registerModel(server, deps);
  registerGcode(server, deps);
  registerGui(server, deps);
  return server;
}
