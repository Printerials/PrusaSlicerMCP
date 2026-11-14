import { constants } from "node:fs";
import { access, mkdtemp, rename, rm, stat, copyFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { Refusal } from "./errors.ts";

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/** PRUSASLICER_MCP_ROOTS: directories the server may read from and write to. Unset means anywhere. */
export function allowedRoots(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env.PRUSASLICER_MCP_ROOTS;
  if (!raw) return null;
  return raw
    .split(delimiter)
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => resolve(expandHome(root)));
}

function checkRoots(path: string): void {
  const roots = allowedRoots();
  if (!roots) return;
  const inside = roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));
  if (!inside) throw new Refusal(`${path} is outside the directories this server may use (PRUSASLICER_MCP_ROOTS: ${roots.join(", ")}).`);
}

function permissionHint(path: string): string {
  if (process.platform !== "darwin") return `No permission to read ${path}.`;
  return (
    `macOS denies access to ${path} for the app that runs this server (Downloads, Documents and Desktop are protected). ` +
    "Grant that app access under System Settings > Privacy & Security > Files and Folders (or Full Disk Access), then restart it, or move the file to another directory."
  );
}

/** An absolute path to an existing, readable file with one of the given extensions. */
export async function requireFile(input: string, extensions?: string[]): Promise<string> {
  const expanded = expandHome(input.trim());
  if (!isAbsolute(expanded)) throw new Refusal(`Give an absolute path, not "${input}".`);
  const path = resolve(expanded);
  checkRoots(path);
  if (extensions && !extensions.includes(extname(path).toLowerCase())) {
    throw new Refusal(`${basename(path)} is not one of ${extensions.join(", ")}.`);
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Refusal(`${path} is not a file.`);
    await access(path, constants.R_OK);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Refusal(`${path} does not exist.`);
    if (code === "EPERM" || code === "EACCES") throw new Refusal(permissionHint(path));
    throw error;
  }
  return path;
}

/** An absolute directory for output, checked against the roots. It must exist. */
export async function requireDirectory(input: string): Promise<string> {
  const expanded = expandHome(input.trim());
  if (!isAbsolute(expanded)) throw new Refusal(`Give an absolute path, not "${input}".`);
  const path = resolve(expanded);
  checkRoots(path);
  try {
    if (!(await stat(path)).isDirectory()) throw new Refusal(`${path} is not a directory.`);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Refusal(`${path} does not exist.`);
    if (code === "EPERM" || code === "EACCES") throw new Refusal(permissionHint(path));
    throw error;
  }
  return path;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where an output goes. An explicit path is taken as given (absolute, inside the roots);
 * otherwise the file lands next to the input under the name the caller proposes.
 */
export async function outputTarget(explicit: string | undefined, fallbackDir: string, fallbackName: string) {
  if (explicit) {
    const expanded = expandHome(explicit.trim());
    if (!isAbsolute(expanded)) throw new Refusal(`Give an absolute output path, not "${explicit}".`);
    const path = resolve(expanded);
    checkRoots(path);
    await requireDirectory(dirname(path));
    return path;
  }
  return join(await requireDirectory(fallbackDir), fallbackName);
}

/**
 * A scratch directory next to the destination, so PrusaSlicer never writes over an existing file
 * and the result is moved in place with a rename on the same volume.
 */
export async function withStaging<T>(destDir: string, fn: (dir: string) => Promise<T>): Promise<T> {
  let dir: string;
  try {
    dir = await mkdtemp(join(destDir, ".prusaslicer-mcp-"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "EROFS") {
      throw new Refusal(`Cannot write to ${destDir}. ${code === "EROFS" ? "It is read-only." : permissionHint(destDir)}`);
    }
    throw error;
  }
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Moves a staged file to its destination; refuses to replace a file unless overwrite is set. */
export async function commitFile(staged: string, destination: string, overwrite: boolean): Promise<void> {
  if (!overwrite && (await exists(destination))) {
    throw new Refusal(`${destination} already exists. Pass overwrite: true to replace it, or choose another output path.`);
  }
  try {
    await rename(staged, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(staged, destination);
    await unlink(staged);
  }
}

/** "model.stl" -> "model" */
export function stem(path: string): string {
  const name = basename(path);
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}
