/** Solver contracts (schemas + types). Owner: workstream (d). */
import { z } from "zod";
import type { ProjectionResult, SimulationInput } from "../engine/types.js";
import { PatchOp } from "../schema/changes.js";
import { MonteCarloSettings } from "../schema/montecarlo.js";
import { Amount, Fraction, Id } from "../schema/primitives.js";
import type { MonteCarloResult } from "../stochastic/types.js";

export const SolverVariable = z
  .discriminatedUnion("kind", [
    /** Scale spending (all, or listed expense ids) by a factor. */
    z.object({ kind: z.literal("spendingScale"), expenseIds: z.array(Id).optional() }),
    /** Move a milestone (retirement) to an absolute month offset from plan start. */
    z.object({ kind: z.literal("milestoneMonth"), milestoneId: Id }),
    /** Scale a contribution flow's amount. */
    z.object({ kind: z.literal("flowScale"), flowId: Id }),
    /** Any numeric field by JSON pointer (with [id=..] segments), relative to the plan. */
    z.object({ kind: z.literal("path"), path: z.string() }),
    /**
     * Scale starting balances (default: every non-cash account) by a factor. Used for "required
     * portfolio size". Changes starting conditions, so the result carries no plan patch for live plans.
     */
    z.object({ kind: z.literal("balanceScale"), accountIds: z.array(Id).optional() }),
  ])
  .meta({ id: "SolverVariable" });
export type SolverVariable = z.infer<typeof SolverVariable>;

export const SolverObjective = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("successRate"), target: Fraction }),
    z.object({ kind: z.literal("noShortfall") }),
    z.object({ kind: z.literal("endNetWorth"), target: Amount }),
  ])
  .meta({ id: "SolverObjective" });
export type SolverObjective = z.infer<typeof SolverObjective>;

export const GoalSeekRequest = z
  .object({
    variable: SolverVariable,
    objective: SolverObjective,
    /** maximize: find the largest value meeting the objective (spending); minimize: smallest (retirement date). */
    direction: z.enum(["maximize", "minimize"]),
    bounds: z.object({ min: z.number(), max: z.number() }),
    /** Absolute tolerance in the variable's units (milestone months are integers: at least 1). */
    tolerance: z.number().positive().default(0.001),
    maxEvaluations: z.number().int().min(1).max(200).default(30),
    monteCarlo: MonteCarloSettings.optional(),
    /**
     * Neighbouring objective targets to re-solve for the sensitivity band, as deltas
     * (e.g. [-0.05, 0.05] -> 75% and 85% around an 80% target). Re-uses cached evaluations.
     */
    sensitivityDeltas: z.array(z.number()).optional(),
  })
  .meta({ id: "GoalSeekRequest" });
export type GoalSeekRequest = z.infer<typeof GoalSeekRequest>;
export type GoalSeekRequestInput = z.input<typeof GoalSeekRequest>;

export const GoalSeekStatus = z
  .enum([
    /** Bracketed and narrowed to within tolerance. */
    "solved",
    /** The objective is met across the whole search range; `value` is the most favourable bound. */
    "at-bound",
    /** The objective is not met anywhere in the range; `value` is null. */
    "infeasible",
    /** Ran out of evaluations; `value` is the best feasible value found. */
    "max-evaluations",
  ])
  .meta({ id: "GoalSeekStatus" });
export type GoalSeekStatus = z.infer<typeof GoalSeekStatus>;

export const GoalSeekResult = z
  .object({
    converged: z.boolean(),
    value: z.number().nullable(),
    /** Objective metric at `value` (success rate, end net worth...). */
    achieved: z.number().nullable(),
    evaluations: z.array(z.object({ value: z.number(), metric: z.number() })),
    /** Same answer at neighbouring targets, e.g. success 75/80/85%. */
    sensitivity: z.array(z.object({ label: z.string(), value: z.number().nullable() })).default([]),
    explanation: z.string(),
    status: GoalSeekStatus.optional(),
    /** Final bracket: largest-known feasible and smallest-known infeasible values. */
    bracket: z
      .object({ feasible: z.number().nullable(), infeasible: z.number().nullable() })
      .optional(),
    /** Plan patch that applies the answer (absent when the variable is not a plan field). */
    patch: z.array(PatchOp).optional(),
    /** Monte Carlo seed used for every evaluation (common random numbers). */
    seed: z.number().int().nullable().optional(),
    /** Money / date rendering of the answer for display, e.g. { annualSpendingReal: 41200 }. */
    details: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).optional(),
  })
  .meta({ id: "GoalSeekResult" });
export type GoalSeekResult = z.infer<typeof GoalSeekResult>;

export interface SolverProgress {
  value: number;
  metric: number;
  feasible: boolean;
  bracket: { feasible: number | null; infeasible: number | null };
}

export interface SolverDeps {
  /**
   * Override how a candidate input is scored by Monte Carlo (e.g. parallel MC in workers). The
   * candidate's `plan.monteCarlo` carries the settings to use, with a FIXED seed so every candidate
   * sees the same market paths (common random numbers -> monotone, noise-free objective).
   */
  evaluate?: (input: SimulationInput) => Promise<MonteCarloResult>;
  /** Deterministic engine override (defaults to core `simulate`). */
  simulate?: (input: SimulationInput) => ProjectionResult;
  signal?: AbortSignal;
  onProgress?: (evaluations: number, progress?: SolverProgress) => void;
}

/** Seed used when settings.seed is null: solvers need common random numbers across candidates. */
export const DEFAULT_SOLVER_SEED = 20_260_101;
