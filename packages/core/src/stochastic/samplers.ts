/**
 * Market path generators. Each produces one `MarketPath` (one `MarketPeriod` per simulated period)
 * from a seeded RNG, so the same (seed, trial) always yields the same path on any thread.
 */
import type { MarketPath, MarketPeriod } from "../engine/types.js";
import { ScenarioError, ValidationError } from "../errors.js";
import { Assumptions } from "../schema/assumptions.js";
import type { MonteCarloSettings } from "../schema/montecarlo.js";
import type { RateSpec } from "../schema/time.js";
import { datasetLength, getMarketDataset, type MarketDataset } from "./data/index.js";
import { chiSquare, cholesky } from "./math.js";
import type { Rng } from "./rng.js";

type Dist = { mean: number; stdDev: number };

export interface SamplerContext {
  /**
   * Deterministic per-period rates (normally the plan assumptions, i.e. the deterministic
   * projection's `periods[i].market`). Series that do not vary, or have no data, use these.
   * Defaults to the schema-default assumptions for every period.
   */
  base?: readonly MarketPeriod[];
  /** historical-sequential: start years in trial order (default: every full-length window). */
  startYears?: readonly number[];
  /** The household's base currency (needed for `settings.fx`; FX shocks are skipped without it). */
  baseCurrency?: string;
}

let defaultBaseCache: MarketPeriod | null = null;
function defaultBase(): MarketPeriod {
  if (!defaultBaseCache) {
    const a = Assumptions.parse({});
    const r = (s: RateSpec) => (s.kind === "fixed" ? s.rate : 0);
    defaultBaseCache = {
      stocks: r(a.stockReturn),
      bonds: r(a.bondReturn),
      cash: r(a.cashReturn),
      inflation: r(a.inflation),
      dividendYield: r(a.dividendYield),
      bondYield: r(a.bondYield),
      crypto: r(a.cryptoReturn),
    };
  }
  return defaultBaseCache;
}

function baseAt(ctx: SamplerContext, i: number): MarketPeriod {
  return ctx.base?.[i] ?? ctx.base?.[ctx.base.length - 1] ?? defaultBase();
}

/** Number of trials a method runs: fixed by the data for historical-sequential, else `settings.trials`. */
export function trialCountFor(
  settings: MonteCarloSettings,
  periods: number,
  ctx: SamplerContext = {},
): number {
  if (settings.method !== "historical-sequential") return settings.trials;
  if (ctx.startYears) return ctx.startYears.length;
  const ds = getMarketDataset(settings.dataset);
  const windows = datasetLength(ds) - periods + 1;
  if (windows < 1)
    throw new ScenarioError(
      `historical-sequential needs ${periods} years of data but ${ds.id} has ${datasetLength(ds)}; use random-restart or block-bootstrap, or a longer dataset`,
      { periods, dataset: ds.id },
    );
  return windows;
}

/** Start year of a historical-sequential trial. */
export function sequentialStartYear(
  settings: MonteCarloSettings,
  trial: number,
  ctx: SamplerContext = {},
): number {
  const ds = getMarketDataset(settings.dataset);
  return ctx.startYears?.[trial] ?? ds.firstYear + trial;
}

/**
 * Generate one market path of `periods` periods for the given settings.
 * `trial` selects the start year for historical-sequential; random methods use only `rng`.
 */
export function sampleMarketPath(
  settings: MonteCarloSettings,
  periods: number,
  rng: Rng,
  trial: number,
  ctx: SamplerContext = {},
): MarketPath {
  const path =
    settings.method === "normal"
      ? sampleNormalPath(settings, periods, rng, ctx)
      : sampleHistoricalPath(settings, periods, rng, trial, ctx);
  const sourced = settings.sources ? applySources(settings, path, rng, ctx) : path;
  return settings.fx?.pairs.length && ctx.baseCurrency
    ? applyFxShocks(settings.fx, sourced, rng, ctx.baseCurrency)
    : sourced;
}

/**
 * MonteCarloSettings.fx: correlated yearly log-normal FX shocks. Each pair's shock is
 * exp(sigma z - sigma^2 / 2) (mean 1, so the pair keeps its deterministic drift on average); the
 * pairs' z share the common `correlation`. Drawn after every other series so enabling FX risk
 * never reshuffles the market draws. Reported per foreign currency as its base-currency value
 * surprise (a pair quoted as base -> foreign is inverted).
 */
