/**
 * UK tax vectors, 2026/27. Each expectation is hand-worked from the published rates (sources in
 * src/tax/data/uk.ts: gov.uk Budget 2025 Annex A, gov.uk rates and thresholds for employers
 * 2026-27, gov.scot Scottish Rate Resolution 2026-27) and the rules on the cited gov.uk pages.
 * Working is shown in comments so each figure can be re-checked against HMRC's calculators.
 */
import { describe, expect, it } from "vitest";
import { TaxConfig } from "../src/schema/tax.js";
import { ukJurisdiction } from "../src/tax/jurisdictions/uk.js";
import { sumKind, sumLabel, taxInput, total } from "./tax-helpers.js";

const uk = (o: Parameters<typeof taxInput>[0]) => ukJurisdiction.computeYear(taxInput(o), []);
const incomeTax = (o: ReturnType<typeof uk>) => sumKind(o, "income", "dividends", "credit");
const ni = (o: ReturnType<typeof uk>) => sumLabel(o, /National Insurance/);
const salary = (amount: number, extra: Parameters<typeof taxInput>[0] = {}) =>
  uk({ ...extra, income: [{ character: "wage", amount }, ...(extra.income ?? [])] });

describe("UK income tax + NI, England/Wales/NI rates (gov.uk/income-tax-rates)", () => {
  it("£30,000 salary: tax (30,000-12,570)x20% = 3,486; NI (30,000-12,570)x8% = 1,394.40", () => {
    const o = salary(30_000);
    expect(incomeTax(o)).toBeCloseTo(3_486, 6);
    expect(ni(o)).toBeCloseTo(1_394.4, 6);
    expect(o.marginalRate).toBeCloseTo(0.2, 6);
  });

  it("£60,000 salary: 37,700x20% + 9,730x40% = 11,432; NI 37,700x8% + 9,730x2% = 3,210.60", () => {
    const o = salary(60_000);
    expect(incomeTax(o)).toBeCloseTo(11_432, 6);
    expect(ni(o)).toBeCloseTo(3_210.6, 6);
    expect(o.marginalRate).toBeCloseTo(0.4, 6);
  });

  it("£110,000 salary: PA tapered to 7,570 (gov.uk: £1 lost per £2 over £100k); tax 33,432; marginal 60%", () => {
    const o = salary(110_000);
    // taxable 102,430 = 37,700 x 20% (7,540) + 64,730 x 40% (25,892)
    expect(incomeTax(o)).toBeCloseTo(33_432, 6);
    expect(o.facts["uk.personalAllowance.p1"]).toBeCloseTo(7_570, 6);
    expect(ni(o)).toBeCloseTo(3_016 + 59_730 * 0.02, 6);
    expect(o.marginalRate).toBeCloseTo(0.6, 6);
  });

  it("personal allowance taper edges (gov.uk/income-tax-rates): full at £100,000, nil at £125,140", () => {
    // £100,000: 37,700 x 20% + (100,000 - 12,570 - 37,700) x 40% = 7,540 + 19,892 = 27,432
    const at100k = salary(100_000);
    expect(at100k.facts["uk.personalAllowance.p1"]).toBeCloseTo(12_570, 6);
    expect(incomeTax(at100k)).toBeCloseTo(27_432, 6);
    // £100,002: PA 12,569; £125,140: PA 0, 7,540 + (125,140 - 37,700) x 40% = 42,516
    expect(salary(100_002).facts["uk.personalAllowance.p1"]).toBeCloseTo(12_569, 6);
    const at125k = salary(125_140);
    expect(at125k.facts["uk.personalAllowance.p1"]).toBeCloseTo(0, 6);
    expect(incomeTax(at125k)).toBeCloseTo(42_516, 6);
  });

  it("Lifetime ISA limit £4,000 from 18 until 50 (gov.uk/lifetime-isa)", () => {
    const limit = (ownerAge: number) =>
      ukJurisdiction.contributionLimit?.({
        accountType: "uk-lisa",
        year: 2026,
        ownerAge,
        priceIndex: 1,
        earnedIncome: 0,
      });
    expect(limit(17)).toBe(0);
    expect(limit(18)).toBe(4_000);
    expect(limit(49)).toBe(4_000);
    expect(limit(50)).toBe(0);
  });

  it("£150,000 salary: no PA; 7,540 + 87,440x40% + 24,860x45% = 53,703; NI 5,010.60", () => {
    const o = salary(150_000);
    expect(incomeTax(o)).toBeCloseTo(53_703, 6);
    expect(ni(o)).toBeCloseTo(5_010.6, 6);
    expect(o.marginalRate).toBeCloseTo(0.45, 6);
  });

  it("no National Insurance above State Pension age (born 1959 -> SPA 66)", () => {
    const o = salary(30_000, { people: [{ age: 67, birthYear: 1959 }] });
    expect(ni(o)).toBe(0);
    expect(incomeTax(o)).toBeCloseTo(3_486, 6);
  });

  it("Class 4 NI on self-employed profits of £40,000: (40,000-12,570) x 6% = 1,645.80", () => {
    const o = uk({ income: [{ character: "self-employment", amount: 40_000 }] });
    expect(sumKind(o, "self-employment")).toBeCloseTo(1_645.8, 6);
    expect(incomeTax(o)).toBeCloseTo(5_486, 6);
  });
});

