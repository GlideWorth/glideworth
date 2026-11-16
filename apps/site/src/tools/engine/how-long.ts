/**
 * How long will my money last: years a balance pays a fixed real withdrawal at a steady return, then
 * the same withdrawal replayed through every start year of US market history.
 *
 * Engine use:
 *  - Steady return: `simulate` for up to 100 years; the answer is the number of fully funded years plus
 *    the share of the first short year that was still paid.
 *  - History: `runMonteCarlo` with method 'historical-sequential' on `us-1928` over a 40-year window,
 *    with the chosen stock share (the rest in 10-year Treasuries); one trial per start year.
 */
import { MARKET_DATASETS, runMonteCarlo } from "@glideworth/core";
import { depletionYears } from "../closed-form";
import { money, pctInput, years as fmtYears, wholeYears } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, Timing, Values, ViewModel } from "../types";
import { axis, balances, percentile, run, yearsFunded } from "./common";
import {
  buildInput,
  HISTORY_DATASET,
  monteCarloSettings,
  START_YEAR,
  taxText,
  timingText,
} from "./model";

export const HISTORY_WINDOW = 40;
const MAX_YEARS = 100;

export function engineYears(v: Values): { years: number; path: number[] } {
  const res = run(
    buildInput({
      currency: str(v, "cur"),
      age: num(v, "age"),
      years: MAX_YEARS,
      balance: num(v, "balance"),
      timing: str(v, "timing") as Timing,
      taxRate: rate(v, "tax"),
      realReturn: rate(v, "ret"),
      spending: [
        { id: "spending", name: "Withdrawal", amount: num(v, "spend"), from: 0, to: null },
      ],
    }),
  );
  return {
    years: num(v, "spend") > 0 ? yearsFunded(res) : Number.POSITIVE_INFINITY,
    path: [num(v, "balance"), ...balances(res)],
  };
}

export function historyYears(v: Values): { startYear: number; years: number; full: boolean }[] {
  const input = buildInput({
    currency: str(v, "cur"),
    age: num(v, "age"),
    years: HISTORY_WINDOW,
    balance: num(v, "balance"),
    timing: str(v, "timing") as Timing,
    taxRate: rate(v, "tax"),
    realReturn: 0,
    stockShare: rate(v, "stocks"),
    spending: [{ id: "spending", name: "Withdrawal", amount: num(v, "spend"), from: 0, to: null }],
  });
  const r = runMonteCarlo(input, monteCarloSettings({ kind: "history-sequential" }, 1, 1));
  return r.trialSummaries
    .map((t) => ({
      startYear: t.startYear ?? 0,
      years: t.firstShortfallYear === null ? HISTORY_WINDOW : t.firstShortfallYear - START_YEAR,
      full: t.firstShortfallYear === null,
    }))
    .sort((a, b) => a.startYear - b.startYear);
}

