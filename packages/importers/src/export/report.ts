/**
 * Printable report as plain data. The web app renders it (HTML / print CSS); nothing here knows
 * about layout. Everything is JSON-serialisable, with numbers unrounded except where a field says
 * otherwise, so the renderer formats with Intl.
 */
import {
  type GlideworthDocument,
  type MoneyMeasure,
  type Plan,
  type ProjectionResult,
  toBasis,
  totalsMeasure,
  type ValueBasis,
} from "@glideworth/core";
import { type Table, yearByYearTable } from "./tables.js";

export interface ReportKeyFigure {
  id: string;
  label: string;
  value: number | string | null;
  /** How to format `value`. */
  format: "money" | "percent" | "integer" | "text";
  note?: string;
}

export interface ReportSeries {
  id: string;
  title: string;
  basis: ValueBasis;
  currency: string;
  points: { year: number; value: number }[];
}

export interface ReportAssumption {
  label: string;
  value: string;
}

export interface ReportMilestone {
  id: string;
  name: string;
  status: "reached" | "never" | "disabled";
  month: string | null;
  year: number | null;
  ages: Record<string, number>;
}

export interface ReportData {
  title: string;
  household: {
    name: string;
    people: { id: string; name: string }[];
    currency: string;
    locale: string;
  };
  plan: { id: string; name: string };
  basis: ValueBasis;
  /** `YYYY-MM` the figures start from, and the last simulated month. */
  period: { start: string; end: string };
  keyFigures: ReportKeyFigure[];
  milestones: ReportMilestone[];
  series: ReportSeries[];
  /** Year-by-year table (every `tableEvery` years plus the final year). */
  table: Table;
  currentFinances: {
    accounts: { name: string; type: string; owner: string; balance: number }[];
    realAssets: { name: string; type: string; value: number; loan: number }[];
    debts: { name: string; balance: number }[];
    totals: {
      accounts: number;
      realAssets: number;
      loans: number;
      debts: number;
      netWorth: number;
    };
  };
  income: { name: string; type: string; frequency: string; amount: number; basis: ValueBasis }[];
  expenses: { name: string; type: string; frequency: string; amount: number; basis: ValueBasis }[];
  assumptions: ReportAssumption[];
  /** Engine warnings plus standing caveats. Always non-empty: a report never claims certainty. */
  caveats: string[];
  warnings: { code: string; severity: string; message: string }[];
}

export interface ReportOptions {
  basis?: ValueBasis;
  /** Table row spacing in years (default 5). */
  tableEvery?: number;
  title?: string;
}

const STANDING_CAVEATS = [
  "Projections are estimates from the assumptions listed, not predictions or financial advice.",
  "Real figures are in today's money; nominal figures include assumed inflation.",
  "Tax results depend on the tax rules and rates configured for this plan and may not reflect your actual liability.",
];

function rateText(spec: Plan["assumptions"]["inflation"]): string {
  switch (spec.kind) {
    case "none":
      return "none";
    case "fixed":
      return `${(spec.rate * 100).toFixed(2)}% a year`;
    case "schedule":
      return `varies over time (${spec.points.length} points)`;
    case "historical":
      return `historical ${spec.series} from ${spec.startYear}`;
  }
}

