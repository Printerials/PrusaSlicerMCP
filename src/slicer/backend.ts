import type { SettingInfo } from "../formats/help.ts";
import type { FlatConfig } from "../formats/ini.ts";

/**
 * What differs between PrusaSlicer majors. 2.x stores configs as INI and its app state in
 * PrusaSlicer.ini; 3.0 moved to JSON (configs, app state, 3MF projects) and YAML bundles and
 * renamed the profile query. Everything a tool needs from the installed slicer goes through here.
 */
export interface Backend {
  major: number;
  /** True while the backend is built from the source but not run against a real binary. */
  experimental: boolean;
  /** How to read the catalogue of settings a slice can override. 2.x prints it, 3.0 writes it to a file. */
  catalog: {
    /** True when the command writes the catalogue to the file given, false when it prints it. */
    toFile: boolean;
    args(outputPath: string): string[];
    parse(text: string): SettingInfo[];
  };
  /** True when --query-* output must be written with -o: 3.0 mixes its log lines into stdout. */
  queryToFile: boolean;
  /**
   * Null when settings can be given as command line options (2.x). 3.0 ignores them without a word:
   * its settings go into a config file given with --load. The function takes the config that
   * saveConfigArgs wrote and returns it with the changes made, values as the CLI would take them.
   */
  patchConfig: ((savedConfig: string, changes: ReadonlyMap<string, string>, catalog: ReadonlyMap<string, SettingInfo>) => string) | null;
  /** Where PrusaSlicer keeps presets and its app config, or null when it is not there. */
  defaultDatadir(): string | null;
  /** Arguments that list the print and filament profiles compatible with a printer, as JSON. */
  profilesQueryArgs(printer: string): string[];
  parseProfilesQuery(json: unknown): ProfilesListing;
  /** Arguments that write the resolved config of the given presets to a file. */
  saveConfigArgs(outputPath: string): string[];
  parseSavedConfig(text: string): FlatConfig;
  /**
   * True when --info reports a bounding box that includes the origin: 3.0.0-alpha14 gives a model
   * at x 115..135 as min_x 0, size_x 135 (negative coordinates come out right).
   */
  infoBoundsIncludeOrigin: boolean;
  /** True when --export-stl and --export-3mf place a lone model on the bed centre unless told not to (3.0). */
  exportArranges: boolean;
  /** True when the app config says which presets the GUI has selected (3.0 does not keep that). */
  keepsGuiSelection: boolean;
  readAppState(datadir: string): Promise<AppState>;
  /** The config keys holding the names of the presets a config came from. */
  presetIdKeys: { printer: string; print: string; filament: string };
}

export interface ProfilesListing {
  printer: string;
  prints: Array<{ name: string; filaments: string[] }>;
}

export interface AppState {
  presets: {
    printer: string | null;
    print: string | null;
    filament: string | null;
    physicalPrinter: string | null;
  };
  /** Full paths, most recent first. */
  recentProjects: string[];
  /** The directory PrusaSlicer last exported to. */
  lastOutputDir: string | null;
  /** Where the state came from, for the status report. */
  source: string | null;
}

export const EMPTY_APP_STATE: AppState = {
  presets: { printer: null, print: null, filament: null, physicalPrinter: null },
  recentProjects: [],
  lastOutputDir: null,
  source: null,
};
