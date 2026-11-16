/**
 * Plain-English formatting for insights (diff descriptions, explanations, audit messages).
 * Uses Intl only; never hard-codes a currency symbol.
 */
import type { Amount, Frequency } from "../schema/primitives.js";
import type { DateRef, RateSpec, TimeRange } from "../schema/time.js";

export interface FormatContext {
  /** ISO 4217 code. Without it, amounts are formatted as plain grouped numbers. */
  currency?: string;
  locale?: string;
  /** person id -> display name */
  people?: Record<string, string>;
  /** milestone id -> name */
  milestones?: Record<string, string>;
  /** account / real asset / debt id -> name */
  entities?: Record<string, string>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtMoney(value: number, ctx: FormatContext = {}): string {
  const locale = ctx.locale ?? "en-GB";
  const frac = Math.abs(value) >= 100 || Number.isInteger(value) ? 0 : 2;
  try {
    if (ctx.currency)
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: ctx.currency,
        maximumFractionDigits: frac,
        minimumFractionDigits: frac,
      }).format(value);
  } catch {
    // fall through to plain number
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: frac }).format(value);
}

export function fmtPercent(rate: number, ctx: FormatContext = {}): string {
  return new Intl.NumberFormat(ctx.locale ?? "en-GB", {
    style: "percent",
    maximumFractionDigits: Math.abs(rate * 100 - Math.round(rate * 100)) < 1e-9 ? 0 : 2,
  }).format(rate);
}

export function fmtNumber(v: number, ctx: FormatContext = {}, digits = 2): string {
  return new Intl.NumberFormat(ctx.locale ?? "en-GB", { maximumFractionDigits: digits }).format(v);
}

export const FREQUENCY_PHRASE: Record<Frequency, string> = {
  once: "",
  weekly: "a week",
  biweekly: "every two weeks",
  semimonthly: "twice a month",
  monthly: "a month",
  quarterly: "a quarter",
  semiannually: "every six months",
  yearly: "a year",
};

export function fmtAmount(
  amount: Amount,
  frequency: Frequency | undefined,
  ctx: FormatContext = {},
): string {
  const money = fmtMoney(amount.value, ctx);
  const per = frequency ? FREQUENCY_PHRASE[frequency] : "";
  const basis = amount.basis === "nominal" ? " (future money)" : "";
  return `${money}${per ? ` ${per}` : ""}${basis}`;
}

export function fmtMonth(month: string): string {
  const [y, m] = month.split("-");
  const name = MONTHS[Number(m) - 1];
  return name ? `${name} ${y}` : month;
}

function offset(n: number | undefined): string {
  if (!n) return "";
  const abs = Math.abs(n);
  const unit =
    abs % 12 === 0
      ? `${abs / 12} year${abs === 12 ? "" : "s"}`
      : `${abs} month${abs === 1 ? "" : "s"}`;
  return n > 0 ? ` + ${unit}` : ` - ${unit}`;
}

export function personName(id: string, ctx: FormatContext): string | undefined {
  return ctx.people?.[id];
}

export function fmtAge(age: number, ctx: FormatContext = {}): string {
  return fmtNumber(age, ctx, 1);
}

export function fmtDateRef(ref: DateRef, ctx: FormatContext = {}): string {
  switch (ref.kind) {
    case "planStart":
      return ref.offsetMonths ? `plan start${offset(ref.offsetMonths)}` : "now";
    case "planEnd":
      return `end of plan${offset(ref.offsetMonths)}`;
    case "never":
      return "never";
    case "date":
      return `${fmtMonth(ref.date)}${offset(ref.offsetMonths)}`;
    case "age": {
      const who = personName(ref.personId, ctx);
      return `${who ? `${who}'s ` : ""}age ${fmtAge(ref.age, ctx)}${offset(ref.offsetMonths)}`;
    }
    case "milestone":
      return `${ctx.milestones?.[ref.milestoneId] ?? ref.milestoneId}${offset(ref.offsetMonths)}`;
  }
}

/** "in Jun 2031", "from now until Avery's age 67", "from age 57". */
export function fmtRange(range: TimeRange, once: boolean, ctx: FormatContext = {}): string {
  if (once) return `in ${fmtDateRef(range.start, ctx)}`;
  const start =
    range.start.kind === "planStart" && !range.start.offsetMonths
      ? "from now"
      : `from ${fmtDateRef(range.start, ctx)}`;
  if (range.end.kind === "planEnd" && !range.end.offsetMonths) return start;
  if (range.end.kind === "never") return start;
  return `${start} until ${fmtDateRef(range.end, ctx)}`;
}

export function fmtRateSpec(spec: RateSpec, ctx: FormatContext = {}): string {
  switch (spec.kind) {
    case "none":
      return "none";
    case "fixed":
      return fmtPercent(spec.rate, ctx);
    case "schedule":
      return `a schedule of ${spec.points.length} point${spec.points.length === 1 ? "" : "s"}`;
    case "historical":
      return `historical ${spec.series} from ${spec.startYear}`;
  }
}

/** Short value rendering for generic change descriptions. */
export function fmtValue(v: unknown, key: string, ctx: FormatContext = {}): string {
  if (v === undefined) return "not set";
  if (v === null) return "none";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "number") {
    if (isRateKey(key) && Math.abs(v) <= 1.5) return fmtPercent(v, ctx);
    if (isMoneyKey(key)) return fmtMoney(v, ctx);
    return fmtNumber(v, ctx);
  }
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("kind" in o && "rate" in o && typeof o.rate === "number" && o.kind === "fixed")
      return fmtPercent(o.rate, ctx);
    if ("kind" in o && typeof o.kind === "string") {
      if (["planStart", "planEnd", "never", "date", "age", "milestone"].includes(o.kind))
        return fmtDateRef(o as DateRef, ctx);
      if (o.kind === "inflation" && typeof o.plus === "number")
        return o.plus ? `inflation + ${fmtPercent(o.plus, ctx)}` : "inflation";
      return o.kind;
    }
    if ("value" in o && typeof o.value === "number") return fmtMoney(o.value, ctx);
    if ("name" in o && typeof o.name === "string") return o.name;
  }
  return JSON.stringify(v);
}

export function isRateKey(key: string): boolean {
  return /rate|share|plus|yield|return|inflation|premium|modifier|guardrail|adjustment|cut|drawdown|success|threshold|allocation/i.test(
    key,
  );
}

function isMoneyKey(key: string): boolean {
  return /value|balance|amount|price|floor|ceiling|target|pia|buffer/i.test(key);
}

/** camelCase / kebab key -> words. */
export function humanKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .toLowerCase();
}

export const ASSUMPTION_LABELS: Record<string, string> = {
  inflation: "Inflation",
  stockReturn: "Stock return",
  dividendYield: "Dividend yield",
  bondReturn: "Bond return",
  bondYield: "Bond yield",
  cashReturn: "Cash return",
  cryptoReturn: "Crypto return",
  healthcareInflationPremium: "Healthcare inflation premium",
  benefitColaModifier: "Benefit COLA modifier",
  bondAllocation: "Bond allocation",
  dividendReinvestment: "Dividend reinvestment",
  yearAlignment: "Year alignment",
  end: "Plan end",
  maxYears: "Maximum plan length",
};

export function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
