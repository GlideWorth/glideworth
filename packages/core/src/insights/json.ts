/** Small JSON helpers shared by patching, diffing and explanations. */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural equality for JSON-like values. `undefined` object members count as absent. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!(k in b) || !deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** Deep clone of JSON-like data (drops `undefined` members, like JSON). */
export function clone<T>(v: T): T {
  if (v === undefined) return v;
  return structuredClone(v);
}

/** Array of objects that all carry a unique string `id`. */
export function isIdKeyedArray(v: unknown): v is { id: string }[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  const seen = new Set<string>();
  for (const e of v) {
    if (!isPlainObject(e) || typeof e.id !== "string" || seen.has(e.id)) return false;
    seen.add(e.id);
  }
  return true;
}
