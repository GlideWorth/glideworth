/** Defensive readers for untrusted JSON. Nothing here throws; callers decide what a miss means. */

export type Json = unknown;
export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function obj(v: unknown): Obj {
  return isObj(v) ? v : {};
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/** `pct(8)` = 0.08. ProjectionLab stores rates as percentages. */
export function pct(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : n / 100;
}

/** Round away binary noise from `x / 100` style conversions (0.07 not 0.07000000000000001). */
export function clean(n: number): number {
  return Math.round(n * 1e10) / 1e10;
}

export function pctClean(v: unknown): number | undefined {
  const n = pct(v);
  return n === undefined ? undefined : clean(n);
}

export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (isObj(val)) {
      const out: Obj = {};
      for (const k of Object.keys(val).sort()) out[k] = val[k];
      return out;
    }
    return val;
  });
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}
