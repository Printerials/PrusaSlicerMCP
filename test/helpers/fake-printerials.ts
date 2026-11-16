/**
 * A Printerials OAuth server and its Spoolman API on 127.0.0.1, behaving as agreed on
 * 2026-11-16: PKCE S256 only, a loopback redirect, rotating refresh tokens, and a refresh token
 * used twice revokes the whole connection, unless it comes back within 60 s and the pair it was
 * exchanged for was never used: then that pair is revoked and a new one issued.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

interface Grant {
  scope: string;
  revoked: boolean;
}

export interface FakePrinterials {
  origin: string;
  /** Seconds an access token lives. */
  accessTtl: number;
  /** Answer the next authorization with access_denied. */
  deny: boolean;
  /** The client is switched off in Printerials' CMS. */
  disabled: boolean;
  /** Grant this instead of the requested scope (the user unticked one). */
  grantScope: string | null;
  /** Rotate on the next refresh, then drop the connection before answering. */
  dropNextRefreshAnswer: boolean;
  /** Refresh tokens that came back within the grace and got a new pair. */
  graced: number;
  refreshes: number;
  reuses: number;
  revocations: string[];
  /** Every bearer token the Spoolman API saw. */
  bearers: string[];
  spool: Record<string, unknown>;
  used: number[];
  /** Revoke every grant: Printerials ended the connection. */
  revokeAll(): void;
  /** End the access tokens early, as a key rotation would. */
  expireAccessTokens(): void;
  close(): Promise<void>;
}

const read = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
  });

