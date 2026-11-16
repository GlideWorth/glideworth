/** Helpers shared by the calculators' engine modules: reading results in today's money. */
import {
  type MonteCarloSession,
  type ProjectionResult,
  type SimulationInput,
  simulate,
  toBasis,
} from "@glideworth/core";
import type { Timing } from "../types";

export interface RunOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export function run(input: SimulationInput): ProjectionResult {
  return simulate(input);
}

/** Closing portfolio of each year in today's money (balances deflate by the end-of-year index). */
export function balances(r: ProjectionResult): number[] {
  return r.periods.map((p) => toBasis(p.totals.portfolio, p, "real", "stock"));
}

/** A flow total of each year in today's money (flows deflate by the start-of-year index). */
export function flows(
  r: ProjectionResult,
  key: "spending" | "withdrawals" | "shortfall" | "taxes" | "income",
): number[] {
  return r.periods.map((p) => toBasis(p.totals[key], p, "real", "flow"));
}

/**
 * Years a withdrawal plan was funded: whole years with no shortfall before the first short year, plus
 * the share of that year's spending that was still paid. Infinity when no year fell short.
 */
export function yearsFunded(r: ProjectionResult): number {
  const idx = r.periods.findIndex((p) => p.totals.shortfall > 1e-6);
  if (idx < 0) return Number.POSITIVE_INFINITY;
  const p = r.periods[idx]!;
  const requested = p.totals.spending + p.totals.shortfall;
  const share = requested > 0 ? p.totals.spending / requested : 0;
  return idx + Math.max(0, Math.min(1, share));
}

/** Throws the standard abort error when the signal fired (checked between engine runs). */
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Calculation cancelled", "AbortError");
}

/** Lets a worker process a cancel message between chunks of work. */
export function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function timingLabel(t: Timing): string {
  return t === "start" ? "start of year" : t === "end" ? "end of year" : "middle of year";
}

/** Ages (or year numbers) at the END of each period: x axis for balance charts. */
export function axis(startAge: number, count: number): number[] {
  return Array.from({ length: count + 1 }, (_, i) => startAge + i);
}

/** Percentile of a sorted copy of the numbers (linear interpolation). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

/** Replaces non-finite numbers with null for charts and tables (never NaN or Infinity in output). */
export function finite(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

/**
 * Runs a Monte Carlo session in chunks, yielding between chunks so a worker can receive a cancel
 * message, and reporting progress as `done + offset` of `total` (several sessions can share a bar).
 */
export async function stepSession(
  session: MonteCarloSession,
  opts: RunOptions & { offset?: number; total?: number },
): Promise<void> {
  const total = opts.total ?? session.total;
  const offset = opts.offset ?? 0;
  for (;;) {
    checkAbort(opts.signal);
    const finished = session.step(50);
    opts.onProgress?.(offset + session.done, total);
    if (finished) return;
    await pause();
  }
}
