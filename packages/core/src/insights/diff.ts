/**
 * Structural, id-aware plan diff.
 *
 * Patch shape (deterministic, and robust when re-applied to a parent that has since changed):
 *   1. removals of entities that disappeared:        remove /expenses/[id=x]
 *   2. field edits inside entities that persist:     replace /income/[id=sal]/amount/value
 *   3. additions, appended:                          add /expenses/- {...}
 *   4. reorders, by id (only when order differs):    move /flows/[id=f] -> /flows/2
 * Arrays of entities (objects with unique ids) are matched by id; other arrays are diffed
 * position-by-position when their lengths match and replaced wholesale otherwise. Objects whose
 * discriminator (`kind` / `type` / `mode`) changes are replaced wholesale.
 */
import { ScenarioError } from "../errors.js";
import type { PatchOp, PlanChange, PlanDiff } from "../schema/changes.js";
import type { Plan } from "../schema/plan.js";
import { type DescribeInput, describeChange } from "./describe.js";
import type { FormatContext } from "./format.js";
import { deepEqual, isIdKeyedArray, isPlainObject } from "./json.js";
import { PLAN_META_KEYS } from "./patch.js";
import { formatPointer, type Segment } from "./pointer.js";

const DISCRIMINATORS = ["kind", "type", "mode", "op"];

export interface DiffOptions {
  /** Top-level keys to ignore. */
  ignoreKeys?: readonly string[];
}

/** Generic JSON diff producing an RFC 6902 patch (with `[id=..]` segments) from a to b. */
export function diffJson(a: unknown, b: unknown, opts: DiffOptions = {}): PatchOp[] {
  const ops: PatchOp[] = [];
  const ignore = new Set(opts.ignoreKeys ?? []);
  if (isPlainObject(a) && isPlainObject(b)) diffObject(a, b, [], ops, ignore);
  else diffValue(a, b, [], ops);
  return ops;
}

function diffValue(a: unknown, b: unknown, path: Segment[], ops: PatchOp[]): void {
  if (deepEqual(a, b)) return;
  if (isPlainObject(a) && isPlainObject(b)) {
    const switched = DISCRIMINATORS.some((d) => d in a && d in b && a[d] !== b[d]);
    if (!switched) {
      diffObject(a, b, path, ops, new Set());
      return;
    }
  } else if (Array.isArray(a) && Array.isArray(b)) {
    const idKeyed =
      (isIdKeyedArray(a) || a.length === 0) &&
      (isIdKeyedArray(b) || b.length === 0) &&
      a.length + b.length > 0;
    if (idKeyed) {
      diffIdArray(a as { id: string }[], b as { id: string }[], path, ops);
      return;
    }
    if (a.length === b.length) {
      for (let i = 0; i < a.length; i++)
        diffValue(a[i], b[i], [...path, { kind: "key", key: String(i) }], ops);
      return;
    }
  }
  ops.push({ op: "replace", path: formatPointer(path), value: b });
}

function diffObject(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  path: Segment[],
  ops: PatchOp[],
  ignore: Set<string>,
): void {
  for (const k of Object.keys(a)) {
    if (ignore.has(k) || a[k] === undefined) continue;
    const p = [...path, { kind: "key" as const, key: k }];
    if (!(k in b) || b[k] === undefined) ops.push({ op: "remove", path: formatPointer(p) });
    else diffValue(a[k], b[k], p, ops);
  }
  for (const k of Object.keys(b)) {
    if (ignore.has(k) || b[k] === undefined) continue;
    if (!(k in a) || a[k] === undefined)
      ops.push({ op: "add", path: formatPointer([...path, { kind: "key", key: k }]), value: b[k] });
  }
}

function diffIdArray(
  a: { id: string }[],
  b: { id: string }[],
  path: Segment[],
  ops: PatchOp[],
): void {
  const bIds = new Set(b.map((e) => e.id));
  const aById = new Map(a.map((e) => [e.id, e]));
  for (const e of a)
    if (!bIds.has(e.id))
      ops.push({ op: "remove", path: formatPointer([...path, { kind: "id", id: e.id }]) });
  for (const e of b) {
    const before = aById.get(e.id);
    if (before) diffValue(before, e, [...path, { kind: "id", id: e.id }], ops);
  }
  const work = a.filter((e) => bIds.has(e.id)).map((e) => e.id);
  for (const e of b)
    if (!aById.has(e.id)) {
      ops.push({ op: "add", path: formatPointer([...path, { kind: "key", key: "-" }]), value: e });
      work.push(e.id);
    }
  for (let i = 0; i < b.length; i++) {
    const id = b[i]!.id;
    if (work[i] === id) continue;
    const from = work.indexOf(id);
    work.splice(from, 1);
    work.splice(i, 0, id);
    ops.push({
      op: "move",
      from: formatPointer([...path, { kind: "id", id }]),
      path: formatPointer([...path, { kind: "key", key: String(i) }]),
    });
  }
}

export interface PlanDiffOptions extends FormatContext {
  /** Include PlanChange entries for reorders of arrays whose order has no meaning (default false). */
  includeCosmeticMoves?: boolean;
}

/**
 * Structural diff of two plans, with a patch turning `base` into `other`.
 * Identity fields (id, householdId, version, timestamps, lineage, isMain, status) are ignored, so
 * `applyPlanPatch(base, diff.patch)` equals `other` except for those fields. This is exactly the
 * patch a branch stores over its parent.
 */
/**
 * Names of a household's accounts, real assets and debts by id, for `PlanDiffOptions.entities`. Plans refer to
 * them by id only (account settings, drawdown order), so without this a change reads "Plan overrides added for
 * account 78ec00a3-…".
 */
export function financeNames(finances: {
  accounts?: ReadonlyArray<{ id: string; name: string }>;
  realAssets?: ReadonlyArray<{ id: string; name: string }>;
  debts?: ReadonlyArray<{ id: string; name: string }>;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of [
    ...(finances.accounts ?? []),
    ...(finances.realAssets ?? []),
    ...(finances.debts ?? []),
  ])
    if (e.name) out[e.id] = e.name;
  return out;
}

export function diffPlans(base: Plan, other: Plan, opts: PlanDiffOptions = {}): PlanDiff {
  if (base.householdId !== other.householdId)
    throw new ScenarioError("the two plans belong to different households and cannot be compared", {
      baseHouseholdId: base.householdId,
      otherHouseholdId: other.householdId,
    });
  const patch = diffJson(base, other, { ignoreKeys: PLAN_META_KEYS });
  const ctx: DescribeInput = {
    base,
    other,
    format: {
      ...opts,
      milestones: {
        ...Object.fromEntries(base.milestones.map((m) => [m.id, m.name])),
        ...Object.fromEntries(other.milestones.map((m) => [m.id, m.name])),
        ...opts.milestones,
      },
    },
  };
  const changes: PlanChange[] = [];
  for (const op of patch) {
    const c = describeChange(op, ctx);
    if (!c) continue;
    if (
      c.kind === "moved" &&
      !opts.includeCosmeticMoves &&
      c.entity.type !== "flow" &&
      !c.path.startsWith("/drawdown")
    )
      continue;
    // One readable change can take several ops (a withdrawal rule's kind and its date): list it once.
    if (changes.some((d) => d.description === c.description)) continue;
    changes.push(c);
  }
  return { basePlanId: base.id, otherPlanId: other.id, changes, patch };
}
