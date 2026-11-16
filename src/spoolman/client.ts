import { Refusal } from "../util/errors.ts";
import { VERSION } from "../version.ts";

/**
 * A client for Spoolman's REST API (v0.22, the part its own clients use: list and read spools,
 * report filament used). Works against a self-hosted Spoolman and against Printerials, whose
 * Spoolman-compatible API takes the account's token in the path
 * (https://printerials.com/api/spoolman/<token>).
 *
 * The User-Agent is PrusaSlicerMCP/<version>: Printerials shows its first product as the client
 * name in the user's token list.
 *
 * The base URL is a credential when it carries a token, so it comes from SPOOLMAN_URL only,
 * never from a tool argument, and no error message or log line contains it.
 *
 * With a Printerials account connected by OAuth the base is https://printerials.com/api/spoolman/oauth
 * and the access token goes in an Authorization header instead.
 */

export interface SpoolmanVendor {
  id: number;
  name: string;
}

export interface SpoolmanFilament {
  id: number;
  name?: string;
  vendor?: SpoolmanVendor;
  material?: string;
  price?: number;
  density: number;
  diameter: number;
  /** Net filament weight of a full spool, grams. */
  weight?: number;
  spool_weight?: number;
  settings_extruder_temp?: number;
  settings_bed_temp?: number;
  color_hex?: string;
  multi_color_hexes?: string;
  external_id?: string;
}

export interface SpoolmanSpool {
  id: number;
  filament: SpoolmanFilament;
  remaining_weight?: number;
  used_weight?: number;
  initial_weight?: number;
  spool_weight?: number;
  price?: number;
  location?: string;
  lot_nr?: string;
  comment?: string;
  archived?: boolean;
  first_used?: string;
  last_used?: string;
}

const TIMEOUT_MS = 15_000;

/** An error answer from the Spoolman API, with its status. */
export class SpoolmanError extends Refusal {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A bearer token source: the connected Printerials account. */
export interface BearerAuth {
  accessToken(): Promise<string>;
  /** The API refused this token: a new one. */
  rejected(token: string): Promise<string>;
}

export class SpoolmanClient {
  private readonly base: string;
  private readonly auth: BearerAuth | null;
  /** Scheme and host only, for messages: never the path, which may hold the token. */
  readonly host: string;
  /** Where the connection comes from: "SPOOLMAN_URL" or "Printerials account". */
  readonly via: string;

  constructor(url: string, { auth = null, via = "SPOOLMAN_URL" }: { auth?: BearerAuth | null; via?: string } = {}) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Refusal("SPOOLMAN_URL is not a valid URL.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Refusal("SPOOLMAN_URL must be an http(s) URL.");
    this.host = parsed.host;
    this.base = url.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
    this.auth = auth;
    this.via = via;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SpoolmanClient | null {
    const url = env.SPOOLMAN_URL?.trim();
    return url ? new SpoolmanClient(url) : null;
  }

  private async send(method: string, path: string, body: unknown, token: string | null): Promise<Response> {
    try {
      return await fetch(`${this.base}/api/v1/${path}`, {
        method,
        headers: {
          accept: "application/json",
          "user-agent": `PrusaSlicerMCP/${VERSION}`,
          ...(body ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not connect";
      throw new Refusal(`Spoolman at ${this.host} ${reason}.`);
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let token = this.auth ? await this.auth.accessToken() : null;
    let response = await this.send(method, path, body, token);
    // An access token can end before its time (revoked, the server restarted its keys): once more with a new one.
    if (response.status === 401 && this.auth && token) {
      token = await this.auth.rejected(token);
      response = await this.send(method, path, body, token);
    }
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // keep null: reported below
    }
    if (!response.ok) {
      const message = data && typeof data === "object" && "message" in data ? String((data as { message: unknown }).message) : response.statusText;
      const fail = (text: string) => new SpoolmanError(response.status, text);
      if (this.auth && response.status === 401) throw fail("Printerials does not accept this connection any more. connect_printerials with restart links the account again.");
      if (this.auth && response.status === 403) {
        // With a scope: one the user unticked, or that was taken from the app. Without: never allowed to an app.
        const scope = /scope="([^"]*)"/.exec(response.headers.get("www-authenticate") ?? "")?.[1];
        throw fail(
          scope
            ? `This needs the Printerials permission ${scope}, which this connection does not have. connect_printerials with restart asks for it again.`
            : "Printerials does not allow this to a connected app.",
        );
      }
      if (response.status === 401 || response.status === 403) throw fail(`Spoolman at ${this.host} refused the request (${response.status}): check the token in SPOOLMAN_URL.`);
      if (response.status === 404) throw fail(`Spoolman at ${this.host}: not found (${message}).`);
      throw fail(`Spoolman at ${this.host} answered ${response.status}: ${message.slice(0, 200)}`);
    }
    if (data === null && text) throw new Refusal(`Spoolman at ${this.host} answered with something that is not JSON.`);
    return data as T;
  }

  listSpools(includeArchived = false): Promise<SpoolmanSpool[]> {
    return this.request<SpoolmanSpool[]>("GET", `spool${includeArchived ? "?allow_archived=true" : ""}`);
  }

  getSpool(id: number): Promise<SpoolmanSpool> {
    return this.request<SpoolmanSpool>("GET", `spool/${id}`);
  }

  /** Reports filament used off a spool, as Moonraker and OctoPrint do. */
  /**
   * Spoolman answers with the spool after the booking. Printerials does so only with shelf:read;
   * with usage:write alone it answers 204 without a body (weights and prices are shelf data), so null.
   */
  async useSpool(id: number, grams: number): Promise<SpoolmanSpool | null> {
    return (await this.request<SpoolmanSpool | null>("PUT", `spool/${id}/use`, { use_weight: grams })) ?? null;
  }
}

/** Spoolman's material names to PrusaSlicer's filament_type. */
const TYPES: Record<string, string> = {
  PLA: "PLA",
  "PLA+": "PLA",
  PETG: "PETG",
  PET: "PET",
  ABS: "ABS",
  ASA: "ASA",
  TPU: "FLEX",
  TPE: "FLEX",
  FLEX: "FLEX",
  PC: "PC",
  PA: "PA",
  NYLON: "PA",
  HIPS: "HIPS",
  PP: "PP",
  PVA: "PVA",
};

export function prusaTypeOf(material: string | undefined): string | undefined {
  if (!material) return undefined;
  const key = material.trim().toUpperCase().replace(/\s+/g, "");
  return TYPES[key] ?? TYPES[key.replace(/[-_].*$/, "")];
}

/** Price per kg of a spool: its own price, else the filament's, over the net weight. */
export function spoolPricePerKg(spool: SpoolmanSpool): number | undefined {
  const price = spool.price ?? spool.filament.price;
  const weight = spool.initial_weight ?? spool.filament.weight;
  if (price === undefined || price <= 0 || !weight) return undefined;
  return Math.round((price / weight) * 1000 * 100) / 100;
}

export function spoolLabel(spool: SpoolmanSpool): string {
  return [spool.filament.vendor?.name, spool.filament.name ?? spool.filament.material].filter(Boolean).join(" ");
}
