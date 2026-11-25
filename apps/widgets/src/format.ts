/** Number formatting with the plan currency and the host locale. */

type FigureFormat = "money" | "year" | "percent" | "month" | "number";

export interface Formatter {
  locale: string;
  currency: string;
  /** Whole units: $1,234,567. */
  money(value: number): string;
  /** Signed whole units: +$12,000 / −$8,000. */
  signedMoney(value: number): string;
  /** Short, for chart axes and tight chips: $1.2M. */
  compact(value: number): string;
  /** A share 0..1 as a percentage: 0.873 → 87%. */
  percent(value: number, digits?: number): string;
  year(value: number): string;
  /** "YYYY-MM" → "Jun 2031". */
  month(value: string): string;
  number(value: number): string;
  figure(value: number | string, format: FigureFormat): string;
}

const cache = new Map<string, Formatter>();

function safeLocale(locale: string | undefined): string {
  if (!locale) return "en-US";
  try {
    return Intl.NumberFormat.supportedLocalesOf([locale]).length ? locale : "en-US";
  } catch {
    return "en-US";
  }
}

function safeCurrency(currency: string): string {
  try {
    return (
      new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().currency ??
      "USD"
    );
  } catch {
    return "USD";
  }
}

export function createFormatter(localeIn: string | undefined, currencyIn: string): Formatter {
  const locale = safeLocale(localeIn);
  const currency = safeCurrency(currencyIn || "USD");
  const key = `${locale}|${currency}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const whole = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  });
  const compactFmt = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  });
  // Thousands without a decimal ($514K); millions keep one ($1.2M).
  const compactWhole = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 0,
  });
  const plain = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const yearFmt = new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 0 });
  const monthFmt = new Intl.DateTimeFormat(locale, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

  const fmt: Formatter = {
    locale,
    currency,
    money: (value) => whole.format(Math.round(value) === 0 ? 0 : value),
    signedMoney: (value) => {
      const rounded = Math.round(value);
      if (rounded === 0) return whole.format(0);
      return `${rounded > 0 ? "+" : "−"}${whole.format(Math.abs(value))}`;
    },
    compact: (value) =>
      Math.abs(value) < 0.5
        ? whole.format(0)
        : (Math.abs(value) < 999_500 ? compactWhole : compactFmt).format(value),
    percent: (value, digits) => {
      const pct = value * 100;
      const d = digits ?? (Math.abs(pct - Math.round(pct)) < 0.05 ? 0 : 1);
      return `${new Intl.NumberFormat(locale, {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      }).format(pct)}%`;
    },
    year: (value) => yearFmt.format(value),
    month: (value) => {
      const match = /^(\d{4})-(\d{2})/.exec(value);
      if (!match) return value;
      return monthFmt.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
    },
    number: (value) => plain.format(value),
    figure: (value, format) => {
      if (typeof value === "string") return format === "month" ? fmt.month(value) : value;
      switch (format) {
        case "money":
          return fmt.money(value);
        case "year":
          return fmt.year(value);
        case "percent":
          return fmt.percent(value);
        default:
          return fmt.number(value);
      }
    },
  };
  cache.set(key, fmt);
  return fmt;
}
