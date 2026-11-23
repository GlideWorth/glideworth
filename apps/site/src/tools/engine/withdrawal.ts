/**
 * Retirement withdrawal calculator: four withdrawal rules the engine implements, run on the same
 * simulated markets (same seed, so every rule sees the same return sequences).
 *
 * Engine use: the plan's `withdrawalStrategy` with each rule (`initial-percent` = constant real,
 * `fixed-percent`, `guyton-klinger` with a 20% guardrail and 10% adjustment, `vpw`), run through
 * `createMonteCarloSession`. The rule sets each year's gross withdrawal; tax (if any) comes out of it.
 * Income is what the rule actually paid (the engine's `spending` total), deflated to today's money.
 * `constantRealSurvival` runs only the constant-real rule across rates and horizons for the
 * safe-withdrawal table; it uses the same session as the comparison.
 */
import { createMonteCarloSession, type WithdrawalStrategy } from "@glideworth/core";
import { money, pct, pctInput, whole } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, Timing, Values, ViewModel } from "../types";
import { percentile, type RunOptions, stepSession } from "./common";
import { buildInput, monteCarloSettings, taxText, timingText } from "./model";
import { marketModel, modelText } from "./monte-carlo";

export interface RuleDef {
  id: "constant" | "percent" | "guardrails" | "vpw";
  name: string;
  rule: (rate: number) => WithdrawalStrategy["rule"];
}

export const RULES: RuleDef[] = [
  { id: "constant", name: "Constant real", rule: (r) => ({ kind: "initial-percent", rate: r }) },
  { id: "percent", name: "Fixed percentage", rule: (r) => ({ kind: "fixed-percent", rate: r }) },
  {
    id: "guardrails",
    name: "Guyton-Klinger guardrails",
    rule: (r) => ({ kind: "guyton-klinger", rate: r, guardrail: 0.2, adjustment: 0.1 }),
  },
  { id: "vpw", name: "VPW", rule: () => ({ kind: "vpw" }) },
];

/** Share of year-1 income below which a year counts as a deep cut. */
export const CUT_LINE = 0.75;

export interface RuleStats {
  id: RuleDef["id"];
  name: string;
  year1: number;
  medianMid: number;
  p10Last: number;
  belowLine: number;
  medianLargestCut: number;
  shortBeforeLast: number;
  shortAny: number;
  /** Share of trials whose real balance at the end was at least the starting balance. */
  preserved: number;
  medianEnd: number;
  bands: { p10: number[]; p25: number[]; p50: number[]; p75: number[]; p90: number[] };
}

/**
 * One rule on the market model in `v`. `place` only shares a progress bar across several rules;
 * the seed, and so the market sequences, does not depend on it.
 */
