/**
 * Spending guardrails expressed in money the user can act on.
 *
 * Risk-based guardrails (Kitces / Income Lab style): keep the plan's chance of success inside
 * [lowerGuardrail, upperGuardrail]. We compute, from ONE shared set of market paths (fixed seed):
 *   - this year's recommended spending (hold, or cut/raise back to `targetSuccess`),
 *   - the portfolio values at which the success rate would cross each guardrail,
 *   - the spending to move to if the portfolio reaches either threshold.
 * No nested Monte Carlo: every evaluation is a whole-plan run on the same paths.
 *
 * Guyton-Klinger guardrails are rate-based and closed-form; `guytonKlingerGuardrails` converts them
 * into portfolio thresholds and spending changes.
 */
import { z } from "zod";
import { simulate as coreSimulate } from "../engine/simulate.js";
import { type SimulationInput, toBasis } from "../engine/types.js";
import { ScenarioError } from "../errors.js";
import { fmtMoney, fmtPercent } from "../insights/format.js";
import { PatchOp } from "../schema/changes.js";
import type { RiskGuardrails } from "../schema/strategies.js";
import { RiskGuardrails as RiskGuardrailsSchema } from "../schema/strategies.js";
import type { GoalSeekResult, SolverDeps } from "./contracts.js";
import { goalSeek } from "./goal-seek.js";
import { fixedSeedSettings, makeMetric } from "./search.js";
import {
  annualRecurringAmount,
  applyVariable,
  scaledBalance,
  scaledExpenses,
} from "./variables.js";

export const GuardrailsYear = z
  .object({
    year: z.number().int(),
    spendingReal: z.number(),
    successRate: z.number(),
    action: z.enum(["hold", "cut", "raise"]),
  })
  .meta({ id: "GuardrailsYear" });
export type GuardrailsYear = z.infer<typeof GuardrailsYear>;

export const GuardrailsThresholds = z
  .object({
    /** Investable (non-cash) portfolio today. */
    portfolio: z.number(),
    /** Annual spending in scope today (today's money). */
    spending: z.number(),
    /** Guardrail spending now (today's money); shown as "Guardrail spending". */
    recommendedSpending: z.number(),
    /** Below this portfolio value, success falls under the lower guardrail: cut to `cutTo`. */
    lowerPortfolio: z.number().nullable(),
    cutTo: z.number().nullable(),
    /** Above this portfolio value, success exceeds the upper guardrail: raise to `raiseTo`. */
    upperPortfolio: z.number().nullable(),
    raiseTo: z.number().nullable(),
    /** False when cutting in-scope spending to the floor still misses `targetSuccess`. */
    targetReachable: z.boolean().optional(),
  })
  .meta({ id: "GuardrailsThresholds" });
export type GuardrailsThresholds = z.infer<typeof GuardrailsThresholds>;

export const GuardrailsResult = z
  .object({
    /** "What the guardrail rules give now": this year's guardrail spending and why. */
    current: GuardrailsYear,
    path: z.array(GuardrailsYear),
    explanation: z.string(),
    thresholds: GuardrailsThresholds.optional(),
    /** Plan patch that applies the recommended spending now. */
    patch: z.array(PatchOp).optional(),
    /** Success rate of the plan as it stands. */
    currentSuccessRate: z.number().optional(),
    /**
     * False when the target cannot be reached by cutting in-scope spending alone (the
     * recommendation is then the deepest allowed cut, and `current.successRate` is what it reaches).
     */
    targetReachable: z.boolean().optional(),
    evaluations: z.number().int().optional(),
  })
  .meta({ id: "GuardrailsResult" });
export type GuardrailsResult = z.infer<typeof GuardrailsResult>;

export interface GuardrailsOptions {
  /** Evaluation budget per internal solve (default 14). */
  maxEvaluationsPerSolve?: number;
}

function scopeExpenseIds(input: SimulationInput, scope: RiskGuardrails["scope"]): string[] {
  const all = scaledExpenses(input.plan);
  const picked =
    scope === "discretionary"
      ? all.filter((e) => e.spendingType === "discretionary" || e.spendingType === "hybrid")
      : all;
  return picked.map((e) => e.id);
}

