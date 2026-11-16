/**
 * Custom chart builder model: a catalogue of every series a projection can offer (account, category,
 * tax line, metric, ...), the saved-view shape, extraction into chart-ready values, and per-plan
 * persistence of named views.
 */
import type { PeriodResult, ProjectionResult, ValueBasis } from "@glideworth/core";
import { type MoneyMeasure, measureOf } from "../../lib/money";
import { CATEGORY_LABEL, conv, type EntityIndex } from "../results/model";

export type SeriesKind = "money" | "percent";

export interface CatalogEntry {
  /** Stable id stored in saved views, e.g. `metric:netWorth`, `acct:acc-isa:closing`. */
  ref: string;
  label: string;
  group: string;
  kind: SeriesKind;
  value: (p: PeriodResult) => number | null;
}

const METRICS: { key: keyof PeriodResult["totals"]; label: string; kind?: SeriesKind }[] = [
  { key: "netWorth", label: "Net worth" },
  { key: "liquidNetWorth", label: "Liquid net worth" },
  { key: "assets", label: "Assets" },
  { key: "liabilities", label: "Liabilities" },
  { key: "portfolio", label: "Portfolio" },
  { key: "cash", label: "Cash" },
  { key: "realAssets", label: "Real assets" },
  { key: "income", label: "Income" },
  { key: "passiveIncome", label: "Passive income" },
  { key: "expenses", label: "Expenses" },
  { key: "spending", label: "Spending" },
  { key: "taxes", label: "Taxes paid" },
  { key: "contributions", label: "Contributions" },
  { key: "withdrawals", label: "Withdrawals" },
  { key: "shortfall", label: "Unfunded spending" },
  { key: "afterTaxIncome", label: "After-tax income (savings rate base)" },
  { key: "savedFromIncome", label: "Saved from income" },
  { key: "oneOffInflows", label: "One-off inflows (sales, windfalls)" },
  { key: "savingsRate", label: "Savings rate", kind: "percent" },
  { key: "withdrawalRate", label: "Withdrawal rate", kind: "percent" },
];

const ACCOUNT_FIELDS = [
  ["closing", "balance"],
  ["contributions", "contributions"],
  ["withdrawals", "withdrawals"],
  ["growth", "growth"],
  ["dividends", "dividends"],
] as const;

const KIND_LABEL: Record<string, string> = {
  income: "Income tax",
  "capital-gains": "Capital gains tax",
  dividends: "Dividend tax",
  payroll: "Payroll / National Insurance",
  "self-employment": "Self-employment tax",
  niit: "Net investment income tax",
  amt: "AMT",
  irmaa: "IRMAA",
  "aca-reconciliation": "ACA reconciliation",
  penalty: "Penalties and charges",
  wealth: "Wealth tax",
  property: "Property tax",
  local: "Local tax",
  credit: "Credits",
  other: "Other tax",
};

/**
 * Today's-money measure of a catalogue series: balances at the year end are stocks, everything that
 * moves during the year (income, tax, contributions, growth...) is a flow.
 */
export function measureOfRef(ref: string): MoneyMeasure {
  const [kind, id, field] = ref.split(":");
  switch (kind) {
    case "metric":
      return measureOf(id ?? "");
    case "cat":
    case "asset":
      return "stock";
    case "acct":
    case "debt":
      return field === "closing" ? "stock" : "flow";
    default:
      return "flow";
  }
}

