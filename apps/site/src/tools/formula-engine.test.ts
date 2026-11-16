/**
 * Closed-form answers against hand calculations and the blog articles' worked examples, and against
 * the engine when the engine is configured to match the formula's assumptions. Tolerances:
 *  - coast number and balances: within 0.01 (a hundredth of a currency unit) for any timing;
 *  - years to deplete: within 0.01 years, except 0.03 with start or mid timing and a negative return
 *    (in a losing year the engine does not let a start/mid withdrawal exceed the current balance;
 *    see the README);
 *  - years to the FIRE number and coast age: the engine's whole years equal the formula rounded up;
 *  - Barista (present value): relative 1e-6 for every timing.
 */
import { describe, expect, it } from "vitest";
import {
  balanceAfter,
  coastNumber,
  depletionYears,
  fireNumber,
  marginOfError,
  presentValue,
  sustainableRate,
  yearsToCoast,
  yearsToTarget,
} from "./closed-form";
import { baristaNumbers, requiredPortfolio } from "./engine/barista";
import { coastNumbers, engineGrowth } from "./engine/coast";
import { fireYears } from "./engine/fire";
import { engineYears } from "./engine/how-long";
import type { Timing } from "./types";

const TIMINGS: Timing[] = ["start", "mid", "end"];

describe("closed forms: hand-checked and article values", () => {
  it("coast number 231,377 for 1,000,000 over 30 years at 5% (coast article)", () => {
    expect(Math.round(coastNumber(1_000_000, 0.05, 30))).toBe(231_377);
  });
  it("the coast article’s return table", () => {
    const table: [number, number, number][] = [
      [0.03, 35, 355_383],
      [0.04, 25, 375_117],
      [0.06, 20, 311_805],
      [0.07, 15, 362_446],
    ];
    for (const [r, n, v] of table) expect(Math.round(coastNumber(1_000_000, r, n))).toBe(v);
  });
  it("saving 30,000 a year from 100,000 at 5%: 485,930 after 9 years (coast article)", () => {
    expect(Math.round(balanceAfter(100_000, 30_000, 0.05, 9, "end"))).toBe(485_930);
    expect(Math.round(balanceAfter(100_000, 30_000, 0.05, 8, "end"))).toBe(434_219);
  });
  it("500,000 with 30,000 a year at 4% lasts 28.0 years, 26.1 with start-of-year withdrawals", () => {
    expect(depletionYears(500_000, 30_000, 0.04, "end").toFixed(2)).toBe("28.01");
    expect(depletionYears(500_000, 30_000, 0.04, "start").toFixed(1)).toBe("26.1");
  });
  it("the depletion article’s return table", () => {
    const rows: [number, string][] = [
      [0.02, "20.5"],
      [0.03, "23.4"],
      [0.05, "36.7"],
    ];
    for (const [r, y] of rows) expect(depletionYears(500_000, 30_000, r, "end").toFixed(1)).toBe(y);
    expect(depletionYears(500_000, 30_000, 0.06, "end")).toBe(Number.POSITIVE_INFINITY);
  });
  it("a 4% withdrawal lasts 28.9 / 35.0 / 46.9 years at 1 / 2 / 3% (FIRE article)", () => {
    expect(depletionYears(1, 0.04, 0.01, "end").toFixed(1)).toBe("28.9");
    expect(depletionYears(1, 0.04, 0.02, "end").toFixed(1)).toBe("35.0");
    expect(depletionYears(1, 0.04, 0.03, "end").toFixed(1)).toBe("46.9");
  });
  it("sustainable rates for 30 and 50 years (FIRE article table)", () => {
    expect((sustainableRate(0.02, 30) * 100).toFixed(2)).toBe("4.46");
    expect((sustainableRate(0.03, 50) * 100).toFixed(2)).toBe("3.89");
    expect((sustainableRate(0.04, 60) * 100).toFixed(2)).toBe("4.42");
  });
  it("FIRE number is 25 times spending at 4%, grossed up for a flat tax", () => {
    expect(fireNumber(40_000, 0.04)).toBeCloseTo(1_000_000, 6);
    expect(Math.round(fireNumber(40_000, 0.04, 0.15))).toBe(1_176_471);
  });
  it("Barista article: 1,010,171 for full retirement and 825,730 with part-time pay to 60", () => {
    const full = Array.from({ length: 45 }, () => 40_000);
    const barista = full.map((w, t) => (t < 15 ? w - 15_000 : w));
    expect(Math.round(presentValue(full, 0.03, "start"))).toBe(1_010_171);
    expect(Math.round(presentValue(barista, 0.03, "start"))).toBe(825_730);
  });
  it("margin of error near 87%: about 2.1 points at 1,000 trials and 0.7 at 10,000", () => {
    expect((marginOfError(0.87, 1000) * 100).toFixed(1)).toBe("2.1");
    expect((marginOfError(0.87, 10_000) * 100).toFixed(1)).toBe("0.7");
  });
  it("an independent year-by-year loop agrees with the depletion and target formulas", () => {
    for (const r of [-0.02, 0, 0.03, 0.07]) {
      let b = 500_000;
      let n = 0;
      while (b >= 30_000 * (1 + r) ** 0.5 && n < 500) {
        b = b * (1 + r) - 30_000 * (1 + r) ** 0.5;
        n++;
      }
      const f = depletionYears(500_000, 30_000, r, "mid");
      expect(Number.isFinite(f) ? Math.floor(f + 1e-9) : 500).toBe(n);
      let s = 10_000;
      let k = 0;
      while (s < 400_000 && k < 500) {
        s = s * (1 + r) + 25_000;
        k++;
      }
      expect(Math.ceil(yearsToTarget(10_000, 25_000, r, 400_000, "end") - 1e-9)).toBe(k);
    }
  });
});

