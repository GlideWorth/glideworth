/**
 * Pure derivations from a ProjectionResult for every analysis view: entity names, series per
 * chart mode, life events, table columns, CSV, ranges. No React, no ECharts — unit-tested.
 * All money in results is nominal; `conv` (lib/money) applies the global today's/future money toggle
 * with the right measure: flows by the start-of-year index, balances by the end-of-year index.
 */
import {
  ACCOUNT_TYPE_INFO,
  periodAge as corePeriodAge,
  type DrawdownCategory,
  type GlideworthDocument,
  type PeriodResult,
  type Plan,
  type ProjectionResult,
  type TaxTreatment,
  type ValueBasis,
} from "@glideworth/core";
import type { ChartKind, ProjectionMode } from "../../components/charts/chart-prefs";
import {
  accountColors,
  categoryColor,
  type FlowRole,
  roleColor,
  slotColor,
  type ThemeName,
  treatmentColor,
} from "../../components/charts/palette";
import { conv, measureOf, type YearViewOptions } from "../../lib/money";
import { periodShortLabel } from "../../lib/period";

export { conv };

export const CATEGORY_ORDER: DrawdownCategory[] = [
  "cash",
  "taxable",
  "crypto",
  "tax-deferred",
  "tax-free",
  "hsa",
  "education",
  "real-assets",
];
export const CATEGORY_LABEL: Record<DrawdownCategory, string> = {
  cash: "Cash",
  taxable: "Taxable",
  crypto: "Crypto",
  "tax-deferred": "Tax-deferred",
  "tax-free": "Tax-free",
  hsa: "Health (HSA)",
  education: "Education",
  "real-assets": "Real assets",
};
export const TREATMENT_ORDER: TaxTreatment[] = [
  "cash",
  "taxable",
  "tax-deferred",
  "tax-free",
  "hsa",
  "education",
];
export const TREATMENT_LABEL: Record<TaxTreatment, string> = {
  cash: "Cash",
  taxable: "Taxable",
  "tax-deferred": "Tax-deferred (pensions)",
  "tax-free": "Tax-free (ISA / Roth)",
  hsa: "Health (HSA)",
  education: "Education",
};

// ---------------------------------------------------------------------------------------------
// Entity index
// ---------------------------------------------------------------------------------------------

export interface AccountMeta {
  id: string;
  name: string;
  category: DrawdownCategory;
  treatment: TaxTreatment;
  typeLabel: string;
  owner: string;
  qualifiedAge?: number;
}
export interface EntityIndex {
  accounts: Map<string, AccountMeta>;
  accountOrder: string[];
  assets: Map<string, string>;
  debts: Map<string, string>;
  people: { id: string; name: string; role: string }[];
  ownerName: (id: string) => string;
}

export function buildEntityIndex(
  doc: GlideworthDocument | undefined,
  plan: Plan | undefined,
): EntityIndex {
  const accounts = new Map<string, AccountMeta>();
  const order: string[] = [];
  const finances =
    plan?.startingConditions.kind === "snapshot" ? plan.startingConditions.finances : doc?.finances;
  for (const a of [...(finances?.accounts ?? []), ...(plan?.plannedAccounts ?? [])]) {
    const info = ACCOUNT_TYPE_INFO[a.type];
    accounts.set(a.id, {
      id: a.id,
      name: a.name,
      category: info.drawdown,
      treatment: a.taxTreatment ?? info.taxTreatment,
      typeLabel: info.label,
      owner: a.owner,
      ...(info.qualifiedAge !== undefined ? { qualifiedAge: info.qualifiedAge } : {}),
    });
    order.push(a.id);
  }
  const assets = new Map<string, string>();
  for (const r of [...(finances?.realAssets ?? []), ...(plan?.plannedRealAssets ?? [])])
    assets.set(r.id, r.name);
  const debts = new Map<string, string>();
  for (const d of finances?.debts ?? []) debts.set(d.id, d.name);
  const people = (doc?.household.people ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
  }));
  const ownerName = (id: string) =>
    id === "joint" ? "Joint" : (people.find((p) => p.id === id)?.name ?? id);
  return { accounts, accountOrder: order, assets, debts, people, ownerName };
}

