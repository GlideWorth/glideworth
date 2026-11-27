/**
 * "Email me this result" on the marketing site's free calculators: the parts the site and the server share.
 * Pure TypeScript (no Node or DOM APIs), exported as `@glideworth/cloud/calculator-email` so the site renders the
 * consent wording from the same constant the server stores with each consent record, and builds the calculator
 * catalog with the same `shapeOf` the server checks against.
 *
 * Nothing the visitor types is echoed into mail. The server accepts:
 *  - an email address (normalised; mail goes only there);
 *  - a calculator id from the catalog;
 *  - the calculator's query string, read field by field against the catalog: numbers inside the field's range,
 *    choices from the field's options. Labels and formatting come from the catalog;
 *  - the result figures the page shows, as label and value pairs. A pair is kept only when both, with every run
 *    of digits replaced by `#` (`shapeOf`), match a shape that calculator is known to produce
 *    (`catalog.generated.ts`, built from the site's engine). So a visitor can choose numbers, never words.
 */
import { CALCULATORS, CURRENCY_LOCALES, VALUE_SHAPES } from "./catalog.generated.js";
import type { CalculatorEntry, CatalogField } from "./catalog-types.js";

export type { Catalog, CalculatorEntry, CatalogField } from "./catalog-types.js";
export { CALCULATORS, CURRENCY_LOCALES, VALUE_SHAPES } from "./catalog.generated.js";

/**
 * The reminder box. The version is stored with every consent record next to the exact words, so a later wording
 * change never rewrites what someone agreed to. Changing the words means a new version here (the old one stays in
 * `CONSENT_TEXTS` so records keep pointing at their wording) and an owner review of the legal pages.
 */
export const CONSENT_VERSION = "calc-updates-1";
export const CONSENT_TEXTS: Readonly<Record<string, string>> = Object.freeze({
  "calc-updates-1":
    "Remind me to re-check this once a year, and send occasional Glideworth updates. I can unsubscribe at any time.",
});
export const CONSENT_TEXT = CONSENT_TEXTS[CONSENT_VERSION] as string;

/** The form's field names (site and server). */
export const FORM_FIELDS = {
  email: "email",
  tool: "tool",
  query: "q",
  figureLabel: "fl",
  figureValue: "fv",
  consent: "updates",
  /** Hidden from people; a bot that fills every field is refused. */
  honeypot: "website",
} as const;

export const LIMITS = {
  queryLength: 2048,
  figures: 8,
  labelLength: 80,
  valueLength: 60,
  /** Days a double opt-in link works. */
  confirmDays: 7,
} as const;

/** Every run of digits (with the grouping and decimal separators inside it) becomes `#`. */
export function shapeOf(s: string): string {
  return s.replace(/\d+(?:[.,'\u2019]\d+)*/g, "#");
}

export type InputValues = Record<string, number | string>;

function isActive(f: CatalogField, values: InputValues): boolean {
  if (!f.showWhen) return true;
  return f.showWhen.values.includes(String(values[f.showWhen.key]));
}

/** Like the site's `parseNumber`, minus the friendliness: plain decimal numbers only. */
function plainNumber(raw: string): number {
  const s = raw.trim();
  if (!/^-?(\d{1,15}(\.\d{1,8})?|\.\d{1,8})$/.test(s)) return Number.NaN;
  return Number(s);
}

/**
 * The calculator's inputs from its query string: every field of the catalog, read and range-checked; a missing
 * or unreadable value takes the field's default (the site's own `fromQuery` behaves the same). Unknown keys are
 * ignored.
 */
export function readInputs(entry: CalculatorEntry, query: string): InputValues {
  const params = new URLSearchParams(query.slice(0, LIMITS.queryLength));
  const out: InputValues = {};
  for (const f of entry.fields) {
    const raw = params.get(f.key);
    out[f.key] = f.default;
    if (raw === null) continue;
    if (f.kind === "number") {
      const n = plainNumber(raw);
      if (Number.isFinite(n) && n >= f.min && n <= f.max && (f.step < 1 || Number.isInteger(n)))
        out[f.key] = n;
    } else if (f.options.some((o) => o.value === raw)) out[f.key] = raw;
  }
  return out;
}

/** Compact number for a URL, as the site writes it. */
function urlNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

/** The query string the calculator page reads back (every field in catalog order, then `v=1`). */
export function toQuery(entry: CalculatorEntry, values: InputValues): string {
  const params = new URLSearchParams();
  for (const f of entry.fields) {
    const v = values[f.key] ?? f.default;
    params.set(f.key, typeof v === "number" ? urlNumber(v) : v);
  }
  params.set("v", "1");
  return params.toString();
}

function formatValue(f: CatalogField, v: number | string, currency: string): string {
  if (f.kind === "select") return f.options.find((o) => o.value === v)?.label ?? String(v);
  const n = Number(v);
  const locale = CURRENCY_LOCALES[currency] ?? "en-US";
  switch (f.unit) {
    case "money":
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        maximumFractionDigits: Number.isInteger(n) ? 0 : 2,
      }).format(n);
    case "percent":
      return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(n)}%`;
    case "seed":
      return String(n);
    default:
      return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(n);
  }
}

/** Label and display value of every input that applies (fields hidden by another choice are left out). */
export function describeInputs(entry: CalculatorEntry, values: InputValues): [string, string][] {
  const currency = typeof values.cur === "string" ? values.cur : (entry.currency ?? "USD");
  return entry.fields
    .filter((f) => isActive(f, values))
    .map((f) => [f.label, formatValue(f, values[f.key] ?? f.default, currency)]);
}

/** The figures whose label and value both have a shape this calculator produces; the rest are dropped. */
export function acceptedFigures(
  entry: CalculatorEntry,
  labels: string[],
  values: string[],
): [string, string][] {
  const out: [string, string][] = [];
  const labelShapes = new Set(entry.labelShapes);
  const valueShapes = new Set(VALUE_SHAPES);
  for (let i = 0; i < Math.min(labels.length, values.length, LIMITS.figures); i++) {
    const label = (labels[i] ?? "").trim();
    const value = (values[i] ?? "").trim();
    if (!label || !value) continue;
    if (label.length > LIMITS.labelLength || value.length > LIMITS.valueLength) continue;
    if (labelShapes.has(shapeOf(label)) && valueShapes.has(shapeOf(value)))
      out.push([label, value]);
  }
  return out;
}

export function calculatorById(id: string): CalculatorEntry | undefined {
  return Object.hasOwn(CALCULATORS, id) ? CALCULATORS[id] : undefined;
}