describe("Scottish income tax 2026/27 (gov.scot Scottish Rate Resolution 2026-27)", () => {
  it("£30,000: 3,967x19% + 12,989x20% + 474x21% = 3,451.07", () => {
    const o = salary(30_000, { region: "SCT" });
    expect(incomeTax(o)).toBeCloseTo(3_451.07, 6);
    expect(ni(o)).toBeCloseTo(1_394.4, 6);
    expect(o.marginalRate).toBeCloseTo(0.21, 6);
  });

  it("£60,000: 753.73 + 2,597.80 + 14,136x21% + 16,338x42% = 13,182.05", () => {
    expect(incomeTax(salary(60_000, { region: "SCT" }))).toBeCloseTo(13_182.05, 6);
  });

  it("£150,000 (no PA): starter..top = 59,634.35", () => {
    // 753.73 + 2,597.80 + 2,968.56 + 31,338x42% (13,161.96) + 62,710x45% (28,219.50) + 24,860x48% (11,932.80)
    expect(incomeTax(salary(150_000, { region: "SCT" }))).toBeCloseTo(59_634.35, 6);
  });
});

describe("UK savings and dividends (gov.uk/apply-tax-free-interest-on-savings, /tax-on-dividends)", () => {
  it("salary £20,000 + interest £3,000: no starting rate, PSA £1,000, 2,000 x 20% = 400", () => {
    const o = salary(20_000, { income: [{ character: "interest", amount: 3_000 }] });
    expect(sumLabel(o, /savings/)).toBeCloseTo(400, 6);
    expect(incomeTax(o)).toBeCloseTo(1_486 + 400, 6);
  });

  it("pension £14,000 + interest £6,000: starting rate band 3,570 + PSA 1,000; 1,430 x 20% = 286", () => {
    const o = uk({
      people: [{ age: 70, birthYear: 1956 }],
      income: [
        { character: "pension", amount: 14_000 },
        { character: "interest", amount: 6_000 },
      ],
    });
    expect(sumLabel(o, /savings/)).toBeCloseTo(286, 6);
    expect(incomeTax(o)).toBeCloseTo(286 + 286, 6);
  });

  it("2027/28 savings rates 24/44/49 (Budget 2026 Annex A, announced): same case at 24% = 480", () => {
    const o = salary(20_000, { year: 2027, income: [{ character: "interest", amount: 3_000 }] });
    expect(sumLabel(o, /savings/)).toBeCloseTo(480, 6);
  });

  it("salary £40,000 + dividends £10,000: allowance £500 then 9,500 x 10.75% = 1,021.25", () => {
    const o = salary(40_000, { income: [{ character: "qualified-dividend", amount: 10_000 }] });
    expect(sumKind(o, "dividends")).toBeCloseTo(1_021.25, 6);
    expect(incomeTax(o)).toBeCloseTo(5_486 + 1_021.25, 6);
    expect(ni(o)).toBeCloseTo(2_194.4, 6);
  });

  it("salary £12,570 + dividends £50,000 spanning basic and higher: 3,999 + 4,397.25 = 8,396.25", () => {
    const o = salary(12_570, { income: [{ character: "qualified-dividend", amount: 50_000 }] });
    expect(sumKind(o, "dividends")).toBeCloseTo(8_396.25, 6);
  });

  it("2027/28 property income rates (24/44/49, Budget 2026) apply outside Scotland only", () => {
    const rent = { character: "rental" as const, amount: 10_000 };
    const eng = salary(30_000, { year: 2027, income: [rent] });
    // all within basic band: 30,000-12,570 = 17,430 x 20% + 10,000 x 24%
    expect(incomeTax(eng)).toBeCloseTo(3_486 + 2_400, 6);
    const sct = salary(30_000, { year: 2027, region: "SCT", income: [rent] });
    // Scottish rates on 27,430 taxable: 753.73 + 2,597.80 + 10,474x21%
    expect(incomeTax(sct)).toBeCloseTo(753.73 + 2_597.8 + 10_474 * 0.21, 6);
  });
});

