/**
 * Price indices per inflation category and foreign-exchange conversion.
 *
 * Inflation categories (Assumptions.inflationCategories): each category has a per-period rate and a
 * start-of-period index, built from the period's GENERAL inflation (the plan inflation, or a Monte
 * Carlo trial's sampled inflation) so categories move coherently with it:
 *   - 'premium': rate = general + premium
 *   - 'rate':    rate = own rate + passThrough x (general - assumed general)
 * Events opt in with `inflationCategory`; everything else follows the general index.
 *
 * FX (CurrentFinances.fxRates, Assumptions.fxRates): each foreign currency resolves to the household
 * base currency through a direct or inverse pair. The rate at month m is
 * `rate x (1 + annualDrift)^((m - planStart) / 12)`. Monte Carlo may add per-period shocks
 * (`MarketPeriod.fx`, MonteCarloSettings.fx): the period's growth becomes `(1 + drift) x shock`.
 */
import { ScenarioError } from "../errors.js";
import { type FxRate, mergeFxRates } from "../schema/assumptions.js";
import type { EngineContext } from "./context.js";
import { priceIndexAt } from "./context.js";
import type { MonthIndex } from "./dates.js";
import { rateSpecValue } from "./growth.js";

export const GENERAL_CATEGORY = "general";

export interface CategoryIndex {
  /** Index at each period start (plan start = 1). */
  piStart: number[];
  /** Annual rate in force in each period. */
  rate: number[];
}

/** Build the category indices once the market path (and so the general inflation) is known. */
export function buildCategoryIndices(
  ctx: EngineContext,
  assumedInflation: readonly number[],
): void {
  const cats = ctx.plan.assumptions.inflationCategories ?? [];
  ctx.categories = new Map();
  for (const c of cats) {
    const rate: number[] = [];
    const piStart: number[] = [];
    let pi = 1;
    ctx.periods.forEach((p, i) => {
      const general = ctx.market[i]!.inflation;
      const own = rateSpecValue(ctx, c.rate, i, `${c.name} inflation`);
      const r =
        c.mode === "premium"
          ? general + own
          : own + c.passThrough * (general - (assumedInflation[i] ?? general));
      rate.push(r);
      piStart.push(pi);
      pi *= Math.max(1e-9, 1 + r) ** (p.months / 12);
    });
    ctx.categories.set(c.id, { rate, piStart });
  }
}

/** Index of `category` at month m (geometric within a period); 'general'/unknown -> plan index. */
export function categoryIndexAt(
  ctx: EngineContext,
  category: string | undefined,
  m: MonthIndex,
): number {
  if (!category || category === GENERAL_CATEGORY) return priceIndexAt(ctx, m);
  const c = ctx.categories?.get(category);
  if (!c) return priceIndexAt(ctx, m);
  const ps = ctx.periods;
  if (ps.length === 0) return 1;
  if (m <= ps[0]!.start) return Math.max(1e-9, 1 + c.rate[0]!) ** ((m - ps[0]!.start) / 12);
  let lo = 0;
  let hi = ps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (m < ps[mid]!.end) hi = mid;
    else lo = mid + 1;
  }
  return c.piStart[lo]! * Math.max(1e-9, 1 + c.rate[lo]!) ** ((m - ps[lo]!.start) / 12);
}

/** Validate that every event's category exists (dangling ids are ScenarioErrors). */
export function validateCategories(ctx: EngineContext): void {
  const known = new Set([
    GENERAL_CATEGORY,
    ...(ctx.plan.assumptions.inflationCategories ?? []).map((c) => c.id),
  ]);
  for (const e of [...ctx.plan.income, ...ctx.plan.expenses])
    if (e.inflationCategory && !known.has(e.inflationCategory))
      throw new ScenarioError(
        `event '${e.id}' uses unknown inflation category '${e.inflationCategory}'`,
        {
          id: e.id,
          inflationCategory: e.inflationCategory,
        },
      );
}

