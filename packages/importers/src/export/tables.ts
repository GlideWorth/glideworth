/**
 * Tabular exports of projection results and progress, as plain data plus CSV.
 *
 * Money is converted to the requested basis with core's `toBasis` (flows by the start-of-period
 * price index, balances by the end-of-period index) and rounded to 2 dp only here (presentation);
 * rates to 4 dp. The engine's own numbers are never rounded. Age columns show the age each person
 * reaches during the year (core `periodAge`), matching milestone ages.
 */
import {
  type GlideworthDocument,
  type MoneyMeasure,
  type PeriodResult,
  type ProjectionResult,
  periodAge,
  toBasis,
  type ValueBasis,
} from "@glideworth/core";
import { toCsv } from "../csv/parse.js";

export type ColumnFormat = "text" | "integer" | "money" | "percent";

export interface TableColumn {
  key: string;
  label: string;
  format: ColumnFormat;
}

export interface Table {
  id: string;
  title: string;
  basis?: ValueBasis;
  currency?: string;
  columns: TableColumn[];
  rows: (string | number | null)[][];
}

export interface TableOptions {
  /** Default `real` (today's money). */
  basis?: ValueBasis;
  /** Person id -> display name for age columns; accounts id -> name for balance columns. */
  labels?: Record<string, string>;
}

const money = (v: number): number => Math.round(v * 100) / 100;
const rate = (v: number | null): number | null =>
  v === null ? null : Math.round(v * 10_000) / 10_000;

/** Money in the table basis; `measure` is 'flow' for anything that happens during the year. */
function mval(
  v: number,
  p: PeriodResult,
  basis: ValueBasis,
  measure: MoneyMeasure = "flow",
): number {
  return money(toBasis(v, p, basis, measure));
}
const sval = (v: number, p: PeriodResult, basis: ValueBasis): number => mval(v, p, basis, "stock");

const label = (labels: Record<string, string> | undefined, id: string): string =>
  labels?.[id] ?? id;

/** Year-by-year projection summary. */
export function yearByYearTable(result: ProjectionResult, opts: TableOptions = {}): Table {
  const basis = opts.basis ?? "real";
  const personIds = [...new Set(result.periods.flatMap((p) => Object.keys(p.ages)))];
  const columns: TableColumn[] = [
    { key: "year", label: "Year", format: "integer" },
    ...personIds.map((id) => ({
      key: `age:${id}`,
      label: `Age (${label(opts.labels, id)})`,
      format: "integer" as const,
    })),
    { key: "netWorth", label: "Net worth", format: "money" },
    { key: "liquidNetWorth", label: "Liquid net worth", format: "money" },
    { key: "assets", label: "Assets", format: "money" },
    { key: "liabilities", label: "Liabilities", format: "money" },
    { key: "portfolio", label: "Portfolio", format: "money" },
    { key: "cash", label: "Cash", format: "money" },
    { key: "income", label: "Income", format: "money" },
    { key: "passiveIncome", label: "Passive income", format: "money" },
    { key: "expenses", label: "Expenses", format: "money" },
    { key: "spending", label: "Spending", format: "money" },
    { key: "taxes", label: "Taxes", format: "money" },
    { key: "contributions", label: "Contributions", format: "money" },
    { key: "withdrawals", label: "Withdrawals", format: "money" },
    { key: "savingsRate", label: "Savings rate", format: "percent" },
    { key: "withdrawalRate", label: "Withdrawal rate", format: "percent" },
    { key: "shortfall", label: "Shortfall", format: "money" },
    { key: "status", label: "Status", format: "text" },
  ];
  const rows = result.periods.map((p) => {
    const t = p.totals;
    return [
      p.year,
      ...personIds.map((id) => periodAge(p, id)),
      sval(t.netWorth, p, basis),
      sval(t.liquidNetWorth, p, basis),
      sval(t.assets, p, basis),
      sval(t.liabilities, p, basis),
      sval(t.portfolio, p, basis),
      sval(t.cash, p, basis),
      mval(t.income, p, basis),
      mval(t.passiveIncome, p, basis),
      mval(t.expenses, p, basis),
      mval(t.spending, p, basis),
      mval(t.taxes, p, basis),
      mval(t.contributions, p, basis),
      mval(t.withdrawals, p, basis),
      rate(t.savingsRate),
      rate(t.withdrawalRate),
      mval(t.shortfall, p, basis),
      p.status,
    ];
  });
  return {
    id: "year-by-year",
    title: "Year-by-year projection",
    basis,
    currency: result.meta.currency,
    columns,
    rows,
  };
}