describe("UK capital gains tax (gov.uk/capital-gains-tax/rates)", () => {
  it("salary £40,000 + gain £20,000: AEA 3,000; 10,270 x 18% + 6,730 x 24% = 3,463.80", () => {
    const o = salary(40_000, {
      withdrawals: [
        {
          accountType: "uk-gia",
          treatment: "taxable",
          amount: 50_000,
          taxableAmount: 20_000,
          character: "capital-gains-long",
        },
      ],
    });
    expect(sumKind(o, "capital-gains")).toBeCloseTo(3_463.8, 6);
  });
  it("gain within the annual exempt amount is tax-free", () => {
    const o = salary(40_000, { income: [{ character: "capital-gains-long", amount: 2_999 }] });
    expect(sumKind(o, "capital-gains")).toBe(0);
  });
});

describe("UK pensions", () => {
  it("drawdown year: State Pension £12,547.60 + UFPLS £20,000 (25% tax-free) at 67 = 2,995.52, no NI", () => {
    const o = uk({
      people: [{ age: 67, birthYear: 1959 }],
      income: [{ character: "pension", amount: 241.3 * 52 }],
      withdrawals: [{ accountType: "uk-sipp", amount: 20_000, taxableAmount: 15_000 }],
    });
    // (12,547.60 + 15,000 - 12,570) x 20%
    expect(total(o)).toBeCloseTo(2_995.52, 6);
    expect(o.facts["uk.lsaUsed.p1"]).toBeCloseTo(5_000, 6);
    expect(o.facts["uk.flexiblyAccessed.p1"]).toBe(1);
  });

  it("lump sum allowance: once £268,275 of tax-free cash is used the excess is taxable", () => {
    const o = uk({
      people: [{ age: 70, birthYear: 1956 }],
      income: [{ character: "pension", amount: 30_000 }],
      withdrawals: [{ accountType: "uk-sipp", amount: 40_000, taxableAmount: 30_000 }],
      history: [{ "uk.lsaUsed.p1": 260_000 }],
    });
    // tax-free allowed 8,275, excess 1,725 taxable: (60,000 + 1,725 - 12,570) -> 37,700x20% + 11,455x40%
    expect(incomeTax(o)).toBeCloseTo(7_540 + 11_455 * 0.4, 6);
    expect(o.facts["uk.lsaUsed.p1"]).toBeCloseTo(268_275, 6);
  });

  it("net pay contribution £3,000 on £60,000: income tax relief, no NI relief", () => {
    const o = salary(60_000, {
      deductions: [{ amount: 3_000, accountType: "uk-workplace-pension" }],
    });
    expect(incomeTax(o)).toBeCloseTo(7_540 + 6_730 * 0.4, 6);
    expect(ni(o)).toBeCloseTo(3_210.6, 6);
  });

  it("relief at source: £4,000 net (£5,000 gross) extends the basic band; top-up £1,000 reported", () => {
    const o = salary(60_000, { deductions: [{ amount: 4_000, accountType: "uk-sipp" }] });
    expect(incomeTax(o)).toBeCloseTo(42_700 * 0.2 + 4_730 * 0.4, 6);
    expect(o.facts["uk.reliefAtSourceTopUp"]).toBeCloseTo(1_000, 6);
  });

  it("relief at source restores the personal allowance at £110,000 with £10,000 gross", () => {
    const o = salary(110_000, { deductions: [{ amount: 8_000, accountType: "uk-sipp" }] });
    expect(o.facts["uk.adjustedNetIncome.p1"]).toBeCloseTo(100_000, 6);
    expect(incomeTax(o)).toBeCloseTo(47_700 * 0.2 + 49_730 * 0.4, 6);
  });

  it("salary sacrifice £5,000 on £60,000 saves income tax and NI", () => {
    const o = salary(60_000, {
      deductions: [{ amount: 5_000, pensionScheme: "salary-sacrifice" }],
    });
    expect(incomeTax(o)).toBeCloseTo(7_540 + 4_730 * 0.4, 6);
    expect(ni(o)).toBeCloseTo(3_016 + 4_730 * 0.02, 6);
  });

  it("from 2029/30 only £2,000 of salary sacrifice is NI-free (Budget 2025)", () => {
    const o = salary(60_000, {
      year: 2029,
      deductions: [{ amount: 5_000, pensionScheme: "salary-sacrifice" }],
    });
    // NI-able pay = 60,000 - 2,000 = 58,000: 3,016 + 7,730 x 2%
    expect(ni(o)).toBeCloseTo(3_016 + 7_730 * 0.02, 6);
  });

  it("tapered annual allowance: £300k salary + £60k employer -> AA £10k, £50k excess charged at 45%", () => {
    const o = salary(300_000, { deductions: [{ amount: 60_000, employer: true }] });
    expect(sumLabel(o, /annual allowance/)).toBeCloseTo(22_500, 6);
  });

  it("MPAA after flexible access: £15k contributions vs £10k allowance -> £5k charged at 20%", () => {
    const o = salary(40_000, {
      deductions: [{ amount: 15_000 }],
      history: [{ "uk.flexiblyAccessed.p1": 1 }],
    });
    expect(sumLabel(o, /annual allowance/)).toBeCloseTo(1_000, 6);
  });
});

