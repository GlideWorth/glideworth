/**
 * Cross-border model: residency timeline, source taxation, treaties, wrappers, exit/return rules.
 * All households and figures are invented. Each UK expectation cites the gov.uk guidance it rests on.
 * Hand-worked numbers use 0% inflation and returns so the arithmetic is visible.
 */
import { describe, expect, it } from "vitest";
import { simulate } from "../src/engine/simulate.js";
import type {
  PeriodResult,
  ProjectionResult,
  SimulationInputInput,
  TaxLine,
} from "../src/engine/types.js";
import type { AccountInput } from "../src/schema/accounts.js";
import type { RealAssetInput } from "../src/schema/assets-debts.js";
import type { PersonInput } from "../src/schema/household.js";
import type { PlanInput } from "../src/schema/plan.js";
import { caFederalJurisdiction, caProvinceJurisdiction } from "../src/tax/jurisdictions/ca.js";
import type { TaxYearInput, TaxYearOutput } from "../src/tax/types.js";

type Person = PersonInput;

const ZERO = {
  inflation: { kind: "fixed" as const, rate: 0 },
  stockReturn: { kind: "fixed" as const, rate: 0 },
  dividendYield: { kind: "fixed" as const, rate: 0 },
  bondReturn: { kind: "fixed" as const, rate: 0 },
  bondYield: { kind: "fixed" as const, rate: 0 },
  cashReturn: { kind: "fixed" as const, rate: 0 },
};

function uk(over: {
  people?: Person[];
  accounts?: AccountInput[];
  realAssets?: RealAssetInput[];
  plan?: Partial<PlanInput>;
  fx?: { from: string; to: string; rate: number; annualDrift?: number }[];
  end?: string;
  location?: { country: string; region?: string };
  currency?: string;
  asOf?: string;
  fiscal?: boolean;
}): SimulationInputInput {
  const people = over.people ?? [
    { id: "me", name: "Me", role: "primary", birthMonth: "1970-06", citizenships: ["GB"] },
  ];
  const fiscal = over.fiscal ?? true;
  return {
    household: {
      id: "h",
      name: "Mover",
      planningMode: people.length > 1 ? "couple" : "individual",
      people,
      location: over.location ?? { country: "GB", region: "ENG" },
      currency: over.currency ?? "GBP",
      locale: "en-GB",
    },
    finances: {
      asOf: over.asOf ?? "2026-04",
      accounts: [
        { id: "cash", name: "Cash", type: "savings", owner: "me", balance: 1_000_000 },
        ...(over.accounts ?? []),
      ],
      realAssets: over.realAssets ?? [],
      fxRates: (over.fx ?? []).map((r) => ({ annualDrift: 0, ...r })),
    },
    plan: {
      id: "p",
      householdId: "h",
      name: "Plan",
      tax: { mode: "estimate" },
      ...over.plan,
      assumptions: {
        ...ZERO,
        yearAlignment: fiscal ? { kind: "fiscal", startMonth: 4 } : { kind: "calendar" },
        end: { kind: "ref", ref: { kind: "date", date: over.end ?? "2028-04" } },
        ...over.plan?.assumptions,
      },
    },
    options: { trace: "summary" },
  };
}

const always = { start: { kind: "planStart" as const }, end: { kind: "planEnd" as const } };
const at = (date: string) => ({ kind: "date" as const, date });
const moveTo = (country: string, date: string, personId?: string) => ({
  id: `move-${country}-${date}`,
  from: at(date),
  location: { country },
  ...(personId ? { personId } : {}),
});
const AED_GBP = { from: "AED", to: "GBP", rate: 0.2 };

const period = (r: ProjectionResult, year: number): PeriodResult =>
  r.periods.find((p) => p.year === year)!;
const sum = (ls: TaxLine[]) => ls.reduce((s, l) => s + l.amount, 0);
const linesOf = (p: PeriodResult, f: (l: TaxLine) => boolean) => sum(p.taxes.lines.filter(f));

/** UK rental property worth £400k (bought 2010), £20,000 a year rent, no costs. */
const ukFlat = (extra: Partial<RealAssetInput> = {}): RealAssetInput => ({
  id: "flat",
  name: "UK flat",
  type: "rental-property",
  owner: "me",
  currentValue: 400_000,
  purchasePrice: 250_000,
  country: "GB",
  behaviour: {
    usage: "investment",
    appreciation: { kind: "none" },
    rental: {
      enabled: true,
      income: { kind: "amountPerYear", amount: { value: 20_000, basis: "nominal" } },
      taxSettings: { estimateDeductions: false },
    },
  },
  ...extra,
});

