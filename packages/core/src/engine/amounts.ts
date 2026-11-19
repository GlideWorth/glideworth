/**
 * Amount maths: activity windows, frequency annualisation, change-over-time and recurrence.
 *
 * Conventions (documented in ARCHITECTURE.md §Engine conventions):
 *   - Recurring amounts are annualised (amount x occurrences/yr) and prorated by active months.
 *   - 'once' events pay the full amount in the period containing their start month.
 *   - Change is anchored at the plan start when growFromToday (default) else at the event start.
 *   - A 'real' amount is converted to nominal with the price index at the anchor month.
 *   - Amounts are valued at the first active month of the period (year 1 = entered amount).
 *   - Recurrence: occurrence k starts at start + k * (duration + yearsBetween * 12) and is scaled
 *     by (1 + scalingRate)^k; occurrences start strictly before `until`.
 *   - ChangeLimit clamps the value (limit basis real -> indexed with the price index).
 */
import { type Amount, FREQUENCY_PER_YEAR, type Frequency } from "../schema/primitives.js";
import type { Change, Recurrence, TimeRange } from "../schema/time.js";
import { type EngineContext, type PeriodState, periodIndexAt } from "./context.js";
import { type MonthIndex, overlapMonths } from "./dates.js";
import { categoryIndexAt, fxAt } from "./indices.js";
import { resolveRef } from "./milestones.js";
import { resolvePoints, valueAt } from "./schedule.js";

export interface Window {
  start: MonthIndex | null;
  /** Exclusive end; Infinity when open-ended or pending. */
  end: number;
}

/** Resolve a TimeRange. A pending start means "not started"; a pending end means "still running". */
export function resolveWindow(ctx: EngineContext, range: TimeRange): Window {
  const s = resolveRef(ctx, range.start);
  const e = resolveRef(ctx, range.end);
  const start = s === "pending" ? null : s;
  let end = e === "pending" || e === null ? Number.POSITIVE_INFINITY : e;
  if (range.endInclusive && Number.isFinite(end)) end += 1;
  return { start, end };
}

export function activeMonths(w: Window, ps: PeriodState): number {
  if (w.start === null) return 0;
  return overlapMonths(w.start, w.end, ps.bounds.start, ps.bounds.end);
}

/**
 * Cumulative growth factor from month `a` to month `b` when each period i grows at `rate(i)`
 * per year (geometric within a period). Used for per-period uprating (triple lock).
 */
export function pathFactor(
  ctx: EngineContext,
  a: MonthIndex,
  b: MonthIndex,
  rate: (periodIndex: number) => number,
): number {
  if (b <= a) return 1;
  let f = 1;
  let m = a;
  while (m < b) {
    const i = periodIndexAt(ctx, m);
    const p = ctx.periods[i]!;
    const segEnd = i === ctx.periods.length - 1 ? b : Math.min(b, p.end);
    const months = Math.max(1, segEnd - m);
    f *= (1 + rate(i)) ** (months / 12);
    m += months;
  }
  return f;
}

/**
 * Nominal value of `amount` at month `m` under `change`, anchored at `anchor`. `category` selects the
 * inflation category whose index a `real` amount and an `inflation` change follow (default general).
 */
export function changedValue(
  ctx: EngineContext,
  amount: Amount,
  change: Change,
  anchor: MonthIndex,
  m: MonthIndex,
  category?: string,
): number {
  const pi = (x: MonthIndex) => categoryIndexAt(ctx, category, x);
  const base = amount.basis === "real" ? amount.value * pi(anchor) : amount.value;
  const years = (m - anchor) / 12;
  switch (change.kind) {
    case "none":
      return base;
    case "inflation":
      return base * (pi(m) / pi(anchor)) * (1 + change.plus) ** years;
    case "rate":
      return base * (1 + change.rate) ** years;
    case "schedule": {
      const pts = resolvePoints(ctx, change.points);
      if (change.valueKind === "multiplier")
        return base * (valueAt(pts, m, change.interpolation) ?? 1);
      if (change.valueKind === "amount") {
        const v = valueAt(pts, m, change.interpolation);
        if (v === null) return base;
        return amount.basis === "real" ? v * pi(m) : v;
      }
      // 'rate': annual growth rate in force each month, compounded monthly from the anchor.
      let f = 1;
      const lo = Math.min(anchor, m);
      const hi = Math.max(anchor, m);
      for (let k = lo; k < hi; k++)
        f *= (1 + (valueAt(pts, k, change.interpolation) ?? 0)) ** (1 / 12);
      return m >= anchor ? base * f : base / f;
    }
  }
}

export interface ChangeLimitSpec {
  max?: number | undefined;
  min?: number | undefined;
  basis: "real" | "nominal";
}

function clampLimit(
  ctx: EngineContext,
  v: number,
  m: MonthIndex,
  limit?: ChangeLimitSpec,
  category?: string,
): number {
  if (!limit) return v;
  const k = limit.basis === "real" ? categoryIndexAt(ctx, category, m) : 1;
  let out = v;
  if (limit.max !== undefined) out = Math.min(out, limit.max * k);
  if (limit.min !== undefined) out = Math.max(out, limit.min * k);
  return out;
}

/** One occurrence of a (possibly recurring) event window. */
export interface Occurrence {
  start: MonthIndex;
  end: number;
  k: number;
  scale: number;
}