async function runRule(
  def: RuleDef,
  v: Values,
  opts: RunOptions,
  place: { index: number; count: number },
): Promise<RuleStats> {
  const balance = num(v, "balance");
  const wr = rate(v, "rate");
  const years = num(v, "years");
  const trials = Number(str(v, "trials"));
  const seed = num(v, "seed");
  const model = marketModel(v);
  const settings = monteCarloSettings(model, trials, seed);
  const input = buildInput({
    currency: str(v, "cur"),
    age: 65,
    years,
    balance,
    timing: str(v, "timing") as Timing,
    taxRate: rate(v, "tax"),
    realReturn: model.kind === "parametric" ? model.mean : 0,
    ...(model.kind === "parametric" ? {} : { stockShare: rate(v, "stocks") }),
    withdrawalStrategy: { rule: def.rule(wr), treatAsSpending: false },
  });
  const session = createMonteCarloSession(input, settings, {
    metrics: ["spending", "portfolio", "shortfall"],
    keepTrials: false,
  });
  await stepSession(session, {
    ...opts,
    offset: place.index * session.total,
    total: place.count * session.total,
  });
  const shard = session.shard();
  const Y = shard.years.length;
  const M = shard.metrics.length;
  const T = shard.trialIndex.length;
  const mi = (name: string) => shard.metrics.indexOf(name as (typeof shard.metrics)[number]);
  const [iS, iP, iF] = [mi("spending"), mi("portfolio"), mi("shortfall")];
  const deflF = (t: number, y: number) => shard.priceIndexStart?.[t * Y + y] || 1;
  const deflS = (t: number, y: number) => shard.priceIndex[t * Y + y] || 1;
  const income: number[][] = [];
  const ends: number[] = [];
  const cuts: number[] = [];
  let below = 0;
  let shortEarly = 0;
  let shortAny = 0;
  let preserved = 0;
  for (let t = 0; t < T; t++) {
    const row: number[] = [];
    let early = false;
    let any = false;
    for (let y = 0; y < Y; y++) {
      row.push(shard.values[(t * M + iS) * Y + y]! / deflF(t, y));
      const shortfall = shard.values[(t * M + iF) * Y + y]!;
      if (shortfall > 1e-6) {
        any = true;
        if (y < Y - 1) early = true;
      }
    }
    income.push(row);
    const end = shard.values[(t * M + iP) * Y + (Y - 1)]! / deflS(t, Y - 1);
    ends.push(end);
    if (end >= balance - 1e-6) preserved++;
    const first = row[0] ?? 0;
    if (row.some((x) => x < CUT_LINE * first - 1e-6)) below++;
    let worst = 0;
    for (let y = 1; y < Y; y++) {
      const prev = row[y - 1]!;
      if (prev > 1e-9) worst = Math.max(worst, (prev - row[y]!) / prev);
    }
    cuts.push(worst);
    if (early) shortEarly++;
    if (any) shortAny++;
  }
  const col = (y: number) => income.map((r) => r[y] ?? 0);
  const q = (p: number) => Array.from({ length: Y }, (_, y) => percentile(col(y), p));
  return {
    id: def.id,
    name: def.name,
    year1: percentile(col(0), 0.5),
    medianMid: percentile(col(Math.floor((Y - 1) / 2)), 0.5),
    p10Last: percentile(col(Y - 1), 0.1),
    belowLine: below / T,
    medianLargestCut: percentile(cuts, 0.5),
    shortBeforeLast: shortEarly / T,
    shortAny: shortAny / T,
    preserved: preserved / T,
    medianEnd: percentile(ends, 0.5),
    bands: { p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9) },
  };
}

export async function compareRules(v: Values, opts: RunOptions = {}): Promise<RuleStats[]> {
  const out: RuleStats[] = [];
  for (const [k, def] of RULES.entries())
    out.push(await runRule(def, v, opts, { index: k, count: RULES.length }));
  return out;
}

/** Initial rates (percent, as the form stores them) and horizons for the safe-withdrawal table. */
export const SWR_RATES = [3, 3.5, 4, 4.5, 5] as const;
export const SWR_YEARS = [30, 40, 50] as const;

export interface SurvivalCell {
  /** Initial withdrawal rate in percent (4 means 4%). */
  rate: number;
  years: number;
  /** Share of trials in which the constant-real rule paid every year in full. */
  lasted: number;
  /** Share of trials whose real balance at the end was at least the starting balance. */
  preserved: number;
  medianEnd: number;
}

/**
 * Chance the constant-real rule pays every year, for each initial rate and horizon, on the market
 * model already in `v` (the rate and the horizon are overridden per cell). Same engine path as
 * `compareRules`, so a cell with `v`'s own rate and horizon matches that comparison's constant-real
 * row. Rates are in percent, matching the calculator form.
 */
export async function constantRealSurvival(
  v: Values,
  rates: readonly number[] = SWR_RATES,
  horizons: readonly number[] = SWR_YEARS,
  opts: RunOptions = {},
): Promise<SurvivalCell[]> {
  const jobs = horizons.flatMap((years) => rates.map((rate) => ({ rate, years })));
  const constant = RULES.find((r) => r.id === "constant");
  if (!constant) throw new Error("constant-real rule missing");
  const out: SurvivalCell[] = [];
  for (const [k, job] of jobs.entries()) {
    const stats = await runRule(constant, { ...v, rate: job.rate, years: job.years }, opts, {
      index: k,
      count: jobs.length,
    });
    out.push({
      rate: job.rate,
      years: job.years,
      lasted: 1 - stats.shortAny,
      preserved: stats.preserved,
      medianEnd: stats.medianEnd,
    });
  }
  return out;
}

