/**
 * Monte Carlo retirement calculator: the share of simulated market sequences in which every year's
 * spending is paid.
 *
 * Engine use: `createMonteCarloSession` (run in chunks so it can report progress and be cancelled) on
 * a plan with the portfolio, inflation-linked spending, optional after-tax income from a chosen year
 * and the flat tax on withdrawals. Market models:
 *  - 'history': historical-random-restart on `us-1928` (each trial starts in a random year and walks
 *    forward through real consecutive years, restarting at a random year when the data runs out);
 *  - 'block': block-bootstrap on `us-1928` with 5-year blocks;
 *  - 'parametric': 'normal' sampler with a log-normal shape for the portfolio's real return, inflation
 *    held at 0 (today's money).
 * Success is the engine's 'all-funded' definition. Percentile bands are in today's money.
 */
import { createMonteCarloSession, MARKET_DATASETS, type MonteCarloResult } from "@glideworth/core";
import { marginOfError } from "../closed-form";
import { money, pct, pctInput, whole, wholeYears } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, Timing, Values, ViewModel } from "../types";
import { percentile, type RunOptions, stepSession } from "./common";
import {
  buildInput,
  HISTORY_DATASET,
  type MarketModel,
  monteCarloSettings,
  START_YEAR,
  taxText,
  timingText,
} from "./model";

export function marketModel(v: Values): MarketModel {
  const method = str(v, "method");
  if (method === "parametric")
    return { kind: "parametric", mean: rate(v, "mean"), vol: rate(v, "vol") };
  return { kind: method === "block" ? "block" : "history" };
}

export function modelText(model: MarketModel, stocks: number): string {
  const ds = MARKET_DATASETS[HISTORY_DATASET];
  if (model.kind === "parametric")
    return `Random returns: each year’s real return is drawn independently from a log-normal distribution with an average of ${pctInput(model.mean * 100)} and a standard deviation of ${pctInput(model.vol * 100)} (the engine’s “normal” sampler with a log-normal shape). Inflation is held at 0, so every figure is in today’s money.`;
  const how =
    model.kind === "block"
      ? "blocks of 5 consecutive historical years, picked at random and stitched together (block bootstrap)"
      : "a random historical start year, then real consecutive years, restarting at a random year when the data runs out";
  return `US history: ${how}, from ${ds.label}. Portfolio ${pctInput(stocks * 100)} stocks and ${pctInput(100 - stocks * 100)} bonds, rebalanced yearly; real returns and inflation come from the data and results are converted back to today’s money.`;
}

/** Runs the calculator's plan through the engine's Monte Carlo runner (in chunks, cancellable). */
export async function simulatePlan(v: Values, opts: RunOptions = {}): Promise<MonteCarloResult> {
  const years = num(v, "years");
  const inc = num(v, "inc");
  const incFrom = num(v, "incFrom");
  const model = marketModel(v);
  const input = buildInput({
    currency: str(v, "cur"),
    age: 65,
    years,
    balance: num(v, "balance"),
    timing: str(v, "timing") as Timing,
    taxRate: rate(v, "tax"),
    realReturn: model.kind === "parametric" ? model.mean : 0,
    ...(model.kind === "parametric" ? {} : { stockShare: rate(v, "stocks") }),
    spending: [{ id: "spending", name: "Spending", amount: num(v, "spend"), from: 0, to: null }],
    income:
      inc > 0 && incFrom < years
        ? [{ id: "income", name: "Other income", amount: inc, from: incFrom, to: null }]
        : [],
  });
  const settings = monteCarloSettings(model, Number(str(v, "trials")), num(v, "seed"));
  const session = createMonteCarloSession(input, settings, {
    metrics: ["portfolio"],
    keepTrials: true,
  });
  await stepSession(session, opts);
  return session.result();
}