describe("UK -> UAE mover", () => {
  it("UK rent of a British non-resident: UK tax at UK rates with the Personal Allowance; UAE taxes nothing (gov.uk/tax-uk-income-live-abroad/rent and /personal-allowance)", () => {
    const r = simulate(
      uk({
        realAssets: [ukFlat()],
        plan: { residency: [moveTo("AE", "2026-04")] },
        fx: [AED_GBP],
      }),
    );
    const p = period(r, 2026);
    // (20,000 - 12,570) x 20% = 1,486 (2026/27 rates).
    expect(linesOf(p, (l) => l.basis === "source" && l.country === "GB")).toBeCloseTo(1_486, 6);
    expect(linesOf(p, (l) => l.country === "AE")).toBe(0);
    expect(p.taxes.total).toBeCloseTo(1_486, 6);
    expect(p.taxes.residence?.me).toEqual([{ country: "AE", months: 12 }]);
    // 2027/28: separate property income rates from April 2027 (22%): 7,430 x 22% = 1,634.60.
    expect(period(r, 2027).taxes.total).toBeCloseTo(1_634.6, 6);
  });

  it("a non-resident who is neither British nor EEA has no Personal Allowance on UK rent (gov.uk/tax-uk-income-live-abroad/personal-allowance)", () => {
    const r = simulate(
      uk({
        people: [
          { id: "me", name: "Me", role: "primary", birthMonth: "1970-06", citizenships: ["IN"] },
        ],
        realAssets: [ukFlat()],
        plan: { residency: [moveTo("AE", "2026-04")] },
        fx: [AED_GBP],
      }),
    );
    // 20,000 x 20% = 4,000.
    expect(period(r, 2026).taxes.total).toBeCloseTo(4_000, 6);
  });

  it("UAE pay is not taxed in the UK after the move; a split year gives each country its months (salary sourced where earned)", () => {
    const r = simulate(
      uk({
        plan: {
          residency: [moveTo("AE", "2026-10")],
          income: [
            {
              id: "uk-pay",
              name: "UK salary",
              type: "salary",
              owner: "me",
              amount: { value: 60_000, basis: "nominal" },
              frequency: "yearly",
              change: { kind: "none" },
              range: { start: { kind: "planStart" }, end: at("2026-10") },
            },
            {
              id: "ae-pay",
              name: "UAE salary",
              type: "salary",
              owner: "me",
              amount: { value: 300_000, basis: "nominal" },
              frequency: "yearly",
              currency: "AED",
              change: { kind: "none" },
              range: { start: at("2026-10"), end: { kind: "planEnd" } },
            },
          ],
        },
        fx: [AED_GBP],
        end: "2027-04",
      }),
    );
    const p = period(r, 2026);
    // UK: £30,000 earned while resident (6 months), thresholds for 6 months:
    // PA 6,285; (30,000 - 6,285) = 23,715 taxable; basic band 18,850 x 20% = 3,770; 4,865 x 40% = 1,946.
    // Class 1 NI for 6 months: 8% x (25,135 - 6,285) + 2% x (30,000 - 25,135) = 1,508 + 97.30.
    const ukTax = linesOf(p, (l) => l.country === "GB");
    expect(ukTax).toBeCloseTo(3_770 + 1_946 + 1_508 + 97.3, 4);
    expect(linesOf(p, (l) => l.country === "AE")).toBe(0);
    expect(p.taxes.residence?.me).toEqual([
      { country: "GB", region: "ENG", months: 6 },
      { country: "AE", months: 6 },
    ]);
  });

  it("UK pension drawdown while UAE-resident: taxable only in the UAE under the UK-UAE treaty Art. 17, so no tax at all (gov.uk/tax-uk-income-live-abroad/pensions)", () => {
    const sipp: AccountInput = {
      id: "sipp",
      name: "SIPP",
      type: "uk-sipp",
      owner: "me",
      balance: 300_000,
      behaviour: {
        distributions: {
          kind: "custom",
          basis: "nominal",
          points: [{ at: { kind: "planStart" }, value: 30_000 }],
        },
      },
    };
    const r = simulate(
      uk({ accounts: [sipp], plan: { residency: [moveTo("AE", "2026-04")] }, fx: [AED_GBP] }),
    );
    const p = period(r, 2026);
    expect(p.accounts.find((a) => a.accountId === "sipp")!.withdrawals).toBeCloseTo(30_000, 6);
    expect(p.taxes.total).toBe(0);
    // The same drawdown by a resident of a country without a treaty in Glideworth's tables (and no preset):
    // UK taxes it as a non-resident (25% UFPLS tax-free; 22,500 - 12,570 = 9,930 x 20% = 1,986) and warns.
    const r2 = simulate(uk({ accounts: [sipp], plan: { residency: [moveTo("SG", "2026-04")] } }));
    expect(period(r2, 2026).taxes.total).toBeCloseTo(1_986, 6);
    expect(r2.warnings.some((w) => /No tax treaty between GB and SG/.test(w.message))).toBe(true);
    expect(r2.warnings.some((w) => /no tax preset for SG/.test(w.message))).toBe(true);
  });

  it("ISA held but not funded: it keeps its UK shelter, but no subscriptions after the tax year of departure (gov.uk/individual-savings-accounts/if-you-move-abroad)", () => {
    const r = simulate(
      uk({
        accounts: [{ id: "isa", name: "ISA", type: "uk-isa", owner: "me", balance: 50_000 }],
        plan: {
          residency: [moveTo("AE", "2027-04")],
          flows: [
            {
              kind: "contribution",
              id: "f-isa",
              name: "ISA",
              owner: "me",
              accountId: "isa",
              range: always,
              method: {
                kind: "amount",
                amount: { value: 10_000, basis: "nominal" },
                frequency: "yearly",
              },
            },
          ],
          income: [
            {
              id: "pay",
              name: "Pay",
              type: "salary",
              owner: "me",
              amount: { value: 40_000, basis: "nominal" },
              frequency: "yearly",
              change: { kind: "none" },
              range: { start: { kind: "planStart" }, end: at("2027-04") },
            },
            {
              id: "ae-pay",
              name: "UAE pay",
              type: "salary",
              owner: "me",
              amount: { value: 300_000, basis: "nominal" },
              currency: "AED",
              frequency: "yearly",
              change: { kind: "none" },
              range: { start: at("2027-04"), end: { kind: "planEnd" } },
            },
          ],
        },
        fx: [AED_GBP],
      }),
    );
    expect(period(r, 2026).accounts.find((a) => a.accountId === "isa")!.contributions).toBeCloseTo(
      10_000,
      6,
    );
    expect(period(r, 2027).accounts.find((a) => a.accountId === "isa")!.contributions).toBe(0);
    // The money went down the waterfall instead (the UAE pay is saved to cash).
    expect(
      period(r, 2027).accounts.find((a) => a.accountId === "cash")!.contributions,
    ).toBeGreaterThan(10_000);
    expect(r.trace.some((t) => t.code === "NON_RESIDENT_WRAPPER")).toBe(true);
  });

  const gia: AccountInput = {
    id: "gia",
    name: "GIA",
    type: "uk-gia",
    owner: "me",
    balance: 100_000,
    costBasis: 40_000,
    behaviour: {
      distributions: {
        kind: "custom",
        basis: "nominal",
        points: [
          { at: at("2026-04"), value: 0 },
          { at: at("2028-04"), value: 100_000 },
          { at: at("2029-04"), value: 0 },
        ],
      },
    },
  };

  it("gains realised in the UAE and a return within five years: taxed in the UK in the tax year of return (HS278 temporary non-residence)", () => {
    const r = simulate(
      uk({
        accounts: [gia],
        plan: { residency: [moveTo("AE", "2027-04"), moveTo("GB", "2031-04")] },
        fx: [AED_GBP],
        end: "2032-04",
      }),
    );
    // While in the UAE: no tax on the £60,000 gain.
    expect(period(r, 2028).taxes.total).toBe(0);
    // Back in 2031/32 with no other income: (60,000 - 3,000) taxed at CGT rates using the basic band:
    // 37,700 x 18% + 19,300 x 24% = 6,786 + 4,632 = 11,418.
    const back = period(r, 2031);
    expect(back.taxes.total).toBeCloseTo(11_418, 6);
    expect(back.taxes.byCountry).toContainEqual({
      country: "GB",
      basis: "return",
      amount: expect.closeTo(11_418, 6),
    });
    expect(r.trace.some((t) => t.code === "UK_TEMPORARY_NON_RESIDENCE")).toBe(true);
  });

  it("a return after more than five years brings no charge (HS278: non-residence must be 5 years or less)", () => {
    const r = simulate(
      uk({
        accounts: [gia],
        plan: { residency: [moveTo("AE", "2027-04"), moveTo("GB", "2032-06")] },
        fx: [AED_GBP],
        end: "2034-04",
      }),
    );
    for (const p of r.periods) expect(p.taxes.total).toBe(0);
  });

  it("non-resident CGT on a UK flat: only the gain since the 5 April 2015 value (gov.uk non-resident CGT calculation guidance)", () => {
    const flat = ukFlat({
      acquiredOn: "2010-04",
      valuations: [{ month: "2015-04", value: 300_000 }],
      behaviour: {
        usage: "investment",
        appreciation: { kind: "none" },
        sale: { at: at("2026-06"), brokerFeeRate: 0 },
      },
    });
    const r = simulate(
      uk({
        realAssets: [flat],
        plan: { residency: [moveTo("AE", "2026-04")] },
        fx: [AED_GBP],
        end: "2027-04",
      }),
    );
    const p = period(r, 2026);
    // Whole gain 400,000 - 250,000 = 150,000; time-apportioned 150,000 x 134/194 = 103,608.25;
    // rebased 400,000 - 300,000 = 100,000 (the lowest). Chargeable 100,000 - 3,000 AEA, with the
    // basic band (PA 12,570 unused: CGT bands use income only): 37,700 x 18% + 59,300 x 24%.
    expect(p.taxes.total).toBeCloseTo(37_700 * 0.18 + 59_300 * 0.24, 4);
  });

  it("UK State Pension is frozen in the UAE (no social security agreement) and uprated again on return (gov.uk State Pension abroad rates)", () => {
    const base = uk({
      people: [
        { id: "me", name: "Me", role: "primary", birthMonth: "1958-06", citizenships: ["GB"] },
      ],
      plan: {
        residency: [moveTo("AE", "2027-04"), moveTo("GB", "2030-04")],
        assumptions: { inflation: { kind: "fixed", rate: 0.03 } },
        income: [
          {
            id: "sp",
            name: "State Pension",
            type: "state-pension",
            owner: "me",
            country: "GB",
            amount: { value: 12_000, basis: "nominal" },
            frequency: "yearly",
            change: { kind: "rate", rate: 0.04 },
            range: always,
            deferral: { kind: "none" },
          },
        ],
      },
      fx: [AED_GBP],
      end: "2031-04",
    });
    const r = simulate(base);
    const sp = (y: number) => period(r, y).income.find((i) => i.sourceId === "sp")!.amount;
    expect(sp(2026)).toBeCloseTo(12_000, 6);
    expect(sp(2027)).toBeCloseTo(12_480, 6); // frozen at the April 2027 rate when leaving
    expect(sp(2028)).toBeCloseTo(12_480, 6);
    expect(sp(2029)).toBeCloseTo(12_480, 6);
    expect(sp(2030)).toBeCloseTo(12_000 * 1.04 ** 4, 6); // back to the current rate
  });

  it("a UK pension keeps the UK access age wherever its owner lives", () => {
    const sipp: AccountInput = {
      id: "sipp",
      name: "SIPP",
      type: "uk-sipp",
      owner: "me",
      balance: 100_000,
    };
    const r = simulate(
      uk({
        people: [
          { id: "me", name: "Me", role: "primary", birthMonth: "1975-06", citizenships: ["GB"] },
        ],
        accounts: [sipp],
        plan: {
          residency: [moveTo("AE", "2026-04")],
          expenses: [
            {
              id: "x",
              name: "Living",
              type: "living",
              owner: "joint",
              amount: { value: 10_000, basis: "nominal" },
              frequency: "yearly",
              change: { kind: "none" },
              range: always,
              payFrom: { kind: "accounts", accountIds: ["sipp"] },
            },
          ],
        },
        fx: [AED_GBP],
      }),
    );
    // Aged 50-51: a UK pension cannot be drawn before 55 (57 from 2028), even from the UAE.
    expect(period(r, 2026).accounts.find((a) => a.accountId === "sipp")!.withdrawals).toBe(0);
  });
});

