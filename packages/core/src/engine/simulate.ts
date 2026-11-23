/**
 * Deterministic engine entry point. Pure: no clock, no I/O, no randomness. The same input always
 * yields the same output, in Node, browsers and Web Workers.
 */
import { ScenarioError, ValidationError } from "../errors.js";
import { ACCOUNT_TYPE_INFO } from "../schema/account-types.js";
import type { Account, DrawdownCategory } from "../schema/accounts.js";
import type { RealAsset } from "../schema/assets-debts.js";
import { SCHEMA_VERSION } from "../schema/document.js";
import { DEFAULT_DRAWDOWN_ORDER } from "../schema/strategies.js";
import { datasetReplacedWarnings, HISTORICAL_SERIES } from "../stochastic/data/index.js";
import {
  createDefaultTaxRegistry,
  NATIONAL_JURISDICTION_BY_COUNTRY,
  type TaxRegistry,
} from "../tax/registry.js";
import type { TaxJurisdiction } from "../tax/types.js";
import { resolveWindow } from "./amounts.js";
import {
  type AccountState,
  type AssetState,
  accountInfo,
  type EngineContext,
  type PeriodState,
  warnOnce,
} from "./context.js";
import { initCrossBorder } from "./crossborder.js";
import { buildPeriods, formatMonth, monthOfYear, parseMonth, yearOf } from "./dates.js";
import { buildDrawdownGroups } from "./drawdown.js";
import { autoMedicareEvents } from "./expenses.js";
import { rateSpecValue } from "./growth.js";
import {
  buildCategoryIndices,
  buildFxPath,
  fxAt,
  isForeign,
  resolveFx,
  validateCategories,
} from "./indices.js";
import { finalizeMilestones, initMilestones, resolveRef } from "./milestones.js";
import { PIPELINE, validateReferences } from "./phases.js";
import { freshStrategyState } from "./strategy.js";
import {
  type HistoricalDataset,
  type MarketPeriod,
  type ProjectionResult,
  SimulationInput,
  type SimulationInputInput,
  toBasis,
} from "./types.js";

/**
 * Bumped when results change meaning (0.3.0: today's-money flow index, savings rate, FX, categories;
 * 0.4.0: cross-border model - residency timeline, source taxation, treaties; account rules follow the
 * account's country after a relocation; single-country results unchanged apart from this field.
 * 0.5.0: withdrawals are capped by the cash-flow timing convention, so an account emptied in a year
 * no longer pays out growth it had not earned by the time of the withdrawal (accounts.ts
 * `withdrawable`); deterministic historical sequences read the bundled us-1928 instead of Shiller's
 * us-1871; retired dataset ids are read as their replacements).
 * 0.6.0: moving country removed - the household lives at `Household.location` for the whole plan
 * (no residency timeline, relocation effects, departure taxes, UK temporary non-residence or State
 * Pension freeze); items in another country are still taxed there and at home; `taxes.residence`
 * is gone from results).
 */
export const ENGINE_VERSION = "0.6.0";

export interface SimulateDeps {
  /** Tax registry; defaults to createDefaultTaxRegistry(). Inject to add/replace jurisdictions. */
  taxRegistry?: TaxRegistry;
  /**
   * Historical market data for deterministic `RateSpec.historical` sequences. Defaults to the
   * bundled `HISTORICAL_SERIES` (US 1871-), so callers need not pass it.
   */
  historical?: HistoricalDataset;
}

/**
 * Assumptions.rateOverrides: temporary rates over a time range (e.g. a market crash) on top of
 * whatever RateSpec a series uses. A period takes the override when its first month is in range.
 */
function applyRateOverrides(ctx: EngineContext): void {
  const overrides = ctx.plan.assumptions.rateOverrides ?? [];
  if (overrides.length === 0) return;
  const windows = overrides.map((o) => ({ o, w: resolveWindow(ctx, o.range) }));
  ctx.baseMarket = ctx.baseMarket.map((m, i) => {
    const at = ctx.periods[i]!.start;
    // Perf note (oxc/no-accumulating-spread): bounded by the number of rate-override windows; core logic left untouched.
    /* oxlint-disable oxc/no-accumulating-spread */
    let out = m;
    for (const { o, w } of windows)
      if (w.start !== null && at >= w.start && at < w.end) out = { ...out, [o.series]: o.rate };
    /* oxlint-enable oxc/no-accumulating-spread */
    return out;
  });
}

