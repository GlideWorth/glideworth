/**
 * FIRE number and the years of saving it takes, plus a test of the number against US market history.
 *
 * Engine use:
 *  - Saving phase: `simulate` with the visitor's yearly saving (after-tax income saved into the
 *    account) and a 'financial-independence' milestone whose criterion is portfolio >= FIRE number.
 *    The engine resolves the milestone at the first year end where it holds.
 *  - History test: `runMonteCarlo` with method 'historical-sequential' on the `us-1928` dataset: one
 *    trial per start year, starting with exactly the FIRE number and spending the visitor's spending
 *    (inflation-linked) for the chosen retirement length, with the chosen stock share (rest in bonds).
 */
import { MARKET_DATASETS, runMonteCarlo } from "@glideworth/core";
import { fireNumber, yearsToTarget } from "../closed-form";
import { money, pct, pctInput, wholeYears } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, Timing, Values, ViewModel } from "../types";
import { axis, balances, run } from "./common";
import {
  buildInput,
  HISTORY_DATASET,
  monteCarloSettings,
  START_YEAR,
  taxText,
  timingText,
} from "./model";

export interface HistoryTest {
  successRate: number;
  trials: number;
  firstYear: number;
  lastStartYear: number;
  failures: { startYear: number; yearsFunded: number }[];
}

/** Starts with `balance`, spends `spend` a year for `years`, once per historical start year. */
export function historyTest(o: {
  balance: number;
  spend: number;
  years: number;
  stockShare: number;
  taxRate: number;
  timing: Timing;
  age: number;
  cur: string;
}): HistoryTest {
  const input = buildInput({
    currency: o.cur,
    age: o.age,
    years: o.years,
    balance: o.balance,
    timing: o.timing,
    taxRate: o.taxRate,
    realReturn: 0,
    stockShare: o.stockShare,
    spending: [{ id: "spending", name: "Spending", amount: o.spend, from: 0, to: null }],
  });
  const r = runMonteCarlo(input, monteCarloSettings({ kind: "history-sequential" }, 1, 1));
  const starts = r.trialSummaries.map((t) => t.startYear ?? 0);
  return {
    successRate: r.successRate,
    trials: r.trials,
    firstYear: Math.min(...starts),
    lastStartYear: Math.max(...starts),
    failures: r.trialSummaries
      .filter((t) => !t.success)
      .map((t) => ({
        startYear: t.startYear ?? 0,
        yearsFunded: t.firstShortfallYear === null ? o.years : t.firstShortfallYear - START_YEAR,
      }))
      .sort((a, b) => a.yearsFunded - b.yearsFunded),
  };
}

export function fireYears(v: Values): {
  target: number;
  years: number | null;
  path: number[];
  horizon: number;
} {
  const age = num(v, "age");
  const target = fireNumber(num(v, "spend"), rate(v, "wr"), rate(v, "tax"));
  const balance = num(v, "balance");
  const horizon = Math.min(80, Math.max(1, 100 - age));
  const res = run(
    buildInput({
      currency: str(v, "cur"),
      age,
      years: horizon,
      balance,
      timing: str(v, "timing") as Timing,
      taxRate: 0,
      realReturn: rate(v, "ret"),
      income: [{ id: "saving", name: "Yearly saving", amount: num(v, "save"), from: 0, to: null }],
      milestones: [
        {
          id: "fi",
          name: "Financial independence",
          kind: "financial-independence",
          criteria: [
            {
              kind: "metric",
              metric: { kind: "portfolio" },
              comparator: ">=",
              threshold: { kind: "amount", amount: { value: target, basis: "real" } },
            },
          ],
        },
      ],
    }),
  );
  const m = res.milestones.find((x) => x.milestoneId === "fi");
  const years =
    balance >= target
      ? 0
      : m && m.status === "reached" && m.periodIndex !== null && m.periodIndex !== undefined
        ? m.periodIndex + 1
        : null;
  return { target, years, path: [balance, ...balances(res)], horizon };
}