/** Risk-based guardrails evaluated from one shared simulation set. */
export async function evaluateGuardrails(
  input: SimulationInput,
  guardrailsInput: z.input<typeof RiskGuardrailsSchema>,
  deps: SolverDeps = {},
  opts: GuardrailsOptions = {},
): Promise<GuardrailsResult> {
  const g = RiskGuardrailsSchema.parse(guardrailsInput);
  if (!(g.lowerGuardrail <= g.targetSuccess && g.targetSuccess <= g.upperGuardrail))
    throw new ScenarioError("guardrails must satisfy lower <= target <= upper", { ...g });
  const cur = input.household.currency;
  const money = (v: number) => fmtMoney(v, { currency: cur });
  const mc = fixedSeedSettings(input);
  const metric = makeMetric(input, { kind: "successRate", target: g.targetSuccess }, deps, mc);
  let evaluations = 0;
  const count: SolverDeps = {
    ...deps,
    onProgress: (n, p) => deps.onProgress?.(evaluations + n, p),
  };
  const maxEval = opts.maxEvaluationsPerSolve ?? 14;
  let expenseIds = scopeExpenseIds(input, g.scope);
  if (expenseIds.length === 0) expenseIds = scopeExpenseIds(input, "all");
  if (expenseIds.length === 0) throw new ScenarioError("no spending to apply guardrails to", {});
  const allSpending = annualRecurringAmount(scaledExpenses(input.plan));
  const scoped = annualRecurringAmount(scaledExpenses(input.plan, expenseIds));
  const fixedSpending = allSpending - scoped;
  const floorScale =
    g.floor && scoped > 0 ? Math.max(0, (g.floor.value - fixedSpending) / scoped) : 0;
  const portfolio = scaledBalance(input);

  const s0 = await metric.score(input);
  evaluations += 1;

  const spendSolve = async (
    base: SimulationInput,
    min: number,
    max: number,
  ): Promise<GoalSeekResult> => {
    const r = await goalSeek(
      base,
      {
        variable: { kind: "spendingScale", expenseIds },
        objective: { kind: "successRate", target: g.targetSuccess },
        direction: "maximize",
        bounds: { min, max },
        tolerance: 0.005,
        maxEvaluations: maxEval,
        monteCarlo: mc,
        sensitivityDeltas: [],
      },
      count,
    );
    evaluations += r.evaluations.length;
    return r;
  };

  // All spending scales below are relative to the ORIGINAL plan's in-scope expenses, so a cut to
  // zero discretionary spending can still be followed by a distinct raise at the upper threshold.
  const pct = (v: number) => fmtPercent(Math.round(v * 100) / 100);
  const scoreAt = async (base: SimulationInput, k: number): Promise<number> => {
    evaluations += 1;
    return metric.score(applyVariable(base, { kind: "spendingScale", expenseIds }, k).input);
  };

  // 1. What to do now.
  let action: GuardrailsYear["action"] = "hold";
  let scale = 1;
  let successNow = s0;
  let targetReachable = true;
  if (s0 < g.lowerGuardrail) {
    action = "cut";
    const r = await spendSolve(input, floorScale, 1);
    if (
      r.value !== null &&
      r.status !== "infeasible" &&
      (r.achieved ?? 0) >= g.targetSuccess - 0.005
    ) {
      scale = r.value;
      successNow = r.achieved ?? s0;
    } else {
      // Even the deepest cut allowed (all in-scope spending down to the floor) misses the target.
      targetReachable = false;
      scale = floorScale;
      successNow = await scoreAt(input, floorScale);
    }
  } else if (s0 > g.upperGuardrail) {
    const r = await spendSolve(input, 1, 4);
    scale = r.value ?? 1;
    successNow = r.achieved ?? s0;
    action = scale > 1 + 1e-6 ? "raise" : "hold";
  }
  const recommended = applyVariable(input, { kind: "spendingScale", expenseIds }, scale);
  const recInput = recommended.input;
  const recommendedSpending = fixedSpending + scoped * scale;

  // 2. Portfolio thresholds at the recommended spending (shared paths, balance scale varies).
  const curve: { wr: number; success: number }[] = [
    { wr: recommendedSpending / Math.max(1, portfolio), success: successNow },
  ];
  const balanceSolve = async (target: number, min: number, max: number) => {
    const r = await goalSeek(
      recInput,
      {
        variable: { kind: "balanceScale" },
        objective: { kind: "successRate", target },
        direction: "minimize",
        bounds: { min, max },
        tolerance: 0.005,
        maxEvaluations: maxEval,
        monteCarlo: mc,
        sensitivityDeltas: [],
      },
      count,
    );
    evaluations += r.evaluations.length;
    for (const e of r.evaluations)
      curve.push({ wr: recommendedSpending / Math.max(1, portfolio * e.value), success: e.metric });
    return r;
  };
  // A lower threshold only makes sense when there is still spending left to cut.
  const canCutFurther = scale > floorScale + 1e-6;
  const low = portfolio > 0 && canCutFurther ? await balanceSolve(g.lowerGuardrail, 0, 1) : null;
  const high = portfolio > 0 ? await balanceSolve(g.upperGuardrail, 1, 6) : null;
  const lowerPortfolio = low?.value != null && low.value > 0 ? portfolio * low.value : null;
  const upperPortfolio =
    high?.value != null && high.status !== "infeasible" ? portfolio * high.value : null;

  // 3. Spending to move to at each threshold (absolute scales of the original in-scope spending).
  let cutTo: number | null = null;
  let raiseTo: number | null = null;
  if (lowerPortfolio !== null && low?.value != null) {
    const at = applyVariable(input, { kind: "balanceScale" }, low.value).input;
    const r = await spendSolve(at, floorScale, scale);
    const k = r.value ?? floorScale;
    if (k < scale - 1e-6) cutTo = fixedSpending + scoped * k;
  }
  if (upperPortfolio !== null && high?.value != null) {
    const at = applyVariable(input, { kind: "balanceScale" }, high.value).input;
    const r = await spendSolve(at, Math.max(scale, 1e-9), Math.max(4, scale * 4));
    const k = r.value;
    // No higher spending keeps the target at that portfolio: no distinct raise to offer.
    if (k !== null && k > scale + 1e-6) raiseTo = fixedSpending + scoped * k;
  }

  const thresholds: GuardrailsThresholds = {
    portfolio,
    spending: allSpending,
    recommendedSpending,
    lowerPortfolio: cutTo === null ? null : lowerPortfolio,
    cutTo,
    upperPortfolio: raiseTo === null ? null : upperPortfolio,
    raiseTo,
    targetReachable,
  };

  // 4. Indicative path on the deterministic projection, using the shared WR -> success curve.
  curve.sort((a, b) => a.wr - b.wr);
  const successAt = (wr: number): number => {
    if (curve.length === 0) return successNow;
    if (wr <= curve[0]!.wr) return curve[0]!.success;
    for (let i = 1; i < curve.length; i++) {
      const a = curve[i - 1]!;
      const b = curve[i]!;
      if (wr <= b.wr)
        return b.wr === a.wr
          ? b.success
          : a.success + ((wr - a.wr) / (b.wr - a.wr)) * (b.success - a.success);
    }
    return curve[curve.length - 1]!.success;
  };
  // The path is the engine's own projection with the guardrails applied year by year: the
  // withdrawal-rate band at the recommended spending drives cuts / raises, which feed back into
  // later balances (and so into later decisions).
  const sim = deps.simulate ?? ((i: SimulationInput) => coreSimulate(i));
  const wrLow = lowerPortfolio ? recommendedSpending / lowerPortfolio : Number.POSITIVE_INFINITY;
  const wrHigh = upperPortfolio ? recommendedSpending / upperPortfolio : 0;
  const guarded: SimulationInput = {
    ...recInput,
    plan: {
      ...recInput.plan,
      riskGuardrails: {
        ...g,
        enabled: true,
        start: { kind: "planStart", offsetMonths: 0 },
        withdrawalRateBand: {
          // Rate is capped at 10 (1,000%): with no lower threshold the band never cuts.
          cutAbove: Number.isFinite(wrLow) ? Math.min(10, wrLow) : 10,
          raiseBelow: Math.min(10, wrHigh),
        },
      },
    },
    options: { ...recInput.options, trace: "summary", lean: false },
  };
  const proj = sim(guarded);
  const year0 = proj.periods[0]?.year ?? 0;
  const actions = new Map<number, GuardrailsYear["action"]>();
  for (const t of proj.trace)
    if (t.code === "GUARDRAIL_CUT") actions.set(t.periodIndex, "cut");
    else if (t.code === "GUARDRAIL_RAISE") actions.set(t.periodIndex, "raise");
  const path: GuardrailsYear[] = proj.periods.map((p, i) => {
    const spendReal = toBasis(
      p.expenses.filter((e) => e.sourceKind === "expense").reduce((s, e) => s + e.requested, 0),
      p,
      "real",
      "flow",
    );
    const portReal = toBasis(p.totals.portfolio, p, "real", "stock");
    const wr = portReal > 0 ? spendReal / portReal : Number.POSITIVE_INFINITY;
    return {
      year: p.year,
      spendingReal: spendReal,
      successRate: Number.isFinite(wr) ? successAt(wr) : 0,
      action: actions.get(i) ?? "hold",
    };
  });

  const current: GuardrailsYear = {
    year: year0,
    spendingReal: recommendedSpending,
    successRate: successNow,
    action,
  };
  const scopeWord = g.scope === "discretionary" ? "discretionary" : "in-scope";
  const parts: string[] = [];
  if (action === "hold")
    parts.push(
      `Your plan's chance of success is ${pct(s0)}, inside your ${pct(g.lowerGuardrail)}-${pct(g.upperGuardrail)} band: the rules give spending of about ${money(recommendedSpending)} a year.`,
    );
  else if (action === "raise")
    parts.push(
      `Your plan's chance of success is ${pct(s0)}, above your ${pct(g.upperGuardrail)} upper guardrail: the rules would allow spending to rise from ${money(allSpending)} to about ${money(recommendedSpending)} a year, with a chance of success of about ${pct(successNow)}.`,
    );
  else if (targetReachable)
    parts.push(
      `Your plan's chance of success is ${pct(s0)}, below your ${pct(g.lowerGuardrail)} lower guardrail: the rules would cut spending from ${money(allSpending)} to about ${money(recommendedSpending)} a year, which gets it back to ${pct(g.targetSuccess)}.`,
    );
  else
    parts.push(
      `Your plan's chance of success is ${pct(s0)}, below your ${pct(g.lowerGuardrail)} lower guardrail, and cutting ${scopeWord} spending alone cannot get it back to ${pct(g.targetSuccess)}: even at ${money(recommendedSpending)} a year (${g.floor ? "your spending floor" : `no ${scopeWord} spending at all`}, down from ${money(allSpending)}) the chance is about ${pct(successNow)}. The model's other levers are essential costs, working or saving longer, and a later retirement.`,
    );
  if (lowerPortfolio !== null && cutTo !== null)
    parts.push(
      `If your investments fall below ${money(lowerPortfolio)} (now ${money(portfolio)}), the rules would cut spending further to about ${money(cutTo)}.`,
    );
  if (upperPortfolio !== null && raiseTo !== null)
    parts.push(
      `If they rise above ${money(upperPortfolio)}, the rules would allow spending of about ${money(raiseTo)}.`,
    );
  return {
    current,
    path,
    explanation: parts.join(" "),
    thresholds,
    ...(recommended.patch && action !== "hold" ? { patch: recommended.patch } : {}),
    currentSuccessRate: s0,
    targetReachable,
    evaluations,
  };
}

