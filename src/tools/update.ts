import type { McpServer } from "@modelcontextprotocol/server";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SlicerContext } from "../context.ts";
import { isGuiOfBinaryRunning } from "../gui/index.ts";
import { compareVersions, newestFor, parseBundleIndex } from "../slicer/bundle-index.ts";
import { describeFailure } from "../slicer/run.ts";
import { Refusal } from "../util/errors.ts";
import { json, tool, type ToolDeps } from "./common.ts";

/**
 * PrusaSlicer 3.0's preset updater, as its CLI exposes it (3.0.0-alpha14, measured 2026-11-20 on a
 * copy of the data directory):
 * - --preset-update-list downloads the sources' indices into update_sync/ and prints
 *   {"result": {regular_updates, forced_updates, forced_downgrades, not_in_index, new_vendors,
 *   removals}, "warnings"?}; each entry has vendor_id, vendor_repo_id, current_version,
 *   recommended_version, state and comment. A bundle set back to 1.0.24 listed 1.0.25 as a
 *   regular update.
 * - --preset-update installs all of them (presets/local/<repo>/), printing nothing unless there
 *   are warnings; that bundle was 1.0.25 again. No snapshot is taken, and user presets
 *   (presets/user) are not touched.
 * - An error comes as {"error": "..."}.
 * - Slicing is refused while forced updates are pending ("Execution blocked: Pending forced preset
 *   reconfigurations", source ProcessActions.cpp); regular updates do not block it.
 */
const V3_LISTS = ["forced_updates", "forced_downgrades", "regular_updates", "new_vendors", "removals", "not_in_index"] as const;

interface V3Entry {
  vendor_id?: string;
  vendor_repo_id?: string;
  current_version?: string;
  recommended_version?: string;
  state?: string;
  comment?: string;
}
type V3Lists = Partial<Record<(typeof V3_LISTS)[number], V3Entry[]>>;

export const FORCED_UPDATE_BLOCK = /Pending forced preset reconfigurations/;

