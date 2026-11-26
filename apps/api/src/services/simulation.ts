import {
  type Actor,
  type DifferenceAttribution,
  ENGINE_VERSION,
  type Explanation,
  type Finding,
  type GuytonKlingerThresholds,
  type MonteCarloResult,
  MonteCarloSettings,
  withReplacedDataset,
  type OutcomeSummary,
  type PatchOp,
  type Plan,
  type PlanDiff,
  type ProjectionResult,
  type RiskGuardrails,
  RothConversionPlanRequest,
  type RothConversionPlanRequest as RothConversionPlanRequestInput,
  type SimulationInput,
  SimulationOptions,
  type SimulationOptionsInput,
  type StrategyCandidate,
  type StrategyObjective,
  type ValueBasis,
  type YearNarrative,
} from "@glideworth/core";
import { ApiError } from "../errors.js";
import type { JobKind } from "../jobs/run.js";
import { inBasis } from "../money.js";
import type { MonteCarloRequest, ProjectionView } from "../schemas.js";
import { hashOf } from "../util.js";
import { compactProjection, outcomeOf, presentedWarnings } from "../views.js";
import type { ResultCache } from "./cache.js";
import type { ServiceCtx } from "./context.js";
import type { HouseholdsService } from "./households.js";
import type { JobsService, JobView } from "./jobs.js";
import type { PlansService } from "./plans.js";

/** Fixed default so repeated runs and "same plan, change X" comparisons use identical random draws. */
export const DEFAULT_MC_SEED = 20_260_101;

export interface ProjectionRun {
  result: ProjectionResult;
  cached: boolean;
  plan: Plan;
}

export class SimulationService {
  constructor(
    private readonly ctx: ServiceCtx,
    private readonly plans: PlansService,
    private readonly households: HouseholdsService,
    private readonly cache: ResultCache,
    readonly jobs: JobsService,
  ) {}
  private get deps() {
    return this.ctx.deps;
  }

  // ----------------------------------------------------------------------------- inputs
  /** Engine input for a stored plan. Branch plans are stored materialised, so lineage is dropped. */
  inputFor(planId: string, options: SimulationOptionsInput = {}, planOverride?: Plan) {
    const plan = planOverride ?? this.plans.get(planId);
    const stored = planOverride ? this.plans.get(planId) : plan;
    const rec = this.households.get(stored.householdId);
    const input: SimulationInput = {
      household: rec.household,
      finances: rec.finances,
      plan: { ...plan, lineage: undefined },
      options: SimulationOptions.parse(options),
    };
    return { input, plan: stored, householdVersion: rec.version, currency: rec.household.currency };
  }

  // ----------------------------------------------------------------------------- deterministic
  projection(planId: string, options: SimulationOptionsInput = {}): ProjectionRun {
    const { input, plan, householdVersion } = this.inputFor(planId, options);
    const hash = hashOf({ o: input.options, hv: householdVersion });
    const hit = this.cache.get(planId, plan.version, "deterministic", hash) as
      | ProjectionResult
      | undefined;
    if (hit) return { result: hit, cached: true, plan };
    const result = this.deps.simulate(input);
    this.cache.put(planId, plan.version, "deterministic", hash, result);
    return { result, cached: false, plan };
  }

  /** Full result, or a compact view when `view` is given. */
  simulate(planId: string, req: { view?: ProjectionView | undefined } & SimulationOptionsInput) {
    const { view, ...options } = req;
    const run = this.projection(planId, options);
    const locale = this.households.get(run.plan.householdId).household.locale;
    // The full result's money is nominal (meta.valueBasis). A compact view names its own basis.
    return view
      ? compactProjection(run.result, view, run.cached, locale)
      : { ...run.result, warnings: presentedWarnings(run.result, "nominal", locale) };
  }

  outcome(planId: string): OutcomeSummary {
    return outcomeOf(this.projection(planId, { trace: "off" }).result);
  }

  // ----------------------------------------------------------------------------- async jobs
  private mcSettings(plan: Plan, overrides: unknown, randomSeed: boolean): MonteCarloSettings {
    // `withReplacedDataset` keeps the DATASET_REPLACED marker of the plan or of the request, and drops a stale one.
    const merged = MonteCarloSettings.parse(
      withReplacedDataset({
        ...plan.monteCarlo,
        ...(overrides as object | undefined),
      }),
    );
    if (merged.seed === null && !randomSeed) merged.seed = DEFAULT_MC_SEED;
    if (merged.seed === null && randomSeed) merged.seed = Math.floor(Math.random() * 2 ** 32);
    return merged;
  }

