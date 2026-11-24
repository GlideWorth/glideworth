/**
 * The country calculators (UK FIRE, UK pension age, UAE gratuity): values checked against the core
 * functions and data they read, worked examples, URL round-trips and edge cases.
 */
import {
  AE_GRATUITY,
  AE_SAVINGS_SCHEME,
  aeGratuity,
  UK_PENSION_ACCESS,
  ukNormalMinimumPensionAge,
  ukStatePensionAge,
} from "@glideworth/core";
import { describe, expect, it } from "vitest";
import { balanceAfter, presentValue } from "./closed-form";
import { runTool } from "./engine";
import { START_YEAR } from "./engine/model";
import { CAP_YEARS, gratuityBreakdown, schemeValue } from "./engine/uae-gratuity";
import {
  FULL_STATE_PENSION,
  retirementRun,
  UK_YEAR,
  ukFire,
  WEEKS_PER_YEAR,
} from "./engine/uk-fire";
import { ukAges } from "./engine/uk-pension-age";
import { renderResults } from "./render";
import { SPECS } from "./specs";
import { defaults, fromQuery, toQuery, validate } from "./state";
import type { Values } from "./types";

const fire = (over: Values = {}) => ({ ...defaults(SPECS["uk-fire"]), ...over });

describe("UK pension age", () => {
  it("matches the core functions for every month from 1960 to 2010", () => {
    for (let y = 1960; y <= 2010; y++)
      for (let mo = 1; mo <= 12; mo++) {
        const a = ukAges(y, mo);
        expect(a.statePensionAge).toBe(ukStatePensionAge(y, mo));
        expect(a.firstAccessAge).toBe(ukNormalMinimumPensionAge(y, mo));
        expect(a.steadyAccessAge).toBeGreaterThanOrEqual(a.firstAccessAge);
        expect(a.statePensionMonth).toBe(y * 12 + mo - 1 + Math.round(a.statePensionAge * 12));
      }
  });

  it("finds the window lost when the minimum pension age rises", () => {
    const rise = UK_PENSION_ACCESS.laterFromYear * 12 + UK_PENSION_ACCESS.laterFromMonth - 1;
    // Just before, at and just after the birth month that reaches the lower age at the rise.
    const by = UK_PENSION_ACCESS.laterFromYear - UK_PENSION_ACCESS.age;
    const bm = UK_PENSION_ACCESS.laterFromMonth;
    const before = ukAges(by, bm - 1);
    expect(before.firstAccessAge).toBe(UK_PENSION_ACCESS.age);
    expect(before.gap).toEqual({
      from: rise,
      to: by * 12 + bm - 2 + UK_PENSION_ACCESS.laterAge * 12,
    });
    expect(before.steadyAccessAge).toBe(UK_PENSION_ACCESS.laterAge);
    const at = ukAges(by, bm);
    expect(at.firstAccessAge).toBe(UK_PENSION_ACCESS.laterAge);
    expect(at.gap).toBeNull();
    // Reaching the higher age by the rise: no gap.
    const older = ukAges(UK_PENSION_ACCESS.laterFromYear - UK_PENSION_ACCESS.laterAge, bm);
    expect(older.gap).toBeNull();
    expect(older.steadyAccessAge).toBe(UK_PENSION_ACCESS.age);
  });

  it("reports the ages and dates in the result", async () => {
    const vm = await runTool("uk-pension-age", { by: 1960, bm: "9" });
    const sp = ukStatePensionAge(1960, 9);
    expect(sp).toBeGreaterThan(66);
    expect(vm.headline).toContain(`${Math.floor(sp)} years ${Math.round((sp % 1) * 12)} months`);
    const vm2 = await runTool("uk-pension-age", { by: 1985, bm: "6" });
    expect(vm2.figures[0]!.value).toBe(`${ukStatePensionAge(1985, 6)} years`);
    expect(vm2.figures[1]!.value).toBe(`${ukNormalMinimumPensionAge(1985, 6)} years`);
    expect(vm2.table!.rows.map((r) => r[2])).toEqual([
      `June ${1985 + ukNormalMinimumPensionAge(1985, 6)}`,
      `June ${1985 + ukStatePensionAge(1985, 6)}`,
    ]);
    const gap = await runTool("uk-pension-age", { by: 1972, bm: "6" });
    expect(gap.table!.rows).toHaveLength(3);
    expect(gap.headline).toMatch(/protected pension age/);
  });
});

