/** Small numeric helpers for the stochastic module. Pure and deterministic. */
import { ValidationError } from "../errors.js";
import type { Rng } from "./rng.js";

/** Lower-triangular Cholesky factor of a symmetric positive-definite matrix. */
export function cholesky(m: readonly (readonly number[])[]): number[][] {
  const n = m.length;
  const l: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = m[i]![j]!;
      for (let k = 0; k < j; k++) sum -= l[i]![k]! * l[j]![k]!;
      if (i === j) {
        if (sum <= -1e-12)
          throw new ValidationError("correlation matrix is not positive semi-definite", {
            matrix: m,
          });
        l[i]![i] = Math.sqrt(Math.max(sum, 0));
      } else {
        const d = l[j]![j]!;
        l[i]![j] = d === 0 ? 0 : sum / d;
      }
    }
  }
  return l;
}

/** Gamma(shape, 1) draw (Marsaglia-Tsang; boosted for shape < 1). */
export function gamma(rng: Rng, shape: number): number {
  if (shape < 1) return gamma(rng, shape + 1) * rng.next() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = rng.normal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng.next();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Chi-square(nu) draw. */
export function chiSquare(rng: Rng, nu: number): number {
  return 2 * gamma(rng, nu / 2);
}

/** Linear-interpolation percentile (type 7) of an ascending-sorted array. NaN when empty. */
export function percentileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0]!;
  const h = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

/** Nearest-rank percentile (returns an actual element) of an ascending-sorted array. */
export function nearestRankSorted<T>(sorted: readonly T[], p: number): T | undefined {
  if (sorted.length === 0) return undefined;
  const k = Math.max(0, Math.ceil(Math.min(1, Math.max(0, p)) * sorted.length) - 1);
  return sorted[k];
}

/** Stable 32-bit FNV-1a hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Average ranks (1-based, ties averaged) of `xs`. */
export function ranks(xs: readonly number[]): number[] {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]! || a - b);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && xs[idx[j + 1]!] === xs[idx[i]!]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]!] = avg;
    i = j + 1;
  }
  return r;
}

/** Pearson correlation; null when either side has zero variance. */
export function correlation(a: readonly number[], b: readonly number[]): number | null {
  const n = a.length;
  if (n < 2) return null;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  if (saa === 0 || sbb === 0) return null;
  return sab / Math.sqrt(saa * sbb);
}
