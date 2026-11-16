/**
 * Schedules ("Advanced" change-over-time editor): control points keyed by DateRef, evaluated at a
 * month with step or linear interpolation.
 *
 * Conventions:
 *   - Points whose DateRef is pending (milestone not reached yet) or never are ignored.
 *   - Before the first point the first value applies; after the last point the last value holds.
 *   - step: the value of the latest point at or before the month.
 *   - linear: straight line between the surrounding points (by month).
 */
import type { DateRef } from "../schema/time.js";
import type { EngineContext } from "./context.js";
import type { MonthIndex } from "./dates.js";
import { resolveRef } from "./milestones.js";

export interface ResolvedPoint {
  month: MonthIndex;
  value: number;
}

export function resolvePoints(
  ctx: EngineContext,
  points: readonly { at: DateRef; value: number }[],
): ResolvedPoint[] {
  const out: ResolvedPoint[] = [];
  for (const p of points) {
    const m = resolveRef(ctx, p.at);
    if (typeof m === "number") out.push({ month: m, value: p.value });
  }
  out.sort((a, b) => a.month - b.month);
  return out;
}

export function valueAt(
  points: readonly ResolvedPoint[],
  m: MonthIndex,
  interpolation: "step" | "linear",
): number | null {
  if (points.length === 0) return null;
  const first = points[0]!;
  if (m <= first.month) return first.value;
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i]!;
    if (m >= p.month) {
      const next = points[i + 1];
      if (interpolation === "step" || !next || next.month === p.month) return p.value;
      const t = (m - p.month) / (next.month - p.month);
      return p.value + t * (next.value - p.value);
    }
  }
  return first.value;
}

/** Evaluate a schedule at month `m`. Returns `fallback` when no point resolves. */
export function scheduleAt(
  ctx: EngineContext,
  points: readonly { at: DateRef; value: number }[],
  m: MonthIndex,
  interpolation: "step" | "linear",
  fallback: number,
): number {
  const v = valueAt(resolvePoints(ctx, points), m, interpolation);
  return v === null ? fallback : v;
}
