import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { CaptureResult, WindowState } from "./index.ts";

/**
 * Window access on Windows through Windows PowerShell 5.1, which every Windows that runs PrusaSlicer has.
 * - Titles come from the process list: each prusa-slicer.exe (the GUI; the CLI is prusa-slicer-console.exe)
 *   with its main window. Nothing is compiled for that.
 * - A capture compiles a small C# class with Add-Type that renders one window with PrintWindow, so a
 *   window behind others comes out as it would look in front.
 * The C# source and the arguments travel in environment variables, and the command line is a fixed
 * script that reads them: no script file, no execution policy to set aside, nothing to quote.
 */

/** By full path, so no powershell.exe earlier on PATH or in the working directory is run instead. */
const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** The main window's title carries the version in every language, as on macOS: "name - PrusaSlicer-2.9.7 based on Slic3r". */
const MAIN_TITLE = /PrusaSlicer-\d/;

export interface ProcessWindow {
  pid: number;
  /** The process's main window handle; 0 while it has none (starting, or only hidden windows). */
  hwnd: number;
  title: string;
}

function powershell(script: string, env: Record<string, string>, timeout: number): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  return new Promise((resolve) => {
    execFile(
      POWERSHELL,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout, windowsHide: true, env: { ...process.env, ...env } },
      (error, stdout, stderr) => resolve({ stdout, stderr, error }),
    );
  });
}

/** The listing comes back as one line of base64 JSON: the console's code page would mangle a title with é or ü. */
const LIST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$windows = @([Diagnostics.Process]::GetProcessesByName('prusa-slicer') | ForEach-Object { @{ pid = $_.Id; hwnd = $_.MainWindowHandle.ToInt64(); title = $_.MainWindowTitle } })",
  "$json = ConvertTo-Json -InputObject $windows -Compress",
  "if (-not $json) { $json = '[]' }",
  "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))",
].join("; ");

export function decodeListing(stdout: string): ProcessWindow[] {
  const line = stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
  if (!line) return [];
  const parsed: unknown = JSON.parse(Buffer.from(line, "base64").toString("utf8"));
  return (Array.isArray(parsed) ? parsed : [parsed]) as ProcessWindow[];
}

async function listWindows(): Promise<ProcessWindow[]> {
  const { stdout, stderr, error } = await powershell(LIST_SCRIPT, {}, 10000);
  if (error) throw new Error(`PowerShell failed: ${stderr.trim() || error.message}`);
  return decodeListing(stdout);
}

/** The plater's window when one is titled as such (PrusaSlicer 2.9 and 3.0 may run side by side), else any window there is. */
export function mainWindow(windows: ProcessWindow[]): ProcessWindow | null {
  const withWindow = windows.filter((w) => w.hwnd !== 0);
  return withWindow.find((w) => MAIN_TITLE.test(w.title)) ?? withWindow[0] ?? null;
}

export async function windowState(): Promise<WindowState> {
  const windows = await listWindows();
  if (windows.length === 0) return { running: false, title: null };
  const main = mainWindow(windows);
  return { running: true, title: main && MAIN_TITLE.test(main.title) ? main.title : null };
}

/**
 * C# 5: Windows PowerShell 5.1 compiles Add-Type with the .NET Framework compiler. Returns "OK" or why not.
 * - The thread is made per-monitor DPI aware first, so the window's rectangle is in physical pixels, the
 *   size PrintWindow draws at, also on a scaled display. Windows before 10 1607 lack the call; there
 *   the rectangle is what the process gets.
 * - PW_RENDERFULLCONTENT (2) includes what the GPU draws: the 3D scene.
 * - The image is cut to the frame DWM draws (DWMWA_EXTENDED_FRAME_BOUNDS), without the invisible
 *   resize border that GetWindowRect counts in.
 */
