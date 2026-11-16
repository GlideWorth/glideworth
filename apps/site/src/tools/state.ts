/**
 * Calculator state: defaults, validation and the URL query string. The same keys are used in the page
 * URL (so results can be shared and reopened) and in the hand-off link to the full planner (carry.ts);
 * the format is documented in README.md. Nothing here touches the network or storage.
 */
import { CURRENCIES } from "./format";
import type { Field, NumberField, SelectField, ToolSpec, Values } from "./types";

/** Version of the query format. Bump it only with a migration for old links. */
export const STATE_VERSION = 1;

export function defaults(spec: ToolSpec): Values {
  const out: Values = {};
  for (const f of spec.fields) out[f.key] = f.default;
  return out;
}

/** True when the field applies under the current values (fields hidden by `showWhen` are ignored). */
export function isActive(field: Field, values: Values): boolean {
  if (!field.showWhen) return true;
  return field.showWhen.values.includes(String(values[field.showWhen.key]));
}

/**
 * Reads a number typed by a person: "1,000,000", "$ 40 000", "4.5%", "−3" are all accepted.
 * Returns NaN for anything else (including an empty string).
 */
export function parseNumber(raw: string): number {
  const cleaned = raw
    .trim()
    .replace(/[−‒–]/g, "-")
    .replace(/[\s,_'  ]/g, "")
    .replace(/^[^\d.+-]+/, "")
    .replace(/%$/, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(cleaned)) return Number.NaN;
  return Number(cleaned);
}

function numberError(f: NumberField, v: number): string | null {
  if (!Number.isFinite(v)) return `Enter a number for ${f.label.toLowerCase()}.`;
  const unit = f.unit === "percent" ? "%" : "";
  if (v < f.min) return `${f.label} must be at least ${f.min.toLocaleString("en-US")}${unit}.`;
  if (v > f.max) return `${f.label} can be at most ${f.max.toLocaleString("en-US")}${unit}.`;
  if (f.step >= 1 && !Number.isInteger(v)) return `${f.label} must be a whole number.`;
  return null;
}

function selectError(f: SelectField, v: string): string | null {
  return f.options.some((o) => o.value === v)
    ? null
    : `Choose one of the options for ${f.label.toLowerCase()}.`;
}

/** Field-level and cross-field messages, keyed by field. Empty when the values can be calculated. */
export function validate(spec: ToolSpec, values: Values): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of spec.fields) {
    if (!isActive(f, values)) continue;
    const v = values[f.key];
    const msg =
      f.kind === "number"
        ? numberError(f, typeof v === "number" ? v : Number.NaN)
        : selectError(f, typeof v === "string" ? v : "");
    if (msg) errors[f.key] = msg;
  }
  if (Object.keys(errors).length === 0 && spec.validate)
    Object.assign(errors, spec.validate(values));
  return errors;
}

/**
 * Values from a query string. Unknown keys are ignored; a missing or unreadable key falls back to its
 * default and is reported, so a damaged link still opens. `present` says whether any field was given.
 */
export function fromQuery(
  spec: ToolSpec,
  search: string,
): { values: Values; present: boolean; invalid: string[] } {
  const params = new URLSearchParams(search);
  const values = defaults(spec);
  const invalid: string[] = [];
  let present = false;
  for (const f of spec.fields) {
    const raw = params.get(f.key);
    if (raw === null) continue;
    present = true;
    if (f.kind === "number") {
      const n = parseNumber(raw);
      if (numberError(f, n) === null) values[f.key] = n;
      else invalid.push(f.key);
    } else if (selectError(f, raw) === null) values[f.key] = raw;
    else invalid.push(f.key);
  }
  return { values, present, invalid };
}

/** Compact number for a URL: no exponent, no trailing zeros. */
function urlNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

/** Query string for the values (every field, in spec order, then `v`). No leading "?". */
export function toQuery(spec: ToolSpec, values: Values): string {
  const params = new URLSearchParams();
  for (const f of spec.fields) {
    const v = values[f.key] ?? f.default;
    params.set(f.key, typeof v === "number" ? urlNumber(v) : v);
  }
  params.set("v", String(STATE_VERSION));
  return params.toString();
}

// ------------------------------------------------------------------- typed accessors for the engine side

export function num(values: Values, key: string): number {
  const v = values[key];
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new Error(`calculator input '${key}' is not a number`);
  return v;
}

export function str(values: Values, key: string): string {
  const v = values[key];
  if (typeof v !== "string") throw new Error(`calculator input '${key}' is not a choice`);
  return v;
}

/** Percent field as a fraction: 5 -> 0.05. */
export function rate(values: Values, key: string): number {
  return num(values, key) / 100;
}

// -------------------------------------------------------------------------------- shared field factories

export const currencyField = (): SelectField => ({
  kind: "select",
  key: "cur",
  label: "Currency",
  help: "For display only. Nothing is converted.",
  options: CURRENCIES.map((c) => ({ value: c.code, label: c.label })),
  default: "USD",
  advanced: true,
});

export const timingField = (def: "start" | "mid" | "end" = "mid"): SelectField => ({
  kind: "select",
  key: "timing",
  label: "When money moves in the year",
  help: "Middle of the year is the planner’s default. The worked example uses the formula’s convention.",
  options: [
    { value: "start", label: "Start of each year" },
    { value: "mid", label: "Middle of each year" },
    { value: "end", label: "End of each year" },
  ],
  default: def,
  advanced: true,
});

export const taxField = (help: string): NumberField => ({
  kind: "number",
  key: "tax",
  label: "Flat tax on withdrawals",
  unit: "percent",
  min: 0,
  max: 60,
  step: 0.1,
  default: 0,
  help,
  advanced: true,
});

export const realReturnField = (def: number, help: string): NumberField => ({
  kind: "number",
  key: "ret",
  label: "Return after inflation",
  unit: "percent",
  min: -10,
  max: 15,
  step: 0.1,
  default: def,
  help,
});

export const seedField = (): NumberField => ({
  kind: "number",
  key: "seed",
  label: "Random seed",
  unit: "seed",
  min: 0,
  max: 4_294_967_295,
  step: 1,
  default: 2026,
  help: "The same seed and inputs always give the same result. Change it to see how much is noise.",
  advanced: true,
});
