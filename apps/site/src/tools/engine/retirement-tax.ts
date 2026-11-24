/**
 * Retirement tax calculator: US federal income tax on a year of retirement income (Social Security,
 * traditional IRA and 401(k) withdrawals, pensions, interest, qualified dividends and long-term gains,
 * tax-free Roth withdrawals) for a filing status and ages.
 *
 * Engine use: the engine's US federal plug-in (`usFederalJurisdiction`) through core's
 * `analyzeTaxYear` for the tax, the taxable part of Social Security (`taxableSocialSecurity` inside
 * the plug-in), the deductions and the bracket fill; `marginalProgression` for the rate on further
 * IRA withdrawals. See us-tax.ts for the shared choices (federal only, no IRMAA).
 */
import { type FilingStatus, US_FIXED } from "@glideworth/core";
import { money, pct } from "../format";
import { num, str } from "../state";
import type { ChartSpec, Values, ViewModel } from "../types";
import {
  analyse,
  bracketRows,
  FILING_LABELS,
  progression,
  ratePct,
  sourceNotes,
  usTaxInput,
} from "./us-tax";

const m = (x: number) => money(x, "USD");

export interface RetirementTaxInputs {
  year: number;
  status: FilingStatus;
  ages: number[];
  ss: number;
  ira: number;
  pen: number;
  int: number;
  qd: number;
  roth: number;
}

export function readInputs(v: Values): RetirementTaxInputs {
  const status = str(v, "status") as FilingStatus;
  return {
    year: Number(str(v, "year")),
    status,
    ages: status === "married-joint" ? [num(v, "age"), num(v, "age2")] : [num(v, "age")],
    ss: num(v, "ss"),
    ira: num(v, "ira"),
    pen: num(v, "pen"),
    int: num(v, "int"),
    qd: num(v, "qd"),
    roth: num(v, "roth"),
  };
}

export function retirementTaxInput(i: RetirementTaxInputs) {
  return usTaxInput({
    year: i.year,
    status: i.status,
    ages: i.ages,
    income: [
      { id: "social-security", character: "social-security", amount: i.ss },
      { id: "pension", character: "pension", amount: i.pen },
      { id: "interest", character: "interest", amount: i.int },
      { id: "qualified", character: "qualified-dividend", amount: i.qd },
      // Qualified Roth withdrawals: income the household receives, never taxed.
      { id: "roth", character: "tax-free", amount: i.roth },
    ],
    deferredWithdrawals: i.ira,
  });
}

/** Every figure the page and the calculator show, from one run of the federal plug-in. */
export function retirementTax(v: Values) {
  const i = readInputs(v);
  const input = retirementTaxInput(i);
  const a = analyse(input);
  const f = a.facts;
  const totalIncome = i.ss + i.ira + i.pen + i.int + i.qd + i.roth;
  const byKind = (k: string) =>
    a.outputs.flatMap((o) => o.lines).reduce((s, l) => s + (l.kind === k ? l.amount : 0), 0);
  const ordinaryFill = a.brackets.find((b) => b.schedule === "ordinary")?.bands ?? [];
  const prefFill = a.brackets.find((b) => b.schedule === "preferential")?.bands ?? [];
  const rows = bracketRows(i.year, i.status).map((r) => {
    const band = ordinaryFill.find((b) => Math.abs(b.rate - r.rate) < 1e-12);
    return { ...r, amount: band?.amount ?? 0, tax: band?.tax ?? 0 };
  });
  return {
    inputs: i,
    total: a.total,
    totalIncome,
    effective: totalIncome > 0 ? a.total / totalIncome : 0,
    marginal: a.marginalByType.ordinary,
    agi: f.agi ?? 0,
    taxableIncome: f["us.taxableIncome"] ?? 0,
    ordinaryTaxable: f["us.ordinaryTaxableIncome"] ?? 0,
    preferential: f["us.preferentialIncome"] ?? 0,
    taxableSs: f["us.taxableSocialSecurity"] ?? 0,
    deduction: f["us.deduction"] ?? 0,
    seniorDeduction: f["us.seniorDeduction"] ?? 0,
    ordinaryTax: byKind("income"),
    preferentialTax: byKind("dividends") + byKind("capital-gains"),
    amt: byKind("amt"),
    niit: byKind("niit"),
    rows,
    prefFill,
    input,
  };
}

