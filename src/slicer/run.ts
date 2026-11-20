import { spawn } from "node:child_process";

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Written to stdin, which is then closed. Without it stdin is closed at once, so a prompt reads EOF. */
  stdin?: string;
  /** Progress lines on stdout, "45 => Making infill". */
  onProgress?: (percent: number, message: string) => void;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

const MAX_OUTPUT = 32 * 1024 * 1024;

/** PIDs of the PrusaSlicer processes this server runs, so a check for the GUI can leave them out. */
export const activePids = new Set<number>();
const PROGRESS_LINE = /^(\d{1,3}) => (.+)$/;

/**
 * Runs PrusaSlicer without a shell. Arguments go to the process as they are, so file names with
 * spaces or quotes need no escaping. The exit code is reported but not trusted: several CLI
 * failures in 2.9 and 3.0 exit with 0, so callers check for the output they expect.
 */
export function runSlicer(binary: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // --loglevel takes effect only after a few lines are logged; SLIC3R_LOGLEVEL holds from the
    // start (3.0.0-alpha14 printed two [info] lines on stdout otherwise).
    const level = args[args.lastIndexOf("--loglevel") + 1];
    const env = args.includes("--loglevel") && level ? { ...process.env, SLIC3R_LOGLEVEL: level } : process.env;
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
    const pid = child.pid;
    if (pid !== undefined) activePids.add(pid);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outSize = 0;
    let errSize = 0;
    let pending = "";
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const stop = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      killTimer.unref();
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, options.timeoutMs)
      : undefined;

    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (outSize < MAX_OUTPUT) out.push(chunk);
      outSize += chunk.length;
      if (!options.onProgress) return;
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const match = PROGRESS_LINE.exec(line.trim());
        if (match) options.onProgress(Number(match[1]), match[2] ?? "");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errSize < MAX_OUTPUT) err.push(chunk);
      errSize += chunk.length;
    });

    child.on("error", (error) => {
      if (pid !== undefined) activePids.delete(pid);
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (pid !== undefined) activePids.delete(pid);
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        aborted,
      });
    });

    child.stdin.on("error", () => {
      // The process may exit before reading stdin; that is not an error of ours.
    });
    child.stdin.end(options.stdin ?? "");
  });
}

/** One readable reason for a failed run, for the model and for the logs. */
/** crashHint replaces the usual guess at why PrusaSlicer crashed, when the caller knows better. */
export function describeFailure(result: RunResult, what: string, crashHint?: string): string {
  if (result.aborted) return `${what} was cancelled.`;
  if (result.timedOut) return `${what} timed out. Raise PRUSASLICER_MCP_TIMEOUT_MS for large models.`;
  const crashed = result.signal === "SIGSEGV" || result.exitCode === 139 || result.exitCode === -1073741819;
  const stderr = result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-15).join("\n");
  if (crashed) {
    return (
      `${what} failed: PrusaSlicer crashed (segmentation fault). ` +
      (crashHint ?? "PrusaSlicer 2.9 does this when the printer preset does not exist or when the preset set is incomplete.") +
      (stderr ? `\n${stderr}` : "")
    );
  }
  if (!result.signal && result.exitCode === 0) {
    // PrusaSlicer reports several failures (objects outside the print volume, ...) with exit code 0.
    return `${what} produced no output.${stderr ? `\n${stderr}` : " PrusaSlicer gave no reason."}`;
  }
  const code = result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode}`;
  return `${what} failed (${code}).${stderr ? `\n${stderr}` : " PrusaSlicer gave no error message."}`;
}
