/**
 * Historical retirement calculator (backtest): the plan replayed through every start year of US
 * history from 1928, each start year's portfolio drawn as its own line.
 *
 * Engine use: `createMonteCarloSession` with method 'historical-sequential' on `us-1928` (one trial per
 * start year whose whole horizon fits in the data, no looping, no random numbers), stepped in chunks so
 * it reports progress and can be cancelled (history-runs.ts). Spending rules:
 *  - 'constant': a yearly expense in today's money (rises with each year's inflation in the data);
 *  - 'guardrails', 'percent', 'vpw': the plan's `withdrawalStrategy` with the engine's
 *    `guyton-klinger` (its default 20% guardrail and 10% adjustment), `fixed-percent` and `vpw` rules,
 *    at an initial rate of spending ÷ portfolio.
 * Success is the engine's 'all-funded' definition: every year's amount paid in full.
 */
import { MARKET_DATASETS, VPW_REAL_RETURNS, WithdrawalStrategyRule } from "@glideworth/core";
import { money, pct, pctInput, whole, wholeYears } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, Table, Timing, Values, ViewModel } from "../types";
import { percentile, type RunOptions } from "./common";
import { replayHistory, type StartYearRun, worstFirst } from "./history-runs";
import { buildInput, HISTORY_DATASET, taxText, timingText, type Window } from "./model";

export type BacktestRule = "constant" | "guardrails" | "percent" | "vpw";

/** Guyton-Klinger with the engine's own defaults (read from the schema, never typed in). */
const GK_DEFAULTS = WithdrawalStrategyRule.parse({ kind: "guyton-klinger", rate: 0.04 }) as {
  guardrail: number;
  adjustment: number;
};

export const RULE_NAMES: Record<BacktestRule, string> = {
  constant: "Constant real spending",
  guardrails: "Guyton-Klinger guardrails",
  percent: "Fixed percentage of the portfolio",
  vpw: "VPW (variable percentage withdrawal)",
};

/** How many of the worst start years the table lists. */
export const WORST_SHOWN = 5;

export interface Backtest {
  rule: BacktestRule;
  runs: StartYearRun[];
  lasted: number;
  worst: StartYearRun[];
  medianEnd: number;
  lowestEnd: number;
  /** Lowest yearly spending paid in any start year (today's money). */
  lowestSpending: number;
  /** Year-1 spending (the same in every start year for each rule). */
  firstYear: number;
}

export async function backtest(v: Values, opts: RunOptions = {}): Promise<Backtest> {
  const balance = num(v, "balance");
  const spend = num(v, "spend");
  const years = num(v, "years");
  const inc = num(v, "inc");
  const incFrom = num(v, "incFrom");
  const rule = str(v, "rule") as BacktestRule;
  // The engine caps a rule’s rate at 10 (1,000%); at that rate a year takes everything anyway.
  const initialRate = balance > 0 ? Math.min(10, spend / balance) : 0;
  const income: Window[] =
    inc > 0 && incFrom < years
      ? [{ id: "income", name: "Other income", amount: inc, from: incFrom, to: null }]
      : [];
  const ruleSpec =
    rule === "constant" || balance <= 0
      ? null
      : rule === "guardrails"
        ? ({
            kind: "guyton-klinger",
            rate: initialRate,
            guardrail: GK_DEFAULTS.guardrail,
            adjustment: GK_DEFAULTS.adjustment,
          } as const)
        : rule === "percent"
          ? ({ kind: "fixed-percent", rate: initialRate } as const)
          : ({ kind: "vpw" } as const);
  const input = buildInput({
    currency: str(v, "cur"),
    age: 65,
    years,
    balance,
    timing: str(v, "timing") as Timing,
    taxRate: rate(v, "tax"),
    realReturn: 0,
    stockShare: rate(v, "stocks"),
    income,
    ...(ruleSpec
      ? { withdrawalStrategy: { rule: ruleSpec, treatAsSpending: false } }
      : {
          spending: [{ id: "spending", name: "Spending", amount: spend, from: 0, to: null }],
        }),
  });
  const runs = await replayHistory(input, balance, opts);
  const ends = runs.map((r) => r.end);
  return {
    rule,
    runs,
    lasted: runs.filter((r) => r.firstShortYear === null).length,
    worst: worstFirst(runs, rule === "constant" ? "end" : "spending").slice(0, WORST_SHOWN),
    medianEnd: ends.length ? percentile(ends, 0.5) : 0,
    lowestEnd: ends.length ? Math.min(...ends) : 0,
    lowestSpending: runs.length ? Math.min(...runs.map((r) => r.minSpending)) : 0,
    firstYear: runs[0]?.spending[0] ?? 0,
  };
}

