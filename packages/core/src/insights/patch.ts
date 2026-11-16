/**
 * RFC 6902 JSON Patch with `[id=...]` array addressing, plus exact inverse patches for undo/redo.
 *
 * Semantics of the `[id=x]` extension:
 *   - remove / replace / test / move-from: the array element whose `id` is x (error if absent).
 *   - add `/arr/[id=x]`: appends the value when no element has id x (value.id must equal x);
 *     error if one already exists. Prefer `/arr/-` for plain appends.
 *   - intermediate segments (`/income/[id=x]/amount`) select the element by id.
 *
 * Every failure (missing target, failed `test`, malformed path) throws PatchConflictError so the
 * API can map it to 409 and the UI can tell the user the plan moved underneath the change.
 */
import { GlideworthError, ScenarioError, ValidationError } from "../errors.js";
import type { PatchOp } from "../schema/changes.js";
import { Plan, type PlanInput } from "../schema/plan.js";
import { clone, deepEqual, isPlainObject } from "./json.js";
import { formatPointer, isUnsafeKey, parsePointer, type Segment } from "./pointer.js";

export class PatchConflictError extends GlideworthError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("PATCH_CONFLICT", message, details);
    this.name = "PatchConflictError";
  }
}

type Container = unknown[] | Record<string, unknown>;

interface Located {
  container: Container;
  /** Array index (arrays) or key (objects). For an add past the end, index === length. */
  key: number | string;
  exists: boolean;
  /** Stable pointer to the parent container. */
  parentPath: string;
}

function fail(message: string, op: PatchOp, opIndex: number): never {
  throw new PatchConflictError(message, { op, opIndex });
}

/** Own (never inherited) member of a plain object. */
function hasOwnMember(obj: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(obj, key) && obj[key] !== undefined;
}

/**
 * Refuse values that carry a prototype-polluting key anywhere inside them (`{"__proto__": ...}`
 * parsed from JSON is an own key and would be written through by a later assignment).
 */
function assertSafeValue(value: unknown, op: PatchOp, opIndex: number, depth = 0): void {
  if (depth > 200) fail("patch value is nested too deeply", op, opIndex);
  if (Array.isArray(value)) {
    for (const v of value) assertSafeValue(v, op, opIndex, depth + 1);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const k of Object.keys(value)) {
    if (isUnsafeKey(k)) {
      throw new ValidationError(`patch value contains the forbidden key '${k}'`, {
        op,
        opIndex,
        key: k,
      });
    }
    assertSafeValue((value as Record<string, unknown>)[k], op, opIndex, depth + 1);
  }
}

function descend(root: unknown, segments: Segment[], op: PatchOp, opIndex: number): unknown {
  let cur = root;
  for (const s of segments) {
    if (Array.isArray(cur)) {
      const idx = arrayIndex(cur, s, false);
      if (idx === null || idx >= cur.length)
        fail(`path not found at ${formatPointer([s])}`, op, opIndex);
      cur = cur[idx];
    } else if (isPlainObject(cur)) {
      if (s.kind === "id") fail(`[id=${s.id}] used on an object`, op, opIndex);
      if (!hasOwnMember(cur, s.key)) fail(`path not found at /${s.key}`, op, opIndex);
      cur = cur[s.key];
    } else fail("path traverses a scalar", op, opIndex);
  }
  return cur;
}

/** Index for a segment in an array; `forAdd` allows '-' and index === length. */
function arrayIndex(arr: unknown[], s: Segment, forAdd: boolean): number | null {
  if (s.kind === "id") {
    const i = arr.findIndex((e) => isPlainObject(e) && e.id === s.id);
    if (i >= 0) return i;
    return forAdd ? arr.length : null;
  }
  if (s.key === "-") return forAdd ? arr.length : null;
  if (!/^(0|[1-9]\d*)$/.test(s.key)) return null;
  const i = Number(s.key);
  if (i > arr.length || (!forAdd && i === arr.length)) return null;
  return i;
}

