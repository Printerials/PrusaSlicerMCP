import { execFile, spawn } from "node:child_process";
import { basename, extname } from "node:path";
import type { LocatedBinary } from "../slicer/locate.ts";
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
  return { running: await isRunningPosix(), title: null, note: UNSUPPORTED };
}

function isRunningPosix(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("pgrep", ["-f", "prusa-slicer|PrusaSlicer"], { timeout: 3000 }, (error, stdout) => resolve(!error && stdout.trim() !== ""));
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
    const child = spawn(binary.path, ["--single-instance", ...paths], { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
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