export async function runHowLong(v: Values): Promise<ViewModel> {
  const balance = num(v, "balance");
  const spend = num(v, "spend");
  const r = rate(v, "ret");
  const age = num(v, "age");
  const tax = rate(v, "tax");
  const stocks = rate(v, "stocks");
  const timing = str(v, "timing") as Timing;
  const cur = str(v, "cur");
  const m = (x: number) => money(x, cur);

  const e = engineYears(v);
  const formula = depletionYears(balance, spend / (1 - tax), r, timing);
  const forever = !Number.isFinite(e.years);
  const fullYears = forever ? MAX_YEARS : Math.floor(e.years + 1e-9);

  const shown = forever ? 50 : Math.min(MAX_YEARS, Math.max(10, Math.ceil(e.years) + 3));
  const ages = axis(age, shown);
  const balanceChart: ChartSpec = {
    id: "how-long-chart",
    kind: "line",
    title: "Savings at the end of each year",
    summary: forever
      ? `Growth of ${pctInput(r * 100)} covers the withdrawal, so the balance never runs out; it is ${m(e.path[shown] ?? 0)} after ${shown} years.`
      : `The balance falls from ${m(balance)} and runs out in year ${fullYears + 1}, at about age ${age + fullYears}. ${fullYears} full years of ${m(spend)} are paid.`,
    xLabel: "Age",
    yLabel: "Today’s money",
    x: ages,
    series: [
      {
        label: `Withdrawing ${m(spend)} a year`,
        values: e.path.slice(0, shown + 1),
        tone: 1,
        style: "solid",
      },
    ],
    markers: forever
      ? []
      : [{ x: age + e.years, label: `Runs out at ${Math.floor(age + e.years)}` }],
    currency: cur,
    table: {
      caption: "Savings at the end of each year of age",
      columns: ["Age", "Savings"],
      rows: ages.map((a, t) => [String(a), m(e.path[t] ?? 0)]),
    },
  };

  const hist = balance > 0 && spend > 0 ? historyYears(v) : [];
  const ds = MARKET_DATASETS[HISTORY_DATASET];
  const lasted = hist.filter((h) => h.full).length;
  const shortest = hist.length ? hist.reduce((a, b) => (b.years < a.years ? b : a)) : null;
  const median = hist.length
    ? percentile(
        hist.map((h) => h.years),
        0.5,
      )
    : Number.NaN;
  const histChart: ChartSpec | null = hist.length
    ? {
        id: "how-long-history",
        kind: "bar",
        title: `Years paid in full, by first year of retirement (US history, ${HISTORY_WINDOW}-year window)`,
        summary: `In ${lasted} of ${hist.length} start years from ${hist[0]!.startYear} to ${hist[hist.length - 1]!.startYear} the money lasted the whole ${HISTORY_WINDOW}-year window. The shortest was ${wholeYears(shortest!.years)} for a retirement starting in ${shortest!.startYear}; the median was ${wholeYears(median)}${median >= HISTORY_WINDOW ? " or more" : ""}.`,
        xLabel: "First year of retirement",
        yLabel: "Years",
        yUnit: "years",
        x: hist.map((h) => h.startYear),
        series: [
          {
            label: `Years fully paid (capped at ${HISTORY_WINDOW})`,
            values: hist.map((h) => h.years),
            tone: 2,
            style: "solid",
          },
        ],
        hLines: [{ y: HISTORY_WINDOW, label: `${HISTORY_WINDOW} years` }],
        yMax: HISTORY_WINDOW,
        currency: cur,
        table: {
          caption: "Years paid in full for each start year",
          columns: ["First year", "Years fully paid"],
          rows: hist.map((h) => [
            String(h.startYear),
            h.full ? `${HISTORY_WINDOW} or more` : String(h.years),
          ]),
        },
      }
    : null;

  const headline =
    spend <= 0
      ? "With no withdrawals, the money is never used up."
      : balance <= 0
        ? "With no savings, there is nothing to withdraw."
        : forever
          ? `At a steady ${pctInput(r * 100)} after inflation your money does not run out: growth of ${m(balance * r)} a year covers the ${m(spend)} withdrawal.`
          : `At a steady ${pctInput(r * 100)} after inflation, ${m(balance)} pays ${m(spend)} a year for ${fmtYears(e.years)}, until about age ${Math.floor(age + e.years)}.`;

  return {
    tool: "how-long",
    headline,
    announce: forever
      ? "The money does not run out at this return."
      : `The money lasts ${fmtYears(e.years)}.`,
    figures: [
      {
        label: "Years it lasts",
        value: forever ? "Never runs out" : fmtYears(e.years),
        detail: forever ? "" : `${fullYears} full years, then part of year ${fullYears + 1}`,
      },
      {
        label: "Lasts until about age",
        value: forever ? "–" : String(Math.floor(age + e.years)),
        detail: `Starting at ${age}`,
      },
      ...(hist.length
        ? [
            {
              label: `US history, ${HISTORY_WINDOW}-year window`,
              value: `${lasted} of ${hist.length} lasted`,
              detail: shortest
                ? `Shortest: ${wholeYears(shortest.years)} from ${shortest.startYear}`
                : "",
            },
          ]
        : []),
    ],
    charts: histChart ? [balanceChart, histChart] : [balanceChart],
    comparison: {
      title: "Formula and engine side by side",
      rows: [
        {
          label: "Years the money lasts",
          formula: Number.isFinite(formula) ? formula.toFixed(2) : "never",
          engine: forever ? "never" : e.years.toFixed(2),
        },
      ],
      note: "Formula: years = −ln(1 − r × B ÷ W′) ÷ ln(1 + r), where W′ is the withdrawal moved to the end of the year under the timing you chose. The engine counts whole funded years and adds the share of the last year it could still pay. With money moving at the end of the year the two agree to a hundredth of a year; with start or middle timing the engine’s last part-year can be slightly longer, because it pays the final withdrawal from that year’s grown balance.",
    },
    method: [
      `Steady return: the engine’s simulate() for up to ${MAX_YEARS} years, one account growing ${pctInput(r * 100)} a year after inflation, withdrawing ${m(spend)} a year in today’s money.`,
      ...(hist.length
        ? [
            `History: runMonteCarlo() with historical-sequential replay of ${ds.label}, one trial per start year over a ${HISTORY_WINDOW}-year window, ${pctInput(stocks * 100)} stocks and ${pctInput(100 - stocks * 100)} bonds rebalanced yearly. The steady return you entered is not used here; each year’s real returns and inflation come from the data.`,
          ]
        : []),
      timingText(timing),
      taxText(tax),
    ],
    warnings: [],
  };
}
