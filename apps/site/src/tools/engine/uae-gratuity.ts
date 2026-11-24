/**
 * UAE end-of-service gratuity: the engine's `aeGratuity` (Article 51 of Federal Decree-Law No. 33 of
 * 2021 as published on the UAE government portal; figures and sources in packages/core/src/tax/
 * data/ae.ts), shown tier by tier with the cap, and the same years of service under the employer
 * contribution rates of the voluntary savings scheme and DEWS (`AE_SAVINGS_SCHEME`, `AE_DEWS`).
 *
 * Engine use:
 *  - Gratuity: `aeGratuity(years, monthly basic wage)` for the answer and for every point of the chart.
 *  - Savings scheme: `simulate` of one account receiving the employer contributions (the lower rate
 *    for the first five years of service, the higher rate after), growing at the return entered;
 *    part-years are pro rata. At a 0% return it is the contributions alone.
 */
import { AE_DEWS, AE_GRATUITY, AE_SAVINGS_SCHEME, aeGratuity } from "@glideworth/core";
import { money, pct, pctInput } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, Table, Timing, Values, ViewModel } from "../types";
import { run } from "./common";
import { buildInput } from "./model";

const g = AE_GRATUITY;
const s = AE_SAVINGS_SCHEME;

/** True when DEWS and the federal savings scheme have the same employer rates in the engine. */
export const SAME_SCHEME_RATES =
  AE_DEWS.employerRateUnder5Years === s.employerRateUnder5Years &&
  AE_DEWS.employerRateFrom5Years === s.employerRateFrom5Years;

/** Years of service at which the gratuity reaches the cap (two years of basic wage). */
export const CAP_YEARS =
  g.firstTierYears +
  (g.capYearsOfWage * 12 * g.daysPerMonth - g.firstTierYears * g.daysFirstFiveYears) /
    g.daysAfterFiveYears;

export interface GratuityBreakdown {
  years: number;
  wage: number;
  daily: number;
  eligible: boolean;
  firstYears: number;
  laterYears: number;
  firstDays: number;
  laterDays: number;
  beforeCap: number;
  cap: number;
  capped: boolean;
  /** The engine's answer, aeGratuity(years, wage). */
  gratuity: number;
}

/** The tiers written out, for the table and the formula column (the answer is aeGratuity). */
export function gratuityBreakdown(years: number, wage: number): GratuityBreakdown {
  const eligible = years >= g.minYears && wage > 0;
  const daily = wage / g.daysPerMonth;
  const firstYears = eligible ? Math.min(years, g.firstTierYears) : 0;
  const laterYears = eligible ? Math.max(0, years - g.firstTierYears) : 0;
  const firstDays = firstYears * g.daysFirstFiveYears;
  const laterDays = laterYears * g.daysAfterFiveYears;
  const beforeCap = (firstDays + laterDays) * daily;
  const cap = g.capYearsOfWage * 12 * wage;
  return {
    years,
    wage,
    daily,
    eligible,
    firstYears,
    laterYears,
    firstDays,
    laterDays,
    beforeCap,
    cap,
    capped: eligible && beforeCap > cap,
    gratuity: aeGratuity(years, wage),
  };
}

/** The savings scheme's employer contributions over `years` of service, grown at `r` (engine). */
export function schemeValue(
  years: number,
  wage: number,
  r: number,
  timing: Timing,
): { value: number; contributions: number } {
  const under = 12 * wage * s.employerRateUnder5Years;
  const after = 12 * wage * s.employerRateFrom5Years;
  const contributions =
    under * Math.min(years, g.firstTierYears) + after * Math.max(0, years - g.firstTierYears);
  if (years <= 0 || wage <= 0) return { value: 0, contributions: 0 };
  const horizon = Math.ceil(years - 1e-9);
  const res = run(
    buildInput({
      currency: "AED",
      age: 30,
      years: horizon,
      balance: 0,
      timing,
      taxRate: 0,
      realReturn: r,
      income: [
        {
          id: "under",
          name: "Employer, first years",
          amount: under,
          from: 0,
          to: Math.min(years, g.firstTierYears),
        },
        ...(years > g.firstTierYears
          ? [
              {
                id: "after",
                name: "Employer, later years",
                amount: after,
                from: g.firstTierYears,
                to: years,
              },
            ]
          : []),
      ],
    }),
  );
  return { value: res.periods.at(-1)?.totals.portfolio ?? 0, contributions };
}