describe("UAE -> UK mover", () => {
  it("UAE years tax-free; UK pay and the gain inside a UAE savings scheme (not recognised in the UK) taxed after arrival, converted AED <-> GBP", () => {
    const r = simulate({
      ...uk({
        location: { country: "AE" },
        currency: "AED",
        people: [
          { id: "me", name: "Me", role: "primary", birthMonth: "1980-03", citizenships: ["GB"] },
        ],
        accounts: [
          {
            id: "ess",
            name: "Savings scheme",
            type: "ae-savings-scheme",
            owner: "me",
            balance: 200_000,
            costBasis: 120_000,
            behaviour: {
              distributions: {
                kind: "custom",
                basis: "nominal",
                points: [
                  { at: at("2026-04"), value: 0 },
                  { at: at("2027-04"), value: 200_000 },
                  { at: at("2028-04"), value: 0 },
                ],
              },
            },
          },
        ],
        plan: {
          residency: [
            { id: "to-uk", from: at("2027-04"), location: { country: "GB", region: "ENG" } },
          ],
          income: [
            {
              id: "uk-pay",
              name: "UK salary",
              type: "salary",
              owner: "me",
              amount: { value: 60_000, basis: "nominal" },
              currency: "GBP",
              frequency: "yearly",
              change: { kind: "none" },
              range: { start: at("2027-04"), end: { kind: "planEnd" } },
            },
          ],
        },
        fx: [{ from: "GBP", to: "AED", rate: 5 }],
      }),
    });
    expect(period(r, 2026).taxes.total).toBe(0);
    const p = period(r, 2027);
    // In GBP: pay 60,000: income tax (60,000 - 12,570) -> 37,700 x 20% + 9,730 x 40% = 11,432;
    // NI 8% x 37,700 + 2% x 9,730 = 3,210.60. Gain: 80,000 AED = 16,000 GBP; (16,000 - 3,000) x 24%
    // = 3,120. Total 17,762.60 GBP = 88,813 AED.
    expect(p.taxes.total).toBeCloseTo((11_432 + 3_210.6 + 3_120) * 5, 4);
    expect(p.taxes.lines.every((l) => l.country === "GB")).toBe(true);
  });
});

