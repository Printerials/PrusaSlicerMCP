import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";
import { parseHelp, type HelpInfo, type SettingInfo } from "./formats/help.ts";
import { parseIniConfig, splitList, unescapeValue, type FlatConfig } from "./formats/ini.ts";
import type { AppState, Backend, ProfilesListing } from "./slicer/backend.ts";
import { EMPTY_APP_STATE } from "./slicer/backend.ts";
import { parseInstalled, readBundles, writeInstalled, type Bundle, type Installed } from "./slicer/installed.ts";
import { locateSlicer, type LocatedBinary } from "./slicer/locate.ts";
import { SerialQueue } from "./slicer/queue.ts";
import { describeFailure, runSlicer, type RunOptions, type RunResult } from "./slicer/run.ts";
import { v2Backend } from "./slicer/v2.ts";
import { v3Backend } from "./slicer/v3.ts";
import { readV3OpenProjects, readV3PhysicalPrinters, readV3UserPresets } from "./slicer/v3-userdata.ts";
import { isGuiRunning } from "./gui/index.ts";
import { Refusal } from "./util/errors.ts";
import { expandHome } from "./util/paths.ts";
import { suggest } from "./util/suggest.ts";

export interface Presets {
  printer: string;
  print: string;
  filament: string;
}

export interface PrinterModel {
  vendor: string;
  vendorId: string;
  id: string;
  name: string;
  technology: string;
  variants: Array<{
    name: string;
    profiles: Array<{ name: string; extruders?: number; bed?: { type?: string; width?: number; height?: number; maxHeight?: number; origin?: string } }>;
  }>;
}

export interface UserPreset {
  name: string;
  inherits: string | null;
}

export interface SlicerInfo {
  binary: LocatedBinary;
  help: HelpInfo;
  backend: Backend;
  /** The datadir PrusaSlicer uses: PRUSASLICER_DATADIR, or the default for this major. */
  datadir: string | null;
  datadirExplicit: boolean;
}

const QUERY_TIMEOUT = 60_000;
const CACHE_TTL = 60_000;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

/**
 * Everything that talks to the installed PrusaSlicer. Lazy: the binary is located and its version
 * read on first use, so the server starts (and lists its tools) without PrusaSlicer installed.
 */
export class SlicerContext {
  readonly sliceQueue = new SerialQueue();
  readonly sliceTimeoutMs: number;
  private infoPromise: Promise<SlicerInfo> | null = null;
  private catalogPromise: Promise<Map<string, SettingInfo>> | null = null;
  private caches = new Map<string, Cached<unknown>>();
  private readonly env: NodeJS.ProcessEnv;

