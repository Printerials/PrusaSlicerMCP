import { splitList, unescapeValue, type FlatConfig } from "../formats/ini.ts";

export interface OverrideCheck {
  /** The G-code config shows the requested value. */
  confirmed: string[];
  /** The G-code config still shows the value from before: PrusaSlicer did not apply it. */
  ignored: Array<{ key: string; requested: string; found: string }>;
  /** The G-code config has no such key, or a value that is neither. Reported, not refused. */
  unverified: Array<{ key: string; requested: string; found: string | null }>;
}

/**
 * Compares requested overrides with the config PrusaSlicer wrote into the G-code. 3.0 ignores
 * settings it does not take without an error, so a result must show them. Only a value equal to
 * the old one counts as ignored: the alpha14 header is not faithful for every key (retract_lift
 * reads 0 whatever the config says), so a value that is neither is left as unverified.
 */
export function checkOverrides(requested: ReadonlyMap<string, string>, before: FlatConfig, gcode: FlatConfig): OverrideCheck {
  const check: OverrideCheck = { confirmed: [], ignored: [], unverified: [] };
  for (const [key, want] of requested) {
    const found = gcode.get(key);
    if (found === undefined) {
      check.unverified.push({ key, requested: want, found: null });
    } else if (same(found, want)) {
      check.confirmed.push(key);
    } else if (before.has(key) && same(found, before.get(key)!)) {
      check.ignored.push({ key, requested: want, found });
    } else {
      check.unverified.push({ key, requested: want, found });
    }
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
  return numeric(x) === numeric(y) && x.endsWith("%") === y.endsWith("%");
}