describe("US citizen resident in the UK", () => {
  const usCitizen = (salary: number) =>
    uk({
      people: [
        {
          id: "me",
          name: "Me",
          role: "primary",
          birthMonth: "1980-06",
          citizenships: ["GB", "US"],
        },
      ],
      plan: {
        income: [
          {
            id: "pay",
            name: "Pay",
            type: "salary",
            owner: "me",
            amount: { value: salary, basis: "nominal" },
            frequency: "yearly",
            change: { kind: "none" },
            range: always,
          },
        ],
      },
      fx: [{ from: "GBP", to: "USD", rate: 1.25 }],
      end: "2027-04",
    });

  it("UK tax is unchanged; the US taxes worldwide income but the foreign earned income exclusion ($132,900 for 2026) covers the pay (IRS FEIE)", () => {
    const r = simulate(usCitizen(100_000));
    const p = period(r, 2026);
    // UK: 37,700 x 20% + 49,730 x 40% = 27,432; NI 3,016 + 994.60.
    expect(linesOf(p, (l) => l.country === "GB")).toBeCloseTo(27_432 + 3_016 + 994.6, 4);
    expect(linesOf(p, (l) => l.country === "US")).toBeCloseTo(0, 6);
    expect(p.taxes.facts["us.feie.me"]).toBeCloseTo(100_000, 6);
  });

  it("above the exclusion the US tax is fully offset by the credit for UK tax (Publication 514)", () => {
    const r = simulate(usCitizen(200_000));
    const p = period(r, 2026);
    const usGross = linesOf(p, (l) => l.country === "US" && l.basis === "citizenship");
    expect(usGross).toBeGreaterThan(0);
    expect(linesOf(p, (l) => l.country === "US")).toBeCloseTo(0, 6);
    // The UK computation is the same as for a British-only resident.
    const plain = simulate({
      ...usCitizen(200_000),
      household: {
        ...usCitizen(200_000).household,
        people: [{ id: "me", name: "Me", role: "primary", birthMonth: "1980-06" }],
      },
    });
    expect(linesOf(p, (l) => l.country === "GB")).toBeCloseTo(period(plain, 2026).taxes.total, 6);
  });
});

