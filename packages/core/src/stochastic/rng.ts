/**
 * Seeded PRNG (mulberry32) + Box-Muller normals. Deterministic across Node, browsers and workers.
 * Each trial should derive its own stream with `deriveSeed(seed, trial)` so sharding across
 * workers reproduces the single-threaded result exactly.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Standard normal N(0, 1). */
  normal(): number;
  /** Integer in [0, n). */
  int(n: number): number;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  let spare: number | null = null;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    normal() {
      if (spare !== null) {
        const s = spare;
        spare = null;
        return s;
      }
      let u = 0;
      while (u === 0) u = next();
      const v = next();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return r * Math.cos(2 * Math.PI * v);
    },
    int(n: number) {
      return Math.floor(next() * n);
    },
  };
}

/** Independent per-trial seed (splitmix-style hash). */
export function deriveSeed(seed: number, trial: number): number {
  let z = (seed ^ Math.imul(trial + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}
