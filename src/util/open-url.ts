import { execFile } from "node:child_process";

/** Opens an http(s) URL in the default browser; false when that could not be done. */
export function openUrl(url: string): Promise<boolean> {
  if (!/^https?:\/\//.test(url)) return Promise.resolve(false);
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? // Not "start" through cmd.exe, which splits the URL at every &.
          ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000 }, (error) => resolve(!error));
  });
}
