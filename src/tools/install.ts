import type { McpServer } from "@modelcontextprotocol/server";
import { copyFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { isGuiRunning } from "../gui/index.ts";
import { parseInstalled, writeInstalled, type Installed } from "../slicer/installed.ts";
import { Refusal } from "../util/errors.ts";
import { suggest } from "../util/suggest.ts";
import { capList, json, READ_ONLY, tool, type ToolDeps } from "./common.ts";

interface PrinterRef {
  vendorId: string;
  modelId: string;
  model: string;
  variant: string;
}

function matcher(search: string | undefined): (text: string) => boolean {
  const words = (search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return (text) => {
    const haystack = text.toLowerCase();
    return words.every((word) => haystack.includes(word));
  };
}

function clone(installed: Installed): Installed {
  return {
    filaments: new Set(installed.filaments),
    vendors: new Map([...installed.vendors].map(([vendor, models]) => [vendor, new Map([...models].map(([model, variants]) => [model, [...variants]]))])),
  };
}

export function registerInstall(server: McpServer, { slicer }: ToolDeps): void {
  /** Printer preset name -> where it lives in the bundles, for every available printer. */
  const printerIndex = async (): Promise<Map<string, PrinterRef>> => {
    const index = new Map<string, PrinterRef>();
    for (const model of await slicer.availablePrinters("FFF")) {
      for (const variant of model.variants) {
        for (const profile of variant.profiles) {
          index.set(profile.name, { vendorId: model.vendorId, modelId: model.id, model: model.name, variant: variant.name });
        }
      }
    }
    return index;
  };

  tool(
    server,
    "find_profiles",
    {
      title: "Find available profiles",
      description:
        "Search the official profiles in PrusaSlicer's installed vendor bundles, including the ones not enabled yet (the Configuration Wizard's choice). " +
        "filament: the filaments that fit a printer, as PrusaSlicer itself evaluates compatibility, each marked installed or not. " +
        "printer: printer models and nozzle variants with their preset names. install_profiles enables what is not installed. " +
        "PrusaSlicer 3.0 has no installed list: there everything is available, and this lists what fits.",
      inputSchema: z.object({
        kind: z.enum(["filament", "printer"]),
        search: z.string().optional().describe("Words that must all appear, such as 'buddy3d petg' or 'mk4s 0.6'."),
        printer: z.string().optional().describe("For filaments: the printer preset to check compatibility with. Defaults to the selected one."),
        only_not_installed: z.boolean().default(false),
        limit: z.number().int().min(1).max(300).default(60),
      }),
      annotations: READ_ONLY,
    },
    async ({ kind, search, printer, only_not_installed, limit }) => {
      const match = matcher(search);
      if ((await slicer.info()).backend.major >= 3) {
        // 3.0 has no installed list: every profile of the vendor bundles is available (checked with
        // 3.0.0-alpha14: 31 printer models and ~247 filaments for a CORE One, no wizard step).
        const note = "PrusaSlicer 3.0 has no installed list: every profile in its vendor bundles is available to slice with.";
        if (kind === "filament") {
          if (!printer) throw new Refusal("Give a printer: PrusaSlicer 3.0 does not keep its selected presets where this server can read them.");
          const fits = [...new Set((await slicer.profiles(printer)).prints.flatMap((p) => p.filaments))].sort();
          const capped = capList(only_not_installed ? [] : fits.filter(match).map((name) => ({ name, installed: true })), limit);
          return json({ printer, fitting_filaments: fits.length, matches: capped.items, total_matches: capped.total, truncated: capped.truncated || undefined, note });
        }
        const rows = (await slicer.printerModels("FFF")).flatMap((model) =>
          model.variants.flatMap((variant) =>
            variant.profiles.map((profile) => ({ preset: profile.name, vendor: model.vendor, model: model.name, variant: variant.name, installed: true })),
          ),
        );
        const capped = capList(only_not_installed ? [] : rows.filter((row) => match(`${row.preset} ${row.vendor} ${row.model} ${row.variant}`)), limit);
        return json({ matches: capped.items, total_matches: capped.total, truncated: capped.truncated || undefined, note });
      }
      const { installed } = await slicer.installedProfiles();

      if (kind === "filament") {
        const name = printer ?? (await slicer.appState()).presets.printer;
        if (!name) throw new Refusal("Give a printer: no printer is selected in PrusaSlicer.");
        const available = await slicer.availablePrinterNames();
        if (!available.includes(name)) throw new Refusal(`No printer preset "${name}" in the bundles.`, { did_you_mean: suggest(name, available) });
        const fits = await slicer.availableFilaments(name);
        const rows = fits
          .filter(match)
          .map((filament) => ({ name: filament, installed: installed.filaments.has(filament) }))
          .filter((row) => !only_not_installed || !row.installed);
        const capped = capList(rows, limit);
        return json({
          printer: name,
          fitting_filaments: fits.length,
          installed_of_those: fits.filter((filament) => installed.filaments.has(filament)).length,
          matches: capped.items,
          total_matches: capped.total,
          truncated: capped.truncated || undefined,
        });
      }

      const rows: Array<{ preset: string; vendor: string; model: string; variant: string; installed: boolean }> = [];
      for (const model of await slicer.availablePrinters("FFF")) {
        const installedVariants = installed.vendors.get(model.vendorId)?.get(model.id) ?? [];
        for (const variant of model.variants) {
          for (const profile of variant.profiles) {
            const row = {
              preset: profile.name,
              vendor: model.vendor,
              model: model.name,
              variant: variant.name,
              installed: installedVariants.includes(variant.name),
            };
            if (match(`${row.preset} ${row.vendor} ${row.model} ${row.variant}`) && (!only_not_installed || !row.installed)) rows.push(row);
          }
        }
      }
      const capped = capList(rows, limit);
      return json({ matches: capped.items, total_matches: capped.total, truncated: capped.truncated || undefined });
    },
  );

  tool(
    server,
    "install_profiles",
    {
      title: "Install or remove profiles",
      description:
        "Enable or disable official filament and printer profiles in PrusaSlicer, as the Configuration Wizard does (PrusaSlicer.ini). " +
        "PrusaSlicer 3.0 needs none of this: every profile is available, and the call changes nothing. " +
        "Names are filament or printer preset names from find_profiles. PrusaSlicer must be closed: it keeps this list in memory and would " +
        "write its own back on quitting. Makes a backup (PrusaSlicer.ini.mcp-backup) first. Use dry_run to see the change without writing.",
      inputSchema: z.object({
        install: z.array(z.string()).max(200).optional().describe("Filament or printer preset names to enable."),
        uninstall: z.array(z.string()).max(200).optional().describe("Filament or printer preset names to disable."),
        dry_run: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ install = [], uninstall = [], dry_run }) => {
      if ((await slicer.info()).backend.major >= 3) {
        // Nothing to switch on in 3.0. Favourites only filter the GUI's lists and live in its app
        // config, which the GUI rewrites when it closes; vendor bundles come from the preset updater.
        return json({
          installed: [],
          uninstalled: [],
          dry_run: dry_run || undefined,
          note:
            "Nothing changed: PrusaSlicer 3.0 has no installed list, every profile in its vendor bundles is already available " +
            `(asked: ${[...install, ...uninstall].join(", ") || "nothing"}). Only the GUI's favourites filter what it shows.`,
        });
      }
      if (install.length === 0 && uninstall.length === 0) throw new Refusal("Give names to install or uninstall.");
      const bundles = await slicer.bundles();
      const filamentNames = new Set(bundles.flatMap((bundle) => [...bundle.filaments]));
      const printers = await printerIndex();
      const variantOrder = (ref: PrinterRef) => bundles.find((b) => b.vendorId === ref.vendorId)?.models.get(ref.modelId)?.variants ?? [];

      const unknown = [...install, ...uninstall].filter((name) => !filamentNames.has(name) && !printers.has(name));
      if (unknown.length) {
        throw new Refusal(`Not found in PrusaSlicer's bundles: ${unknown.map((name) => `"${name}"`).join(", ")}.`, {
          did_you_mean: Object.fromEntries(unknown.map((name) => [name, suggest(name, [...filamentNames, ...printers.keys()], 4)])),
        });
      }

      const { path, text, installed } = await slicer.installedProfiles();
      const state = await slicer.appState();
      const wanted = clone(installed);
      const changes = { installed: [] as string[], uninstalled: [] as string[], unchanged: [] as string[] };

      for (const name of install) {
        if (filamentNames.has(name)) {
          if (wanted.filaments.has(name)) changes.unchanged.push(name);
          else {
            wanted.filaments.add(name);
            changes.installed.push(name);
          }
          continue;
        }
        const ref = printers.get(name)!;
        const models = wanted.vendors.get(ref.vendorId) ?? new Map<string, string[]>();
        const variants = models.get(ref.modelId) ?? [];
        if (variants.includes(ref.variant)) changes.unchanged.push(name);
        else {
          const order = variantOrder(ref);
          models.set(ref.modelId, [...variants, ref.variant].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
          wanted.vendors.set(ref.vendorId, models);
          changes.installed.push(name);
        }
      }

      for (const name of uninstall) {
        if (name === state.presets.printer || name === state.presets.filament) {
          throw new Refusal(`"${name}" is selected in PrusaSlicer. Select another preset there first.`);
        }
        if (filamentNames.has(name)) {
          if (wanted.filaments.delete(name)) changes.uninstalled.push(name);
          else changes.unchanged.push(name);
          continue;
        }
        const ref = printers.get(name)!;
        const variants = wanted.vendors.get(ref.vendorId)?.get(ref.modelId) ?? [];
        if (!variants.includes(ref.variant)) changes.unchanged.push(name);
        else {
          wanted.vendors.get(ref.vendorId)!.set(ref.modelId, variants.filter((variant) => variant !== ref.variant));
          changes.uninstalled.push(name);
        }
      }

      const printerCount = [...wanted.vendors.values()].reduce((sum, models) => sum + [...models.values()].reduce((n, v) => n + v.length, 0), 0);
      if (printerCount === 0) throw new Refusal("That would leave no printer installed; PrusaSlicer needs at least one.");

      const nothing = changes.installed.length === 0 && changes.uninstalled.length === 0;
      if (dry_run || nothing) {
        return json({ dry_run: dry_run || undefined, ...changes, note: nothing ? "Nothing to change." : "Nothing written (dry_run)." });
      }

      if (await slicer.datadirIsTheGuis()) {
        const running = await isGuiRunning();
        if (running !== false) {
          throw new Refusal(
            running
              ? "PrusaSlicer is open. It keeps the installed profiles in memory and writes them back when it quits, which would undo this. Close PrusaSlicer, then call again."
              : "Could not check whether PrusaSlicer is open. Close it, then call again.",
          );
        }
      }

      const backup = `${path}.mcp-backup`;
      await copyFile(path, backup);
      const next = writeInstalled(text, wanted);
      const staged = `${path}.mcp-${process.pid}`;
      await writeFile(staged, next, "utf8");
      await rename(staged, path);
      slicer.invalidate();

      // Read back what PrusaSlicer will read, and ask PrusaSlicer what it now lists.
      const reread = parseInstalled(next);
      const listed = new Set(await slicer.printerNames());
      const selected = state.presets.printer && listed.has(state.presets.printer) ? state.presets.printer : null;
      const fitsSelected = selected ? new Set(await slicer.availableFilaments(selected)) : null;
      const listedFilaments = selected ? new Set((await slicer.profiles(selected)).prints.flatMap((print) => print.filaments)) : null;
      const verified: Record<string, string> = {};
      for (const name of changes.installed) {
        if (!filamentNames.has(name)) verified[name] = listed.has(name) ? "listed by PrusaSlicer" : "NOT listed by PrusaSlicer";
        else if (!reread.filaments.has(name)) verified[name] = "NOT written";
        else if (selected && fitsSelected?.has(name)) verified[name] = listedFilaments?.has(name) ? `listed for ${selected}` : `NOT listed for ${selected}`;
        else verified[name] = selected ? `installed; it does not fit ${selected}, so it shows for other printers` : "installed";
      }

      return json({
        ...changes,
        verified,
        backup,
        note: "Written to PrusaSlicer.ini. PrusaSlicer reads it at startup.",
      });
    },
  );
}
