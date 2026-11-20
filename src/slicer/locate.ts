import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/** On macOS the CLI is the app binary itself; it only opens the GUI when no action is given. */
const MAC_APP_BINARY = join("Contents", "MacOS", "PrusaSlicer");

/** Flathub's PrusaSlicer, the build Prusa points Linux users to (2.9.7 has no AppImage on GitHub). */
export const FLATPAK_ID = "com.prusa3d.PrusaSlicer";

export interface FlatpakApp {
  id: string;
  /** The installed app's /app on the host (…/app/<id>/current/active/files); share/PrusaSlicer/profiles is in it. */
  files: string;
}

export interface LocatedBinary {
  /** The executable to run: PrusaSlicer itself, or flatpak for a Flatpak. slicerCommand builds the arguments. */
  path: string;
  /** The .app bundle on macOS, used to open files through Launch Services. */
  appBundle: string | null;
  /** PrusaSlicer installed as a Flatpak. */
  flatpak: FlatpakApp | null;
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
    return existsSync(binary) ? { path: binary, appBundle: trimmed, flatpak: null } : null;
  }
  const bundle = trimmed.endsWith(MAC_APP_BINARY) ? trimmed.slice(0, -MAC_APP_BINARY.length - 1) : null;
  return { path: trimmed, appBundle: bundle && bundle.endsWith(".app") ? bundle : null, flatpak: null };
}

function which(name: string): string | null {
  try {
    const first = execFileSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8", timeout: 5000 })
      .trim()
      .split(/\r?\n/)[0];
    return first && existsSync(first) ? first : null;
  } catch {
    return null; // not on PATH under this name
  }
}

function onPath(): string | null {
  const names = process.platform === "win32" ? ["prusa-slicer-console.exe"] : ["prusa-slicer", "PrusaSlicer"];
  for (const name of names) {
    const found = which(name);
    if (found) return found;
  }
  return null;
}

/** The per-user and the system-wide Flatpak installation, in the order flatpak itself prefers them. */
export function flatpakInstallations(): string[] {
  return [join(homedir(), ".local", "share", "flatpak"), "/var/lib/flatpak"];
}

/** A Flatpak of PrusaSlicer in one of the installations, run through the given flatpak binary. */
export function locateFlatpak(flatpak: string | null, installations: string[], id = FLATPAK_ID): Omit<LocatedBinary, "source"> | null {
  if (!flatpak) return null;
  for (const installation of installations) {
    const files = join(installation, "app", id, "current", "active", "files");
    if (existsSync(join(files, "bin", "prusa-slicer"))) return { path: flatpak, appBundle: null, flatpak: { id, files } };
  }
  return null;
}

export function locateSlicer(env: NodeJS.ProcessEnv = process.env): LocatedBinary | { error: string } {
  const configured = env.PRUSASLICER_PATH;
  if (configured) {
    // The Flatpak's id, or the launcher flatpak exports for it (…/exports/bin/com.prusa3d.PrusaSlicer).
    if (basename(configured) === FLATPAK_ID) {
      const found = locateFlatpak(which("flatpak"), flatpakInstallations());
      if (found) return { ...found, source: "env" };
      return { error: `PRUSASLICER_PATH names the Flatpak ${FLATPAK_ID}, which is not installed (or flatpak is not on PATH).` };
    }
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
  if (process.platform === "linux") {
    const found = locateFlatpak(which("flatpak"), flatpakInstallations());
    if (found) return { ...found, source: "default" };
  }
  return {
    error:
      "PrusaSlicer was not found in the standard locations, on PATH or as a Flatpak. " +
      `Set PRUSASLICER_PATH to the PrusaSlicer.app bundle (macOS), prusa-slicer-console.exe (Windows), the binary or ${FLATPAK_ID} (Linux).`,
  };
}

/**
 * The process to start for PrusaSlicer with these arguments.
 *
 * A Flatpak (Flathub's 2.9.7, measured 2026-11-20 on aarch64):
 * - The CLI runs prusa-slicer itself. The app's own command is an entrypoint script that starts
 *   PrusaSlicer in the background and prints a banner first, so its output and exit code are not
 *   PrusaSlicer's. The GUI goes through the entrypoint, as the desktop file does.
 * - The sandbox sees the home directory (--filesystem=home) and has a /tmp of its own: a file in
 *   /tmp gave "No such file". Every other directory an argument names is added for this run with
 *   --filesystem. A path with ":" cannot be given that way (flatpak reads ":ro" and the like after
 *   it) and is left to fail.
 * - The environment and stdin reach PrusaSlicer. flatpak becomes the sandbox's bwrap, and
 *   PrusaSlicer stops with it on SIGTERM.
 */
export function slicerCommand(binary: LocatedBinary, args: string[], entry: "cli" | "gui" = "cli"): { file: string; args: string[] } {
  if (!binary.flatpak) return { file: binary.path, args };
  const filesystems = sandboxDirectories(args).map((dir) => `--filesystem=${dir}`);
  const command = entry === "cli" ? ["--command=prusa-slicer"] : [];
  return { file: binary.path, args: ["run", ...filesystems, ...command, binary.flatpak.id, ...args] };
}

/** Directories outside the home directory that the arguments name: an existing directory itself, else the parent. */
export function sandboxDirectories(args: string[], home = homedir()): string[] {
  const dirs = new Set<string>();
  for (const arg of args) {
    if (!isAbsolute(arg) || arg.includes(":")) continue;
    const dir = existsSync(arg) && statSync(arg).isDirectory() ? arg : dirname(arg);
    const inside = relative(home, dir);
    if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) continue;
    dirs.add(dir.replace(new RegExp(`\\${sep}+$`), "") || sep);
  }
  return [...dirs];
}

/** Where PrusaSlicer's config home is (its XDG_CONFIG_HOME on Linux): a Flatpak keeps its own under ~/.var/app. */
export function linuxConfigHome(binary: LocatedBinary | null): string {
  if (binary?.flatpak) return join(homedir(), ".var", "app", binary.flatpak.id, "config");
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}
