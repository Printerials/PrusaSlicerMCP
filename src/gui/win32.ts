import { execFile } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureResult, WindowState } from "./index.ts";

/** Window access on Windows through PowerShell; the GUI process is prusa-slicer.exe. */

function run(args: string[], timeout: number): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  return new Promise((resolve) => {
    execFile("powershell", args, { timeout, windowsHide: true }, (error, stdout, stderr) => resolve({ stdout, stderr, error }));
  });
}

export async function windowState(): Promise<WindowState> {
  const { stdout } = await run(
    [
      "-NoProfile",
      "-Command",
      "Get-Process -Name 'prusa-slicer' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty MainWindowTitle",
    ],
    5000,
  );
  const title = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  return { running: title !== null, title };
}

/** PrintWindow captures the window also when it is behind others. */
const CAPTURE_SCRIPT = `
param([string]$out, [int]$maxEdge)
Add-Type -AssemblyName System.Drawing
$proc = Get-Process -Name 'prusa-slicer' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Error "NOT_RUNNING"; exit 1 }
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class WindowCapture {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public static Bitmap Capture(IntPtr hwnd) {
        RECT r; GetWindowRect(hwnd, out r);
        int w = r.Right - r.Left, h = r.Bottom - r.Top;
        Bitmap bmp = new Bitmap(Math.Max(w, 1), Math.Max(h, 1));
        using (Graphics g = Graphics.FromImage(bmp)) { IntPtr hdc = g.GetHdc(); PrintWindow(hwnd, hdc, 2); g.ReleaseHdc(hdc); }
        return bmp;
    }
}
'@
$bmp = [WindowCapture]::Capture($proc.MainWindowHandle)
$scale = [Math]::Min(1.0, $maxEdge / [Math]::Max($bmp.Width, $bmp.Height))
if ($scale -lt 1.0) {
    $small = New-Object System.Drawing.Bitmap ([int]($bmp.Width * $scale)), ([int]($bmp.Height * $scale))
    $g = [System.Drawing.Graphics]::FromImage($small)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($bmp, 0, 0, $small.Width, $small.Height)
    $g.Dispose(); $bmp.Dispose(); $bmp = $small
}
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "OK"
`;

export async function capture(outputPath: string, maxEdge: number): Promise<CaptureResult> {
  const script = join(tmpdir(), `prusaslicer-mcp-capture-${process.pid}-${Date.now()}.ps1`);
  await writeFile(script, CAPTURE_SCRIPT, "utf8");
  try {
    const { stdout, stderr, error } = await run(
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, outputPath, String(maxEdge)],
      20000,
    );
    if (stderr.includes("NOT_RUNNING")) return { ok: false, reason: "PrusaSlicer is not running." };
    if (error || !stdout.includes("OK")) return { ok: false, reason: `Capture failed: ${stderr.trim() || error?.message || "unknown error"}` };
    return { ok: true };
  } finally {
    await unlink(script).catch(() => undefined);
  }
}
