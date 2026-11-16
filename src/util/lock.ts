import { mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Runs fn while holding a lock file, across processes: creating with O_EXCL is atomic on a local
 * file system. A lock older than staleMs is taken to be left by a process that died; fn must
 * finish well within that.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, { staleMs = 30_000, timeoutMs = 45_000 } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(path).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > staleMs) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Another process has held ${path} for too long.`);
      await sleep(25 + Math.random() * 75);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(path).catch(() => undefined);
  }
}
