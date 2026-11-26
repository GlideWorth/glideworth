/**
 * Social Security break-even calculator. Expected values come from official worked figures (read
 * 2026-11-26; ssa.gov refuses automated access, so its pages were read from Internet Archive copies):
 *
 * - SSA "Retirement Age and Benefit Reduction" (agereduction.html): FRA, months from 62, and at 62 a
 *   $1,000 benefit and a $500 spouse's benefit by year of birth (1960 and later: $700 and $325; 1957:
 *   $725 and $337; 1955: $741 and $345).
 * - SSA "Delayed Retirement | Born in 1960" (1960-delay.html): 108% at 68, 124% at 70; "Born in 1957"
 *   (1957-delay.html): 104% at 67, 128% at 70.
 * - 20 CFR 404.409(a) for FRA, 404.333 (spouse: half the PIA), 404.338(c) (survivor: the larger of the
 *   reduced benefit and 82.5% of the PIA), 404.411(d) (spousal excess over the own PIA).
 */
import { ssClaimFactor, ssFullRetirementAge, ssSpousalFactor } from "@glideworth/core";
import { describe, expect, it } from "vitest";
import { runTool } from "./engine";
import {
  breakEvenAge,
  breakEvenFormula,
  claimAges,
  cumulativeByMonth,
  monthsEarly,
  ownMonthly,
  spousalTopUp,
  survivorBenefit,
  survivorKeeps,
  topUpStartAge,
} from "./engine/social-security";
import { toolMeta } from "./registry";
import { SPECS } from "./specs";
import { defaults, fromQuery, toQuery, validate } from "./state";
import type { Values } from "./types";

const ssV = (over: Values = {}) => ({ ...defaults(SPECS["social-security"]), ...over });
const p = (born: number, pia = 1_000) => ({ born, pia });

describe("monthly benefit at each claiming age (SSA tables)", () => {
  // [born, $1,000 at 62 (SSA, whole dollars), FRA in months]
  const at62: [number, number, number][] = [
    [1955, 741, 66 * 12 + 2],
    [1956, 733, 66 * 12 + 4],
    [1957, 725, 66 * 12 + 6],
    [1958, 716, 66 * 12 + 8],
    [1959, 708, 66 * 12 + 10],
    [1960, 700, 67 * 12],
    [1990, 700, 67 * 12],
  ];
  for (const [born, dollars, fraMonths] of at62)
    it(`born ${born}: FRA ${Math.floor(fraMonths / 12)}y${fraMonths % 12}m, $1,000 becomes $${dollars} at 62`, () => {
      expect(Math.round(ssFullRetirementAge(born) * 12)).toBe(fraMonths);
      expect(Math.floor(ownMonthly(p(born), 62))).toBe(dollars);
    });

  it("born 1959 and 1960 sit on each side of the last FRA change: 58 and 60 months from 62", () => {
    expect(monthsEarly(1959, 62)).toBe(58);
    expect(monthsEarly(1960, 62)).toBe(60);
  });

  it("born 1960: one month before FRA, at FRA, one month after, at 68 and at 70", () => {
    const x = p(1960);
    expect(ownMonthly(x, 67 - 1 / 12)).toBeCloseTo(1000 * (1 - 5 / 900), 9);
    expect(ownMonthly(x, 67)).toBeCloseTo(1000, 9);
    expect(ownMonthly(x, 67 + 1 / 12)).toBeCloseTo(1006.67, 2); // SSA: 100.7%
    expect(ownMonthly(x, 68)).toBeCloseTo(1080, 9); // SSA: 108.0%
    expect(ownMonthly(x, 70)).toBeCloseTo(1240, 9); // SSA: 124.0%
  });

  it("born 1957: 104% at 67 and 128% at 70", () => {
    expect(ownMonthly(p(1957), 67)).toBeCloseTo(1040, 9);
    expect(ownMonthly(p(1957), 70)).toBeCloseTo(1280, 9);
  });
});