function locate(
  root: unknown,
  path: string,
  forAdd: boolean,
  op: PatchOp,
  opIndex: number,
): Located {
  let segments: Segment[];
  try {
    segments = parsePointer(path);
  } catch (e) {
    if ((e as Error).name === "UnsafePointerError")
      throw new ValidationError((e as Error).message, { op, opIndex, path });
    fail((e as Error).message, op, opIndex);
  }
  if (segments.length === 0) fail("operations on the document root are not supported", op, opIndex);
  const parentSegs = segments.slice(0, -1);
  const last = segments[segments.length - 1]!;
  const container = descend(root, parentSegs, op, opIndex);
  const parentPath = formatPointer(parentSegs);
  if (Array.isArray(container)) {
    if (forAdd && last.kind === "id" && container.some((e) => isPlainObject(e) && e.id === last.id))
      fail(`an element with id '${last.id}' already exists`, op, opIndex);
    const idx = arrayIndex(container, last, forAdd);
    if (idx === null) fail(`array element ${formatPointer([last])} not found`, op, opIndex);
    return { container, key: idx, exists: idx < container.length, parentPath };
  }
  if (isPlainObject(container)) {
    if (last.kind === "id") fail(`[id=${last.id}] used on an object`, op, opIndex);
    return {
      container,
      key: last.key,
      exists: hasOwnMember(container, last.key),
      parentPath,
    };
  }
  return fail("parent of the target is not a container", op, opIndex);
}

/** Pointer to a located element, preferring `[id=..]` for array elements that carry an id. */
function stablePath(loc: Located): string {
  if (Array.isArray(loc.container)) {
    const el = loc.container[loc.key as number];
    if (isPlainObject(el) && typeof el.id === "string") {
      const id = el.id;
      const unique = loc.container.filter((e) => isPlainObject(e) && e.id === id).length === 1;
      if (unique) return `${loc.parentPath}/[id=${id}]`;
    }
    return `${loc.parentPath}/${loc.key}`;
  }
  return loc.parentPath + formatPointer([{ kind: "key", key: loc.key as string }]);
}

function indexPath(loc: Located): string {
  return Array.isArray(loc.container)
    ? `${loc.parentPath}/${loc.key}`
    : loc.parentPath + formatPointer([{ kind: "key", key: loc.key as string }]);
}

function getAt(loc: Located): unknown {
  return Array.isArray(loc.container)
    ? loc.container[loc.key as number]
    : (loc.container as Record<string, unknown>)[loc.key as string];
}

function removeAt(loc: Located): unknown {
  if (Array.isArray(loc.container)) return loc.container.splice(loc.key as number, 1)[0];
  const obj = loc.container as Record<string, unknown>;
  const v = obj[loc.key as string];
  delete obj[loc.key as string];
  return v;
}

function insertAt(loc: Located, value: unknown): void {
  if (Array.isArray(loc.container)) loc.container.splice(loc.key as number, 0, value);
  else (loc.container as Record<string, unknown>)[loc.key as string] = value;
}

export interface ApplyPatchResult<T> {
  result: T;
  /** Ops that undo the patch when applied to `result` (exact, including array positions). */
  inverse: PatchOp[];
}

/**
 * Apply a patch to any JSON document (no schema validation). Pure: the input is not mutated.
 * Returns the patched document and its inverse patch.
 */
export function applyPatchWithInverse<T>(doc: T, ops: readonly PatchOp[]): ApplyPatchResult<T> {
  const root = clone(doc) as unknown;
  const inverse: PatchOp[] = [];
  ops.forEach((op, opIndex) => {
    if ("value" in op) assertSafeValue(op.value, op, opIndex);
    switch (op.op) {
      case "add": {
        if (op.value === undefined) fail("add requires a value", op, opIndex);
        const loc = locate(root, op.path, true, op, opIndex);
        const value = clone(op.value);
        if (Array.isArray(loc.container)) {
          const segs = parsePointer(op.path);
          const last = segs[segs.length - 1]!;
          if (last.kind === "id" && (!isPlainObject(value) || value.id !== last.id))
            fail(`added value must have id '${last.id}'`, op, opIndex);
          insertAt(loc, value);
          inverse.push({ op: "remove", path: stablePath({ ...loc, exists: true }) });
        } else {
          const old = loc.exists ? getAt(loc) : undefined;
          insertAt(loc, value);
          inverse.push(
            loc.exists
              ? { op: "replace", path: indexPath(loc), value: old }
              : { op: "remove", path: indexPath(loc) },
          );
        }
        break;
      }
      case "remove": {
        const loc = locate(root, op.path, false, op, opIndex);
        if (!loc.exists) fail("remove target does not exist", op, opIndex);
        const old = removeAt(loc);
        inverse.push({ op: "add", path: indexPath(loc), value: old });
        break;
      }
      case "replace": {
        if (op.value === undefined) fail("replace requires a value", op, opIndex);
        const loc = locate(root, op.path, false, op, opIndex);
        if (!loc.exists) fail("replace target does not exist", op, opIndex);
        const old = getAt(loc);
        if (Array.isArray(loc.container)) loc.container[loc.key as number] = clone(op.value);
        else (loc.container as Record<string, unknown>)[loc.key as string] = clone(op.value);
        inverse.push({ op: "replace", path: stablePath(loc), value: old });
        break;
      }
      case "move": {
        if (op.path === op.from) break;
        if (op.path.startsWith(`${op.from}/`)) fail("cannot move a value into itself", op, opIndex);
        const from = locate(root, op.from, false, op, opIndex);
        if (!from.exists) fail("move source does not exist", op, opIndex);
        const value = removeAt(from);
        const to = locate(root, op.path, true, op, opIndex);
        if (!Array.isArray(to.container) && to.exists) {
          // RFC: add over an existing member replaces it; keep it in the inverse.
          const displaced = getAt(to);
          insertAt(to, value);
          // Inverse ops are reversed at the end: the move back runs first, then the restore.
          inverse.push({ op: "add", path: indexPath(to), value: displaced });
          inverse.push({
            op: "move",
            from: stablePath({ ...to, exists: true }),
            path: indexPath(from),
          });
        } else {
          insertAt(to, value);
          inverse.push({
            op: "move",
            from: stablePath({ ...to, exists: true }),
            path: indexPath(from),
          });
        }
        break;
      }
      case "test": {
        const loc = locate(root, op.path, false, op, opIndex);
        if (!loc.exists || !deepEqual(getAt(loc), op.value))
          fail(`test failed at ${op.path}`, op, opIndex);
        break;
      }
    }
  });
  return { result: root as T, inverse: inverse.reverse() };
}