/** Income by source and expenses by item, plus taxes, contributions and withdrawals. */
export function cashFlowTable(result: ProjectionResult, opts: TableOptions = {}): Table {
  const basis = opts.basis ?? "real";
  const incomeKeys = new Map<string, string>();
  const expenseKeys = new Map<string, string>();
  for (const p of result.periods) {
    for (const i of p.income) incomeKeys.set(i.sourceId, i.label);
    for (const e of p.expenses) expenseKeys.set(e.sourceId, e.label);
  }
  const columns: TableColumn[] = [
    { key: "year", label: "Year", format: "integer" },
    { key: "income", label: "Total income", format: "money" },
    ...[...incomeKeys].map(([id, l]) => ({
      key: `income:${id}`,
      label: `Income: ${l}`,
      format: "money" as const,
    })),
    { key: "expenses", label: "Total expenses (funded)", format: "money" },
    ...[...expenseKeys].map(([id, l]) => ({
      key: `expense:${id}`,
      label: `Expense: ${l}`,
      format: "money" as const,
    })),
    { key: "taxes", label: "Taxes", format: "money" },
    { key: "contributions", label: "Contributions", format: "money" },
    { key: "withdrawals", label: "Withdrawals", format: "money" },
    { key: "net", label: "Income less expenses and taxes", format: "money" },
    { key: "shortfall", label: "Unfunded shortfall", format: "money" },
  ];
  const rows = result.periods.map((p) => {
    const inc = new Map<string, number>();
    for (const i of p.income) inc.set(i.sourceId, (inc.get(i.sourceId) ?? 0) + i.amount);
    const exp = new Map<string, number>();
    let funded = 0;
    for (const e of p.expenses) {
      exp.set(e.sourceId, (exp.get(e.sourceId) ?? 0) + e.funded);
      funded += e.funded;
    }
    const incomeTotal = p.income.reduce((s, i) => s + i.amount, 0);
    return [
      p.year,
      mval(incomeTotal, p, basis),
      ...[...incomeKeys.keys()].map((id) => mval(inc.get(id) ?? 0, p, basis)),
      mval(funded, p, basis),
      ...[...expenseKeys.keys()].map((id) => mval(exp.get(id) ?? 0, p, basis)),
      mval(p.totals.taxes, p, basis),
      mval(p.totals.contributions, p, basis),
      mval(p.totals.withdrawals, p, basis),
      mval(incomeTotal - funded - p.totals.taxes, p, basis),
      mval(p.totals.shortfall, p, basis),
    ];
  });
  return {
    id: "cash-flow",
    title: "Cash flow",
    basis,
    currency: result.meta.currency,
    columns,
    rows,
  };
}