/** Make sure every account seen in the result is indexed (handles accounts created mid-plan). */
export function accountMeta(
  index: EntityIndex,
  id: string,
  category: DrawdownCategory,
): AccountMeta {
  return (
    index.accounts.get(id) ?? {
      id,
      name: id,
      category,
      treatment: category === "crypto" || category === "real-assets" ? "taxable" : category,
      typeLabel: CATEGORY_LABEL[category],
      owner: "joint",
    }
  );
}

export function accountColorMap(
  result: ProjectionResult,
  index: EntityIndex,
  theme: ThemeName,
  surface: string,
  ink: string,
): Record<string, string> {
  const ids = new Set(index.accountOrder);
  const extra: { id: string; category: DrawdownCategory }[] = [];
  for (const p of result.periods)
    for (const a of p.accounts)
      if (!ids.has(a.accountId)) {
        ids.add(a.accountId);
        extra.push({ id: a.accountId, category: a.category });
      }
  return accountColors(
    theme,
    [
      ...index.accountOrder.map((id) => ({ id, category: index.accounts.get(id)!.category })),
      ...extra,
    ],
    surface,
    ink,
  );
}

// ---------------------------------------------------------------------------------------------
// Chart series per mode
// ---------------------------------------------------------------------------------------------

export interface SeriesSpec {
  id: string;
  name: string;
  color: string;
  values: number[];
  /** 'pos' and 'neg' stacks are drawn on either side of zero. */
  stack: "pos" | "neg" | null;
  /** Hatched (liabilities) for secondary encoding. */
  hatch?: boolean;
}
export interface ModeSeries {
  series: SeriesSpec[];
  /** Overlaid ink line (net worth, net cash flow...). */
  line?: { name: string; values: number[] };
}

export const MODE_LABEL: Record<ProjectionMode, string> = {
  netWorth: "Net worth",
  byAccount: "By account",
  byTreatment: "By tax treatment",
  assetsDebts: "Assets vs debts",
  incomeExpenses: "Income vs expenses",
  cashFlow: "Savings & withdrawals",
};

export interface Palette {
  theme: ThemeName;
  surface: string;
  ink: string;
  negative: string;
}

const present = (values: number[]) => values.some((v) => Math.abs(v) > 0.5);