/** Whole years plus months: 7.5 -> "7 years 6 months". */
export function serviceText(years: number): string {
  const whole = Math.floor(years + 1e-9);
  const months = Math.round((years - whole) * 12);
  const y = `${whole} ${whole === 1 ? "year" : "years"}`;
  if (months === 0) return y;
  if (months === 12) return `${whole + 1} years`;
  return `${y} ${months} ${months === 1 ? "month" : "months"}`;
}

const days = (d: number) => `${Number(d.toFixed(2)).toLocaleString("en-US")} days`;

export async function runUaeGratuity(v: Values): Promise<ViewModel> {
  const years = num(v, "years");
  const wage = num(v, "wage");
  const r = rate(v, "ret");
  const timing = str(v, "timing") as Timing;
  const cur = str(v, "cur");
  const m = (x: number) => money(x, cur);
  const b = gratuityBreakdown(years, wage);
  const scheme = schemeValue(years, wage, r, timing);

  const top = Math.max(30, Math.ceil(Math.max(years, CAP_YEARS)) + 2);
  const x = Array.from({ length: top + 1 }, (_, i) => i);
  const schemeLine = x.map((y) => schemeValue(y, wage, r, timing).value);
  const schemeName = SAME_SCHEME_RATES ? "Savings scheme or DEWS" : "Savings scheme";
  const chart: ChartSpec = {
    id: "uae-gratuity-chart",
    kind: "line",
    title: "Gratuity by years of service, against the savings scheme",
    summary: `On a monthly basic wage of ${m(wage)}, the gratuity is 0 before ${g.minYears} year of service, rises by ${g.daysFirstFiveYears} days of wage a year to year ${g.firstTierYears} and ${g.daysAfterFiveYears} days a year after, and stops at the cap of ${m(b.cap)} after about ${CAP_YEARS.toFixed(1)} years. The savings scheme’s employer contributions${r !== 0 ? `, growing at ${pctInput(r * 100)} a year,` : ""} have no cap.`,
    xLabel: "Years of service",
    yLabel: cur,
    x,
    series: [
      {
        label: "Gratuity",
        values: x.map((y) => aeGratuity(y, wage)),
        tone: 1,
        style: "solid",
      },
      { label: schemeName, values: schemeLine, tone: 2, style: "dashed" },
    ],
    markers: years > 0 ? [{ x: years, label: `${serviceText(years)}` }] : [],
    hLines: wage > 0 ? [{ y: b.cap, label: `Cap ${m(b.cap)}` }] : [],
    currency: cur,
    table: {
      caption: "Gratuity and savings scheme by whole years of service",
      columns: ["Years of service", "Gratuity", schemeName],
      rows: x.map((y, i) => [String(y), m(aeGratuity(y, wage)), m(schemeLine[i] ?? 0)]),
    },
  };

  const table: Table = {
    caption: `How the gratuity for ${serviceText(years)} on ${m(wage)} a month is worked out`,
    columns: ["Step", "Days of wage", "Amount"],
    rows: b.eligible
      ? [
          ["Daily wage (monthly basic ÷ " + g.daysPerMonth + ")", "", m(b.daily)],
          [
            `First ${g.firstTierYears} years: ${Number(b.firstYears.toFixed(4))} × ${g.daysFirstFiveYears} days`,
            days(b.firstDays),
            m(b.firstDays * b.daily),
          ],
          [
            `After ${g.firstTierYears} years: ${Number(b.laterYears.toFixed(4))} × ${g.daysAfterFiveYears} days`,
            days(b.laterDays),
            m(b.laterDays * b.daily),
          ],
          ["Total before the cap", days(b.firstDays + b.laterDays), m(b.beforeCap)],
          [
            `Cap: ${g.capYearsOfWage} years of basic wage`,
            days(g.capYearsOfWage * 12 * g.daysPerMonth),
            m(b.cap),
          ],
          ["Gratuity", "", m(b.gratuity)],
        ]
      : [
          [`Service under ${g.minYears} year`, "", m(0)],
          ["Gratuity", "", m(0)],
        ],
  };

  const diff = scheme.value - b.gratuity;
  const headline = !b.eligible
    ? wage <= 0
      ? "With no basic wage there is no gratuity."
      : `Under ${g.minYears} year of continuous service there is no gratuity. The savings scheme would hold ${m(scheme.value)} of employer contributions by now.`
    : `After ${serviceText(years)} on a monthly basic wage of ${m(wage)}, the end-of-service gratuity is ${m(b.gratuity)}${b.capped ? `, held at the cap of ${g.capYearsOfWage} years of basic wage` : ""}. The savings scheme would hold ${m(scheme.value)}${r !== 0 ? ` with a ${pctInput(r * 100)} return` : ""}.`;

  return {
    tool: "uae-gratuity",
    headline,
    announce: `Gratuity ${m(b.gratuity)}.`,
    figures: [
      {
        label: "End-of-service gratuity",
        value: m(b.gratuity),
        detail: b.eligible
          ? `${days(b.firstDays + b.laterDays)} of basic wage${b.capped ? ", capped" : ""}`
          : `Nothing under ${g.minYears} year of service`,
      },
      {
        label: "In months of basic wage",
        value: wage > 0 ? (b.gratuity / wage).toFixed(1) : "–",
        detail: `The cap is ${g.capYearsOfWage * 12} months`,
      },
      {
        label: "Daily wage used",
        value: m(b.daily),
        detail: `Monthly basic ÷ ${g.daysPerMonth}`,
      },
      {
        label: schemeName,
        value: m(scheme.value),
        detail: `${pct(s.employerRateUnder5Years, 2)} of basic wage for ${g.firstTierYears} years, ${pct(s.employerRateFrom5Years, 2)} after${diff !== 0 ? `; ${m(Math.abs(diff))} ${diff > 0 ? "more" : "less"} than the gratuity` : ""}`,
      },
    ],
    charts: [chart],
    table,
    comparison: {
      title: "Formula and engine side by side",
      rows: [
        {
          label: "Gratuity",
          formula: m(b.eligible ? Math.min(b.beforeCap, b.cap) : 0),
          engine: m(b.gratuity),
        },
        {
          label: "Savings scheme, contributions only",
          formula: m(scheme.contributions),
          engine: m(r === 0 ? scheme.value : schemeValue(years, wage, 0, timing).value),
        },
      ],
      note: "The formula column is the tier arithmetic in the table above; the engine column is the planner’s own aeGratuity() and a simulate() run of the scheme account at a 0% return. They agree to the dirham, as they should: both apply the same rule.",
    },
    method: [
      `Gratuity: the engine’s aeGratuity(${Number(years.toFixed(4))}, ${Number(wage.toFixed(2))}): ${g.daysFirstFiveYears} days of basic wage for each of the first ${g.firstTierYears} years, ${g.daysAfterFiveYears} days for each year after, fractions of a year pro rata once ${g.minYears} year is complete, capped at ${g.capYearsOfWage} years of basic wage.`,
      `Daily wage: monthly basic wage ÷ ${g.daysPerMonth}. This is Glideworth’s convention; the government portal gives the rule in days of wage but no daily-wage formula.`,
      `Savings scheme: simulate() of one account receiving ${pct(s.employerRateUnder5Years, 2)} of the monthly basic wage for the first ${g.firstTierYears} years and ${pct(s.employerRateFrom5Years, 2)} after, growing ${pctInput(r * 100)} a year, with the same basic wage throughout.${years % 1 > 1e-9 && r !== 0 ? " Growth runs to the end of the last part-year." : ""}`,
    ],
    warnings: [],
  };
}
