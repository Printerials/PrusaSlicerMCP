/**
 * The Printerials account over OAuth, end to end through an MCP client: sign-in through the
 * loopback callback, spools over the bearer API, usage, disconnect. Printerials is a fake on
 * 127.0.0.1 (test/helpers/fake-printerials.ts); the connection goes to a token file in a temp
 * directory, never to the Keychain. Needs no PrusaSlicer.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { approveInBrowser, startFakePrinterials, type FakePrinterials } from "./helpers/fake-printerials.ts";

const root = join(import.meta.dirname, "..");

describe("a Printerials account through MCP", () => {
  let dir: string;
  let fake: FakePrinterials;
  let client: Client;
  let tokenFile: string;
  const answers: string[] = [];

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("\n");
    answers.push(text);
    return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "prusaslicer-mcp-account-"));
    tokenFile = join(dir, "printerials-tokens.json");
    fake = await startFakePrinterials({ id: 1, remaining_weight: 300, filament: { id: 2, name: "PETG Black", material: "PETG", density: 1.27, diameter: 1.75 } });
    const env = { ...(process.env as Record<string, string>), PRINTERIALS_URL: fake.origin, PRINTERIALS_TOKEN_FILE: tokenFile };
    delete env.SPOOLMAN_URL;
    client = new Client({ name: "integration-printerials", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "src", "index.ts")], stderr: "ignore", cwd: root, env }));
  });

  after(async () => {
    await client?.close();
    await fake?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("not connected: the spool tools say how to connect", async () => {
    const spools = await call("list_spools");
    assert.equal(spools.isError, true);
    assert.match(spools.text, /connect_printerials/);
  });

  test("sign in, read and use a spool, disconnect", async () => {
    const pending = await call("connect_printerials", { open_browser: false });
    assert.equal(pending.isError, false, pending.text);
    assert.equal(pending.data.status, "sign-in pending");
    assert.equal(pending.data.opened_browser, false);

    const page = await approveInBrowser(pending.data.url);
    assert.equal(page.status, 200, page.html);

    const connected = await call("connect_printerials", { wait_s: 5 });
    assert.equal(connected.data.status, "connected", connected.text);
    assert.deepEqual(connected.data.scopes, ["shelf:read", "usage:write"]);
    assert.match(connected.data.stored_in, /^file /);

    const spools = await call("list_spools");
    assert.equal(spools.isError, false, spools.text);
    assert.equal(spools.data.spools[0].remaining_g, 300);
    assert.equal(spools.data.source.via, "Printerials account");

    // The hour is over: the server refreshes by itself.
    fake.expireAccessTokens();
    const used = await call("record_spool_usage", { spool_id: 1, grams: 12 });
    assert.equal(used.isError, false, used.text);
    assert.deepEqual(used.data.remaining_g, { before: 300, after: 288 });
    assert.equal(fake.refreshes, 1);
    assert.equal(fake.reuses, 0);

    // Signed in again with shelf:read unticked: usage can still be recorded, the shelf not read.
    fake.grantScope = "usage:write";
    const again = await call("connect_printerials", { open_browser: false, restart: true });
    await approveInBrowser(again.data.url);
    const partial = await call("connect_printerials", { wait_s: 5 });
    assert.deepEqual(partial.data.scopes, ["usage:write"]);
    assert.match(partial.data.notes.join(" "), /Without shelf:read/);
    const blind = await call("list_spools");
    assert.equal(blind.isError, true);
    assert.match(blind.text, /needs the Printerials permission shelf:read/);
    const recorded = await call("record_spool_usage", { spool_id: 1, grams: 8 });
    assert.equal(recorded.isError, false, recorded.text);
    // Printerials answers 204 without the spool then: weights are shelf data.
    assert.deepEqual(recorded.data.remaining_g, { before: null, after: null });
    assert.equal(fake.used.at(-1), 8);
    assert.equal(fake.revocations.length, 1, "the replaced connection was revoked");

    const stored = JSON.parse(await readFile(tokenFile, "utf8"))[fake.origin];
    const gone = await call("disconnect_printerials");
    assert.equal(gone.data.status, "disconnected", gone.text);
    assert.equal(gone.data.revoked_at_printerials, true);
    assert.equal(fake.revocations.at(-1), stored.refresh_token);

    const after = await call("list_spools");
    assert.equal(after.isError, true);

    // No answer carried a token.
    for (const text of answers) {
      for (const secret of [stored.access_token, stored.refresh_token, ...fake.bearers.filter(Boolean)]) assert.ok(!text.includes(secret), "a token was in an answer");
    }
  });
});