  private submit(
    kind: JobKind,
    planId: string,
    params: unknown,
    cacheKind: "monte-carlo" | "historical" | "solver",
    cacheable: boolean,
    actor: Actor,
  ): JobView {
    const { input, plan, householdVersion } = this.inputFor(planId, { trace: "off" });
    const cache = cacheable
      ? { kind: cacheKind, hash: hashOf({ kind, params, hv: householdVersion }) }
      : null;
    return this.jobs.submit({
      kind,
      planId,
      planVersion: plan.version,
      input,
      params,
      cache,
      actor,
    });
  }

  startMonteCarlo(planId: string, req: MonteCarloRequest, actor: Actor): JobView {
    const plan = this.plans.get(planId);
    const settings = this.mcSettings(plan, req.settings, req.randomSeed);
    return this.submit(
      "monte-carlo",
      planId,
      { settings, keepTrials: req.keepTrials },
      "monte-carlo",
      !req.randomSeed,
      actor,
    );
  }

  /**
   * The chance-of-success result a default `runMonteCarlo` job (`{}`: the plan's own settings, fixed seed)
   * produced for the current plan and household versions, or null when none has run. Reads the same cache
   * entry that job writes, so the figure is the one the app shows; never runs anything.
   */
  cachedMonteCarlo(planId: string): MonteCarloResult | null {
    const plan = this.plans.get(planId);
    const settings = this.mcSettings(plan, undefined, false);
    const { householdVersion } = this.inputFor(planId, { trace: "off" });
    const params = { settings, keepTrials: false };
    const hash = hashOf({ kind: "monte-carlo", params, hv: householdVersion });
    return (this.cache.get(planId, plan.version, "monte-carlo", hash) as MonteCarloResult) ?? null;
  }

  startHistorical(
    planId: string,
    req: { startYears?: number[] | undefined; keepTrials?: boolean | undefined },
    actor: Actor,
  ): JobView {
    return this.submit(
      "historical",
      planId,
      { startYears: req.startYears, keepTrials: req.keepTrials ?? false },
      "historical",
      true,
      actor,
    );
  }

  startSolver(
    kind:
      | "goal-seek"
      | "max-spending"
      | "earliest-retirement"
      | "required-savings"
      | "required-portfolio"
      | "safe-withdrawal-rate",
    planId: string,
    body: Record<string, unknown>,
    actor: Actor,
  ): JobView {
    const plan = this.plans.get(planId);
    const { monteCarlo, ...rest } = body as { monteCarlo?: unknown; maxEvaluations?: number };
    const mc = this.mcSettings(plan, monteCarlo, false);
    const params =
      kind === "goal-seek"
        ? {
            request: { ...rest, ...(monteCarlo ? { monteCarlo: mc } : {}) },
            maxEvaluations: rest.maxEvaluations,
          }
        : { ...rest, monteCarlo: mc };
    return this.submit(kind, planId, params, "solver", true, actor);
  }

  startGuardrails(
    planId: string,
    req: { guardrails?: RiskGuardrails | undefined; monteCarlo?: unknown },
    actor: Actor,
  ): JobView {
    const plan = this.plans.get(planId);
    const guardrails = req.guardrails ?? plan.riskGuardrails;
    if (!guardrails)
      throw new ApiError(
        400,
        "VALIDATION",
        "the plan has no riskGuardrails; pass `guardrails` in the request or set them on the plan",
      );
    const monteCarlo = this.mcSettings(plan, req.monteCarlo, false);
    return this.submit("guardrails", planId, { guardrails, monteCarlo }, "solver", true, actor);
  }

  // ----------------------------------------------------------------------------- insights
  explain(
    planId: string,
    question?: string,
  ): Explanation & { planId: string; planVersion: number } {
    const { input, plan } = this.inputFor(planId, { trace: "full" });
    const { result } = this.projection(planId, { trace: "full" });
    const e = this.deps.explainProjection(input, result, question);
    return { planId, planVersion: plan.version, ...e };
  }

