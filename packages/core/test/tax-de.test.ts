/**
 * Germany 2026 vectors. Hand-worked from the statutory formulas (§32a EStG tariff as published on
 * gesetze-im-internet.de, SolZG §3/§4, SV-Rechengrößen 2026); working inline. Cross-check: the
 * official tariff formula itself (the BMF calculator at bmf-steuerrechner.de implements it; it
 * could not be queried automatically). Glideworth omits the statutory rounding to full euros.
 */
import { describe, expect, it } from "vitest";
import { DE_YEARS, deBesteuerungsanteil } from "../src/tax/data/de.js";
import { deJurisdiction, deTariff } from "../src/tax/jurisdictions/de.js";
import { sumKind, sumLabel, taxInput, total } from "./tax-helpers.js";

const d = DE_YEARS[0]!;
const de = (o: Parameters<typeof taxInput>[0]) =>
  deJurisdiction.computeYear(taxInput({ country: "DE", year: 2026, ...o }), []);
const wage = (amount: number) => ({ income: [{ character: "wage" as const, amount }] });

describe("Germany 2026: §32a tariff", () => {
  it("zones: 0 to 12,348; 17,799 -> 1,034.87 (start of zone 3); 69,878 -> 18,213.13; 0.42x - 11,135.63; 0.45x - 19,470.38", () => {
    expect(deTariff(12_348, d)).toBe(0);
    // y = 0.5451: (914.51 x 0.5451 + 1,400) x 0.5451 = 1,034.87 (continuity with zone 3)
    expect(deTariff(17_799, d)).toBeCloseTo(1_034.87, 1);
    // zone 4 at its lower edge: 0.42 x 69,878 - 11,135.63 = 18,213.13 (continuous with zone 3)
    expect(deTariff(69_878, d)).toBeCloseTo(18_213.13, 0);
    expect(deTariff(100_000, d)).toBeCloseTo(42_000 - 11_135.63, 6);
    expect(deTariff(400_000, d)).toBeCloseTo(180_000 - 19_470.38, 6);
  });

  it("Besteuerungsanteil: 50% to 2005, 80% in 2020, 84% for pensions starting 2026, 100% from 2058", () => {
    expect(deBesteuerungsanteil(2005)).toBe(0.5);
    expect(deBesteuerungsanteil(2020)).toBeCloseTo(0.8, 12);
    expect(deBesteuerungsanteil(2026)).toBeCloseTo(0.84, 12);
    expect(deBesteuerungsanteil(2058)).toBe(1);
  });
});

