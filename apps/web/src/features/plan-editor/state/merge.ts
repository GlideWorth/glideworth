/**
 * Three-way merge used when a save hits HTTP 409 (someone else saved first).
 *
 *   base   = the version our edits started from
 *   mine   = our local draft
 *   theirs = the latest version on the server
 *
 * Objects merge key by key. Arrays of entities (objects with a string `id`) merge by id, so two
 * people adding different income events both survive. Anything both sides changed differently is
 * a conflict: we keep "mine" and report the JSON path so the UI can list it.
 */

type Json = unknown;

export interface MergeResult<T> {
  value: T;
  conflicts: string[];
}

export function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as Json[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ao = a as Record<string, Json>;
  const bo = b as Record<string, Json>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => deepEqual(ao[k], bo[k]));
}

const isObj = (v: Json): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isEntityArray = (v: Json): v is { id: string }[] =>
  Array.isArray(v) && v.every((x) => isObj(x) && typeof x.id === "string");

export function merge3<T>(base: T, mine: T, theirs: T, path = ""): MergeResult<T> {
  if (deepEqual(mine, theirs)) return { value: mine, conflicts: [] };
  if (deepEqual(base, mine)) return { value: theirs, conflicts: [] };
  if (deepEqual(base, theirs)) return { value: mine, conflicts: [] };

  if (isObj(base) && isObj(mine) && isObj(theirs)) {
    const out: Record<string, Json> = {};
    const conflicts: string[] = [];
    const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)]);
    for (const k of keys) {
      const r = merge3(base[k], mine[k], theirs[k], `${path}/${k}`);
      conflicts.push(...r.conflicts);
      if (r.value !== undefined) out[k] = r.value;
    }
    return { value: out as T, conflicts };
  }

  if (isEntityArray(mine) && isEntityArray(theirs) && (base === undefined || isEntityArray(base))) {
    return mergeEntityArrays(
      (base ?? []) as { id: string }[],
      mine,
      theirs,
      path,
    ) as unknown as MergeResult<T>;
  }

  return { value: mine, conflicts: [path || "/"] };
}

function mergeEntityArrays(
  base: { id: string }[],
  mine: { id: string }[],
  theirs: { id: string }[],
  path: string,
): MergeResult<{ id: string }[]> {
  const b = new Map(base.map((x) => [x.id, x]));
  const m = new Map(mine.map((x) => [x.id, x]));
  const t = new Map(theirs.map((x) => [x.id, x]));
  const conflicts: string[] = [];
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  const shared = (xs: string[]) => xs.filter((id) => b.has(id));
  const mineReordered = !deepEqual(
    shared(ids(mine)),
    shared(ids(base)).filter((id) => m.has(id)),
  );
  const theirsReordered = !deepEqual(
    shared(ids(theirs)),
    shared(ids(base)).filter((id) => t.has(id)),
  );
  const primary = mineReordered && !theirsReordered ? mine : theirs;
  const secondary = primary === mine ? theirs : mine;
  const order = [...ids(primary)];
  for (const id of ids(secondary)) if (!order.includes(id)) order.push(id);

  const out: { id: string }[] = [];
  for (const id of order) {
    const p = `${path}/[id=${id}]`;
    const bv = b.get(id);
    const mv = m.get(id);
    const tv = t.get(id);
    if (mv && tv) {
      const r = merge3(bv, mv, tv, p);
      conflicts.push(...r.conflicts);
      out.push(r.value as { id: string });
    } else if (mv && !tv) {
      // Deleted by them. Keep only if it is new on our side, or we changed it (conflict).
      if (!bv) out.push(mv);
      else if (!deepEqual(bv, mv)) {
        conflicts.push(p);
        out.push(mv);
      }
    } else if (!mv && tv) {
      if (!bv) out.push(tv);
      else if (!deepEqual(bv, tv)) conflicts.push(p); // we deleted, they edited: our delete wins
    }
  }
  return { value: out, conflicts };
}
