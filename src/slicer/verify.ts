/**
 * Whether PrusaSlicer took the values written for a slice. 3.0 ignores what it does not take
 * without an error, so before slicing PrusaSlicer loads the written config and saves it again
 * (--load written.json --save check.json), and the two are compared per section (checkPatched in
 * v3-config.ts).
 *
 * Not the G-code header: in 3.0.0-alpha14 it is not faithful for every key. A 3DBenchy lifts the
 * nozzle as often as with 2.9.7 while the header shows retract_lift, travel_max_lift and
 * travel_ramping_lift as 0 (measured 2026-11-19).
 */
export interface AppliedCheck {
  /** Every place the value was written holds it after loading. */
  confirmed: string[];
  /** PrusaSlicer loaded another value: it replaced, clamped or ignored the one written. */
  rejected: Array<{ key: string; layer: string; expected: string; found: string }>;
  /** Not in what PrusaSlicer saved back: "key (section)". */
  missing: string[];
}

/** Deep equality of config values, with numbers compared to 1e-9 (PrusaSlicer re-serializes floats). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameJson(value, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return a === b;
}