const PROGRESSION_UPTO = 100_000;
const PROGRESSION_STEP = 2_500;

export async function runRetirementTax(v: Values): Promise<ViewModel> {
  const r = retirementTax(v);
  const i = r.inputs;
  const steps = progression(r.input, PROGRESSION_UPTO, PROGRESSION_STEP);
  const status = FILING_LABELS[i.status];

  // Brackets up to the one above the highest that holds income, so the chart stays readable.
  const lastFilled = r.rows.reduce((k, row, idx) => (row.amount > 0 ? idx : k), 0);
  const shownRows = r.rows.slice(0, Math.min(r.rows.length, lastFilled + 2));
  const fillChart: ChartSpec = {
    id: "retirement-tax-brackets",
    kind: "bar",
    title: `Taxable ordinary income in each federal bracket, ${i.year}`,
    summary:
      r.ordinaryTaxable > 0
        ? `After deductions, ${m(r.ordinaryTaxable)} of ordinary income is taxed. It reaches the ${ratePct(r.rows[lastFilled]!.rate)} bracket, which holds ${m(r.rows[lastFilled]!.amount)} of it.${r.preferential > 0 ? ` ${m(r.preferential)} of qualified dividends and long-term gains sits on top, at the capital gains rates.` : ""}`
        : `Deductions cover all ordinary income, so none of it is taxed at the ordinary rates.${r.preferential > 0 ? ` ${m(r.preferential)} of qualified dividends and long-term gains is taxed at the capital gains rates.` : ""}`,
    xLabel: "Federal bracket (%)",
    yLabel: "Income in the bracket",
    x: shownRows.map((row) => Number((row.rate * 100).toFixed(2))),
    series: [
      {
        label: "Taxable ordinary income in the bracket",
        values: shownRows.map((row) => row.amount),
        tone: 1,
        style: "solid",
      },
    ],
    currency: "USD",
    table: {
      caption: `Federal ordinary brackets for ${status.toLowerCase()}, ${i.year}`,
      columns: ["Bracket", "Taxable income from", "Up to", "Your income in it", "Tax"],
      rows: [
        ...r.rows.map((row) => [
          ratePct(row.rate),
          m(row.from),
          Number.isFinite(row.to) ? m(row.to) : "and above",
          m(row.amount),
          m(row.tax),
        ]),
        ...r.prefFill.map((b) => [
          `${b.label} capital gains`,
          m(b.from),
          Number.isFinite(b.to) ? m(b.to) : "and above",
          m(b.amount),
          m(b.tax),
        ]),
      ],
    },
  };

  const marginalChart: ChartSpec = {
    id: "retirement-tax-marginal",
    kind: "line",
    title: "Federal tax rate on further IRA withdrawals",
    summary: `Each point is the federal tax on the next ${m(PROGRESSION_STEP)} of traditional IRA withdrawals, divided by ${m(PROGRESSION_STEP)}. It starts at ${pct(steps[0]?.marginalRate ?? 0)} and is ${pct(steps[steps.length - 1]?.marginalRate ?? 0)} after ${m(PROGRESSION_UPTO)} more. Where it rises above the bracket rate, more Social Security is becoming taxable or gains are leaving the 0% band.`,
    xLabel: "Extra IRA withdrawals (thousands of dollars)",
    yLabel: "Tax rate on the next step",
    yUnit: "percent",
    x: steps.map((s) => s.extra / 1000),
    series: [
      {
        label: `Rate on each further ${m(PROGRESSION_STEP)}`,
        values: steps.map((s) => s.marginalRate),
        tone: 2,
        style: "solid",
      },
    ],
    currency: "USD",
    table: {
      caption: "Tax rate on each further step of IRA withdrawals",
      columns: ["Extra withdrawals", "Rate on that step"],
      rows: steps.map((s) => [m(s.extra), pct(s.marginalRate)]),
    },
  };

  const untaxedSs = Math.max(0, i.ss - r.taxableSs);
  const summary = {
    caption: `How the ${i.year} federal estimate is built`,
    columns: ["", "Amount"],
    rows: [
      ["Total income entered", m(r.totalIncome)],
      ["Less: Social Security that is not taxable", m(-untaxedSs)],
      ["Less: Roth withdrawals (tax-free)", m(-i.roth)],
      ["Adjusted gross income", m(r.agi)],
      [
        r.seniorDeduction > 0 ? "Less: standard and senior deductions" : "Less: standard deduction",
        m(-(r.deduction + r.seniorDeduction)),
      ],
      ["Taxable income", m(r.taxableIncome)],
      ["Tax on ordinary income", m(r.ordinaryTax)],
      ["Tax on qualified dividends and long-term gains", m(r.preferentialTax)],
      ...(r.amt > 0 ? [["Alternative minimum tax", m(r.amt)]] : []),
      ...(r.niit > 0 ? [["Net investment income tax", m(r.niit)]] : []),
      ["Federal income tax", m(r.total)],
    ],
  };

  const warnings: string[] = [];
  if (i.ira > 0 && i.ages[0]! < US_FIXED.retirementAccessAge)
    warnings.push(
      `Withdrawals before age ${String(US_FIXED.retirementAccessAge).replace(".5", "½")} can also owe an additional tax on early withdrawals, which this calculator does not add.`,
    );

  const headline =
    r.totalIncome <= 0
      ? "With no income entered there is no federal income tax."
      : r.total <= 0.5
        ? `On ${m(r.totalIncome)} of income in ${i.year}, the estimate is no federal income tax: deductions cover the taxable part.`
        : `On ${m(r.totalIncome)} of income in ${i.year}, estimated federal income tax is ${m(r.total)}, ${pct(r.effective)} of the total. The next dollar of IRA withdrawals is taxed at ${pct(r.marginal)}.`;

  return {
    tool: "retirement-tax",
    headline,
    announce: `Estimated federal income tax ${m(r.total)}.`,
    figures: [
      {
        label: "Federal income tax",
        value: m(r.total),
        detail: `Estimate for ${i.year}, ${status.toLowerCase()}`,
      },
      {
        label: "Taxable income",
        value: m(r.taxableIncome),
        detail: `After ${m(r.deduction + r.seniorDeduction)} of deductions`,
      },
      {
        label: "Effective rate",
        value: pct(r.effective),
        detail: "Federal tax ÷ all the income entered",
      },
      {
        label: "Marginal rate",
        value: pct(r.marginal),
        detail: "On one more dollar of IRA withdrawals",
      },
      {
        label: "Taxable Social Security",
        value: m(r.taxableSs),
        detail: i.ss > 0 ? `${pct(r.taxableSs / i.ss, 0)} of ${m(i.ss)}` : "No benefits entered",
      },
    ],
    table: summary,
    charts: [fillChart, marginalChart],
    method: [
      `The engine’s US federal tax model (usFederalJurisdiction) for tax year ${i.year}, filing ${status.toLowerCase()}: the taxable part of Social Security, the standard deduction with its additions for age and the senior deduction where they apply, the ordinary brackets, qualified dividends and long-term gains stacked on top at the capital gains rates, the alternative minimum tax and the net investment income tax.`,
      `Figures from: ${sourceNotes(i.year).join("; ")}.`,
      "Federal income tax only: no state or local tax, no payroll tax, no Medicare premium surcharges (IRMAA). Amounts are that year’s dollars.",
      "Traditional IRA and 401(k) withdrawals are taxed as ordinary income with no early-withdrawal additional tax; Roth withdrawals are treated as qualified and tax-free.",
    ],
    warnings,
  };
}
