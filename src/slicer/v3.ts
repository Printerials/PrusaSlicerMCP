import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseConfigSchema } from "../formats/help.ts";
import type { FlatConfig } from "../formats/ini.ts";
import { EMPTY_APP_STATE, type AppState, type Backend, type ProfilesListing } from "./backend.ts";
import { patchSavedConfig } from "./v3-config.ts";

/**
 * PrusaSlicer 3.x. Written from the 3.0.0-alpha14 source, then checked against the alpha14
 * binary on macOS (2026-11-17): the settings catalogue, the profile queries, --save, and
 * slicing with a patched --load config (see v3-config.ts). Known alpha14 quirks, not ours:
 * the G-code header has empty printer, print and filament preset ids, and shows retract_lift = 0
 * where the config says 0.2.
 *
 * - Data directory: "PrusaSlicer3", "PrusaSlicer3-dev" for alpha and beta builds
 *   (slic3r-base Directories.cpp, versioned_datadir_name).
 * - App config: <datadir>/shared_runtime/PrusaSlicer.json (slic3r-shared App/AppConfig.cpp).
 * - `--save FILE` writes {"preset": ..., "configuration": {<location>: {key: value} | [{...}]}}
 *   (slic3r-app-cli ProcessActions.cpp, perform_configuration_save).
 * - The profile query is --query-print-tool-filament-profiles (ReadCLI.cpp).
 */
export function v3Backend(prerelease: boolean): Backend {
  return {
    major: 3,
    experimental: true,

    // --help-fff prints only the general help in alpha14; the settings come from the schema export.
    catalog: { toFile: true, args: (outputPath) => ["--export-config-schema", outputPath], parse: parseConfigSchema },
    queryToFile: true,
    patchConfig: patchSavedConfig,
    keepsGuiSelection: false,

    defaultDatadir() {
      const name = prerelease ? "PrusaSlicer3-dev" : "PrusaSlicer3";
      const base =
        process.platform === "darwin"
          ? join(homedir(), "Library", "Application Support")
          : process.platform === "win32"
            ? (process.env.APPDATA ?? null)
            : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
      if (!base) return null;
      const dir = join(base, name);
      return existsSync(dir) ? dir : null;
    },

    profilesQueryArgs(printer) {
      return ["--query-print-tool-filament-profiles", "--printer-profile", printer];
    },

    parseProfilesQuery(json) {
      const data = json as {
        printer_profile?: string;
        print_profiles?: Array<{ name: string; filament_profiles?: string[]; user_filament_profiles?: string[]; sla_material_profiles?: string[] }>;
      };
      const listing: ProfilesListing = {
        printer: data.printer_profile ?? "",
        prints: (data.print_profiles ?? []).map((print) => ({
          name: print.name,
          // 2.9.7 lists user presets separately; assumed to carry over.
          filaments: [...(print.filament_profiles ?? print.sla_material_profiles ?? []), ...(print.user_filament_profiles ?? [])],
        })),
      };
      return listing;
    },

    saveConfigArgs(outputPath) {
      return ["--save", outputPath];
    },

    parseSavedConfig(text) {
      const data = JSON.parse(text) as { preset?: SavedPreset; configuration?: Record<string, unknown> };
      const config = flattenConfiguration(data.configuration ?? {});
      // 3.0 keeps the preset names beside the settings. The printer's own name is the one under
      // hw_config (preset.printer.name is the model). Stored under the 2.x keys so both majors
      // are checked the same way.
      const { hw_config, print, materials } = data.preset ?? {};
      if (hw_config?.config_name) config.set("printer_settings_id", hw_config.config_name);
      if (print?.name) config.set("print_settings_id", print.name);
      const names = (materials ?? []).map((material) => material.name).filter((name): name is string => Boolean(name));
      // Quoted and ";"-separated, as 2.x writes a list of strings: names may hold commas.
      if (names.length) config.set("filament_settings_id", names.map((name) => `"${name.replace(/["\\]/g, "\\$&")}"`).join(";"));
      return config;
    },

    async readAppState(datadir) {
      const path = join(datadir, "shared_runtime", "PrusaSlicer.json");
      if (!existsSync(path)) return structuredClone(EMPTY_APP_STATE);
      const data = JSON.parse(await readFile(path, "utf8")) as {
        app_settings_advanced?: { recent_projects?: unknown[] };
      };
      const recent = (data.app_settings_advanced?.recent_projects ?? [])
        .map((entry) => (typeof entry === "string" ? entry : (entry as { path?: string })?.path))
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
      const state: AppState = { ...structuredClone(EMPTY_APP_STATE), recentProjects: recent, source: path };
      return state;
    },

    presetIdKeys: { printer: "printer_settings_id", print: "print_settings_id", filament: "filament_settings_id" },
  };
}

interface SavedPreset {
  hw_config?: { config_name?: string };
  print?: { name?: string };
  materials?: Array<{ name?: string }>;
}

/**
 * The configuration is a set of "boxes" per location (printer, print, material slots...). A box is
 * an object of settings; a location with one box per slot becomes a list per key, joined the
 * way 2.x serializes vectors, so both majors diff and display the same way.
 */
export function flattenConfiguration(configuration: Record<string, unknown>): FlatConfig {
  const config: FlatConfig = new Map();
  for (const box of Object.values(configuration)) {
    if (Array.isArray(box)) {
      const perKey = new Map<string, string[]>();
      for (const slot of box) {
        if (!slot || typeof slot !== "object") continue;
        for (const [key, value] of Object.entries(slot as Record<string, unknown>)) {
          const list = perKey.get(key) ?? [];
          list.push(serialize(value));
          perKey.set(key, list);
        }
      }
      for (const [key, values] of perKey) config.set(key, values.join(","));
    } else if (box && typeof box === "object") {
      for (const [key, value] of Object.entries(box as Record<string, unknown>)) {
        if (value && typeof value === "object" && !Array.isArray(value) && !isPercent(value)) {
          // A named box (keyed by name): keep its settings under the name.
          for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
            config.set(`${key}.${inner}`, serialize(innerValue));
          }
        } else {
          config.set(key, serialize(value));
        }
      }
    }
  }
  return config;
}

/** 3.0 stores percentages and mixed numbers as {"value": 15, "is_percent": true}. */
function isPercent(value: object): value is { value: number; is_percent: boolean } {
  return "is_percent" in value && "value" in value;
}

function serialize(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && !Array.isArray(value) && isPercent(value)) return `${value.value}${value.is_percent ? "%" : ""}`;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(serialize).join(",");
  return JSON.stringify(value);
}