/** Apply a patch to any JSON document (no schema validation). */
export function applyPatch<T>(doc: T, ops: readonly PatchOp[]): T {
  return applyPatchWithInverse(doc, ops).result;
}

/** Inverse of `ops` relative to `doc` (apply it to the patched result to get `doc` back). */
export function invertPatch<T>(doc: T, ops: readonly PatchOp[]): PatchOp[] {
  return applyPatchWithInverse(doc, ops).inverse;
}

function validatePlan(raw: unknown): Plan {
  const parsed = Plan.safeParse(raw);
  if (!parsed.success)
    throw new ValidationError("patched plan is invalid", { issues: parsed.error.issues });
  return parsed.data;
}

/**
 * Apply RFC 6902 ops (with `[id=...]` segments) to a plan and validate the result.
 * @throws PatchConflictError when an op cannot be applied, ValidationError when the result is invalid.
 */
export function applyPlanPatch(plan: Plan | PlanInput, ops: readonly PatchOp[]): Plan {
  return validatePlan(applyPatch(plan, ops));
}

/** Like applyPlanPatch, but also returns the inverse patch for undo (and `ops` serve as redo). */
export function applyPlanPatchWithInverse(
  plan: Plan,
  ops: readonly PatchOp[],
): { plan: Plan; inverse: PatchOp[] } {
  const { result, inverse } = applyPatchWithInverse(plan, ops);
  return { plan: validatePlan(result), inverse };
}

/** Fields of a branch that always come from the branch itself, never from its parent or patch. */
export const PLAN_META_KEYS = [
  "id",
  "householdId",
  "version",
  "createdAt",
  "updatedAt",
  "lineage",
  "isMain",
  "status",
] as const;

export type PlanLookup = (id: string, pinnedVersion: number | null) => Plan | undefined;

/**
 * Resolve a branch plan: the parent's materialised body + the branch's lineage patch, with the
 * branch's own identity fields (PLAN_META_KEYS). Plans without lineage are returned unchanged.
 * `lookup` receives the pinned parent version (null = latest) so the API can serve history.
 * @throws ScenarioError on a missing parent or a lineage cycle; PatchConflictError if the patch no
 *         longer applies to the parent.
 */
export function materializePlan(plan: Plan, lookup: PlanLookup): Plan {
  return materialize(plan, lookup, new Set());
}

function materialize(plan: Plan, lookup: PlanLookup, seen: Set<string>): Plan {
  if (!plan.lineage) return plan;
  if (seen.has(plan.id))
    throw new ScenarioError("plan lineage contains a cycle", { planId: plan.id });
  seen.add(plan.id);
  const parentRaw = lookup(plan.lineage.parentPlanId, plan.lineage.parentVersion);
  if (!parentRaw)
    throw new ScenarioError(`parent plan '${plan.lineage.parentPlanId}' not found`, {
      planId: plan.id,
      parentPlanId: plan.lineage.parentPlanId,
    });
  const parent = materialize(parentRaw, lookup, seen);
  const body = applyPatch(parent, plan.lineage.patch) as Record<string, unknown>;
  for (const k of PLAN_META_KEYS) {
    const v = (plan as Record<string, unknown>)[k];
    if (v === undefined) delete body[k];
    else body[k] = clone(v);
  }
  return validatePlan(body);
}