describe("UK household rules", () => {
  it("marriage allowance: £1,260 transferred; recipient on £30,000 saves £252", () => {
    const o = uk({
      people: [{}, {}],
      config: { filingStatus: "married-joint" },
      income: [
        { owner: "p1", character: "wage", amount: 10_000 },
        { owner: "p2", character: "wage", amount: 30_000 },
      ],
    });
    expect(incomeTax(o)).toBeCloseTo(3_486 - 252, 6);
    expect(o.facts["uk.marriageAllowanceRelief"]).toBeCloseTo(252, 6);
  });

  it("High Income Child Benefit Charge: ANI £70,000, two children -> 50% of £2,337.40", () => {
    const o = salary(70_000, { dependents: [3, 6], config: { uk: { childBenefitClaimed: true } } });
    expect(sumLabel(o, /Child Benefit/)).toBeCloseTo((27.05 + 17.9) * 52 * 0.5, 6);
  });

  it("student loan Plan 2 on £40,000: 9% x (40,000 - 29,385) = 955.35", () => {
    const o = salary(40_000, {
      config: { uk: { studentLoans: [{ personId: "p1", plan: "plan2" }] } },
    });
    expect(sumLabel(o, /Student loan/)).toBeCloseTo(955.35, 6);
  });

  it("Plan 1 + postgraduate on £40,000: 9% over £26,900 and 6% over £21,000 concurrently", () => {
    const o = salary(40_000, {
      config: {
        uk: {
          studentLoans: [
            { personId: "p1", plan: "plan1" },
            { personId: "p1", plan: "postgraduate" },
          ],
        },
      },
    });
    expect(sumLabel(o, /Student loan/)).toBeCloseTo(1_179, 6);
    expect(sumLabel(o, /Postgraduate/)).toBeCloseTo(1_140, 6);
  });

  it("student loan stops at the outstanding balance and after write-off", () => {
    const cfg = (balance: number, writeOffYear?: number) => ({
      uk: {
        studentLoans: [
          {
            personId: "p1",
            plan: "plan2" as const,
            balance,
            ...(writeOffYear ? { writeOffYear } : {}),
          },
        ],
      },
    });
    expect(sumLabel(salary(40_000, { config: cfg(500) }), /Student/)).toBeCloseTo(500, 6);
    expect(sumLabel(salary(40_000, { config: cfg(5_000, 2026) }), /Student/)).toBe(0);
  });
});

