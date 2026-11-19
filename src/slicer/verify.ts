import { splitList, unescapeValue, type FlatConfig } from "../formats/ini.ts";

export interface AppliedCheck {
  /** PrusaSlicer loaded the value that was written. */
  confirmed: string[];
  /** PrusaSlicer loaded another value: it replaced, clamped or ignored the one written. */
  rejected: Array<{ key: string; expected: string; found: string }>;
  /** Not in what PrusaSlicer saved back. */
  missing: string[];
}

/**
 * Compares the config written for a slice with what PrusaSlicer saves back after loading it
 * (--load written.json --save check.json). Both sides go through the same serializer, so a
 * difference is PrusaSlicer's doing.
 *
 * Not the G-code header: in 3.0.0-alpha14 it is not faithful for every key. A 3DBenchy lifts the
 * nozzle as often as with 2.9.7 while the header shows retract_lift, travel_max_lift and
 * travel_ramping_lift as 0 (measured 2026-11-19).
 */
export function checkApplied(keys: Iterable<string>, written: FlatConfig, loaded: FlatConfig): AppliedCheck {
  const check: AppliedCheck = { confirmed: [], rejected: [], missing: [] };
  for (const key of keys) {
    const expected = written.get(key);
    const found = loaded.get(key);
    if (expected === undefined || found === undefined) check.missing.push(key);
    else if (same(found, expected)) check.confirmed.push(key);
    else check.rejected.push({ key, expected, found });
  }
  return check;
}

function same(a: string, b: string): boolean {
  const left = parts(a);
  const right = parts(b);
  return left.length === right.length && left.every((value, index) => equal(value, right[index]!));
}

function parts(value: string): string[] {
  const list = splitList(value.trim());
  return list.length ? list : [unescapeValue(value.trim())];
}

function equal(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (x === y) return true;
  const numeric = (text: string) => (text !== "" && /^-?\d+(\.\d+)?%?$/.test(text) ? Number(text.replace("%", "")) : NaN);
  return Math.abs(numeric(x) - numeric(y)) < 1e-9 && x.endsWith("%") === y.endsWith("%");
}