  /**
   * Static assumption checks, plus result-based ones (penalties, spending drops, cash drag) when the
   * plan projects cleanly. A projection failure never blocks the static audit.
   */
  audit(planId: string): {
    planId: string;
    planVersion: number;
    findings: Finding[];
    counts: Record<string, number>;
  } {
    const { input, plan } = this.inputFor(planId, { trace: "off" });
    let result: ProjectionResult | undefined;
    try {
      result = this.projection(planId, { trace: "full" }).result;
    } catch {
      result = undefined;
    }
    const findings = this.deps.auditAssumptions(input, result ? { result } : {});
    const counts: Record<string, number> = { info: 0, warning: 0, critical: 0 };
    for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    return { planId, planVersion: plan.version, findings, counts };
  }

  /** "Where did the money go in <year>": narrative built from the ledger. */
  explainYear(
    planId: string,
    q: { year?: number | undefined; periodIndex?: number | undefined; basis: ValueBasis },
  ): YearNarrative & { planId: string; planVersion: number } {
    const { input, plan } = this.inputFor(planId, { trace: "full" });
    const { result } = this.projection(planId, { trace: "full" });
    let idx = q.periodIndex;
    if (idx === undefined && q.year !== undefined) {
      idx = result.periods.findIndex((p) => p.year === q.year);
      if (idx < 0)
        throw new ApiError(404, "NOT_FOUND", `year ${q.year} is outside the projection`, {
          firstYear: result.periods[0]?.year,
          lastYear: result.periods[result.periods.length - 1]?.year,
        });
    }
    if (idx === undefined) throw new ApiError(400, "VALIDATION", "give `year` or `periodIndex`");
    const n = this.deps.explainYear(input, result, idx, { basis: q.basis });
    return { planId, planVersion: plan.version, ...n };
  }

  /** Narratives for a range of years (every Nth). */
  explainYears(
    planId: string,
    q: {
      fromYear?: number | undefined;
      toYear?: number | undefined;
      everyNYears: number;
      basis: ValueBasis;
    },
  ): { planId: string; planVersion: number; years: YearNarrative[] } {
    const { input, plan } = this.inputFor(planId, { trace: "full" });
    const { result } = this.projection(planId, { trace: "full" });
    const inRange = result.periods.filter(
      (p) =>
        (q.fromYear === undefined || p.year >= q.fromYear) &&
        (q.toYear === undefined || p.year <= q.toYear),
    );
    const picked = inRange.filter((_, i) => i % q.everyNYears === 0);
    return {
      planId,
      planVersion: plan.version,
      years: picked.map((p) => this.deps.explainYear(input, result, p.index, { basis: q.basis })),
    };
  }

  /**
   * Why do two plans end differently? A diff, an explanation and (optionally) which edit caused how
   * much of the change. Deterministic metrics are answered inline; `successRate` is a job
   * (startAttribution).
   */
  async explainDifference(
    basePlanId: string,
    otherPlanId: string,
    o: {
      attribute: boolean;
      metric: "endNetWorthReal" | "lifetimeTaxesReal" | "totalShortfallReal";
    },
  ) {
    const base = this.projection(basePlanId, { trace: "summary" });
    const other = this.projection(otherPlanId, { trace: "summary" });
    const diff = this.deps.diffPlans(base.plan, other.plan);
    let attribution: DifferenceAttribution | undefined;
    if (o.attribute) {
      const { input } = this.inputFor(basePlanId, { trace: "off" });
      // Replays each edit alone: long for a large diff, so it runs in the job executor (a worker thread in
      // production) under the job time limit instead of on the event loop.
      attribution = (await this.jobs.compute("attribution", input, {
        otherPlan: { ...other.plan, lineage: undefined },
        metric: o.metric,
        diff,
      })) as DifferenceAttribution;
    }
    const explanation = this.deps.explainDifference(base.result, other.result, diff, attribution);
    return {
      basePlanId,
      otherPlanId,
      changeCount: diff.changes.length,
      changes: diff.changes.map((c) => c.description),
      explanation,
      ...(attribution ? { attribution } : {}),
    };
  }