describe("Germany 2026: employees (single, 40, childless, no church tax)", () => {
  it("low, 20,000: SV 1,860 + 260 + 1,750 + 480; zvE 14,714; ESt 382.43; no Soli", () => {
    // zvE = 20,000 - 1,230 - (2 x 1,860 - 1,860) - (1,750 x 0.96 + 480) - 36 = 14,714
    // y = 0.2366: (914.51 x 0.2366 + 1,400) x 0.2366 = 382.43
    const o = de(wage(20_000));
    expect(sumLabel(o, /Rentenversicherung/)).toBeCloseTo(1_860, 6);
    expect(sumLabel(o, /Arbeitslosen/)).toBeCloseTo(260, 6);
    expect(sumLabel(o, /Krankenversicherung/)).toBeCloseTo(1_750, 6);
    expect(sumLabel(o, /Pflegeversicherung/)).toBeCloseTo(480, 6);
    expect(o.facts["de.zvE.p1"]).toBeCloseTo(14_714, 6);
    expect(sumLabel(o, /^Einkommensteuer/)).toBeCloseTo(382.4339, 3);
    expect(sumLabel(o, /Solidarit/)).toBe(0);
  });

  it("median, 50,000: zvE 38,684, ESt 6,796.04 (zone 3), Soli 0 below the 20,350 Freigrenze", () => {
    // z = 2.0885: (173.10 x 2.0885 + 2,397) x 2.0885 + 1,034.87 = 6,796.04
    const o = de(wage(50_000));
    expect(o.facts["de.zvE.p1"]).toBeCloseTo(38_684, 6);
    expect(sumLabel(o, /^Einkommensteuer/)).toBeCloseTo(6_796.0377, 3);
    expect(sumKind(o, "payroll")).toBeCloseTo(4_650 + 650 + 4_375 + 1_200, 6);
    expect(o.facts["tax.ordinaryBracketRate"]).toBeCloseTo(
      (2 * 173.1 * 2.0885 + 2_397) / 10_000,
      6,
    );
  });

  it("high, 100,000: health/care capped at the 69,750 BBG; zvE 81,901; ESt 23,262.79; Soli in the Milderungszone 346.62", () => {
    // KV 8.75% x 69,750 = 6,103.125; PV 2.4% x 69,750 = 1,674; RV 9.3% x 100,000 = 9,300
    // Soli = min(5.5% x 23,262.79, 11.9% x (23,262.79 - 20,350)) = 346.62
    const o = de(wage(100_000));
    expect(sumLabel(o, /Krankenversicherung/)).toBeCloseTo(6_103.125, 6);
    expect(o.facts["de.zvE.p1"]).toBeCloseTo(81_901, 6);
    expect(sumLabel(o, /^Einkommensteuer/)).toBeCloseTo(23_262.79, 4);
    expect(sumLabel(o, /^Solidarit/)).toBeCloseTo(346.62201, 4);
  });

  it("very high, 300,000: pension BBG 101,400; 45% zone; full 5.5% Soli", () => {
    // RV 9.3% x 101,400 = 9,430.20; zvE = 298,770 - 9,430.20 - (6,103.125 x 0.96 + 1,674) - 36 = 281,770.80
    const o = de(wage(300_000));
    expect(sumLabel(o, /Rentenversicherung/)).toBeCloseTo(9_430.2, 6);
    const zve = o.facts["de.zvE.p1"]!;
    expect(zve).toBeCloseTo(281_770.8, 6);
    expect(sumLabel(o, /^Einkommensteuer/)).toBeCloseTo(0.45 * zve - 19_470.38, 6);
    expect(sumLabel(o, /^Solidarit/)).toBeCloseTo(0.055 * (0.45 * zve - 19_470.38), 6);
    expect(o.facts["tax.ordinaryBracketRate"]).toBe(0.45);
  });

  it("Ehegattensplitting: 80,000 earner with a non-earning spouse pays 2 x T(63,761 / 2) = 9,506.89 instead of 15,708.71", () => {
    const single = de(wage(80_000));
    expect(sumLabel(single, /^Einkommensteuer/)).toBeCloseTo(15_708.7083, 3);
    const joint = de({
      ...wage(80_000),
      people: [{}, {}],
      config: { filingStatus: "married-joint" },
      // a couple with a child: no childless surcharge, so use the same care rate as above
      dependents: [],
    });
    expect(sumLabel(joint, /Einkommensteuer \(Splitting\)/)).toBeCloseTo(9_506.8864, 3);
  });

  it("church tax (9%, 8% in Bayern) is a toggle", () => {
    const o = de({ ...wage(50_000), config: { lawToggles: { "de.churchTax": true } } });
    expect(sumLabel(o, /^Kirchensteuer$/)).toBeCloseTo(0.09 * 6_796.0377, 3);
    const by = de({
      ...wage(50_000),
      region: "BY",
      config: { lawToggles: { "de.churchTax": true } },
    });
    expect(sumLabel(by, /^Kirchensteuer$/)).toBeCloseTo(0.08 * 6_796.0377, 3);
  });

  it("bAV 3,000 (§3 Nr. 63): tax-free in full, social-free up to 4,056; zvE 36,287", () => {
    // SV wage 50,000 - 3,000 = 47,000 (3,000 < 4% x 101,400): RV 4,371, KV 4,112.50, PV 1,128
    // zvE = 47,000 - 1,230 - 4,371 - (4,112.50 x 0.96 + 1,128) - 36 = 36,287
    const o = de({ ...wage(50_000), deductions: [{ amount: 3_000, accountType: "de-bav" }] });
    expect(sumLabel(o, /Rentenversicherung/)).toBeCloseTo(4_371, 6);
    expect(o.facts["de.zvE.p1"]).toBeCloseTo(36_287, 6);
    expect(sumLabel(o, /^Einkommensteuer/)).toBeCloseTo(6_058.11, 2);
  });

  it("Riester (max 2,100) and Rürup (within the 30,826 Höchstbetrag) are Sonderausgaben", () => {
    const base = de(wage(50_000)).facts["de.zvE.p1"]!;
    const r = de({ ...wage(50_000), deductions: [{ amount: 3_000, accountType: "de-riester" }] });
    expect(base - r.facts["de.zvE.p1"]!).toBeCloseTo(2_100, 6);
    const ru = de({ ...wage(50_000), deductions: [{ amount: 5_000, accountType: "de-ruerup" }] });
    expect(base - ru.facts["de.zvE.p1"]!).toBeCloseTo(5_000, 6);
  });
});