export function registerUpdate(server: McpServer, { slicer }: ToolDeps): void {
  tool(
    server,
    "update_profiles",
    {
      title: "Check or install vendor profile updates",
      description:
        "Whether newer official profile bundles (printers, prints, filaments) are available, and with install: true, install them. " +
        "PrusaSlicer 3.x: asks Prusa's preset repository through PrusaSlicer itself, and installs with PrusaSlicer's own updater " +
        "(user presets are kept; PrusaSlicer must be closed for install). Forced updates must be installed before 3.x slices again. " +
        "PrusaSlicer 2.x: compares the installed bundles with the index PrusaSlicer last downloaded; its GUI installs updates when it starts, its command line cannot.",
      inputSchema: z.object({
        install: z.boolean().default(false).describe("Install what the check finds (PrusaSlicer 3.x). Ask the user first."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ install }) => {
      const info = await slicer.info();
      if (info.backend.major < 3) {
        const check = await v2Check(slicer);
        if (install) {
          throw new Refusal(
            "PrusaSlicer 2.x installs profile updates only in its GUI: at start it downloads the index and offers what is new " +
              "(Check for configuration updates). Its command line has no updater, and this server does not download bundles itself.",
            check,
          );
        }
        return json(check);
      }

      const before = await v3List(slicer);
      const pending = summarize(before);
      if (!install || pending.length === 0) {
        return json({
          version: info.help.version,
          up_to_date: pending.length === 0,
          ...lists(before),
          warnings: before.warnings,
          note:
            pending.length === 0
              ? "Every bundle is at the version the preset repository recommends for this PrusaSlicer."
              : (before.result?.forced_updates?.length || before.result?.forced_downgrades?.length
                  ? "Forced updates are pending: PrusaSlicer will not slice until they are installed. "
                  : "") + "install: true installs them with PrusaSlicer's own updater, after the user agrees.",
        });
      }

      if (await slicer.datadirIsTheGuis()) {
        const running = await isGuiOfBinaryRunning(info.binary.path);
        if (running !== false) {
          throw new Refusal(
            running
              ? `PrusaSlicer ${info.help.version} is open. It keeps its profiles in memory and runs its own updater; close it, then call again.`
              : "Could not check whether PrusaSlicer is open. Close it, then call again.",
          );
        }
      }
      const run = await slicer.run(["--preset-update", "--loglevel", "0"], { timeoutMs: slicer.sliceTimeoutMs });
      const answer = parseUpdaterJson(run.stdout);
      if (answer && typeof answer.error === "string") throw new Refusal(`PrusaSlicer's updater failed: ${answer.error}`);
      if (!answer && (run.exitCode !== 0 || run.signal)) throw new Refusal(describeFailure(run, "Installing the updates"));
      slicer.invalidate();
      const after = await v3List(slicer);
      const left = summarize(after);
      return json({
        version: info.help.version,
        installed: pending.filter((line) => !left.includes(line)),
        still_pending: left.length ? left : undefined,
        warnings: [...((answer?.warnings as unknown[]) ?? []), ...(after.warnings ?? [])],
        note: "PrusaSlicer's own updater installed them. User presets were not touched. An open PrusaSlicer shows the new profiles after a restart.",
      });
    },
  );
}

async function v3List(slicer: SlicerContext): Promise<{ result?: V3Lists; warnings?: unknown[] }> {
  const run = await slicer.run(["--preset-update-list", "--loglevel", "0"], { timeoutMs: slicer.sliceTimeoutMs });
  const answer = parseUpdaterJson(run.stdout);
  if (!answer) throw new Refusal(describeFailure(run, "Checking for profile updates"));
  if (typeof answer.error === "string") throw new Refusal(`PrusaSlicer's updater could not check: ${answer.error}`);
  return answer as { result?: V3Lists; warnings?: unknown[] };
}

/** The JSON object PrusaSlicer prints, after whatever log lines came first. */
export function parseUpdaterJson(stdout: string): Record<string, unknown> | null {
  const start = stdout.search(/^\{/m);
  if (start === -1) return null;
  try {
    return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** "PrusaResearch 1.0.24 -> 1.0.25 (regular_updates)", one per entry. */
function summarize(answer: { result?: V3Lists }): string[] {
  const lines: string[] = [];
  for (const list of V3_LISTS) {
    for (const entry of answer.result?.[list] ?? []) {
      lines.push(`${entry.vendor_id ?? "?"} ${entry.current_version ?? "-"} -> ${entry.recommended_version ?? "-"} (${list})`);
    }
  }
  return lines;
}

function lists(answer: { result?: V3Lists }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const list of V3_LISTS) {
    const entries = answer.result?.[list] ?? [];
    if (entries.length) {
      out[list] = entries.map((entry) => ({
        vendor: entry.vendor_id,
        repository: entry.vendor_repo_id,
        installed: entry.current_version,
        recommended: entry.recommended_version,
        comment: entry.comment || undefined,
      }));
    }
  }
  return out;
}

/**
 * 2.x: each bundle in vendor/ (config_version under [vendor]) against the index the GUI last
 * downloaded into cache/ (cache/<id>.idx, or cache/vendor/<id>.idx; the newer file counts).
 */
async function v2Check(slicer: SlicerContext): Promise<Record<string, unknown>> {
  const info = await slicer.info();
  const datadir = info.datadir;
  if (!datadir) throw new Refusal("PrusaSlicer's data directory is not known here; set PRUSASLICER_DATADIR.");
  const bundles: Array<Record<string, unknown>> = [];
  const vendorDir = join(datadir, "vendor");
  for (const file of (await readdir(vendorDir).catch(() => [] as string[])).filter((name) => name.endsWith(".ini")).sort()) {
    const id = file.slice(0, -4);
    const text = await readFile(join(vendorDir, file), "utf8").catch(() => "");
    const installed = /^config_version\s*=\s*(\S+)/m.exec(text)?.[1] ?? null;
    const name = /^name\s*=\s*(.+?)\s*$/m.exec(text)?.[1] ?? id;
    const index = await newestIndex([join(datadir, "cache", `${id}.idx`), join(datadir, "cache", "vendor", `${id}.idx`)]);
    const newest = index ? newestFor(parseBundleIndex(index.text), info.help.version) : null;
    bundles.push({
      vendor: name,
      id,
      installed,
      newest_known: newest?.version ?? null,
      update_available: installed && newest ? compareVersions(newest.version, installed) > 0 : null,
      comment: newest && installed && compareVersions(newest.version, installed) > 0 ? newest.comment : undefined,
      index_downloaded: index?.modified,
    });
  }
  const app = await readFile(join(datadir, "PrusaSlicer.ini"), "utf8").catch(() => "");
  const checks = /^preset_update\s*=\s*(\d)/m.exec(app)?.[1];
  return {
    version: info.help.version,
    bundles,
    update_available: bundles.some((bundle) => bundle.update_available === true),
    gui_checks_for_updates: checks === undefined ? null : checks === "1",
    note:
      "From the index PrusaSlicer downloaded when its GUI last started (index_downloaded), not from the internet. " +
      "The GUI installs updates when it starts, when its update check is on (gui_checks_for_updates).",
  };
}

async function newestIndex(paths: string[]): Promise<{ text: string; modified: string } | null> {
  let best: { text: string; modified: string; time: number } | null = null;
  for (const path of paths) {
    const info = await stat(path).catch(() => null);
    if (!info || (best && info.mtimeMs <= best.time)) continue;
    best = { text: await readFile(path, "utf8"), modified: info.mtime.toISOString(), time: info.mtimeMs };
  }
  return best && { text: best.text, modified: best.modified };
}
