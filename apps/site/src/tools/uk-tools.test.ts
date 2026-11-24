/**
 * The UK calculators: tax by hand against the engine's UK estimate, the pots against the future-value
 * formula, pension access and State Pension from core's data, and the claims the pages make about
 * their worked examples. No UK figure is typed here: expected values come from @glideworth/core.
 */
import { pickYear, UK_PENSION_ACCESS, UK_TAX_YEARS, ukStatePensionAge } from "@glideworth/core";
import { describe, expect, it } from "vitest";
import { runTool } from "./engine";
import { maxIncome, potsByFormula, readIsaPension, runComparison } from "./engine/isa-vs-pension";
import { START_YEAR } from "./engine/model";
import {
  type DrawdownInputs,
  firstYearTaxByHand,
  readDrawdown,
  runDrawdown,
} from "./engine/uk-drawdown";
import {
  fmtAge,
  statePensionAge,
  steadyPensionAccessAge,
  UK_SIMPLIFICATION_KEYS,
  ukSimplification,
  ukTaxFreeShare,
  WEEKS_PER_YEAR,
} from "./engine/uk-model";
import { SPECS } from "./specs";
import { defaults, fromQuery, toQuery } from "./state";
import type { Values } from "./types";

const Y = pickYear(UK_TAX_YEARS, START_YEAR);
const drawdown = (over: Partial<DrawdownInputs> = {}): DrawdownInputs => ({
  ...readDrawdown(defaults(SPECS["uk-drawdown"])),
  ...over,
});
const isaPension = (over: Values = {}) =>
  readIsaPension({ ...defaults(SPECS["isa-vs-pension"]), ...over });

describe("UK data comes from core", () => {
  it("the State Pension default is the full new State Pension of the first tax year", () => {
    expect(defaults(SPECS["uk-drawdown"]).sp).toBe(Y.statePension.fullNewWeekly);
    expect(defaults(SPECS["isa-vs-pension"]).sp).toBe(Y.statePension.fullNewWeekly);
  });

  it("State Pension age is core's, for someone born in January", () => {
    for (const age of [50, 60, 66, 70])
      expect(statePensionAge(age)).toBe(ukStatePensionAge(START_YEAR - age, 1));
  });

  it("pension access: open from the lower age if it stays open, else from the later age", () => {
    // Born long ago: open since the lower age.
    expect(steadyPensionAccessAge(70)).toBe(UK_PENSION_ACCESS.age);
    // Reaches the lower age shortly before the rise but is under the later age then: a break.
    const rises = UK_PENSION_ACCESS.laterFromYear;
    const age = UK_PENSION_ACCESS.age - (rises - START_YEAR) + 1;
    expect(steadyPensionAccessAge(age)).toBe(UK_PENSION_ACCESS.laterAge);
  });

  it("every simplification the pages quote exists in TAX_SIMPLIFICATIONS.uk", () => {
    for (const k of Object.keys(UK_SIMPLIFICATION_KEYS) as (keyof typeof UK_SIMPLIFICATION_KEYS)[])
      expect(ukSimplification(k), k).not.toBe("");
  });

  it("the tax-free share the pages print is the one the drawdown runs apply", () => {
    const share = ukTaxFreeShare();
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(1);
    const f = runDrawdown(drawdown()).rows[0]!;
    expect(f.taxFree / f.fromPot).toBeCloseTo(share, 9);
  });

  it("formats ages with months", () => {
    expect(fmtAge(67)).toBe("67");
    expect(fmtAge(66 + 3 / 12)).toBe("66 and 3 months");
    expect(fmtAge(66 + 1 / 12)).toBe("66 and 1 month");
  });
});

describe("UK pension drawdown", () => {
  it("first-year tax by hand equals the engine's estimate, both regions and both methods", () => {
    for (const region of ["ruk", "sct"] as const)
      for (const method of ["ufpls", "pcls"] as const)
        for (const income of [12_000, 25_000, 50_000, 120_000]) {
          const r = runDrawdown(drawdown({ region, method, income, pot: 2_000_000 }));
          const f = r.rows[0]!;
          const byHand = firstYearTaxByHand(f.fromPot - f.taxFree, region);
          expect(Math.abs(byHand - f.tax), `${region} ${method} ${income}`).toBeLessThan(0.01);
        }
  });

  it("with the State Pension in payment, it is taxed before the pot's withdrawal", () => {
    const r = runDrawdown(drawdown({ age: 75 }));
    const f = r.rows[0]!;
    expect(f.statePension).toBeCloseTo(drawdown().sp * WEEKS_PER_YEAR, 6);
    const byHand = firstYearTaxByHand(f.fromPot - f.taxFree + f.statePension, "ruk");
    expect(Math.abs(byHand - f.tax)).toBeLessThan(0.01);
  });

  it("pays the income after tax in full every year until it runs out", () => {
    const r = runDrawdown(drawdown());
    expect(Number.isFinite(r.years)).toBe(true);
    for (const row of r.rows.slice(0, Math.floor(r.years)))
      expect(row.net).toBeCloseTo(drawdown().income, 4);
    expect(r.rows[Math.floor(r.years)]!.net).toBeLessThan(drawdown().income);
  });

  it("tax-free cash with each withdrawal is the same share as the lump sum of the pot", () => {
    const u = runDrawdown(drawdown());
    const p = runDrawdown(drawdown({ method: "pcls" }));
    const share = u.rows[0]!.taxFree / u.rows[0]!.fromPot;
    // The engine crystallises the pot as it stands after the first year's growth.
    const d = drawdown();
    const grown = d.pot * (1 + d.realReturn) * (1 + d.inflation);
    expect(p.lump / grown).toBeCloseTo(share, 9);
    // The lump sum is spent, so what is left pays the income for less time.
    expect(p.years).toBeLessThan(u.years);
  });

  it("a larger pot lasts longer; no income lasts forever; no pot lasts no time", () => {
    expect(runDrawdown(drawdown({ pot: 400_000 })).years).toBeGreaterThan(
      runDrawdown(drawdown()).years,
    );
    expect(runDrawdown(drawdown({ income: 0 })).years).toBe(Number.POSITIVE_INFINITY);
    expect(runDrawdown(drawdown({ pot: 0, sp: 0 })).years).toBe(0);
  });

  it("explains, instead of a result, when the pension cannot yet be drawn", async () => {
    const age = UK_PENSION_ACCESS.age - 1;
    const vm = await runTool("uk-drawdown", { ...defaults(SPECS["uk-drawdown"]), age });
    expect(vm.figures).toEqual([]);
    expect(vm.headline).toContain("cannot be drawn");
  });

  it("states the simplifications that bear on it", async () => {
    const vm = await runTool("uk-drawdown", {
      ...defaults(SPECS["uk-drawdown"]),
      region: "sct",
    });
    for (const k of ["taxFreeCash", "calendar", "scotland"] as const)
      expect(vm.method).toContain(ukSimplification(k));
  });
});