  startAttribution(
    basePlanId: string,
    otherPlanId: string,
    req: { metric: "successRate"; monteCarlo?: unknown },
    actor: Actor,
  ): JobView {
    const plan = this.plans.get(basePlanId);
    const other = this.plans.get(otherPlanId);
    const mc = this.mcSettings(plan, req.monteCarlo, false);
    const { input, plan: stored, householdVersion } = this.inputFor(basePlanId, { trace: "off" });
    const inputWithMc = { ...input, plan: { ...input.plan, monteCarlo: mc } };
    return this.jobs.submit({
      kind: "attribution",
      planId: basePlanId,
      planVersion: stored.version,
      input: inputWithMc,
      params: {
        otherPlan: { ...other, lineage: undefined },
        metric: req.metric,
        otherVersion: other.version,
      },
      cache: {
        kind: "solver",
        hash: hashOf({
          kind: "attribution",
          other: other.id,
          ov: other.version,
          mc,
          hv: householdVersion,
        }),
      },
      actor,
    });
  }

  /** Candidate tax strategies (UK-first), ranked. Always a job: every candidate is a full projection. */
  startTaxStrategy(
    planId: string,
    req: {
      objective?: StrategyObjective | undefined;
      candidates?: StrategyCandidate[] | undefined;
    },
    actor: Actor,
  ): JobView {
    const plan = this.plans.get(planId);
    const objective = req.objective ?? "endNetWorthReal";
    const { input, plan: stored, householdVersion } = this.inputFor(planId, { trace: "off" });
    const mc = this.mcSettings(plan, undefined, false);
    return this.jobs.submit({
      kind: "tax-strategy",
      planId,
      planVersion: stored.version,
      input:
        objective === "successRate" ? { ...input, plan: { ...input.plan, monteCarlo: mc } } : input,
      params: { objective, ...(req.candidates ? { candidates: req.candidates } : {}) },
      cache: {
        kind: "solver",
        hash: hashOf({
          kind: "tax-strategy",
          objective,
          c: req.candidates,
          hv: householdVersion,
          mc,
        }),
      },
      actor,
    });
  }

  /**
   * Roth conversion plan (US): a conversion amount per year and person with the reason, compared with
   * no conversions. A job: the planner runs the engine many times. Read-only; its `patch` is applied
   * only through a change set.
   */
  startRothConversionPlan(
    planId: string,
    raw: RothConversionPlanRequestInput,
    actor: Actor,
  ): JobView {
    const plan = this.plans.get(planId);
    const request = RothConversionPlanRequest.parse(raw ?? {});
    const { input, plan: stored, householdVersion } = this.inputFor(planId, { trace: "off" });
    const mc = request.successRate ? this.mcSettings(plan, undefined, false) : null;
    return this.jobs.submit({
      kind: "roth-conversion-plan",
      planId,
      planVersion: stored.version,
      input: mc ? { ...input, plan: { ...input.plan, monteCarlo: mc } } : input,
      params: { request, maxEvaluations: request.maxEvaluations },
      cache: {
        kind: "solver",
        hash: hashOf({ kind: "roth-conversion-plan", request, hv: householdVersion, mc }),
      },
      actor,
    });
  }

  /** Strategies x metrics matrix (tax, legacy, chance of success, end net worth). A job: every row is a projection. */
  startStrategyMatrix(
    planId: string,
    req: { candidates?: StrategyCandidate[] | undefined; successRate?: boolean | undefined },
    actor: Actor,
  ): JobView {
    const plan = this.plans.get(planId);
    const { input, plan: stored, householdVersion } = this.inputFor(planId, { trace: "off" });
    const mc = this.mcSettings(plan, undefined, false);
    return this.jobs.submit({
      kind: "strategy-matrix",
      planId,
      planVersion: stored.version,
      input,
      params: {
        successRate: req.successRate !== false,
        monteCarlo: mc,
        ...(req.candidates ? { candidates: req.candidates } : {}),
      },
      cache: {
        kind: "solver",
        hash: hashOf({
          kind: "strategy-matrix",
          c: req.candidates,
          s: req.successRate,
          hv: householdVersion,
          mc,
        }),
      },
      actor,
    });
  }

  /** How much income falls in each tax-rate band per year (needs a full-trace projection; computed here). */
  incomeByTaxRate(
    planId: string,
    opts: {
      jurisdictionId?: string | undefined;
      basis?: ValueBasis | undefined;
      schedules?: string[] | undefined;
    },
  ) {
    const { input } = this.inputFor(planId, { trace: "off" });
    const o = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
    return this.deps.incomeByTaxRateForInput(input, o, { simulate: this.deps.simulate });
  }