describe("spouse's benefit (SSA table: a $500 spouse's benefit at 62)", () => {
  // The spouse has no own benefit, so the top-up is the whole spouse's benefit.
  const rows: [number, number][] = [
    [1955, 345],
    [1957, 337],
    [1959, 329],
    [1960, 325],
  ];
  for (const [born, dollars] of rows)
    it(`spouse born ${born} claiming at 62 on a $1,000 record: $${dollars}`, () => {
      const worker = p(born - 2);
      const spouse = p(born, 0);
      expect(Math.floor(spousalTopUp(spouse, 62, worker, 62))).toBe(dollars);
    });

  it("the top-up is half the worker's PIA less the spouse's own PIA, unreduced at the spouse's FRA", () => {
    expect(spousalTopUp(p(1964, 300), 67, p(1964, 1000), 67)).toBeCloseTo(200, 9);
    expect(spousalTopUp(p(1964, 500), 67, p(1964, 1000), 67)).toBe(0);
    expect(spousalTopUp(p(1964, 600), 67, p(1964, 1000), 67)).toBe(0);
  });

  it("the worker's delayed credits do not raise it", () => {
    expect(spousalTopUp(p(1964, 0), 67, p(1964, 1000), 70)).toBeCloseTo(500, 9);
  });

  it("a spouse claiming early: reduced by 25/36 of 1% a month for 36 months, then 5/12 of 1%", () => {
    // Spouse born 1964 (FRA 67) claims at 64, worker already claimed: 36 months early.
    expect(spousalTopUp(p(1964, 0), 64, p(1960, 1000), 62)).toBeCloseTo(500 * 0.75, 9);
    expect(spousalTopUp(p(1964, 0), 63, p(1960, 1000), 62)).toBeCloseTo(
      500 * ssSpousalFactor(48),
      9,
    );
  });

  it("starts when both have claimed, reduced only for the months before FRA left then", () => {
    // Spouse born 1966 claims own at 62 in 2028; worker born 1960 claims at 70 in 2030, when the spouse is 64.
    const spouse = p(1966, 200);
    const worker = p(1960, 1000);
    expect(topUpStartAge(spouse, 62, worker, 70)).toBe(64);
    expect(spousalTopUp(spouse, 62, worker, 70)).toBeCloseTo(300 * ssSpousalFactor(36), 9);
  });
});

describe("survivor's benefit (20 CFR 404.338)", () => {
  it("claimed at or after FRA: the deceased's benefit with delayed credits", () => {
    expect(survivorBenefit(p(1960), 67)).toBeCloseTo(1000, 9);
    expect(survivorBenefit(p(1960), 70)).toBeCloseTo(1240, 9);
  });
  it("claimed early: never below 82.5% of the PIA", () => {
    // At 62 the deceased got 700; the survivor gets 825.
    expect(survivorBenefit(p(1960), 62)).toBeCloseTo(825, 9);
    // One month before FRA the reduced benefit (994.44) is above the floor.
    expect(survivorBenefit(p(1960), 67 - 1 / 12)).toBeCloseTo(1000 * (1 - 5 / 900), 9);
  });
  it("the survivor keeps the larger of their own benefit and the survivor benefit", () => {
    expect(survivorKeeps(p(1962, 500), 67, p(1960, 1000), 70)).toBeCloseTo(1240, 9);
    expect(survivorKeeps(p(1962, 1500), 67, p(1960, 1000), 70)).toBeCloseTo(1500, 9);
  });
});

describe("break-even", () => {
  it("62 vs 70 for FRA 67: the formula gives 80.37, the month count 80 years 5 months", () => {
    // 0.70 (A − 62) = 1.24 (A − 70) → A = (86.8 − 43.4) / 0.54
    expect(breakEvenFormula(1960, 62, 70)).toBeCloseTo(43.4 / 0.54, 9);
    expect(breakEvenAge(p(1960, 2000), 62, 70)! * 12).toBeCloseTo(80 * 12 + 5, 6);
  });

  it("does not depend on the size of the benefit without discounting", () => {
    expect(breakEvenAge(p(1964, 900), 62, 67)).toBeCloseTo(breakEvenAge(p(1964, 3500), 62, 67)!, 9);
  });

  it("is the first whole month at or after the formula, for every pair of claiming ages", () => {
    for (const born of [1955, 1957, 1959, 1960, 1975])
      for (let a = 62; a < 70; a++)
        for (let b = a + 1; b <= 70; b++) {
          const f = breakEvenFormula(born, a, b);
          const e = breakEvenAge(p(born), a, b)!;
          expect(e).toBeGreaterThanOrEqual(f - 1e-9);
          expect(e - f).toBeLessThan(1 / 12 + 1e-9);
        }
  });

  it("a discount rate pushes it later; a high one means waiting never catches up", () => {
    const plain = breakEvenAge(p(1960), 62, 70)!;
    const d3 = breakEvenAge(p(1960), 62, 70, { cola: 0, discount: 0.03 })!;
    expect(d3).toBeGreaterThan(plain);
    expect(breakEvenAge(p(1960), 62, 70, { cola: 0, discount: 0.1 })).toBeNull();
  });

  it("cumulative totals: claiming at 62 has paid 12 × monthly by 63; a later claim nothing before it", () => {
    const c62 = cumulativeByMonth(700, 62);
    expect(c62[12]).toBeCloseTo(8400, 9);
    const c70 = cumulativeByMonth(1240, 70);
    expect(c70[8 * 12]).toBe(0);
    expect(c70[8 * 12 + 1]).toBeCloseTo(1240, 9);
  });

  it("cost-of-living increases step once a year from 62", () => {
    const c = cumulativeByMonth(1000, 62, { cola: 0.1, discount: 0 }, 64);
    expect(c[12]).toBeCloseTo(12_000, 9);
    expect(c[24]).toBeCloseTo(12_000 + 13_200, 9);
  });
});

