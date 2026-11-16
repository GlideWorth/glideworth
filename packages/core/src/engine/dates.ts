/** Month arithmetic. A "month index" is year * 12 + (month - 1); comparisons are integer. */
import { ScenarioError } from "../errors.js";
import type { MonthDate } from "../schema/primitives.js";

export type MonthIndex = number;

export function parseMonth(m: MonthDate): MonthIndex {
  const [y, mo] = m.split("-");
  return Number(y) * 12 + (Number(mo) - 1);
}

export function formatMonth(i: MonthIndex): MonthDate {
  const y = Math.floor(i / 12);
  const mo = i - y * 12 + 1;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}`;
}

export function yearOf(i: MonthIndex): number {
  return Math.floor(i / 12);
}

/** Month (0-11) within its year. */
export function monthOfYear(i: MonthIndex): number {
  return i - yearOf(i) * 12;
}

/** Month a person reaches `age` (fractional ages round down to whole months). */
export function monthAtAge(birth: MonthIndex, age: number): MonthIndex {
  return birth + Math.floor(age * 12 + 1e-9);
}

export function ageAt(birth: MonthIndex, at: MonthIndex): number {
  return (at - birth) / 12;
}

/** Number of months of [aStart, aEnd) that fall in [bStart, bEnd). */
export function overlapMonths(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

export interface PeriodBounds {
  index: number;
  start: MonthIndex;
  /** Exclusive. */
  end: MonthIndex;
  months: number;
  /** Year label: calendar year of the start month (fiscal periods use their start year). */
  year: number;
}

/**
 * Split [start, end) into annual periods aligned to `alignMonth` (0-11). Calendar alignment uses
 * 0 (January); fiscal uses its start month; rolling uses the plan start month. The first and last
 * periods may be partial.
 */
export function buildPeriods(
  start: MonthIndex,
  end: MonthIndex,
  alignMonth: number,
): PeriodBounds[] {
  if (end <= start) throw new ScenarioError("plan ends before it starts", { start, end });
  const out: PeriodBounds[] = [];
  let s = start;
  let index = 0;
  while (s < end) {
    const moy = monthOfYear(s);
    const toBoundary = (alignMonth - moy + 12) % 12 || 12;
    const e = Math.min(s + toBoundary, end);
    out.push({ index, start: s, end: e, months: e - s, year: yearOf(s) });
    s = e;
    index += 1;
  }
  return out;
}