describe("UK thresholds: proration and indexation policy", () => {
  it("a 6-month period prorates thresholds", () => {
    expect(incomeTax(salary(30_000, { months: 6 }))).toBeCloseTo(11_432 / 2, 6);
  });
  it("legislated: frozen through 2030/31, then indexed from the anchor price index", () => {
    const o = salary(30_000, {
      year: 2031,
      priceIndex: 1.26,
      history: [{ "uk.indexAnchor": 1.2 }],
    });
    expect(incomeTax(o)).toBeCloseTo((30_000 - 12_570 * 1.05) * 0.2, 6);
    expect(incomeTax(salary(30_000, { year: 2030, priceIndex: 1.2 }))).toBeCloseTo(3_486, 6);
  });
  it("frozen and indexed policies", () => {
    const frozen = salary(30_000, {
      year: 2031,
      priceIndex: 1.26,
      config: { thresholdIndexation: "frozen" },
    });
    expect(incomeTax(frozen)).toBeCloseTo(3_486, 6);
    const idx = salary(30_000, {
      year: 2031,
      priceIndex: 1.26,
      config: { thresholdIndexation: "indexed" },
    });
    expect(incomeTax(idx)).toBeCloseTo((30_000 - 12_570 * 1.26) * 0.2, 6);
  });
  it("explainYear returns bracket fill for each schedule", () => {
    const o = ukJurisdiction.explainYear!(
      taxInput({ income: [{ character: "wage", amount: 60_000 }] }),
      [],
    );
    const ns = o.brackets!.find((b) => b.schedule === "non-savings")!;
    expect(ns.bands.map((b) => b.amount)).toEqual([37_700, 9_730]);
  });
});

describe("TaxConfig schema additions (optional, additive)", () => {
  it("parses without the new fields and round-trips them when present", async () => {
    const { TaxConfig } = await import("../src/schema/tax.js");
    const plain = TaxConfig.parse({});
    expect(plain.uk).toBeUndefined();
    expect(plain.thresholdIndexation).toBeUndefined();
    const full = TaxConfig.parse({
      thresholdIndexation: "frozen",
      localIncomeTaxRate: 0.01,
      uk: {
        studentLoans: [{ personId: "p1", plan: "plan2", balance: 40_000 }],
        childBenefitClaimed: true,
      },
      custom: {
        ordinary: { brackets: [{ from: 0, rate: 0.2 }] },
        flatEffectiveRate: 0.2,
        financialTransactionTax: { rate: 0.001 },
      },
    });
    expect(TaxConfig.parse(JSON.parse(JSON.stringify(full)))).toEqual(full);
    expect(full.custom?.financialTransactionTax?.base).toBe("purchases");
  });
});

/**
 * Worked examples published by gov.uk, reproduced exactly (pages read 2026-11-19). Each test names
 * the page; the inputs are the page's own figures.
 */
describe("gov.uk worked examples, 2026/27", () => {
  it("gov.uk/tax-on-dividends: £29,570 wages + £3,000 dividends -> 17,000 x 20% + 2,500 x 10.75%", () => {
    const o = salary(29_570, { income: [{ character: "qualified-dividend", amount: 3_000 }] });
    expect(sumKind(o, "dividends")).toBeCloseTo(268.75, 6);
    expect(incomeTax(o)).toBeCloseTo(3_400 + 268.75, 6);
  });

  it("gov.uk/apply-tax-free-interest-on-savings/how-much-is-tax-free: £16,000 wages + £200 interest -> no tax on the interest", () => {
    const o = salary(16_000, { income: [{ character: "interest", amount: 200 }] });
    expect(sumLabel(o, /savings/)).toBe(0);
    expect(incomeTax(o)).toBeCloseTo(3_430 * 0.2, 6);
  });

  it("gov.uk/apply-tax-free-interest-on-savings/how-much-is-tax-free: basic-rate taxpayer with £1,300 interest pays £60", () => {
    // Wages above £17,570 so the starting rate is used up; £1,000 PSA, then 300 x 20%.
    const o = salary(30_000, { income: [{ character: "interest", amount: 1_300 }] });
    expect(sumLabel(o, /savings/)).toBeCloseTo(60, 6);
  });

  it("gov.uk/capital-gains-tax/rates: taxable income £20,000, gains £12,600 -> £1,728", () => {
    const o = salary(32_570, { income: [{ character: "capital-gains-long", amount: 12_600 }] });
    expect(sumKind(o, "capital-gains")).toBeCloseTo(1_728, 6);
  });

  it("gov.uk/capital-gains-tax/rates: taxable income £20,000, gains £52,600 -> 17,700 x 18% + 31,900 x 24% = £10,842", () => {
    const o = salary(32_570, { income: [{ character: "capital-gains-long", amount: 52_600 }] });
    expect(sumKind(o, "capital-gains")).toBeCloseTo(10_842, 6);
  });

  it("gov.uk/marriage-allowance: incomes £11,500 and £20,000 -> the couple saves £214", () => {
    const couple = (lawToggles: Record<string, boolean>) =>
      uk({
        people: [{}, {}],
        config: { filingStatus: "married-joint", lawToggles },
        income: [
          { owner: "p1", character: "wage", amount: 11_500 },
          { owner: "p2", character: "wage", amount: 20_000 },
        ],
      });
    const off = couple({ "uk.marriageAllowance": false });
    const on = couple({});
    expect(incomeTax(off) - incomeTax(on)).toBeCloseTo(214, 6);
  });

  it("gov.uk/self-employed-national-insurance-rates: Class 4 6% on £12,570-£50,270, 2% above", () => {
    const o = uk({ income: [{ character: "self-employment", amount: 60_000 }] });
    expect(sumKind(o, "self-employment")).toBeCloseTo(37_700 * 0.06 + 9_730 * 0.02, 6);
  });
});

