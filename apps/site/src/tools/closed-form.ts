/**
 * Closed-form answers shown next to the engine's results. They are NOT where the calculators get their
 * results (the engine is); they are the textbook formulas from the blog articles, generalised to the
 * engine's cash-flow timing convention so the two can be compared exactly.
 *
 * Timing: the engine grows each opening balance for a year and books the year's net flow at the end,
 * crediting (or debiting) the flow with the share k of the year's return it was invested for:
 * k = 1 (start of year), 0.5 (middle), 0 (end). So a flow F behaves like F x (1 + r)^k paid at the end
 * of the year, and every formula below uses F' = F x (1 + r)^k. With k = 0 they are the articles'
 * end-of-year formulas exactly.
 *
 * All rates are real (after inflation) annual fractions; all amounts are in today's money.
 */
import type { Timing } from "./types";

export const TIMING_SHARE: Record<Timing, number> = { start: 1, mid: 0.5, end: 0 };

/** A flow as if paid at the end of the year under the timing convention. */
export function atYearEnd(flow: number, r: number, timing: Timing): number {
  return flow * (1 + r) ** TIMING_SHARE[timing];
}

/** Growth factor over n years: (1 + r)^n. */
export function growthFactor(r: number, n: number): number {
  return (1 + r) ** n;
}

/** Coast number: what you need today so that growth alone reaches `target` in n years. */
export function coastNumber(target: number, r: number, n: number): number {
  return target / growthFactor(r, n);
}

/** FIRE number: spending grossed up for a flat tax on withdrawals, divided by the withdrawal rate. */
export function fireNumber(spending: number, withdrawalRate: number, taxRate = 0): number {
  return spending / (1 - taxRate) / withdrawalRate;
}

/** Sum of (1 + r)^j for j = 0..n-1: the growth of one unit added at each year end. */
function annuityFactor(r: number, n: number): number {
  return Math.abs(r) < 1e-12 ? n : ((1 + r) ** n - 1) / r;
}

/** Balance after n years from B with a contribution C each year (C may be negative: a withdrawal). */
export function balanceAfter(B: number, C: number, r: number, n: number, timing: Timing): number {
  return B * growthFactor(r, n) + atYearEnd(C, r, timing) * annuityFactor(r, n);
}

/**
 * Years until the balance reaches `target` with yearly contributions C (fractional; Infinity when it
 * never does; 0 when it already has).
 */
export function yearsToTarget(
  B: number,
  C: number,
  r: number,
  target: number,
  timing: Timing,
): number {
  if (B >= target) return 0;
  const c = atYearEnd(C, r, timing);
  if (Math.abs(r) < 1e-12) return c > 0 ? (target - B) / c : Number.POSITIVE_INFINITY;
  const x = (target * r + c) / (B * r + c);
  if (!(x > 0) || !Number.isFinite(x)) return Number.POSITIVE_INFINITY;
  const n = Math.log(x) / Math.log(1 + r);
  return n >= 0 && Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * Coast age as years from now: the first point where the balance (saving C a year) reaches the coast
 * number for the remaining years to retirement, n years away. Infinity when it never does before n.
 */
export function yearsToCoast(
  B: number,
  C: number,
  r: number,
  target: number,
  n: number,
  timing: Timing,
): number {
  const goal = coastNumber(target, r, n);
  if (B >= goal) return 0;
  const c = atYearEnd(C, r, timing);
  let t: number;
  if (Math.abs(r) < 1e-12) t = c > 0 ? (target - B) / c : Number.POSITIVE_INFINITY;
  else {
    // B(1+r)^t + c((1+r)^t - 1)/r = target (1+r)^(t-n)  =>  (1+r)^t (B + c/r - target/(1+r)^n) = c/r
    const denom = B + c / r - target / growthFactor(r, n);
    const x = c / r / denom;
    t = denom !== 0 && x > 0 ? Math.log(x) / Math.log(1 + r) : Number.POSITIVE_INFINITY;
  }
  return t >= 0 && t <= n && Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/**
 * Years a balance B lasts when W is withdrawn every year (fractional). Infinity when growth covers
 * the withdrawal for ever. The articles' formula with end-of-year withdrawals: -ln(1 - rB/W) / ln(1 + r).
 */
export function depletionYears(B: number, W: number, r: number, timing: Timing): number {
  if (B <= 0) return 0;
  if (W <= 0) return Number.POSITIVE_INFINITY;
  const w = atYearEnd(W, r, timing);
  if (Math.abs(r) < 1e-12) return B / w;
  if (r * B >= w) return Number.POSITIVE_INFINITY;
  return -Math.log(1 - (r * B) / w) / Math.log(1 + r);
}

/**
 * Present value of a list of yearly net withdrawals (year 0 first; negative = money added): the starting
 * balance that ends at exactly zero. With start-of-year timing it is the familiar sum of w_t / (1+r)^t.
 */
export function presentValue(withdrawals: readonly number[], r: number, timing: Timing): number {
  const k = TIMING_SHARE[timing];
  return withdrawals.reduce((s, w, t) => s + w * (1 + r) ** (k - 1 - t), 0);
}

/** Sustainable constant withdrawal rate for n years at a constant return (end-of-year payments). */
export function sustainableRate(r: number, n: number): number {
  if (n <= 0) return 1;
  if (Math.abs(r) < 1e-12) return 1 / n;
  return r / (1 - (1 + r) ** -n);
}

/** 95% sampling margin of a simulated success rate p over n trials: 1.96 sqrt(p(1-p)/n). */
export function marginOfError(p: number, n: number): number {
  if (n <= 0) return Number.NaN;
  return 1.96 * Math.sqrt((p * (1 - p)) / n);
}
