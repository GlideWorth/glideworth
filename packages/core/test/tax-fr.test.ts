/**
 * France vectors: barème, décote and allowances of the 2026 finance law (2025 income), 2026 social
 * rates. Hand-worked; working inline. The quotient-familial cap case follows the service-public.fr
 * F1419 rule (1,807 per half part; 3,614 for two children).
 */
import { describe, expect, it } from "vitest";
import { FR_YEARS, frLegalRetirementAge } from "../src/tax/data/fr.js";
import { frImpot, frJurisdiction, frParts, frPensionTier } from "../src/tax/jurisdictions/fr.js";
import { sumKind, sumLabel, taxInput, total } from "./tax-helpers.js";

const d = FR_YEARS[0]!;
const fr = (o: Parameters<typeof taxInput>[0]) =>
  frJurisdiction.computeYear(taxInput({ country: "FR", year: 2026, ...o }), []);
const wage = (amount: number) => ({ income: [{ character: "wage" as const, amount }] });

describe("France: salaried, single, no children", () => {
  it("low, 25,000 gross: contributions 2,827.50, CSG/CRDS 2,382.56; net imposable after 10% 18,452.03; impôt 753.72 less décote 555.94", () => {
    // pension contribs 25,000 x (6.90% + 0.40% + 4.01%); CSG base 98.25% x 25,000 = 24,562.50
    // net = 25,000 - 2,827.50 - 6.8% x 24,562.50 = 20,502.25; frais 10% = 2,050.23
    // impôt = 11% x (18,452.03 - 11,600) = 753.72; décote = 897 - 45.25% x 753.72 = 555.94
    const o = fr(wage(25_000));
    expect(sumLabel(o, /Cotisations retraite/)).toBeCloseTo(2_827.5, 6);
    expect(sumLabel(o, /CSG \/ CRDS \(revenus d'activité\)/)).toBeCloseTo(2_382.5625, 6);
    expect(o.facts["fr.revenuImposable.p1"]).toBeCloseTo(18_452.025, 6);
    expect(sumLabel(o, /^Impôt sur le revenu/)).toBeCloseTo(753.72275, 5);
    expect(sumLabel(o, /^Décote/)).toBeCloseTo(-555.940456, 5);
  });

  it("median, 45,000 gross: revenu 33,213.65 in the 30% band, no décote", () => {
    const o = fr(wage(45_000));
    expect(o.facts["fr.revenuImposable.p1"]).toBeCloseTo(33_213.645, 6);
    expect(sumLabel(o, /^Impôt sur le revenu/)).toBeCloseTo(3_068.0835, 4);
    expect(sumKind(o, "credit")).toBe(0);
    expect(o.facts["tax.ordinaryBracketRate"]).toBe(0.3);
  });

  it("high, 100,000 gross: tranche 2 AGIRC-ARRCO and CET apply; impôt 15,375.50 (revenu 74,238 in the 30% band)", () => {
    // contributions: 6.90% x 48,060 + 0.40% x 100,000 + 4.01% x 48,060 + 9.72% x 51,940 + 0.14% x 100,000
    const o = fr(wage(100_000));
    expect(sumLabel(o, /Cotisations retraite/)).toBeCloseTo(10_831.914, 6);
    expect(sumLabel(o, /^Impôt sur le revenu/)).toBeCloseTo(15_375.50322, 4);
    expect(o.facts["tax.ordinaryBracketRate"]).toBe(0.3);
  });

  it("very high, 300,000 gross: CSG base 98.25% only up to 4 PASS; frais capped at 14,555; 45% band", () => {
    const o = fr(wage(300_000));
    expect(sumLabel(o, /CSG \/ CRDS \(revenus d'activité\)/)).toBeCloseTo(28_773.6726, 4);
    expect(o.facts["fr.revenuImposable.p1"]).toBeCloseTo(233_921.8516, 4);
    expect(sumLabel(o, /^Impôt sur le revenu/)).toBeCloseTo(81_788.67322, 4);
    expect(o.facts["tax.ordinaryBracketRate"]).toBe(0.45);
  });

  it("quotient familial: a couple with two children (3 parts) on 74,238 is capped at 1,807 x 2 half parts", () => {
    expect(frParts(true, 2, false)).toBe(3);
    expect(frParts(true, 3, false)).toBe(4);
    expect(frParts(false, 1, true)).toBe(2);
    const o = fr({
      ...wage(100_000),
      people: [{}, {}],
      dependents: [5, 8],
      config: { filingStatus: "married-joint" },
    });
    // without children (2 parts): 8,479.49; with 3 parts uncapped it would be lower than 8,479.49 - 3,614
    expect(sumLabel(o, /^Impôt sur le revenu/)).toBeCloseTo(8_479.49322 - 3_614, 4);
    const r = frImpot(d, 74_238.3774, 3, true);
    expect(r.brut).toBeCloseTo(4_865.49322, 4);
  });
});

describe("France: capital income, wrappers, PER and retirees", () => {
  it("PFU 31.4%: 10,000 dividends -> 12.8% income tax + 18.6% prélèvements sociaux", () => {
    const o = fr({ income: [{ character: "qualified-dividend", amount: 10_000 }] });
    expect(sumLabel(o, /^PFU/)).toBeCloseTo(1_280, 6);
    expect(sumLabel(o, /Prélèvements sociaux \(capital\)/)).toBeCloseTo(1_860, 6);
    expect(total(o)).toBeCloseTo(3_140, 6);
  });

  it("barème option: 40% dividend allowance and 6.8% deductible CSG; 10,000 dividends alone -> 5,320 taxable, no income tax", () => {
    const o = fr({
      income: [{ character: "qualified-dividend", amount: 10_000 }],
      config: { lawToggles: { "fr.baremeOption": true } },
    });
    expect(o.facts["fr.revenuImposable.p1"]).toBeCloseTo(5_320, 6);
    expect(total(o)).toBeCloseTo(1_860, 6);
  });

  it("assurance-vie after 8 years: 7.5% above the 4,600 allowance + 17.2%; PEA after 5 years: 18.6% social only", () => {
    const o = fr({
      withdrawals: [
        {
          accountType: "fr-assurance-vie",
          treatment: "taxable",
          amount: 30_000,
          taxableAmount: 10_000,
          character: "capital-gains-long",
        },
        {
          accountType: "fr-pea",
          treatment: "taxable",
          amount: 20_000,
          taxableAmount: 10_000,
          character: "capital-gains-long",
        },
      ],
    });
    expect(sumLabel(o, /^Assurance-vie/)).toBeCloseTo(0.075 * 5_400, 6);
    expect(sumLabel(o, /Prélèvements sociaux \(assurance-vie\)/)).toBeCloseTo(1_720, 6);
    expect(sumLabel(o, /Prélèvements sociaux \(PEA\)/)).toBeCloseTo(1_860, 6);
    expect(sumLabel(o, /^PFU/)).toBe(0);
    const early = fr({
      withdrawals: [
        {
          accountType: "fr-pea",
          treatment: "taxable",
          amount: 20_000,
          taxableAmount: 10_000,
          character: "capital-gains-long",
        },
      ],
      config: { lawToggles: { "fr.peaHeld5Years": false } },
    });
    expect(sumLabel(early, /^PEA/)).toBeCloseTo(1_280, 6);
  });

  it("PER contributions are deductible within 10% of professional income", () => {
    const base = fr(wage(45_000)).facts["fr.revenuImposable.p1"]!;
    const o = fr({ ...wage(45_000), deductions: [{ amount: 2_000, accountType: "fr-per" }] });
    expect(base - o.facts["fr.revenuImposable.p1"]!).toBeCloseTo(2_000, 6);
    // ceiling: max(10% x 47,100, 10% x 33,213.65) = 4,710
    const big = fr({ ...wage(45_000), deductions: [{ amount: 10_000, accountType: "fr-per" }] });
    expect(base - big.facts["fr.revenuImposable.p1"]!).toBeCloseTo(4_710, 6);
    expect(
      frJurisdiction.contributionLimit!({
        accountType: "fr-per",
        year: 2026,
        ownerAge: 40,
        priceIndex: 1,
        earnedIncome: 100_000,
      }),
    ).toBeCloseTo(10_000, 6);
  });

  it("retiree, pension 30,000: RFR 25,407 is in the median tier (17,057 to 26,472): CSG/CRDS/CASA 7.4% = 2,220; 4.2 points deductible; 10% allowance; impôt 1,569.26 less décote 186.91", () => {
    // Tier test (service-public F2971): 30,000 x (1 - 5.9%) = 28,230, less 10% = 25,407 <= 26,472.
    // Then 30,000 x (1 - 4.2%) = 28,740, less 10% (2,874) = 25,866; 11% x (25,866 - 11,600) = 1,569.26;
    // décote 897 - 45.25% x 1,569.26 = 186.91.
    const o = fr({ people: [{ age: 70 }], income: [{ character: "pension", amount: 30_000 }] });
    expect(sumLabel(o, /CSG \/ CRDS \/ CASA \(pensions, taux médian\)/)).toBeCloseTo(2_220, 6);
    expect(o.facts["fr.revenuImposable.p1"]).toBeCloseTo(25_866, 6);
    expect(sumLabel(o, /^Impôt sur le revenu/)).toBeCloseTo(1_569.26, 6);
    expect(sumLabel(o, /^Décote/)).toBeCloseTo(-(897 - 0.4525 * 1_569.26), 6);
  });

  it("retiree, pension 40,000: RFR 33,876 is above 26,472, so the normal rate 9.1% = 3,640 with 5.9 points deductible", () => {
    const o = fr({ people: [{ age: 70 }], income: [{ character: "pension", amount: 40_000 }] });
    expect(sumLabel(o, /CSG \/ CRDS \/ CASA \(pensions, taux normal\)/)).toBeCloseTo(3_640, 6);
    expect(o.facts["fr.revenuImposable.p1"]).toBeCloseTo(40_000 * 0.941 * 0.9, 6);
  });
});

describe("France: CSG tiers on pensions, single-parent cap, legal retirement age", () => {
  it("pension CSG tiers by RFR (service-public F2971, 2026): 1 part 13,048 / 17,057 / 26,472; 2 parts +2 half-parts", () => {
    expect(frPensionTier(d, 13_048, 1).label).toBe("taux zéro");
    expect(frPensionTier(d, 13_049, 1).label).toBe("taux réduit");
    expect(frPensionTier(d, 17_058, 1).label).toBe("taux médian");
    expect(frPensionTier(d, 26_472, 1).label).toBe("taux médian");
    expect(frPensionTier(d, 26_473, 1).label).toBe("taux normal");
    // 2 parts: 13,048 + 2 x 3,484 = 20,016; 17,057 + 2 x 4,555 = 26,167; 26,472 + 2 x 7,066 = 40,604
    expect(frPensionTier(d, 20_016, 2).label).toBe("taux zéro");
    expect(frPensionTier(d, 26_168, 2).label).toBe("taux médian");
    expect(frPensionTier(d, 40_604, 2).label).toBe("taux médian");
    expect(frPensionTier(d, 40_605, 2).label).toBe("taux normal");
  });

  it("low pensions: 14,000 pays no CSG (RFR 11,856.60); 16,000 pays the reduced 3.8% + 0.5% CRDS, no CASA = 688", () => {
    // RFR proxy 14,000 x 0.941 x 0.9 = 11,856.60 <= 13,048 -> taux zéro
    // 16,000 x 0.941 = 15,056, less 10% = 13,550.40 > 13,048 -> taux réduit 4.3% = 688
    const zero = fr({ people: [{ age: 70 }], income: [{ character: "pension", amount: 14_000 }] });
    expect(sumLabel(zero, /CSG \/ CRDS \/ CASA/)).toBe(0);
    const o = fr({ people: [{ age: 70 }], income: [{ character: "pension", amount: 16_000 }] });
    expect(sumLabel(o, /CSG \/ CRDS \/ CASA \(pensions, taux réduit\)/)).toBeCloseTo(688, 6);
    // 3.8% fully deductible: 16,000 x 0.962 = 15,392, less 10% = 13,852.8
    expect(o.facts["fr.revenuImposable.p1"]).toBeCloseTo(13_852.8, 6);
  });

  it("single parent, one child, 60,000: the two half-parts are capped at 4,262 (service-public F1419)", () => {
    // 2 parts: 2 x tax(30,000) = 4,207.98; 1 part: tax(60,000) = 11,103.99; 11,103.99 - 4,262 = 6,841.99
    expect(frParts(false, 1, true)).toBe(2);
    expect(frImpot(d, 60_000, 2, false, 1, true).brut).toBeCloseTo(6_841.99, 6);
    // a couple's or other half-parts use 1,807: a non-single-parent with 2 parts would get 3,614
    expect(frImpot(d, 60_000, 2, false, 1, false).brut).toBeCloseTo(11_103.99 - 3_614, 6);
  });

  it("legal retirement age after the LFSS 2026 suspension (service-public F14043)", () => {
    expect(frLegalRetirementAge(1960)).toBe(62);
    expect(frLegalRetirementAge(1961, 8)).toBe(62);
    expect(frLegalRetirementAge(1961, 9)).toBe(62.25);
    expect(frLegalRetirementAge(1962)).toBe(62.5);
    expect(frLegalRetirementAge(1963)).toBe(62.75);
    expect(frLegalRetirementAge(1964)).toBe(62.75);
    expect(frLegalRetirementAge(1965, 3)).toBe(62.75);
    expect(frLegalRetirementAge(1965, 4)).toBe(63);
    expect(frLegalRetirementAge(1966)).toBe(63.25);
    expect(frLegalRetirementAge(1968)).toBe(63.75);
    expect(frLegalRetirementAge(1969)).toBe(64);
    expect(frLegalRetirementAge(1990)).toBe(64);
    expect(
      frJurisdiction.pensionAccessAge!({ accountType: "fr-per", birthYear: 1964, birthMonth: 6 }),
    ).toBe(62.75);
    expect(
      frJurisdiction.pensionAccessAge!({ accountType: "fr-pea", birthYear: 1964, birthMonth: 6 }),
    ).toBeNull();
  });
});