function applyFxShocks(
  fx: NonNullable<MonteCarloSettings["fx"]>,
  path: MarketPath,
  rng: Rng,
  base: string,
): MarketPath {
  const legs = fx.pairs.map((p) => {
    if (p.to === base) return { currency: p.from, sign: 1, sigma: p.volatility };
    if (p.from === base) return { currency: p.to, sign: -1, sigma: p.volatility };
    throw new ValidationError(
      `Monte Carlo FX pair ${p.from}/${p.to} does not involve the household currency ${base}`,
      { from: p.from, to: p.to, base },
    );
  });
  const seen = new Set<string>();
  for (const l of legs) {
    if (seen.has(l.currency))
      throw new ValidationError(`Monte Carlo FX lists ${l.currency} more than once`, {
        currency: l.currency,
      });
    seen.add(l.currency);
  }
  const n = legs.length;
  const chol = cholesky(
    Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 1 : fx.correlation)),
    ),
  );
  const periods = path.periods.map((p) => {
    const e = legs.map(() => rng.normal());
    const shocks: Record<string, number> = { ...(p.fx ?? {}) };
    legs.forEach((l, i) => {
      let z = 0;
      for (let k = 0; k <= i; k++) z += chol[i]![k]! * e[k]!;
      shocks[l.currency] = Math.exp(l.sign * (l.sigma * z - (l.sigma * l.sigma) / 2));
    });
    return { ...p, fx: shocks };
  });
  return { periods };
}

/**
 * MonteCarloSettings.sources: per-series override of where a series comes from. 'fixed' keeps the
 * plan assumption; 'distribution' draws the series from `distributions` (independent normal draws,
 * consumed after the method's own draws so other series are unaffected); 'method' leaves it.
 */
function applySources(
  settings: MonteCarloSettings,
  path: MarketPath,
  rng: Rng,
  ctx: SamplerContext,
): MarketPath {
  const src = settings.sources!;
  const d = settings.distributions;
  const drawer = makeDrawer(settings.distributionShape ?? "normal");
  const fields: [keyof NonNullable<MonteCarloSettings["sources"]>, keyof MarketPeriod][] = [
    ["stocks", "stocks"],
    ["bonds", "bonds"],
    ["inflation", "inflation"],
    ["dividends", "dividendYield"],
    ["crypto", "crypto"],
  ];
  const periods = path.periods.map((p, i) => {
    const base = baseAt(ctx, i);
    const out = { ...p };
    for (const [key, field] of fields) {
      const mode = src[key];
      if (mode === "fixed") (out[field] as number) = base[field] as number;
      else if (mode === "distribution") {
        const z = rng.normal();
        (out[field] as number) =
          key === "dividends"
            ? Math.max(0, d.dividends.mean + d.dividends.stdDev * z)
            : drawer.draw(d[key], z);
      }
    }
    return out;
  });
  return { periods };
}

// ------------------------------------------------------------------------------ parametric

interface Drawer {
  draw(d: Dist, z: number): number;
}

function makeDrawer(shape: "normal" | "lognormal"): Drawer {
  if (shape === "normal") return { draw: (d, z) => Math.max(-1, d.mean + d.stdDev * z) };
  const cache = new Map<Dist, { mu: number; sigma: number }>();
  return {
    draw(d, z) {
      let p = cache.get(d);
      if (!p) {
        const m = 1 + d.mean;
        if (m <= 0)
          throw new ValidationError("log-normal returns need a mean above -100%", { mean: d.mean });
        const s2 = Math.log(1 + (d.stdDev * d.stdDev) / (m * m));
        p = { mu: Math.log(m) - s2 / 2, sigma: Math.sqrt(s2) };
        cache.set(d, p);
      }
      return Math.exp(p.mu + p.sigma * z) - 1;
    },
  };
}

