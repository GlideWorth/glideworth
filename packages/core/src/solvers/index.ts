/**
 * Goal-seek solvers, guardrails, withdrawal rules, sensitivity and tax-strategy search.
 * Owner: workstream (d). All solvers are async so callers can farm Monte Carlo evaluations out to
 * workers via `SolverDeps.evaluate`.
 */
export * from "./contracts.js";
export {
  goalSeek,
  SWR_EXPENSE_ID,
  solveEarliestRetirement,
  solveMaxSpending,
  solveRequiredPortfolio,
  solveRequiredSavings,
  solveSafeWithdrawalRate,
} from "./goal-seek.js";
export * from "./guardrails.js";
export * from "./sensitivity.js";
export * from "./roth-conversion-plan.js";
export * from "./tax-strategy.js";
export {
  applyVariable,
  isScalableFlow,
  milestoneAtMonthPatch,
  planStartMonth,
  scalableFlowIds,
} from "./variables.js";
export * from "./withdrawal-rules.js";
