/** Locale-aware number and date parsing for CSV cells (en-GB, en-US, plus decimal-comma files). */
import type { CsvLocale } from "../types.js";

export type DateFormat = "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY";
export type NumberLocale = CsvLocale | "auto";

export interface NumberOptions {
  locale?: NumberLocale;
  /** Force the decimal separator regardless of locale. */
  decimalSeparator?: "." | ",";
}

const MINUS = /[−‒–]/g;

/**
 * Parse a money/number cell. Accepts currency symbols and codes, thousands separators, spaces,
 * accounting negatives `(1,234.50)`, leading/trailing minus. Returns undefined when unparseable.
 */
export function parseNumber(raw: string, opts: NumberOptions = {}): number | undefined {
  let s = raw
    .replace(MINUS, "-")
    .replace(/[  \s]/g, "")
    .replace(/['’]/g, "");
  if (s === "") return undefined;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s
    .replace(/^[A-Za-z]{3}(?=[-+\d(.,])/, "")
    .replace(/[A-Za-z]{2,3}$/, (m) => (/^(cr|dr)$/i.test(m) ? m : ""));
  let suffixSign: -1 | 1 | 0 = 0;
  const crdr = /(cr|dr)$/i.exec(s);
  if (crdr) {
    suffixSign = crdr[1]!.toLowerCase() === "dr" ? -1 : 1;
    s = s.slice(0, -2);
  }
  s = s.replace(/[£$€¥₹]/g, "").replace(/%$/, "");
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s.startsWith("-") || s === "") return undefined;

  const locale = opts.locale ?? "auto";
  let decimal: "." | ",";
  if (opts.decimalSeparator) decimal = opts.decimalSeparator;
  else if (locale === "en-GB" || locale === "en-US") decimal = ".";
  else decimal = guessDecimal(s);
  const thousands = decimal === "." ? "," : ".";
  // Thousands separators must group digits in threes; otherwise the cell is not a number.
  const parts = s.split(decimal);
  if (parts.length > 2) return undefined;
  const intPart = parts[0] ?? "";
  const frac = parts[1];
  if (intPart.includes(thousands)) {
    if (!new RegExp(`^\\d{1,3}(\\${thousands}\\d{3})+$`).test(intPart)) return undefined;
  } else if (!/^\d*$/.test(intPart)) return undefined;
  if (frac !== undefined && !/^\d+$/.test(frac)) return undefined;
  if (intPart === "" && frac === undefined) return undefined;
  const n = Number(
    `${intPart.split(thousands).join("") || "0"}${frac !== undefined ? `.${frac}` : ""}`,
  );
  if (!Number.isFinite(n)) return undefined;
  const signed = negative ? -n : n;
  return suffixSign === -1 ? -Math.abs(signed) : signed;
}

/** Decimal separator for a cell when the locale is not fixed. */
function guessDecimal(s: string): "." | "," {
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) return lastComma > lastDot ? "," : ".";
  if (lastComma >= 0) {
    // `1,234` / `1,234,567` read as thousands; `12,5` / `0,75` as decimals.
    return /^\d{1,3}(,\d{3})+$/.test(s) ? "." : ",";
  }
  if (lastDot >= 0) {
    return /^\d{1,3}(\.\d{3}){2,}$/.test(s) ? "," : ".";
  }
  return ".";
}

/** Detect decimal separator for a whole column (majority vote over unambiguous cells). */
export function detectDecimalSeparator(values: string[]): "." | "," | undefined {
  let dot = 0;
  let comma = 0;
  for (const v of values) {
    const s = v.replace(/[^\d.,]/g, "");
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    if (lastDot >= 0 && lastComma >= 0) {
      if (lastComma > lastDot) comma += 1;
      else dot += 1;
    } else if (lastComma >= 0 && /,\d{1,2}$/.test(s)) comma += 1;
    else if (lastDot >= 0 && /\.\d{1,2}$/.test(s)) dot += 1;
  }
  if (dot === 0 && comma === 0) return undefined;
  return comma > dot ? "," : ".";
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(y: number, m: number, d: number): string | undefined {
  if (m < 1 || m > 12 || d < 1 || y < 1000 || y > 3000) return undefined;
  if (d > daysIn(y, m)) return undefined;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function fullYear(y: number, digits: number): number {
  if (digits > 2) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

export interface DateOptions {
  /** Interpretation of all-numeric d/m/y dates. `auto` falls back to the locale. */
  format?: DateFormat | "auto";
  locale?: NumberLocale;
}

/** Parse a date cell to `YYYY-MM-DD`. Undefined when unparseable or invalid (e.g. 31/02). */
export function parseDate(raw: string, opts: DateOptions = {}): string | undefined {
  const s = raw.trim();
  if (s === "") return undefined;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s])/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ,]+(\d{2,4})(?:$|[T\s])/.exec(s);
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase()];
    return mon ? iso(fullYear(Number(m[3]), m[3]!.length), mon, Number(m[1])) : undefined;
  }
  m = /^([A-Za-z]{3,9})\.?[ ,-]+(\d{1,2})(?:st|nd|rd|th)?,?[ -]+(\d{2,4})(?:$|[T\s])/.exec(s);
  if (m) {
    const mon = MONTHS[m[1]!.toLowerCase()];
    return mon ? iso(fullYear(Number(m[3]), m[3]!.length), mon, Number(m[2])) : undefined;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:$|[T\s])/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = fullYear(Number(m[3]), m[3]!.length);
    let format = opts.format ?? "auto";
    if (format === "auto" || format === "YYYY-MM-DD")
      format = opts.locale === "en-US" ? "MM/DD/YYYY" : "DD/MM/YYYY";
    return format === "MM/DD/YYYY" ? iso(y, a, b) : iso(y, b, a);
  }
  return undefined;
}

export interface DateFormatDetection {
  format: DateFormat;
  /** True when every all-numeric date was consistent with both day-first and month-first. */
  ambiguous: boolean;
}

/** Choose day-first vs month-first for a column from its values. */
export function detectDateFormat(
  values: string[],
  fallbackLocale: CsvLocale = "en-GB",
): DateFormatDetection {
  let dayFirst = 0;
  let monthFirst = 0;
  let iso8601 = 0;
  let numeric = 0;
  for (const v of values) {
    const s = v.trim();
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(s)) {
      iso8601 += 1;
      continue;
    }
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})/.exec(s);
    if (!m) continue;
    numeric += 1;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dayFirst += 1;
    else if (b > 12 && a <= 12) monthFirst += 1;
  }
  const fallback: DateFormat = fallbackLocale === "en-US" ? "MM/DD/YYYY" : "DD/MM/YYYY";
  if (numeric === 0) return { format: iso8601 > 0 ? "YYYY-MM-DD" : fallback, ambiguous: false };
  if (dayFirst > 0 && monthFirst === 0) return { format: "DD/MM/YYYY", ambiguous: false };
  if (monthFirst > 0 && dayFirst === 0) return { format: "MM/DD/YYYY", ambiguous: false };
  return { format: fallback, ambiguous: dayFirst === 0 && monthFirst === 0 };
}
