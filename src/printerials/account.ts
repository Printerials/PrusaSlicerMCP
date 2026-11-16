import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { Refusal } from "../util/errors.ts";
import { withFileLock } from "../util/lock.ts";
import { openUrl } from "../util/open-url.ts";
import { assertSecureUrl, CLIENT_ID, discover, OAuthError, pkcePair, revokeToken, SCOPES, tokenRequest, UnreachableError, type ServerMetadata, type TokenResponse } from "./oauth.ts";
import { defaultTokenStore, type StoredTokens, type TokenStore } from "./token-store.ts";

/** How long a sign-in link stays valid here. */
const LOGIN_TTL_MS = 10 * 60_000;
/** An access token this close to its expiry is refreshed first. */
const EXPIRY_MARGIN_MS = 60_000;
/** Before retrying a refresh whose answer did not arrive; well inside Printerials' 60 s grace. */
const RETRY_DELAY_MS = 1_000;

const NOT_CONNECTED = "No Printerials account is connected. connect_printerials links one (sign-in in the browser).";
const SWITCHED_OFF = "Printerials has switched PrusaSlicer MCP off for now. The connection is kept and works again once it is back on";
const REVOKED = "Printerials ended this connection (signed out, revoked in the account, or unused for 90 days). connect_printerials links it again.";

export type AccountState =
  | { status: "connected"; scopes: string[]; since: string; stored_in: string }
  | { status: "sign-in pending"; url: string; expires_in_s: number }
  | { status: "not connected"; stored_in: string | null };

interface LoginAttempt {
  url: string;
  expiresAt: number;
  done: Promise<void>;
  outcome: { ok: true } | { ok: false; error: string } | null;
  close(): void;
}

export interface AccountOptions {
  base?: string;
  store?: TokenStore | null;
  open?: (url: string) => Promise<boolean>;
}

/**
 * The user's Printerials account, connected with OAuth. One per process: it holds the pending
 * sign-in and makes concurrent refreshes in this process one. Refreshes across processes are
 * serialized by a lock file, and every refresh rereads the store first: a refresh token that
 * another process already rotated would count as reused, and that revokes the connection.
 */
export class PrinterialsAccount {
  readonly origin: string;
  readonly host: string;
  private readonly store: TokenStore | null;
  private readonly open: (url: string) => Promise<boolean>;
  private metadata: Promise<ServerMetadata> | null = null;
  private login: LoginAttempt | null = null;
  private refreshing: Promise<string> | null = null;

  constructor({ base = process.env.PRINTERIALS_URL || "https://printerials.com", store, open = openUrl }: AccountOptions = {}) {
    const url = assertSecureUrl(base, "PRINTERIALS_URL");
    this.origin = url.origin;
    this.host = url.host;
    this.store = store === undefined ? defaultTokenStore(this.origin) : store;
    this.open = open;
  }

  /** Printerials' Spoolman-compatible API for the connected account; the token goes in a header. */
  get spoolmanBase(): string {
    return `${this.origin}/api/spoolman/oauth`;
  }

  private requireStore(): TokenStore {
    if (!this.store) {
      throw new Refusal(
        "This platform has no Keychain support here. Set PRINTERIALS_TOKEN_FILE to a file the connection may be kept in (plain text, mode 0600), or use SPOOLMAN_URL.",
      );
    }
    return this.store;
  }

  private meta(): Promise<ServerMetadata> {
    this.metadata ??= discover(this.origin).catch((error: unknown) => {
      this.metadata = null;
      throw error;
    });
    return this.metadata;
  }