function sampleNormalPath(
  settings: MonteCarloSettings,
  periods: number,
  rng: Rng,
  ctx: SamplerContext,
): MarketPath {
  const d = settings.distributions;
  const c = d.correlation;
  const l = cholesky([
    [1, c.stocksBonds, c.stocksInflation],
    [c.stocksBonds, 1, c.bondsInflation],
    [c.stocksInflation, c.bondsInflation, 1],
  ]);
  const drawer = makeDrawer(settings.distributionShape ?? "normal");
  const nu = settings.fatTails?.degreesOfFreedom;
  const v = settings.vary;
  const out: MarketPeriod[] = new Array(periods);
  for (let i = 0; i < periods; i++) {
    const base = baseAt(ctx, i);
    // Always consume the same draws so toggling `vary` flags never reshuffles other series.
    const e1 = rng.normal();
    const e2 = rng.normal();
    const e3 = rng.normal();
    let zd = rng.normal();
    let zc = rng.normal();
    let zk = rng.normal();
    let z1 = l[0]![0]! * e1;
    let z2 = l[1]![0]! * e1 + l[1]![1]! * e2;
    let z3 = l[2]![0]! * e1 + l[2]![1]! * e2 + l[2]![2]! * e3;
    if (nu !== undefined) {
      // Multivariate Student-t with unit variance: shared chi-square mixing keeps correlations.
      const s = Math.sqrt((nu - 2) / chiSquare(rng, nu));
      z1 *= s;
      z2 *= s;
      z3 *= s;
      zd *= s;
      zc *= s;
      zk *= s;
    }
    out[i] = {
      stocks: v.stocks ? drawer.draw(d.stocks, z1) : base.stocks,
      bonds: v.bonds ? drawer.draw(d.bonds, z2) : base.bonds,
      inflation: v.inflation ? drawer.draw(d.inflation, z3) : base.inflation,
      dividendYield: v.dividends
        ? Math.max(0, d.dividends.mean + d.dividends.stdDev * zd)
        : base.dividendYield,
      crypto: v.crypto ? drawer.draw(d.crypto, zc) : base.crypto,
      cash: d.cash ? drawer.draw(d.cash, zk) : base.cash,
      bondYield: base.bondYield,
    };
  }
  return { periods: out };
}

// ------------------------------------------------------------------------------ historical

/** Data-year indexes for one trial. */
export function historicalYearIndexes(
  settings: MonteCarloSettings,
  ds: MarketDataset,
  periods: number,
  rng: Rng,
  trial: number,
  ctx: SamplerContext = {},
): number[] {
  const n = datasetLength(ds);
  const idx: number[] = [];
  switch (settings.method) {
    case "historical-sequential": {
      const start = sequentialStartYear(settings, trial, ctx) - ds.firstYear;
      if (start < 0 || start + periods > n)
        throw new ScenarioError(
          `start year ${ds.firstYear + start} does not leave ${periods} years of data in ${ds.id} (no looping)`,
          { dataset: ds.id, startYear: ds.firstYear + start, periods },
        );
      for (let i = 0; i < periods; i++) idx.push(start + i);
      return idx;
    }
    case "historical-random-restart": {
      let cur = rng.int(n);
      for (let i = 0; i < periods; i++) {
        idx.push(cur);
        cur += 1;
        if (cur >= n) cur = rng.int(n);
      }
      return idx;
    }
    case "block-bootstrap": {
      const len = Math.min(settings.blockLength, n);
      while (idx.length < periods) {
        const s = rng.int(n - len + 1);
        for (let k = 0; k < len && idx.length < periods; k++) idx.push(s + k);
      }
      return idx;
    }
    default:
      throw new ValidationError(`'${settings.method}' is not a historical method`);
  }
}

function sampleHistoricalPath(
  settings: MonteCarloSettings,
  periods: number,
  rng: Rng,
  trial: number,
  ctx: SamplerContext,
): MarketPath {
  const ds = getMarketDataset(settings.dataset);
  const idx = historicalYearIndexes(settings, ds, periods, rng, trial, ctx);
  const s = ds.series;
  const v = settings.vary;
  const crypto = settings.distributions.crypto;
  const drawer = makeDrawer(settings.distributionShape ?? "normal");
  const out: MarketPeriod[] = new Array(periods);
  for (let i = 0; i < periods; i++) {
    const base = baseAt(ctx, i);
    const k = idx[i]!;
    // No crypto history exists: draw it from its distribution, independent of the data year.
    const zc = rng.normal();
    // Historical returns are nominal: they embed that year's inflation. When inflation is NOT
    // drawn from history (it stays at the plan assumption) keep each year's REAL return and
    // re-inflate it at the plan's inflation, otherwise a high-inflation year's nominal return
    // would be paired with low plan inflation (and vice versa), distorting real outcomes.
    const histInf = s.inflation[k];
    const reprice =
      !v.inflation && typeof histInf === "number"
        ? (x: number) => ((1 + x) * (1 + base.inflation)) / (1 + histInf) - 1
        : (x: number) => x;
    const histCash = s.cash[k];
    out[i] = {
      stocks: v.stocks ? reprice(s.stocks[k]!) : base.stocks,
      dividendYield: v.dividends ? s.dividendYield[k]! : base.dividendYield,
      bonds: v.bonds ? reprice(s.bonds[k]!) : base.bonds,
      bondYield: v.bonds ? s.bondYield[k]! : base.bondYield,
      cash: typeof histCash === "number" ? reprice(histCash) : base.cash,
      inflation: v.inflation ? s.inflation[k]! : base.inflation,
      crypto: v.crypto ? drawer.draw(crypto, zc) : base.crypto,
      sourceYear: ds.firstYear + k,
    };
  }
  return { periods: out };
}