/** Every series this projection can chart. Order is the picker order. */
export function buildCatalog(result: ProjectionResult, index: EntityIndex): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const m of METRICS)
    out.push({
      ref: `metric:${m.key}`,
      label: m.label,
      group: "Metrics",
      kind: m.kind ?? "money",
      value: (p) => (p.totals[m.key] as number | null | undefined) ?? null,
    });

  const cats = new Set<string>();
  for (const p of result.periods) for (const c of Object.keys(p.totals.byCategory)) cats.add(c);
  for (const c of cats)
    out.push({
      ref: `cat:${c}`,
      label: (CATEGORY_LABEL as Record<string, string>)[c] ?? c,
      group: "Net worth by category",
      kind: "money",
      value: (p) => (p.totals.byCategory as Record<string, number | undefined>)[c] ?? 0,
    });

  const accountIds = [
    ...new Set(result.periods.flatMap((p) => p.accounts.map((a) => a.accountId))),
  ];
  for (const id of accountIds) {
    const name = index.accounts.get(id)?.name ?? id;
    for (const [field, word] of ACCOUNT_FIELDS)
      out.push({
        ref: `acct:${id}:${field}`,
        label: `${name}: ${word}`,
        group: `Account: ${name}`,
        kind: "money",
        value: (p) => p.accounts.find((a) => a.accountId === id)?.[field] ?? null,
      });
  }

  const assetIds = [...new Set(result.periods.flatMap((p) => p.realAssets.map((a) => a.assetId)))];
  for (const id of assetIds) {
    const name = index.assets.get(id) ?? id;
    for (const [field, word] of [
      ["value", "value"],
      ["equity", "equity"],
      ["loanBalance", "loan balance"],
    ] as const)
      out.push({
        ref: `asset:${id}:${field}`,
        label: `${name}: ${word}`,
        group: "Property and assets",
        kind: "money",
        value: (p) => p.realAssets.find((a) => a.assetId === id)?.[field] ?? null,
      });
  }
  const debtIds = [...new Set(result.periods.flatMap((p) => p.debts.map((d) => d.debtId)))];
  for (const id of debtIds)
    out.push({
      ref: `debt:${id}:closing`,
      label: `${index.debts.get(id) ?? id}: balance`,
      group: "Debts",
      kind: "money",
      value: (p) => p.debts.find((d) => d.debtId === id)?.closing ?? null,
    });

  const taxKinds = [...new Set(result.periods.flatMap((p) => p.taxes.lines.map((l) => l.kind)))];
  for (const k of taxKinds)
    out.push({
      ref: `taxkind:${k}`,
      label: KIND_LABEL[k] ?? k,
      group: "Taxes",
      kind: "money",
      value: (p) => p.taxes.lines.filter((l) => l.kind === k).reduce((s, l) => s + l.amount, 0),
    });
  const taxJur = [
    ...new Set(result.periods.flatMap((p) => p.taxes.lines.map((l) => l.jurisdictionId))),
  ];
  if (taxJur.length > 1)
    for (const j of taxJur)
      out.push({
        ref: `taxjur:${j}`,
        label: `Tax: ${j}`,
        group: "Taxes",
        kind: "money",
        value: (p) =>
          p.taxes.lines.filter((l) => l.jurisdictionId === j).reduce((s, l) => s + l.amount, 0),
      });
  out.push(
    {
      ref: "tax:total",
      label: "Total tax",
      group: "Taxes",
      kind: "money",
      value: (p) => p.taxes.total,
    },
    {
      ref: "tax:gross",
      label: "Taxable gross income",
      group: "Taxes",
      kind: "money",
      value: (p) => p.taxes.grossIncome,
    },
    {
      ref: "tax:taxable",
      label: "Taxable income",
      group: "Taxes",
      kind: "money",
      value: (p) => p.taxes.taxableIncome,
    },
    {
      ref: "tax:effective",
      label: "Effective tax rate",
      group: "Taxes",
      kind: "percent",
      value: (p) => p.taxes.effectiveRate,
    },
    {
      ref: "tax:marginal",
      label: "Marginal tax rate",
      group: "Taxes",
      kind: "percent",
      value: (p) => p.taxes.marginalRate,
    },
  );

  const incomeSources = new Map<string, string>();
  for (const p of result.periods) for (const l of p.income) incomeSources.set(l.sourceId, l.label);
  for (const [id, label] of incomeSources)
    out.push({
      ref: `income:${id}`,
      label,
      group: "Income sources",
      kind: "money",
      value: (p) => p.income.filter((l) => l.sourceId === id).reduce((s, l) => s + l.amount, 0),
    });
  const expCats = [...new Set(result.periods.flatMap((p) => p.expenses.map((e) => e.category)))];
  for (const c of expCats)
    out.push({
      ref: `expcat:${c}`,
      label: c.replace(/-/g, " ").replace(/^./, (x) => x.toUpperCase()),
      group: "Spending by category",
      kind: "money",
      value: (p) => p.expenses.filter((e) => e.category === c).reduce((s, e) => s + e.funded, 0),
    });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