/** Taxes by jurisdiction and kind, with rates. */
export function taxTable(result: ProjectionResult, opts: TableOptions = {}): Table {
  const basis = opts.basis ?? "real";
  const lineKeys = new Map<string, string>();
  for (const p of result.periods) {
    for (const l of p.taxes.lines)
      lineKeys.set(`${l.jurisdictionId}|${l.kind}`, `${l.jurisdictionId} ${l.kind}`);
  }
  const columns: TableColumn[] = [
    { key: "year", label: "Year", format: "integer" },
    { key: "total", label: "Total tax", format: "money" },
    ...[...lineKeys].map(([k, l]) => ({ key: `line:${k}`, label: l, format: "money" as const })),
    { key: "gross", label: "Gross income", format: "money" },
    { key: "taxable", label: "Taxable income", format: "money" },
    { key: "effective", label: "Effective rate", format: "percent" },
    { key: "marginal", label: "Marginal rate", format: "percent" },
    { key: "withheld", label: "Withheld", format: "money" },
    { key: "settlement", label: "Settlement paid (refund)", format: "money" },
  ];
  const rows = result.periods.map((p) => {
    const sums = new Map<string, number>();
    for (const l of p.taxes.lines) {
      const k = `${l.jurisdictionId}|${l.kind}`;
      sums.set(k, (sums.get(k) ?? 0) + l.amount);
    }
    return [
      p.year,
      mval(p.taxes.total, p, basis),
      ...[...lineKeys.keys()].map((k) => mval(sums.get(k) ?? 0, p, basis)),
      mval(p.taxes.grossIncome, p, basis),
      mval(p.taxes.taxableIncome, p, basis),
      rate(p.taxes.effectiveRate),
      rate(p.taxes.marginalRate),
      mval(p.taxes.withheld, p, basis),
      mval(p.taxes.settlement, p, basis),
    ];
  });
  return { id: "taxes", title: "Taxes", basis, currency: result.meta.currency, columns, rows };
}

/** Closing balance of every account at the end of each year. */
export function accountBalancesTable(result: ProjectionResult, opts: TableOptions = {}): Table {
  const basis = opts.basis ?? "real";
  const ids = [...new Set(result.periods.flatMap((p) => p.accounts.map((a) => a.accountId)))];
  const columns: TableColumn[] = [
    { key: "year", label: "Year", format: "integer" },
    ...ids.map((id) => ({
      key: `acct:${id}`,
      label: label(opts.labels, id),
      format: "money" as const,
    })),
  ];
  const rows = result.periods.map((p) => [
    p.year,
    ...ids.map((id) => {
      const a = p.accounts.find((x) => x.accountId === id);
      return a ? sval(a.closing, p, basis) : null;
    }),
  ]);
  return {
    id: "account-balances",
    title: "Account balances at year end",
    basis,
    currency: result.meta.currency,
    columns,
    rows,
  };
}

/** Progress snapshots (actuals). Values are as recorded; they are nominal by nature. */
export function progressTable(doc: GlideworthDocument): Table {
  const cats = [...new Set(doc.progress.flatMap((s) => Object.keys(s.byCategory)))].sort();
  const columns: TableColumn[] = [
    { key: "date", label: "Date", format: "text" },
    { key: "netWorth", label: "Net worth", format: "money" },
    { key: "assets", label: "Assets", format: "money" },
    { key: "liabilities", label: "Liabilities", format: "money" },
    ...cats.map((c) => ({ key: `cat:${c}`, label: c, format: "money" as const })),
    { key: "source", label: "Source", format: "text" },
  ];
  const rows = [...doc.progress]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((s) => [
      s.date,
      money(s.netWorth),
      money(s.assets),
      money(s.liabilities),
      ...cats.map((c) => {
        const v = (s.byCategory as Record<string, number | undefined>)[c];
        return v === undefined ? null : money(v);
      }),
      s.source,
    ]);
  return { id: "progress", title: "Progress", currency: doc.household.currency, columns, rows };
}

/** Serialise a table to CSV text (header row = column labels). */
export function tableToCsv(table: Table): string {
  return toCsv([table.columns.map((c) => c.label), ...table.rows]);
}

export const TABLE_BUILDERS = {
  "year-by-year": yearByYearTable,
  "cash-flow": cashFlowTable,
  taxes: taxTable,
  "account-balances": accountBalancesTable,
} as const;
export type ProjectionTableId = keyof typeof TABLE_BUILDERS;