describe("UK FIRE", () => {
  const f = ukFire(fire());

  it("reads its ages and State Pension from core", () => {
    const by = START_YEAR - Number(fire().age);
    expect(f.birthYear).toBe(by);
    expect(f.statePensionAge).toBe(ukStatePensionAge(by, 1));
    expect(f.accessAge).toBe(ukNormalMinimumPensionAge(by, 1));
    expect(FULL_STATE_PENSION).toBeCloseTo(UK_YEAR.statePension.fullNewWeekly * WEEKS_PER_YEAR, 9);
    expect(f.statePension).toBeCloseTo((FULL_STATE_PENSION * Number(fire().sp)) / 100, 9);
  });

  it("saving phase agrees with the formula to the penny", () => {
    const v = fire();
    const n = Number(v.retire) - Number(v.age);
    const r = Number(v.ret) / 100;
    expect(f.isaAtRetire).toBeCloseTo(
      balanceAfter(Number(v.isa), Number(v.isaSave), r, n, "mid"),
      2,
    );
    expect(f.pensionAtRetire).toBeCloseTo(
      balanceAfter(Number(v.pension), Number(v.penSave), r, n, "mid"),
      2,
    );
  });

  it("the ISA needed for the bridge is the present value of the spending, for every timing", () => {
    for (const timing of ["start", "mid", "end"] as const) {
      const x = ukFire(fire({ timing }));
      const pv = presentValue(
        Array<number>(x.bridgeYears).fill(Number(fire().spend)),
        0.04,
        timing,
      );
      expect(x.bridgeYears).toBe(x.accessAge - x.retire);
      expect(Math.abs(x.isaNeeded - pv)).toBeLessThan(0.01);
      // Exactly that much pays the bridge; a pound less does not.
      const base = {
        birthYear: x.birthYear,
        startAge: x.retire,
        endAge: x.accessAge,
        pension: 0,
        spend: Number(fire().spend),
        statePension: 0,
        statePensionAge: x.statePensionAge,
        realReturn: 0.04,
        timing,
        region: "ENG",
      };
      expect(retirementRun({ ...base, isa: x.isaNeeded }).firstShortAge).toBeNull();
      expect(retirementRun({ ...base, isa: x.isaNeeded - 1 }).firstShortAge).not.toBeNull();
    }
  });

  it("the pension cannot be drawn before the pension age, so an empty ISA runs short at once", () => {
    const x = ukFire(fire({ isa: 0, isaSave: 0, pension: 5_000_000 }));
    expect(x.plan.firstShortAge).toBe(x.retire);
    expect(x.plan.pensionDrawn.slice(0, x.bridgeYears).every((w) => w === 0)).toBe(true);
    expect(x.fireAge).toBe(x.accessAge);
  });

  it("the FIRE age is the first stopping age with no year short", () => {
    expect(f.fireAge).not.toBeNull();
    expect(f.firePlan?.firstShortAge).toBeNull();
    const v = fire();
    const before = retirementRun({
      birthYear: f.birthYear,
      startAge: f.fireAge! - 1,
      endAge: f.planTo,
      isa: f.isaPath[f.fireAge! - 1 - f.age]!,
      pension: f.pensionPath[f.fireAge! - 1 - f.age]!,
      spend: Number(v.spend),
      statePension: f.statePension,
      statePensionAge: f.statePensionAge,
      realReturn: 0.04,
      timing: "mid",
      region: "ENG",
    });
    expect(before.firstShortAge).not.toBeNull();
  });

  it("pension needed pays exactly from the pension age with the State Pension, after tax", () => {
    const v = fire();
    const base = {
      birthYear: f.birthYear,
      startAge: f.pensionFrom,
      endAge: f.planTo,
      isa: 0,
      spend: Number(v.spend),
      statePension: f.statePension,
      statePensionAge: f.statePensionAge,
      realReturn: 0.04,
      timing: "mid" as const,
      region: "ENG",
    };
    expect(retirementRun({ ...base, pension: f.pensionNeededAtStart }).firstShortAge).toBeNull();
    expect(
      retirementRun({ ...base, pension: f.pensionNeededAtStart - 1 }).firstShortAge,
    ).not.toBeNull();
    expect(f.pensionNeededAtRetire).toBeCloseTo(
      f.pensionNeededAtStart / 1.04 ** (f.pensionFrom - f.retire),
      6,
    );
    expect(f.pensionCoastToday).toBeCloseTo(
      f.pensionNeededAtStart / 1.04 ** (f.pensionFrom - f.age),
      6,
    );
  });

  it("taxes pension withdrawals with the core personal allowance and basic rate, a quarter tax-free", () => {
    // Before State Pension age, one withdrawal inside the basic-rate band (2026 thresholds held in
    // today's money): tax = basic rate × (taxable share × withdrawal − personal allowance).
    const run = retirementRun({
      birthYear: START_YEAR - 57,
      startAge: 57,
      endAge: 60,
      isa: 0,
      pension: 1_000_000,
      spend: 30_000,
      statePension: 0,
      statePensionAge: 68,
      realReturn: 0,
      timing: "mid",
      region: "ENG",
    });
    const w = run.pensionDrawn[0]!;
    const t = run.tax[0]!;
    expect(w - t).toBeCloseTo(30_000, 2);
    expect(t).toBeCloseTo(
      UK_YEAR.income.rates.basic * (0.75 * w - UK_YEAR.income.personalAllowance),
      2,
    );
  });

  it("Scottish rates change the tax", () => {
    const eng = ukFire(fire());
    const sct = ukFire(fire({ region: "SCT" }));
    const i = eng.plan.ages.indexOf(eng.accessAge);
    expect(sct.plan.tax[i]).not.toBeCloseTo(eng.plan.tax[i]!, 0);
  });

  it("no bridge when stopping at or after the pension age", async () => {
    const vm = await runTool("uk-fire", fire({ retire: 60 }));
    expect(vm.figures[1]!.value).toBe("No gap");
    expect(vm.headline).toMatch(/no gap/);
  });

  it("warns about allowances (read from core) and the cohort that loses access at the rise", async () => {
    const vm = await runTool(
      "uk-fire",
      fire({ isaSave: UK_YEAR.isa.overall + 1, penSave: UK_YEAR.pensions.annualAllowance + 1 }),
    );
    expect(vm.warnings.join(" ")).toMatch(/ISA allowance/);
    expect(vm.warnings.join(" ")).toMatch(/annual allowance/);
    const gap = await runTool("uk-fire", fire({ age: 54, retire: 54 }));
    expect(gap.warnings.join(" ")).toMatch(/protected pension age/);
    expect((await runTool("uk-fire", fire())).warnings).toEqual([]);
  });

  it("validates the ages", () => {
    const s = SPECS["uk-fire"];
    expect(validate(s, fire({ retire: 30 })).retire).toBeDefined();
    expect(validate(s, fire({ planTo: 50 })).planTo).toBeDefined();
    expect(validate(s, fire({ age: 18, planTo: 110 })).planTo).toMatch(/80 years/);
    expect(validate(s, fire({ retire: 35 }))).toEqual({});
  });
});

