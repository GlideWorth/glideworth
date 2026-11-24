/**
 * The US retirement tax calculators (RMD, 72(t), IRMAA): every result is checked against the core
 * function that holds the rule, so a calculator cannot drift from Glideworth's US data.
 */
import {
  IRS_MORTALITY_RATES,
  irmaaMonthly,
  irmaaThresholds,
  seppAnnuityFactor,
  UNIFORM_LIFETIME,
  US_IRMAA_YEARS,
  usRequiredDistribution,
  usRmdStartAge,
} from "@glideworth/core";
import { describe, expect, it } from "vitest";
import { runTool } from "./engine";
import { LOOKBACK_YEARS, rangeText, rowsFor, tierOf, tiers } from "./engine/irmaa";
import { engineRmds, firstRmdYear, formulaRmds } from "./engine/rmd";
import { comparisonRates, seppPath, seppPayment } from "./engine/sepp";
import { TOOLS } from "./registry";
import { IRMAA_YEARS, SPECS } from "./specs";
import { defaults, fromQuery, toQuery, validate } from "./state";
import type { Values } from "./types";

const rmdV = (over: Values = {}) => ({ ...defaults(SPECS.rmd), ...over });
const seppV = (over: Values = {}) => ({ ...defaults(SPECS["sepp-72t"]), ...over });
const irmaaV = (over: Values = {}) => ({ ...defaults(SPECS.irmaa), ...over });

describe("RMD calculator", () => {
  it("the worked example: this year's RMD is core's usRequiredDistribution", async () => {
    const v = rmdV();
    const born = v.born as number;
    const year = v.year as number;
    const expected = usRequiredDistribution({
      accountType: "traditional-ira",
      rule: "us-rmd",
      year,
      ownerAge: year - born,
      priorYearEndBalance: v.balance as number,
      ownerBirthYear: born,
    });
    expect(expected).toBeCloseTo((v.balance as number) / UNIFORM_LIFETIME[year - born]!, 9);
    const rows = engineRmds(v);
    expect(rows[0]!.rmd).toBeCloseTo(expected, 6);
    expect(rows[0]!.factor).toBe(UNIFORM_LIFETIME[year - born]);
    const vm = await runTool("rmd", v);
    expect(vm.headline).toContain(`divided by ${UNIFORM_LIFETIME[year - born]}`);
  });

  it.each(["start", "mid", "end"])(
    "engine and year-by-year formula agree to the cent (%s timing)",
    (timing) => {
      for (const ret of [-5, 0, 4, 9]) {
        const v = rmdV({ timing, ret, born: 1960, year: 2026 });
        const e = engineRmds(v);
        const f = formulaRmds(v);
        expect(e).toHaveLength(f.length);
        e.forEach((row, i) => {
          expect(row.rmd, `${ret}% year ${row.year}`).toBeCloseTo(f[i]!.rmd, 2);
          expect(row.closing, `${ret}% year ${row.year}`).toBeCloseTo(f[i]!.closing, 2);
        });
      }
    },
  );

  it("RMDs begin in the year the owner reaches core's start age", () => {
    for (const born of [1959, 1960, 1964, 1970]) {
      const rows = engineRmds(rmdV({ born, year: Math.max(2024, born + 60) }));
      const first = rows.find((r) => r.rmd > 0)!;
      expect(first.year, String(born)).toBe(firstRmdYear(born));
      expect(first.age).toBeGreaterThanOrEqual(usRmdStartAge(born));
      const before = rows.find((r) => r.year === first.year - 1);
      if (before) expect(before.rmd).toBe(0);
    }
  });

  it("before the start age no RMD is due and the headline says when it starts", async () => {
    const vm = await runTool("rmd", rmdV({ born: 1965, year: 2026 }));
    expect(vm.headline).toMatch(/No RMD is due for 2026/);
    expect(vm.headline).toContain(String(firstRmdYear(1965)));
    expect(vm.figures[0]!.value).toBe("$0");
  });

  it("edge cases: no balance, age 120, every timing", async () => {
    for (const over of <Values[]>[
      { balance: 0 },
      { born: 1920, year: 2040 },
      { born: 2010, year: 2024 },
      { ret: -10, timing: "start" },
    ]) {
      const v = rmdV(over);
      expect(validate(SPECS.rmd, v)).toEqual({});
      const vm = await runTool("rmd", v);
      expect(JSON.stringify(vm)).not.toMatch(/NaN|Infinity/);
    }
    expect(validate(SPECS.rmd, rmdV({ born: 1920, year: 2041 })).born).toMatch(/120/);
  });
});

describe("72(t) calculator", () => {
  it("the payment is the balance divided by core's seppAnnuityFactor", async () => {
    const v = seppV();
    const f = seppAnnuityFactor(v.age as number, (v.interest as number) / 100);
    expect(seppPayment(v.balance as number, v.age as number, (v.interest as number) / 100)).toBe(
      (v.balance as number) / f,
    );
    const vm = await runTool("sepp-72t", v);
    expect(vm.figures[1]!.value).toBe(f.toFixed(4));
  });

  it("at 0% interest the factor is the sum of the survival chances from the IRS mortality rates", () => {
    let s = 1;
    let sum = 0;
    for (let t = 0; t < 200 && s > 1e-12; t++) {
      sum += s;
      s *= 1 - IRS_MORTALITY_RATES[Math.min(120, 50 + t)]!;
    }
    expect(seppAnnuityFactor(50, 0)).toBeCloseTo(sum, 9);
  });

  it("a lower rate or a younger age gives a smaller payment", () => {
    expect(seppPayment(500_000, 50, 0.04)).toBeLessThan(seppPayment(500_000, 50, 0.05));
    expect(seppPayment(500_000, 45, 0.05)).toBeLessThan(seppPayment(500_000, 50, 0.05));
    expect(comparisonRates(5)).toEqual([3, 3.5, 4, 4.5, 5]);
    expect(comparisonRates(0.5)).toEqual([0, 0.5]);
  });

  it("the balance path takes the payment at the start of each year, then grows", () => {
    const p = seppPath(100_000, 10_000, 2, 0.1, 50);
    expect(p[0]!.closing).toBeCloseTo(99_000, 9);
    expect(p[1]!.closing).toBeCloseTo(97_900, 9);
  });

  it("warns when the account cannot pay the full amount", async () => {
    const vm = await runTool("sepp-72t", seppV({ growth: -10, years: 40 }));
    expect(vm.warnings.join(" ")).toMatch(/cannot pay the full amount/);
    const zero = await runTool("sepp-72t", seppV({ balance: 0 }));
    expect(zero.headline).toMatch(/no payment/);
  });
});

