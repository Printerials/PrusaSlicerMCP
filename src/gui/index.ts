import { execFile, spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { slicerCommand, type LocatedBinary } from "../slicer/locate.ts";
import { activePids } from "../slicer/run.ts";
import * as darwin from "./darwin.ts";
import * as win32 from "./win32.ts";

export interface WindowState {
  running: boolean;
  /** The main window's title, or null when it cannot be read. */
  title: string | null;
  /** Why the title is missing, when known. */
  note?: string;
}

export type CaptureResult = { ok: true } | { ok: false; reason: string };

const UNSUPPORTED = `Reading PrusaSlicer's window is supported on macOS and Windows, not on ${process.platform}.`;

export async function windowState(): Promise<WindowState> {
  try {
    if (process.platform === "darwin") return await darwin.windowState();
    if (process.platform === "win32") return await win32.windowState();
  } catch (error) {
    return { running: false, title: null, note: error instanceof Error ? error.message : String(error) };
  }
  return { running: (await isGuiRunning()) === true, title: null, note: UNSUPPORTED };
}

/**
 * PrusaSlicer's actions, from --help of 2.9.7 and 3.0.0-alpha14. PrusaSlicer opens its GUI when it
 * is given none of them; --gcodeviewer opens the G-code viewer, not the slicer.
 */
const CLI_ACTIONS = new Set([
  "--export-3mf", "--export-amf", "--export-gcode", "-g", "--export-obj", "--export-sla", "--sla", "--export-stl", "--gcodeviewer",
  "--help", "-h", "--help-fff", "--help-sla", "--info", "--save", "--slice", "-s", "--export-config-schema",
  "--query-print-filament-profiles", "--query-print-tool-filament-profiles", "--query-printer-models",
]);

/**
 * Whether a command line is PrusaSlicer's GUI: the program is PrusaSlicer (its binary, the Flatpak's
 * /app/bin/prusa-slicer, an AppImage) and no action is given. Files and options such as --datadir
 * or --single-instance may follow.
 */
export function isGuiCommandLine(argv: string[]): boolean {
  if (!/^(prusa-slicer|PrusaSlicer)(-[^/]*\.AppImage)?$/.test(basename(argv[0] ?? ""))) return false;
  return !argv.slice(1).some((arg) => CLI_ACTIONS.has(arg.split("=")[0]!) || arg.startsWith("--preset-update"));
}

/**
 * Linux: PIDs of PrusaSlicer GUIs, from /proc/<pid>/cmdline. A name match would not do: in a
 * Flatpak the process is called slic3r_main, its bwrap carries "prusa-slicer" in its arguments,
 * and so does any process run from a directory named after PrusaSlicer (measured 2026-11-20).
 * Null when /proc cannot be read.
 */
async function linuxGuiPids(): Promise<number[] | null> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid || activePids.has(pid)) continue;
    const raw = await readFile(`/proc/${pid}/cmdline`).catch(() => null);
    if (!raw?.length) continue;
    const argv = raw.toString("utf8").split("\0");
    if (argv.at(-1) === "") argv.pop();
    if (isGuiCommandLine(argv)) pids.push(pid);
  }
  return pids;
}

/**
 * Whether the PrusaSlicer GUI runs, from the process list (no Screen Recording permission needed).
 * The CLI runs of this server are left out; on Windows the GUI is prusa-slicer.exe and the CLI
 * prusa-slicer-console.exe. Null when the process list cannot be read.
 */
export function isGuiRunning(): Promise<boolean | null> {
  if (process.platform === "linux") return linuxGuiPids().then((pids) => (pids === null ? null : pids.length > 0));
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("tasklist", ["/FI", "IMAGENAME eq prusa-slicer.exe", "/NH", "/FO", "CSV"], { timeout: 5000, windowsHide: true }, (error, stdout) =>
        resolve(error ? null : /prusa-slicer\.exe/i.test(stdout)),
      );
      return;
    }
    const args = process.platform === "darwin" ? ["-x", "PrusaSlicer"] : ["-f", "prusa-slicer|PrusaSlicer"];
    execFile("pgrep", args, { timeout: 5000 }, (error, stdout) => {
      // pgrep exits with 1 when nothing matches.
      if (error && (error as NodeJS.ErrnoException & { code?: number }).code !== 1) return resolve(null);
      const pids = stdout.split(/\s+/).filter(Boolean).map(Number).filter((pid) => pid !== process.pid && !activePids.has(pid));
      resolve(pids.length > 0);
    });
  });
}

/**
 * Whether the GUI of this PrusaSlicer binary runs. On macOS a GUI's command line is its binary's
 * path alone (seen for 3.0.0-alpha14 next to 2.9.7), which tells two installed versions apart;
 * a CLI run has arguments. Elsewhere any PrusaSlicer GUI counts. Null when it cannot be told.
 */
