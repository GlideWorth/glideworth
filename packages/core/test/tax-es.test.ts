/**
 * Spain vectors: IRPF 2025 state and regional scales (AEAT Manual práctico de Renta 2025),
 * 2026 social security. Hand-worked following the AEAT method (scale on the base minus the scale
 * on the mínimo personal y familiar); working inline.
 */
import { describe, expect, it } from "vitest";
import { ES_YEARS } from "../src/tax/data/es.js";
import { esJurisdiction, esRegion, esWorkReduction } from "../src/tax/jurisdictions/es.js";
import { createDefaultTaxRegistry, defaultStackIds } from "../src/tax/registry.js";
import { sumKind, sumLabel, taxInput, total } from "./tax-helpers.js";

const d = ES_YEARS[0]!;
const es = (region: string | undefined, o: Parameters<typeof taxInput>[0]) => {
  const j = region ? esJurisdiction.parameterize!(region) : esJurisdiction;
  return j.computeYear(taxInput({ country: "ES", year: 2026, ...o }), []);
};
const wage = (amount: number) => ({ income: [{ character: "wage" as const, amount }] });

describe("Spain: employees (single, 40, no children)", () => {
  it("low, 18,000 (default region): SS 6.5% = 1,170; work-income reduction 7,302; base 7,528; 9.5% x (7,528 - 5,550) per half = 187.91", () => {
    // net work income 18,000 - 1,170 - 2,000 = 14,830 <= 14,852 -> reduction 7,302
    const o = es(undefined, wage(18_000));
    expect(sumLabel(o, /Seguridad Social/)).toBeCloseTo(1_170, 6);
    expect(o.facts["es.baseGeneral.p1"]).toBeCloseTo(7_528, 6);
    expect(sumLabel(o, /cuota estatal/)).toBeCloseTo(187.91, 6);
    expect(sumLabel(o, /cuota autonómica/)).toBeCloseTo(187.91, 6);
  });

  it("median, 30,000 in Madrid: base 26,050; state 2,463.00; Madrid scale 2,169.58", () => {
    const o = es("MD", wage(30_000));
    expect(o.facts["es.baseGeneral.p1"]).toBeCloseTo(26_050, 6);
    expect(sumLabel(o, /cuota estatal/)).toBeCloseTo(2_463, 6);
    expect(sumLabel(o, /Comunidad de Madrid/)).toBeCloseTo(2_169.58393, 4);
    expect(o.facts["tax.ordinaryBracketRate"]).toBeCloseTo(0.15 + 0.128, 12);
  });

  it("high, 80,000 in Cataluña: SS capped at the 61,214.40 maximum base; state 11,578.24; Cataluña 11,927.28", () => {
    const o = es("CT", wage(80_000));
    expect(sumLabel(o, /Seguridad Social/)).toBeCloseTo(0.065 * 61_214.4, 6);
    expect(sumLabel(o, /cuota estatal/)).toBeCloseTo(11_578.2394, 4);
    expect(sumLabel(o, /Cataluña/)).toBeCloseTo(11_927.27876, 4);
  });

  it("very high, 400,000: top state rate 24.5%; 49% combined with the default regional mirror", () => {
    const o = es(undefined, wage(400_000));
    expect(sumLabel(o, /cuota estatal/)).toBeCloseTo(85_458.66068, 4);
    expect(o.facts["tax.ordinaryBracketRate"]).toBeCloseTo(0.49, 12);
  });

  it("regional hook: Andalucía, Valencia and aliases resolve; unknown names are rejected", () => {
    expect(esRegion("Andalucia").code).toBe("AN");
    expect(esRegion("ES-VC").code).toBe("VC");
    expect(esRegion("GA").code).toBe("DEFAULT");
    expect(() => esRegion("Atlantis")).toThrow();
    const vc = es("VC", wage(30_000));
    // Valencia: 1,080 + 1,200 (12,000-22,000 at 12%) + 15% x 4,050 = 2,887.50 less 9% x 5,550 = 499.50
    expect(sumLabel(vc, /Comunitat Valenciana/)).toBeCloseTo(2_887.5 - 499.5, 6);
    expect(defaultStackIds({ country: "ES", region: "MD" })).toEqual(["es:MD"]);
    expect(createDefaultTaxRegistry().get("es:AN").id).toBe("es:AN");
  });

  it("work-income reduction phases out between 14,852 and 19,747.50", () => {
    expect(esWorkReduction(d, 14_852, 0)).toBe(7_302);
    expect(esWorkReduction(d, 16_000, 0)).toBeCloseTo(7_302 - 1.75 * 1_148, 6);
    expect(esWorkReduction(d, 19_747.5, 0)).toBe(0);
    expect(esWorkReduction(d, 14_000, 7_000)).toBe(0);
  });
});

describe("Spain: savings, pension plans, retirees, wealth tax", () => {
  it("savings base: 20,000 dividends alone; the 5,550 minimum moves to the savings base -> 2 x (2,040 - 527.25) = 3,025.50", () => {
    const o = es(undefined, { income: [{ character: "qualified-dividend", amount: 20_000 }] });
    expect(sumKind(o, "dividends")).toBeCloseTo(3_025.5, 6);
    expect(sumLabel(o, /cuota/)).toBe(0);
  });

  it("pension plan contribution limited to 1,500", () => {
    const o = es("MD", {
      ...wage(30_000),
      deductions: [{ amount: 3_000, accountType: "es-plan-pensiones" }],
    });
    expect(o.facts["es.baseGeneral.p1"]).toBeCloseTo(26_050 - 1_500, 6);
    expect(
      esJurisdiction.contributionLimit!({
        accountType: "es-plan-pensiones",
        year: 2026,
        ownerAge: 40,
        priceIndex: 1,
        earnedIncome: 50_000,
      }),
    ).toBe(1_500);
  });

  it("retiree, 70, pension 20,000: reduction 1,992.15; minimum 6,700 (over 65); state 973.19 per half", () => {
    // net 18,000: 2,364.34 - 1.14 x (18,000 - 17,673.52) = 1,992.15 -> base 16,007.85
    const o = es(undefined, {
      people: [{ age: 70 }],
      income: [{ character: "pension", amount: 20_000 }],
    });
    expect(o.facts["es.baseGeneral.p1"]).toBeCloseTo(16_007.8472, 4);
    expect(sumLabel(o, /cuota estatal/)).toBeCloseTo(973.191664, 5);
    expect(sumLabel(o, /Seguridad Social/)).toBe(0);
  });

  it("wealth tax (toggle): 2,000,000 net worth -> state scale on 1,300,000 = 8,190.37; Valencia 10,181.31; Madrid 100% bonificación", () => {
    const o = {
      wealth: { netWorth: 2_000_000, liquidNetWorth: 0, portfolio: 0 },
      config: { lawToggles: { "es.wealthTax": true } },
    };
    expect(sumKind(es("CT", o), "wealth")).toBeCloseTo(8_190.36579, 4);
    expect(sumKind(es("VC", o), "wealth")).toBeCloseTo(10_181.31371, 4);
    expect(sumKind(es("MD", o), "wealth")).toBe(0);
    expect(sumKind(es("CT", { wealth: o.wealth }), "wealth")).toBe(0);
    expect(total(es("CT", o))).toBeCloseTo(8_190.36579, 4);
  });
});