const CAPTURE_SOURCE = `
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace PrusaSlicerMcp {
  public static class WindowImage {
    [StructLayout(LayoutKind.Sequential)]
    private struct Box { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Box box);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Box box, int size);

    private const uint PW_RENDERFULLCONTENT = 2;
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private static readonly IntPtr PER_MONITOR_AWARE_V2 = new IntPtr(-4);

    private static IntPtr SetDpiContext(IntPtr context) {
      try { return SetThreadDpiAwarenessContext(context); }
      catch (EntryPointNotFoundException) { return IntPtr.Zero; }
    }

    public static string Save(long handle, string path, int maxEdge) {
      IntPtr window = new IntPtr(handle);
      if (!IsWindow(window)) return "closed";
      if (IsIconic(window)) return "minimized";
      IntPtr previous = SetDpiContext(PER_MONITOR_AWARE_V2);
      try {
        Box outer;
        if (!GetWindowRect(window, out outer)) return "closed";
        int width = outer.Right - outer.Left, height = outer.Bottom - outer.Top;
        if (width <= 0 || height <= 0) return "empty";

        Rectangle whole = new Rectangle(0, 0, width, height);
        Rectangle frame = whole;
        Box drawn;
        if (DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, out drawn, Marshal.SizeOf(typeof(Box))) == 0) {
          Rectangle inside = Rectangle.Intersect(whole, new Rectangle(drawn.Left - outer.Left, drawn.Top - outer.Top, drawn.Right - drawn.Left, drawn.Bottom - drawn.Top));
          if (inside.Width > 0 && inside.Height > 0) frame = inside;
        }

        using (Bitmap full = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
          using (Graphics canvas = Graphics.FromImage(full)) {
            IntPtr dc = canvas.GetHdc();
            bool printed;
            try { printed = PrintWindow(window, dc, PW_RENDERFULLCONTENT); }
            finally { canvas.ReleaseHdc(dc); }
            if (!printed) return "not drawn";
          }
          double scale = Math.Min(1.0, (double)maxEdge / Math.Max(frame.Width, frame.Height));
          int outWidth = Math.Max(1, (int)Math.Round(frame.Width * scale));
          int outHeight = Math.Max(1, (int)Math.Round(frame.Height * scale));
          using (Bitmap result = new Bitmap(outWidth, outHeight, PixelFormat.Format24bppRgb)) {
            using (Graphics canvas = Graphics.FromImage(result)) {
              canvas.InterpolationMode = InterpolationMode.HighQualityBicubic;
              canvas.PixelOffsetMode = PixelOffsetMode.HighQuality;
              canvas.DrawImage(full, new Rectangle(0, 0, outWidth, outHeight), frame, GraphicsUnit.Pixel);
            }
            result.Save(path, ImageFormat.Png);
          }
        }
        return "OK";
      } finally {
        if (previous != IntPtr.Zero) SetDpiContext(previous);
      }
    }
  }
}
`;

const CAPTURE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition $env:PRUSASLICER_MCP_CAPTURE_SOURCE -ReferencedAssemblies System.Drawing",
  "[PrusaSlicerMcp.WindowImage]::Save([long]$env:PRUSASLICER_MCP_CAPTURE_WINDOW, $env:PRUSASLICER_MCP_CAPTURE_PATH, [int]$env:PRUSASLICER_MCP_CAPTURE_MAX_EDGE)",
].join("; ");

const CAPTURE_FAILURES: Record<string, string> = {
  closed: "The PrusaSlicer window closed during the capture.",
  minimized: "The PrusaSlicer window is minimized. Restore it (it may stay behind other windows) and try again.",
  empty: "The PrusaSlicer window has no size.",
  "not drawn": "Windows did not render the PrusaSlicer window (PrintWindow failed).",
};

export async function capture(outputPath: string, maxEdge: number): Promise<CaptureResult> {
  const windows = await listWindows();
  if (windows.length === 0) return { ok: false, reason: "PrusaSlicer is not running." };
  const main = mainWindow(windows);
  if (!main) return { ok: false, reason: "PrusaSlicer runs but shows no window yet." };
  const { stdout, stderr, error } = await powershell(
    CAPTURE_SCRIPT,
    {
      PRUSASLICER_MCP_CAPTURE_SOURCE: CAPTURE_SOURCE,
      PRUSASLICER_MCP_CAPTURE_WINDOW: String(main.hwnd),
      PRUSASLICER_MCP_CAPTURE_PATH: outputPath,
      PRUSASLICER_MCP_CAPTURE_MAX_EDGE: String(maxEdge),
    },
    30000,
  );
  const verdict = stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
  if (verdict !== "OK") {
    return { ok: false, reason: CAPTURE_FAILURES[verdict] ?? `Capture failed: ${stderr.trim() || error?.message || verdict || "no output"}` };
  }
  const size = await stat(outputPath).then((info) => info.size, () => 0);
  return size > 0 ? { ok: true } : { ok: false, reason: "Capture failed: no image written." };
}