describe("IRMAA calculator", () => {
  it("offers exactly the premium years in core's data", () => {
    expect([...IRMAA_YEARS]).toEqual(US_IRMAA_YEARS.map((y) => String(y.year)));
  });

  // Vectors just below, at and just above every threshold, for every year and filing status.
  const statuses = [
    "single",
    "married-joint",
    "married-separate",
    "head-of-household",
    "qualifying-surviving-spouse",
  ] as const;
  for (const t of US_IRMAA_YEARS)
    for (const status of statuses)
      it(`${t.year} ${status}: tier and surcharge match core at each threshold`, async () => {
        const thr = irmaaThresholds(status, 1, t);
        const all = tiers(status, t);
        expect(all).toHaveLength(thr.length + 1);
        thr.forEach((lo, i) => {
          expect(tierOf(lo - 1, status, t)).toBe(i);
          expect(tierOf(lo, status, t)).toBe(i);
          expect(tierOf(lo + 0.01, status, t)).toBe(i + 1);
          expect(all[i + 1]!.monthly).toBeCloseTo(irmaaMonthly(lo + 0.01, status, 1, t), 9);
          expect(all[i]!.monthly).toBeCloseTo(irmaaMonthly(lo, status, 1, t), 9);
          const row = rowsFor(status, t)[i]!;
          expect(all[i + 1]!.partBSurcharge + all[i + 1]!.partD).toBeCloseTo(
            row[1] - t.standardPartB + row[2],
            9,
          );
        });
        const magi = thr[0]! + 1;
        const vm = await runTool("irmaa", irmaaV({ magi, status, year: String(t.year) }));
        expect(vm.figures[0]!.value).toBe(`1 of ${thr.length}`);
        expect(vm.headline).toContain(`${t.year - LOOKBACK_YEARS} MAGI`);
      });

  it("a joint return with both spouses on Medicare pays twice the yearly surcharge", async () => {
    const t = US_IRMAA_YEARS[US_IRMAA_YEARS.length - 1]!;
    const magi = irmaaThresholds("married-joint", 1, t)[1]! + 1;
    const one = await runTool("irmaa", irmaaV({ magi, status: "married-joint", people: "1" }));
    const two = await runTool("irmaa", irmaaV({ magi, status: "married-joint", people: "2" }));
    const yearly = irmaaMonthly(magi, "married-joint", 1, t) * 12;
    expect(one.figures[2]!.value).toBe(`$${Math.round(yearly).toLocaleString("en-US")}`);
    expect(two.figures[2]!.value).toBe(`$${Math.round(yearly * 2).toLocaleString("en-US")}`);
  });

  it("states the distance to the next tier, and the top tier has none", async () => {
    const t = US_IRMAA_YEARS[0]!;
    const thr = irmaaThresholds("single", 1, t);
    const vm = await runTool(
      "irmaa",
      irmaaV({ magi: thr[0]! - 1000, status: "single", year: String(t.year) }),
    );
    expect(vm.figures[3]!.value).toBe("$1,000 away");
    const top = await runTool("irmaa", irmaaV({ magi: 5_000_000, year: String(t.year) }));
    expect(top.figures[3]!.value).toBe("None");
    expect(top.figures[0]!.value).toBe(`${thr.length} of ${thr.length}`);
  });

  it("writes tier ranges without rounding a cent-based bound up into a false limit", () => {
    const t = US_IRMAA_YEARS[0]!;
    const all = tiers("single", t);
    expect(rangeText(all[0]!)).toMatch(/^Up to \$/);
    expect(rangeText(all[all.length - 1]!)).toMatch(/ or more$|^More than/);
  });
});

describe("registry, specs and URL state", () => {
  it("each new tool is registered in the tax group with its spec's path", () => {
    for (const id of ["rmd", "sepp-72t", "irmaa"] as const) {
      const meta = TOOLS.find((t) => t.id === id)!;
      expect(meta.group).toBe("tax");
      expect(meta.path).toBe(SPECS[id].path);
    }
  });
  it("non-default values round-trip through the query string", () => {
    const cases: [keyof typeof SPECS, Values][] = [
      ["rmd", rmdV({ born: 1958, year: 2031, balance: 812_345, ret: 2.5, timing: "end" })],
      ["sepp-72t", seppV({ balance: 250_000, age: 47, interest: 4.75, years: 13, growth: 6.2 })],
      ["irmaa", irmaaV({ magi: 260_000, status: "married-joint", year: "2026", people: "1" })],
    ];
    for (const [id, v] of cases) {
      expect(validate(SPECS[id], v)).toEqual({});
      const back = fromQuery(SPECS[id], toQuery(SPECS[id], v));
      expect(back.invalid).toEqual([]);
      expect(back.values).toEqual(v);
    }
  });
});
