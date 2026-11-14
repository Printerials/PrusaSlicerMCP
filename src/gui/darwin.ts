import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import type { CaptureResult, WindowState } from "./index.ts";

/**
 * Window access on macOS without compiling anything: JXA (ships with macOS) reads
 * CGWindowListCopyWindowInfo, screencapture -l grabs one window, sips downsizes the Retina capture.
 * Without Screen Recording permission for the host app, macOS returns empty titles for other
 * apps' windows; an empty title on every PrusaSlicer window therefore means: no permission.
 */

const OWNER = "PrusaSlicer";

/** The main window's title carries the version in every language: "name - PrusaSlicer-2.9.7 based on Slic3r". */
const MAIN_TITLE = /PrusaSlicer-\d/;

export const PERMISSION_HINT =
  "macOS hides other apps' window titles and contents without Screen Recording permission. " +
  "Grant it to the app that runs this MCP server (Claude Desktop, Terminal, VS Code...) in " +
  "System Settings > Privacy & Security > Screen & System Audio Recording, then restart that app.";

const LIST_WINDOWS_JXA = `
ObjC.import("CoreGraphics");
const raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
const list = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];
JSON.stringify(list
  .filter(w => w.kCGWindowOwnerName === ${JSON.stringify(OWNER)} && w.kCGWindowLayer === 0)
  .map(w => ({
    id: w.kCGWindowNumber,
    title: w.kCGWindowName || "",
    onscreen: !!w.kCGWindowIsOnscreen,
    area: w.kCGWindowBounds ? w.kCGWindowBounds.Width * w.kCGWindowBounds.Height : 0,
  })));
`;

interface MacWindow {
  id: number;
  title: string;
  onscreen: boolean;
  area: number;
}

function run(command: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout }, (error, stdout, stderr) => resolve({ stdout, stderr, error }));
  });
}

async function listWindows(): Promise<MacWindow[]> {
  const { stdout, stderr, error } = await run("osascript", ["-l", "JavaScript", "-e", LIST_WINDOWS_JXA], 5000);
  if (error) throw new Error(`osascript failed: ${stderr.trim() || error.message}`);
  return JSON.parse(stdout.trim()) as MacWindow[];
}

async function mainWindow(): Promise<{ window: MacWindow; titlesVisible: boolean } | null> {
  const windows = (await listWindows()).filter((w) => w.area > 0);
  if (windows.length === 0) return null;
  const titlesVisible = windows.some((w) => w.title !== "");
  const titled = windows.filter((w) => MAIN_TITLE.test(w.title));
  const pool = titled.length > 0 ? titled : windows;
  // A visible window first, then the largest (the plater, not a dialog).
  pool.sort((a, b) => Number(b.onscreen) - Number(a.onscreen) || b.area - a.area);
  return { window: pool[0]!, titlesVisible };
}

export async function windowState(): Promise<WindowState> {
  const main = await mainWindow();
  if (!main) return { running: false, title: null };
  if (!main.titlesVisible) return { running: true, title: null, note: PERMISSION_HINT };
  return { running: true, title: MAIN_TITLE.test(main.window.title) ? main.window.title : null };
}

export async function capture(outputPath: string, maxEdge: number): Promise<CaptureResult> {
  const main = await mainWindow();
  if (!main) return { ok: false, reason: "PrusaSlicer is not running." };
  // -l: that one window, also behind others. -o: no shadow. -x: no sound.
  const shot = await run("screencapture", ["-x", "-o", "-t", "png", "-l", String(main.window.id), outputPath], 15000);
  const size = await stat(outputPath).then((info) => info.size, () => 0);
  if (shot.error || size === 0) {
    const detail = shot.stderr.trim() || shot.error?.message || "no image written";
    const hint = main.titlesVisible ? "Is the PrusaSlicer window minimized?" : PERMISSION_HINT;
    return { ok: false, reason: `screencapture failed (${detail}). ${hint}` };
  }
  // Downscaling is best effort; the full-size capture is still a valid result.
  await run("sips", ["-Z", String(maxEdge), outputPath, "--out", outputPath], 15000);
  return { ok: true };
}
