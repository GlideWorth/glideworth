/**
 * Partial plan years. A plan starts in the month its balances are dated and ends at its horizon, so
 * the first and last periods usually cover fewer than 12 months (e.g. August to December). Their
 * income, spending and taxes are for those months only and look low beside full years. Every place
 * that shows one year's figures labels such a year with these helpers, and can show it annualised.
 */
import type { MonthDate } from "@glideworth/core";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface PeriodLike {
  year: number;
  startMonth: MonthDate | string;
  months: number;
}

export const isPartialPeriod = (p: { months: number }): boolean => p.months > 0 && p.months < 12;

/** "Aug–Dec" (or "Aug" for a one-month period). */
export function periodSpan(p: PeriodLike): string {
  const start = Number(String(p.startMonth).slice(5, 7)) - 1;
  const end = (start + p.months - 1) % 12;
  const a = MONTHS[start] ?? "";
  return p.months <= 1 ? a : `${a}–${MONTHS[end] ?? ""}`;
}

/** "2026", or "2026 (Aug–Dec, 5 months)" / "2026 (5 months, annualised)" for a partial year. */
export function periodLabel(p: PeriodLike, opts: { annualise?: boolean } = {}): string {
  if (!isPartialPeriod(p)) return String(p.year);
  return opts.annualise
    ? `${p.year} (${p.months} months, annualised)`
    : `${p.year} (${periodSpan(p)}, ${p.months} ${p.months === 1 ? "month" : "months"})`;
}

/** Short axis/table marker: "2026*" for a partial year. */
export const periodShortLabel = (p: PeriodLike): string =>
  isPartialPeriod(p) ? `${p.year}*` : String(p.year);

/** One sentence explaining a partial year's figures, or null for a full year. */
export function partialNote(p: PeriodLike, opts: { annualise?: boolean } = {}): string | null {
  if (!isPartialPeriod(p)) return null;
  const n = `${p.months} ${p.months === 1 ? "month" : "months"}`;
  return opts.annualise
    ? `${p.year} covers only ${n} of the plan (${periodSpan(p)}); its income, spending and taxes are scaled up to a full year. Balances are as at the end of ${periodSpan(p).split("–").pop()}.`
    : `${p.year} covers only ${n} of the plan (${periodSpan(p)}), so its income, spending and taxes are for those months, not a full year.`;
}

/** Whether a projection has any partial year (to decide whether to offer the annualised view). */
export const hasPartialPeriods = (periods: readonly { months: number }[]): boolean =>
  periods.some(isPartialPeriod);