export async function runWithdrawal(v: Values, opts: RunOptions = {}): Promise<ViewModel> {
  const balance = num(v, "balance");
  const wr = rate(v, "rate");
  const years = num(v, "years");
  const trials = Number(str(v, "trials"));
  const seed = num(v, "seed");
  const tax = rate(v, "tax");
  const timing = str(v, "timing") as Timing;
  const cur = str(v, "cur");
  const stocks = rate(v, "stocks");
  const model = marketModel(v);
  const m = (x: number) => money(x, cur);
  const stats = await compareRules(v, opts);
  const mid = Math.floor((years - 1) / 2) + 1;
  const byId = (id: RuleStats["id"]) => stats.find((s) => s.id === id)!;
  const constant = byId("constant");
  const percent = byId("percent");

  const yMax = Math.max(...stats.map((s) => Math.max(...s.bands.p90.filter(Number.isFinite))));
  const x = Array.from({ length: years }, (_, i) => i + 1);
  const charts: ChartSpec[] = stats.map((s) => ({
    id: `wd-${s.id}`,
    kind: "line",
    title: `${s.name}: yearly income`,
    summary: `${s.name}: median income starts at ${m(s.year1)} and is ${m(s.bands.p50[years - 1] ?? 0)} in year ${years}; in the worst tenth of simulations it is ${m(s.p10Last)} or less in year ${years}.`,
    xLabel: "Year of retirement",
    yLabel: "Today’s money",
    x,
    bands: [
      {
        label: "10th to 90th percentile (lighter band)",
        lower: s.bands.p10,
        upper: s.bands.p90,
        tone: 1,
        level: "outer",
      },
      {
        label: "25th to 75th percentile (darker band)",
        lower: s.bands.p25,
        upper: s.bands.p75,
        tone: 1,
        level: "inner",
      },
    ],
    series: [{ label: "Median", values: s.bands.p50, tone: 1, style: "solid" }],
    hLines: [{ y: CUT_LINE * s.year1, label: `75% of year 1` }],
    yMax,
    currency: cur,
    table: {
      caption: `${s.name}: income percentiles by year (today’s money)`,
      columns: ["Year", "10th", "Median", "90th"],
      rows: x.map((yr, i) => [
        String(yr),
        m(s.bands.p10[i] ?? 0),
        m(s.bands.p50[i] ?? 0),
        m(s.bands.p90[i] ?? 0),
      ]),
    },
  }));

  const headline = `Over ${whole(trials)} simulated ${years}-year retirements from ${m(balance)}, constant real withdrawals of ${m(constant.year1)} ran short before the final year in ${pct(constant.shortBeforeLast, 1)} of them; a fixed ${pctInput(wr * 100)} of the portfolio never ran out, but income fell below ${m(CUT_LINE * percent.year1)} at some point in ${pct(percent.belowLine, 0)}.`;

  return {
    tool: "withdrawal",
    headline,
    announce: `Compared four rules over ${whole(trials)} simulations.`,
    figures: [],
    table: {
      caption:
        "Four rules on the same simulated markets (income is what the rule paid, in today’s money)",
      columns: [
        "Rule",
        "Year-1 income",
        `Median income, year ${mid}`,
        `10th percentile, year ${years}`,
        "Income ever below 75% of year 1",
        "Median largest one-year cut",
        "Ran short before the final year",
        "Median left at the end",
      ],
      rows: stats.map((s) => [
        s.name,
        m(s.year1),
        m(s.medianMid),
        m(s.p10Last),
        pct(s.belowLine, 1),
        pct(s.medianLargestCut, 1),
        pct(s.shortBeforeLast, 1),
        m(s.medianEnd),
      ]),
    },
    charts,
    smallMultiples: true,
    method: [
      modelText(model, stocks),
      `${whole(trials)} simulations per rule with seed ${seed}; every rule sees the same market sequences.`,
      `Rules (the engine’s withdrawal strategies): constant real takes ${pctInput(wr * 100)} of the starting portfolio, then raises it with inflation; fixed percentage takes ${pctInput(wr * 100)} of each year’s balance; Guyton-Klinger starts at ${pctInput(wr * 100)}, skips the inflation raise after a losing year when the rate is above the initial one, cuts 10% when the rate is over 120% of the initial rate (not in the last 15 years) and raises 10% when it is under 80%; VPW amortises the balance over the years left at an assumed real return (5% for stocks, 1.9% for bonds, weighted by the mix; the random-returns model counts as all stocks).`,
      `“Ran short before the final year” counts simulations with a year before the last in which the rule’s amount could not be paid in full (${pct(constant.shortAny, 1)} of constant-real simulations had any short year, including the last).`,
      timingText(timing),
      taxText(tax),
    ],
    warnings: [],
  };
}
