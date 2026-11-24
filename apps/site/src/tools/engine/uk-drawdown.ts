/**
 * UK pension drawdown: how long a pension pot pays the income you want after tax, with the engine's
 * UK income tax estimate, the tax-free part of the pot and the State Pension from State Pension age.
 *
 * Engine use: `simulate` on a UK household (`tax.mode: 'estimate'`) with one `uk-sipp` account, a
 * yearly after-tax income need, the State Pension from State Pension age and any other taxable
 * pension. The engine draws from the pot what the income and the tax on it need, year by year.
 *  - Tax-free cash with each withdrawal (UFPLS, `ukDrawdownMethod: 'ufpls'`): the engine makes its
 *    tax-free share of every withdrawal tax-free, up to the lump sum allowance.
 *  - Lump sum at the start (PCLS, 'pcls'): the engine crystallises its tax-free share of the pot on
 *    the first withdrawal. The lump sum is taken out (an expense of the same size in the first year),
 *    so the rest of the pot pays the income.
 * The answer is the number of years the income is paid in full plus the share of the first short
 * year that was still paid.
 */
import { simulate, sliceTax, type Band, type ProjectionResult } from "@glideworth/core";
import { money, pctInput, years as fmtYears } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, Table, Timing, Values, ViewModel } from "../types";
import { axis } from "./common";
import { ACCOUNT_ID, START_YEAR, timingText } from "./model";
import {
  accountOf,
  expenseOf,
  fmtAge,
  incomeOf,
  real,
  realStock,
  statePensionAge,
  statePensionEvent,
  steadyPensionAccessAge,
  thresholdText,
  ukFirstTaxYear,
  ukInput,
  type UkRegion,
  ukSimplification,
  weekly,
  WEEKS_PER_YEAR,
  yearly,
} from "./uk-model";

/** The plan runs to this age (results past it are not shown). */
export const PLAN_TO_AGE = 100;
const CUR = "GBP";
const m = (x: number) => money(x, CUR);

export type TaxFreeMethod = "ufpls" | "pcls";

export interface DrawdownInputs {
  pot: number;
  income: number;
  age: number;
  /** State Pension a week, today's money. */
  sp: number;
  realReturn: number;
  method: TaxFreeMethod;
  region: UkRegion;
  /** Other taxable pension a year, today's money. */
  other: number;
  inflation: number;
  timing: Timing;
}

export function readDrawdown(v: Values): DrawdownInputs {
  return {
    pot: num(v, "pot"),
    income: num(v, "income"),
    age: num(v, "age"),
    sp: num(v, "sp"),
    realReturn: rate(v, "ret"),
    method: str(v, "tfc") as TaxFreeMethod,
    region: str(v, "region") as UkRegion,
    other: num(v, "other"),
    inflation: rate(v, "infl"),
    timing: str(v, "timing") as Timing,
  };
}

/** One year of the drawdown, in today's money. */
export interface DrawdownYear {
  age: number;
  /** Taken from the pot for income (before tax; a PCLS lump sum is not included). */
  fromPot: number;
  /** Tax-free part of `fromPot`. */
  taxFree: number;
  statePension: number;
  other: number;
  /** Income tax estimate. */
  tax: number;
  /** After-tax income: everything received less the tax. */
  net: number;
  /** Pot at the end of the year. */
  potEnd: number;
}

export interface DrawdownResult {
  inputs: DrawdownInputs;
  /** Years the income is paid in full plus the funded share of the first short year; Infinity if never short. */
  years: number;
  horizon: number;
  /** PCLS lump sum taken at the start (0 for UFPLS). */
  lump: number;
  rows: DrawdownYear[];
  /** State Pension age (engine data). */
  spa: number;
  /** Age from which the pension can be drawn without a break (engine rules). */
  accessAge: number;
}

function horizonFor(age: number): number {
  return Math.max(1, PLAN_TO_AGE - age);
}

