/**
 * ISA or pension: the same money from take-home pay saved into a pension or into an ISA until
 * retirement, then the after-tax income each pays to the same age, with the engine's UK tax estimate.
 *
 * Engine use: two `simulate` runs of a UK household (`tax.mode: 'estimate'`) with a salary until the
 * retirement age, a yearly contribution flow of the same take-home amount into a `uk-sipp` (relief
 * at source: the engine adds basic-rate relief to the pension and widens the bands for higher-rate
 * relief) or a `uk-isa`, and the State Pension from State Pension age. From retirement a level
 * after-tax income (today's money, the State Pension included) is drawn; a bisection on that income
 * finds the most each wrapper pays in full every year until the chosen age. Part of each pension
 * withdrawal is tax-free (UFPLS, the engine's share); the rest is taxed as income. ISA withdrawals are
 * tax-free.
 */
import { type ProjectionResult, simulate } from "@glideworth/core";
import { balanceAfter, TIMING_SHARE } from "../closed-form";
import { money, pct, pctInput } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, Table, Timing, Values, ViewModel } from "../types";
import { axis } from "./common";
import { ACCOUNT_ID, PERSON_ID, START_YEAR, timingText } from "./model";
import {
  accountOf,
  expenseOf,
  fmtAge,
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
  ukTaxFreeShare,
  weekly,
  WEEKS_PER_YEAR,
  yearly,
} from "./uk-model";

const CUR = "GBP";
const m = (x: number) => money(x, CUR);

export type Wrapper = "pension" | "isa";

export interface IsaPensionInputs {
  /** Taken from take-home pay each year, today's money. */
  save: number;
  salary: number;
  age: number;
  retire: number;
  planTo: number;
  /** State Pension a week, today's money. */
  sp: number;
  realReturn: number;
  region: UkRegion;
  inflation: number;
  timing: Timing;
}

export function readIsaPension(v: Values): IsaPensionInputs {
  return {
    save: num(v, "save"),
    salary: num(v, "salary"),
    age: num(v, "age"),
    retire: num(v, "retire"),
    planTo: num(v, "planTo"),
    sp: num(v, "sp"),
    realReturn: rate(v, "ret"),
    region: str(v, "region") as UkRegion,
    inflation: rate(v, "infl"),
    timing: str(v, "timing") as Timing,
  };
}

function build(d: IsaPensionInputs, w: Wrapper, income: number) {
  const working = d.retire - d.age;
  return ukInput({
    age: d.age,
    years: d.planTo - d.age,
    region: d.region,
    inflation: d.inflation,
    realReturn: d.realReturn,
    timing: d.timing,
    accounts: [
      w === "pension"
        ? {
            id: ACCOUNT_ID,
            name: "Pension",
            type: "uk-sipp",
            owner: PERSON_ID,
            balance: 0,
            behaviour: { ukDrawdownMethod: "ufpls" },
          }
        : { id: ACCOUNT_ID, name: "ISA", type: "uk-isa", owner: PERSON_ID, balance: 0 },
    ],
    income: [
      ...(d.salary > 0
        ? [
            {
              id: "salary",
              type: "salary" as const,
              name: "Salary",
              owner: PERSON_ID,
              amount: { value: d.salary, basis: "real" as const },
              frequency: "yearly" as const,
              range: {
                start: { kind: "planStart" as const },
                end: { kind: "planStart" as const, offsetMonths: working * 12 },
              },
            },
          ]
        : []),
      ...(d.sp > 0 ? [statePensionEvent(d.sp, d.age)] : []),
    ],
    expenses: income > 0 ? [yearly("income", "Retirement income", income, working, null)] : [],
    flows:
      d.save > 0
        ? [
            {
              id: "save",
              kind: "contribution",
              name: w === "pension" ? "Pension contribution" : "ISA saving",
              owner: PERSON_ID,
              accountId: ACCOUNT_ID,
              method: {
                kind: "amount",
                amount: { value: d.save, basis: "real" },
                frequency: "yearly",
              },
              mandatory: true,
              range: {
                start: { kind: "planStart" },
                end: { kind: "planStart", offsetMonths: working * 12 },
              },
              ...(w === "pension" ? { pensionScheme: "relief-at-source" as const } : {}),
            },
          ]
        : [],
  });
}