export function isGuiOfBinaryRunning(binary: string): Promise<boolean | null> {
  if (process.platform !== "darwin") return isGuiRunning();
  const pattern = `^${binary.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`;
  return new Promise((resolve) => {
    execFile("pgrep", ["-f", pattern], { timeout: 5000 }, (error, stdout) => {
      if (error && (error as NodeJS.ErrnoException & { code?: number }).code !== 1) return resolve(null);
      resolve(stdout.split(/\s+/).filter(Boolean).map(Number).some((pid) => pid !== process.pid && !activePids.has(pid)));
    });
  });
}

export function captureWindow(outputPath: string, maxEdge: number): Promise<CaptureResult> {
  if (process.platform === "darwin") return darwin.capture(outputPath, maxEdge);
  if (process.platform === "win32") return win32.capture(outputPath, maxEdge);
  return Promise.resolve({ ok: false, reason: UNSUPPORTED });
}

/**
 * Opens files in the running PrusaSlicer, or starts it with them. On macOS through Launch
 * Services (`open -a`), which hands the files to the running instance as an open-documents event;
 * elsewhere through --single-instance, which forwards the paths to the running instance.
 */
export function openInGui(binary: LocatedBinary, paths: string[]): Promise<void> {
  if (process.platform === "darwin" && binary.appBundle) {
    return new Promise((resolve, reject) => {
      execFile("open", ["-a", binary.appBundle!, ...paths], { timeout: 15000 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`open failed: ${stderr.trim() || error.message}`));
        else resolve();
      });
    });
  }
  return new Promise((resolve, reject) => {
    const command = slicerCommand(binary, ["--single-instance", ...paths], "gui");
    const child = spawn(command.file, command.args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * PrusaSlicer 3.0 (checked against 3.0.0-alpha14, 2026-11-19): `open -a` and Finder's "Open With"
 * give an empty project, because 3.0 handles no open-documents event. What reaches the running GUI
 * is --single-instance, which imports the files into the current project as geometry: a 3MF's
 * settings do not come along. The call exits 1 with "Failed to create a lockfile" and still
 * delivers. Started cold, PrusaSlicer ignores file arguments (source DesktopApp.cpp), so the GUI is
 * started first and the files sent once it runs.
 */
export async function importIntoV3Gui(binary: LocatedBinary, paths: string[]): Promise<{ started: boolean }> {
  let started = false;
  if (!(await isGuiRunning())) {
    if (process.platform === "darwin" && binary.appBundle) {
      await new Promise<void>((resolve, reject) =>
        execFile("open", ["-a", binary.appBundle!], { timeout: 15000 }, (error) => (error ? reject(error) : resolve())),
      );
    } else {
      const command = slicerCommand(binary, [], "gui");
      spawn(command.file, command.args, { detached: true, stdio: "ignore" }).unref();
    }
    started = true;
    for (let waited = 0; waited < 30 && !(await isGuiRunning()); waited++) await new Promise((resolve) => setTimeout(resolve, 1000));
    // The window needs a moment after the process appears before it takes messages.
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  await new Promise<void>((resolve) => {
    const command = slicerCommand(binary, ["--single-instance", ...paths], "gui");
    execFile(command.file, command.args, { timeout: 30000 }, () => resolve());
  });
  return { started };
}

// ─── Window title → project ───────────────────────────────────

const MODEL_EXTENSIONS = [".3mf", ".stl", ".obj", ".step", ".stp", ".amf"];

/** PrusaSlicer translates "Untitled"; these are the languages it ships most often. */
const UNTITLED = /^(untitled|sans titre|naamloos|unbenannt|senza titolo|sin título|bez názvu|bez tytułu)$/i;

export interface TitleInfo {
  /** Project or file name as shown, or null for an untitled project. */
  name: string | null;
  /** The title starts with "*": unsaved changes. */
  modified: boolean;
}

/**
 *   "name - PrusaSlicer-2.9.7 based on Slic3r"
 *   "*name - PrusaSlicer-2.9.7 gebaseerd op Slic3r"   (modified)
 *   "PrusaSlicer-2.9.7 based on Slic3r"                (empty plater)
 * 3MF projects show without extension; an imported model may show with it.
 */
export function parseWindowTitle(title: string): TitleInfo {
  const dash = title.indexOf(" - PrusaSlicer");
  if (dash === -1) return { name: null, modified: false };
  let name = title.slice(0, dash).trim();
  const modified = name.startsWith("*");
  if (modified) name = name.slice(1).trim();
  if (!name || UNTITLED.test(name)) return { name: null, modified };
  return { name, modified };
}

/** Recent projects are full paths, so a name match needs no directory guessing. Most recent first. */
export function matchRecentProjects(name: string, recentProjects: string[]): string[] {
  const wanted = name.toLowerCase();
  return recentProjects.filter((path) => {
    const file = basename(path).toLowerCase();
    const ext = extname(file);
    const bare = MODEL_EXTENSIONS.includes(ext) ? file.slice(0, -ext.length) : file;
    return file === wanted || bare === wanted;
  });
}