  /**
   * Guyton-Klinger guardrails in money terms. Defaults come from the plan's first projected year:
   * the investable portfolio at the start and that year's spending (today's money).
   */
  guytonKlinger(
    planId: string,
    q: {
      portfolio?: number | undefined;
      spending?: number | undefined;
      initialRate?: number | undefined;
      guardrail?: number | undefined;
      adjustment?: number | undefined;
      yearsRemaining?: number | undefined;
    },
  ): GuytonKlingerThresholds & {
    planId: string;
    planVersion: number;
    portfolio: number;
    spending: number;
  } {
    const { result, plan } = this.projection(planId, { trace: "off" });
    const first = result.periods[0];
    let portfolio = q.portfolio;
    let spending = q.spending;
    if (first) {
      portfolio ??= first.accounts
        .filter((a) => a.liquid && a.category !== "cash")
        .reduce((sum, a) => sum + a.opening, 0);
      spending ??= inBasis(first.totals.spending, first, "real", "flow");
    }
    if (portfolio === undefined || spending === undefined || portfolio <= 0)
      throw new ApiError(
        400,
        "VALIDATION",
        "no investable portfolio to evaluate; pass `portfolio` and `spending`",
      );
    const years = q.yearsRemaining ?? Math.max(0, result.periods.length);
    const g = this.deps.guytonKlingerGuardrails({
      portfolio,
      spending,
      yearsRemaining: years,
      currency: result.meta.currency,
      ...(q.initialRate !== undefined ? { initialRate: q.initialRate } : {}),
      ...(q.guardrail !== undefined ? { guardrail: q.guardrail } : {}),
      ...(q.adjustment !== undefined ? { adjustment: q.adjustment } : {}),
    });
    return {
      planId,
      planVersion: plan.version,
      portfolio: Math.round(portfolio),
      spending: Math.round(spending),
      ...g,
    };
  }

  /** Tornado data. Deterministic metrics are answered inline; `successRate` is a job (startSensitivity). */
  async sensitivity(planId: string, req: Record<string, unknown>) {
    const { input, plan } = this.inputFor(planId, { trace: "off" });
    const { monteCarlo: _mc, ...opts } = req;
    // Many engine runs: in the job executor (worker thread) under the job time limit, off the event loop.
    const result = (await this.jobs.compute("sensitivity", input, opts)) as Awaited<
      ReturnType<typeof this.deps.sensitivityAnalysis>
    >;
    return { planId, planVersion: plan.version, ...result };
  }

  startSensitivity(planId: string, req: Record<string, unknown>, actor: Actor): JobView {
    const plan = this.plans.get(planId);
    const { monteCarlo, ...rest } = req;
    return this.submit(
      "sensitivity",
      planId,
      { ...rest, monteCarlo: this.mcSettings(plan, monteCarlo, false) },
      "solver",
      true,
      actor,
    );
  }

  compare(planIds: string[], explain: boolean) {
    const runs = planIds.map((id) => ({
      id,
      ...this.projection(id, { trace: explain ? "summary" : "off" }),
    }));
    const base = runs[0]!;
    return {
      baseline: base.id,
      plans: runs.map((r) => ({
        planId: r.id,
        name: r.plan.name,
        version: r.plan.version,
        outcome: outcomeOf(r.result),
        success: r.result.summary.success,
        cached: r.cached,
      })),
      differences: runs.slice(1).map((r) => {
        const diff = this.deps.diffPlans(base.plan, r.plan);
        return {
          planId: r.id,
          changes: diff.changes.map((c) => c.description),
          changeCount: diff.changes.length,
          endNetWorthChange: Math.round(
            r.result.summary.endNetWorthReal - base.result.summary.endNetWorthReal,
          ),
          lifetimeTaxesChange: Math.round(
            r.result.summary.lifetimeTaxesReal - base.result.summary.lifetimeTaxesReal,
          ),
          ...(explain
            ? { explanation: this.deps.explainDifference(base.result, r.result, diff) }
            : {}),
        };
      }),
    };
  }

