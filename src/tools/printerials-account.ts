import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { json, tool, type ToolDeps } from "./common.ts";

export function registerPrinterialsAccount(server: McpServer, { account }: ToolDeps): void {
  tool(
    server,
    "connect_printerials",
    {
      title: "Connect a Printerials account",
      description:
        "Link this server to the user's Printerials account, so list_spools, slice with spool_id and record_spool_usage work with their shelf " +
        "without a pasted URL. Opens Printerials' sign-in in the browser and returns at once with the link (show it to the user in case no browser opened). " +
        "After the user approved, call again with wait_s, or check slicer_status. The connection is kept in the macOS Keychain and renews itself.",
      inputSchema: z.object({
        wait_s: z.number().int().min(0).max(300).default(0).describe("Wait this long for the user to finish signing in."),
        open_browser: z.boolean().default(true).describe("false: only return the link."),
        restart: z.boolean().default(false).describe("Sign in anew, also when connected (another account, or scopes declined before)."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ wait_s, open_browser, restart }) => {
      const state = await account.connect({ restart, openBrowser: open_browser, waitMs: wait_s * 1000 });
      const notes: string[] = [];
      if (state.status === "sign-in pending") notes.push("Ask the user to sign in and approve PrusaSlicer MCP in the browser, then call connect_printerials with wait_s.");
      if (state.status === "connected") {
        // The user can untick a permission on Printerials' consent page.
        if (!state.scopes.includes("shelf:read")) notes.push("Without shelf:read, list_spools, slice with spool_id and spools in create_filament_preset do not work.");
        if (!state.scopes.includes("usage:write")) notes.push("Without usage:write, record_spool_usage does not work.");
        if (process.env.SPOOLMAN_URL?.trim()) notes.push("SPOOLMAN_URL is set too and goes first: remove it from this server's environment to use this connection.");
      }
      return json({ account: account.host, ...state, notes: notes.length ? notes : undefined });
    },
  );

  tool(
    server,
    "disconnect_printerials",
    {
      title: "Disconnect the Printerials account",
      description: "Unlink the Printerials account: revokes the connection at Printerials and removes it from the Keychain. Only when the user asks for it.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => json({ account: account.host, ...(await account.disconnect()) }),
  );
}