// ------------------------------------------------------------------------------------------- FX

export interface ResolvedFx {
  /** Base-currency units per 1 unit of the currency at the plan start. */
  rate: number;
  /** Annual drift of that rate. */
  drift: number;
}

/**
 * Merge household and plan rate tables. A plan pair replaces the household's pair in EITHER direction
 * (a plan's USD>GBP overrides the household's GBP>USD), and within one table the last entry for a pair wins.
 */
export function fxTable(ctx: EngineContext): FxRate[] {
  return mergeFxRates(ctx.finances.fxRates, ctx.plan.assumptions.fxRates);
}

/** Resolve every currency used by accounts, assets, debts and events to the base currency. */
export function resolveFx(ctx: EngineContext): void {
  const base = ctx.household.currency;
  const used = new Set<string>();
  const add = (c: string | undefined) => {
    if (c && c !== base) used.add(c);
  };
  for (const a of ctx.finances.accounts) add(a.currency);
  for (const a of ctx.plan.plannedAccounts) add(a.currency);
  for (const r of ctx.finances.realAssets) add(r.currency);
  for (const r of ctx.plan.plannedRealAssets) add(r.currency);
  for (const d of ctx.finances.debts) add(d.currency);
  for (const e of [...ctx.plan.income, ...ctx.plan.expenses]) add(e.currency);
  ctx.fx = new Map();
  if (used.size === 0) return;
  const table = fxTable(ctx);
  for (const c of used) {
    const direct = table.find((r) => r.from === c && r.to === base);
    const inverse = table.find((r) => r.from === base && r.to === c);
    if (direct) ctx.fx.set(c, { rate: direct.rate, drift: direct.annualDrift });
    else if (inverse)
      ctx.fx.set(c, { rate: 1 / inverse.rate, drift: 1 / (1 + inverse.annualDrift) - 1 });
    else
      throw new ScenarioError(
        `no exchange rate between ${c} and the household currency ${base}: add one to the FX rates table`,
        { currency: c, base },
      );
  }
}

/** Build `ctx.fxPath` when the market path carries FX shocks (after periods and market are set). */
export function buildFxPath(ctx: EngineContext): void {
  ctx.fxPath = undefined;
  if (!ctx.fx?.size || !ctx.market.some((p) => p.fx)) return;
  const path = new Map<string, { start: number[]; growth: number[] }>();
  for (const [c, f] of ctx.fx) {
    const start: number[] = [];
    const growth: number[] = [];
    let rate = f.rate;
    ctx.periods.forEach((b, i) => {
      const g = (1 + f.drift) * (ctx.market[i]!.fx?.[c] ?? 1);
      start.push(rate);
      growth.push(g);
      rate *= g ** (b.months / 12);
    });
    path.set(c, { start, growth });
  }
  ctx.fxPath = path;
}

/** Base-currency units per 1 unit of `currency` at month m (1 for the base currency). */
export function fxAt(ctx: EngineContext, currency: string | undefined, m: MonthIndex): number {
  if (!currency || currency === ctx.household.currency) return 1;
  const f = ctx.fx?.get(currency);
  if (!f) return 1;
  const p = ctx.fxPath?.get(currency);
  const ps = ctx.periods;
  if (!p || ps.length === 0 || m <= ps[0]!.start)
    return f.rate * (1 + f.drift) ** ((m - ctx.start) / 12);
  let lo = 0;
  let hi = ps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (m < ps[mid]!.end) hi = mid;
    else lo = mid + 1;
  }
  return p.start[lo]! * p.growth[lo]! ** ((m - ps[lo]!.start) / 12);
}

/** True when `currency` is a foreign (non-base) currency with a resolved rate. */
export function isForeign(ctx: EngineContext, currency: string | undefined): currency is string {
  return !!currency && currency !== ctx.household.currency && !!ctx.fx?.has(currency);
}
