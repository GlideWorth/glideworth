/**
 * US Social Security claiming rules against official figures (all read 2026-11-26):
 *
 * - FRA: 20 CFR 404.409(a) table,
 *   https://www.ecfr.gov/current/title-20/chapter-III/part-404/subpart-E/section-404.409
 * - Reductions: 20 CFR 404.410(a) and (b), and SSA "Retirement Age and Benefit Reduction" (the table
 *   "Full Retirement and Age 62 Benefit By Year Of Birth"; ssa.gov refuses automated access, read from
 *   the Internet Archive copy of 2 Nov 2026),
 *   https://www.ssa.gov/benefits/retirement/planner/agereduction.html
 * - Delayed credits: 20 CFR 404.313(b)(2), and SSA "Delayed Retirement | Born in 1960" and "Born in
 *   1957" (archived copies of 2 Nov 2026 and 11 Aug 2026),
 *   https://www.ssa.gov/benefits/retirement/planner/1960-delay.html,
 *   https://www.ssa.gov/benefits/retirement/planner/1957-delay.html
 *
 * SSA's percentages are rounded ("Percentages are approximate due to rounding"), so they are checked
 * to the precision SSA prints.
 */
import { describe, expect, it } from "vitest";
import { ssClaimFactor, ssFullRetirementAge, ssSpousalFactor } from "../src/index.js";

const months = (fra: number, claim: number) => Math.round((fra - claim) * 12);

describe("full retirement age (20 CFR 404.409(a))", () => {
  // [birth year, FRA years, FRA months] on each side of every change in the table.
  const rows: [number, number, number][] = [
    [1937, 65, 0],
    [1938, 65, 2],
    [1939, 65, 4],
    [1942, 65, 10],
    [1943, 66, 0],
    [1954, 66, 0],
    [1955, 66, 2],
    [1956, 66, 4],
    [1957, 66, 6],
    [1958, 66, 8],
    [1959, 66, 10],
    [1960, 67, 0],
    [1990, 67, 0],
  ];
  for (const [born, y, m] of rows)
    it(`born ${born}: ${y} years ${m} months`, () => {
      expect(Math.round(ssFullRetirementAge(born) * 12)).toBe(y * 12 + m);
    });
});

describe("claiming at 62 (SSA table by year of birth)", () => {
  // [birth year, months between 62 and FRA, own reduction %, spouse reduction %], as SSA prints them.
  const rows: [number, number, number, number][] = [
    [1954, 48, 25.0, 30.0],
    [1955, 50, 25.83, 30.83],
    [1956, 52, 26.67, 31.67],
    [1957, 54, 27.5, 32.5],
    [1958, 56, 28.33, 33.33],
    [1959, 58, 29.17, 34.17],
    [1960, 60, 30.0, 35.0],
  ];
  for (const [born, early, own, spouse] of rows)
    it(`born ${born}: ${early} months early, own −${own}%, spouse −${spouse}%`, () => {
      const m = months(ssFullRetirementAge(born), 62);
      expect(m).toBe(early);
      expect((1 - ssClaimFactor(m)) * 100).toBeCloseTo(own, 2);
      expect((1 - ssSpousalFactor(m)) * 100).toBeCloseTo(spouse, 2);
    });

  it("SSA's dollar example: $1,000 at FRA is $700 at 62 for 1960 births; a $500 spouse's benefit is $325", () => {
    expect(1000 * ssClaimFactor(60)).toBeCloseTo(700, 9);
    expect(500 * ssSpousalFactor(60)).toBeCloseTo(325, 9);
  });

  it("20 CFR 404.410(a) worked example: 44 months early on $980.50 is a $228.78 reduction before rounding", () => {
    expect(980.5 * (1 - ssClaimFactor(44))).toBeCloseTo(228.78, 2);
  });

  it("20 CFR 404.410(b) worked example: a wife's $412.40 benefit 28 months early is reduced by $80.18 before rounding", () => {
    // 412.40 × 28 × 25/36 × .01 = 80.1889; the regulation prints it cut to the cent, $80.18.
    expect(412.4 * (1 - ssSpousalFactor(28))).toBeCloseTo(80.1889, 4);
  });
});

describe("around full retirement age", () => {
  it("one month early is 5/9 of 1% less (own) and 25/36 of 1% less (spouse)", () => {
    expect(ssClaimFactor(1)).toBeCloseTo(1 - 5 / 900, 12);
    expect(ssSpousalFactor(1)).toBeCloseTo(1 - 25 / 3600, 12);
  });
  it("at FRA both factors are 1", () => {
    expect(ssClaimFactor(0)).toBe(1);
    expect(ssSpousalFactor(0)).toBe(1);
  });
  it("one month late is 2/3 of 1% more; a spouse's benefit gets no credit", () => {
    expect(ssClaimFactor(-1)).toBeCloseTo(1 + 2 / 300, 12);
    expect(ssSpousalFactor(-1)).toBe(1);
  });
  it("36 months early is the last month at 5/9 of 1%: 20% less", () => {
    expect(ssClaimFactor(36)).toBeCloseTo(0.8, 12);
    expect(ssClaimFactor(37)).toBeCloseTo(0.8 - 5 / 1200, 12);
  });
});

describe("delayed retirement credits (SSA tables by year of birth)", () => {
  it("born 1960: 124% at 70 (36 months), 108% at 68, 100.7% one month after 67", () => {
    const fra = ssFullRetirementAge(1960);
    expect(ssClaimFactor(months(fra, 70)) * 100).toBeCloseTo(124, 9);
    expect(ssClaimFactor(months(fra, 68)) * 100).toBeCloseTo(108, 9);
    expect(ssClaimFactor(months(fra, 67 + 1 / 12)) * 100).toBeCloseTo(100.7, 1);
  });
  it("born 1957: 104% at 67 (6 months) and 128% at 70 (42 months)", () => {
    const fra = ssFullRetirementAge(1957);
    expect(ssClaimFactor(months(fra, 67)) * 100).toBeCloseTo(104, 9);
    expect(ssClaimFactor(months(fra, 70)) * 100).toBeCloseTo(128, 9);
  });
});