/** Expand a window with an optional recurrence into occurrences overlapping [from, to). */
export function occurrences(
  ctx: EngineContext,
  w: Window,
  frequency: Frequency,
  recurrence: Recurrence | undefined,
  from: MonthIndex,
  to: MonthIndex,
): Occurrence[] {
  if (w.start === null) return [];
  if (!recurrence) return [{ start: w.start, end: w.end, k: 0, scale: 1 }];
  const until = resolveRef(ctx, recurrence.until);
  const untilM = typeof until === "number" ? until : Number.POSITIVE_INFINITY;
  const duration = frequency === "once" ? 0 : w.end - w.start;
  if (!Number.isFinite(duration)) return [{ start: w.start, end: w.end, k: 0, scale: 1 }];
  const step = duration + Math.round(recurrence.yearsBetween * 12);
  if (step <= 0) return [{ start: w.start, end: w.end, k: 0, scale: 1 }];
  const out: Occurrence[] = [];
  // Jump straight to the first occurrence that can overlap the period.
  const firstK = Math.max(0, Math.floor((from - w.start - duration) / step));
  for (let k = firstK; ; k++) {
    const s = w.start + k * step;
    if (s >= to || (k > 0 && s >= untilM)) break;
    const e = s + (frequency === "once" ? 1 : duration);
    if (e > from || frequency === "once")
      out.push({ start: s, end: e, k, scale: (1 + recurrence.scalingRate) ** k });
    if (k > 10_000) break;
  }
  return out;
}

export interface PeriodAmountArgs {
  amount: Amount;
  frequency: Frequency;
  range: TimeRange;
  change: Change;
  growFromToday: boolean;
  refs: string[];
  /** Optional per-month multiplier (part-time share...). Returns 1 for full. */
  monthShare?: (m: MonthIndex) => number;
  changeLimit?: ChangeLimitSpec | undefined;
  recurrence?: Recurrence | undefined;
  /** Exclusive month after which the event stops (e.g. owner's death). */
  cutoff?: number;
  /** Per-period uprating rate overriding `change` (e.g. UK triple lock). */
  uprate?: (periodIndex: number) => number;
  /** Override the resolved window (already computed by the caller). */
  window?: Window;
  /** Inflation category (Assumptions.inflationCategories id) the amount follows; default general. */
  inflationCategory?: string | undefined;
  /** Currency of the amount; foreign amounts are converted to the base currency at month m. */
  currency?: string | undefined;
}

function valueAtMonth(
  ctx: EngineContext,
  a: PeriodAmountArgs,
  occ: Occurrence,
  m: MonthIndex,
): number {
  const anchor = a.growFromToday ? ctx.start : Math.max(occ.start, ctx.start);
  const cat = a.inflationCategory;
  let v: number;
  if (a.uprate) {
    const base =
      a.amount.basis === "real"
        ? a.amount.value * categoryIndexAt(ctx, cat, anchor)
        : a.amount.value;
    v = base * pathFactor(ctx, anchor, m, a.uprate);
  } else v = changedValue(ctx, a.amount, a.change, anchor, m, cat);
  return clampLimit(ctx, v * occ.scale, m, a.changeLimit, cat) * fxAt(ctx, a.currency, m);
}

/**
 * Nominal value of one occurrence-unit of an event (per `frequency`) at month m, ignoring
 * recurrence scaling, part-time shares and the owner's death (the last basic wage of a salary for
 * the UAE gratuity).
 */
export function eventValueAt(ctx: EngineContext, a: PeriodAmountArgs, m: MonthIndex): number {
  const w = a.window ?? resolveWindow(ctx, a.range);
  const start = w.start ?? ctx.start;
  return valueAtMonth(ctx, a, { start, end: w.end, k: 0, scale: 1 }, m);
}

/** Total nominal amount an event contributes in this period. */
export function periodAmount(ctx: EngineContext, ps: PeriodState, a: PeriodAmountArgs): number {
  const w0 = a.window ?? resolveWindow(ctx, a.range);
  if (w0.start === null) return 0;
  const cutoff = a.cutoff ?? Number.POSITIVE_INFINITY;
  const ps0 = ps.bounds.start;
  const ps1 = Math.min(ps.bounds.end, cutoff);
  if (ps1 <= ps0) return 0;
  let total = 0;
  for (const occ of occurrences(ctx, w0, a.frequency, a.recurrence, ps0, ps1)) {
    if (a.frequency === "once") {
      // Events dated before the plan starts are treated as already happened.
      if (occ.start < ps0 || occ.start >= ps1) continue;
      total += valueAtMonth(ctx, a, occ, occ.start) * (a.monthShare?.(occ.start) ?? 1);
      continue;
    }
    const lo = Math.max(occ.start, ps0);
    const hi = Math.min(occ.end, ps1);
    if (hi <= lo) continue;
    const perYear = FREQUENCY_PER_YEAR[a.frequency];
    let shareMonths = 0;
    if (a.monthShare) for (let m = lo; m < hi; m++) shareMonths += a.monthShare(m);
    else shareMonths = hi - lo;
    total += (valueAtMonth(ctx, a, occ, lo) * perYear * shareMonths) / 12;
  }
  return total;
}

/** Real amount -> nominal at the start of this period (for flows/payments without a change rule). */
export function nominalAtPeriod(ps: PeriodState, amount: Amount): number {
  return amount.basis === "real" ? amount.value * ps.piStart : amount.value;
}