  taxBreakdown(
    planId: string,
    q: {
      fromYear?: number | undefined;
      toYear?: number | undefined;
      basis: ValueBasis;
      detail: "summary" | "lines";
    },
  ) {
    const { result, plan } = this.projection(planId, { trace: "off" });
    const m = (n: number, p: Parameters<typeof inBasis>[1]) =>
      Math.round(inBasis(n, p, q.basis, "flow"));
    const byJurisdiction: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    const byCountry: Record<string, number> = {};
    const byBasis: Record<string, number> = {};
    let total = 0;
    const years = result.periods
      .filter(
        (p) =>
          (q.fromYear === undefined || p.year >= q.fromYear) &&
          (q.toYear === undefined || p.year <= q.toYear),
      )
      .map((p) => {
        for (const l of p.taxes.lines) {
          const v = inBasis(l.amount, p, q.basis, "flow");
          byJurisdiction[l.jurisdictionId] = (byJurisdiction[l.jurisdictionId] ?? 0) + v;
          byKind[l.kind] = (byKind[l.kind] ?? 0) + v;
        }
        for (const r of p.taxes.byCountry ?? []) {
          const v = inBasis(r.amount, p, q.basis, "flow");
          byCountry[r.country] = (byCountry[r.country] ?? 0) + v;
          byBasis[r.basis] = (byBasis[r.basis] ?? 0) + v;
        }
        total += inBasis(p.taxes.total, p, q.basis, "flow");
        return {
          year: p.year,
          total: m(p.taxes.total, p),
          grossIncome: m(p.taxes.grossIncome, p),
          taxableIncome: m(p.taxes.taxableIncome, p),
          effectiveRate: Math.round(p.taxes.effectiveRate * 10_000) / 10_000,
          marginalRate: Math.round(p.taxes.marginalRate * 10_000) / 10_000,
          byJurisdiction: Object.fromEntries(
            Object.entries(
              p.taxes.lines.reduce<Record<string, number>>((acc, l) => {
                acc[l.jurisdictionId] = (acc[l.jurisdictionId] ?? 0) + l.amount;
                return acc;
              }, {}),
            ).map(([k, v]) => [k, m(v, p)]),
          ),
          ...(p.taxes.byCountry
            ? {
                byCountry: p.taxes.byCountry
                  .map((r) => ({ country: r.country, basis: r.basis, amount: m(r.amount, p) }))
                  .filter((r) => r.amount !== 0),
              }
            : {}),
          ...(q.detail === "lines"
            ? {
                lines: p.taxes.lines.map((l) => ({
                  jurisdictionId: l.jurisdictionId,
                  kind: l.kind,
                  label: l.label,
                  amount: m(l.amount, p),
                  ...(l.basis ? { basis: l.basis } : {}),
                  ...(l.country ? { country: l.country } : {}),
                  ...(l.personId ? { personId: l.personId } : {}),
                })),
              }
            : {}),
        };
      });
    const rnd = (o: Record<string, number>) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
    return {
      planId,
      planVersion: plan.version,
      currency: result.meta.currency,
      basis: q.basis,
      engineVersion: ENGINE_VERSION,
      totals: {
        total: Math.round(total),
        byJurisdiction: rnd(byJurisdiction),
        byKind: rnd(byKind),
        // Cross-border plans only (relief is negative): see GET /plans/{id}/tax-breakdown/by-country.
        ...(Object.keys(byCountry).length
          ? { byCountry: rnd(byCountry), byBasis: rnd(byBasis) }
          : {}),
      },
      years,
    };
  }

  // ----------------------------------------------------------------------------- what-if
  /**
   * Apply ops in memory: diff + before/after outcomes. Nothing is stored. `results` are the two projections the
   * outcomes come from (the chat widgets chart them).
   */
  preview(planId: string, ops: PatchOp[], withOutcome = true) {
    const plan = this.plans.get(planId);
    const patched = this.deps.applyPlanPatch(plan, ops);
    const diff: PlanDiff = this.deps.diffPlans(plan, patched);
    if (!withOutcome) return { plan, patched, diff, preview: undefined, results: undefined };
    const beforeResult = this.projection(planId, { trace: "off" }).result;
    const { input } = this.inputFor(planId, { trace: "off" }, patched);
    const afterResult = this.deps.simulate(input);
    return {
      plan,
      patched,
      diff,
      preview: { before: outcomeOf(beforeResult), after: outcomeOf(afterResult) },
      results: { before: beforeResult, after: afterResult },
    };
  }
}