describe("the calculator", () => {
  it("compares 62, FRA and 70, plus the visitor's age when it is none of them", () => {
    expect(claimAges(1960, 65)).toEqual([62, 65, 67, 70]);
    expect(claimAges(1960, 67)).toEqual([62, 67, 70]);
    expect(claimAges(1957, 67)).toEqual([62, 66.5, 67, 70]);
  });

  it("the defaults: born 1964, $2,000 at FRA 67", async () => {
    const vm = await runTool("social-security", ssV());
    expect(vm.headline).toContain("$1,400");
    expect(vm.headline).toContain("$2,000");
    expect(vm.headline).toContain("$2,480");
    expect(vm.headline).toContain("80 years 5 months");
    expect(vm.charts[0]!.series).toHaveLength(4);
    expect(vm.charts[0]!.x[0]).toBe(62);
    expect(vm.charts[0]!.x.at(-1)).toBe(100);
    // Every value finite, and every series rises (or stays flat) with age.
    for (const s of vm.charts[0]!.series) {
      const vals = s.values as number[];
      for (let i = 1; i < vals.length; i++) expect(vals[i]!).toBeGreaterThanOrEqual(vals[i - 1]!);
    }
  });

  it("with a spouse: figures for the top-up and the survivor, and the couple table", async () => {
    const vm = await runTool(
      "social-security",
      ssV({ spouse: "yes", sborn: 1966, spia: 800, sclaim: 67, claim: 70 }),
    );
    const top = vm.figures.find((f) => f.label.startsWith("Spousal top-up"))!;
    // Half of 2,000 less 800 = 200, unreduced: the spouse claims at FRA 67 and the top-up starts at 68.
    expect(top.value).toBe("$200 a month");
    const surv = vm.figures.find((f) => f.label.startsWith("Your spouse keeps"))!;
    expect(surv.value).toBe("$2,480 a month");
    const couple = vm.extraTables!.at(-1)!;
    expect(couple.columns[0]).toBe("You claim at");
    // You at 62: the survivor gets 82.5% of 2,000.
    expect(couple.rows[0]![3]).toBe("$1,650");
  });

  it("a spouse claiming early on the default record", async () => {
    const vm = await runTool(
      "social-security",
      ssV({ spouse: "yes", sborn: 1966, spia: 0, sclaim: 62, claim: 62 }),
    );
    // Spouse born 1966 claims at 62 when you are 64 and have claimed: 60 months early, 35% less on 1,000.
    const top = vm.figures.find((f) => f.label.startsWith("Spousal top-up"))!;
    expect(top.value).toBe("$650 a month");
    expect(ssSpousalFactor(60)).toBeCloseTo(0.65, 12);
  });

  it("round-trips its inputs through the URL and validates ranges", () => {
    const spec = SPECS["social-security"];
    const v = ssV({ spouse: "yes", sborn: 1970, spia: 1234, claim: 68, cola: 2.5, disc: 3 });
    expect(fromQuery(spec, toQuery(spec, v)).values).toEqual(v);
    expect(validate(spec, ssV({ born: 1950 })).born).toBeTruthy();
    expect(validate(spec, ssV({ claim: 71 })).claim).toBeTruthy();
    expect(validate(spec, ssV())).toEqual({});
  });

  it("is registered for the index and uses the break-even keyword in its path", () => {
    const meta = toolMeta("social-security");
    expect(meta.path).toBe("/tools/social-security-break-even-calculator/");
    expect(SPECS["social-security"].path).toBe(meta.path);
  });

  it("uses core's rules, not copies", () => {
    for (const born of [1955, 1960, 1980])
      for (const age of [62, 63.5, 66, 67, 68, 70])
        expect(ownMonthly(p(born, 1500), age)).toBeCloseTo(
          1500 * ssClaimFactor(Math.round((ssFullRetirementAge(born) - age) * 12)),
          9,
        );
  });
});