describe("Canada leaver", () => {
  const leaver = (departureTax?: "apply" | "defer") =>
    uk({
      location: { country: "CA", region: "ON" },
      currency: "CAD",
      fiscal: false,
      asOf: "2026-01",
      people: [
        { id: "me", name: "Me", role: "primary", birthMonth: "1975-06", citizenships: ["CA"] },
      ],
      accounts: [
        {
          id: "nr",
          name: "Non-registered",
          type: "ca-non-registered",
          owner: "me",
          balance: 200_000,
          costBasis: 100_000,
        },
      ],
      plan: {
        residency: [
          { id: "to-uk", from: at("2027-01"), location: { country: "GB", region: "ENG" } },
        ],
        ...(departureTax ? { tax: { mode: "estimate", crossBorder: { departureTax } } } : {}),
      },
      fx: [{ from: "GBP", to: "CAD", rate: 1.8 }],
      end: "2028-01",
    });

  it("departure tax: investments deemed sold the day before leaving, taxed in Canada; cost basis stepped up (canada.ca dispositions of property)", () => {
    const r = simulate(leaver());
    const p = period(r, 2026);
    expect(r.trace.find((t) => t.code === "DEPARTURE_TAX")?.data).toMatchObject({
      country: "CA",
      gain: 100_000,
    });
    // The exit charge equals Canada's tax with the 100,000 deemed gain minus without it.
    const exit = p.taxes.byCountry!.find((b) => b.country === "CA" && b.basis === "exit")!.amount;
    expect(exit).toBeCloseTo(expectedCanadianTaxOnGain(100_000), 4);
    expect(p.accounts.find((a) => a.accountId === "nr")!.costBasis).toBeCloseTo(200_000, 6);
    expect(period(r, 2027).taxes.lines.some((l) => l.country === "CA")).toBe(false);
  });

  it("electing to defer leaves no exit charge and the original cost basis", () => {
    const r = simulate(leaver("defer"));
    expect(period(r, 2026).taxes.total).toBe(0);
    expect(period(r, 2026).accounts.find((a) => a.accountId === "nr")!.costBasis).toBeCloseTo(
      100_000,
      6,
    );
  });
});