function buildDrawdown(d: DrawdownInputs, years: number, lump: number, need: number) {
  return ukInput({
    age: d.age,
    years,
    region: d.region,
    inflation: d.inflation,
    realReturn: d.realReturn,
    timing: d.timing,
    accounts: [
      {
        id: ACCOUNT_ID,
        name: "Pension pot",
        type: "uk-sipp",
        owner: "you",
        balance: Math.max(0, d.pot),
        behaviour: { ukDrawdownMethod: d.method },
      },
    ],
    income: [
      ...(d.sp > 0 ? [statePensionEvent(d.sp, d.age)] : []),
      ...(d.other > 0
        ? [
            {
              id: "other",
              type: "pension" as const,
              name: "Other pension",
              owner: "you",
              amount: { value: d.other, basis: "real" as const },
              frequency: "yearly" as const,
              range: { start: { kind: "planStart" as const }, end: { kind: "planEnd" as const } },
            },
          ]
        : []),
    ],
    expenses: [
      ...(need > 0 ? [yearly("income", "Income", need, 0, null)] : []),
      ...(lump > 0 ? [yearly("lump", "Tax-free lump sum taken", lump, 0, 1)] : []),
    ],
  });
}

/**
 * PCLS lump sum the engine takes from this pot at the start: a one-year run with a token need, so
 * the engine crystallises the pot at the first withdrawal; the lump sum is its tax-free cash.
 */
export function pclsLumpSum(d: DrawdownInputs): number {
  if (d.method !== "pcls" || d.pot <= 0) return 0;
  const r = simulate(buildDrawdown({ ...d, sp: 0, other: 0 }, 1, 0, 1));
  const p = r.periods[0];
  return p ? real(p, p.totals.taxFreePensionCash ?? 0) : 0;
}

function yearsPaid(r: ProjectionResult): number {
  for (let i = 0; i < r.periods.length; i++) {
    const p = r.periods[i]!;
    const e = expenseOf(p, "income");
    if (e.requested > 0 && e.funded < e.requested - 1e-6)
      return i + Math.max(0, Math.min(1, e.funded / e.requested));
  }
  return Number.POSITIVE_INFINITY;
}

export function runDrawdown(d: DrawdownInputs): DrawdownResult {
  const horizon = horizonFor(d.age);
  const spa = statePensionAge(d.age);
  const accessAge = steadyPensionAccessAge(d.age);
  const lump = pclsLumpSum(d);
  const r = simulate(buildDrawdown(d, horizon, lump, d.income));
  const rows: DrawdownYear[] = r.periods.map((p, i) => {
    const acc = accountOf(p, ACCOUNT_ID);
    const lumpNominal = i === 0 ? expenseOf(p, "lump").funded : 0;
    const fromPot = real(p, Math.max(0, (acc?.withdrawals ?? 0) - lumpNominal));
    const taxFree = real(p, Math.max(0, (p.totals.taxFreePensionCash ?? 0) - lumpNominal));
    const statePension = real(p, incomeOf(p, "sp"));
    const other = real(p, incomeOf(p, "other"));
    const tax = real(p, p.totals.taxes);
    return {
      age: d.age + i,
      fromPot,
      taxFree,
      statePension,
      other,
      tax,
      net: fromPot + statePension + other - tax,
      potEnd: realStock(p, acc?.closing ?? 0),
    };
  });
  return { inputs: d, years: yearsPaid(r), horizon, lump, rows, spa, accessAge };
}

/**
 * First-year income tax worked out by hand from the 2026/27 figures in the engine's UK data: the
 * personal allowance (with its taper) against the taxable income, then the rest-of-UK or Scottish
 * bands. Agrees with the engine's estimate for pension and State Pension income in that year.
 */
export function firstYearTaxByHand(taxable: number, region: UkRegion): number {
  const Y = ukFirstTaxYear().income;
  const pa = Math.max(0, Y.personalAllowance - Math.max(0, taxable - Y.paTaperThreshold) / 2);
  const bands: Band[] =
    region === "sct"
      ? Y.scotland.bands.map(([from, r], i) => ({
          from,
          rate: r,
          label: Y.scotland.labels[i] ?? "",
        }))
      : [
          { from: 0, rate: Y.rates.basic, label: "Basic" },
          { from: Y.basicRateBand, rate: Y.rates.higher, label: "Higher" },
          { from: Y.higherRateLimit, rate: Y.rates.additional, label: "Additional" },
        ];
  return sliceTax(bands, 0, Math.max(0, taxable - pa)).tax;
}

