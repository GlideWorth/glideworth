/**
 * Number formatting for the calculators. The currency is for display only: no conversion is made,
 * every amount is in whatever currency the visitor thinks in.
 */

export const CURRENCIES = [
  { code: "USD", locale: "en-US", label: "US dollar ($)" },
  { code: "GBP", locale: "en-GB", label: "Pound sterling (£)" },
  { code: "EUR", locale: "en-IE", label: "Euro (€)" },
  { code: "CAD", locale: "en-CA", label: "Canadian dollar ($)" },
  { code: "AUD", locale: "en-AU", label: "Australian dollar ($)" },
  { code: "NZD", locale: "en-NZ", label: "New Zealand dollar ($)" },
  { code: "CHF", locale: "de-CH", label: "Swiss franc (CHF)" },
  { code: "AED", locale: "en-AE", label: "UAE dirham (AED)" },
  { code: "SGD", locale: "en-SG", label: "Singapore dollar ($)" },
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number]["code"];
export const DEFAULT_CURRENCY: CurrencyCode = "USD";

function localeOf(currency: string): string {
  return CURRENCIES.find((c) => c.code === currency)?.locale ?? "en-US";
}

const cache = new Map<string, Intl.NumberFormat>();
function nf(key: string, make: () => Intl.NumberFormat): Intl.NumberFormat {
  let f = cache.get(key);
  if (!f) {
    f = make();
    cache.set(key, f);
  }
  return f;
}

/** Whole currency units: 231,377 shown as "$231,377". Non-finite values show as a dash. */
export function money(value: number, currency: string): string {
  if (!Number.isFinite(value)) return "–";
  const f = nf(
    `m:${currency}`,
    () =>
      new Intl.NumberFormat(localeOf(currency), {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
      }),
  );
  // Avoid "-$0" for tiny negative rounding noise.
  return f.format(Math.abs(value) < 0.5 ? 0 : value);
}

/** Compact money for chart axes: "$1.2M". */
export function moneyCompact(value: number, currency: string): string {
  if (!Number.isFinite(value)) return "–";
  const f = nf(
    `c:${currency}`,
    () =>
      new Intl.NumberFormat(localeOf(currency), {
        style: "currency",
        currency,
        notation: "compact",
        maximumFractionDigits: 1,
      }),
  );
  return f.format(value);
}

/** A plain whole number with grouping: 231,377. */
export function whole(value: number): string {
  if (!Number.isFinite(value)) return "–";
  return nf("w", () => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })).format(value);
}

/** A rate given as a fraction (0.05) shown as "5.0%". */
export function pct(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return "–";
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** A rate given in percent (5) shown as "5%" or "4.5%". */
export function pctInput(percent: number): string {
  return `${Number.isInteger(percent) ? percent : Number(percent.toFixed(2))}%`;
}

/** Years with one decimal: "28.0 years"; one year is "1.0 year". */
export function years(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "never";
  const v = value.toFixed(digits);
  return `${v} ${v === (1).toFixed(digits) ? "year" : "years"}`;
}

/** Whole years: "28 years", "1 year". */
export function wholeYears(value: number): string {
  const n = Math.round(value);
  return `${n} ${n === 1 ? "year" : "years"}`;
}

/** Escapes text for HTML. Every value the calculators insert into markup goes through this. */
export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The currency's symbol as the locale writes it ("$", "£", "€", "CHF"). */
export function currencySymbol(currency: string): string {
  try {
    return (
      new Intl.NumberFormat(localeOf(currency), { style: "currency", currency })
        .formatToParts(0)
        .find((p) => p.type === "currency")?.value ?? currency
    );
  } catch {
    return currency;
  }
}

/** How a number field's value is written back into its input: grouped money, plain otherwise. */
export function inputText(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "";
  if (unit === "money") return whole(value);
  return String(Number.isInteger(value) ? value : Number(value.toFixed(4)));
}
