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

/**
 * "Hide amounts" (privacy mode for screen sharing and screenshots). While on, every money amount
 * the app formats is replaced by the currency symbol and a fixed run of dots ("$•••••"), so neither
 * the value, its sign nor its magnitude (digit count) shows. Percentages, rates, ages, years, dates
 * and counts are not money and stay visible.
 *
 * Masking happens here, in the one money formatter, so every screen gets it without opting in. The
 * flag mirrors the per-device `hideAmounts` preference (stores/ui.ts sets it synchronously, before
 * React re-renders). Exports and downloads never format money through here: they write raw numbers.
 * Anything that must always show the real figure (a format preview) passes `reveal: true`.
 */
let hidden = false;
export function setAmountsHidden(on: boolean): void {
  hidden = on;
}
export const amountsHidden = (): boolean => hidden;

/** What replaces the digits of a hidden amount: always five dots, whatever the magnitude. */
export const AMOUNT_MASK = "•••••";
/** Screen readers hear this instead of "bullet bullet bullet…". */
export const AMOUNT_MASK_SPOKEN = "amount hidden";

/**
 * A hidden amount in the given currency and locale: the symbol where the locale puts it, then the
 * mask ("$•••••", "••••• €", "CHF •••••"). No sign, grouping or decimals, so the width is fixed.
 */
export function maskedMoney(o: FormatOptions): string {
  let out = "";
  let masked = false;
  for (const p of nf(o.locale, { style: "currency", currency: o.currency }).formatToParts(1)) {
    if (p.type === "currency" || p.type === "literal") out += p.value;
    else if (
      p.type === "integer" ||
      p.type === "group" ||
      p.type === "decimal" ||
      p.type === "fraction"
    ) {
      if (!masked) out += AMOUNT_MASK;
      masked = true;
    }
  }
  return out.trim();
}
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
  o: FormatOptions & { compact?: boolean; decimals?: number; reveal?: boolean },
): string {
  if (!Number.isFinite(value)) return "–";
  if (hidden && !o.reveal) return maskedMoney(o);
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

/**
 * Money inside prose the app did not format itself (insight and audit sentences from core, plan
 * diffs, notifications, toasts): while amounts are hidden, every figure written next to a currency
 * symbol or ISO code ("$1,200", "−£3.4k", "1.234 €", "CHF 950", "A$2m") becomes the mask, keeping
 * the symbol. Bare numbers (years, ages, counts, percentages) are left alone. Returns the text
 * unchanged when amounts are shown.
 */
export function maskAmountsInText(text: string): string {
  if (!hidden || !text) return text;
  return text
    .replace(SYMBOL_FIRST, (m, sym: string, gap: string) =>
      isCurrency(sym) ? `${sym}${gap}${AMOUNT_MASK}` : m,
    )
    .replace(NUMBER_FIRST, (m, gap: string, sym: string) =>
      isCurrency(sym) ? `${AMOUNT_MASK}${gap}${sym}` : m,
    );
}

/** A grouped or plain number with optional decimals and an optional compact suffix (k, M, bn, Mio.). */
const NUM = String.raw`\d{1,3}(?:[,.  ' ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const SUFFIX = String.raw`(?:[  ]?(?:bn|mn|Mio\.|Mrd\.|[kKmMBT])(?![\p{L}\d]))?`;
/** A currency symbol (with an optional country prefix: CA$, A$, NZ$, R$), a letter symbol or an ISO code. */
const SYM = String.raw`[A-Z]{0,3}\p{Sc}|\b[A-Z]{3}\b|kr|zł|Kč|Ft`;
const SYMBOL_FIRST = new RegExp(
  String.raw`[-−+]?(?<![\p{L}\d])(${SYM})([   ]?)[-−+]?(?:${NUM})${SUFFIX}`,
  "gu",
);
const NUMBER_FIRST = new RegExp(
  String.raw`[-−+]?(?<![\p{L}\d.,])(?:${NUM})${SUFFIX}([   ]?)(${SYM})(?![\p{L}])`,
  "gu",
);
let isoCodes: Set<string> | null = null;
/** A symbol, or a three-letter code only when it is a real ISO 4217 currency (not "ISA", "RMD"). */
function isCurrency(sym: string): boolean {
  if (!/^[A-Z]{3}$/.test(sym)) return true;
  isoCodes ??= new Set(
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : [],
  );
  return isoCodes.has(sym);
}

/**
 * The text a screen reader should hear for a string that may hold hidden amounts: each masked amount
 * (with its symbol and any sign or bracket stuck to it) is read as "amount hidden", not as dots.
 */
export function speakAmounts(text: string): string {
  return text.includes(AMOUNT_MASK) ? text.replace(SPOKEN, AMOUNT_MASK_SPOKEN) : text;
}
const SPOKEN = /(?:\S+[\u00a0\u202f])?\S*•••••(?:[\u00a0\u202f][^\s)\]]+)?[)\]]*/gu;

/**
 * Parse a user-typed number in the given locale ("1.234,5" in de-DE, "1,234.5" in en-US).
 * Scientific notation is a real number (`1e9` is 1,000,000,000). Letters that are not a currency
 * symbol, code or exponent are rejected: stripping them used to turn `1e9` into 19.
 */
export function parseLocaleNumber(text: string, locale: string): number | null {
  const parts = nf(locale, { useGrouping: true }).formatToParts(12345.6);
  const group = parts.find((p) => p.type === "group")?.value ?? ",";
  const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";
  let s = text.trim().replace(/[\u2212\u2013\u2014]/g, "-");
  if (s === "") return null;
  // A prefix such as "CA" sits on the symbol ("CA$"). Drop it with the symbol, not as a number.
  s = s.replace(/[A-Za-z]{1,3}(?=\p{Sc})/gu, "");
  s = s.replace(/\p{Sc}/gu, " ");
  s = s.replace(/\b(?:kr|zł|Kč|Ft)\b/gi, " ");
  let strayWord = false;
  s = s.replace(/\b[A-Za-z]{3}\b/g, (word) => {
    if (isCurrency(word.toUpperCase())) return " ";
    strayWord = true;
    return word;
  });
  if (strayWord) return null;
  // An exponent marker is the only letter a number may still contain.
  if (/[A-Za-z]/.test(s.replace(/[eE](?=[+-]?\d)/g, ""))) return null;
  s = s.replace(/[\s\u00a0\u202f]+/g, " ").trim();
  if (s === "" || s === "-" || s === "+") return null;
  const groups = [...new Set([group, " ", "\u00a0", "\u202f", "'", "’"])].filter(
    (c) => c !== decimal && c !== "",
  );
  const groupClass = escapeRxClass(groups);
  const decimalRx = escapeRxClass([decimal]);
  const pattern = new RegExp(
    `^[+-]?(?:\\d{1,3}(?:[${groupClass}]\\d{3})+|\\d+)(?:${decimalRx}\\d*)?(?:[eE][+-]?\\d+)?$|^[+-]?${decimalRx}\\d+(?:[eE][+-]?\\d+)?$`,
  );
  if (!pattern.test(s)) return null;
  const normalized = [...s]
    .filter((c) => !groups.includes(c))
    .join("")
    .replace(decimal, ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function escapeRxClass(chars: readonly string[]): string {
  return chars.map((c) => c.replace(/[\\\]^-]/g, "\\$&")).join("");
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
  if (hidden) {
    // A hidden difference shows neither its direction nor whether it is zero.
    const masked = fmt(Math.abs(d));
    if (masked.includes(AMOUNT_MASK)) return masked;
  }
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