/**
 * Pension Tax Allowance, 2027/28 (Budget 2026 OOTLAR para 1.4 and Annex A; announced, Finance Bill
 * 2026-27): over State Pension age, up to 20% x (£13,037 - £12,570) = £93.40 off income tax,
 * withdrawn at £1 for every £3 of total income above £13,037.
 */
describe("UK Pension Tax Allowance 2027/28 (announced)", () => {
  const pensioner = (amount: number, year = 2027, age = 70) =>
    uk({
      year,
      people: [{ age, birthYear: year - age }],
      income: [{ character: "pension", amount }],
    });

  it("only the full new State Pension (£250.70 x 52 = £13,036.40): no income tax", () => {
    const o = pensioner(250.7 * 52);
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo((13_036.4 - 12_570) * 0.2, 6);
    expect(sumLabel(o, /Pension Tax Allowance/)).toBeCloseTo(-(13_036.4 - 12_570) * 0.2, 6);
    expect(total(o)).toBeCloseTo(0, 6);
  });

  it("£13,237 (£200 above the threshold): allowance 93.40 - 200/3 = 26.73", () => {
    const o = pensioner(13_237);
    expect(sumLabel(o, /Pension Tax Allowance/)).toBeCloseTo(-(93.4 - 200 / 3), 6);
    expect(total(o)).toBeCloseTo(667 * 0.2 - (93.4 - 200 / 3), 6);
  });

  it("withdrawn in full by about £13,317 (Annex A rounds it to £13,319)", () => {
    expect(sumLabel(pensioner(13_320), /Pension Tax Allowance/)).toBe(0);
  });

  it("not below State Pension age, and not in 2026/27", () => {
    expect(sumLabel(pensioner(13_000, 2027, 60), /Pension Tax Allowance/)).toBe(0);
    expect(sumLabel(pensioner(13_000, 2026), /Pension Tax Allowance/)).toBe(0);
  });

  it("ends after 2029/30", () => {
    expect(sumLabel(pensioner(13_000, 2029), /Pension Tax Allowance/)).toBeLessThan(0);
    expect(sumLabel(pensioner(13_000, 2030), /Pension Tax Allowance/)).toBe(0);
  });
});

describe("UK 2027/28 published rates", () => {
  it("cash ISA: no statutory sub-limit (Budget 2026 kept the full £20,000)", () => {
    const q = (uk?: Record<string, unknown>) => ({
      accountType: "uk-isa" as const,
      subtype: "cash",
      ownerAge: 30,
      year: 2028,
      config: TaxConfig.parse({ mode: "estimate", ...(uk ? { uk } : {}) }),
    });
    expect(ukJurisdiction.contributionSubLimit!(q())).toBeNull();
    expect(ukJurisdiction.contributionSubLimit!(q({ cashIsaLimit: { amount: 12_000 } }))).toEqual({
      key: "uk-cash-isa",
      annual: 12_000,
      from: "2027-04",
    });
  });

  it("High Income Child Benefit Charge uses the 2027/28 rates (£28.00 and £18.55 a week)", () => {
    const o = salary(70_000, {
      year: 2027,
      dependents: [3, 6],
      config: { uk: { childBenefitClaimed: true } },
    });
    expect(sumLabel(o, /Child Benefit/)).toBeCloseTo((28 + 18.55) * 52 * 0.5, 6);
  });
});