describe("Germany 2026: capital income and retirees", () => {
  it("Abgeltungsteuer: 10,000 dividends + 5,000 fund gains, 30% Teilfreistellung, 1,000 Sparer-Pauschbetrag -> 25% x 9,500 = 2,375 + Soli 130.63", () => {
    const o = de({
      income: [
        { character: "qualified-dividend", amount: 10_000 },
        { character: "capital-gains-long", amount: 5_000 },
      ],
    });
    expect(sumKind(o, "dividends", "capital-gains")).toBeCloseTo(2_375, 6);
    expect(sumKind(o, "capital-gains")).toBeCloseTo(2_375 / 3, 6);
    expect(sumLabel(o, /Solidaritätszuschlag auf/)).toBeCloseTo(130.625, 6);
    expect(sumLabel(o, /^Einkommensteuer/)).toBe(0);
    // with 9% church tax: 9,500 x 25% x 4 / 4.09 = 2,322.74; KiSt 9% of it
    const k = de({
      income: [
        { character: "qualified-dividend", amount: 10_000 },
        { character: "capital-gains-long", amount: 5_000 },
      ],
      config: { lawToggles: { "de.churchTax": true } },
    });
    expect(sumKind(k, "dividends", "capital-gains")).toBeCloseTo(9_500 / 4.09, 6);
    expect(sumLabel(k, /Kirchensteuer auf/)).toBeCloseTo((0.09 * 9_500) / 4.09, 6);
    // without the equity-fund assumption (direct shares / bonds): 14,000 x 25%
    const raw = de({
      income: [{ character: "interest", amount: 15_000 }],
    });
    expect(sumKind(raw, "dividends", "capital-gains")).toBeCloseTo(3_500, 6);
  });

  it("retiree, 70, statutory pension 24,000 starting 2026: 84% taxable; KVdR 8.75% + PV 4.2%; ESt 829.90", () => {
    // KV 0.0875 x 24,000 = 2,100; PV 0.042 x 24,000 = 1,008 (childless)
    // zvE = 0.84 x 24,000 - 102 - (2,100 + 1,008) - 36 = 16,914; y = 0.4566 -> 829.90
    const o = de({
      people: [{ age: 70 }],
      income: [{ character: "pension", incomeType: "state-pension", amount: 24_000 }],
    });
    expect(sumLabel(o, /Krankenversicherung/)).toBeCloseTo(2_100, 6);
    expect(sumLabel(o, /Pflegeversicherung/)).toBeCloseTo(1_008, 6);
    expect(o.facts["de.zvE.p1"]).toBeCloseTo(16_914, 6);
    expect(sumLabel(o, /^Einkommensteuer/)).toBeCloseTo(829.9003, 3);
    expect(o.facts["de.pensionStart.p1"]).toBe(2026);
    // a pension that started in 2010 keeps its 60% share (history fact)
    const old = de({
      year: 2027,
      people: [{ age: 70 }],
      income: [{ character: "pension", incomeType: "state-pension", amount: 24_000 }],
      history: [{ "de.pensionStart.p1": 2010 }],
    });
    expect(old.facts["de.zvE.p1"]).toBeCloseTo(0.6 * 24_000 - 102 - 3_108 - 36, 6);
  });

  it("limits and access ages: Riester 2,100, Rürup 30,826, bAV 8% of 101,400; payouts from 62", () => {
    const q = { year: 2026, ownerAge: 40, priceIndex: 1, earnedIncome: 50_000 };
    expect(deJurisdiction.contributionLimit!({ ...q, accountType: "de-riester" })).toBe(2_100);
    expect(deJurisdiction.contributionLimit!({ ...q, accountType: "de-ruerup" })).toBe(30_826);
    expect(deJurisdiction.contributionLimit!({ ...q, accountType: "de-bav" })).toBeCloseTo(
      8_112,
      6,
    );
    expect(
      deJurisdiction.pensionAccessAge!({
        accountType: "de-riester",
        birthYear: 1980,
        birthMonth: 1,
      }),
    ).toBe(62);
    expect(total(de(wage(0)))).toBe(0);
  });
});
