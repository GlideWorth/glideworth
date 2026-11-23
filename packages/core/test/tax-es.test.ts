/**
 * Spain vectors: IRPF state scales (LIRPF arts. 63, 66, 76, BOE consolidated text of 18/11/2026),
 * 2025 regional scales (AEAT Manual práctico de Renta 2025), 2026 social security (seg-social.es),
 * wealth tax (AEAT Manual práctico de Patrimonio 2025) and the solidarity tax (Ley 38/2022 art. 3).
 * The "official table" tests check the cumulative cuota column the BOE and AEAT publish with each
 * scale; the other vectors are hand-worked following the AEAT method (scale on the base minus the
 * scale on the mínimo personal y familiar), with the working inline. Checked 2026-11-19.
 */
import { describe, expect, it } from "vitest";
import { bands, sliceTax } from "../src/tax/common.js";
import { ES_REGIONAL_SCALES, ES_YEARS } from "../src/tax/data/es.js";
import {
  esJurisdiction,
  esMinimum,
  esRegion,
  esWealthTax,
  esWorkReduction,
} from "../src/tax/jurisdictions/es.js";
import { createDefaultTaxRegistry, defaultStackIds } from "../src/tax/registry.js";
import { sumKind, sumLabel, taxInput, total } from "./tax-helpers.js";

const d = ES_YEARS[0]!;
const es = (region: string | undefined, o: Parameters<typeof taxInput>[0]) => {
  const j = region ? esJurisdiction.parameterize!(region) : esJurisdiction;
  return j.computeYear(taxInput({ country: "ES", year: 2026, ...o }), []);
};
const wage = (amount: number) => ({ income: [{ character: "wage" as const, amount }] });