export async function runFire(v: Values): Promise<ViewModel> {
  const age = num(v, "age");
  const spend = num(v, "spend");
  const wr = rate(v, "wr");
  const tax = rate(v, "tax");
  const balance = num(v, "balance");
  const save = num(v, "save");
  const r = rate(v, "ret");
  const hy = num(v, "hy");
  const stocks = rate(v, "stocks");
  const timing = str(v, "timing") as Timing;
  const cur = str(v, "cur");
  const m = (x: number) => money(x, cur);

  const f = fireYears(v);
  const target = f.target;
  const fiAge = f.years === null ? null : age + f.years;
  const formulaYears = yearsToTarget(balance, save, r, target, timing);

  const shown = Math.min(f.horizon, f.years === null ? f.horizon : Math.max(5, f.years + 5));
  const ages = axis(age, shown);
  const chart: ChartSpec = {
    id: "fire-chart",
    kind: "line",
    title: "Portfolio by age against your FIRE number",
    summary:
      f.years === null
        ? `Saving ${m(save)} a year, the portfolio does not reach ${m(target)} by age ${age + f.horizon}.`
        : f.years === 0
          ? `You already have your FIRE number of ${m(target)}.`
          : `Saving ${m(save)} a year from ${m(balance)}, the portfolio reaches ${m(target)} at age ${fiAge}, after ${wholeYears(f.years)}.`,
    xLabel: "Age",
    yLabel: "Today’s money",
    x: ages,
    series: [
      {
        label: `Portfolio, saving ${m(save)} a year`,
        values: f.path.slice(0, shown + 1),
        tone: 1,
        style: "solid",
      },
    ],
    hLines: target > 0 ? [{ y: target, label: `FIRE number ${m(target)}` }] : [],
    markers: fiAge !== null && fiAge > age ? [{ x: fiAge, label: `FI at ${fiAge}` }] : [],
    currency: cur,
    table: {
      caption: "Portfolio at the end of each year of age",
      columns: ["Age", "Portfolio", "Share of FIRE number"],
      rows: ages.map((a, t) => [
        String(a),
        m(f.path[t]!),
        target > 0 ? pct(f.path[t]! / target, 0) : "–",
      ]),
    },
  };

  const ds = MARKET_DATASETS[HISTORY_DATASET];
  const h =
    target > 0 && spend > 0
      ? historyTest({
          balance: target,
          spend,
          years: hy,
          stockShare: stocks,
          taxRate: tax,
          timing,
          age: fiAge ?? age,
          cur,
        })
      : null;
  const worst = h?.failures[0];

  const headline =
    target <= 0
      ? "With no spending, your FIRE number is 0."
      : f.years === 0
        ? `Your FIRE number is ${m(target)} and you already have ${m(balance)}.`
        : f.years === null
          ? `Your FIRE number is ${m(target)}. Saving ${m(save)} a year at ${pctInput(r * 100)} after inflation, you would not reach it by age ${age + f.horizon}.`
          : `Your FIRE number is ${m(target)}. Saving ${m(save)} a year at ${pctInput(r * 100)} after inflation, you reach it in ${wholeYears(f.years)}, at age ${fiAge}.`;

  const figures = [
    {
      label: "FIRE number",
      value: m(target),
      detail: `${m(spend)}${tax > 0 ? ` ÷ (1 − ${pctInput(tax * 100)} tax)` : ""} ÷ ${pctInput(wr * 100)}`,
    },
    {
      label: "Years to reach it",
      value:
        f.years === null
          ? `More than ${f.horizon}`
          : f.years === 0
            ? "Already there"
            : String(f.years),
      detail: fiAge !== null ? `At age ${fiAge}` : "",
    },
    ...(h
      ? [
          {
            label: `${hy}-year retirements in US history`,
            value: `${Math.round(h.successRate * h.trials)} of ${h.trials} lasted`,
            detail: worst
              ? `Shortest: starting in ${worst.startYear}, ${wholeYears(worst.yearsFunded)} fully paid`
              : `Every start year from ${h.firstYear} to ${h.lastStartYear} paid every year`,
          },
        ]
      : []),
  ];

  return {
    tool: "fire",
    headline,
    announce:
      f.years === null
        ? `FIRE number ${m(target)}; not reached within ${f.horizon} years.`
        : `FIRE number ${m(target)}; reached ${f.years === 0 ? "already" : `in ${wholeYears(f.years)}, at ${fiAge}`}.`,
    figures,
    charts: [chart],
    ...(h && h.failures.length
      ? {
          table: {
            caption: `Start years in which ${m(spend)} a year from ${m(target)} ran short within ${hy} years`,
            columns: ["First year of retirement", "Years fully paid"],
            rows: h.failures.map((x) => [String(x.startYear), String(x.yearsFunded)]),
          },
        }
      : {}),
    comparison: {
      title: "Formula and engine side by side",
      rows: [
        { label: "FIRE number", formula: m(target), engine: m(target) },
        {
          label: "Years to reach it",
          formula: Number.isFinite(formulaYears) ? formulaYears.toFixed(2) : "never",
          engine: f.years === null ? `more than ${f.horizon}` : String(f.years),
        },
      ],
      note: "The FIRE number is a definition (spending ÷ withdrawal rate), so both columns agree. For the years, the formula gives the exact fractional crossing; the engine checks the portfolio at each year end and reports the first whole year at or above the number, so it is the formula rounded up.",
    },
    method: [
      `Saving phase: the engine’s simulate() with one account growing ${pctInput(r * 100)} a year after inflation, ${m(save)} saved every year, and a financial-independence milestone at a portfolio of ${m(target)}.`,
      ...(h
        ? [
            `History test: runMonteCarlo() with historical-sequential replay of the ${ds.label} dataset, one trial per start year (${h.firstYear} to ${h.lastStartYear}), ${pctInput(stocks * 100)} stocks and ${pctInput(100 - stocks * 100)} bonds rebalanced yearly, ${m(spend)} a year rising with inflation. A trial passes if every year’s spending is paid.`,
          ]
        : []),
      timingText(timing),
      taxText(tax),
    ],
    warnings:
      r <= 0 && save <= 0 && f.years === null
        ? ["With no saving and no growth the portfolio cannot grow."]
        : [],
  };
}
