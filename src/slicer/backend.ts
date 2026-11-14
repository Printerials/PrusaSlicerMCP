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
  /** Where PrusaSlicer keeps presets and its app config, or null when it is not there. */
  defaultDatadir(): string | null;
  /** Arguments that list the print and filament profiles compatible with a printer, as JSON. */
  profilesQueryArgs(printer: string): string[];
  parseProfilesQuery(json: unknown): ProfilesListing;
  /** Arguments that write the resolved config of the given presets to a file. */
  saveConfigArgs(outputPath: string): string[];
  parseSavedConfig(text: string): FlatConfig;
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