function ruleText(rule: BacktestRule, initialRate: number): string {
  const r = pctInput(Number((initialRate * 100).toFixed(2)));
  switch (rule) {
    case "constant":
      return "Spending rule: the same amount in today’s money every year, raised by each historical year’s inflation, whatever the portfolio does.";
    case "guardrails":
      return `Spending rule: Guyton-Klinger guardrails (the engine’s guyton-klinger rule) starting at ${r}. No inflation raise after a losing year while the rate is above ${r}; a ${pct(GK_DEFAULTS.adjustment, 0)} cut when the rate is more than ${pct(GK_DEFAULTS.guardrail, 0)} above it (not in the last 15 years), a ${pct(GK_DEFAULTS.adjustment, 0)} raise when it is more than ${pct(GK_DEFAULTS.guardrail, 0)} below. These are the engine’s defaults.`;
    case "percent":
      return `Spending rule: ${r} of each year’s portfolio (the engine’s fixed-percent rule). It cannot run out; income moves with the balance.`;
    case "vpw":
      return `Spending rule: VPW (the engine’s vpw rule), the payment that would spend the portfolio over the years left at an assumed real return of ${pct(VPW_REAL_RETURNS.stocks, 1)} for stocks and ${pct(VPW_REAL_RETURNS.bonds, 1)} for bonds, weighted by the mix. Your spending figure is not used. A start year counted as short under VPW is nearly always short only in its final year: the rule asks for the whole remaining balance grown at the assumed return, and a final year below that return leaves a little unpaid.`;
  }
}

