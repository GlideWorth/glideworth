/**
 * Today's money / future money: the ONE place the web converts engine output (always nominal) to the
 * basis the user picked. Every screen goes through these helpers, which call core's `toBasis` with
 * the right measure (ARCHITECTURE §3):
 *  - flows (income, spending, taxes, contributions, withdrawals, interest...: money that moves
 *    DURING a year) deflate by the start-of-year index, so an amount entered in today's money reads
 *    back exactly as entered in every year;
 *  - stocks (balances at the year end: net worth, account and loan balances) deflate by the
 *    end-of-year index.
 * Never divide by `priceIndex` anywhere else.
 */
import {
  type DeflatablePeriod,
  fromBasis,
  type MoneyMeasure,
  PERIOD_TOTALS_MEASURE,
  type PeriodTotals,
  toBasis,
  type ValueBasis,
} from "@glideworth/core";

export type { MoneyMeasure };

/** Measure of a `PeriodTotals` field (or a series named after one); unknown keys are flows. */
export function measureOf(key: string): MoneyMeasure {
  return (PERIOD_TOTALS_MEASURE as Record<string, MoneyMeasure | null | undefined>)[key] ?? "flow";
}

/** Options for a single year's figures (never for sums over several years). */
export interface YearViewOptions {
  /**
   * Scale the flows of a partial year (the first or last period of a plan, e.g. 5 months) to a full
   * year, so they compare with the years around them. Balances and rates are never scaled.
   */
  annualise?: boolean;
}

/** 12 / months for a partial period whose flows are being annualised, else 1. */
export function annualiseFactor(period: { months?: number }, opts?: YearViewOptions): number {
  const months = period.months ?? 12;
  return opts?.annualise && months > 0 && months < 12 ? 12 / months : 1;
}

/** Convert a nominal amount of `period` to `basis`. `measure`: a MoneyMeasure or a totals key. */
export function conv(
  period: DeflatablePeriod,
  nominal: number,
  basis: ValueBasis,
  measure: MoneyMeasure | (keyof PeriodTotals & string),
  opts?: YearViewOptions,
): number {
  const m: MoneyMeasure = measure === "flow" || measure === "stock" ? measure : measureOf(measure);
  const v = toBasis(nominal, period, basis, m);
  return m === "flow" ? v * annualiseFactor(period, opts) : v;
}

/** Inverse of `conv`: a value shown in `basis` back to nominal. */
export function unconv(
  period: DeflatablePeriod,
  value: number,
  basis: ValueBasis,
  measure: MoneyMeasure | (keyof PeriodTotals & string),
): number {
  const m: MoneyMeasure = measure === "flow" || measure === "stock" ? measure : measureOf(measure);
  return fromBasis(value, period, basis, m);
}

export type MoneyTotalKey =
  | "netWorth"
  | "liquidNetWorth"
  | "assets"
  | "liabilities"
  | "portfolio"
  | "cash"
  | "realAssets"
  | "income"
  | "passiveIncome"
  | "expenses"
  | "spending"
  | "taxes"
  | "contributions"
  | "withdrawals"
  | "shortfall"
  | "savedFromIncome"
  | "afterTaxIncome"
  | "oneOffInflows"
  | "taxFreePensionCash"
  | "externalContributions";

/** A `PeriodTotals` money field of `period` in `basis`, with the field's own measure. */
export function total(
  period: DeflatablePeriod & { totals: PeriodTotals },
  key: MoneyTotalKey,
  basis: ValueBasis,
  opts?: YearViewOptions,
): number {
  return conv(period, period.totals[key] ?? 0, basis, key, opts);
}

/** Deflator for one period and measure (for code that must convert many values at once). */
export function factor(period: DeflatablePeriod, basis: ValueBasis, measure: MoneyMeasure): number {
  return toBasis(1, period, basis, measure);
}

/** Index of the first full (12-month) year of a projection, the year headline figures quote. */
export function firstFullYear(result: { periods: readonly { months: number }[] }): number | null {
  const i = result.periods.findIndex((p) => p.months === 12);
  return i < 0 ? (result.periods.length ? 0 : null) : i;
}
