/**
 * Netherlands 2026 vectors, hand-worked from the Belastingdienst "Fiscale informatie 2026" tables
 * (box 1 rates, heffingskortingen); working inline. Box 3 reproduces the Belastingdienst's own
 * 2026 worked example (fisin2026/belastingberekening: 350,000 savings, 250,000 second home,
 * 90,000 debt -> voordeel 15,171).
 */
import { describe, expect, it } from "vitest";
import { NL_YEARS, nlAowAge } from "../src/tax/data/nl.js";
import { nlArbeidskorting, nlBox3, nlJurisdiction } from "../src/tax/jurisdictions/nl.js";
import { sumKind, sumLabel, taxInput, total } from "./tax-helpers.js";

const d = NL_YEARS[0]!;
const nl = (o: Parameters<typeof taxInput>[0]) =>
  nlJurisdiction.computeYear(taxInput({ country: "NL", year: 2026, ...o }), []);
const wage = (amount: number) => ({ income: [{ character: "wage" as const, amount }] });

describe("Netherlands 2026: box 1 employees (under AOW age)", () => {
  it("low, 20,000: 35.75% = 7,150 less AHK 3,115 and arbeidskorting 3,487.57 -> 547.43", () => {
    // arbeidskorting: 996 + 31.009% x (20,000 - 11,965) = 3,487.57
    const o = nl(wage(20_000));
    expect(sumLabel(o, /^Box 1/)).toBeCloseTo(7_150, 6);
    expect(-sumKind(o, "credit")).toBeCloseTo(3_115 + 3_487.57315, 4);
    expect(total(o)).toBeCloseTo(547.42685, 4);
  });

  it("median, 50,000: 13,900.67 + 37.56% x 11,117 = 18,076.22; AHK 1,818.51; AK 5,398.04", () => {
    // AHK 3,115 - 6.398% x (50,000 - 29,736); AK 5,685 - 6.51% x (50,000 - 45,592)
    const o = nl(wage(50_000));
    expect(sumLabel(o, /^Box 1/)).toBeCloseTo(18_076.2177, 4);
    expect(total(o)).toBeCloseTo(10_859.66922, 4);
    expect(o.facts["tax.ordinaryBracketRate"]).toBe(0.3756);
  });

  it("high, 100,000: 49.5% band; AHK fully phased out; AK 2,143.04", () => {
    const o = nl(wage(100_000));
    expect(sumLabel(o, /^Box 1/)).toBeCloseTo(39_432.1533, 4);
    expect(total(o)).toBeCloseTo(37_289.1141, 4);
    expect(o.facts["tax.ordinaryBracketRate"]).toBe(0.495);
  });

  it("very high, 250,000: no credits (arbeidskorting is zero from 132,920)", () => {
    const o = nl(wage(250_000));
    expect(sumKind(o, "credit")).toBe(0);
    expect(total(o)).toBeCloseTo(113_682.1533, 4);
  });

  it("pension contributions are deducted: 50,000 with 5,000 to a pension -> box 1 on 45,000", () => {
    const o = nl({ ...wage(50_000), deductions: [{ amount: 5_000, accountType: "nl-pension" }] });
    expect(o.facts["nl.box1.p1"]).toBe(45_000);
    expect(sumLabel(o, /^Box 1/)).toBeCloseTo(16_198.2177, 4);
    expect(-sumKind(o, "credit")).toBeCloseTo(2_138.40928 + 5_673.5225, 4);
  });

  it("arbeidskorting at its peak is 5,685 at 45,592", () => {
    expect(nlArbeidskorting(d, 45_592, false)).toBeCloseTo(5_685, 6);
    expect(nlArbeidskorting(d, 45_592, true)).toBeCloseTo(2_840, 6);
  });
});

describe("Netherlands 2026: retirees, box 2 and box 3", () => {
  it("retiree at AOW age (70), AOW 18,000 + pension 20,000: 17.85% = 6,783; AOW-age AHK 1,291.97, ouderenkorting 2,067, alleenstaande-ouderenkorting 540", () => {
    const o = nl({
      people: [{ age: 70 }],
      income: [
        { character: "pension", incomeType: "state-pension", amount: 18_000 },
        { character: "pension", amount: 20_000 },
      ],
    });
    expect(sumLabel(o, /^Box 1/)).toBeCloseTo(6_783, 6);
    expect(total(o)).toBeCloseTo(2_884.0348, 4);
  });

  it("AOW age: 67 for those born before 1961, 67 years 3 months for 1961-1965", () => {
    expect(nlAowAge(1959)).toBe(67);
    expect(nlAowAge(1962)).toBe(67.25);
  });

  it("box 3: the Belastingdienst 2026 example gives a voordeel of 15,171 and 36% tax = 5,461.57", () => {
    const r = nlBox3(
      d,
      {
        netWorth: 0,
        liquidNetWorth: 0,
        portfolio: 0,
        cash: 350_000,
        taxableInvestments: 250_000,
        debts: 90_000,
      },
      1,
    );
    expect(r.grondslag).toBeCloseTo(454_443, 6);
    expect(r.voordeel).toBeCloseTo(15_171, 0);
    expect(r.tax).toBeCloseTo(5_461.5735, 3);
    // the same through the plug-in (investment case), with no other income: credits offset box 3
    const o = nl({
      wealth: {
        netWorth: 0,
        liquidNetWorth: 0,
        portfolio: 0,
        cash: 350_000,
        taxableInvestments: 250_000,
        debts: 90_000,
      },
    });
    expect(sumKind(o, "wealth")).toBeCloseTo(5_461.5735, 3);
    // AHK on verzamelinkomen 15,171 = 3,115 (no arbeidskorting)
    expect(total(o)).toBeCloseTo(5_461.5735 - 3_115, 2);
  });

  it("box 3 with a partner doubles the allowance; actual interest and dividends are not taxed again", () => {
    const w = { netWorth: 0, liquidNetWorth: 0, portfolio: 200_000 };
    const single = nl({ wealth: w, income: [{ character: "qualified-dividend", amount: 5_000 }] });
    // (200,000 - 59,357) x 6% x 36% = 3,037.89; box 1 empty
    expect(sumKind(single, "wealth")).toBeCloseTo((200_000 - 59_357) * 0.06 * 0.36, 6);
    expect(sumLabel(single, /^Box 1/)).toBe(0);
    const couple = nl({ wealth: w, people: [{}, {}], config: { filingStatus: "married-joint" } });
    expect(sumKind(couple, "wealth")).toBeCloseTo((200_000 - 118_714) * 0.06 * 0.36, 6);
  });

  it("box 2: 100,000 of substantial-interest dividends -> 24.5% x 68,843 + 31% x 31,157", () => {
    const o = nl({
      income: [{ character: "qualified-dividend", incomeType: "nl-box2", amount: 100_000 }],
    });
    expect(sumLabel(o, /^Box 2/)).toBeCloseTo(0.245 * 68_843 + 0.31 * 31_157, 6);
  });
});