  /**
   * Post-processing scripts run programs on this computer, and a downloaded 3MF can carry one.
   * A tool argument alone could be set by a misled agent, so the user switches it on for the server.
   */
  readonly postProcessAllowed: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    this.postProcessAllowed = env.PRUSASLICER_MCP_ALLOW_POST_PROCESS === "1";
    const timeout = Number(env.PRUSASLICER_MCP_TIMEOUT_MS);
    this.sliceTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 10 * 60_000;
  }

  info(): Promise<SlicerInfo> {
    this.infoPromise ??= this.detect().catch((error) => {
      this.infoPromise = null;
      throw error;
    });
    return this.infoPromise;
  }

  private async detect(): Promise<SlicerInfo> {
    const located = locateSlicer(this.env);
    if ("error" in located) throw new Refusal(located.error);
    const result = await runSlicer(located, ["--help"], { timeoutMs: QUERY_TIMEOUT });
    const help = parseHelp(result.stdout + result.stderr);
    const prerelease = /alpha|beta|rc/i.test(help.version);
    const backend = help.major >= 3 ? v3Backend(prerelease) : v2Backend;
    const configured = this.env.PRUSASLICER_DATADIR ? expandHome(this.env.PRUSASLICER_DATADIR) : null;
    const datadir = configured ?? backend.defaultDatadir(located);
    return { binary: located, help, backend, datadir, datadirExplicit: configured !== null };
  }

  /** Runs PrusaSlicer with the configured datadir and a quiet log level unless the caller sets one. */
  async run(args: string[], options: RunOptions & { datadir?: string } = {}): Promise<RunResult> {
    const info = await this.info();
    const full = [...args];
    if (options.datadir) full.unshift("--datadir", options.datadir);
    else if (info.datadirExplicit && info.datadir) full.unshift("--datadir", info.datadir);
    if (!full.includes("--loglevel")) full.push("--loglevel", "1");
    return runSlicer(info.binary, full, { timeoutMs: QUERY_TIMEOUT, ...options });
  }

  /** Runs a --query-* command and parses its JSON. 3.0 writes it to a file: its stdout is full of log lines. */
  private async queryJson(args: string[], what: string, options: { datadir?: string } = {}): Promise<unknown> {
    const info = await this.info();
    if (info.backend.queryToFile) {
      const dir = await mkdtemp(join(tmpdir(), "prusaslicer-mcp-"));
      try {
        const out = join(dir, "query.json");
        const result = await this.run([...args, "--output", out], options);
        if (!existsSync(out)) throw new Refusal(describeFailure(result, what));
        return parseJson(await readFile(out, "utf8"), what);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    const result = await this.run(args, options);
    const start = result.stdout.indexOf("{");
    if (start === -1) throw new Refusal(describeFailure(result, what));
    return parseJson(result.stdout.slice(start), what);
  }

  /** After the installed profiles change: every listing and resolved config may differ. */
  invalidate(): void {
    this.caches.clear();
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.caches.get(key) as Cached<T> | undefined;
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
    const value = load();
    this.caches.set(key, { at: Date.now(), value });
    value.catch(() => this.caches.delete(key));
    return value;
  }

  /** Settings a slice accepts as overrides: --help-fff for 2.x, the exported schema for 3.0. */
  catalog(): Promise<Map<string, SettingInfo>> {
    this.catalogPromise ??= (async () => {
      const { catalog } = (await this.info()).backend;
      const dir = catalog.toFile ? await mkdtemp(join(tmpdir(), "prusaslicer-mcp-")) : null;
      try {
        const out = dir ? join(dir, "catalog.json") : "";
        const result = await this.run(catalog.args(out));
        // Exit codes are not trusted: 3.0 logs a missing bed model and still writes the file.
        const text = dir ? (existsSync(out) ? await readFile(out, "utf8") : "") : result.stdout + result.stderr;
        let entries: SettingInfo[] = [];
        try {
          entries = text ? catalog.parse(text) : [];
        } catch {
          // reported below, with PrusaSlicer's own output
        }
        if (entries.length === 0) throw new Refusal(describeFailure(result, "Reading the settings catalogue"));
        const byKey = new Map<string, SettingInfo>();
        for (const entry of entries) if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
        return byKey;
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    })().catch((error) => {
      this.catalogPromise = null;
      throw error;
    });
    return this.catalogPromise;
  }

  printerModels(technology: "FFF" | "SLA" = "FFF"): Promise<PrinterModel[]> {
    return this.cached(`models:${technology}`, async () => {
      const args = ["--query-printer-models"];
      if (technology === "SLA") args.push("--printer-technology", "SLA");
      const data = (await this.queryJson(args, "Listing printer models")) as { printer_models?: RawModel[] };
      return (data.printer_models ?? []).map(normalizeModel);
    });
  }

  /** User presets of one kind ("printer", "print", "filament"), from the datadir. */
  async userPresets(kind: "printer" | "print" | "filament" | "physical_printer"): Promise<UserPreset[]> {
    const { datadir, backend } = await this.info();
    if (!datadir) return [];
    if (backend.major >= 3) {
      if (kind === "physical_printer") return (await readV3PhysicalPrinters(datadir)).map((name) => ({ name, inherits: null }));
      return (await readV3UserPresets(datadir, kind)).map(({ name, inherits }) => ({ name, inherits }));
    }
    const dir = join(datadir, kind);
    if (!existsSync(dir)) return [];
    const presets: UserPreset[] = [];
    for (const entry of await readdir(dir)) {
      if (!entry.endsWith(".ini")) continue;
      let inherits: string | null = null;
      try {
        inherits = parseIniConfig(await readFile(join(dir, entry), "utf8")).get("inherits") || null;
      } catch {
        // unreadable preset: list it without its parent
      }
      presets.push({ name: entry.slice(0, -4), inherits });
    }
    return presets.sort((a, b) => a.name.localeCompare(b.name));
  }

  async printerNames(): Promise<string[]> {
    const [models, user] = await Promise.all([this.printerModels("FFF"), this.userPresets("printer")]);
    const system = models.flatMap((model) => model.variants.flatMap((variant) => variant.profiles.map((profile) => profile.name)));
    return [...new Set([...system, ...user.map((preset) => preset.name)])];
  }

  profiles(printer: string): Promise<ProfilesListing> {
    return this.cached(`profiles:${printer}`, async () => {
      const info = await this.info();
      return info.backend.parseProfilesQuery(
        await this.queryJson(info.backend.profilesQueryArgs(printer), `Listing profiles for ${printer}`),
      );
    });
  }

  async appState(): Promise<AppState> {
    const info = await this.info();
    if (!info.datadir) return structuredClone(EMPTY_APP_STATE);
    let state: AppState;
    try {
      state = await info.backend.readAppState(info.datadir);
    } catch {
      state = structuredClone(EMPTY_APP_STATE);
    }
    if (!info.backend.keepsGuiSelection) {
      // 3.0 keeps no selected presets, and its window title names no project. What it does keep
      // is a backup of each unsaved project; while the GUI runs, the newest one is what is open,
      // and its presets stand in for the selection 2.x keeps.
      state.openProjects = await readV3OpenProjects(info.datadir).catch(() => []);
      const open = state.openProjects[0];
      const usable = (name: string | null | undefined) => Boolean(name) && !name!.startsWith("(From 3mf)");
      if (!state.presets.printer && open && usable(open.presets.printer) && (await isGuiRunning())) {
        state.presets = {
          printer: open.presets.printer,
          print: usable(open.presets.print) ? open.presets.print : null,
          filament: usable(open.presets.filament[0]) ? open.presets.filament[0]! : null,
          physicalPrinter: null,
        };
        state.presetsFrom = `the project open in PrusaSlicer (${open.name}), from its backup`;
      }
    }
    return state;
  }

  /**
   * Fills in the presets the caller left out from PrusaSlicer's current selection, and checks
   * every name against what PrusaSlicer lists. PrusaSlicer 2.9 crashes on an unknown printer or an
   * incomplete set, so nothing reaches the CLI unchecked.
   */
  async completePresets(partial: Partial<Presets>): Promise<Presets & { filledIn: string[] }> {
    const state = await this.appState();
    const filledIn: string[] = [];

    const printer = partial.printer ?? state.presets.printer;
    if (!printer) {
      const info = await this.info();
      throw new Refusal(
        info.backend.keepsGuiSelection
          ? "No printer given and none is selected in PrusaSlicer. list_printers shows the installed ones."
          : "No printer given, and no unsaved project is open in PrusaSlicer 3.0 to take presets from (3.0 keeps no selected presets). Give printer, print and filament; list_printers and list_profiles show the names.",
      );
    }
    if (!partial.printer) filledIn.push("printer");
    const printers = await this.printerNames();
    if (!printers.includes(printer)) {
      const available: string[] = await this.availablePrinterNames().catch(() => []);
      if (available.includes(printer)) {
        throw new Refusal(`Printer preset "${printer}" exists in PrusaSlicer's bundles but is not installed. install_profiles can enable it.`);
      }
      throw new Refusal(`Printer preset "${printer}" is not installed.`, { did_you_mean: suggest(printer, printers) });
    }

    const listing = await this.profiles(printer);
    const prints = listing.prints.map((print) => print.name);
    let print = partial.print;
    if (!print) {
      if (state.presets.print && prints.includes(state.presets.print)) {
        print = state.presets.print;
        filledIn.push("print");
      } else {
        throw new Refusal(`Give a print profile for ${printer}.`, { print_profiles: prints });
      }
    }
    const printEntry = listing.prints.find((entry) => entry.name === print);
    if (!printEntry) {
      throw new Refusal(`Print profile "${print}" is not compatible with ${printer} or does not exist.`, {
        did_you_mean: suggest(print, prints),
      });
    }

    let filament = partial.filament;
    if (!filament) {
      if (state.presets.filament && printEntry.filaments.includes(state.presets.filament)) {
        filament = state.presets.filament;
        filledIn.push("filament");
      } else {
        throw new Refusal(`Give a filament profile for ${printer} with "${print}".`, { filament_profiles: printEntry.filaments });
      }
    }
    if (!printEntry.filaments.includes(filament)) {
      const bundles: Bundle[] = await this.bundles().catch(() => []);
      if (bundles.some((bundle) => bundle.filaments.has(filament))) {
        // Not installed, PrusaSlicer would silently slice with the selected filament instead.
        throw new Refusal(
          `Filament profile "${filament}" is an official profile, but it is not installed. ` +
            `find_profiles shows whether it fits ${printer}; install_profiles enables it.`,
        );
      }
      throw new Refusal(`Filament profile "${filament}" is not compatible with "${print}" on ${printer}, or does not exist.`, {
        did_you_mean: suggest(filament, printEntry.filaments),
      });
    }
    return { printer, print, filament, filledIn };
  }

  // ─── Installed profiles (what the Configuration Wizard manages) ───

  /** The vendor bundles in the datadir. 2.x only: 3.0 stores presets differently. */
  async bundles(): Promise<Bundle[]> {
    const info = await this.info();
    if (info.backend.major >= 3) throw new Refusal("Managing installed profiles is supported for PrusaSlicer 2.x only, so far.");
    if (!info.datadir) throw new Refusal("PrusaSlicer's data directory was not found. Start PrusaSlicer once to create it.");
    return readBundles(info.datadir);
  }

  async installedProfiles(): Promise<{ path: string; text: string; installed: Installed }> {
    const info = await this.info();
    if (info.backend.major >= 3) throw new Refusal("Managing installed profiles is supported for PrusaSlicer 2.x only, so far.");
    if (!info.datadir) throw new Refusal("PrusaSlicer's data directory was not found. Start PrusaSlicer once to create it.");
    const path = join(info.datadir, "PrusaSlicer.ini");
    if (!existsSync(path)) throw new Refusal(`${path} does not exist. Start PrusaSlicer once and finish the Configuration Wizard.`);
    const text = await readFile(path, "utf8");
    return { path, text, installed: parseInstalled(text) };
  }

  /**
   * Output never goes into PrusaSlicer's data directory. It holds the presets and, for 3.0, the
   * GUI's backups of unsaved projects (backup_projects): a 3MF written there is offered for
   * recovery at the next start, and slicing the open project's backup would otherwise put its
   * G-code right next to it.
   */
  async assertOutsideDatadir(dir: string): Promise<void> {
    const info = await this.info();
    const target = resolvePath(dir);
    const roots = [info.datadir, info.backend.defaultDatadir(info.binary)].filter((root): root is string => Boolean(root)).map((root) => resolvePath(root));
    if (roots.some((root) => target === root || target.startsWith(`${root}${sep}`))) {
      throw new Refusal(
        `${dir} is inside PrusaSlicer's data directory (its presets, and its backups of unsaved projects). Nothing is written there: give an output outside it.`,
      );
    }
  }

  /** True when the GUI would use this datadir: PrusaSlicer's default one. */
  async datadirIsTheGuis(): Promise<boolean> {
    const info = await this.info();
    const standard = info.backend.defaultDatadir(info.binary);
    return !info.datadir || !standard || resolvePath(info.datadir) === resolvePath(standard);
  }

  /**
   * Runs fn against a scratch copy of the datadir in which every profile of every installed bundle
   * is enabled, so PrusaSlicer itself says what exists and what fits which printer. The real
   * datadir is only read.
   */
  private async withEverythingInstalled<T>(fn: (datadir: string) => Promise<T>): Promise<T> {
    const info = await this.info();
    const bundles = await this.bundles();
    const { text } = await this.installedProfiles();
    const dir = await mkdtemp(join(tmpdir(), "prusaslicer-mcp-all-"));
    try {
      await mkdir(join(dir, "vendor"));
      for (const bundle of bundles) {
        await copyFile(join(info.datadir!, "vendor", `${bundle.vendorId}.ini`), join(dir, "vendor", `${bundle.vendorId}.ini`));
      }
      for (const kind of ["printer", "print", "filament", "physical_printer"]) {
        const source = join(info.datadir!, kind);
        if (existsSync(source)) await cp(source, join(dir, kind), { recursive: true });
      }
      const everything: Installed = { filaments: new Set(bundles.flatMap((bundle) => [...bundle.filaments])), vendors: new Map() };
      for (const bundle of bundles) {
        const models = new Map<string, string[]>();
        for (const model of bundle.models.values()) if (model.variants.length) models.set(model.id, model.variants);
        if (models.size) everything.vendors.set(bundle.vendorId, models);
      }
      await writeFile(join(dir, "PrusaSlicer.ini"), writeInstalled(text, everything));
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Every printer model the installed bundles offer, installed or not. */
  availablePrinters(technology: "FFF" | "SLA" = "FFF"): Promise<PrinterModel[]> {
    return this.cached(`available-models:${technology}`, () =>
      this.withEverythingInstalled(async (datadir) => {
        const args = ["--query-printer-models", ...(technology === "SLA" ? ["--printer-technology", "SLA"] : [])];
        const data = (await this.queryJson(args, "Listing available printers", { datadir })) as { printer_models?: RawModel[] };
        return (data.printer_models ?? []).map(normalizeModel);
      }),
    );
  }

  async availablePrinterNames(): Promise<string[]> {
    const models = await this.availablePrinters("FFF");
    return models.flatMap((model) => model.variants.flatMap((variant) => variant.profiles.map((profile) => profile.name)));
  }

  /** Every filament that fits a printer, installed or not, as PrusaSlicer evaluates compatibility. */
  availableFilaments(printer: string): Promise<string[]> {
    return this.cached(`available-filaments:${printer}`, () =>
      this.withEverythingInstalled(async (datadir) => {
        const info = await this.info();
        const listing = info.backend.parseProfilesQuery(
          await this.queryJson(info.backend.profilesQueryArgs(printer), `Listing filaments for ${printer}`, { datadir }),
        );
        return [...new Set(listing.prints.flatMap((print) => print.filaments))].sort();
      }),
    );
  }

  presetArgs(presets: Presets): string[] {
    return ["--printer-profile", presets.printer, "--print-profile", presets.print, "--material-profile", presets.filament];
  }

  /**
   * The config PrusaSlicer builds from the given arguments (presets, or a project file), as
   * --save writes it: INI for 2.x, JSON for 3.0. Not cached: it is the base of a slice.
   */
  async savedConfigText(args: string[]): Promise<string> {
    const info = await this.info();
    const dir = await mkdtemp(join(tmpdir(), "prusaslicer-mcp-"));
    try {
      const out = join(dir, info.backend.major >= 3 ? "config.json" : "config.ini");
      // 3.0 asks "Continue(Y/N) ?" on stdin when the loaded config has a post_process script, and
      // without a Y it stops with no output and exit 0. A --save exports no G-code, so no script
      // runs (3.0.0-alpha14: the config came out, the script did not run).
      const result = await this.run([...args, ...info.backend.saveConfigArgs(out)], info.backend.major >= 3 ? { stdin: "Y\n" } : {});
      if (!existsSync(out)) throw new Refusal(describeFailure(result, "Resolving the presets"));
      return await readFile(out, "utf8");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** The complete config PrusaSlicer builds from three presets: inheritance and conditions resolved. */
  resolveConfig(presets: Presets): Promise<FlatConfig> {
    return this.cached(`config:${presets.printer}\u0000${presets.print}\u0000${presets.filament}`, async () => {
      const info = await this.info();
      const config = info.backend.parseSavedConfig(await this.savedConfigText(this.presetArgs(presets)));
      assertPresetsUsed(config, presets, info.backend);
      return config;
    });
  }
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Refusal(`${what}: PrusaSlicer returned output that is not JSON.\n${text.slice(0, 500)}`);
  }
}

/**
 * PrusaSlicer 2.9 replaces a preset it cannot use (not installed, not compatible) by the one
 * selected in the GUI, without a word and with exit code 0. The ids in the result say what it used.
 */
export function assertPresetsUsed(config: FlatConfig, presets: Presets, backend: Backend): void {
  const keys = backend.presetIdKeys;
  const used = {
    printer: config.has(keys.printer) ? unescapeValue(config.get(keys.printer)!) : undefined,
    print: config.has(keys.print) ? unescapeValue(config.get(keys.print)!) : undefined,
    filament: config.has(keys.filament) ? splitList(config.get(keys.filament)!)[0] : undefined,
  };
  for (const kind of ["printer", "print", "filament"] as const) {
    const value = used[kind];
    if (value !== undefined && value !== presets[kind]) {
      throw new Refusal(
        `PrusaSlicer used the ${kind} preset "${value}" instead of "${presets[kind]}": the requested one is not installed or does not fit.`,
      );
    }
  }
}

interface RawModel {
  id: string;
  name: string;
  technology: string;
  vendor_name: string;
  vendor_id: string;
  variants?: Array<{ name: string; printer_profiles?: RawProfile[] }>;
  printer_profiles?: RawProfile[];
}

interface RawProfile {
  name: string;
  extruders_cnt?: number;
  bed?: { type?: string; width?: number; height?: number; max_print_height?: number; origin?: string };
}

function normalizeModel(raw: RawModel): PrinterModel {
  const profile = (p: RawProfile) => ({
    name: p.name,
    extruders: p.extruders_cnt,
    bed: p.bed
      ? { type: p.bed.type, width: p.bed.width, height: p.bed.height, maxHeight: p.bed.max_print_height, origin: p.bed.origin }
      : undefined,
  });
  // SLA models list their profiles directly, without variants.
  const variants = raw.variants?.length
    ? raw.variants.map((variant) => ({ name: variant.name, profiles: (variant.printer_profiles ?? []).map(profile) }))
    : [{ name: "", profiles: (raw.printer_profiles ?? []).map(profile) }];
  return { vendor: raw.vendor_name, vendorId: raw.vendor_id, id: raw.id, name: raw.name, technology: raw.technology, variants };
}
