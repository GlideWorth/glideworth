/** Plan branching helpers: create a branch, re-derive its patch after an edit, rebase onto a new parent. */
import type { PatchOp } from "../schema/changes.js";
import type { Plan } from "../schema/plan.js";
import { diffJson } from "./diff.js";
import { clone } from "./json.js";
import { applyPlanPatch, PLAN_META_KEYS } from "./patch.js";

export interface CreateBranchOptions {
  id: string;
  name: string;
  /** Edits relative to the parent (default none). */
  patch?: PatchOp[];
  /** Pin to the parent's current version instead of following its latest (default false). */
  pin?: boolean;
  description?: string;
}

/**
 * Create a branch of `parent`: a plan whose `lineage.patch` holds only its differences. The body is
 * the materialised cache (parent + patch), so the branch is immediately simulatable.
 */
export function createBranch(parent: Plan, opts: CreateBranchOptions): Plan {
  const patch: PatchOp[] = [
    { op: "replace", path: "/name", value: opts.name },
    ...(opts.description !== undefined
      ? [{ op: "add", path: "/description", value: opts.description } satisfies PatchOp]
      : []),
    ...(opts.patch ?? []),
  ];
  const body = applyPlanPatch(parent, patch);
  // Re-derive the minimal patch so stored lineage is canonical.
  const canonical = branchPatch(parent, body);
  return {
    ...body,
    id: opts.id,
    householdId: parent.householdId,
    isMain: false,
    status: "active",
    version: 0,
    lineage: {
      parentPlanId: parent.id,
      parentVersion: opts.pin ? parent.version : null,
      patch: canonical,
    },
  };
}

/** Canonical patch turning `parentBody` into `branchBody` (identity fields ignored). */
export function branchPatch(parentBody: Plan, branchBody: Plan): PatchOp[] {
  return diffJson(parentBody, branchBody, { ignoreKeys: PLAN_META_KEYS });
}

/**
 * After the user edits a branch's materialised body, recompute its lineage patch against the
 * parent's materialised body. Returns the branch with updated body and lineage.
 */
export function updateBranch(branch: Plan, edited: Plan, parentBody: Plan): Plan {
  if (!branch.lineage) return edited;
  return {
    ...clone(edited),
    lineage: { ...branch.lineage, patch: branchPatch(parentBody, edited) },
  };
}

/**
 * Detach a branch: it keeps its current body and stops inheriting (lineage removed).
 */
export function detachBranch(branch: Plan): Plan {
  const { lineage: _lineage, ...rest } = branch;
  return rest as Plan;
}

/** Promote a branch's changes into the parent ("merge"): returns the new parent body. */
export function mergeBranchIntoParent(parent: Plan, branch: Plan): Plan {
  if (!branch.lineage) return parent;
  const ops = branch.lineage.patch.filter(
    (op) => op.path !== "/name" && op.path !== "/description",
  );
  return applyPlanPatch(parent, ops);
}
