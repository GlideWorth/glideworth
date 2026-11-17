/** Small formatting helpers for the hosted-mode screens (dates, trial countdown, prices). */

const DAY = 86_400_000;

/**
 * Whole days from `now` until `iso`, rounded down, as Stripe Checkout counts a trial ("29 days free" for a trial
 * that ends in 29 days and 23 hours); 0 when less than a day is left or it is past.
 */
export function daysLeft(iso: string | null | undefined, now: Date = new Date()): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((t - now.getTime()) / DAY));
}

/** "12 days", "1 day", or "less than a day" (for a count from `daysLeft`). */
export const daysText = (days: number): string =>
  days <= 0 ? "less than a day" : days === 1 ? "1 day" : `${days} days`;

export function fmtDate(iso: string | null | undefined, locale?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? "" : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(t);
}

export function fmtDateTime(iso: string | null | undefined, locale?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t)
    ? ""
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(t);
}

/** `unitAmount` is in minor units (cents, pence); zero-decimal currencies are handled by Intl. */
export function fmtPrice(unitAmount: number, currency: string, locale?: string): string {
  const code = currency.toUpperCase();
  try {
    const f = new Intl.NumberFormat(locale, { style: "currency", currency: code });
    const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: Number.isInteger(unitAmount / 10 ** digits) ? 0 : digits,
    }).format(unitAmount / 10 ** digits);
  } catch {
    return `${(unitAmount / 100).toFixed(2)} ${code}`;
  }
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
