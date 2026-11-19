/**
 * Analytics data for visualisations the web draws:
 *  - `strategyMetricsMatrix`: tax / drawdown strategies x outcome metrics (lifetime tax, net
 *    legacy, chance of success, final net worth) with per-metric 0..1 scores for a heatmap.
 *  - `incomeByTaxRate`: per year, how much income fell in each tax-rate band (heatmap).
 *  - `netLegacyAtEnd`: net legacy (after estate tax, heirs' tax and costs) of a projection's year.
 * Pure functions; money is reported in today's money unless a field says nominal.
 */
import { simulate as coreSimulate } from "../engine/simulate.js";
import {
  type PeriodResult,
  type ProjectionResult,
  type SimulationInput,
  toBasis,
} from "../engine/types.js";
import { isNotImplemented, ScenarioError } from "../errors.js";
import { ACCOUNT_TYPE_INFO } from "../schema/account-types.js";
import type { ValueBasis } from "../schema/primitives.js";
import type { SolverDeps } from "../solvers/contracts.js";
import { checkAbort, isAbortError, makeMetric } from "../solvers/search.js";
import {
  bracketFillCandidates,
  drawdownOrderCandidates,
  isUkPlan,
  type StrategyCandidate,
  ukDrawdownCandidates,
} from "../solvers/tax-strategy.js";
import { UK_TAX_YEARS } from "../tax/data/uk.js";
import { estimateNetLegacy, estimateUkInheritanceTax, estimateUsEstateTax } from "../tax/estate.js";
import { applyPlanPatch } from "./patch.js";

// ------------------------------------------------------------------------------- net legacy

export interface NetLegacy {
  year: number;
  /** Assets less debts (nominal). */
  estate: number;
  estateTax: number;
  netLegacy: number;
  /** `netLegacy` in today's money (end-of-year index). */
  netLegacyReal: number;
}

/**
 * Net legacy if the last surviving person died at the end of period `index` (default: the last):
 * UK Inheritance Tax or US federal estate tax by household country, heirs' income tax on pensions,
 * embedded gains, selling and admin costs (plan `tax.estate` settings). Mirrors the web estate tab.
 */
