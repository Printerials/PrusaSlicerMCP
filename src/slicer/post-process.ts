import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import type { FlatConfig } from "../formats/ini.ts";

/**
 * Post-processing scripts, run as PrusaSlicer 2.9.7 runs them (source GCode/PostProcessor.cpp,
 * POSIX; behaviour measured 2026-11-23 with its CLI):
 * - post_process holds scripts; each item is split into lines, every line trimmed, empty ones left
 *   out, and each runs in order as `$SHELL -c "<script> '<G-code>'"` (/bin/sh without SHELL): the
 *   script's own arguments split by the shell, the G-code's path last, quoted.
 * - The environment gets every setting as SLIC3R_<KEY> (the key in capitals, the value as text),
 *   SLIC3R_PP_HOST=File and SLIC3R_PP_OUTPUT_NAME, the G-code's path.
 * - The script changes the G-code in place. A non-zero exit fails ("Post-processing script <s> on
 *   file <g> failed. Error code: <n>", then the script's stderr); so does a G-code that is gone.
 * - A script may write <G-code>.output_name with a new name. The CLI removes that file and keeps
 *   the name (measured); so does this.
 * 3.0.0-alpha14's CLI asks for confirmation and then runs no script at all, so for 3.x this server
 * runs them itself.
 */

/** The scripts in a post_process value: a list or one text, as 2.9.7 splits them. */
export function scriptsOf(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return items.flatMap((item) => String(item).split(/[\r\n]+/)).map((line) => line.trim()).filter(Boolean);
}

/** 2.9's own report of a failed script, from its log; null when none failed. */
export function scriptFailure(log: string): string | null {
  const match = /Post-processing script [\s\S]*? failed\.\s*\nError code: -?\d+(?:\s*\nOutput:\s*\n[\s\S]*?(?=\n\[\d{4}-|\n\d+ => |$))?/.exec(log);
  return match ? match[0].trim() : null;
}

export interface PostProcessResult {
  scripts: string[];
  /** What a script wrote to <G-code>.output_name; not applied. */
  renameAsked: string | null;
}

export async function runPostProcess(
  scripts: string[],
  gcode: string,
  config: FlatConfig,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<PostProcessResult> {
  if (process.platform === "win32") {
    throw new Error("Running post-processing scripts for PrusaSlicer 3.x is done on macOS and Linux; on Windows it is not implemented.");
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of config) {
    // A setting of a named box ("name.key") has no environment name in 2.x.
    if (!key.includes(".")) env[`SLIC3R_${key.toUpperCase()}`] = value;
  }
  env.SLIC3R_PP_HOST = "File";
  env.SLIC3R_PP_OUTPUT_NAME = gcode;
  const outputName = `${gcode}.output_name`;
  await rm(outputName, { force: true });

  for (const script of scripts) {
    const { code, stderr } = await runScript(script, gcode, env, options);
    if (code !== 0) {
      throw new Error(`Post-processing script ${script} on file ${gcode} failed.\nError code: ${code}${stderr.trim() ? `\nOutput:\n${stderr.trim()}` : ""}`);
    }
    if (!existsSync(gcode)) {
      throw new Error(
        `Post-processing script ${script} failed: it is expected to change the G-code ${gcode} in place, but the file is gone (likely saved under another name).`,
      );
    }
  }
  let renameAsked: string | null = null;
  if (existsSync(outputName)) {
    renameAsked = (await readFile(outputName, "utf8")).split(/\r?\n/)[0]!.trim() || null;
    await rm(outputName, { force: true });
  }
  return { scripts, renameAsked };
}

/** One script through the user's shell. Its stdout is kept off this server's own (the MCP channel). */
function runScript(
  script: string,
  gcode: string,
  env: NodeJS.ProcessEnv,
  options: { timeoutMs?: number; signal?: AbortSignal },
): Promise<{ code: number | null; stderr: string }> {
  const command = `${script} '${gcode.replace(/'/g, "'\\''")}'`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SHELL || "/bin/sh", ["-c", command], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
    });
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    };
    const timer = options.timeoutMs ? setTimeout(stop, options.timeoutMs) : undefined;
    options.signal?.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve({ code: code ?? (signal ? 128 : null), stderr: signal && code === null ? `${stderr}\n(stopped by ${signal})` : stderr });
    });
  });
}