export function modeSeries(
  result: ProjectionResult,
  mode: ProjectionMode,
  basis: ValueBasis,
  index: EntityIndex,
  pal: Palette,
  view: YearViewOptions = {},
): ModeSeries {
  const P = result.periods;
  const c = (p: PeriodResult, v: number) => conv(p, v, basis, "stock");
  /** Flows of one year (a partial year is scaled to 12 months when `view.annualise`). */
  const fl = (p: PeriodResult, v: number) => conv(p, v, basis, "flow", view);
  const liabilities = (): SeriesSpec => ({
    id: "liabilities",
    name: "Liabilities",
    color: pal.negative,
    stack: "neg",
    hatch: true,
    values: P.map((p) => -c(p, p.totals.liabilities)),
  });
  const netWorth = { name: "Net worth", values: P.map((p) => c(p, p.totals.netWorth)) };

  switch (mode) {
    case "netWorth": {
      const series = CATEGORY_ORDER.map((cat) => ({
        id: cat,
        name: CATEGORY_LABEL[cat],
        color: categoryColor(pal.theme, cat),
        stack: "pos" as const,
        values: P.map((p) => c(p, p.totals.byCategory[cat] ?? 0)),
      })).filter((s) => present(s.values));
      return { series: [...series, liabilities()], line: netWorth };
    }
    case "byTreatment": {
      const byT = TREATMENT_ORDER.map((t) => ({
        id: t,
        name: TREATMENT_LABEL[t],
        color: treatmentColor(pal.theme, t),
        stack: "pos" as const,
        values: P.map((p) =>
          c(
            p,
            p.accounts
              .filter((a) => accountMeta(index, a.accountId, a.category).treatment === t)
              .reduce((s, a) => s + a.closing, 0),
          ),
        ),
      })).filter((s) => present(s.values));
      const real: SeriesSpec = {
        id: "real-assets",
        name: "Property & real assets",
        color: categoryColor(pal.theme, "real-assets"),
        stack: "pos",
        values: P.map((p) => c(p, p.totals.realAssets)),
      };
      return {
        series: [...byT, ...(present(real.values) ? [real] : []), liabilities()],
        line: netWorth,
      };
    }
    case "byAccount": {
      const colors = accountColorMap(result, index, pal.theme, pal.surface, pal.ink);
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const id of index.accountOrder) {
        seen.add(id);
        ids.push(id);
      }
      for (const p of P)
        for (const a of p.accounts)
          if (!seen.has(a.accountId)) {
            seen.add(a.accountId);
            ids.push(a.accountId);
          }
      const cats = new Map<string, DrawdownCategory>();
      for (const p of P) for (const a of p.accounts) cats.set(a.accountId, a.category);
      // Group by category so stepped hues sit together in the stack.
      ids.sort(
        (a, b) =>
          CATEGORY_ORDER.indexOf(cats.get(a) ?? "cash") -
          CATEGORY_ORDER.indexOf(cats.get(b) ?? "cash"),
      );
      const accounts: SeriesSpec[] = ids
        .map((id) => ({
          id,
          name: accountMeta(index, id, cats.get(id) ?? "cash").name,
          color: colors[id] ?? pal.ink,
          stack: "pos" as const,
          values: P.map((p) => c(p, p.accounts.find((a) => a.accountId === id)?.closing ?? 0)),
        }))
        .filter((s) => present(s.values));
      const assetIds = [...new Set(P.flatMap((p) => p.realAssets.map((r) => r.assetId)))];
      const assets: SeriesSpec[] = assetIds.map((id, i) => ({
        id: `asset:${id}`,
        name: index.assets.get(id) ?? id,
        color: i === 0 ? categoryColor(pal.theme, "real-assets") : mixStone(pal, i),
        stack: "pos",
        values: P.map((p) => c(p, p.realAssets.find((r) => r.assetId === id)?.value ?? 0)),
      }));
      const loans: SeriesSpec[] = assetIds.map((id) => ({
        id: `loan:${id}`,
        name: `${index.assets.get(id) ?? id} loan`,
        color: pal.negative,
        stack: "neg",
        hatch: true,
        values: P.map((p) => -c(p, p.realAssets.find((r) => r.assetId === id)?.loanBalance ?? 0)),
      }));
      const debtIds = [...new Set(P.flatMap((p) => p.debts.map((d) => d.debtId)))];
      const debts: SeriesSpec[] = debtIds.map((id) => ({
        id: `debt:${id}`,
        name: index.debts.get(id) ?? id,
        color: slotColor(pal.theme, 7),
        stack: "neg",
        hatch: true,
        values: P.map((p) => -c(p, p.debts.find((d) => d.debtId === id)?.closing ?? 0)),
      }));
      return {
        series: [...accounts, ...assets, ...loans, ...debts].filter((s) => present(s.values)),
        line: netWorth,
      };
    }
    case "assetsDebts":
      return {
        series: [
          {
            id: "liquid",
            name: "Liquid assets",
            color: roleColor(pal.theme, "savings", pal.negative),
            stack: "pos",
            values: P.map((p) => c(p, p.totals.assets - p.totals.realAssets)),
          },
          {
            id: "real",
            name: "Real assets",
            color: categoryColor(pal.theme, "real-assets"),
            stack: "pos",
            values: P.map((p) => c(p, p.totals.realAssets)),
          },
          liabilities(),
        ].filter((s) => present(s.values)) as SeriesSpec[],
        line: netWorth,
      };
    case "incomeExpenses": {
      const incomeIds = uniqueLines(P, (p) => p.income.map((l) => [l.sourceId, l.label]));
      const inc = incomeIds.map(([id, label], i) => ({
        id: `inc:${id}`,
        name: label,
        color: slotColor(pal.theme, [0, 5, 6, 2, 4][i % 5]!),
        stack: "pos" as const,
        values: P.map((p) =>
          fl(
            p,
            p.income.filter((l) => l.sourceId === id).reduce((s, l) => s + l.amount, 0),
          ),
        ),
      }));
      const withdrawals: SeriesSpec = {
        id: "withdrawals",
        name: "Portfolio withdrawals",
        color: roleColor(pal.theme, "withdrawal", pal.negative),
        stack: "pos",
        hatch: true,
        values: P.map((p) => fl(p, p.totals.withdrawals)),
      };
      const expCats = uniqueLines(P, (p) =>
        p.expenses.map((l) => [l.category, categoryName(l.category)]),
      );
      const exp = expCats.map(([cat, label], i) => ({
        id: `exp:${cat}`,
        name: label,
        color: slotColor(pal.theme, [1, 3, 7, 4, 2][i % 5]!),
        stack: "neg" as const,
        values: P.map(
          (p) =>
            -fl(
              p,
              p.expenses.filter((l) => l.category === cat).reduce((s, l) => s + l.funded, 0),
            ),
        ),
      }));
      const taxes: SeriesSpec = {
        id: "taxes",
        name: "Taxes",
        color: roleColor(pal.theme, "tax", pal.negative),
        stack: "neg",
        values: P.map((p) => -fl(p, p.totals.taxes)),
      };
      return {
        series: [...inc, withdrawals, ...exp, taxes].filter((s) => present(s.values)),
        line: {
          name: "Net cash flow",
          values: P.map((p) =>
            fl(p, p.totals.income + p.totals.withdrawals - p.totals.expenses - p.totals.taxes),
          ),
        },
      };
    }
    case "cashFlow":
      return {
        series: [
          {
            id: "contributions",
            name: "Contributions",
            color: roleColor(pal.theme, "savings", pal.negative),
            stack: "pos",
            values: P.map((p) => fl(p, p.totals.contributions)),
          },
          {
            id: "withdrawals",
            name: "Withdrawals",
            color: roleColor(pal.theme, "withdrawal", pal.negative),
            stack: "neg",
            hatch: true,
            values: P.map((p) => -fl(p, p.totals.withdrawals)),
          },
          {
            id: "shortfall",
            name: "Unfunded shortfall",
            color: pal.negative,
            stack: "neg",
            values: P.map((p) => -fl(p, p.totals.shortfall)),
          },
        ].filter((s) => present(s.values)) as SeriesSpec[],
        line: {
          name: "Net saved",
          values: P.map((p) => fl(p, p.totals.contributions - p.totals.withdrawals)),
        },
      };
  }
}