const METHOD_LABEL: Record<TaxFreeMethod, string> = {
  ufpls: "Tax-free cash with each withdrawal (UFPLS)",
  pcls: "Lump sum at the start (PCLS)",
};

function lastsText(res: DrawdownResult): string {
  return Number.isFinite(res.years)
    ? `${fmtYears(res.years)}, to about age ${Math.floor(res.inputs.age + res.years)}`
    : `beyond age ${PLAN_TO_AGE}`;
}

export async function runUkDrawdown(v: Values): Promise<ViewModel> {
  const d = readDrawdown(v);
  const accessAge = steadyPensionAccessAge(d.age);
  const tfcSimplification = ukSimplification("taxFreeCash");
  const simplifications = [
    ukSimplification("calendar"),
    ukSimplification("pta"),
    ...(d.region === "sct" ? [ukSimplification("scotland")] : []),
  ].filter(Boolean);

  if (d.age < accessAge)
    return {
      tool: "uk-drawdown",
      headline: `A pension cannot be drawn at ${d.age} under the engine’s UK rules. For someone who is ${d.age} now, it can be drawn without a break from age ${fmtAge(accessAge)}: the normal minimum pension age, which rises during that time.`,
      announce: `Drawdown can start at ${Math.ceil(accessAge)}.`,
      figures: [],
      charts: [],
      method: [
        "Pension access follows the engine’s UK data: the normal minimum pension age in force each year (UK_PENSION_ACCESS). Protected pension ages are not modelled.",
      ],
      warnings: [`Enter an age of ${Math.ceil(accessAge)} or more to see the drawdown.`],
    };

  const res = runDrawdown(d);
  const other = runDrawdown({ ...d, method: d.method === "ufpls" ? "pcls" : "ufpls" });
  const byMethod = d.method === "ufpls" ? { ufpls: res, pcls: other } : { ufpls: other, pcls: res };
  const rows = res.rows;
  const first = rows[0]!;
  const spRow = rows.find((r) => r.age >= res.spa && r.statePension > 0);
  const forever = !Number.isFinite(res.years);
  const fullYears = forever ? res.horizon : Math.floor(res.years + 1e-9);
  const runOutAge = d.age + res.years;
  const taxYear = ukFirstTaxYear();

  const shown = forever
    ? res.horizon
    : Math.min(res.horizon, Math.max(10, Math.ceil(res.years) + 5));
  const ages = axis(d.age, shown);
  const potPath = [Math.max(0, d.pot - res.lump), ...rows.map((r) => r.potEnd)];
  const flowAges = ages.slice(0, shown);
  const spaMarker =
    res.spa > d.age && res.spa <= d.age + shown
      ? [{ x: res.spa, label: `State Pension from ${fmtAge(res.spa)}` }]
      : [];
  const potChart: ChartSpec = {
    id: "uk-drawdown-pot",
    kind: "line",
    title: "Pension pot at the end of each year",
    summary: forever
      ? `The pot pays ${m(d.income)} a year after tax and still holds ${m(potPath[shown] ?? 0)} at age ${d.age + shown}.`
      : `The pot falls from ${m(potPath[0] ?? 0)} and can no longer pay the full income in year ${fullYears + 1}, at about age ${Math.floor(runOutAge)}.`,
    xLabel: "Age",
    yLabel: "Today’s money",
    x: ages,
    series: [
      { label: "Pension pot", values: potPath.slice(0, shown + 1), tone: 1, style: "solid" },
    ],
    markers: [
      ...(forever ? [] : [{ x: runOutAge, label: `Runs out at ${Math.floor(runOutAge)}` }]),
      ...spaMarker,
    ],
    currency: CUR,
    table: {
      caption: "Pension pot at the end of each year of age",
      columns: ["Age", "Pension pot"],
      rows: ages.map((a, t) => [String(a), m(potPath[t] ?? 0)]),
    },
  };
  const yearRows = rows.slice(0, shown);
  const incomeChart: ChartSpec = {
    id: "uk-drawdown-income",
    kind: "line",
    title: "Income and tax each year",
    summary: `In the first year you take ${m(first.fromPot)} from the pot (${m(first.taxFree)} of it tax-free) and pay about ${m(first.tax)} income tax.${spRow ? ` From State Pension age (${fmtAge(res.spa)}) the State Pension of ${m(spRow.statePension)} a year covers part of the income, so the pot pays ${m(spRow.fromPot)} and the tax is about ${m(spRow.tax)}.` : ""}`,
    xLabel: "Age",
    yLabel: "Today’s money a year",
    x: flowAges,
    series: [
      {
        label: "Income after tax",
        values: yearRows.map((r) => r.net),
        tone: 1,
        style: "solid",
      },
      {
        label: "From the pot, before tax",
        values: yearRows.map((r) => r.fromPot),
        tone: 2,
        style: "dashed",
      },
      { label: "Income tax", values: yearRows.map((r) => r.tax), tone: 3, style: "dotted" },
    ],
    markers: spaMarker,
    currency: CUR,
    table: {
      caption: "Each year of age, in today’s money",
      columns: [
        "Age",
        "From the pot",
        "Tax-free part",
        "State Pension",
        ...(d.other > 0 ? ["Other pension"] : []),
        "Income tax",
        "Income after tax",
        "Pot at year end",
      ],
      rows: yearRows.map((r) => [
        String(r.age),
        m(r.fromPot),
        m(r.taxFree),
        m(r.statePension),
        ...(d.other > 0 ? [m(r.other)] : []),
        m(r.tax),
        m(r.net),
        m(r.potEnd),
      ]),
    },
  };

  const both = spRow && spRow !== first ? [first, spRow] : [first];
  const line = (label: string, key: keyof Omit<DrawdownYear, "age">) => [
    label,
    ...both.map((r) => m(r[key])),
  ];
  const summary: Table = {
    caption: "The first year, and the first year with the State Pension (today’s money)",
    columns: ["", ...both.map((r) => (r === first ? `First year (age ${r.age})` : `Age ${r.age}`))],
    rows: [
      line("Taken from the pot, before tax", "fromPot"),
      line("of which tax-free", "taxFree"),
      line("State Pension", "statePension"),
      ...(d.other > 0 ? [line("Other pension", "other")] : []),
      line("Income tax (estimate)", "tax"),
      line("Income after tax", "net"),
    ],
  };

  const compare: Table = {
    caption: "The two ways of taking the tax-free cash",
    columns: ["", METHOD_LABEL.ufpls, METHOD_LABEL.pcls],
    rows: [
      [
        "Tax-free cash",
        `${m(byMethod.ufpls.rows.slice(0, Number.isFinite(byMethod.ufpls.years) ? Math.ceil(byMethod.ufpls.years) : undefined).reduce((s, r) => s + r.taxFree, 0))} with withdrawals while the pot lasts`,
        `${m(byMethod.pcls.lump)} at the start, taken out`,
      ],
      ["Your income lasts", lastsText(byMethod.ufpls), lastsText(byMethod.pcls)],
      [
        "Income tax in the first year",
        m(byMethod.ufpls.rows[0]?.tax ?? 0),
        m(byMethod.pcls.rows[0]?.tax ?? 0),
      ],
    ],
  };

  const taxable = first.fromPot - first.taxFree + first.statePension + first.other;
  const byHand = firstYearTaxByHand(taxable, d.region);
  const effective = first.fromPot + first.statePension + first.other;

  const potText =
    d.method === "pcls"
      ? `your ${m(d.pot)} pot (after a tax-free lump sum of ${m(res.lump)})`
      : `your ${m(d.pot)} pot`;
  const firstYear = `In the first year you take ${m(first.fromPot)} from it and pay about ${m(first.tax)} income tax.`;
  const headline =
    d.income <= 0
      ? "With no income wanted, nothing is taken from the pot."
      : d.pot <= 0
        ? "With no pension pot, there is nothing to draw."
        : forever
          ? `Taking ${m(d.income)} a year after tax, ${potText} still holds ${m(potPath[shown] ?? 0)} at age ${d.age + shown}. ${firstYear}`
          : `Taking ${m(d.income)} a year after tax, ${potText} pays it for ${fmtYears(res.years)}, until about age ${Math.floor(runOutAge)}. ${firstYear}`;

  const warnings: string[] = [];
  if (d.pot > 0 && d.income > 0 && first.fromPot <= 0)
    warnings.push(
      "Your other income already pays the income you want in the first year, so nothing is taken from the pot then.",
    );

  return {
    tool: "uk-drawdown",
    headline,
    announce: forever
      ? `The pot lasts beyond age ${PLAN_TO_AGE}.`
      : `The pot pays your income for ${fmtYears(res.years)}.`,
    figures: [
      {
        label: "Your income lasts",
        value: forever ? `Beyond ${PLAN_TO_AGE}` : fmtYears(res.years),
        detail: forever
          ? `Pot left at ${d.age + shown}: ${m(potPath[shown] ?? 0)}`
          : `Until about age ${Math.floor(runOutAge)}`,
      },
      {
        label: "Income tax, first year",
        value: m(first.tax),
        detail:
          effective > 0
            ? `${pctInput((first.tax / effective) * 100)} of income before tax (${taxYear.label})`
            : taxYear.label,
      },
      {
        label: d.method === "pcls" ? "Tax-free lump sum" : "Tax-free cash, first year",
        value: m(d.method === "pcls" ? res.lump : first.taxFree),
        detail:
          d.method === "pcls" ? "Taken out at the start" : `Part of the ${m(first.fromPot)} taken`,
      },
      {
        label: "State Pension from",
        value: fmtAge(res.spa),
        detail: d.sp > 0 ? `${m(d.sp * WEEKS_PER_YEAR)} a year` : "None entered",
      },
    ],
    table: summary,
    charts: [potChart, incomeChart],
    extraTables: [compare],
    comparison: {
      title: "First-year tax by hand and by the engine",
      rows: [
        {
          label: `Income tax in ${taxYear.label}`,
          formula: m(byHand),
          engine: m(first.tax),
        },
      ],
      note: `By hand: taxable income ${m(taxable)} (the pot’s withdrawal less its tax-free part, plus the State Pension and other pension), less the ${taxYear.label} personal allowance (reduced above its taper threshold), taxed at the ${d.region === "sct" ? "Scottish" : "rest-of-UK"} bands from the engine’s UK data. The engine applies the same rules inside the full UK estimate, so the two agree; later years differ from a by-hand sum as thresholds stay frozen while prices rise.`,
    },
    method: [
      `The engine’s simulate() on a UK household with its income tax estimate (${d.region === "sct" ? "Scottish" : "rest-of-UK"} rates), one pension pot of ${m(d.pot)} growing ${pctInput(d.realReturn * 100)} a year after inflation, and an income need of ${m(d.income)} a year after tax. Each year the engine takes from the pot what the income and the tax on it need.`,
      d.method === "pcls"
        ? `Tax-free cash as a lump sum at the start (PCLS): the engine crystallises the pot in the first year and pays its tax-free share of the pot as it stands after that year’s growth (${m(res.lump)}); it is taken out and not counted as income. Every later withdrawal is taxable.`
        : "Tax-free cash with each withdrawal (UFPLS): the engine makes its tax-free share of every withdrawal tax-free; the rest is taxed as income.",
      tfcSimplification,
      `State Pension of ${weekly(d.sp)} a week from State Pension age ${fmtAge(res.spa)} (from the engine’s UK data for someone born in ${START_YEAR - d.age}), rising with prices. It counts as taxable income first, so it uses up the personal allowance.`,
      thresholdText(d.inflation),
      timingText(d.timing),
      ...simplifications,
    ],
    warnings,
  };
}
