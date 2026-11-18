import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseHelpFff } from "../formats/help.ts";
import { parseIniConfig, parseIniSections } from "../formats/ini.ts";
import { EMPTY_APP_STATE, type AppState, type Backend, type ProfilesListing } from "./backend.ts";

/** PrusaSlicer 2.x, verified against 2.9.7. */
export const v2Backend: Backend = {
  major: 2,
  experimental: false,
  catalog: { toFile: false, args: () => ["--help-fff"], parse: parseHelpFff },
  queryToFile: false,
  patchConfig: null,
  keepsGuiSelection: true,

  defaultDatadir() {
    const dir =
      process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "PrusaSlicer")
        : process.platform === "win32"
          ? process.env.APPDATA
            ? join(process.env.APPDATA, "PrusaSlicer")
            : null
          : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "PrusaSlicer");
    return dir && existsSync(dir) ? dir : null;
  },

  profilesQueryArgs(printer) {
    return ["--query-print-filament-profiles", "--printer-profile", printer];
  },

  parseProfilesQuery(json) {
    // User filament presets come in a list of their own, user_filament_profiles (seen with 2.9.7).
    const data = json as {
      printer_profile?: string;
      print_profiles?: Array<{ name: string; filament_profiles?: string[]; user_filament_profiles?: string[] }>;
    };
    const listing: ProfilesListing = {
      printer: data.printer_profile ?? "",
      prints: (data.print_profiles ?? []).map((print) => ({
        name: print.name,
        filaments: [...(print.filament_profiles ?? []), ...(print.user_filament_profiles ?? [])],
      })),
    };
    return listing;
  },

  saveConfigArgs(outputPath) {
    return ["--save", outputPath];
  },

  parseSavedConfig(text) {
    return parseIniConfig(text);
  },

  async readAppState(datadir) {
    const path = join(datadir, "PrusaSlicer.ini");
    if (!existsSync(path)) return structuredClone(EMPTY_APP_STATE);
    const sections = parseIniSections(await readFile(path, "utf8"));
    const presets = sections.get("presets") ?? new Map();
    const recent = sections.get("recent") ?? new Map();
    const recentProjects = [...(sections.get("recent_projects") ?? new Map()).entries()]
      .filter(([key]) => /^\d+$/.test(key))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, value]) => value)
      .filter(Boolean);
    const state: AppState = {
      presets: {
        printer: presets.get("printer") || null,
        print: presets.get("print") || null,
        filament: presets.get("filament") || null,
        physicalPrinter: presets.get("physical_printer") || null,
      },
      recentProjects,
      lastOutputDir: recent.get("last_output_path") || recent.get("skein_directory") || null,
      source: path,
    };
    return state;
  },

  presetIdKeys: { printer: "printer_settings_id", print: "print_settings_id", filament: "filament_settings_id" },
};