function mixStone(pal: Palette, i: number): string {
  return slotColor(pal.theme, i % 2 ? 7 : 4);
}

function uniqueLines(P: PeriodResult[], pick: (p: PeriodResult) => string[][]): [string, string][] {
  const m = new Map<string, string>();
  for (const p of P) for (const [id, label] of pick(p)) if (!m.has(id!)) m.set(id!, label!);
  return [...m.entries()];
}

/** Category names the generic rule below would get wrong. */
const CATEGORY_NAMES: Record<string, string> = { "long-term-care": "Long-term care" };

export function categoryName(cat: string): string {
  if (CATEGORY_NAMES[cat]) return CATEGORY_NAMES[cat];
  const s = cat.replace(/[-_]/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function roleOf(kind: string): FlowRole {
  switch (kind) {
    case "income":
      return "income";
    case "tax":
      return "tax";
    case "expense":
      return "expense";
    case "account":
      return "savings";
    case "debt":
    case "asset":
      return "debt";
    case "growth":
      return "growth";
    case "shortfall":
      return "shortfall";
    default:
      return "pool";
  }
}

export const KIND_LABEL: Record<ChartKind, string> = { bar: "Bars", area: "Area", line: "Lines" };

// ---------------------------------------------------------------------------------------------
// Timeline: milestones and life events
// ---------------------------------------------------------------------------------------------

export interface TimelineEvent {
  periodIndex: number;
  label: string;
  type: "milestone" | "income-start" | "income-end" | "expense" | "shortfall" | "early-withdrawal";
}

export function timelineEvents(result: ProjectionResult, plan?: Plan): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  const shown = new Set(
    (plan?.milestones ?? []).filter((m) => m.showOnChart !== false).map((m) => m.id),
  );
  for (const m of result.milestones) {
    if (m.status !== "reached" || m.periodIndex === null) continue;
    if (plan && !shown.has(m.milestoneId)) continue;
    out.push({ periodIndex: m.periodIndex, label: m.name, type: "milestone" });
  }
  const P = result.periods;
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const p of P)
    for (const l of p.income) {
      if (l.sourceKind === "dividend" || l.sourceKind === "interest") continue;
      if (!first.has(l.sourceId)) first.set(l.sourceId, p.index);
      last.set(l.sourceId, p.index);
      labels.set(l.sourceId, l.label);
    }
  const lastIndex = P.at(-1)?.index ?? 0;
  for (const [id, i] of first)
    if (i > 0)
      out.push({ periodIndex: i, label: `${labels.get(id)} starts`, type: "income-start" });
  for (const [id, i] of last)
    if (i < lastIndex)
      out.push({ periodIndex: i, label: `${labels.get(id)} ends`, type: "income-end" });
  const onceExp = new Map<string, number[]>();
  for (const p of P)
    for (const e of p.expenses)
      if (e.sourceKind === "expense")
        onceExp.set(e.sourceId, [...(onceExp.get(e.sourceId) ?? []), p.index]);
  const once = new Set(
    (plan?.expenses ?? []).filter((e) => e.frequency === "once").map((e) => e.id),
  );
  for (const [id, idx] of onceExp)
    if (once.has(id) || idx.length === 1) {
      const p = P[idx[0]!]!;
      const label = p.expenses.find((e) => e.sourceId === id)?.label ?? id;
      out.push({ periodIndex: p.index, label, type: "expense" });
    }
  const firstShort = P.find((p) => p.status === "shortfall");
  if (firstShort)
    out.push({ periodIndex: firstShort.index, label: "Money runs short", type: "shortfall" });
  const ew = result.warnings.find(
    (w) => w.code === "EARLY_WITHDRAWAL_PENALTY" && w.periodIndex !== null,
  );
  if (ew)
    out.push({
      periodIndex: ew.periodIndex!,
      label: "Penalised early withdrawal",
      type: "early-withdrawal",
    });
  return out.sort((a, b) => a.periodIndex - b.periodIndex);
}

