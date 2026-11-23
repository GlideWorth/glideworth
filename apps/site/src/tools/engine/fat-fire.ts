/**
 * Fat FIRE: the same FIRE number and saving projection as the FIRE calculator, run at a high
 * spending level and compared with two lower spending levels for the same person.
 *
 * Engine use matches `fire.ts`:
 *  - Saving phase: `simulate` with yearly saving and a financial-independence milestone at each
 *    target (fat, regular, lean). The path does not depend on the target; each call only changes
 *    the milestone threshold.
 *  - History test: `historyTest` (`runMonteCarlo`, historical-sequential, `us-1928`) starts with
 *    exactly the fat FIRE number and spends the fat spending for the chosen retirement length.
 */
import { MARKET_DATASETS } from "@glideworth/core";
import { yearsToTarget } from "../closed-form";
import { money, pct, pctInput, wholeYears } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, Timing, Values, ViewModel } from "../types";
import { axis } from "./common";
import { fireYears, historyTest, type HistoryTest } from "./fire";
import { HISTORY_DATASET, taxText, timingText } from "./model";

export interface FatLevels {
  fat: ReturnType<typeof fireYears>;
  regular: ReturnType<typeof fireYears>;
  lean: ReturnType<typeof fireYears>;
}

/** One saving plan, three portfolio targets (fat spending, and the two comparison levels). */
export function fatFireNumbers(v: Values): FatLevels {
  return {
    fat: fireYears(v),
    regular: fireYears({ ...v, spend: num(v, "reg") }),
    lean: fireYears({ ...v, spend: num(v, "lean") }),
  };
}

/** History test of the fat number. `levels` avoids a second set of saving runs when the caller has them. */
export function fatHistory(v: Values, levels: FatLevels = fatFireNumbers(v)): HistoryTest | null {
  const spend = num(v, "spend");
  const target = levels.fat.target;
  if (!(target > 0 && spend > 0)) return null;
  const age = num(v, "age");
  return historyTest({
    balance: target,
    spend,
    years: num(v, "hy"),
    stockShare: rate(v, "stocks"),
    taxRate: rate(v, "tax"),
    timing: str(v, "timing") as Timing,
    age: levels.fat.years === null ? age : age + levels.fat.years,
    cur: str(v, "cur"),
  });
}

function yearValue(years: number | null, horizon: number): string {
  if (years === null) return `More than ${horizon}`;
  if (years === 0) return "Already there";
  return String(years);
}

