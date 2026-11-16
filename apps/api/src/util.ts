import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./errors.js";

/** JSON with sorted keys: equal values hash equally regardless of key order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    }
    return v;
  });
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const hashOf = (value: unknown): string => sha256(stableStringify(value ?? null));

export const newId = (prefix: string): string =>
  `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
export const nowIso = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------------------------
// Pagination: `limit` + opaque `cursor`. Responses are `{ items, nextCursor }`.
// ---------------------------------------------------------------------------------------------
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("Page size (1-200)."),
  cursor: z.string().max(200).optional().describe("Opaque cursor from a previous response."),
});
export type PageQuery = z.infer<typeof PageQuery>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export function paginate<T>(all: T[], q: { limit?: number; cursor?: string | undefined }): Page<T> {
  const limit = q.limit ?? 50;
  let offset = 0;
  if (q.cursor) {
    const n = Number(Buffer.from(q.cursor, "base64url").toString("utf8"));
    if (!Number.isInteger(n) || n < 0) throw new ApiError(400, "VALIDATION", "invalid cursor");
    offset = n;
  }
  const items = all.slice(offset, offset + limit);
  const next =
    offset + limit < all.length ? Buffer.from(String(offset + limit)).toString("base64url") : null;
  return { items, nextCursor: next, total: all.length };
}

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable(), total: z.number().int() });

// ---------------------------------------------------------------------------------------------
// JSON Merge Patch (RFC 7386): null deletes a key; objects merge recursively; arrays replace.
// ---------------------------------------------------------------------------------------------
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base: Record<string, unknown> =
    target && typeof target === "object" && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue; // never address prototypes
    if (v === null) delete base[k];
    else base[k] = mergePatch(base[k], v);
  }
  return base;
}

// ---------------------------------------------------------------------------------------------
// Pointer reads with the `[id=...]` extension (see @glideworth/core PatchOp).
// ---------------------------------------------------------------------------------------------
export function readPointer(root: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return root;
  const segs = pointer
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = root;
  for (const seg of segs) {
    if (cur === null || cur === undefined) return undefined;
    const idm = /^\[id=(.+)\]$/.exec(seg);
    if (Array.isArray(cur)) {
      if (idm)
        cur = cur.find((e) => e && typeof e === "object" && (e as { id?: unknown }).id === idm[1]);
      else cur = cur[Number(seg)];
    } else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

/** Cheap deep clone for plain JSON values. */
export const clone = <T>(v: T): T => structuredClone(v);
