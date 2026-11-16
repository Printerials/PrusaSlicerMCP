import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { PrinterialsAccount } from "../../src/printerials/account.ts";
import { challengeOf } from "../../src/printerials/oauth.ts";
import { FileTokenStore } from "../../src/printerials/token-store.ts";
import { SpoolmanClient } from "../../src/spoolman/client.ts";
import { Refusal } from "../../src/util/errors.ts";
import { withFileLock } from "../../src/util/lock.ts";
import { approveInBrowser, startFakePrinterials, type FakePrinterials } from "../helpers/fake-printerials.ts";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "prusaslicer-mcp-oauth-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("PKCE S256: RFC 7636 appendix B", () => {
  assert.equal(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("the token file: per origin, mode 0600", async () => {
  const path = join(dir, "tokens.json");
  const a = new FileTokenStore(path, "https://a.test");
  const b = new FileTokenStore(path, "https://b.test");
  const tokens = { access_token: "at", expires_at: 1, refresh_token: "rt", scope: "shelf:read", connected_at: "2026-11-16T00:00:00.000Z" };
  await a.write(tokens);
  await b.write({ ...tokens, refresh_token: "rt-b" });
  assert.deepEqual(await a.read(), tokens);
  assert.equal((await b.read())?.refresh_token, "rt-b");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await a.delete();
  assert.equal(await a.read(), null);
  assert.equal((await b.read())?.refresh_token, "rt-b");
});

test("the lock file lets one holder in at a time", async () => {
  const path = join(dir, "x.lock");
  let inside = 0;
  let most = 0;
  await Promise.all(
    Array.from({ length: 5 }, () =>
      withFileLock(path, async () => {
        most = Math.max(most, ++inside);
        await sleep(10);
        inside--;
      }),
    ),
  );
  assert.equal(most, 1);
});

describe("a Printerials account over OAuth", () => {
  let fake: FakePrinterials;
  let store: FileTokenStore;
  let opened: string[];
  let account: PrinterialsAccount;
  const spool = () => ({ id: 1, remaining_weight: 500, filament: { id: 2, name: "PETG Black", material: "PETG", density: 1.27, diameter: 1.75 } });
  const make = () => new PrinterialsAccount({ base: fake.origin, store, open: async (url) => (opened.push(url), true) });

  beforeEach(async () => {
    await fake?.close();
    fake = await startFakePrinterials(spool());
    store = new FileTokenStore(join(dir, `tokens-${Date.now()}-${Math.random()}.json`), fake.origin);
    opened = [];
    account = make();
  });
  after(() => fake?.close());

  const signIn = async (target = account) => {
    const pending = await target.connect();
    assert.equal(pending.status, "sign-in pending");
    const page = await approveInBrowser((pending as { url: string }).url);
    assert.equal(page.status, 200, page.html);
    assert.match(page.html, /connected to your Printerials account/);
  };

  test("sign-in: the browser opens on a PKCE link, the callback stores the connection", async () => {
    const pending = await account.connect();
    assert.equal(pending.status, "sign-in pending");
    assert.equal(pending.opened_browser, true);
    const link = new URL(opened[0]!);
    assert.equal(link.origin + link.pathname, `${fake.origin}/oauth/authorize`);
    assert.equal(link.searchParams.get("client_id"), "prusaslicer-mcp");
    assert.equal(link.searchParams.get("scope"), "shelf:read usage:write");
    assert.equal(link.searchParams.get("code_challenge_method"), "S256");
    assert.match(link.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    // Asking again while it is pending gives the same link and opens no second window.
    const again = await account.connect();
    assert.equal((again as { url: string }).url, opened[0]);
    assert.equal(opened.length, 1);

    // A request with another state is not this sign-in's: refused, and the sign-in goes on.
    const stray = new URL(link.searchParams.get("redirect_uri")!);
    stray.searchParams.set("state", "forged");
    stray.searchParams.set("code", "x");
    assert.equal((await fetch(stray)).status, 400);

    await approveInBrowser(opened[0]!);
    const connected = await account.connect({ waitMs: 1000 });
    assert.equal(connected.status, "connected");
    assert.deepEqual((connected as { scopes: string[] }).scopes, ["shelf:read", "usage:write"]);
    assert.equal((await account.state()).status, "connected");
  });

  test("declining in the browser is reported", async () => {
    fake.deny = true;
    const pending = await account.connect();
    await approveInBrowser((pending as { url: string }).url);
    await assert.rejects(account.connect({ waitMs: 1000 }), /the user declined/);
    assert.equal((await account.state()).status, "not connected");
  });

  test("Spoolman with the bearer token; a 401 gets one retry with a new token", async () => {
    await signIn();
    const client = new SpoolmanClient(account.spoolmanBase, { auth: account, via: "Printerials account" });
    assert.equal((await client.listSpools())[0]!.id, 1);
    const first = fake.bearers.at(-1)!;
    assert.ok(first);

    fake.expireAccessTokens();
    assert.equal((await client.getSpool(1)).id, 1);
    assert.equal(fake.refreshes, 1);
    assert.notEqual(fake.bearers.at(-1), first);
    assert.equal(fake.bearers.at(-2), first);

    await client.useSpool(1, 2.5);
    assert.deepEqual(fake.used, [2.5]);
  });

  test("two processes with one store refresh once, so the rotated token is never used twice", async () => {
    await signIn();
    // A second server process (Claude Desktop next to Claude Code) on the same Keychain item.
    const other = make();
    await store.write({ ...(await store.read())!, expires_at: 0 });
    const tokens = await Promise.all([account.accessToken(), other.accessToken(), account.accessToken(), other.accessToken()]);
    assert.equal(new Set(tokens).size, 1);
    assert.equal(fake.refreshes, 1);
    assert.equal(fake.reuses, 0);

    // The next expiry: rotated again, from the token the first refresh stored.
    await store.write({ ...(await store.read())!, expires_at: 0 });
    await other.accessToken();
    assert.equal(fake.refreshes, 2);
    assert.equal(fake.reuses, 0);
  });

  test("a refresh answer lost on the way is retried inside the grace, without revoking", async () => {
    await signIn();
    await store.write({ ...(await store.read())!, expires_at: 0 });
    fake.dropNextRefreshAnswer = true;
    const token = await account.accessToken();
    assert.equal(fake.graced, 1);
    assert.equal(fake.reuses, 0);
    const client = new SpoolmanClient(account.spoolmanBase, { auth: account });
    assert.equal((await client.getSpool(1)).id, 1);
    assert.equal(fake.bearers.at(-1), token);
  });

  test("a rotated refresh token used again after its successor was used revokes the connection", async () => {
    await signIn();
    const old = (await store.read())!;
    await store.write({ ...old, expires_at: 0 });
    const client = new SpoolmanClient(account.spoolmanBase, { auth: account });
    await client.listSpools();
    // A stale copy of the old pair (what a second process without the lock would hold).
    await store.write({ ...old, expires_at: 0 });
    await assert.rejects(account.accessToken(), /ended this connection/);
    assert.equal(fake.reuses, 1);
  });

  test("an app switched off at Printerials keeps its connection, and works again when it is back on", async () => {
    await signIn();
    const client = new SpoolmanClient(account.spoolmanBase, { auth: account });
    fake.disabled = true;
    await assert.rejects(client.listSpools(), /switched PrusaSlicer MCP off for now/);
    assert.ok(await store.read(), "kept");
    fake.disabled = false;
    assert.equal((await client.listSpools())[0]!.id, 1);
    assert.equal(fake.reuses, 0);
  });

  test("a connection Printerials ended is removed, with a way back", async () => {
    await signIn();
    fake.revokeAll();
    await store.write({ ...(await store.read())!, expires_at: 0 });
    await assert.rejects(account.accessToken(), (error: unknown) => {
      assert.ok(error instanceof Refusal);
      assert.match(error.message, /ended this connection.*connect_printerials/s);
      return true;
    });
    assert.equal(await store.read(), null);
    assert.equal((await account.state()).status, "not connected");
  });

  test("restart replaces the connection and revokes the old one", async () => {
    await signIn();
    const old = (await store.read())!.refresh_token;
    const pending = await account.connect({ restart: true });
    await approveInBrowser((pending as { url: string }).url);
    await account.connect({ waitMs: 1000 });
    assert.notEqual((await store.read())!.refresh_token, old);
    assert.deepEqual(fake.revocations, [old]);
  });

  test("disconnect revokes at Printerials and forgets here", async () => {
    await signIn();
    const refresh = (await store.read())!.refresh_token;
    const result = await account.disconnect();
    assert.deepEqual(result, { status: "disconnected", revoked_at_printerials: true, problem: undefined });
    assert.deepEqual(fake.revocations, [refresh]);
    assert.equal(await store.read(), null);
    assert.deepEqual(await account.disconnect(), { status: "not connected" });
    const file = await readFile((store as unknown as { path: string }).path, "utf8");
    assert.ok(!file.includes(refresh));
  });

  test("plain http only to the loopback interface", () => {
    assert.throws(() => new PrinterialsAccount({ base: "http://printerials.com", store }), /must be https/);
  });
});
