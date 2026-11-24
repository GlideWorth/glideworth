/**
 * The US tax calculators (retirement tax, Roth conversion, ACA subsidy): their inputs match the
 * engine's tables, every figure agrees with core's own functions, worked examples, URL round-trips and
 * edge cases with no NaN or Infinity. Expected values are computed from core's data (which cites the
 * IRS and HHS sources), never typed in.
 */
import {
  acaApplicablePercentage,
  EstateSettings,
  federalPovertyLine,
  taxableSocialSecurity,
  US_ACA_YEARS,
  US_FEDERAL_YEARS,
  usFederalJurisdiction,
} from "@glideworth/core";
import { describe, expect, it } from "vitest";
import { runTool } from "./engine";
import { acaNumbers, creditAt, readAca } from "./engine/aca-subsidy";
import { retirementTax } from "./engine/retirement-tax";
import { fillTo, ladder, readRoth } from "./engine/roth-conversion";
import { acaYear, FILING_LABELS, federalFacts, federalYear, usTaxInput } from "./engine/us-tax";
import { renderResults } from "./render";
import { SPECS } from "./specs";
import { defaults, fromQuery, toQuery, validate } from "./state";
import type { SelectField, ToolId, Values, ViewModel } from "./types";

const IDS = ["retirement-tax", "roth-conversion", "aca-subsidy"] as const;
const select = (id: ToolId, key: string) =>
  SPECS[id].fields.find((f) => f.key === key) as SelectField;
const values = (id: ToolId, over: Values = {}): Values => ({ ...defaults(SPECS[id]), ...over });

function nonFinite(x: unknown, path = "vm"): string[] {
  if (typeof x === "number") return Number.isFinite(x) ? [] : [path];
  if (Array.isArray(x)) return x.flatMap((v, i) => nonFinite(v, `${path}[${i}]`));
  if (x && typeof x === "object")
    return Object.entries(x).flatMap(([k, v]) => nonFinite(v, `${path}.${k}`));
  return [];
}

async function clean(id: ToolId, over: Values): Promise<ViewModel> {
  const v = values(id, over);
  expect(validate(SPECS[id], v), `${id} ${JSON.stringify(over)}`).toEqual({});
  const vm = await runTool(id, v);
  expect(nonFinite(vm), `${id} ${JSON.stringify(over)}`).toEqual([]);
  expect(renderResults(vm)).not.toMatch(/NaN|Infinity|undefined|\[object Object\]/);
  expect(vm.headline.length).toBeGreaterThan(10);
  return vm;
}

describe("inputs match the engine's tables", () => {
  it("tax years are the published US federal and ACA years", () => {
    const fed = US_FEDERAL_YEARS.map((y) => String(y.year));
    const aca = US_ACA_YEARS.map((y) => String(y.year));
    for (const id of IDS) {
      const years = select(id, "year").options.map((o) => o.value);
      expect(years, id).toEqual(id === "aca-subsidy" ? aca : fed);
    }
  });
  it("filing statuses are the engine's, and the bracket choices are every rate but the top", () => {
    for (const id of ["retirement-tax", "roth-conversion"] as const)
      expect(
        select(id, "status")
          .options.map((o) => o.value)
          .sort(),
      ).toEqual(Object.keys(FILING_LABELS).sort());
    const offered = select("roth-conversion", "target").options.map((o) => Number(o.value) / 100);
    for (const y of US_FEDERAL_YEARS)
      for (const rows of Object.values(y.brackets))
        expect(rows.slice(0, -1).map(([, r]) => r)).toEqual(offered);
  });
  it("the default heir rate is the planner's", () => {
    const heir = SPECS["roth-conversion"].fields.find((f) => f.key === "heir");
    expect(heir?.default).toBe(EstateSettings.parse({}).heirTaxDeferredRate * 100);
  });
});