  /** A refresh takes at most two token requests of 15 s and the retry delay: well within staleMs. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.requireStore().lockPath, fn, { staleMs: 60_000, timeoutMs: 75_000 });
  }

  async isConnected(): Promise<boolean> {
    return this.store ? (await this.store.read()) !== null : false;
  }

  async state(): Promise<AccountState> {
    const tokens = this.store ? await this.store.read() : null;
    if (tokens) return connectedState(tokens, this.store!);
    const attempt = this.login;
    if (attempt && !attempt.outcome && attempt.expiresAt > Date.now()) {
      return { status: "sign-in pending", url: attempt.url, expires_in_s: Math.round((attempt.expiresAt - Date.now()) / 1000) };
    }
    return { status: "not connected", stored_in: this.store?.kind ?? null };
  }

  /**
   * Starts a sign-in (or reports the one under way) and returns without waiting for it, unless
   * waitMs is given: the user approves in the browser, which may take a while.
   */
  async connect({ restart = false, openBrowser = true, waitMs = 0 }: { restart?: boolean; openBrowser?: boolean; waitMs?: number } = {}): Promise<
    AccountState & { opened_browser?: boolean }
  > {
    const store = this.requireStore();
    if (!restart) {
      const tokens = await store.read();
      if (tokens) {
        this.login?.close();
        this.login = null;
        return connectedState(tokens, store);
      }
    }

    let attempt = this.login;
    if (attempt && (restart || attempt.expiresAt <= Date.now())) {
      attempt.close();
      attempt = null;
    }
    let opened: boolean | undefined;
    if (!attempt) {
      attempt = await this.startLogin();
      this.login = attempt;
      opened = openBrowser ? await this.open(attempt.url) : false;
    }

    if (waitMs > 0 && !attempt.outcome) await Promise.race([attempt.done, sleep(waitMs)]);
    if (attempt.outcome) {
      this.login = null;
      if (!attempt.outcome.ok) throw new Refusal(`The Printerials sign-in failed: ${attempt.outcome.error}`);
      const tokens = await store.read();
      if (!tokens) throw new Refusal("The sign-in completed, but the connection was not found in the store afterwards.");
      return connectedState(tokens, store);
    }
    return { status: "sign-in pending", url: attempt.url, expires_in_s: Math.round((attempt.expiresAt - Date.now()) / 1000), opened_browser: opened };
  }