describe("Spain: employees (single, 40, no children)", () => {
  it("low, 18,000 (default region): SS 6.5% = 1,170; art. 20 reduction on 16,830 = 3,840.50; base 10,989.50; 9.5% x (10,989.50 - 5,550) per half = 516.75", () => {
    // Art. 20 measures net work income before the 2,000 other expenses: 18,000 - 1,170 = 16,830,
    // so the reduction is 7,302 - 1.75 x (16,830 - 14,852) = 3,840.50. Net after other expenses
    // 14,830 - 3,840.50 = 10,989.50.
    const o = es(undefined, wage(18_000));
    expect(sumLabel(o, /Seguridad Social/)).toBeCloseTo(1_170, 6);
    expect(o.facts["es.baseGeneral.p1"]).toBeCloseTo(10_989.5, 6);
    expect(sumLabel(o, /cuota estatal/)).toBeCloseTo(516.7525, 6);
    expect(sumLabel(o, /cuota autonómica/)).toBeCloseTo(516.7525, 6);
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
    // Aragón has no row: an unmodelled ISO 3166-2 code falls back to the state-scale mirror
    expect(esRegion("AR").code).toBe("DEFAULT");
    expect(esRegion("ES-AR").code).toBe("DEFAULT");
    expect(() => esRegion("Atlantis")).toThrow();
    const vc = es("VC", wage(30_000));
    // Valencia: 1,080 + 1,200 (12,000-22,000 at 12%) + 15% x 4,050 = 2,887.50 less 9% x 5,550 = 499.50
    expect(sumLabel(vc, /Comunitat Valenciana/)).toBeCloseTo(2_887.5 - 499.5, 6);
    expect(defaultStackIds({ country: "ES", region: "MD" })).toEqual(["es:MD"]);
    expect(createDefaultTaxRegistry().get("es:AN").id).toBe("es:AN");
  });

  it("median, 30,000 in Galicia: base 26,050; Galicia scale 2,852.61 less 9% x 5,550 = 2,353.11", () => {
    // Galicia 2025 (AEAT Manual práctico de Renta 2025; art. 4 DL 1/2011, BOE), worked by hand:
    // 2,110.380125 at 21,068.60 (1,168.6815 + 11.65% x 8,083.25) + 14.90% x (26,050 - 21,068.60)
    // = 2,110.380125 + 742.2286 = 2,852.608725; less 9% x 5,550 (state mínimo) = 499.50 -> 2,353.108725
    const o = es("GA", wage(30_000));
    expect(o.facts["es.baseGeneral.p1"]).toBeCloseTo(26_050, 6);
    expect(sumLabel(o, /cuota estatal/)).toBeCloseTo(2_463, 6);
    expect(sumLabel(o, /Galicia/)).toBeCloseTo(2_353.108725, 6);
    expect(o.facts["tax.ordinaryBracketRate"]).toBeCloseTo(0.15 + 0.149, 12);
  });

  it("Galicia aliases: ISO 3166-2 ES-GA, GA, Galicia and Galiza", () => {
    for (const c of ["GA", "ga", "ES-GA", "Galicia", "GALIZA"]) expect(esRegion(c).code).toBe("GA");
    expect(esJurisdiction.parameterize!("Galicia").id).toBe("es:GA");
    expect(defaultStackIds({ country: "ES", region: "GA" })).toEqual(["es:GA"]);
    expect(createDefaultTaxRegistry().get("es:GA").id).toBe("es:GA");
  });

  it("work-income reduction (art. 20) phases out between 14,852 and 19,747.50; none with other income above 6,500", () => {
    expect(esWorkReduction(d, 14_852, 0)).toBe(7_302);
    expect(esWorkReduction(d, 16_000, 0)).toBeCloseTo(7_302 - 1.75 * 1_148, 6);
    expect(esWorkReduction(d, 17_673.52, 0)).toBeCloseTo(2_364.34, 6);
    expect(esWorkReduction(d, 18_000, 0)).toBeCloseTo(2_364.34 - 1.14 * 326.48, 6);
    expect(esWorkReduction(d, 19_747.5, 0)).toBe(0);
    expect(esWorkReduction(d, 14_000, 6_500)).toBe(7_302);
    expect(esWorkReduction(d, 14_000, 6_500.01)).toBe(0);
  });

  it("the reduction never takes net work income below zero (art. 20, last paragraph)", () => {
    // 8,000 wage: SS 520, net before other expenses 7,480 -> reduction 7,302; after the 2,000
    // other expenses only 5,480 is left, so the reduced net is 0.
    const o = es(undefined, wage(8_000));
    expect(o.facts["es.baseGeneral.p1"]).toBe(0);
    expect(sumLabel(o, /cuota/)).toBe(0);
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

  it("retiree, 70, pension 20,000: net 20,000 is above 19,747.50, so no reduction; base 18,000; minimum 6,700 (65+); state 1,212.25 per half", () => {
    // No social security on a pension: art. 20 net income is the full 20,000. Base 20,000 - 2,000.
    // State: scale(18,000) 1,848.75 - scale(6,700) 636.50 = 1,212.25.
    const o = es(undefined, {
      people: [{ age: 70 }],
      income: [{ character: "pension", amount: 20_000 }],
    });
    expect(o.facts["es.baseGeneral.p1"]).toBeCloseTo(18_000, 6);
    expect(sumLabel(o, /cuota estatal/)).toBeCloseTo(1_212.25, 6);
    expect(sumLabel(o, /Seguridad Social/)).toBe(0);
  });

  it("minimum rises by 1,150 from age 65 and 1,400 more from 75 (AEAT: 'igual o superior')", () => {
    expect(esMinimum(d, 64, [], 1)).toBe(5_550);
    expect(esMinimum(d, 65, [], 1)).toBe(6_700);
    expect(esMinimum(d, 74, [], 1)).toBe(6_700);
    expect(esMinimum(d, 75, [], 1)).toBe(8_100);
    // descendants: 2,400 + 2,700 (+2,800 under 3), split between two parents
    expect(esMinimum(d, 40, [10, 2], 2)).toBe(5_550 + (2_400 + 2_700 + 2_800) / 2);
    // pension 30,000 at 65: base 28,000; state scale(28,000) 3,282.75 - scale(6,700) 636.50
    const o = es(undefined, {
      people: [{ age: 65 }],
      income: [{ character: "pension", amount: 30_000 }],
    });
    expect(sumLabel(o, /cuota estatal/)).toBeCloseTo(2_646.25, 6);
  });

  it("wealth tax (toggle), 2,000,000: state scale on 1,300,000 = 8,190.37; Cataluña own scale on 1,500,000 (500,000 exempt) = 11,174.49; Valencia own scale on 1,000,000 (1,000,000 exempt) = 6,821.31; Madrid 0", () => {
    const o = {
      wealth: { netWorth: 2_000_000, liquidNetWorth: 0, portfolio: 0 },
      config: { lawToggles: { "es.wealthTax": true } },
    };
    expect(sumKind(es(undefined, o), "wealth")).toBeCloseTo(8_190.36579, 4);
    // Cataluña: 8,949.54 at 1,336,999.75 + 1.365% x 163,000.25
    expect(sumKind(es("CT", o), "wealth")).toBeCloseTo(11_174.48513, 4);
    // Valencia: 3,108.51 at 668,499.75 + 1.12% x 331,500.25
    expect(sumKind(es("VC", o), "wealth")).toBeCloseTo(6_821.31371, 4);
    // Madrid: the ITSGF base 1,300,000 is under 3,000,000, so the bonificación leaves nothing
    expect(sumKind(es("MD", o), "wealth")).toBe(0);
    expect(sumKind(es("CT", { wealth: o.wealth }), "wealth")).toBe(0);
    expect(total(es("CT", o))).toBeCloseTo(11_174.48513, 4);
  });

  it("solidarity tax on large fortunes, 5,000,000: Madrid pays the ITSGF amount as wealth tax (22,100); Cataluña's wealth tax (59,793.69) exceeds it, so no ITSGF", () => {
    const o = {
      wealth: { netWorth: 5_000_000, liquidNetWorth: 0, portfolio: 0 },
      config: { lawToggles: { "es.wealthTax": true } },
    };
    // ITSGF: base 5,000,000 - 700,000 = 4,300,000; 1.7% x (4,300,000 - 3,000,000) = 22,100.
    // Madrid wealth tax before the bonificación: state scale on 4,300,000 = 53,546.37, so the
    // bonificación is 53,546.37 - 22,100 and 22,100 is paid as wealth tax; the ITSGF due is 0.
    const md = es("MD", o);
    expect(sumLabel(md, /Patrimonio/)).toBeCloseTo(22_100, 6);
    expect(sumLabel(md, /solidaridad/)).toBeCloseTo(0, 6);
    const ct = es("CT", o);
    expect(sumLabel(ct, /Patrimonio/)).toBeCloseTo(59_793.68929, 4);
    expect(sumLabel(ct, /solidaridad/)).toBe(0);
    // A region whose wealth tax is below the ITSGF pays the difference as ITSGF
    const lowRegion = {
      ...ES_REGIONAL_SCALES.DEFAULT!,
      wealthScale: [[0, 0.001]] as [number, number][],
    };
    const w = esWealthTax(d, lowRegion, 5_000_000);
    expect(w.wealthTax).toBeCloseTo(4_300, 6);
    expect(w.solidarityTax).toBeCloseTo(22_100 - 4_300, 6);
  });
});

describe("Spain: official scale tables (cumulative cuota at each band edge)", () => {
  const cuota = (rows: [number, number][], at: number) => sliceTax(bands(rows, 1), 0, at).tax;

  it("state general scale, LIRPF art. 63", () => {
    const st = d.stateGeneral;
    expect(cuota(st, 12_450)).toBeCloseTo(1_182.75, 6);
    expect(cuota(st, 20_200)).toBeCloseTo(2_112.75, 6);
    expect(cuota(st, 35_200)).toBeCloseTo(4_362.75, 6);
    expect(cuota(st, 60_000)).toBeCloseTo(8_950.75, 6);
    expect(cuota(st, 300_000)).toBeCloseTo(62_950.75, 6);
  });

  it("savings scale halves, LIRPF arts. 66 and 76 (30% combined above 300,000)", () => {
    const sv = d.savingsHalf;
    expect(cuota(sv, 6_000)).toBeCloseTo(570, 6);
    expect(cuota(sv, 50_000)).toBeCloseTo(5_190, 6);
    expect(cuota(sv, 200_000)).toBeCloseTo(22_440, 6);
    expect(cuota(sv, 300_000)).toBeCloseTo(35_940, 6);
    expect(sv.at(-1)![1] * 2).toBeCloseTo(0.3, 12);
  });

  it("regional general scales 2025, AEAT Manual práctico de Renta 2025", () => {
    const md = ES_REGIONAL_SCALES.MD!.general;
    expect(cuota(md, 13_362.22)).toBeCloseTo(1_135.79, 2);
    expect(cuota(md, 19_004.63)).toBeCloseTo(1_739.53, 2);
    expect(cuota(md, 35_425.68)).toBeCloseTo(3_841.42, 2);
    expect(cuota(md, 57_320.4)).toBeCloseTo(7_651.1, 2);
    const ct = ES_REGIONAL_SCALES.CT!.general;
    expect(cuota(ct, 12_500)).toBeCloseTo(1_187.5, 6);
    expect(cuota(ct, 22_000)).toBeCloseTo(2_375, 6);
    expect(cuota(ct, 33_000)).toBeCloseTo(4_135, 6);
    expect(cuota(ct, 53_000)).toBeCloseTo(7_935, 6);
    expect(cuota(ct, 90_000)).toBeCloseTo(15_890, 6);
    expect(cuota(ct, 120_000)).toBeCloseTo(22_940, 6);
    expect(cuota(ct, 175_000)).toBeCloseTo(36_415, 6);
    const an = ES_REGIONAL_SCALES.AN!.general;
    expect(cuota(an, 13_000)).toBeCloseTo(1_235, 6);
    expect(cuota(an, 21_100)).toBeCloseTo(2_207, 6);
    expect(cuota(an, 35_200)).toBeCloseTo(4_322, 6);
    expect(cuota(an, 60_000)).toBeCloseTo(8_910, 6);
    const vc = ES_REGIONAL_SCALES.VC!.general;
    expect(cuota(vc, 12_000)).toBeCloseTo(1_080, 6);
    expect(cuota(vc, 22_000)).toBeCloseTo(2_280, 6);
    expect(cuota(vc, 32_000)).toBeCloseTo(3_780, 6);
    expect(cuota(vc, 42_000)).toBeCloseTo(5_530, 6);
    expect(cuota(vc, 52_000)).toBeCloseTo(7_530, 6);
    expect(cuota(vc, 62_000)).toBeCloseTo(9_780, 6);
    expect(cuota(vc, 72_000)).toBeCloseTo(12_280, 6);
    expect(cuota(vc, 100_000)).toBeCloseTo(19_700, 6);
    expect(cuota(vc, 150_000)).toBeCloseTo(33_450, 6);
    expect(cuota(vc, 200_000)).toBeCloseTo(47_700, 6);
  });

  it("Galicia general scale 2025 (AEAT Manual práctico de Renta 2025; art. 4 DL 1/2011): cuota column and rates at each edge", () => {
    const ga = ES_REGIONAL_SCALES.GA!.general;
    // Cuota íntegra column as published (rounded to cents)
    expect(cuota(ga, 12_985.35)).toBeCloseTo(1_168.68, 2);
    expect(cuota(ga, 21_068.6)).toBeCloseTo(2_110.38, 2);
    expect(cuota(ga, 35_200)).toBeCloseTo(4_215.96, 2);
    expect(cuota(ga, 60_000)).toBeCloseTo(8_779.16, 2);
    // Just below, at and just above each edge: the rate up to the edge, then the next rate
    const rates: [number, number, number][] = [
      [12_985.35, 0.09, 0.1165],
      [21_068.6, 0.1165, 0.149],
      [35_200, 0.149, 0.184],
      [60_000, 0.184, 0.225],
    ];
    for (const [edge, below, above] of rates) {
      expect(cuota(ga, edge) - cuota(ga, edge - 1)).toBeCloseTo(below, 9);
      expect(cuota(ga, edge + 1) - cuota(ga, edge)).toBeCloseTo(above, 9);
    }
  });

  it("wealth tax scales 2025 (AEAT Manual práctico de Patrimonio 2025) and the ITSGF (Ley 38/2022 art. 3)", () => {
    // The published cuotas are rounded at each step, so they match to within 0.05
    const st = d.wealth.stateScale;
    expect(cuota(st, 167_129.45)).toBeCloseTo(334.26, 1);
    expect(cuota(st, 668_499.75)).toBeCloseTo(2_506.86, 1);
    expect(cuota(st, 2_673_999.01)).toBeCloseTo(25_904.35, 1);
    expect(cuota(st, 10_695_996.06)).toBeCloseTo(183_670.29, 1);
    const ct = ES_REGIONAL_SCALES.CT!.wealthScale!;
    expect(Math.abs(cuota(ct, 1_336_999.75) - 8_949.54)).toBeLessThan(0.02);
    expect(Math.abs(cuota(ct, 10_695_996.06) - 192_853.82)).toBeLessThan(0.02);
    expect(Math.abs(cuota(ct, 20_000_000) - 448_713.93)).toBeLessThan(0.02);
    const vc = ES_REGIONAL_SCALES.VC!.wealthScale!;
    expect(cuota(vc, 668_499.75)).toBeCloseTo(3_108.51, 1);
    expect(cuota(vc, 10_695_996.06)).toBeCloseTo(229_061.43, 1);
    const sg = d.solidarity.scale;
    expect(cuota(sg, 3_000_000)).toBe(0);
    expect(cuota(sg, 5_347_998.03)).toBeCloseTo(39_915.97, 1);
    expect(cuota(sg, 10_695_996.06)).toBeCloseTo(152_223.93, 1);
  });

  it("social security 2026: employee 6.50% up to 5,101.20 a month", () => {
    expect(d.social.employeeRate).toBeCloseTo(0.065, 12);
    expect(d.social.maxBase).toBeCloseTo(61_214.4, 6);
  });
});