export async function startFakePrinterials(spool: Record<string, unknown>): Promise<FakePrinterials> {
  const codes = new Map<string, { challenge: string; redirectUri: string; scope: string }>();
  const grants: Grant[] = [];
  const refreshTokens = new Map<string, { grant: Grant; used: boolean; usedAt: number; successor: { access: string; refresh: string } | null }>();
  const accessTokens = new Map<string, { grant: Grant; expiresAt: number }>();
  const token = () => randomBytes(24).toString("base64url");

  let server: Server;
  const fake: FakePrinterials = {
    origin: "",
    accessTtl: 3600,
    deny: false,
    dropNextRefreshAnswer: false,
    grantScope: null,
    disabled: false,
    graced: 0,
    refreshes: 0,
    reuses: 0,
    revocations: [],
    bearers: [],
    spool,
    used: [],
    revokeAll: () => grants.forEach((grant) => (grant.revoked = true)),
    expireAccessTokens: () => accessTokens.forEach((entry) => (entry.expiresAt = 0)),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const issue = (grant: Grant) => {
    const access = token();
    const refresh = token();
    accessTokens.set(access, { grant, expiresAt: Date.now() + fake.accessTtl * 1000 });
    refreshTokens.set(refresh, { grant, used: false, usedAt: 0, successor: null });
    return { access_token: access, token_type: "Bearer", expires_in: fake.accessTtl, refresh_token: refresh, scope: grant.scope };
  };

  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", fake.origin);
    const body = await read(request);
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(data));
    };
    const fail = (error: string, status = 400) => send(status, { error, error_description: `fake: ${error}` });

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return send(200, {
        issuer: fake.origin,
        authorization_endpoint: `${fake.origin}/oauth/authorize`,
        token_endpoint: `${fake.origin}/api/oauth/token`,
        revocation_endpoint: `${fake.origin}/api/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["shelf:read", "usage:write"],
      });
    }

    // The browser: the user approves at once.
    if (url.pathname === "/oauth/authorize") {
      const p = url.searchParams;
      const redirectUri = p.get("redirect_uri") ?? "";
      if (p.get("client_id") !== "prusaslicer-mcp" || p.get("response_type") !== "code") return fail("invalid_request");
      if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) return fail("invalid_request");
      if (!/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri)) return fail("invalid_redirect_uri");
      const back = new URL(redirectUri);
      back.searchParams.set("state", p.get("state") ?? "");
      back.searchParams.set("iss", fake.origin);
      if (fake.deny) {
        back.searchParams.set("error", "access_denied");
      } else {
        const code = token();
        codes.set(code, { challenge: p.get("code_challenge")!, redirectUri, scope: fake.grantScope ?? p.get("scope") ?? "" });
        back.searchParams.set("code", code);
      }
      response.writeHead(302, { location: back.toString() });
      return response.end();
    }

    if (url.pathname === "/api/oauth/token" && request.method === "POST") {
      if (!String(request.headers["content-type"]).startsWith("application/x-www-form-urlencoded")) return fail("invalid_request");
      const p = new URLSearchParams(body);
      if (p.get("client_id") !== "prusaslicer-mcp" || fake.disabled) return fail("invalid_client", 401);
      if (p.get("grant_type") === "authorization_code") {
        const entry = codes.get(p.get("code") ?? "");
        codes.delete(p.get("code") ?? "");
        if (!entry || entry.redirectUri !== p.get("redirect_uri")) return fail("invalid_grant");
        if (createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url") !== entry.challenge) return fail("invalid_grant");
        const grant = { scope: entry.scope, revoked: false };
        grants.push(grant);
        return send(200, issue(grant));
      }
      if (p.get("grant_type") === "refresh_token") {
        const entry = refreshTokens.get(p.get("refresh_token") ?? "");
        if (!entry || entry.grant.revoked) return fail("invalid_grant");
        if (entry.used) {
          const successor = entry.successor;
          const unused = successor && !fake.bearers.includes(successor.access) && !refreshTokens.get(successor.refresh)?.used;
          if (successor && unused && Date.now() - entry.usedAt < 60_000) {
            fake.graced++;
            accessTokens.delete(successor.access);
            refreshTokens.delete(successor.refresh);
          } else {
            fake.reuses++;
            entry.grant.revoked = true;
            return fail("invalid_grant");
          }
        }
        entry.used = true;
        entry.usedAt = Date.now();
        fake.refreshes++;
        const pair = issue(entry.grant);
        entry.successor = { access: pair.access_token, refresh: pair.refresh_token };
        if (fake.dropNextRefreshAnswer) {
          fake.dropNextRefreshAnswer = false;
          return request.socket.destroy();
        }
        return send(200, pair);
      }
      return fail("unsupported_grant_type");
    }

    if (url.pathname === "/api/oauth/revoke" && request.method === "POST") {
      const p = new URLSearchParams(body);
      const entry = refreshTokens.get(p.get("token") ?? "");
      if (entry) entry.grant.revoked = true;
      fake.revocations.push(p.get("token") ?? "");
      response.writeHead(200);
      return response.end();
    }

    if (url.pathname.startsWith("/api/spoolman/oauth/api/v1/")) {
      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
      fake.bearers.push(bearer);
      const entry = accessTokens.get(bearer);
      if (!entry || entry.grant.revoked || entry.expiresAt < Date.now() || fake.disabled) {
        return send(401, { message: "Unauthorized" }, { "www-authenticate": 'Bearer error="invalid_token"' });
      }
      const rest = url.pathname.slice("/api/spoolman/oauth/api/v1/".length);
      if (request.method === "GET" && !entry.grant.scope.split(" ").includes("shelf:read")) {
        return send(403, { message: "Forbidden" }, { "www-authenticate": 'Bearer error="insufficient_scope", scope="shelf:read"' });
      }
      if (rest === "spool" && request.method === "GET") return send(200, [fake.spool]);
      if (rest === `spool/${fake.spool.id}` && request.method === "GET") return send(200, fake.spool);
      if (rest === `spool/${fake.spool.id}/use` && request.method === "PUT") {
        if (!entry.grant.scope.split(" ").includes("usage:write")) {
          return send(403, { message: "Forbidden" }, { "www-authenticate": 'Bearer error="insufficient_scope", scope="usage:write"' });
        }
        const grams = JSON.parse(body).use_weight as number;
        fake.used.push(grams);
        (fake.spool as { remaining_weight: number }).remaining_weight -= grams;
        // The spool only with shelf:read: weights and prices are shelf data.
        if (!entry.grant.scope.split(" ").includes("shelf:read")) {
          response.writeHead(204);
          return response.end();
        }
        return send(200, fake.spool);
      }
    }
    send(404, { message: "Not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return fake;
}

/** What the browser does: follow the sign-in link through the redirect to the callback. */
export async function approveInBrowser(url: string): Promise<{ status: number; html: string }> {
  const response = await fetch(url);
  return { status: response.status, html: await response.text() };
}