/** Canadian federal + Ontario tax on a capital gain alone (50% inclusion), from the CA plug-ins. */
function expectedCanadianTaxOnGain(gain: number): number {
  const input: TaxYearInput = {
    year: 2026,
    periodIndex: 0,
    months: 12,
    filingStatus: "single",
    location: { country: "CA", region: "ON" },
    people: [{ id: "me", role: "primary", age: 50.5, alive: true, birthYear: 1975, birthMonth: 6 }],
    dependents: [],
    priceIndex: 1,
    income: [
      { sourceId: "g", owner: "me", character: "capital-gains-long", amount: gain, exemptIn: [] },
    ],
    withdrawals: [],
    deductions: [],
    config: {
      mode: "estimate",
      jurisdictions: [],
      filingStatus: "single",
      flat: { ordinary: 0.2, capitalGains: 0.15, dividends: 0.15, local: 0 },
      lawToggles: {},
      withholding: { taxDeferred: 0, taxable: 0, conversions: 0 },
      settlement: "same-period",
      firstYearPriorTaxDue: 0,
      estate: {
        liquidationCostRate: 0.06,
        adminCostRate: 0.02,
        stepUpBasis: true,
        heirTaxDeferredRate: 0.25,
        heirCapitalGainsRate: 0.15,
        charitableShare: 0,
      },
    },
    history: [],
  };
  const outs: TaxYearOutput[] = [];
  outs.push(caFederalJurisdiction.computeYear(input, outs));
  outs.push(caProvinceJurisdiction.parameterize!("ON").computeYear(input, outs));
  return outs.reduce((s, o) => s + o.lines.reduce((x, l) => x + l.amount, 0), 0);
}