/** Provenance (tax year + official sources) of every jurisdiction the plan's stack used. */
function taxSourcesOf(ctx: EngineContext): { taxSources?: ProjectionResult["meta"]["taxSources"] } {
  if (ctx.plan.tax.mode !== "estimate") return {};
  let stack: TaxJurisdiction[] = [];
  try {
    stack = ctx.registry.resolveStack(ctx.plan.tax, ctx.location);
  } catch {
    if (!ctx.crossBorder) return {};
  }
  if (ctx.crossBorder)
    for (const c of ctx.crossBorder.countries) {
      const id = NATIONAL_JURISDICTION_BY_COUNTRY[c];
      if (!id) continue;
      try {
        const j = ctx.registry.get(id);
        if (!stack.includes(j)) stack.push(j);
      } catch {
        // unknown id: nothing to cite
      }
    }
  const out = stack.flatMap((j) => (j.sources ?? []).map((s) => ({ jurisdictionId: j.id, ...s })));
  return out.length > 0 ? { taxSources: out } : {};
}

function emptyAccountP(): AccountState["p"] {
  return {
    opening: 0,
    contributions: 0,
    withdrawals: 0,
    growth: 0,
    dividends: 0,
    dividendsReinvested: 0,
    fees: 0,
    transfersIn: 0,
    transfersOut: 0,
    requiredDistribution: 0,
    qcd: 0,
    rate: 0,
    timing: 0,
  };
}

/**
 * Run one deterministic projection.
 * @throws ValidationError on schema-invalid input, ScenarioError on inconsistent references,
 *         NotImplementedError (strict mode) when the plan uses an unimplemented feature.
 */
