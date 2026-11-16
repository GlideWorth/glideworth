/**
 * The ONE place apps/api converts between nominal and today's (real) money.
 *
 * Core exports a single conversion for every layer (`toBasis(value, period, basis, measure)`): balances
 * (`stock`) deflate by the period-end price index, flows (income, spending, taxes, contributions...) by the
 * period-start index, so a figure entered in today's money reads back as entered (QA finding Q1). Nothing else in
 * apps/api calls `toBasis` directly: pass the measure here, or use `totalsMeasure(key)` for a `PeriodTotals`
 * field.
 */
import { type MoneyMeasure, toBasis, totalsMeasure, type ValueBasis } from "@glideworth/core";

export type { MoneyMeasure };

type Deflatable = Parameters<typeof toBasis>[1];

/** Convert a nominal engine amount of `period` into `basis` ('real' = today's money, 'nominal' = as projected). */
export function inBasis(
  value: number,
  period: Deflatable,
  basis: ValueBasis,
  measure: MoneyMeasure = "stock",
): number {
  return toBasis(value, period, basis, measure);
}

/** A `PeriodTotals` field (netWorth: stock; spending, taxes, income: flow) converted with its own measure. */
export function totalInBasis(
  key: string,
  value: number,
  period: Deflatable,
  basis: ValueBasis,
): number {
  return toBasis(value, period, basis, totalsMeasure(key) ?? "stock");
}

/** Shorthand for today's money. */
export const toTodaysMoney = (
  value: number,
  period: Deflatable,
  measure: MoneyMeasure = "stock",
): number => inBasis(value, period, "real", measure);