export async function runFatFire(v: Values): Promise<ViewModel> {
  const age = num(v, "age");
  const spend = num(v, "spend");
  const regSpend = num(v, "reg");
  const leanSpend = num(v, "lean");
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

  const levels = fatFireNumbers(v);
  const target = levels.fat.target;
  const years = levels.fat.years;
  const horizon = levels.fat.horizon;
  const fiAge = years === null ? null : age + years;
  const formulaYears = yearsToTarget(balance, save, r, target, timing);
  const h = fatHistory(v, levels);
  const worst = h?.failures[0];
  const ds = MARKET_DATASETS[HISTORY_DATASET];

  const reached = [levels.lean.years, levels.regular.years, years].filter(
    (y): y is number => y !== null,
  );
  const last = reached.length > 0 ? Math.max(...reached) : horizon;
  const shown = Math.min(horizon, Math.max(5, (years === null ? horizon : last) + 5));
  const ages = axis(age, shown);
  const rateLabel = pctInput(wr * 100);

  const lines = [
    { label: "Lean", y: levels.lean.target },
    { label: "Regular", y: levels.regular.target },
    { label: "Fat", y: target },
  ].filter((line) => line.y > 0);

  const chart: ChartSpec = {
    id: "fat-fire-chart",
    kind: "line",
    title: "Portfolio by age against lean, regular and fat targets",
    summary:
      years === null
        ? `Saving ${m(save)} a year, the portfolio does not reach the fat FIRE number of ${m(target)} by age ${age + horizon}.`
        : years === 0
          ? `You already have the fat FIRE number of ${m(target)}. The regular target is ${m(levels.regular.target)} and the lean target is ${m(levels.lean.target)}.`
          : `Saving ${m(save)} a year from ${m(balance)}, the portfolio reaches the fat FIRE number of ${m(target)} at age ${fiAge}. The regular target is ${m(levels.regular.target)} and the lean target is ${m(levels.lean.target)}.`,
    xLabel: "Age",
    yLabel: "Today’s money",
    x: ages,
    series: [
      {
        label: `Portfolio, saving ${m(save)} a year`,
        values: levels.fat.path.slice(0, shown + 1),
        tone: 1,
        style: "solid",
      },
    ],
    hLines: lines.map((line) => ({ y: line.y, label: `${line.label} ${m(line.y)}` })),
    markers: fiAge !== null && fiAge > age ? [{ x: fiAge, label: `Fat FI at ${fiAge}` }] : [],
    currency: cur,
    table: {
      caption: "Portfolio at the end of each year of age",
      columns: ["Age", "Portfolio", "Share of the fat number"],
      rows: ages.map((a, t) => [
        String(a),
        m(levels.fat.path[t]!),
        target > 0 ? pct(levels.fat.path[t]! / target, 0) : "–",
      ]),
    },
  };

  const gross = tax > 0 ? ` ÷ (1 − ${pctInput(tax * 100)} tax)` : "";
  const headline =
    target <= 0
      ? "With no fat spending, your fat FIRE number is 0."
      : years === 0
        ? `Your fat FIRE number is ${m(target)} and you already have ${m(balance)}. At ${rateLabel}, regular spending of ${m(regSpend)} needs ${m(levels.regular.target)} and lean spending of ${m(leanSpend)} needs ${m(levels.lean.target)}.`
        : years === null
          ? `Your fat FIRE number is ${m(target)}. Saving ${m(save)} a year at ${pctInput(r * 100)} after inflation, you would not reach it by age ${age + horizon}. At ${rateLabel}, regular spending of ${m(regSpend)} needs ${m(levels.regular.target)} and lean spending of ${m(leanSpend)} needs ${m(levels.lean.target)}.`
          : `Your fat FIRE number is ${m(target)}. Saving ${m(save)} a year at ${pctInput(r * 100)} after inflation, you reach it in ${wholeYears(years)}, at age ${fiAge}. At ${rateLabel}, regular spending of ${m(regSpend)} needs ${m(levels.regular.target)} and lean spending of ${m(leanSpend)} needs ${m(levels.lean.target)}.`;

  const gapYears =
    years !== null && levels.regular.years !== null ? years - levels.regular.years : null;

  const figures = [
    {
      label: "Fat FIRE number",
      value: m(target),
      detail: `${m(spend)}${gross} ÷ ${rateLabel}`,
    },
    {
      label: "Years to the fat number",
      value: yearValue(years, horizon),
      detail: fiAge !== null ? `At age ${fiAge}` : "",
    },
    {
      label: "Above the regular target",
      value: m(target - levels.regular.target),
      detail:
        gapYears === null
          ? `Regular target ${m(levels.regular.target)}`
          : gapYears === 0
            ? "Same number of years as the regular target"
            : gapYears > 0
              ? `${wholeYears(gapYears)} more of saving than the regular target`
              : `${wholeYears(-gapYears)} less of saving than the regular target`,
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

  const row = (label: string, spending: number, level: ReturnType<typeof fireYears>) => [
    label,
    m(spending),
    m(level.target),
    yearValue(level.years, level.horizon) +
      (level.years !== null && level.years > 0 ? ` (age ${age + level.years})` : ""),
  ];

  return {
    tool: "fat-fire",
    headline,
    announce:
      years === null
        ? `Fat FIRE number ${m(target)}; not reached within ${horizon} years. Regular target ${m(levels.regular.target)}.`
        : `Fat FIRE number ${m(target)}; ${years === 0 ? "already reached" : `reached in ${wholeYears(years)}`}. Regular target ${m(levels.regular.target)}.`,
    figures,
    charts: [chart],
    table: {
      caption: "Fat, regular and lean targets for the same saving plan",
      columns: ["Spending level", "Yearly spending", "Portfolio needed", "Years to reach it"],
      rows: [
        row("Fat", spend, levels.fat),
        row("Regular", regSpend, levels.regular),
        row("Lean", leanSpend, levels.lean),
      ],
    },
    ...(h && h.failures.length
      ? {
          extraTables: [
            {
              caption: `Start years in which ${m(spend)} a year from the fat number ${m(target)} ran short within ${hy} years`,
              columns: ["First year of retirement", "Years fully paid"],
              rows: h.failures.map((x) => [String(x.startYear), String(x.yearsFunded)]),
            },
          ],
        }
      : {}),
    comparison: {
      title: "Formula and engine side by side",
      rows: [
        { label: "Fat FIRE number", formula: m(target), engine: m(target) },
        {
          label: "Years to the fat number",
          formula: Number.isFinite(formulaYears) ? formulaYears.toFixed(2) : "never",
          engine: years === null ? `more than ${horizon}` : String(years),
        },
      ],
      note: "Each number is spending divided by the withdrawal rate (grossed up when a flat tax is set), so the formula and the engine agree. For the years, the formula gives the exact fractional crossing of the fat number; the engine checks the portfolio at each year end and reports the first whole year at or above it. Regular and lean use that same year-end check at their own targets.",
    },
    method: [
      `Saving phase: the engine’s simulate() with one account growing ${pctInput(r * 100)} a year after inflation, ${m(save)} saved every year, and a financial-independence milestone at each target.`,
      `Targets at ${rateLabel}: fat ${m(target)} from ${m(spend)} of spending, regular ${m(levels.regular.target)} from ${m(regSpend)}, lean ${m(levels.lean.target)} from ${m(leanSpend)}.`,
      ...(h
        ? [
            `History test of the fat number only: runMonteCarlo() with historical-sequential replay of the ${ds.label} dataset, one trial per start year (${h.firstYear} to ${h.lastStartYear}), ${pctInput(stocks * 100)} stocks and ${pctInput(100 - stocks * 100)} bonds rebalanced yearly, ${m(spend)} a year rising with inflation. A trial passes if every year’s spending is paid.`,
          ]
        : []),
      timingText(timing),
      taxText(tax),
    ],
    warnings:
      r <= 0 && save <= 0 && years === null
        ? ["With no saving and no growth the portfolio cannot grow."]
        : [],
  };
}