export function netLegacyAtEnd(
  input: SimulationInput,
  result: ProjectionResult,
  opts: { index?: number; transferAllowances?: boolean } = {},
): NetLegacy {
  const p = result.periods[opts.index ?? result.periods.length - 1];
  if (!p) throw new ScenarioError("projection has no periods", {});
  if (p.accounts.length === 0 && p.totals.portfolio + p.totals.cash !== 0)
    throw new ScenarioError("netLegacyAtEnd needs a full (non-lean) projection", {});
  const sc = input.plan.startingConditions;
  const fin = sc.kind === "snapshot" ? sc.finances : input.finances;
  const defs = new Map([...fin.accounts, ...input.plan.plannedAccounts].map((a) => [a.id, a]));
  let cash = 0;
  let taxFree = 0;
  let taxable = 0;
  let taxableBasis = 0;
  let taxDeferred = 0;
  let ukPensions = 0;
  for (const a of p.accounts) {
    const def = defs.get(a.accountId);
    const t = def ? ACCOUNT_TYPE_INFO[def.type].taxTreatment : "cash";
    if (t === "tax-deferred") {
      taxDeferred += a.closing;
      if (def?.type.startsWith("uk-")) ukPensions += a.closing;
    } else if (t === "tax-free") taxFree += a.closing;
    else if (t === "taxable") {
      taxable += a.closing;
      taxableBasis += a.costBasis ?? a.closing;
    } else cash += a.closing;
  }
  const realEstate = p.totals.realAssets;
  const debts = p.totals.liabilities;
  const estate = taxDeferred + taxable + taxFree + cash + realEstate - debts;
  const homes = new Set(
    fin.realAssets
      .filter(
        (r) =>
          (input.plan.realAssetSettings[r.id]?.usage ?? r.behaviour.usage) === "primary-residence",
      )
      .map((r) => r.id),
  );
  const home = p.realAssets
    .filter((r) => r.owned && homes.has(r.assetId))
    .reduce((s, r) => s + Math.max(0, r.equity), 0);
  const settings = input.plan.tax.estate;
  const country = input.household.location.country;
  let estateTax = 0;
  if (country === "GB") {
    const last = UK_TAX_YEARS[UK_TAX_YEARS.length - 1];
    const frozen = last?.iht.frozenThrough;
    const freeze =
      frozen === undefined
        ? undefined
        : [...result.periods].reverse().find((x) => x.year <= frozen);
    estateTax = estimateUkInheritanceTax({
      year: p.year,
      netEstate: Math.max(0, estate - ukPensions),
      homeToDescendants: home,
      pensions: ukPensions,
      priceIndex: p.priceIndex,
      charityShare: settings.charitableShare,
      ...(opts.transferAllowances ? { transferredNrbShare: 1, transferredRnrbShare: 1 } : {}),
      ...(freeze ? { freezeEndPriceIndex: freeze.priceIndex } : {}),
    }).tax;
  } else if (country === "US") {
    estateTax = estimateUsEstateTax({
      year: p.year,
      grossEstate: Math.max(0, estate),
      toCharity: Math.max(0, estate) * settings.charitableShare,
      priceIndex: p.priceIndex,
      ...(opts.transferAllowances
        ? {
            dsue: estimateUsEstateTax({ year: p.year, grossEstate: 0, priceIndex: p.priceIndex })
              .exclusion,
          }
        : {}),
    }).tax;
  }
  const net = estimateNetLegacy({
    taxDeferred,
    taxable,
    taxableCostBasis: taxableBasis,
    taxFree,
    cash,
    realEstate,
    otherAssets: 0,
    debts,
    estateTax,
    settings,
  });
  return {
    year: p.year,
    estate: net.legacy,
    estateTax,
    netLegacy: net.netLegacy,
    netLegacyReal: toBasis(net.netLegacy, p, "real", "stock"),
  };
}

// --------------------------------------------------------------- strategies x metrics matrix

export type StrategyMetricId =
  | "lifetimeTaxesReal"
  | "netLegacyReal"
  | "successRate"
  | "endNetWorthReal";

export interface StrategyMetricColumn {
  id: StrategyMetricId;
  label: string;
  /** Which direction is better (the heatmap colours 'better' cells greener). */
  better: "lower" | "higher";
  unit: "money" | "share";
}

export interface StrategyMatrixRow {
  id: string;
  label: string;
  description: string;
  status: "ok" | "unsupported" | "error";
  /** One value per column (null: not computed or the run failed). */
  values: (number | null)[];
  /** Per column: 0 = worst row, 1 = best row (null when the value is null or all rows are equal). */
  scores: (number | null)[];
  /** Per column: value minus the baseline's value (null when either is missing). */
  deltas: (number | null)[];
  error?: string;
}

export interface StrategyMetricsMatrix {
  columns: StrategyMetricColumn[];
  rows: StrategyMatrixRow[];
  /** Per column: id of the best row. */
  best: (string | null)[];
}

export const STRATEGY_METRIC_COLUMNS: readonly StrategyMetricColumn[] = [
  { id: "lifetimeTaxesReal", label: "Lifetime tax", better: "lower", unit: "money" },
  { id: "netLegacyReal", label: "Net legacy", better: "higher", unit: "money" },
  { id: "successRate", label: "Chance of success", better: "higher", unit: "share" },
  { id: "endNetWorthReal", label: "Final net worth", better: "higher", unit: "money" },
];