describe("UAE gratuity", () => {
  it("is core's aeGratuity, and the tiers add up to it", () => {
    for (const years of [
      0,
      0.5,
      0.99,
      1,
      1.5,
      3,
      5,
      5.25,
      7,
      10,
      20,
      CAP_YEARS - 0.01,
      CAP_YEARS,
      30,
      60,
    ])
      for (const wage of [0, 1, 3_000, 10_000, 15_000, 123_456.78]) {
        const b = gratuityBreakdown(years, wage);
        expect(b.gratuity).toBe(aeGratuity(years, wage));
        expect(b.eligible ? Math.min(b.beforeCap, b.cap) : 0).toBeCloseTo(b.gratuity, 6);
      }
  });

  it("works the portal rule through the planning page's example", () => {
    // /planning/ae/: AED 10,000 a month for 8 years is 195 days, AED 65,000.
    const b = gratuityBreakdown(8, 10_000);
    expect(b.firstDays + b.laterDays).toBe(
      AE_GRATUITY.firstTierYears * AE_GRATUITY.daysFirstFiveYears +
        3 * AE_GRATUITY.daysAfterFiveYears,
    );
    expect(b.gratuity).toBeCloseTo(65_000, 6);
  });

  it("pays nothing under a year, and is capped at two years of basic wage", () => {
    expect(gratuityBreakdown(AE_GRATUITY.minYears - 0.01, 10_000).gratuity).toBe(0);
    expect(gratuityBreakdown(AE_GRATUITY.minYears, 10_000).gratuity).toBeGreaterThan(0);
    const cap = AE_GRATUITY.capYearsOfWage * 12 * 10_000;
    expect(aeGratuity(CAP_YEARS, 10_000)).toBeCloseTo(cap, 6);
    expect(gratuityBreakdown(CAP_YEARS + 0.5, 10_000).capped).toBe(true);
    expect(gratuityBreakdown(CAP_YEARS - 0.5, 10_000).capped).toBe(false);
  });

  it("the savings scheme at 0% is the core contribution rates times the wage", () => {
    const wage = 10_000;
    for (const years of [0.5, 3, 5, 7.5, 12]) {
      const expected =
        12 * wage * AE_SAVINGS_SCHEME.employerRateUnder5Years * Math.min(years, 5) +
        12 * wage * AE_SAVINGS_SCHEME.employerRateFrom5Years * Math.max(0, years - 5);
      for (const timing of ["start", "mid", "end"] as const) {
        const s = schemeValue(years, wage, 0, timing);
        expect(s.contributions).toBeCloseTo(expected, 6);
        expect(s.value).toBeCloseTo(expected, 4);
      }
    }
    expect(schemeValue(10, wage, 0.05, "mid").value).toBeGreaterThan(
      schemeValue(10, wage, 0, "mid").value,
    );
  });

  it("renders without NaN for odd inputs", async () => {
    for (const over of <Values[]>[
      { years: 0, wage: 0 },
      { years: 0.5 },
      { years: 60, wage: 10_000_000 },
      { ret: -10 },
      { years: 25.5, ret: 15 },
    ]) {
      const vm = await runTool("uae-gratuity", { ...defaults(SPECS["uae-gratuity"]), ...over });
      expect(renderResults(vm)).not.toMatch(/NaN|Infinity|undefined/);
    }
  });
});

describe("URL state of the country tools", () => {
  it("round-trips non-default values", () => {
    const cases: [keyof typeof SPECS, Values][] = [
      ["uk-fire", fire({ age: 41, retire: 52, region: "SCT", sp: 70, timing: "end" })],
      ["uk-pension-age", { by: 1977, bm: "11" }],
      [
        "uae-gratuity",
        { ...defaults(SPECS["uae-gratuity"]), years: 7.25, wage: 22_500, cur: "USD" },
      ],
    ];
    for (const [id, v] of cases) {
      const spec = SPECS[id];
      expect(validate(spec, v)).toEqual({});
      const back = fromQuery(spec, toQuery(spec, v));
      expect(back.invalid).toEqual([]);
      expect(back.values).toEqual(v);
    }
  });
  it("defaults to pounds for the UK and dirhams for the gratuity", () => {
    expect(defaults(SPECS["uk-fire"]).cur).toBe("GBP");
    expect(defaults(SPECS["uae-gratuity"]).cur).toBe("AED");
    expect(fromQuery(SPECS["uk-fire"], "?cur=USD").invalid).toEqual(["cur"]);
  });
});