export async function runMonteCarloTool(v: Values, opts: RunOptions = {}): Promise<ViewModel> {
  const balance = num(v, "balance");
  const spend = num(v, "spend");
  const years = num(v, "years");
  const stocks = rate(v, "stocks");
  const seed = num(v, "seed");
  const inc = num(v, "inc");
  const incFrom = num(v, "incFrom");
  const tax = rate(v, "tax");
  const timing = str(v, "timing") as Timing;
  const cur = str(v, "cur");
  const model = marketModel(v);
  const m = (x: number) => money(x, cur);
  const r = await simulatePlan(v, opts);

  const p = r.successRate;
  const moe = marginOfError(p, r.trials);
  const ok = Math.round(p * r.trials);
  const band = r.percentiles.find((s) => s.metric === "portfolio");
  const at = (q: number) => band?.bands.find((b) => Math.abs(b.p - q) < 1e-9)?.values ?? [];
  const Y = band?.years.length ?? 0;
  const x = Array.from({ length: Y + 1 }, (_, i) => i);
  const withStart = (vals: number[]) => [balance, ...vals];
  const p10 = withStart(at(0.1));
  const p25 = withStart(at(0.25));
  const p50 = withStart(at(0.5));
  const p75 = withStart(at(0.75));
  const p90 = withStart(at(0.9));

  const failures = r.trialSummaries.filter((t) => !t.success);
  const failYears = failures.map(
    (t) => (t.firstShortfallYear ?? START_YEAR + years) - START_YEAR + 1,
  );
  const medianFail = failYears.length ? percentile(failYears, 0.5) : Number.NaN;
  const failedBy = x.map((y) => (y === 0 ? 0 : failYears.filter((f) => f <= y).length / r.trials));

  const fan: ChartSpec = {
    id: "mc-fan",
    kind: "line",
    title: "Portfolio across the simulations, in today’s money",
    summary: `Half the simulations end above ${m(p50[Y] ?? 0)} after ${years} years. One in ten ends below ${m(p10[Y] ?? 0)}, and one in ten above ${m(p90[Y] ?? 0)}.`,
    xLabel: "Year",
    yLabel: "Today’s money",
    x,
    bands: [
      {
        label: "10th to 90th percentile (lighter band)",
        lower: p10,
        upper: p90,
        tone: 1,
        level: "outer",
      },
      {
        label: "25th to 75th percentile (darker band)",
        lower: p25,
        upper: p75,
        tone: 1,
        level: "inner",
      },
    ],
    series: [{ label: "Median (50th percentile)", values: p50, tone: 1, style: "solid" }],
    currency: cur,
    table: {
      caption: "Portfolio percentiles at the end of each year (today’s money)",
      columns: ["Year", "10th", "25th", "Median", "75th", "90th"],
      rows: x.map((y) => [
        String(y),
        m(p10[y] ?? 0),
        m(p25[y] ?? 0),
        m(p50[y] ?? 0),
        m(p75[y] ?? 0),
        m(p90[y] ?? 0),
      ]),
    },
  };
  const failChart: ChartSpec = {
    id: "mc-failures",
    kind: "line",
    title: "Share of simulations that have had a year not fully paid",
    summary: failures.length
      ? `${pct(failures.length / r.trials, 1)} of simulations had at least one year that could not be paid in full. Half of those first fell short by year ${Math.round(medianFail)}.`
      : "No simulation had a year that could not be paid in full.",
    xLabel: "Year",
    yLabel: "Share of simulations",
    yUnit: "percent",
    x,
    series: [{ label: "Fell short by this year", values: failedBy, tone: 4, style: "solid" }],
    currency: cur,
    table: {
      caption: "Cumulative share of simulations with a year not fully paid",
      columns: ["Year", "Share"],
      rows: x.filter((y) => y > 0).map((y) => [String(y), pct(failedBy[y] ?? 0, 1)]),
    },
  };

  return {
    tool: "monte-carlo",
    headline: `In ${whole(ok)} of ${whole(r.trials)} simulations (${pct(p, 1)}), every year’s spending of ${m(spend)} was paid for ${wholeYears(years)}. The sampling margin on that figure is about ±${(moe * 100).toFixed(1)} points.`,
    announce: `Chance of success ${pct(p, 1)} over ${whole(r.trials)} simulations.`,
    figures: [
      {
        label: "Chance of success",
        value: pct(p, 1),
        detail: `±${(moe * 100).toFixed(1)} points (95% sampling margin)`,
      },
      {
        label: "Simulations that fell short",
        value: whole(failures.length),
        detail: failures.length ? `Half of them by year ${Math.round(medianFail)}` : "None",
      },
      {
        label: `Median portfolio after ${years} years`,
        value: m(p50[Y] ?? 0),
        detail: "Today’s money",
      },
      {
        label: "10th percentile after that",
        value: m(p10[Y] ?? 0),
        detail: "One simulation in ten ends lower",
      },
    ],
    charts: [fan, failChart],
    method: [
      modelText(model, stocks),
      `${whole(r.trials)} simulations with seed ${seed}: the same seed and inputs always give the same result (engine runMonteCarlo, one derived seed per trial).`,
      "Success: every year’s spending paid in full (the engine’s “all funded” definition). A simulation that is short by a little in its last year counts as a failure.",
      ...(inc > 0 && incFrom < years
        ? [
            `Other income of ${m(inc)} a year (after tax, rising with inflation) from year ${incFrom + 1}.`,
          ]
        : []),
      timingText(timing),
      taxText(tax),
    ],
    warnings: [],
  };
}