/** The candidates `optimiseTaxStrategy` would rank for this plan (UK, US or generic orders). */
export function defaultStrategyCandidates(input: SimulationInput): StrategyCandidate[] {
  if (isUkPlan(input)) return ukDrawdownCandidates(input);
  if (input.household.location.country === "US")
    return [...drawdownOrderCandidates(input), ...bracketFillCandidates(input)];
  return drawdownOrderCandidates(input);
}

/**
 * Evaluate the baseline plus each strategy on every metric. Deterministic metrics come from one
 * engine run per strategy; the chance of success runs Monte Carlo on shared paths (fixed seed) when
 * `successRate` is true (default) - pass false to skip it (the column is then null).
 */
export async function strategyMetricsMatrix(
  input: SimulationInput,
  candidates: StrategyCandidate[] = defaultStrategyCandidates(input),
  opts: { successRate?: boolean; transferAllowances?: boolean } = {},
  deps: SolverDeps = {},
): Promise<StrategyMetricsMatrix> {
  const sim = deps.simulate ?? ((i: SimulationInput) => coreSimulate(i));
  const mc =
    opts.successRate === false ? null : makeMetric(input, { kind: "successRate", target: 0 }, deps);
  const columns = [...STRATEGY_METRIC_COLUMNS];
  const all: StrategyCandidate[] = [
    { id: "baseline", label: "Current plan", description: "The plan as it stands.", patch: [] },
    ...candidates,
  ];
  const rows: StrategyMatrixRow[] = [];
  for (const c of all) {
    checkAbort(deps.signal);
    const empty = (): (number | null)[] => columns.map(() => null);
    try {
      const plan = applyPlanPatch(input.plan, c.patch);
      const candidate = { ...input, plan };
      const r = sim({ ...candidate, options: { ...input.options, trace: "off", lean: false } });
      const legacy = netLegacyAtEnd(candidate, r, {
        transferAllowances: opts.transferAllowances ?? input.household.people.length > 1,
      });
      const success = mc ? await mc.score(candidate) : null;
      const byId: Record<StrategyMetricId, number | null> = {
        lifetimeTaxesReal: r.summary.lifetimeTaxesReal,
        netLegacyReal: legacy.netLegacyReal,
        successRate: success,
        endNetWorthReal: r.summary.endNetWorthReal,
      };
      rows.push({
        id: c.id,
        label: c.label,
        description: c.description,
        status: "ok",
        values: columns.map((col) => byId[col.id]),
        scores: empty(),
        deltas: empty(),
      });
    } catch (e) {
      if (isAbortError(e)) throw e;
      rows.push({
        id: c.id,
        label: c.label,
        description: c.description,
        status: isNotImplemented(e) ? "unsupported" : "error",
        values: empty(),
        scores: empty(),
        deltas: empty(),
        error: (e as Error).message,
      });
    }
  }
  const best: (string | null)[] = columns.map((col, j) => {
    const vals = rows.map((r) => r.values[j]).filter((v): v is number => v !== null);
    if (vals.length === 0) return null;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    for (const r of rows) {
      const v = r.values[j] ?? null;
      const base = rows[0]!.values[j] ?? null;
      r.scores[j] =
        v === null || hi - lo < 1e-9
          ? null
          : col.better === "higher"
            ? (v - lo) / (hi - lo)
            : (hi - v) / (hi - lo);
      r.deltas[j] = v === null || base === null ? null : v - base;
    }
    const target = col.better === "higher" ? hi : lo;
    return rows.find((r) => r.values[j] === target)?.id ?? null;
  });
  return { columns, rows, best };
}

// ------------------------------------------------------------------- income by tax rate

export interface IncomeByRateColumn {
  /** Marginal rate of the band (decimal). */
  rate: number;
  /** Band names that share this rate (e.g. "Basic", "Starting rate / PSA"). */
  labels: string[];
}