export interface GuytonKlingerThresholds {
  initialRate: number;
  currentRate: number;
  upperRateLimit: number;
  lowerRateLimit: number;
  /** Cut when the portfolio falls below this. */
  cutBelowPortfolio: number;
  /** Raise when the portfolio rises above this. */
  raiseAbovePortfolio: number;
  spendingAfterCut: number;
  spendingAfterRaise: number;
  action: "hold" | "cut" | "raise";
  explanation: string;
}

/**
 * Guyton-Klinger guardrails in money terms. `initialRate` defaults to the current withdrawal rate
 * (spending / portfolio). The capital-preservation rule only applies with more than 15 years left.
 */
export function guytonKlingerGuardrails(opts: {
  portfolio: number;
  spending: number;
  initialRate?: number;
  guardrail?: number;
  adjustment?: number;
  yearsRemaining?: number;
  currency?: string;
}): GuytonKlingerThresholds {
  const g = opts.guardrail ?? 0.2;
  const adj = opts.adjustment ?? 0.1;
  if (opts.portfolio <= 0)
    throw new ScenarioError("portfolio must be positive", { portfolio: opts.portfolio });
  const currentRate = opts.spending / opts.portfolio;
  const initialRate = opts.initialRate ?? currentRate;
  const upper = initialRate * (1 + g);
  const lower = initialRate * (1 - g);
  const cutBelow = opts.spending / upper;
  const raiseAbove = opts.spending / lower;
  const preservation = (opts.yearsRemaining ?? Number.POSITIVE_INFINITY) > 15;
  const action =
    currentRate > upper && preservation ? "cut" : currentRate < lower ? "raise" : "hold";
  const m = (v: number) => fmtMoney(v, opts.currency ? { currency: opts.currency } : {});
  const explanation =
    `With ${m(opts.spending)} a year from ${m(opts.portfolio)} (${fmtPercent(currentRate)}), ` +
    (action === "cut"
      ? `you are above the ${fmtPercent(upper)} upper guardrail: the rules would cut spending by ${fmtPercent(adj)} to ${m(opts.spending * (1 - adj))}.`
      : action === "raise"
        ? `you are below the ${fmtPercent(lower)} lower guardrail: the rules would raise spending by ${fmtPercent(adj)} to ${m(opts.spending * (1 + adj))}.`
        : `the rules leave spending unchanged. They would cut ${fmtPercent(adj)} to ${m(opts.spending * (1 - adj))} if your portfolio falls below ${m(cutBelow)}${preservation ? "" : " (not applied in the final 15 years)"}; they would raise ${fmtPercent(adj)} to ${m(opts.spending * (1 + adj))} if it rises above ${m(raiseAbove)}.`);
  return {
    initialRate,
    currentRate,
    upperRateLimit: upper,
    lowerRateLimit: lower,
    cutBelowPortfolio: cutBelow,
    raiseAbovePortfolio: raiseAbove,
    spendingAfterCut: opts.spending * (1 - adj),
    spendingAfterRaise: opts.spending * (1 + adj),
    action,
    explanation,
  };
}