/** True when every year's retirement income is paid in full. */
function incomePaid(r: ProjectionResult): boolean {
  return r.periods.every((p) => {
    const e = expenseOf(p, "income");
    return e.funded >= e.requested - 1e-6 * Math.max(1, e.requested);
  });
}

/** One wrapper's run, in today's money. */
export interface WrapperResult {
  wrapper: Wrapper;
  /** Highest level after-tax income (State Pension included) paid in full to `planTo`. */
  income: number;
  /** Pot on the retirement date. */
  potAtRetirement: number;
  /** Relief at source the engine added to the pension over the working years. */
  reliefAdded: number;
  /** Income tax and NI over the working years. */
  taxWorking: number;
  /** Income tax over the retirement years. */
  taxRetired: number;
  /** Income tax in the first year of retirement. */
  taxFirstRetiredYear: number;
  /** True when the contributions were paid from pay every year (no shortfall while working). */
  affordable: boolean;
  /** Pot at the end of each year (index 0: today). */
  path: number[];
  run: ProjectionResult;
}

function summarise(d: IsaPensionInputs, w: Wrapper, income: number): WrapperResult {
  const r = simulate(build(d, w, income));
  const working = d.retire - d.age;
  let reliefAdded = 0;
  let taxWorking = 0;
  let taxRetired = 0;
  let affordable = true;
  const path = [0];
  r.periods.forEach((p, i) => {
    path.push(realStock(p, accountOf(p, ACCOUNT_ID)?.closing ?? 0));
    if (i < working) {
      reliefAdded += real(p, p.totals.externalContributions ?? 0);
      taxWorking += real(p, p.totals.taxes);
      if (p.totals.shortfall > 1e-6) affordable = false;
    } else taxRetired += real(p, p.totals.taxes);
  });
  return {
    wrapper: w,
    income,
    potAtRetirement: path[working] ?? 0,
    reliefAdded,
    taxWorking,
    taxRetired,
    taxFirstRetiredYear: r.periods[working]
      ? real(r.periods[working]!, r.periods[working]!.totals.taxes)
      : 0,
    affordable,
    path,
    run: r,
  };
}

/** The highest level income each wrapper pays in full, found by bisection to within a pound. */
export function maxIncome(d: IsaPensionInputs, w: Wrapper): WrapperResult {
  const paid = (x: number) => incomePaid(simulate(build(d, w, x)));
  const base = summarise(d, w, 0);
  const retiredYears = d.planTo - d.retire;
  let lo = 0;
  let hi = Math.max(1_000, base.potAtRetirement / retiredYears + d.sp * WEEKS_PER_YEAR + 1_000);
  for (let i = 0; i < 20 && paid(hi); i++) {
    lo = hi;
    hi *= 2;
  }
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2;
    if (paid(mid)) lo = mid;
    else hi = mid;
  }
  return summarise(d, w, Math.floor(lo));
}

export interface IsaPensionResult {
  inputs: IsaPensionInputs;
  pension: WrapperResult;
  isa: WrapperResult;
  accessAge: number;
  spa: number;
}

export function runComparison(d: IsaPensionInputs): IsaPensionResult {
  return {
    inputs: d,
    pension: maxIncome(d, "pension"),
    isa: maxIncome(d, "isa"),
    accessAge: steadyPensionAccessAge(d.age),
    spa: statePensionAge(d.age),
  };
}

/**
 * The pots by the textbook future-value formula, the pension contribution grossed up at the
 * relief-at-source rate. Each year's saving is the same amount in that year's starting prices, paid
 * when the timing option places it (k = 1 / 0.5 / 0 of the year's growth still to come), while the
 * pot is valued in end-of-year prices: in today's money the formula is divided by (1 + i)^(1 − k).
 */
export function potsByFormula(d: IsaPensionInputs): { pension: number; isa: number } {
  const ras = ukFirstTaxYear().pensions.reliefAtSourceRate;
  const n = d.retire - d.age;
  const lag = (1 + d.inflation) ** (1 - TIMING_SHARE[d.timing]);
  const fv = (c: number) => balanceAfter(0, c, d.realReturn, n, d.timing) / lag;
  return { isa: fv(d.save), pension: fv(d.save / (1 - ras)) };
}