describe("engine matches the formulas when configured like them", () => {
  it("engine growth equals (1 + r)^n for any timing (no flows)", () => {
    for (const r of [-0.03, 0, 0.02, 0.05, 0.09])
      for (const t of TIMINGS) {
        const g = engineGrowth(r, 30, 40, t);
        expect(g[40]! / (1 + r) ** 40).toBeCloseTo(1, 10);
      }
  });

  it("coast number: engine and formula agree within 0.01", () => {
    for (const ret of [-2, 0, 3, 5, 8])
      for (const timing of TIMINGS) {
        const c = coastNumbers({
          age: 30,
          retire: 62,
          balance: 50_000,
          spend: 50_000,
          wr: 3.5,
          ret,
          save: 12_000,
          timing,
          cur: "USD",
        });
        expect(Math.abs(c.coastToday - c.formulaCoast)).toBeLessThan(0.01);
        expect(Math.abs(c.atRetirementNoSaving - 50_000 * (1 + ret / 100) ** 32)).toBeLessThan(
          0.01,
        );
      }
  });

  it("coast age: the engine’s whole year is the formula rounded up", () => {
    for (const ret of [2, 4, 5, 7])
      for (const timing of TIMINGS) {
        const c = coastNumbers({
          age: 35,
          retire: 60,
          balance: 100_000,
          spend: 40_000,
          wr: 4,
          ret,
          save: 30_000,
          timing,
          cur: "USD",
        });
        expect(c.coastYears).toBe(Math.ceil(c.formulaCoastYears - 1e-9));
      }
    // The article's second example: crosses at 44.
    const ex = coastNumbers({
      age: 35,
      retire: 60,
      balance: 100_000,
      spend: 40_000,
      wr: 4,
      ret: 5,
      save: 30_000,
      timing: "end",
      cur: "USD",
    });
    expect(35 + ex.coastYears!).toBe(44);
    expect(Math.round(ex.keep[8]!)).toBe(434_219);
    expect(Math.round(ex.coastByAge[8]!)).toBe(436_297);
    expect(Math.round(ex.keep[9]!)).toBe(485_930);
    expect(Math.round(ex.coastByAge[9]!)).toBe(458_112);
  });

  it("balance with savings: engine equals the annuity formula for each timing", () => {
    for (const timing of TIMINGS) {
      const c = coastNumbers({
        age: 35,
        retire: 60,
        balance: 100_000,
        spend: 40_000,
        wr: 4,
        ret: 5,
        save: 30_000,
        timing,
        cur: "USD",
      });
      for (const k of [1, 9, 25])
        expect(Math.abs(c.keep[k]! - balanceAfter(100_000, 30_000, 0.05, k, timing))).toBeLessThan(
          0.01,
        );
    }
  });

  it("years to the FIRE number: engine whole years = formula rounded up", () => {
    for (const ret of [0, 3, 5, 7])
      for (const timing of TIMINGS) {
        const v = {
          age: 30,
          spend: 40_000,
          wr: 4,
          balance: 50_000,
          save: 20_000,
          ret,
          tax: 0,
          hy: 30,
          stocks: 60,
          timing,
          cur: "USD",
        };
        const f = yearsToTarget(50_000, 20_000, ret / 100, fireNumber(40_000, 0.04), timing);
        expect(fireYears(v).years, `${ret}% ${timing}`).toBe(Math.ceil(f - 1e-9));
      }
  });

  it("years the money lasts: within 0.01 (0.03 for start/mid timing with a negative return)", () => {
    for (const ret of [-3, 0, 2, 4, 5])
      for (const timing of TIMINGS)
        for (const tax of [0, 20]) {
          const v = {
            balance: 500_000,
            spend: 30_000,
            ret,
            age: 65,
            tax,
            stocks: 60,
            timing,
            cur: "USD",
          };
          const e = engineYears(v).years;
          const f = depletionYears(500_000, 30_000 / (1 - tax / 100), ret / 100, timing);
          expect(Math.abs(e - f), `${ret}% ${timing} tax ${tax}`).toBeLessThan(
            timing !== "end" && ret < 0 ? 0.03 : 0.01,
          );
          if (timing === "end") expect(Math.floor(e + 1e-9)).toBe(Math.floor(f + 1e-9));
        }
    // The article's example: 28 full withdrawals, 29,158 left after 27 and 324 after 28.
    const ex = engineYears({
      balance: 500_000,
      spend: 30_000,
      ret: 4,
      age: 65,
      tax: 0,
      stocks: 60,
      timing: "end",
      cur: "USD",
    });
    expect(ex.years.toFixed(1)).toBe("28.0");
    expect(Math.round(ex.path[27]!)).toBe(29_158);
    expect(Math.round(ex.path[28]!)).toBe(324);
  });

  it("Barista: the solver matches the present value for every timing", async () => {
    const plan = {
      age: 45,
      years: 45,
      spend: 40_000,
      pt: 15_000,
      ptYears: 15,
      r: 0.03,
      tax: 0,
      cur: "USD",
    };
    const flows = Array.from({ length: 45 }, (_, t) => 40_000 - (t < 15 ? 15_000 : 0));
    for (const timing of TIMINGS) {
      const engine = await requiredPortfolio({ ...plan, timing }, true);
      const pv = presentValue(flows, 0.03, timing);
      // Start of year: 825,730, the article's figure (the engine gave 825,413 before engine 0.5.0
      // capped the final withdrawal at what the account held when it was made).
      expect(Math.abs(engine / pv - 1), timing).toBeLessThan(1e-6);
    }
    const ex = await baristaNumbers({
      age: 45,
      spend: 40_000,
      pt: 15_000,
      ptUntil: 60,
      planTo: 90,
      ret: 3,
      tax: 0,
      timing: "end",
      cur: "USD",
    });
    expect(Math.abs(ex.barista - ex.formulaBarista)).toBeLessThan(1);
    expect(Math.abs(ex.full - ex.formulaFull)).toBeLessThan(1);
    expect(ex.shortcut).toBe(625_000);
  });

  it("Barista with a flat tax grosses up withdrawals only", async () => {
    const ex = await baristaNumbers({
      age: 50,
      spend: 30_000,
      pt: 10_000,
      ptUntil: 55,
      planTo: 85,
      ret: 2,
      tax: 20,
      timing: "end",
      cur: "USD",
    });
    const flows = Array.from({ length: 35 }, (_, t) => (30_000 - (t < 5 ? 10_000 : 0)) / 0.8);
    expect(Math.abs(ex.barista / presentValue(flows, 0.02, "end") - 1)).toBeLessThan(1e-6);
  });

  it("coast age formula handles a zero return", () => {
    expect(yearsToCoast(100_000, 50_000, 0, 1_000_000, 30, "end")).toBeCloseTo(18, 10);
  });
});
