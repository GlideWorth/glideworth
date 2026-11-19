/**
 * Items in another country at a fixed residence: source taxation, treaties, relief, wrappers,
 * citizenship taxation.
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
      name: "Household",
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

describe("UAE resident with UK items", () => {
  it("UK rent of a British non-resident: UK tax at UK rates with the Personal Allowance; UAE taxes nothing (gov.uk/tax-uk-income-live-abroad/rent and /personal-allowance)", () => {
    const r = simulate(
      uk({
        location: { country: "AE" },
        realAssets: [ukFlat()],
        fx: [AED_GBP],
      }),
    );
    const p = period(r, 2026);
    // (20,000 - 12,570) x 20% = 1,486 (2026/27 rates).
    expect(linesOf(p, (l) => l.basis === "source" && l.country === "GB")).toBeCloseTo(1_486, 6);
    expect(linesOf(p, (l) => l.country === "AE")).toBe(0);
    expect(p.taxes.total).toBeCloseTo(1_486, 6);
    // 2027/28: separate property income rates from April 2027 (24%, Budget 2026): 7,430 x 24% = 1,783.20.
    expect(period(r, 2027).taxes.total).toBeCloseTo(1_783.2, 6);
  });

  it("a non-resident who is neither British nor EEA has no Personal Allowance on UK rent (gov.uk/tax-uk-income-live-abroad/personal-allowance)", () => {
    const r = simulate(
      uk({
        people: [
          { id: "me", name: "Me", role: "primary", birthMonth: "1970-06", citizenships: ["IN"] },
        ],
        location: { country: "AE" },
        realAssets: [ukFlat()],
        fx: [AED_GBP],
      }),
    );
    // 20,000 x 20% = 4,000.
    expect(period(r, 2026).taxes.total).toBeCloseTo(4_000, 6);
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
    const r = simulate(uk({ location: { country: "AE" }, accounts: [sipp], fx: [AED_GBP] }));
    const p = period(r, 2026);
    expect(p.accounts.find((a) => a.accountId === "sipp")!.withdrawals).toBeCloseTo(30_000, 6);
    expect(p.taxes.total).toBe(0);
    // The same drawdown by a resident of a country without a treaty in Glideworth's tables (and no preset):
    // UK taxes it as a non-resident (25% UFPLS tax-free; 22,500 - 12,570 = 9,930 x 20% = 1,986) and warns.
    const r2 = simulate(uk({ location: { country: "SG" }, accounts: [sipp] }));
    expect(period(r2, 2026).taxes.total).toBeCloseTo(1_986, 6);
    expect(r2.warnings.some((w) => /No tax treaty between GB and SG/.test(w.message))).toBe(true);
    expect(r2.warnings.some((w) => /no tax preset for SG/.test(w.message))).toBe(true);
  });

  it("ISA held but not funded: it keeps its UK shelter, but no subscriptions while non-resident (gov.uk/individual-savings-accounts/if-you-move-abroad)", () => {
    const r = simulate(
      uk({
        location: { country: "AE" },
        accounts: [{ id: "isa", name: "ISA", type: "uk-isa", owner: "me", balance: 50_000 }],
        plan: {
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
              id: "ae-pay",
              name: "UAE pay",
              type: "salary",
              owner: "me",
              amount: { value: 300_000, basis: "nominal" },
              currency: "AED",
              frequency: "yearly",
              change: { kind: "none" },
              range: always,
            },
          ],
        },
        fx: [AED_GBP],
      }),
    );
    for (const y of [2026, 2027]) {
      expect(period(r, y).accounts.find((a) => a.accountId === "isa")!.contributions).toBe(0);
      // The money went down the waterfall instead (the UAE pay, £60,000 a year, is saved to cash).
      expect(
        period(r, y).accounts.find((a) => a.accountId === "cash")!.contributions,
      ).toBeGreaterThan(10_000);
    }
    expect(r.trace.some((t) => t.code === "NON_RESIDENT_WRAPPER")).toBe(true);
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
        location: { country: "AE" },
        realAssets: [flat],
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

  it("German flat of a UAE resident: the gain is taxed in Germany when no more than 10 years pass between purchase and sale, exempt after (§23(1) Nr. 1, §49(1) Nr. 8 EStG)", () => {
    const sell = (acquiredOn: string) =>
      simulate(
        uk({
          location: { country: "AE" },
          realAssets: [
            ukFlat({
              id: "berlin",
              name: "Berlin flat",
              country: "DE",
              acquiredOn,
              behaviour: {
                usage: "investment",
                appreciation: { kind: "none" },
                sale: { at: at("2026-06"), brokerFeeRate: 0 },
              },
            }),
          ],
          fx: [AED_GBP, { from: "EUR", to: "GBP", rate: 0.85 }],
          asOf: "2025-12",
          fiscal: false,
          end: "2027-12",
        }),
      );
    const de = (r: ProjectionResult) =>
      linesOf(period(r, 2026), (l) => l.country === "DE" && l.basis === "source");
    // The engine dates a sale at the start of its plan year (January 2026 here).
    // Exactly ten years (January 2016 to January 2026) is still "not more than ten years": taxed.
    expect(de(sell("2016-01"))).toBeGreaterThan(0);
    // One month more: exempt.
    expect(de(sell("2015-12"))).toBeCloseTo(0, 6);
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
        location: { country: "AE" },
        accounts: [sipp],
        plan: {
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

describe("UK resident with a UAE savings scheme", () => {
  it("UK pay and the gain inside a UAE savings scheme (not recognised in the UK) are taxed in the UK, converted AED <-> GBP", () => {
    const r = simulate({
      ...uk({
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
                  { at: at("2026-04"), value: 200_000 },
                  { at: at("2027-04"), value: 0 },
                ],
              },
            },
          },
        ],
        plan: {
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
              range: always,
            },
          ],
        },
        fx: [{ from: "GBP", to: "AED", rate: 5 }],
        end: "2027-04",
      }),
    });
    const p = period(r, 2026);
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

describe("contributions", () => {
  it("UK pension contributions while non-resident: blocked (the 5-year £3,600 relief after leaving is not modelled; gov.uk pension tax relief)", () => {
    const r = simulate(
      uk({
        location: { country: "AE" },
        accounts: [{ id: "sipp", name: "SIPP", type: "uk-sipp", owner: "me", balance: 50_000 }],
        plan: {
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
      }),
    );
    for (const y of [2026, 2027])
      expect(period(r, y).accounts.find((a) => a.accountId === "sipp")!.contributions).toBe(0);
    expect(r.trace.some((t) => t.code === "NON_RESIDENT_WRAPPER")).toBe(true);
  });
});

describe("UAE resident with UK items, all together", () => {
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
        location: { country: "AE" },
        realAssets: [ukFlat()],
        plan: {
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