  private async startLogin(): Promise<LoginAttempt> {
    const meta = await this.meta();
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString("base64url");

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    // A pending sign-in must not keep the process alive once its MCP host has gone.
    server.unref();
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;

    const url = new URL(meta.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPES.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    })) {
      url.searchParams.set(key, value);
    }

    let settle!: (outcome: { ok: true } | { ok: false; error: string }) => void;
    const done = new Promise<void>((resolve) => {
      settle = (outcome) => {
        if (attempt.outcome) return;
        attempt.outcome = outcome;
        clearTimeout(timer);
        server.close();
        resolve();
      };
    });
    const timer = setTimeout(() => settle({ ok: false, error: "it was not completed within 10 minutes." }), LOGIN_TTL_MS);
    timer.unref();

    const attempt: LoginAttempt = {
      url: url.toString(),
      expiresAt: Date.now() + LOGIN_TTL_MS,
      done,
      outcome: null,
      close: () => settle({ ok: false, error: "a new sign-in replaced it." }),
    };

    let exchanging = false;
    server.on("request", (request: IncomingMessage, response: ServerResponse) => {
      const callback = new URL(request.url ?? "/", redirectUri);
      if (request.method !== "GET" || callback.pathname !== "/callback") return page(response, 404, "Not found", "");
      const params = callback.searchParams;
      // Not this sign-in's redirect: ignored, the sign-in goes on.
      if (!sameText(params.get("state"), state)) return page(response, 400, "Unknown sign-in", "This link does not belong to the sign-in PrusaSlicer MCP is waiting for.");
      if (exchanging || attempt.outcome) return page(response, 409, "Already handled", "This sign-in has been handled. You can close this window.");
      // RFC 9207: when the server names itself, it must be the server the request went to.
      const iss = params.get("iss");
      if (iss !== null && iss.replace(/\/+$/, "") !== meta.issuer.replace(/\/+$/, "")) {
        settle({ ok: false, error: `the answer came from another issuer (${iss}).` });
        return page(response, 400, "Sign-in refused", "The answer came from another server than Printerials.");
      }
      const error = params.get("error");
      if (error) {
        const description = params.get("error_description");
        settle({ ok: false, error: error === "access_denied" ? "the user declined." : `${description ?? error} (${error}).` });
        return page(response, 200, "Not connected", error === "access_denied" ? "You declined. PrusaSlicer MCP is not connected to Printerials." : "Printerials did not connect PrusaSlicer MCP.");
      }
      const code = params.get("code");
      if (!code) return page(response, 400, "No code", "Printerials' answer has no authorization code.");

      exchanging = true;
      void (async () => {
        try {
          const tokens = await tokenRequest(meta.token_endpoint, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
          if (!tokens.refresh_token) throw new Refusal("Printerials issued no refresh token.");
          const replaced = await this.locked(async () => {
            const store = this.requireStore();
            const previous = await store.read();
            await store.write(toStored(tokens, null));
            return previous;
          });
          // A new sign-in (restart) replaces the old connection; it should not linger in the account.
          if (replaced && meta.revocation_endpoint) await revokeToken(meta.revocation_endpoint, replaced.refresh_token).catch(() => undefined);
          page(response, 200, "Connected", "PrusaSlicer MCP is connected to your Printerials account. You can close this window.");
          settle({ ok: true });
        } catch (failure) {
          page(response, 502, "Not connected", "Connecting failed. The assistant has the reason.");
          settle({ ok: false, error: failure instanceof Error ? failure.message : String(failure) });
        }
      })();
    });

    return attempt;
  }

  /** A valid access token, refreshed first when it is (nearly) expired. */
  async accessToken(): Promise<string> {
    const tokens = await this.requireStore().read();
    if (!tokens) throw new Refusal(NOT_CONNECTED);
    if (tokens.expires_at - EXPIRY_MARGIN_MS > Date.now()) return tokens.access_token;
    return this.refresh(null);
  }

  /** The API rejected this access token (401): a new one, unless another process has one already. */
  rejected(token: string): Promise<string> {
    return this.refresh(token);
  }

  private refresh(rejected: string | null): Promise<string> {
    this.refreshing ??= this.locked(async () => {
      const store = this.requireStore();
      const current = await store.read();
      if (!current) throw new Refusal(NOT_CONNECTED);
      // Another process (or call) refreshed while this one waited for the lock.
      if (current.expires_at - EXPIRY_MARGIN_MS > Date.now() && current.access_token !== rejected) return current.access_token;

      const meta = await this.meta();
      const exchange = () => tokenRequest(meta.token_endpoint, { grant_type: "refresh_token", refresh_token: current.refresh_token });
      let response: TokenResponse;
      try {
        try {
          response = await exchange();
        } catch (error) {
          // Printerials may have rotated without the answer arriving. The same refresh token again
          // within 60 s, before the new pair is used, gets a new pair instead of revoking: retry now,
          // not on the next call, which may be well after that.
          if (!(error instanceof UnreachableError || (error instanceof OAuthError && error.status >= 500))) throw error;
          await sleep(RETRY_DELAY_MS);
          response = await exchange();
        }
      } catch (error) {
        // Only invalid_grant means the connection is gone. A switched-off app gets invalid_client and
        // OAuth switched off a 404: the connection stays, and works again when they are back on.
        if (error instanceof OAuthError && error.code === "invalid_grant") {
          await store.delete();
          throw new Refusal(REVOKED);
        }
        if (error instanceof OAuthError && error.code === "invalid_client") throw new Refusal(SWITCHED_OFF);
        if (error instanceof OAuthError && error.status === 404) throw new Refusal(`${SWITCHED_OFF} (OAuth is off at Printerials.)`);
        throw error;
      }
      const next = toStored(response, current);
      await store.write(next);
      return next.access_token;
    }).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Revokes the connection at Printerials and removes it here; removed here even when Printerials cannot be reached. */
  async disconnect(): Promise<{ status: "disconnected" | "not connected"; revoked_at_printerials?: boolean; problem?: string }> {
    this.login?.close();
    this.login = null;
    const store = this.requireStore();
    return this.locked(async () => {
      const tokens = await store.read();
      if (!tokens) return { status: "not connected" as const };
      let problem: string | undefined;
      try {
        const meta = await this.meta();
        if (meta.revocation_endpoint) await revokeToken(meta.revocation_endpoint, tokens.refresh_token);
        else problem = "Printerials has no revocation endpoint: revoke PrusaSlicer MCP in your Printerials account.";
      } catch (error) {
        problem = `${error instanceof Error ? error.message : String(error)} Revoke PrusaSlicer MCP in your Printerials account.`;
      }
      await store.delete();
      return { status: "disconnected" as const, revoked_at_printerials: !problem, problem };
    });
  }
}

function connectedState(tokens: StoredTokens, store: TokenStore): AccountState {
  return { status: "connected", scopes: tokens.scope.split(/\s+/).filter(Boolean), since: tokens.connected_at, stored_in: store.kind };
}

function toStored(response: TokenResponse, previous: StoredTokens | null): StoredTokens {
  return {
    access_token: response.access_token,
    expires_at: Date.now() + (response.expires_in ?? 3600) * 1000,
    // Rotated on every refresh; kept if a server ever answers without one.
    refresh_token: response.refresh_token ?? previous!.refresh_token,
    scope: response.scope ?? previous?.scope ?? SCOPES.join(" "),
    connected_at: previous?.connected_at || new Date().toISOString(),
  };
}

function sameText(a: string | null, b: string): boolean {
  if (a === null) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function page(response: ServerResponse, status: number, title: string, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // The address holds the authorization code: no page may be told it.
    "referrer-policy": "no-referrer",
  });
  response.end(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1rem"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`,
  );
}