/** Build the printable report data for one plan and its projection. */
export function buildReportData(
  doc: GlideworthDocument,
  planId: string,
  result: ProjectionResult,
  opts: ReportOptions = {},
): ReportData {
  const plan = doc.plans.find((p) => p.id === planId);
  if (!plan) throw new Error(`plan '${planId}' not found`);
  const basis = opts.basis ?? "real";
  const every = Math.max(1, opts.tableEvery ?? 5);
  const labels = Object.fromEntries([
    ...doc.household.people.map((p) => [p.id, p.name]),
    ...doc.finances.accounts.map((a) => [a.id, a.name]),
  ]);
  const periods = result.periods;
  const last = periods[periods.length - 1];
  const first = periods[0];
  const conv = (v: number, p: (typeof periods)[number], measure: MoneyMeasure = "stock"): number =>
    toBasis(v, p, basis, measure);

  const keyFigures: ReportKeyFigure[] = [
    {
      id: "success",
      label: "Plan funds all expenses",
      value: result.summary.success ? "Yes" : "No",
      format: "text",
    },
    {
      id: "firstShortfallYear",
      label: "First shortfall year",
      value: result.summary.firstShortfallYear,
      format: "integer",
    },
    {
      id: "startNetWorth",
      label: "Net worth at start",
      value: first ? conv(first.totals.netWorth, first) : null,
      format: "money",
    },
    {
      id: "endNetWorth",
      label: "Net worth at end",
      value: basis === "real" ? result.summary.endNetWorthReal : result.summary.endNetWorth,
      format: "money",
    },
    {
      id: "lifetimeTaxes",
      label: "Lifetime taxes",
      value: basis === "real" ? result.summary.lifetimeTaxesReal : result.summary.lifetimeTaxes,
      format: "money",
    },
    {
      id: "retirementYear",
      label: "Retirement year",
      value: result.summary.retirementYear,
      format: "integer",
    },
  ];

  const series: ReportSeries[] = [
    ["netWorth", "Net worth", (p: (typeof periods)[number]) => p.totals.netWorth],
    [
      "liquidNetWorth",
      "Liquid net worth",
      (p: (typeof periods)[number]) => p.totals.liquidNetWorth,
    ],
    ["income", "Income", (p: (typeof periods)[number]) => p.totals.income],
    ["expenses", "Expenses", (p: (typeof periods)[number]) => p.totals.expenses],
  ].map(([id, title, pick]) => ({
    id: id as string,
    title: title as string,
    basis,
    currency: result.meta.currency,
    points: periods.map((p) => ({
      year: p.year,
      value: conv(
        (pick as (p: (typeof periods)[number]) => number)(p),
        p,
        totalsMeasure(id as string) ?? "stock",
      ),
    })),
  }));

  const fullTable = yearByYearTable(result, { basis, labels });
  const rows = fullTable.rows.filter((_, i) => i % every === 0 || i === periods.length - 1);

  const loanTotal = doc.finances.realAssets.reduce((s, a) => s + (a.loan?.balance ?? 0), 0);
  const accountsTotal = doc.finances.accounts.reduce((s, a) => s + a.balance, 0);
  const assetsTotal = doc.finances.realAssets.reduce((s, a) => s + a.currentValue, 0);
  const debtsTotal = doc.finances.debts.reduce((s, d) => s + d.balance, 0);
  const personName = (id: string): string => (id === "joint" ? "Joint" : (labels[id] ?? id));

  const assumptions: ReportAssumption[] = [
    { label: "Inflation", value: rateText(plan.assumptions.inflation) },
    { label: "Stock return", value: rateText(plan.assumptions.stockReturn) },
    { label: "Bond return", value: rateText(plan.assumptions.bondReturn) },
    { label: "Cash return", value: rateText(plan.assumptions.cashReturn) },
    { label: "Dividend yield", value: rateText(plan.assumptions.dividendYield) },
    { label: "Tax mode", value: plan.tax.mode },
    { label: "Filing status", value: plan.tax.filingStatus },
    { label: "Chance-of-success method", value: plan.monteCarlo.method },
    { label: "Currency / locale", value: `${doc.household.currency} / ${doc.household.locale}` },
  ];
  if (plan.withdrawalStrategy?.enabled)
    assumptions.push({ label: "Withdrawal strategy", value: plan.withdrawalStrategy.rule.kind });

  return {
    title: opts.title ?? `${plan.name}: plan report`,
    household: {
      name: doc.household.name,
      people: doc.household.people.map((p) => ({ id: p.id, name: p.name })),
      currency: doc.household.currency,
      locale: doc.household.locale,
    },
    plan: { id: plan.id, name: plan.name },
    basis,
    period: { start: result.meta.startMonth, end: result.meta.endMonth },
    keyFigures,
    milestones: result.milestones.map((m) => ({
      id: m.milestoneId,
      name: m.name,
      status: m.status,
      month: m.month,
      year: m.month ? Number(m.month.slice(0, 4)) : null,
      ages: m.ages,
    })),
    series,
    table: { ...fullTable, rows },
    currentFinances: {
      accounts: doc.finances.accounts.map((a) => ({
        name: a.name,
        type: a.type,
        owner: personName(a.owner),
        balance: a.balance,
      })),
      realAssets: doc.finances.realAssets.map((a) => ({
        name: a.name,
        type: a.type,
        value: a.currentValue,
        loan: a.loan?.balance ?? 0,
      })),
      debts: doc.finances.debts.map((d) => ({ name: d.name, balance: d.balance })),
      totals: {
        accounts: accountsTotal,
        realAssets: assetsTotal,
        loans: loanTotal,
        debts: debtsTotal,
        netWorth: accountsTotal + assetsTotal - loanTotal - debtsTotal,
      },
    },
    income: plan.income.map((e) => ({
      name: e.name,
      type: e.type,
      frequency: e.frequency,
      amount: e.amount.value,
      basis: e.amount.basis,
    })),
    expenses: plan.expenses.map((e) => ({
      name: e.name,
      type: e.type,
      frequency: e.frequency,
      amount: e.amount.value,
      basis: e.amount.basis,
    })),
    assumptions,
    caveats: [
      ...STANDING_CAVEATS,
      ...(result.meta.strict
        ? []
        : ["Some features are not yet modelled; see the warnings below."]),
      ...(last && last.status === "shortfall"
        ? ["The plan runs out of funds before the end of the horizon."]
        : []),
    ],
    warnings: result.warnings.map((w) => ({
      code: w.code,
      severity: w.severity,
      message: w.message,
    })),
  };
}
