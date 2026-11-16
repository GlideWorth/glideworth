/**
 * Explainability, assumption audit, plan diff and patching. Owner: workstream (d).
 */

export * from "./analytics.js";
export * from "./audit.js";
export * from "./branch.js";
export * from "./contracts.js";
export * from "./crossborder.js";
export * from "./crossborder-explain.js";
export * from "./debt-payoff.js";
export { describeChange, fmtCriterion } from "./describe.js";
export { type DiffOptions, diffJson, diffPlans, type PlanDiffOptions } from "./diff.js";
export * from "./difference.js";
export * from "./explain.js";
export { type FormatContext, fmtAmount, fmtDateRef, fmtMoney, fmtPercent } from "./format.js";
export { deepEqual } from "./json.js";
export {
  type ApplyPatchResult,
  applyPatch,
  applyPatchWithInverse,
  applyPlanPatch,
  applyPlanPatchWithInverse,
  invertPatch,
  materializePlan,
  PatchConflictError,
  PLAN_META_KEYS,
  type PlanLookup,
} from "./patch.js";
export { formatPointer, parsePointer } from "./pointer.js";
export {
  type AccountReconcileRow,
  type ReconcileRow,
  reconcileYear,
  type YearReconciliation,
} from "./reconcile.js";
export * from "./scenarios.js";