export type ChartType = "line" | "bar" | "area";

export interface ViewSeries {
  ref: string;
  axis: "left" | "right";
  /** Overrides the view's chart type for this series. */
  type?: ChartType;
}

export interface ChartView {
  id: string;
  name: string;
  chartType: ChartType;
  stacked: boolean;
  /** 'follow' uses the app's today's/future money toggle. */
  basis: "follow" | ValueBasis;
  series: ViewSeries[];
}

export function emptyView(): ChartView {
  return {
    id: "",
    name: "Untitled view",
    chartType: "line",
    stacked: false,
    basis: "follow",
    series: [{ ref: "metric:netWorth", axis: "left" }],
  };
}

/** Axis a newly added series should use: percentages go right when money is already charted. */
export function defaultAxis(
  kind: SeriesKind,
  existing: { kind: SeriesKind; axis: "left" | "right" }[],
) {
  const hasMoney = existing.some((s) => s.kind === "money");
  const hasPercent = existing.some((s) => s.kind === "percent");
  if (kind === "percent") return hasMoney ? ("right" as const) : ("left" as const);
  return hasPercent && !hasMoney ? ("right" as const) : ("left" as const);
}

export interface BuiltSeries {
  ref: string;
  label: string;
  kind: SeriesKind;
  axis: "left" | "right";
  type: ChartType;
  stack: string | undefined;
  values: (number | null)[];
}

export function buildSeries(
  view: ChartView,
  catalog: CatalogEntry[],
  result: ProjectionResult,
  appBasis: ValueBasis,
): { series: BuiltSeries[]; missing: string[] } {
  const basis = view.basis === "follow" ? appBasis : view.basis;
  const byRef = new Map(catalog.map((c) => [c.ref, c]));
  const series: BuiltSeries[] = [];
  const missing: string[] = [];
  for (const s of view.series) {
    const entry = byRef.get(s.ref);
    if (!entry) {
      missing.push(s.ref);
      continue;
    }
    const type = s.type ?? view.chartType;
    series.push({
      ref: s.ref,
      label: entry.label,
      kind: entry.kind,
      axis: s.axis,
      type,
      // Only same-axis money series can stack meaningfully.
      stack:
        view.stacked && entry.kind === "money" && type !== "line" ? `stack-${s.axis}` : undefined,
      values: result.periods.map((p) => {
        const v = entry.value(p);
        if (v === null || Number.isNaN(v)) return null;
        return entry.kind === "money" ? conv(p, v, basis, measureOfRef(entry.ref)) : v;
      }),
    });
  }
  return { series, missing };
}

// ---------------------------------------------------------------------------------------------
// Persistence (per plan, this browser)
// ---------------------------------------------------------------------------------------------

const KEY = (planId: string) => `glideworth:chart-views:v1:${planId}`;

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function store(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadViews(planId: string, s: StorageLike | null = store()): ChartView[] {
  try {
    const raw = s?.getItem(KEY(planId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isView) : [];
  } catch {
    return [];
  }
}

export function saveViews(
  planId: string,
  views: ChartView[],
  s: StorageLike | null = store(),
): boolean {
  try {
    s?.setItem(KEY(planId), JSON.stringify(views));
    return !!s;
  } catch {
    return false;
  }
}

export function isView(v: unknown): v is ChartView {
  if (!v || typeof v !== "object") return false;
  const x = v as Partial<ChartView>;
  return (
    typeof x.id === "string" &&
    typeof x.name === "string" &&
    (x.chartType === "line" || x.chartType === "bar" || x.chartType === "area") &&
    typeof x.stacked === "boolean" &&
    Array.isArray(x.series) &&
    x.series.every(
      (s) => s && typeof s.ref === "string" && (s.axis === "left" || s.axis === "right"),
    )
  );
}

export function upsertView(views: ChartView[], view: ChartView): ChartView[] {
  const exists = views.some((v) => v.id === view.id);
  return exists ? views.map((v) => (v.id === view.id ? view : v)) : [...views, view];
}
