import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { parseHelp, parseHelpFff, type HelpInfo, type SettingInfo } from "./formats/help.ts";
import { parseIniConfig, splitList, unescapeValue, type FlatConfig } from "./formats/ini.ts";
import type { AppState, Backend, ProfilesListing } from "./slicer/backend.ts";
import { EMPTY_APP_STATE } from "./slicer/backend.ts";
import { parseInstalled, readBundles, writeInstalled, type Bundle, type Installed } from "./slicer/installed.ts";
import { locateSlicer, type LocatedBinary } from "./slicer/locate.ts";
import { SerialQueue } from "./slicer/queue.ts";
import { describeFailure, runSlicer, type RunOptions, type RunResult } from "./slicer/run.ts";
import { v2Backend } from "./slicer/v2.ts";
import { v3Backend } from "./slicer/v3.ts";
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

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
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
    const result = await runSlicer(located.path, ["--help"], { timeoutMs: QUERY_TIMEOUT });
    const help = parseHelp(result.stdout + result.stderr);
    const prerelease = /alpha|beta|rc/i.test(help.version);
    const backend = help.major >= 3 ? v3Backend(prerelease) : v2Backend;
    const configured = this.env.PRUSASLICER_DATADIR ? expandHome(this.env.PRUSASLICER_DATADIR) : null;
    const datadir = configured ?? backend.defaultDatadir();
    return { binary: located, help, backend, datadir, datadirExplicit: configured !== null };
  }

  /** Runs PrusaSlicer with the configured datadir and a quiet log level unless the caller sets one. */
  async run(args: string[], options: RunOptions & { datadir?: string } = {}): Promise<RunResult> {
    const info = await this.info();
    const full = [...args];
    if (options.datadir) full.unshift("--datadir", options.datadir);
    else if (info.datadirExplicit && info.datadir) full.unshift("--datadir", info.datadir);
    if (!full.includes("--loglevel")) full.push("--loglevel", "1");
    return runSlicer(info.binary.path, full, { timeoutMs: QUERY_TIMEOUT, ...options });
  }

  private async queryJson(args: string[], what: string): Promise<unknown> {
    const result = await this.run(args);
    const start = result.stdout.indexOf("{");
    if (start === -1) throw new Refusal(describeFailure(result, what));
    try {
      return JSON.parse(result.stdout.slice(start));
    } catch {
      throw new Refusal(`${what}: PrusaSlicer returned output that is not JSON.\n${result.stdout.slice(0, 500)}`);
    }
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

  /** Settings the CLI accepts as overrides, from --help-fff. */
  catalog(): Promise<Map<string, SettingInfo>> {
    this.catalogPromise ??= (async () => {
      const result = await this.run(["--help-fff"]);
      const entries = parseHelpFff(result.stdout + result.stderr);
      if (entries.length === 0) throw new Refusal(describeFailure(result, "Reading the settings catalogue"));
      return new Map(entries.map((entry) => [entry.key, entry]));
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
    const { datadir } = await this.info();
    if (!datadir) return [];
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
    try {
      return await info.backend.readAppState(info.datadir);
    } catch {
      return structuredClone(EMPTY_APP_STATE);
    }
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
    if (!printer) throw new Refusal("No printer given and none is selected in PrusaSlicer. list_printers shows the installed ones.");
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
    if (!info.datadir) throw new Refusal("PrusaSlicer's data directory was not found. Start PrusaSlicer once to create it.");
    const path = join(info.datadir, "PrusaSlicer.ini");
    if (!existsSync(path)) throw new Refusal(`${path} does not exist. Start PrusaSlicer once and finish the Configuration Wizard.`);
    const text = await readFile(path, "utf8");
    return { path, text, installed: parseInstalled(text) };
  }

  /** True when the GUI would use this datadir: PrusaSlicer's default one. */
  async datadirIsTheGuis(): Promise<boolean> {
    const info = await this.info();
    const standard = info.backend.defaultDatadir();
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
        const result = await this.run(args, { datadir });
        const start = result.stdout.indexOf("{");
        if (start === -1) throw new Refusal(describeFailure(result, "Listing available printers"));
        const data = JSON.parse(result.stdout.slice(start)) as { printer_models?: RawModel[] };
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
        const result = await this.run(info.backend.profilesQueryArgs(printer), { datadir });
        const start = result.stdout.indexOf("{");
        if (start === -1) throw new Refusal(describeFailure(result, `Listing filaments for ${printer}`));
        const listing = info.backend.parseProfilesQuery(JSON.parse(result.stdout.slice(start)));
        return [...new Set(listing.prints.flatMap((print) => print.filaments))].sort();
      }),
    );
  }

  presetArgs(presets: Presets): string[] {
    return ["--printer-profile", presets.printer, "--print-profile", presets.print, "--material-profile", presets.filament];
  }

  /** The complete config PrusaSlicer builds from three presets: inheritance and conditions resolved. */
  resolveConfig(presets: Presets): Promise<FlatConfig> {
    return this.cached(`config:${presets.printer}\u0000${presets.print}\u0000${presets.filament}`, async () => {
      const info = await this.info();
      const dir = await mkdtemp(join(tmpdir(), "prusaslicer-mcp-"));
      try {
        const out = join(dir, info.backend.major >= 3 ? "config.json" : "config.ini");
        const result = await this.run([...this.presetArgs(presets), ...info.backend.saveConfigArgs(out)]);
        if (!existsSync(out)) throw new Refusal(describeFailure(result, "Resolving the presets"));
        const config = info.backend.parseSavedConfig(await readFile(out, "utf8"));
        assertPresetsUsed(config, presets, info.backend);
        return config;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
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