export function simulate(
  rawInput: SimulationInputInput | SimulationInput,
  deps: SimulateDeps = {},
): ProjectionResult {
  const parsed = SimulationInput.safeParse(rawInput);
  if (!parsed.success)
    throw new ValidationError("invalid simulation input", { issues: parsed.error.issues });
  const input = parsed.data;
  const { household, plan, options } = input;
  if (options.resolution === "monthly")
    throw new ScenarioError("resolution 'monthly' is reserved; only 'annual' is implemented");
  const finances =
    plan.startingConditions.kind === "snapshot" ? plan.startingConditions.finances : input.finances;
  const start = parseMonth(finances.asOf);
  const maxEnd = start + plan.assumptions.maxYears * 12;

  const ctx: EngineContext = {
    options,
    household,
    finances,
    plan,
    registry: deps.taxRegistry ?? createDefaultTaxRegistry(),
    historical: deps.historical ?? HISTORICAL_SERIES,
    people: household.people.map((p) => ({
      id: p.id,
      role: p.role,
      birth: parseMonth(p.birthMonth),
      name: p.name,
    })),
    start,
    endExclusive: maxEnd,
    periods: [],
    market: [],
    baseMarket: [],
    piStart: [],
    milestones: new Map(),
    accounts: [],
    accountById: new Map(),
    assets: [],
    debts: [],
    warnings: [],
    trace: [],
    taxHistory: [],
    results: [],
    unsupportedSeen: new Set(),
    warnedOnce: new Set(),
    filingStatus: plan.tax.filingStatus,
    location: household.location,
    withholdingRates: plan.tax.withholding,
    appliedEffects: new Set(),
    deceased: new Set(),
    lsaUsed: new Map(),
    flexiblyAccessed: new Set(),
    payHistory: new Map(),
    dbPayout: new Map(),
    perf: { index: 1, ath: 1 },
    strategy: freshStrategyState(),
    guardrailMultiplier: 1,
    pendingSettlement: 0,
    expenseEvents: [],
    drawdownGroups: [],
    drawdownCategoryRank: new Map(),
  };

  // --- FX: every foreign currency resolves to the base currency (ScenarioError when a rate is missing).
  resolveFx(ctx);
  // --- Cross-border plans: items in other countries and the tax currencies of the countries involved.
  initCrossBorder(ctx);
  /** Starting values in a foreign currency convert at the plan-start rate. */
  const fx0 = (currency: string | undefined) => fxAt(ctx, currency, start);

  // --- Accounts / assets / debts with plan overrides merged (shallow per top-level key).
  const excluded = new Set(plan.excludedIds);
  const mkAccount = (def: Account, opensAt: number | null): AccountState => {
    const info = accountInfo(def);
    const behaviour = { ...def.behaviour, ...(plan.accountSettings[def.id] ?? {}) };
    const k = fx0(def.currency);
    return {
      def,
      behaviour,
      info,
      category: ACCOUNT_TYPE_INFO[def.type] ? info.drawdown : "taxable",
      owner: def.owner,
      balance: def.balance * k,
      costBasis:
        info.tracksCostBasis || info.taxTreatment === "taxable"
          ? (def.costBasis ?? def.balance) * k
          : null,
      contributionBasis: info.tracksContributionBasis ? (def.contributionBasis ?? 0) * k : null,
      ...(isForeign(ctx, def.currency) ? { currency: def.currency } : {}),
      opensAt,
      opensRef: null,
      iraBasis: 0,
      pclsTaken: false,
      sepp: null,
      bondShare: 0,
      p: emptyAccountP(),
    };
  };
  ctx.accounts = finances.accounts
    .filter((a) => !a.archived && !excluded.has(a.id))
    .map((a) => mkAccount(a, null));
  const assetState = (def: RealAsset, planned: AssetState["planned"]): AssetState => ({
    def,
    behaviour: { ...def.behaviour, ...(plan.realAssetSettings[def.id] ?? {}) },
    value: planned ? 0 : def.currentValue * fx0(def.currency),
    loanBalance: planned ? 0 : (def.loan?.balance ?? 0) * fx0(def.currency),
    ...(isForeign(ctx, def.currency) ? { currency: def.currency } : {}),
    loan: def.loan
      ? {
          interest: def.loan.interest,
          monthlyPayment: def.loan.monthlyPayment,
          termEnd: def.loan.termEnd,
        }
      : null,
    owned: !planned,
    owner: def.owner,
    costBasis: (def.purchasePrice ?? def.currentValue) * fx0(def.currency),
    assessed: null,
    planned,
    done: false,
    acquiredAt: null,
    p: {
      ownershipCosts: 0,
      loanPayments: 0,
      loanInterest: 0,
      rentalIncome: 0,
      purchasePrice: 0,
      saleProceeds: 0,
    },
  });
  ctx.assets = finances.realAssets
    .filter((r) => !r.archived && !excluded.has(r.id))
    .map((def) => assetState(def, null));
  ctx.debts = finances.debts
    .filter((d) => !d.archived && !excluded.has(d.id))
    .map((def) => ({
      def,
      behaviour: { ...def.behaviour, ...(plan.debtSettings[def.id] ?? {}) },
      balance: def.balance * fx0(def.currency),
      owner: def.owner,
      ...(isForeign(ctx, def.currency) ? { currency: def.currency } : {}),
      p: { opening: 0, interest: 0, payments: 0, forgiven: 0 },
    }));

  // --- Milestones (time-resolved ones get exact months now) and plan horizon.
  initMilestones(ctx, plan.milestones);
  let endExclusive = maxEnd;
  if (plan.assumptions.end.kind === "ref") {
    const e = resolveRef(ctx, plan.assumptions.end.ref);
    if (typeof e === "number") endExclusive = Math.min(maxEnd, e);
  } else {
    const le = [...ctx.milestones.values()].filter(
      (m) => m.def.kind === "life-expectancy" && typeof m.month === "number",
    );
    if (le.length > 0)
      endExclusive = Math.min(maxEnd, Math.max(...le.map((m) => m.month as number)) + 1);
  }
  ctx.endExclusive = endExclusive;

  const align = plan.assumptions.yearAlignment;
  const alignMonth =
    align.kind === "calendar"
      ? 0
      : align.kind === "fiscal"
        ? align.startMonth - 1
        : monthOfYear(start);
  ctx.periods = buildPeriods(start, endExclusive, alignMonth);

  // --- Market rates per period and the price index (needed by DateRef-dependent amounts).
  const a = plan.assumptions;
  if (options.market && options.market.periods.length < ctx.periods.length)
    throw new ScenarioError("market path shorter than the plan", {
      need: ctx.periods.length,
      got: options.market.periods.length,
    });
  ctx.baseMarket = ctx.periods.map((_, i): MarketPeriod => ({
    stocks: rateSpecValue(ctx, a.stockReturn, i, "stock return"),
    bonds: rateSpecValue(ctx, a.bondReturn, i, "bond return"),
    cash: rateSpecValue(ctx, a.cashReturn, i, "cash return"),
    inflation: rateSpecValue(ctx, a.inflation, i, "inflation"),
    dividendYield: rateSpecValue(ctx, a.dividendYield, i, "dividend yield"),
    bondYield: rateSpecValue(ctx, a.bondYield, i, "bond yield"),
    crypto: rateSpecValue(ctx, a.cryptoReturn, i, "crypto return"),
  }));
  const assumedInflation = ctx.baseMarket.map((m) => m.inflation);
  applyRateOverrides(ctx);
  ctx.market = ctx.periods.map((_, i) => options.market?.periods[i] ?? ctx.baseMarket[i]!);
  let pi = 1;
  ctx.piStart = ctx.periods.map((p, i) => {
    const s = pi;
    pi *= (1 + ctx.market[i]!.inflation) ** (p.months / 12);
    return s;
  });
  // FX shocks from a Monte Carlo market path (deterministic rate and drift otherwise).
  buildFxPath(ctx);
  // Inflation categories follow this path's general inflation (coherent in Monte Carlo trials).
  validateCategories(ctx);
  buildCategoryIndices(ctx, assumedInflation);

  // --- Planned accounts (open at a DateRef; pending milestone refs are re-checked per period).
  for (const pa of plan.plannedAccounts) {
    const o = resolveRef(ctx, pa.opensAt);
    const acc = mkAccount(
      { ...pa, balance: 0 },
      typeof o === "number" ? o : o === null ? Number.POSITIVE_INFINITY : null,
    );
    if (o === "pending") acc.opensRef = pa.opensAt;
    ctx.accounts.push(acc);
  }
  // --- Planned real assets (future purchases, optional recurrence).
  for (const pr of plan.plannedRealAssets) {
    if (excluded.has(pr.id)) continue;
    const def = { ...pr, currentValue: 0 } as RealAsset;
    const behaviour = { ...pr.behaviour, ...(plan.realAssetSettings[pr.id] ?? {}) };
    let holdMonths: number | null = null;
    if (behaviour.recurrence && behaviour.sale) {
      const p0 = resolveRef(ctx, pr.purchase.at);
      const s0 = resolveRef(ctx, behaviour.sale.at);
      if (typeof p0 === "number" && typeof s0 === "number" && s0 > p0) holdMonths = s0 - p0;
    }
    ctx.assets.push(
      assetState(def, {
        purchase: pr.purchase,
        cycle: 0,
        nextPurchase: null,
        saleAt: null,
        holdMonths,
      }),
    );
  }
  // Existing assets with recurrence: the current asset is cycle 0; it is sold at `sale.at` and a
  // replacement worth today's value (scaled by `scalingRate` per cycle) is bought `yearsBetween`
  // later, repeating until `recurrence.until`.
  for (const r of ctx.assets) {
    if (r.planned || !r.behaviour.recurrence) continue;
    const sale = r.behaviour.sale;
    if (!sale) {
      warnOnce(ctx, `recurrence-existing:${r.def.id}`, {
        code: "ASSUMPTION",
        severity: "info",
        message: `Recurrence on ${r.def.name} needs a sale date to know when to replace it; it is kept for the whole plan instead.`,
        periodIndex: null,
        refs: [r.def.id],
      });
      continue;
    }
    const s0 = resolveRef(ctx, sale.at);
    r.planned = {
      purchase: {
        at: { kind: "planStart", offsetMonths: 0 },
        price: { value: r.def.currentValue, basis: "real" },
        fundFromAccountIds: [],
      },
      cycle: 0,
      nextPurchase: null,
      saleAt: typeof s0 === "number" ? Math.max(s0, ctx.start) : null,
      holdMonths: typeof s0 === "number" && s0 > ctx.start ? s0 - ctx.start : null,
    };
  }
  for (const acc of ctx.accounts) ctx.accountById.set(acc.def.id, acc);
  ctx.expenseEvents = [...plan.expenses, ...autoMedicareEvents(ctx)];
  validateReferences(ctx);
  ctx.drawdownGroups = buildDrawdownGroups(ctx);
  const rank = ctx.drawdownCategoryRank;
  for (const e of [...plan.drawdown.order, ...DEFAULT_DRAWDOWN_ORDER]) {
    const c: DrawdownCategory | undefined =
      e.kind === "category"
        ? e.category
        : e.kind === "account"
          ? ctx.accountById.get(e.accountId)?.category
          : undefined;
    if (c && !rank.has(c)) rank.set(c, rank.size);
  }

  // --- The yearly loop.
  for (const bounds of ctx.periods) {
    const i = bounds.index;
    const ps: PeriodState = {
      bounds,
      market: ctx.market[i]!,
      baseMarket: ctx.baseMarket[i]!,
      piStart: ctx.piStart[i]!,
      piEnd: ctx.piStart[i]! * (1 + ctx.market[i]!.inflation) ** (bounds.months / 12),
      ages: {},
      alive: {},
      incomeLines: [],
      expenseLines: [],
      poolInflow: 0,
      poolRequired: 0,
      taxIncome: [],
      taxWithdrawals: [],
      taxDeductions: [],
      engineTaxLines: [],
      withholding: new Map(),
      targeted: [],
      strategy: null,
      limitUsed: new Map(),
      taxes: {
        total: 0,
        lines: [],
        grossIncome: 0,
        taxableIncome: 0,
        effectiveRate: 0,
        marginalRate: 0,
        withheld: 0,
        settlement: 0,
        facts: {},
      },
      shortfall: 0,
      ledgerNodes: new Map(),
      ledger: [],
      milestonesReached: [],
      tax: plan.tax,
      location: household.location,
      stack: [],
      aca: null,
      wealth: null,
      qualified: { healthcare: 0, education: 0 },
    };
    for (const phase of PIPELINE) phase.run(ctx, ps);
  }
  finalizeMilestones(ctx);

  // --- Assemble result.
  const periods = ctx.results;
  const last = periods[periods.length - 1];
  const shortfalls = periods.filter((p) => p.status === "shortfall");
  const retirement = [...ctx.milestones.values()].find(
    (m) =>
      m.def.kind === "retirement" &&
      (!m.def.personId || ctx.people.find((p) => p.id === m.def.personId)?.role === "primary"),
  );
  const result: ProjectionResult = {
    meta: {
      engineVersion: ENGINE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      resolution: "annual",
      planId: plan.id,
      planVersion: plan.version,
      currency: household.currency,
      referenceMonth: finances.asOf,
      startMonth: finances.asOf,
      endMonth: formatMonth(endExclusive - 1),
      valueBasis: "nominal",
      ...(ctx.fx && ctx.fx.size > 0
        ? {
            fxRates: [...ctx.fx].map(([currency, f]) => ({
              currency,
              rate: f.rate,
              annualDrift: f.drift,
            })),
          }
        : {}),
      strict: options.strict,
      ...taxSourcesOf(ctx),
    },
    periods,
    milestones: [...ctx.milestones.values()].map((m) => {
      const month = typeof m.month === "number" ? Math.max(m.month, start) : null;
      const pIndex =
        month === null ? null : ctx.periods.findIndex((b) => month >= b.start && month < b.end);
      return {
        milestoneId: m.def.id,
        name: m.def.name,
        status: !m.def.enabled ? "disabled" : month === null ? "never" : "reached",
        month: month === null ? null : formatMonth(month),
        periodIndex: pIndex === null || pIndex < 0 ? null : pIndex,
        ages:
          month === null
            ? {}
            : Object.fromEntries(ctx.people.map((p) => [p.id, (month - p.birth) / 12])),
        via: m.via,
      };
    }),
    warnings: [
      ...datasetReplacedWarnings(plan.monteCarlo),
      ...ctx.warnings,
      ...[...ctx.milestones.values()]
        .filter((m) => m.def.enabled && m.month === null && m.def.kind !== "life-expectancy")
        .map((m) => ({
          code: "MILESTONE_NEVER_REACHED" as const,
          severity: "info" as const,
          message: `${m.def.name} is never reached: its criteria do not all hold at any point before the plan ends in ${periods[periods.length - 1]?.year ?? ""}.`,
          periodIndex: null,
          refs: [m.def.id],
        })),
    ],
    summary: {
      success: shortfalls.length === 0,
      firstShortfallYear: shortfalls[0]?.year ?? null,
      totalShortfall: periods.reduce((s, p) => s + p.totals.shortfall, 0),
      endNetWorth: last?.totals.netWorth ?? 0,
      endNetWorthReal: last ? last.totals.netWorth / last.priceIndex : 0,
      lifetimeTaxes: periods.reduce((s, p) => s + p.totals.taxes, 0),
      lifetimeTaxesReal: periods.reduce(
        (s, p) => s + toBasis(p.totals.taxes, p, "real", "flow"),
        0,
      ),
      retirementYear:
        typeof retirement?.month === "number" ? yearOf(Math.max(retirement.month, start)) : null,
    },
    trace: ctx.trace,
  };
  return result;
}
