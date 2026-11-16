/**
 * Locale- and currency-aware formatting. Never hard-code a currency symbol: everything goes
 * through Intl with the household's currency + locale (overridable in settings).
 */
export interface FormatOptions {
  locale: string;
  currency: string;
}

const cache = new Map<string, Intl.NumberFormat>();

/**
 * User preference (UserSettings.compactNumbers): when off, "compact" requests (1.2M, 340K) render
 * in full instead. Set once by the app shell from the persisted settings.
 */
let compactAllowed = true;
export function setCompactNumbers(on: boolean): void {
  compactAllowed = on;
}
export const compactNumbersEnabled = (): boolean => compactAllowed;
function nf(locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, opts);
    cache.set(key, f);
  }
  return f;
}

export function formatMoney(
  value: number,
  o: FormatOptions & { compact?: boolean; decimals?: number },
): string {
  if (!Number.isFinite(value)) return "–";
  const compact = o.compact && compactAllowed && Math.abs(value) >= 10_000;
  return typographicMinus(
    nf(o.locale, {
      style: "currency",
      currency: o.currency,
      notation: compact ? "compact" : "standard",
      maximumFractionDigits: compact ? (Math.abs(value) >= 1e6 ? 2 : 1) : (o.decimals ?? 0),
      minimumFractionDigits: compact ? 0 : (o.decimals ?? 0),
    }).format(value),
  );
}

/**
 * Display figures use a true minus sign (U+2212), as the hand-built deltas ("−£300") already do,
 * so negatives line up and read the same everywhere. Input fields keep the ASCII hyphen.
 */
function typographicMinus(s: string): string {
  return s.replace(/(?<=^[^\d]*)-/, "−");
}

export function formatPercent(value: number, locale: string, decimals = 1): string {
  if (!Number.isFinite(value)) return "–";
  return typographicMinus(
    nf(locale, {
      style: "percent",
      maximumFractionDigits: decimals,
      minimumFractionDigits: decimals,
    }).format(value),
  );
}

export function formatNumber(value: number, locale: string, decimals = 0): string {
  return nf(locale, { maximumFractionDigits: decimals }).format(value);
}

/** Currency symbol / code for input adornments (e.g. "$", "£", "CA$"). */
export function currencySymbol(o: FormatOptions): string {
  const part = nf(o.locale, { style: "currency", currency: o.currency })
    .formatToParts(0)
    .find((p) => p.type === "currency");
  return part?.value ?? o.currency;
}

/** Parse a user-typed number in the given locale ("1.234,5" in de-DE, "1,234.5" in en-US). */
export function parseLocaleNumber(text: string, locale: string): number | null {
  const parts = nf(locale, { useGrouping: true }).formatToParts(12345.6);
  const group = parts.find((p) => p.type === "group")?.value ?? ",";
  const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";
  const cleaned = text
    .trim()
    .replace(/[^\d\-.,\s  ']/g, "")
    .split(group)
    .join("")
    .replace(/[\s  ']/g, "")
    .replace(decimal, ".");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function formatMonth(month: string, locale: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(y!, m! - 1, 1));
}

/**
 * A signed difference ("+£1,200", "−£300") that never prints "+£0" or "−£0": anything that rounds
 * to nothing is reported as `zero` instead. `fmt` formats the absolute value.
 */
export function formatSigned(d: number, fmt: (abs: number) => string, zero = "no change"): string {
  if (!Number.isFinite(d)) return "–";
  if (Math.abs(d) < 0.5) return zero;
  return `${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}`;
}

/** A calendar date ("2026-11-15") in the user's locale ("15 Nov 2026"). Invalid input is returned as is. */
export function formatDay(date: string, locale: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(y, m - 1, d));
}

/** "1 plan", "3 plans" (pass `many` for irregular plurals). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "3 minutes ago", "yesterday", or a date for anything older than a month. Null = "Never". */
export function relativeTime(iso: string | null, locale: string): string {
  if (!iso) return "Never";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (s < 60) return rtf.format(-Math.round(s), "second");
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  if (s < 86400 * 30) return rtf.format(-Math.round(s / 86400), "day");
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(Date.parse(iso));
}
