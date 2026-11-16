import { setTimeout as sleep } from "node:timers/promises";
import type { StatedFigure, StatedFilament } from "../slicer/filament-preset.ts";
import { Refusal } from "../util/errors.ts";
import { VERSION } from "../version.ts";

/**
 * Printerials' public catalogue API (no token), as agreed with the Printerials project on
 * 2026-11-16:
 *   GET /api/app/v1/catalogue/materials?q=          lines matching a search
 *   GET /api/app/v1/catalogue/materials/{id}        the colours (variants) of a line
 *   GET /api/app/v1/catalogue/variants/{id}/slicer  stated values, sources, community temps, price
 * Limits without a token: 60 requests a minute and 3,000 a day per IP; a 429 carries Retry-After.
 * Answers are cached per URL: stated values change rarely, prices a few times a day.
 */

export interface PrinterialsLine {
  id: number;
  name: string;
  brand: string;
  type: string | null;
  colourCount: number;
}

export interface PrinterialsColour {
  variantId: number;
  brand: string;
  material: string;
  type: { slug: string; name: string } | null;
  colour: string;
  hex: string | null;
  measuredHex?: string | null;
  isDiscontinued?: boolean;
}

export interface StatedValue {
  value: number | null;
  min?: number | null;
  max?: number | null;
  source?: string | null;
  sourceUrl?: string | null;
  method?: string | null;
  /** Set when `value` comes from another source than the range (live since 2026-11-16, d17b98f9). */
  valueFrom?: { source: string; sourceUrl?: string | null } | null;
}

export interface PrinterialsSlicer {
  variantId: number;
  materialId: number;
  material: { slug: string; name: string; brand: string; type: { slug: string; name: string } | null; url: string };
  colour: { slug: string; name: string; hex: string | null; measured: boolean; url: string } | null;
  diameters: number[];
  base: { prusaType: string; orca?: string } | null;
  stated: Partial<Record<"nozzleTempC" | "bedTempC" | "chamberTempC" | "densityGcm3" | "dryTempMaxC", StatedValue | null>>;
  community?: Array<{ printer: { slug: string; name: string } | null; nozzleSizes?: number[]; nozzle?: { min: number; max: number } | null; bed?: { min: number; max: number } | null; people: number }>;
  profiles?: Array<{ format: string; url: string }>;
  price?: { country: string | null; currency: string; headline: { url?: string; seenAt?: string; shop?: unknown } | null; noHeadline?: unknown; perKg: number | null };
}

const TTL = { search: 10 * 60_000, colours: 60 * 60_000, slicer: 30 * 60_000 };

export class PrinterialsClient {
  readonly base: string;
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(base = process.env.PRINTERIALS_URL || "https://printerials.com") {
    this.base = base.replace(/\/+$/, "");
  }

  private async get<T>(path: string, ttl: number): Promise<T> {
    const url = `${this.base}${path}`;
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < ttl) return hit.value as T;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { accept: "application/json", "user-agent": `PrusaSlicerMCP/${VERSION}` },
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new Refusal(`Printerials (${new URL(this.base).host}) could not be reached.`);
      }
      if (response.status === 429) {
        const wait = Number(response.headers.get("retry-after") ?? "60");
        if (attempt === 0 && wait <= 10) {
          await sleep(wait * 1000);
          continue;
        }
        throw new Refusal(`Printerials asks to wait ${wait} s before the next request (rate limit).`);
      }
      if (response.status === 404) throw new Refusal(`Printerials has no ${path.split("?")[0]}.`);
      if (!response.ok) throw new Refusal(`Printerials answered ${response.status} for ${path.split("?")[0]}.`);
      const value = (await response.json()) as T;
      this.cache.set(url, { at: Date.now(), value });
      return value;
    }
  }

  searchLines(query: string): Promise<PrinterialsLine[]> {
    return this.get(`/api/app/v1/catalogue/materials?q=${encodeURIComponent(query)}`, TTL.search);
  }

  colours(materialId: number): Promise<PrinterialsColour[]> {
    return this.get(`/api/app/v1/catalogue/materials/${materialId}`, TTL.colours);
  }

  /** `to` is the delivery country: without it the price counts shops that do not deliver there, so it is then ignored. */
  slicer(variantId: number, to?: string, currency?: string): Promise<PrinterialsSlicer> {
    const query = new URLSearchParams();
    if (to) query.set("to", to.toUpperCase());
    if (currency) query.set("currency", currency.toUpperCase());
    const qs = query.toString();
    return this.get(`/api/app/v1/catalogue/variants/${variantId}/slicer${qs ? `?${qs}` : ""}`, TTL.slicer);
  }
}

/** "printerials:variant/7767" -> 7767, as Printerials' Spoolman API sets filament.external_id. */
export function variantFromExternalId(externalId: string | undefined | null): number | null {
  const match = /^printerials:variant\/(\d+)$/.exec(externalId ?? "");
  return match ? Number(match[1]) : null;
}

function figure(value: StatedValue | null | undefined): StatedFigure | undefined {
  if (!value) return undefined;
  const source = [value.source, value.method].filter(Boolean).join(", ") || undefined;
  const hasRange = value.min != null || value.max != null;
  const range = hasRange ? { min: value.min ?? undefined, max: value.max ?? undefined } : {};
  if (value.value !== null && value.value !== undefined) {
    const valueSource = value.valueFrom?.source;
    if (!hasRange) return { value: value.value, source: valueSource ?? source };
    return { value: value.value, ...range, source, ...(valueSource ? { valueSource } : {}) };
  }
  return hasRange ? { ...range, source } : undefined;
}

/** The slicer data in the source-independent form; prices only when a delivery country was given. */
export function statedFromPrinterials(data: PrinterialsSlicer, diameter: number | undefined, withPrice: boolean): StatedFilament {
  const nozzle = figure(data.stated.nozzleTempC);
  const bed = figure(data.stated.bedTempC);
  const describe = (label: string, f: StatedFigure | undefined) => {
    if (!f) return null;
    const by = (source: string | undefined) => (source ? ` (${source})` : "");
    const hasRange = f.min !== undefined || f.max !== undefined;
    const range = hasRange ? `${f.min ?? "…"}–${f.max ?? "…"} °C${by(f.source)}` : null;
    const value = f.value !== undefined ? `${f.value} °C${by(hasRange ? f.valueSource : f.source)}` : null;
    return `${label} ${[range, value].filter(Boolean).join(", typical ")}`;
  };
  const notes = [
    `Printerials: ${data.colour?.url ?? data.material.url}`,
    describe("nozzle", nozzle),
    describe("bed", bed),
  ]
    .filter(Boolean)
    .join("\n");
  return {
    vendor: data.material.brand,
    type: data.base?.prusaType,
    colour: data.colour?.hex ?? undefined,
    diameter: diameter ?? (data.diameters.includes(1.75) ? 1.75 : data.diameters[0]),
    density: data.stated.densityGcm3?.value ?? undefined,
    nozzle,
    bed,
    chamber: figure(data.stated.chamberTempC),
    costPerKg: withPrice && data.price?.country && data.price.perKg !== null ? data.price.perKg : undefined,
    notes,
  };
}