// ---------------------------------------------------------------------------------------------
// Display ranges
// ---------------------------------------------------------------------------------------------

export interface RangePreset {
  id: string;
  label: string;
  start: number;
  end: number;
}

export function rangePresets(result: ProjectionResult): RangePreset[] {
  const n = result.periods.length;
  const last = n - 1;
  const out: RangePreset[] = [{ id: "all", label: "Full plan", start: 0, end: last }];
  for (const y of [10, 20, 30])
    if (y < n) out.push({ id: `next${y}`, label: `Next ${y}y`, start: 0, end: y });
  const retire =
    result.summary.retirementYear !== null
      ? result.periods.findIndex((p) => p.year === result.summary.retirementYear)
      : -1;
  if (retire > 0 && retire < last) {
    out.push({ id: "accumulation", label: "Working years", start: 0, end: retire });
    out.push({ id: "drawdown", label: "Retirement", start: retire, end: last });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Year-by-year table
// ---------------------------------------------------------------------------------------------

export interface ColumnDef {
  id: string;
  label: string;
  group: "Timeline" | "Totals" | "Rates" | "Categories" | "Accounts";
  kind: "money" | "percent" | "age" | "year" | "text";
  /** Money columns: balance at the year end ('stock') or money moved during the year ('flow'). */
  measure?: "stock" | "flow";
  get: (p: PeriodResult) => number | string | null;
  defaultOn?: boolean;
}

export function tableColumns(result: ProjectionResult, index: EntityIndex): ColumnDef[] {
  const cols: ColumnDef[] = [
    {
      id: "year",
      label: "Year",
      group: "Timeline",
      kind: "year",
      get: (p) => p.year,
      defaultOn: true,
    },
    {
      id: "months",
      label: "Months in year",
      group: "Timeline",
      kind: "age",
      get: (p) => p.months,
      // Shown by default when the first or last year is partial, so short years are obvious.
      defaultOn: result.periods.some((p) => p.months < 12),
    },
  ];
  for (const person of index.people)
    cols.push({
      id: `age:${person.id}`,
      label: `${person.name} age`,
      group: "Timeline",
      kind: "age",
      get: (p) => periodAge(p, person.id),
      defaultOn: person.role === "primary",
    });
  const t = (id: keyof PeriodResult["totals"], label: string, on = false): ColumnDef => ({
    id,
    label,
    group: "Totals",
    kind: "money",
    measure: measureOf(id),
    get: (p) => p.totals[id] as number,
    defaultOn: on,
  });
  cols.push(
    t("netWorth", "Net worth", true),
    t("liquidNetWorth", "Liquid net worth"),
    t("assets", "Assets"),
    t("liabilities", "Liabilities"),
    t("portfolio", "Portfolio"),
    t("cash", "Cash"),
    t("realAssets", "Real assets"),
    t("income", "Income", true),
    t("passiveIncome", "Passive income"),
    t("expenses", "Expenses"),
    t("spending", "Spending", true),
    t("taxes", "Taxes", true),
    t("contributions", "Contributions", true),
    t("withdrawals", "Withdrawals", true),
    t("shortfall", "Shortfall"),
    {
      id: "savingsRate",
      label: "Savings rate",
      group: "Rates",
      kind: "percent",
      get: (p) => p.totals.savingsRate,
      defaultOn: true,
    },
    {
      id: "withdrawalRate",
      label: "Withdrawal rate",
      group: "Rates",
      kind: "percent",
      get: (p) => p.totals.withdrawalRate,
    },
    {
      id: "effectiveTax",
      label: "Effective tax rate",
      group: "Rates",
      kind: "percent",
      get: (p) => p.taxes.effectiveRate,
    },
    {
      id: "marginalTax",
      label: "Marginal tax rate",
      group: "Rates",
      kind: "percent",
      get: (p) => p.taxes.marginalRate,
    },
    {
      id: "inflation",
      label: "Inflation",
      group: "Rates",
      kind: "percent",
      get: (p) => p.market.inflation,
    },
    {
      id: "stocks",
      label: "Stock return",
      group: "Rates",
      kind: "percent",
      get: (p) => p.market.stocks,
    },
  );
  for (const cat of CATEGORY_ORDER)
    if (result.periods.some((p) => (p.totals.byCategory[cat] ?? 0) > 0.5))
      cols.push({
        id: `cat:${cat}`,
        label: CATEGORY_LABEL[cat],
        group: "Categories",
        kind: "money",
        measure: "stock",
        get: (p) => p.totals.byCategory[cat] ?? 0,
      });
  const ids = [...new Set(result.periods.flatMap((p) => p.accounts.map((a) => a.accountId)))];
  for (const id of ids)
    cols.push({
      id: `acc:${id}`,
      label: index.accounts.get(id)?.name ?? id,
      group: "Accounts",
      kind: "money",
      measure: "stock",
      get: (p) => p.accounts.find((a) => a.accountId === id)?.closing ?? 0,
    });
  return cols;
}

export function cellValue(
  col: ColumnDef,
  p: PeriodResult,
  basis: ValueBasis,
  view: YearViewOptions = {},
): number | string | null {
  const v = col.get(p);
  return col.kind === "money" && typeof v === "number"
    ? conv(p, v, basis, col.measure ?? "flow", view)
    : v;
}

/** Year cell text for tables: "2026*" marks a partial year (footnoted under the table). */
export const yearCell = (p: PeriodResult): string => periodShortLabel(p);

/** RFC 4180 CSV. Money is rounded to 2 dp with no symbol; percentages as decimals. */
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const esc = (v: string | number | null) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "number" ? String(Math.round(v * 100) / 100) : v;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
}

export function projectionCsv(
  result: ProjectionResult,
  cols: ColumnDef[],
  basis: ValueBasis,
  currency: string,
): string {
  const header = cols.map((c) =>
    c.kind === "money"
      ? `${c.label} (${currency}, ${basis === "real" ? "today's money" : "nominal"})`
      : c.label,
  );
  const rows = result.periods.map((p) =>
    cols.map((c) => {
      const v = cellValue(c, p, basis);
      return c.kind === "percent" && typeof v === "number" ? Math.round(v * 10000) / 10000 : v;
    }),
  );
  return toCsv(header, rows);
}

export function downloadText(filename: string, text: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * A person's age in a period, as people say it: the age they reach during the year (core's
 * `periodAge`), or null when the person is not alive or not modelled in the period.
 */
export function periodAge(p: PeriodResult, personId: string): number | null {
  if (p.alive[personId] === false) return null;
  return corePeriodAge(p, personId);
}

/** Age label for an axis / tooltip ("57" or "57 · 55"). */
export function agesLabel(p: PeriodResult, people: EntityIndex["people"]): string {
  return people
    .map((x) => [x.name, periodAge(p, x.id)] as const)
    .filter(([, age]) => age !== null)
    .map(([name, age]) => `${name} ${age}`)
    .join(" · ");
}

export function retirementIndex(result: ProjectionResult): number | null {
  if (result.summary.retirementYear === null) return null;
  const i = result.periods.findIndex((p) => p.year === result.summary.retirementYear);
  return i < 0 ? null : i;
}

/** Percentage of plan years fully funded. */
export function fundedShare(result: ProjectionResult): number {
  const n = result.periods.length || 1;
  return result.periods.filter((p) => p.status === "ok").length / n;
}