export async function runIsaVsPension(v: Values): Promise<ViewModel> {
  const d = readIsaPension(v);
  const accessAge = steadyPensionAccessAge(d.age);
  const taxYear = ukFirstTaxYear();
  if (d.retire < accessAge)
    return {
      tool: "isa-vs-pension",
      headline: `A pension cannot be drawn at ${d.retire} under the engine’s UK rules. For someone who is ${d.age} now, it can be drawn from age ${fmtAge(accessAge)}, the normal minimum pension age.`,
      announce: `Choose a retirement age of ${Math.ceil(accessAge)} or more.`,
      figures: [],
      charts: [],
      method: [
        "Pension access follows the engine’s UK data: the normal minimum pension age in force each year. Protected pension ages are not modelled.",
      ],
      warnings: [`Enter a retirement age of ${Math.ceil(accessAge)} or more to compare the two.`],
    };

  const res = runComparison(d);
  const { pension, isa } = res;
  const working = d.retire - d.age;
  const diff = pension.income - isa.income;
  const higherRateRelief = isa.taxWorking - pension.taxWorking;
  const formula = potsByFormula(d);
  const spAnnual = d.sp * WEEKS_PER_YEAR;
  const better =
    Math.abs(diff) < 1
      ? "Both pay the same income"
      : diff > 0
        ? `The pension pays ${m(diff)} a year more after tax`
        : `The ISA pays ${m(-diff)} a year more after tax`;

  const ages = axis(d.age, d.planTo - d.age);
  const potChart: ChartSpec = {
    id: "isa-vs-pension-pots",
    kind: "line",
    title: "Pension and ISA at the end of each year",
    summary: `Saving ${m(d.save)} a year from take-home pay, the pension holds ${m(pension.potAtRetirement)} at ${d.retire} and the ISA ${m(isa.potAtRetirement)}. Each is then drawn to pay the income below until age ${d.planTo}.`,
    xLabel: "Age",
    yLabel: "Today’s money",
    x: ages,
    series: [
      { label: "Pension", values: pension.path, tone: 1, style: "solid" },
      { label: "ISA", values: isa.path, tone: 2, style: "dashed" },
    ],
    markers: [{ x: d.retire, label: `Retire at ${d.retire}` }],
    currency: CUR,
    table: {
      caption: "Pension and ISA at the end of each year of age",
      columns: ["Age", "Pension", "ISA"],
      rows: ages.map((a, i) => [String(a), m(pension.path[i] ?? 0), m(isa.path[i] ?? 0)]),
    },
  };

  const table: Table = {
    caption: `Saving ${m(d.save)} a year from take-home pay from ${d.age} to ${d.retire}, in today’s money`,
    columns: ["", "Pension", "ISA"],
    rows: [
      ["Paid from take-home pay", m(d.save * working), m(d.save * working)],
      ["Relief at source added to the pension", m(pension.reliefAdded), m(0)],
      [`Pot at ${d.retire}`, m(pension.potAtRetirement), m(isa.potAtRetirement)],
      [`Income after tax a year, ${d.retire} to ${d.planTo}`, m(pension.income), m(isa.income)],
      [
        `Income tax in the first year of retirement`,
        m(pension.taxFirstRetiredYear),
        m(isa.taxFirstRetiredYear),
      ],
      ["Income tax over the whole retirement", m(pension.taxRetired), m(isa.taxRetired)],
    ],
  };

  const warnings: string[] = [];
  if (!pension.affordable || !isa.affordable)
    warnings.push(
      "In some years your pay after tax does not cover the saving, so part of it was not paid. Lower the saving or raise the salary.",
    );
  if (d.save > taxYear.isa.overall)
    warnings.push(
      `${m(d.save)} is above the ${taxYear.label} ISA allowance of ${m(taxYear.isa.overall)}; this calculator still puts all of it in the ISA.`,
    );
  if (
    d.save / (1 - taxYear.pensions.reliefAtSourceRate) >
    Math.max(d.salary, taxYear.pensions.basicAmount)
  )
    warnings.push(
      "Tax relief is limited to your earnings (or the basic amount without earnings), so part of the pension saving gets no relief.",
    );

  return {
    tool: "isa-vs-pension",
    headline: `${better}: ${m(pension.income)} from the pension and ${m(isa.income)} from the ISA, each a year until ${d.planTo}${spAnnual > 0 ? ", State Pension included" : ""}. The pension holds ${m(pension.potAtRetirement)} at ${d.retire}, the ISA ${m(isa.potAtRetirement)}.`,
    announce: `${better}.`,
    figures: [
      {
        label: "Pension: income after tax",
        value: m(pension.income),
        detail: `A year from ${d.retire} to ${d.planTo}`,
      },
      {
        label: "ISA: income after tax",
        value: m(isa.income),
        detail: `A year from ${d.retire} to ${d.planTo}`,
      },
      {
        label: "Difference",
        value: m(Math.abs(diff)),
        detail:
          Math.abs(diff) < 1
            ? "No difference"
            : diff > 0
              ? "A year more from the pension"
              : "A year more from the ISA",
      },
      {
        label: "Higher-rate relief while working",
        value: m(Math.max(0, higherRateRelief)),
        detail: "Less tax on your pay in total; counted as spent, not saved",
      },
    ],
    table,
    charts: [potChart],
    comparison: {
      title: `Pots at ${d.retire}: formula and engine`,
      rows: [
        { label: "ISA", formula: m(formula.isa), engine: m(isa.potAtRetirement) },
        {
          label: `Pension (contribution ÷ (1 − ${pctInput(taxYear.pensions.reliefAtSourceRate * 100)}))`,
          formula: m(formula.pension),
          engine: m(pension.potAtRetirement),
        },
      ],
      note: `The formula is the future value of the yearly saving at ${pctInput(d.realReturn * 100)} after inflation, with each payment credited with ${d.timing === "start" ? "a full" : d.timing === "mid" ? "half a" : "no"} year’s growth in its first year${d.inflation > 0 && d.timing !== "start" ? `, divided by (1 + inflation)${d.timing === "mid" ? "^½" : ""} (each year’s saving is set at that year’s starting prices, paid ${d.timing === "mid" ? "in the middle" : "at the end"} of the year, and the pot is valued at its end)` : ""}. For the pension the payment is grossed up by the relief-at-source rate from the engine’s ${taxYear.label} data, as the engine’s relief is.`,
    },
    method: [
      `The engine’s simulate() on a UK household with its income tax and National Insurance estimate (${d.region === "sct" ? "Scottish" : "rest-of-UK"} rates), run twice: a salary of ${m(d.salary)} until ${d.retire}, and ${m(d.save)} a year from take-home pay into a pension or into an ISA, both growing ${pctInput(d.realReturn * 100)} a year after inflation.`,
      `Pension: relief at source, as the engine models it. The provider adds basic-rate relief (${pctInput(taxYear.pensions.reliefAtSourceRate * 100)} of the gross contribution) to the pot; a higher or additional rate taxpayer’s bands are widened, so the tax on pay falls. That saving is shown but not invested: it is treated as spent in both runs.`,
      `Retirement: the highest level income after tax, in today’s money, that each pot (with the State Pension) pays in full every year until the age chosen, found by bisection on the engine’s runs. ${pct(ukTaxFreeShare(), 0)} of each pension withdrawal is tax-free (UFPLS); the rest is taxed as income. ISA withdrawals are tax-free.`,
      ukSimplification("taxFreeCash"),
      spAnnual > 0
        ? `State Pension of ${weekly(d.sp)} a week from State Pension age ${fmtAge(res.spa)} (engine data, born in ${START_YEAR - d.age}), rising with prices, in both runs. It uses up the personal allowance first.`
        : "No State Pension.",
      thresholdText(d.inflation),
      timingText(d.timing),
      ...[
        ukSimplification("annualAllowance"),
        ukSimplification("calendar"),
        ...(d.region === "sct" ? [ukSimplification("scotland")] : []),
      ].filter(Boolean),
    ],
    warnings,
  };
}
