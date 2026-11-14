import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** On macOS the CLI is the app binary itself; it only opens the GUI when no action is given. */
const MAC_APP_BINARY = join("Contents", "MacOS", "PrusaSlicer");

export interface LocatedBinary {
  /** The executable to run. */
  path: string;
  /** The .app bundle on macOS, used to open files through Launch Services. */
  appBundle: string | null;
  source: "env" | "default" | "path";
}

function candidates(): string[] {
  switch (process.platform) {
    case "darwin":
      return [
        "/Applications/PrusaSlicer.app",
        // The Prusa installer for drivers puts the app in a folder of its own.
        "/Applications/Original Prusa Drivers/PrusaSlicer.app",
        join(homedir(), "Applications", "PrusaSlicer.app"),
      ];
    case "win32": {
      const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(
        (dir): dir is string => Boolean(dir),
      );
      return programFiles.map((dir) => join(dir, "Prusa3D", "PrusaSlicer", "prusa-slicer-console.exe"));
    }
    default:
      return [];
  }
}

/** Accepts the .app bundle as well as the binary inside it. */
function resolve(path: string): Omit<LocatedBinary, "source"> | null {
  if (!existsSync(path)) return null;
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed.endsWith(".app") && statSync(trimmed).isDirectory()) {
    const binary = join(trimmed, MAC_APP_BINARY);
    return existsSync(binary) ? { path: binary, appBundle: trimmed } : null;
  }
  const bundle = trimmed.endsWith(MAC_APP_BINARY) ? trimmed.slice(0, -MAC_APP_BINARY.length - 1) : null;
  return { path: trimmed, appBundle: bundle && bundle.endsWith(".app") ? bundle : null };
}

function onPath(): string | null {
  const [command, names] =
    process.platform === "win32"
      ? ["where", ["prusa-slicer-console.exe"]]
      : ["which", ["prusa-slicer", "PrusaSlicer"]];
  for (const name of names) {
    try {
      const first = execFileSync(command, [name], { encoding: "utf8", timeout: 5000 }).trim().split(/\r?\n/)[0];
      if (first && existsSync(first)) return first;
    } catch {
      // not on PATH under this name
    }
  }
  return null;
}

export function locateSlicer(env: NodeJS.ProcessEnv = process.env): LocatedBinary | { error: string } {
  const configured = env.PRUSASLICER_PATH;
  if (configured) {
    const found = resolve(configured);
    if (found) return { ...found, source: "env" };
    return { error: `PRUSASLICER_PATH points to ${configured}, which is not a PrusaSlicer binary or app bundle.` };
  }
  for (const candidate of candidates()) {
    const found = resolve(candidate);
    if (found) return { ...found, source: "default" };
  }
  const fromPath = onPath();
  if (fromPath) {
    const found = resolve(fromPath);
    if (found) return { ...found, source: "path" };
  }
  return {
    error:
      "PrusaSlicer was not found in the standard locations or on PATH. " +
      "Set PRUSASLICER_PATH to the PrusaSlicer.app bundle (macOS), prusa-slicer-console.exe (Windows) or the binary (Linux).",
  };
}
