/** Monte Carlo FX risk (MonteCarloSettings.fx): off by default, correlated, mean-preserving. */
import { describe, expect, it } from "vitest";
import { getTrialMarketPath, runMonteCarlo, runTrial } from "../src/index.js";
import { acct, sim } from "./engine-helpers.js";

// A GBP household holding EUR and CHF accounts; no other randomness (nothing in `vary`).
const input = sim({
  start: "2027-01",
  years: 10,
  accounts: [
    acct("gbp", "savings", 50_000),
    acct("eur", "savings", 100_000, { currency: "EUR" }),
    acct("chf", "savings", 100_000, { currency: "CHF" }),
  ],
  finances: {
    fxRates: [
      { from: "EUR", to: "GBP", rate: 0.85, annualDrift: 0 },
      // Quoted base -> foreign: inverted by the engine and the sampler.
      { from: "GBP", to: "CHF", rate: 1.1, annualDrift: 0 },
    ],
  },
});
const still = { stocks: false, bonds: false, inflation: false, dividends: false, crypto: false };
const base = { method: "normal" as const, trials: 400, seed: 7, vary: still };
const fx = {
  pairs: [
    { from: "EUR", to: "GBP", volatility: 0.08 },
    { from: "GBP", to: "CHF", volatility: 0.1 },
  ],
  correlation: 0.6,
};
const endNw = (r: ReturnType<typeof runMonteCarlo>) =>
  r.trialSummaries.map((t) => t.endNetWorthReal);

describe("Monte Carlo FX risk", () => {
  it("is off by default: every trial ends at the deterministic net worth", () => {
    const r = runMonteCarlo(input, base);
    const v = endNw(r);
    expect(Math.max(...v) - Math.min(...v)).toBeLessThan(1e-6);
    expect(getTrialMarketPath(input, base, 0).periods[0]!.fx).toBeUndefined();
  });

  it("zero volatility reproduces the deterministic run exactly", () => {
    const off = endNw(runMonteCarlo(input, base));
    const zero = endNw(
      runMonteCarlo(input, {
        ...base,
        fx: { pairs: fx.pairs.map((p) => ({ ...p, volatility: 0 })) },
      }),
    );
    for (const [i, x] of zero.entries()) expect(x).toBeCloseTo(off[i]!, 6);
  });

  it("samples correlated, mean-preserving shocks and spreads the outcomes", () => {
    const r = runMonteCarlo(input, { ...base, fx });
    const v = endNw(r);
    expect(Math.max(...v) - Math.min(...v)).toBeGreaterThan(10_000);
    // Shocks: EUR (listed foreign -> base) has mean 1; CHF is quoted base -> CHF, so its value
    // shock is the inverse of a mean-1 shock. log-shock correlation is -0.6 for the inverted leg.
    const eur: number[] = [];
    const chf: number[] = [];
    for (let t = 0; t < 200; t++) {
      const path = getTrialMarketPath(input, { ...base, fx }, t);
      for (const p of path.periods) {
        eur.push(Math.log(p.fx!.EUR!));
        chf.push(-Math.log(p.fx!.CHF!));
      }
    }
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
    const corr =
      mean(eur.map((x, i) => (x - mean(eur)) * (chf[i]! - mean(chf)))) / (sd(eur) * sd(chf));
    expect(sd(eur)).toBeCloseTo(0.08, 2);
    expect(sd(chf)).toBeCloseTo(0.1, 2);
    expect(corr).toBeCloseTo(0.6, 1);
    expect(mean(eur.map(Math.exp))).toBeCloseTo(1, 2);
  });

  it("revalues foreign holdings by the path and keeps every trial reconciled; deterministic per seed", () => {
    const a = runTrial(input, { ...base, fx }, 3, { trace: "off" });
    const b = runTrial(input, { ...base, fx }, 3, { trace: "off" });
    expect(a.result.periods.at(-1)!.totals.netWorth).toBe(b.result.periods.at(-1)!.totals.netWorth);
    let rate = 0.85;
    for (const [i, p] of a.result.periods.entries()) {
      rate *= a.market.periods[i]!.fx!.EUR!;
      const eur = p.accounts.find((x) => x.accountId === "eur")!;
      expect(eur.closing).toBeCloseTo(100_000 * rate, 6);
    }
  });

  it("pairs must involve the household currency", () => {
    expect(() =>
      runMonteCarlo(input, {
        ...base,
        trials: 2,
        fx: { pairs: [{ from: "EUR", to: "CHF", volatility: 0.1 }] },
      }),
    ).toThrow(/household currency/);
  });

  it("enabling FX risk leaves the market draws unchanged", () => {
    const s = { method: "normal" as const, trials: 5, seed: 3 };
    const plain = getTrialMarketPath(input, s, 2);
    const withFx = getTrialMarketPath(input, { ...s, fx }, 2);
    for (const [i, p] of plain.periods.entries()) expect(withFx.periods[i]!.stocks).toBe(p.stocks);
  });
});