describe("contributions and couples", () => {
  it("UK pension contributions while non-resident: up to £3,600 for five tax years after leaving, then none (gov.uk pension tax relief)", () => {
    const r = simulate(
      uk({
        accounts: [{ id: "sipp", name: "SIPP", type: "uk-sipp", owner: "me", balance: 50_000 }],
        plan: {
          residency: [moveTo("AE", "2026-04")],
          flows: [
            {
              kind: "contribution",
              id: "f-sipp",
              name: "SIPP",
              owner: "me",
              accountId: "sipp",
              range: always,
              method: {
                kind: "amount",
                amount: { value: 10_000, basis: "nominal" },
                frequency: "yearly",
              },
            },
          ],
          income: [
            {
              id: "ae-pay",
              name: "UAE pay",
              type: "salary",
              owner: "me",
              amount: { value: 200_000, basis: "nominal" },
              currency: "AED",
              frequency: "yearly",
              change: { kind: "none" },
              range: always,
            },
          ],
        },
        fx: [AED_GBP],
        end: "2033-04",
      }),
    );
    const c = (y: number) =>
      period(r, y).accounts.find((a) => a.accountId === "sipp")!.contributions;
    expect(c(2026)).toBeCloseTo(3_600, 6);
    expect(c(2030)).toBeCloseTo(3_600, 6);
    expect(c(2031)).toBe(0);
  });

  it("a couple with different residences: each country taxes its own resident on their own income", () => {
    const r = simulate(
      uk({
        people: [
          { id: "me", name: "Me", role: "primary", birthMonth: "1980-06", citizenships: ["GB"] },
          { id: "you", name: "You", role: "partner", birthMonth: "1981-06", citizenships: ["GB"] },
        ],
        plan: {
          residency: [moveTo("AE", "2026-04", "me")],
          income: [
            {
              id: "ae-pay",
              name: "UAE pay",
              type: "salary",
              owner: "me",
              country: "AE",
              amount: { value: 400_000, basis: "nominal" },
              currency: "AED",
              frequency: "yearly",
              change: { kind: "none" },
              range: always,
            },
            {
              id: "uk-pay",
              name: "UK pay",
              type: "salary",
              owner: "you",
              amount: { value: 30_000, basis: "nominal" },
              frequency: "yearly",
              change: { kind: "none" },
              range: always,
            },
          ],
        },
        fx: [AED_GBP],
        end: "2027-04",
      }),
    );
    const p = period(r, 2026);
    // Only the partner's UK pay is taxed: (30,000 - 12,570) x 20% = 3,486; NI 8% x 17,430 = 1,394.40.
    expect(p.taxes.total).toBeCloseTo(3_486 + 1_394.4, 4);
    expect(p.taxes.lines.every((l) => l.personId === "you")).toBe(true);
    expect(p.taxes.residence).toEqual({
      me: [{ country: "AE", months: 12 }],
      you: [{ country: "GB", region: "ENG", months: 12 }],
    });
  });
});

describe("UK -> UAE mover, all together", () => {
  it("UK rental, UK pension drawdown, an ISA, a GIA with dividends and UAE pay: only the UK rent is taxed (UK-UAE treaty Arts 6, 10, 17; gov.uk non-resident guidance)", () => {
    const r = simulate(
      uk({
        accounts: [
          {
            id: "sipp",
            name: "SIPP",
            type: "uk-sipp",
            owner: "me",
            balance: 300_000,
            behaviour: {
              distributions: {
                kind: "custom",
                basis: "nominal",
                points: [{ at: { kind: "planStart" }, value: 20_000 }],
              },
            },
          },
          { id: "isa", name: "ISA", type: "uk-isa", owner: "me", balance: 100_000 },
          {
            id: "gia",
            name: "GIA",
            type: "uk-gia",
            owner: "me",
            balance: 200_000,
            costBasis: 150_000,
            behaviour: { dividends: { yield: { kind: "fixed", rate: 0.03 } } },
          },
        ],
        realAssets: [ukFlat()],
        plan: {
          residency: [moveTo("AE", "2026-04")],
          income: [
            {
              id: "ae-pay",
              name: "UAE pay",
              type: "salary",
              owner: "me",
              amount: { value: 500_000, basis: "nominal" },
              currency: "AED",
              frequency: "yearly",
              change: { kind: "none" },
              range: always,
            },
          ],
        },
        fx: [AED_GBP],
        end: "2027-04",
      }),
    );
    const p = period(r, 2026);
    // Rent (20,000) is the only UK-taxable item: the SIPP drawdown is taxable only in the UAE (Art. 17),
    // dividends only in the UAE (Art. 10), the ISA keeps its shelter and UAE pay is foreign income.
    // A British non-resident keeps the PA: (20,000 - 12,570) x 20% = 1,486.
    expect(p.taxes.total).toBeCloseTo(1_486, 6);
    expect(p.taxes.byCountry).toEqual([
      { country: "GB", basis: "source", amount: expect.closeTo(1_486, 6) },
    ]);
  });
});
