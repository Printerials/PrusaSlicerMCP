import { createHash, randomBytes } from "node:crypto";
import { Refusal } from "../util/errors.ts";
import { VERSION } from "../version.ts";

/**
 * OAuth 2.0 with Printerials, as agreed with the Printerials project on 2026-11-16: authorization
 * code with PKCE S256 (RFC 7636) for a public client without a secret, a loopback redirect
 * (RFC 8252), metadata (RFC 8414), revocation (RFC 7009). The access token lives an hour; the
 * refresh token rotates on every use and lives 90 days, and a refresh token used twice revokes
 * the whole connection, except within 60 s when the pair it was exchanged for was never used
 * (Printerials' grace for an answer lost on the way).
 */

export const CLIENT_ID = "prusaslicer-mcp";
export const SCOPES = ["shelf:read", "usage:write"] as const;

const TIMEOUT_MS = 15_000;
const USER_AGENT = `PrusaSlicerMCP/${VERSION}`;

export interface ServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/** An error answer from the authorization server ({error, error_description}). */
export class OAuthError extends Refusal {
  readonly code: string;
  readonly status: number;

  constructor(code: string, description: string | undefined, status: number) {
    super(`Printerials refused: ${description ?? code} (${code}).`);
    this.code = code;
    this.status = status;
  }
}

/** The server could not be reached, or gave no answer: the request may or may not have been handled. */
export class UnreachableError extends Refusal {}

/** https, or http on the loopback interface (a local test server). */
export function assertSecureUrl(url: string, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Refusal(`${what} is not a valid URL.`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new Refusal(`${what} must be https.`);
  return parsed;
}

export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** 32 random bytes: a 43-character verifier, the minimum length RFC 7636 allows. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: challengeOf(verifier) };
}

export async function discover(origin: string): Promise<ServerMetadata> {
  const host = new URL(origin).host;
  let response: Response;
  try {
    response = await fetch(`${origin}/.well-known/oauth-authorization-server`, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Refusal(`Printerials (${host}) could not be reached.`);
  }
  if (!response.ok) throw new Refusal(`Printerials (${host}) has no OAuth metadata (${response.status}).`);
  const data = (await response.json().catch(() => null)) as Partial<ServerMetadata> | null;
  if (!data || typeof data.authorization_endpoint !== "string" || typeof data.token_endpoint !== "string") {
    throw new Refusal(`Printerials' OAuth metadata at ${host} lacks the authorization or token endpoint.`);
  }
  // RFC 8414 section 3.3: the issuer must be the URL the metadata was fetched for.
  if (typeof data.issuer !== "string" || data.issuer.replace(/\/+$/, "") !== origin) {
    throw new Refusal(`Printerials' OAuth metadata names another issuer (${String(data.issuer)}) than ${origin}.`);
  }
  if (data.code_challenge_methods_supported && !data.code_challenge_methods_supported.includes("S256")) {
    throw new Refusal("Printerials' OAuth server does not offer PKCE S256.");
  }
  assertSecureUrl(data.authorization_endpoint, "The authorization endpoint");
  assertSecureUrl(data.token_endpoint, "The token endpoint");
  if (data.revocation_endpoint) assertSecureUrl(data.revocation_endpoint, "The revocation endpoint");
  return data as ServerMetadata;
}

async function post(endpoint: string, params: Record<string, string>): Promise<{ response: Response; data: Record<string, unknown> | null }> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": USER_AGENT },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new UnreachableError(`Printerials (${new URL(endpoint).host}) could not be reached.`);
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { response, data };
}

export async function tokenRequest(endpoint: string, params: Record<string, string>): Promise<TokenResponse> {
  const { response, data } = await post(endpoint, { ...params, client_id: CLIENT_ID });
  if (!response.ok) {
    const code = typeof data?.error === "string" ? data.error : `http_${response.status}`;
    throw new OAuthError(code, typeof data?.error_description === "string" ? data.error_description : undefined, response.status);
  }
  if (!data || typeof data.access_token !== "string" || !data.access_token) throw new Refusal("Printerials' token answer has no access token.");
  if (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer") {
    throw new Refusal(`Printerials issued a token of type ${String(data.token_type)}, not Bearer.`);
  }
  return data as unknown as TokenResponse;
}

/** RFC 7009: the server answers 200 for a token it does not know, too. */
export async function revokeToken(endpoint: string, refreshToken: string): Promise<void> {
  const { response, data } = await post(endpoint, { token: refreshToken, token_type_hint: "refresh_token", client_id: CLIENT_ID });
  if (!response.ok) {
    const code = typeof data?.error === "string" ? data.error : `http_${response.status}`;
    throw new OAuthError(code, typeof data?.error_description === "string" ? data.error_description : undefined, response.status);
  }
}