export async function runHistoricalBacktest(v: Values, opts: RunOptions = {}): Promise<ViewModel> {
  const balance = num(v, "balance");
  const spend = num(v, "spend");
  const years = num(v, "years");
  const stocks = rate(v, "stocks");
  const inc = num(v, "inc");
  const incFrom = num(v, "incFrom");
  const timing = str(v, "timing") as Timing;
  const cur = str(v, "cur");
  const m = (x: number) => money(x, cur);
  const ds = MARKET_DATASETS[HISTORY_DATASET];
  const b = await backtest(v, opts);
  const n = b.runs.length;
  const rule = b.rule;
  const initialRate = balance > 0 ? spend / balance : 0;
  const first = b.runs[0]?.startYear ?? 0;
  const last = b.runs[n - 1]?.startYear ?? 0;
  const x = Array.from({ length: years + 1 }, (_, i) => i);
  const failed = b.runs.filter((r) => r.firstShortYear !== null);
  const okRuns = b.runs.filter((r) => r.firstShortYear === null);
  const worst = b.worst[0];
  const col = (y: number) => b.runs.map((r) => r.portfolio[y] ?? 0);
  const q = (y: number, p: number) => (n ? percentile(col(y), p) : 0);

  const pathsChart: ChartSpec = {
    id: "bt-paths",
    kind: "line",
    title: `The portfolio in every start year from ${first} to ${last}, in today’s money`,
    summary: n
      ? `${b.lasted} of ${n} start years paid every year in full${failed.length ? `; ${failed.length} ran short, the earliest in year ${worst?.firstShortYear ?? years} for a retirement starting in ${worst?.startYear ?? first}` : ""}. After ${years} years half the start years ended above ${m(b.medianEnd)} and the lowest ended at ${m(b.lowestEnd)}.`
      : "The data holds no start year with this many years after it.",
    xLabel: "Year of retirement",
    yLabel: "Today’s money",
    x,
    paths: [
      {
        label: `Paid every year (${okRuns.length} start years)`,
        lines: okRuns.map((r) => r.portfolio),
        tone: 1,
        style: "solid",
      },
      ...(failed.length
        ? [
            {
              label: `Ran short (${failed.length} start years, dashed)`,
              lines: failed.map((r) => r.portfolio),
              tone: 4 as const,
              style: "dashed" as const,
            },
          ]
        : []),
    ],
    series: [],
    hLines: balance > 0 ? [{ y: balance, label: "Starting amount" }] : [],
    currency: cur,
    table: {
      caption: "Portfolio across the start years at the end of each year (today’s money)",
      columns: ["Year", "Lowest", "10th percentile", "Median", "90th percentile", "Highest"],
      rows: x.map((y) => [
        String(y),
        m(n ? Math.min(...col(y)) : 0),
        m(q(y, 0.1)),
        m(q(y, 0.5)),
        m(q(y, 0.9)),
        m(n ? Math.max(...col(y)) : 0),
      ]),
    },
  };

  const endsChart: ChartSpec = {
    id: "bt-ends",
    kind: "bar",
    title: `Portfolio after ${years} years, by first year of retirement`,
    summary: n
      ? `Ending balances in today’s money for each start year from ${first} to ${last}. The median is ${m(b.medianEnd)}; ${pct(okRuns.filter((r) => r.end >= balance - 1e-6).length / n, 0)} of start years ended with at least the starting ${m(balance)}.`
      : "No start year to show.",
    xLabel: "First year of retirement",
    yLabel: "Today’s money",
    x: b.runs.map((r) => r.startYear),
    series: [
      {
        label: "Portfolio at the end",
        values: b.runs.map((r) => r.end),
        tone: 2,
        style: "solid",
      },
    ],
    currency: cur,
    table: {
      caption: "Every start year (today’s money)",
      columns: [
        "First year",
        "Years paid in full",
        "Lowest yearly spending",
        "Portfolio at the end",
      ],
      rows: b.runs.map((r) => [
        String(r.startYear),
        r.firstShortYear === null ? `All ${years}` : String(r.firstShortYear - 1),
        m(r.minSpending),
        m(r.end),
      ]),
    },
  };

  const charts: ChartSpec[] = [pathsChart, endsChart];
  if (rule !== "constant" && n) {
    const sp = (y: number) => b.runs.map((r) => r.spending[y] ?? 0);
    const sx = Array.from({ length: years }, (_, i) => i + 1);
    charts.push({
      id: "bt-spending",
      kind: "line",
      title: "Yearly spending the rule paid in every start year, in today’s money",
      summary: `Year-1 spending was ${m(b.firstYear)}. The lowest yearly spending in any start year was ${m(b.lowestSpending)}, and in year ${years} half the start years paid more than ${m(percentile(sp(years - 1), 0.5))}.`,
      xLabel: "Year of retirement",
      yLabel: "Today’s money",
      x: sx,
      paths: [
        {
          label: `Spending in each start year (${n})`,
          lines: b.runs.map((r) => r.spending),
          tone: 3,
          style: "solid",
        },
      ],
      series: [],
      hLines: [{ y: b.firstYear, label: "Year 1" }],
      currency: cur,
      table: {
        caption: "Yearly spending across the start years (today’s money)",
        columns: ["Year", "Lowest", "Median", "Highest"],
        rows: sx.map((y) => [
          String(y),
          m(Math.min(...sp(y - 1))),
          m(percentile(sp(y - 1), 0.5)),
          m(Math.max(...sp(y - 1))),
        ]),
      },
    });
  }

  const worstTable: Table = {
    caption: `The ${Math.min(WORST_SHOWN, n)} worst start years for this plan (today’s money)`,
    columns: ["First year", "Outcome", "Lowest yearly spending", "Portfolio at the end"],
    rows: b.worst.map((r) => [
      String(r.startYear),
      r.firstShortYear === null ? `Paid all ${years} years` : `Short from year ${r.firstShortYear}`,
      m(r.minSpending),
      m(r.end),
    ]),
  };

  const share = n ? b.lasted / n : 0;
  const headline = !n
    ? "US history from 1928 has no start year with that many years after it."
    : balance <= 0
      ? "With no portfolio, there is nothing to withdraw."
      : rule === "constant"
        ? `Spending ${m(spend)} a year from ${m(balance)} for ${wholeYears(years)} was paid in full in ${b.lasted} of ${n} historical start years (${pct(share, 1)}).${failed.length ? ` The worst was a retirement starting in ${worst!.startYear}, which ran short in year ${worst!.firstShortYear}.` : ` The worst start year, ${worst!.startYear}, ended with ${m(worst!.end)}.`}`
        : `${RULE_NAMES[rule]} from ${m(balance)} for ${wholeYears(years)} paid its own amount in full in ${b.lasted} of ${n} historical start years; its lowest yearly spending in any of them was ${m(b.lowestSpending)}, against ${m(b.firstYear)} in year 1.`;

  return {
    tool: "historical-backtest",
    headline,
    announce: n ? `${b.lasted} of ${n} start years lasted.` : "No start years to test.",
    figures: [
      {
        label: "Start years that lasted",
        value: `${whole(b.lasted)} of ${whole(n)}`,
        detail: n ? `${pct(share, 1)}, from ${first} to ${last}` : "",
      },
      {
        label: "Worst start year",
        value: worst ? String(worst.startYear) : "–",
        detail: worst
          ? worst.firstShortYear === null
            ? rule === "constant"
              ? `Ended with ${m(worst.end)}`
              : `Lowest year ${m(worst.minSpending)}`
            : `Short from year ${worst.firstShortYear}`
          : "",
      },
      {
        label: `Median portfolio after ${years} years`,
        value: m(b.medianEnd),
        detail: `Lowest ${m(b.lowestEnd)}`,
      },
      {
        label: "Lowest yearly spending",
        value: m(b.lowestSpending),
        detail: `Year 1: ${m(b.firstYear)}`,
      },
    ],
    charts,
    extraTables: n ? [worstTable] : [],
    method: [
      `US history: every start year from ${ds.label} whose ${years} years fit in the data, replayed once each in real order (the engine’s historical-sequential method; no random numbers, so the result never changes for the same inputs). Portfolio ${pctInput(stocks * 100)} stocks and ${pctInput(100 - stocks * 100)} bonds, rebalanced yearly; returns and inflation come from the data and results are converted back to today’s money.`,
      ruleText(rule, initialRate),
      "“Lasted” means every year’s amount was paid in full (the engine’s “all funded” definition). A start year that is short by a little in its last year counts as short.",
      ...(inc > 0 && incFrom < years
        ? [
            `Other income of ${m(inc)} a year (after tax, rising with inflation) from year ${incFrom + 1}; it reduces what is taken from the portfolio.`,
          ]
        : []),
      timingText(timing),
      taxText(rate(v, "tax")),
    ],
    warnings: [],
  };
}