export interface IncomeByTaxRateMatrix {
  jurisdictionId: string;
  basis: ValueBasis;
  years: number[];
  /** Columns sorted by rate; the first column (rate 0) includes income below any band (allowances). */
  columns: IncomeByRateColumn[];
  /** cells[yearIndex][columnIndex]: income taxed at that rate in that year. */
  cells: number[][];
  /** Per year: the same split per schedule (non-savings, savings, dividends, capital gains...). */
  detail: { year: number; schedule: string; rate: number; label: string; amount: number }[];
}

/**
 * How much income fell in each tax-rate band each year. Needs a projection run with
 * `options.trace: 'full'` (the bracket fill); use `incomeByTaxRateForInput` to run one.
 * `jurisdictionId` defaults to the first jurisdiction with brackets (the national one); people
 * and schedules are summed per rate. Income below every band (personal allowance, standard
 * deduction) is reported at 0% as gross income minus banded income.
 */
export function incomeByTaxRate(
  result: ProjectionResult,
  opts: { jurisdictionId?: string; basis?: ValueBasis; schedules?: string[] } = {},
): IncomeByTaxRateMatrix {
  const withBrackets = result.periods.filter((p) => p.taxes.brackets !== undefined);
  if (result.periods.length > 0 && withBrackets.length === 0)
    throw new ScenarioError("incomeByTaxRate needs a projection run with options.trace 'full'", {});
  const basis = opts.basis ?? "real";
  const jurisdictionId =
    opts.jurisdictionId ??
    result.periods.flatMap((p) => p.taxes.brackets ?? []).find((b) => b.bands.length > 0)
      ?.jurisdictionId ??
    "";
  const key = (r: number) => Math.round(r * 10_000) / 10_000;
  const cols = new Map<number, Set<string>>([[0, new Set()]]);
  const detail: IncomeByTaxRateMatrix["detail"] = [];
  const perYear: Map<number, number>[] = [];
  const conv = (v: number, p: PeriodResult) => toBasis(v, p, basis, "flow");
  for (const p of result.periods) {
    const m = new Map<number, number>();
    let banded = 0;
    for (const b of p.taxes.brackets ?? []) {
      if (b.jurisdictionId !== jurisdictionId) continue;
      if (opts.schedules && !opts.schedules.includes(b.schedule)) continue;
      for (const band of b.bands) {
        if (!(band.amount > 0)) continue;
        const r = key(band.rate);
        if (!cols.has(r)) cols.set(r, new Set());
        cols.get(r)!.add(band.label);
        const v = conv(band.amount, p);
        m.set(r, (m.get(r) ?? 0) + v);
        banded += v;
        detail.push({ year: p.year, schedule: b.schedule, rate: r, label: band.label, amount: v });
      }
    }
    if (!opts.schedules) {
      const untaxed = Math.max(0, conv(p.taxes.grossIncome, p) - banded);
      if (untaxed > 0.005) {
        m.set(0, (m.get(0) ?? 0) + untaxed);
        cols.get(0)!.add("Allowances and deductions");
      }
    }
    perYear.push(m);
  }
  const rates = [...cols.keys()].sort((a, b) => a - b);
  return {
    jurisdictionId,
    basis,
    years: result.periods.map((p) => p.year),
    columns: rates.map((rate) => ({ rate, labels: [...cols.get(rate)!] })),
    cells: perYear.map((m) => rates.map((r) => m.get(r) ?? 0)),
    detail,
  };
}

/** Run the plan with the bracket fill (trace 'full') and build `incomeByTaxRate`. */
export function incomeByTaxRateForInput(
  input: SimulationInput,
  opts: { jurisdictionId?: string; basis?: ValueBasis; schedules?: string[] } = {},
  deps: Pick<SolverDeps, "simulate"> = {},
): IncomeByTaxRateMatrix {
  const sim = deps.simulate ?? ((i: SimulationInput) => coreSimulate(i));
  return incomeByTaxRate(
    sim({ ...input, options: { ...input.options, trace: "full", lean: false } }),
    opts,
  );
}