describe("retirement tax", () => {
  const d = federalYear(2026);

  it("one person under 65 with IRA withdrawals: 10% bracket vectors from the year's table", () => {
    const sd = d.standardDeduction.single;
    const [, r1] = d.brackets.single[0]!;
    const [top1, r2] = d.brackets.single[1]!;
    const base = { year: "2026", status: "single", age: 50, ss: 0, pen: 0, int: 0, qd: 0, roth: 0 };
    for (const [taxable, expected] of [
      [top1 - 1, (top1 - 1) * r1],
      [top1, top1 * r1],
      [top1 + 1, top1 * r1 + r2],
    ] as const) {
      const r = retirementTax({ ...base, ira: sd + taxable });
      expect(r.taxableIncome).toBeCloseTo(taxable, 6);
      expect(r.total).toBeCloseTo(expected, 6);
    }
    expect(retirementTax({ ...base, ira: sd }).total).toBe(0);
  });

  it("agrees with the engine's federal plug-in and its taxable Social Security rule", () => {
    const v = values("retirement-tax");
    const r = retirementTax(v);
    const out = usFederalJurisdiction.computeYear(r.input, []);
    expect(r.total).toBeCloseTo(
      out.lines.reduce((s, l) => s + l.amount, 0),
      6,
    );
    const other = Number(v.ira) + Number(v.pen) + Number(v.int) + Number(v.qd);
    expect(r.taxableSs).toBeCloseTo(taxableSocialSecurity(Number(v.ss), other, "married-joint"), 6);
    // Age deductions: two people at or over 65 on a joint return (core's additional amounts).
    expect(r.deduction).toBe(d.standardDeduction["married-joint"] + 2 * d.additionalAged.married);
    expect(r.effective).toBeCloseTo(r.total / r.totalIncome, 12);
  });

  it("Roth withdrawals never change the tax", () => {
    const a = retirementTax(values("retirement-tax", { roth: 0 }));
    const b = retirementTax(values("retirement-tax", { roth: 500_000 }));
    expect(b.total).toBeCloseTo(a.total, 9);
  });

  it("the view model shows the engine's numbers", async () => {
    const vm = await runTool("retirement-tax", values("retirement-tax"));
    const r = retirementTax(values("retirement-tax"));
    expect(vm.figures[0]!.value).toBe(`$${Math.round(r.total).toLocaleString("en-US")}`);
    expect(vm.charts.map((c) => c.id)).toEqual([
      "retirement-tax-brackets",
      "retirement-tax-marginal",
    ]);
  });
});

describe("Roth conversion", () => {
  it("with no other income the conversion is the top of the bracket plus the deductions", () => {
    for (const year of [2026, 2027]) {
      const d = federalYear(year);
      const i = readRoth(
        values("roth-conversion", { year: String(year), status: "single", age: 55, ss: 0 }),
      );
      const idx = d.brackets.single.findIndex(([, r]) => r === i.target);
      const top = d.brackets.single[idx + 1]![0];
      const f = fillTo(i);
      expect(Math.abs(f.amount - (top + d.standardDeduction.single))).toBeLessThanOrEqual(1);
      // Tax on it: the bracket table itself.
      let tax = 0;
      for (let k = 0; k <= idx; k++) {
        const [from, r] = d.brackets.single[k]!;
        tax += (Math.min(top, d.brackets.single[k + 1]![0]) - from) * r;
      }
      expect(f.tax).toBeCloseTo(tax, -1);
      // One dollar more lands in the next bracket.
      const over = federalFacts(
        usTaxInput({
          year,
          status: "single",
          ages: [55],
          income: [{ id: "c", character: "ordinary", amount: f.amount + 2 }],
        }),
      );
      expect(over["tax.ordinaryBracketRate"]).toBeGreaterThan(i.target);
    }
  });

  it("Social Security already paid shrinks the room, as taxable benefits rise with the conversion", () => {
    const young = fillTo(readRoth(values("roth-conversion", { age: 60, age2: 60 })));
    const older = fillTo(readRoth(values("roth-conversion", { age: 67, age2: 67 })));
    expect(older.amount).toBeLessThan(young.amount);
    expect(older.average).toBeGreaterThan(0);
  });

  it("income already past the bracket leaves no room", async () => {
    const vm = await clean("roth-conversion", { inc: 600_000, target: "12" });
    expect(vm.headline).toMatch(/already reaches past/);
    expect(vm.figures[0]!.value).toBe("$0");
  });

  it("the ladder's first conversion is this year's amount, and it stops after the chosen years", () => {
    const i = readRoth(values("roth-conversion", { years: 3 }));
    const { none, convert } = ladder(i);
    expect(convert.converted[0]).toBeCloseTo(fillTo(i).amount, -1);
    expect(convert.converted.slice(3).every((x) => x === 0)).toBe(true);
    expect(none.totalConverted).toBe(0);
    expect(convert.totalConverted).toBeGreaterThan(0);
    // The default case: conversions at 12% beat leaving the balance for required distributions.
    const def = ladder(readRoth(values("roth-conversion")));
    expect(def.convert.endAfterTax).toBeGreaterThan(def.none.endAfterTax);
    expect(def.none.totalRmd).toBeGreaterThan(def.convert.totalRmd);
  });

  it("the conversion is capped at the traditional balance", async () => {
    const vm = await clean("roth-conversion", { trad: 10_000 });
    expect(vm.figures[0]!.value).toBe("$10,000");
  });
});