describe("ISA vs pension", () => {
  it("each pot equals the future-value formula to the penny (relief grossed up)", () => {
    for (const timing of ["start", "mid", "end"])
      for (const infl of [0, 2.5]) {
        const d = isaPension({ timing, infl });
        const f = potsByFormula(d);
        expect(Math.abs(maxIncome(d, "isa").potAtRetirement - f.isa)).toBeLessThan(0.01);
        expect(Math.abs(maxIncome(d, "pension").potAtRetirement - f.pension)).toBeLessThan(0.01);
      }
  });

  it("relief at source adds the basic rate on the gross contribution every working year", () => {
    const d = isaPension();
    const ras = Y.pensions.reliefAtSourceRate;
    const r = maxIncome(d, "pension");
    expect(r.reliefAdded).toBeCloseTo(((d.save * ras) / (1 - ras)) * (d.retire - d.age), 4);
    expect(maxIncome(d, "isa").reliefAdded).toBe(0);
  });

  it("higher-rate relief lowers the tax on pay only above the basic-rate band", () => {
    const top = Y.income.personalAllowance + Y.income.basicRateBand;
    const basic = runComparison(isaPension({ salary: top - 5_000, infl: 0 }));
    expect(Math.abs(basic.isa.taxWorking - basic.pension.taxWorking)).toBeLessThan(0.01);
    const higher = runComparison(isaPension({ salary: top + 20_000, infl: 0 }));
    const d = higher.inputs;
    const gross = d.save / (1 - Y.pensions.reliefAtSourceRate);
    // The band is widened by the gross contribution: that much moves from the higher to the basic rate.
    expect(higher.isa.taxWorking - higher.pension.taxWorking).toBeCloseTo(
      gross * (Y.income.rates.higher - Y.income.rates.basic) * (d.retire - d.age),
      4,
    );
  });

  it("the income found is the most each pot pays in full: a pound more falls short", () => {
    const d = isaPension();
    for (const w of ["isa", "pension"] as const) {
      const r = maxIncome(d, w);
      for (const p of r.run.periods) {
        const e = p.expenses.filter((x) => x.sourceId === "income");
        for (const x of e)
          expect(x.funded).toBeGreaterThanOrEqual(x.requested - 1e-6 * x.requested);
      }
      expect(r.income).toBeGreaterThan(0);
    }
  });

  it("nothing saved gives the same income from both, the State Pension alone", () => {
    const r = runComparison(isaPension({ save: 0 }));
    expect(r.pension.income).toBe(r.isa.income);
    expect(r.pension.potAtRetirement).toBe(0);
  });

  it("the worked example's claims hold: the pension pays more at the default inputs", () => {
    const r = runComparison(isaPension());
    expect(r.pension.income).toBeGreaterThan(r.isa.income);
    expect(r.pension.potAtRetirement).toBeGreaterThan(r.isa.potAtRetirement);
    expect(r.pension.taxRetired).toBeGreaterThan(r.isa.taxRetired);
  });

  it("explains, instead of a result, when retiring before pension access", async () => {
    const v = { ...defaults(SPECS["isa-vs-pension"]), age: 30, retire: 50 };
    const vm = await runTool("isa-vs-pension", v);
    expect(vm.figures).toEqual([]);
    expect(vm.headline).toContain("cannot be drawn");
  });

  it("warns when saving exceeds the ISA allowance or the pay", async () => {
    const vm = await runTool("isa-vs-pension", {
      ...defaults(SPECS["isa-vs-pension"]),
      save: Y.isa.overall + 1_000,
      salary: Y.isa.overall,
    });
    expect(vm.warnings.join(" ")).toContain("ISA allowance");
    expect(vm.warnings.join(" ")).toContain("does not cover the saving");
  });
});

describe("UK tools' URLs", () => {
  it("round-trip every input, the pence of a weekly State Pension included", () => {
    for (const id of ["uk-drawdown", "isa-vs-pension"] as const) {
      const spec = SPECS[id];
      const v = { ...defaults(spec), sp: 203.85, region: "sct" };
      expect(fromQuery(spec, toQuery(spec, v)).values).toEqual(v);
    }
  });
});