describe("ACA subsidy", () => {
  it("credit = benchmark − applicable percentage × MAGI, from core's poverty line and table", () => {
    for (const year of [2026, 2027])
      for (const size of [1, 2, 4])
        for (const mult of [1, 1.4, 2.2, 3.5, 3.99]) {
          const row = acaYear(year);
          const fpl = federalPovertyLine(size, 1, row);
          const magi = mult * fpl;
          const i = readAca(
            values("aca-subsidy", { year: String(year), size, magi, bench: 1_500 }),
          );
          const p = acaApplicablePercentage(magi / fpl, false, row)!;
          expect(creditAt(i, magi)).toBeCloseTo(Math.max(0, 18_000 - p * magi), 6);
        }
  });

  it("no credit below the floor or past the cliff; just below the cliff there is one", () => {
    const row = acaYear(2026);
    const i = readAca(values("aca-subsidy", { size: 2 }));
    const fpl = federalPovertyLine(2, 1, row);
    expect(creditAt(i, fpl * row.floor - 1)).toBe(0);
    expect(creditAt(i, fpl * row.floor)).toBeGreaterThan(0);
    expect(creditAt(i, fpl * row.cliff)).toBeGreaterThan(0);
    expect(creditAt(i, fpl * (row.cliff + 0.01) + 1)).toBe(0);
    const r = acaNumbers(i);
    expect(r.cliff).toBe(true);
    expect(creditAt(i, r.endMagi!)).toBeGreaterThan(0);
    expect(creditAt(i, r.endMagi! + 1)).toBe(0);
    expect(r.headroom).toBeCloseTo(r.endMagi! - i.magi, 6);
  });

  it("a small benchmark premium runs out before the cliff, without a jump", () => {
    const r = acaNumbers(readAca(values("aca-subsidy", { bench: 300, magi: 30_000 })));
    expect(r.cliff).toBe(false);
    expect(r.endMagi).not.toBeNull();
    expect(r.per1000).toBeGreaterThan(0);
  });

  it("the worked example's numbers come from the plug-in", async () => {
    const vm = await runTool("aca-subsidy", values("aca-subsidy"));
    const r = acaNumbers(readAca(values("aca-subsidy")));
    expect(vm.figures[0]!.detail).toBe(`$${Math.round(r.credit).toLocaleString("en-US")} a year`);
    expect(r.credit).toBeCloseTo(18_000 - r.applicable! * 60_000, 6);
  });
});

describe("URL round-trip and edge cases", () => {
  it.each(IDS)("%s: non-default values round-trip through the query string", (id) => {
    const v = values(
      id,
      id === "aca-subsidy"
        ? { year: "2027", size: 4, magi: 123_456, bench: 2_222, plan: 999 }
        : id === "roth-conversion"
          ? { year: "2027", status: "single", target: "24", ss: 0, years: 3, heir: 30 }
          : { year: "2027", status: "head-of-household", ira: 12_345, roth: 0 },
    );
    expect(fromQuery(SPECS[id], toQuery(SPECS[id], v)).values).toEqual(v);
  });

  it("zero income, zero balances and zero premiums", async () => {
    await clean("retirement-tax", { ss: 0, ira: 0, pen: 0, int: 0, qd: 0, roth: 0 });
    await clean("roth-conversion", { trad: 0, taxable: 0, rbal: 0, spend: 0, ss: 0 });
    await clean("roth-conversion", { taxable: 0, spend: 200_000 });
    const a = await clean("aca-subsidy", { magi: 0 });
    expect(a.warnings.join(" ")).toMatch(/below/);
    await clean("aca-subsidy", { bench: 0, plan: 0 });
  });

  it("very large incomes and every filing status", async () => {
    for (const status of Object.keys(FILING_LABELS)) {
      await clean("retirement-tax", { status, ira: 900_000_000, qd: 50_000_000 });
      await clean("roth-conversion", { status, inc: 2_000_000, target: "35" });
    }
    await clean("aca-subsidy", { magi: 1_000_000_000, size: 10 });
  });

  it("long and short ladders", async () => {
    await clean("roth-conversion", { age: 30, planTo: 110, years: 40, ret: -5 });
    await clean("roth-conversion", { age: 99, planTo: 100, years: 1, ssAge: 62 });
  });
});
