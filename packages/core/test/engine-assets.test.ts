import { describe, expect, it } from "vitest";
import {
  simulate,
  singleLifeExpectancy,
  uniformLifetimeDivisor,
  usRmdStartAge,
} from "../src/index.js";
import type { PlannedRealAsset, RealAssetInput } from "../src/schema/assets-debts.js";
import {
  account,
  acct,
  always,
  between,
  expectInvariants,
  flatTax,
  period,
  sim,
} from "./engine-helpers.js";

const spend = (value: number, extra: object = {}) => ({
  id: "e",
  type: "living" as const,
  name: "L",
  owner: "me",
  amount: { value },
  frequency: "yearly" as const,
  range: always,
  ...extra,
});

describe("distributions", () => {
  const rmdIra = (balance: number, extra: object = {}) =>
    acct("ira", "traditional-ira", balance, {
      behaviour: { distributions: { kind: "required", rule: "us-rmd", ...extra } },
    });

  it("takes US RMDs from the SECURE 2.0 start age (Uniform Lifetime Table)", () => {
    expect(usRmdStartAge(1950)).toBe(72);
    expect(usRmdStartAge(1955)).toBe(73);
    expect(usRmdStartAge(1960)).toBe(75);
    expect(uniformLifetimeDivisor(75)).toBe(24.6);
    const r = simulate(
      sim({ births: ["1952-05"], accounts: [acct("c", "cash", 0), rmdIra(265_000)], years: 1 }),
    );
    expect(account(r, 2027, "ira").requiredDistribution).toBeCloseTo(265_000 / 24.6, 6);
    expect(account(r, 2027, "c").closing).toBeCloseTo(265_000 / 24.6, 6);
    const young = simulate(
      sim({
        births: ["1960-05"],
        start: "2034-01",
        accounts: [acct("c", "cash", 0), rmdIra(265_000)],
        years: 1,
      }),
    );
    expect(account(young, 2034, "ira").requiredDistribution).toBe(0);
  });

  it("honours distributions already taken and lets expenses use the RMD cash", () => {
    const r = simulate(
      sim({
        births: ["1952-05"],
        accounts: [acct("c", "cash", 0), rmdIra(265_000, { alreadyTakenThisYear: 5_000 })],
        plan: { expenses: [spend(5_000)], tax: flatTax(0.1) },
        years: 1,
      }),
    );
    const rmd = 265_000 / 24.6 - 5_000;
    expect(account(r, 2027, "ira").withdrawals).toBeCloseTo(rmd, 6);
    expect(account(r, 2027, "c").closing).toBeCloseTo(rmd - 5_000 - rmd * 0.1, 6);
    expectInvariants(r);
  });

  it("counts QCDs toward the RMD and keeps them out of taxable income", () => {
    const r = simulate(
      sim({
        births: ["1952-05"],
        accounts: [acct("c", "cash", 0), rmdIra(265_000)],
        plan: {
          tax: flatTax(0.1),
          expenses: [
            {
              ...spend(4_000),
              id: "gift",
              type: "charity",
              charity: { vehicle: "qcd", qcdFromAccountId: "ira" },
            },
          ],
        },
        years: 1,
      }),
    );
    const rmd = 265_000 / 24.6;
    expect(account(r, 2027, "ira").withdrawals).toBeCloseTo(rmd, 6);
    expect(period(r, 2027).taxes.total).toBeCloseTo((rmd - 4_000) * 0.1, 6);
  });

  it("inherited IRA: annual RMDs then full divestment in year 10", () => {
    const r = simulate(
      sim({
        accounts: [
          acct("c", "cash", 0),
          acct("inh", "inherited-ira", 100_000, {
            inherited: { originalOwnerBirthMonth: "1940-01", originalOwnerDeathMonth: "2025-06" },
            behaviour: { distributions: { kind: "required", rule: "us-inherited-10-year" } },
          }),
        ],
        years: 10,
      }),
    );
    const divisor = singleLifeExpectancy(46) - 1;
    expect(account(r, 2027, "inh").requiredDistribution).toBeCloseTo(100_000 / divisor, 6);
    expect(account(r, 2035, "inh").closing).toBeCloseTo(0, 6);
    expect(account(r, 2034, "inh").closing).toBeGreaterThan(0);
  });

  it("RRIF and Australian minimums", () => {
    const run = (
      type: "ca-rrif" | "au-super-pension",
      rule: "ca-rrif-minimum" | "au-minimum-drawdown",
      birth: string,
    ) =>
      account(
        simulate(
          sim({
            births: [birth],
            accounts: [
              acct("c", "cash", 0),
              acct("x", type, 100_000, {
                behaviour: { distributions: { kind: "required", rule } },
              }),
            ],
            years: 1,
          }),
        ),
        2027,
        "x",
      ).requiredDistribution;
    expect(run("ca-rrif", "ca-rrif-minimum", "1955-01")).toBeCloseTo(5_400, 6);
    expect(run("ca-rrif", "ca-rrif-minimum", "1962-01")).toBeCloseTo(100_000 / 25, 6);
    expect(run("au-super-pension", "au-minimum-drawdown", "1961-01")).toBeCloseTo(5_000, 6);
  });

  it("custom distribution schedules", () => {
    const r = simulate(
      sim({
        accounts: [
          acct("c", "cash", 0),
          acct("x", "traditional-ira", 100_000, {
            behaviour: {
              distributions: {
                kind: "custom",
                basis: "real",
                points: [{ at: { kind: "date", date: "2028-01" }, value: 5_000 }],
              },
            },
          }),
        ],
        years: 2,
      }),
    );
    expect(account(r, 2027, "x").requiredDistribution).toBeCloseTo(5_000, 6); // before the first point: first value
    expect(account(r, 2028, "x").requiredDistribution).toBeCloseTo(5_000, 6);
  });

  it("72(t) fixed amortisation is penalty-free", () => {
    const r = simulate(
      sim({
        births: ["1977-01"],
        accounts: [
          acct("c", "cash", 0),
          acct("x", "traditional-ira", 500_000, {
            behaviour: {
              earlyWithdrawal: { enabled: true, qualifiedAge: 59.5, penaltyRate: 0.1 },
              sepp: {
                method: "fixed-amortization",
                start: { kind: "planStart" },
                interestRate: 0.05,
              },
            },
          }),
        ],
        plan: { tax: flatTax(0.2) },
        years: 2,
      }),
    );
    const n = singleLifeExpectancy(50);
    const pmt = (500_000 * 0.05) / (1 - 1.05 ** -n);
    expect(account(r, 2027, "x").requiredDistribution).toBeCloseTo(pmt, 4);
    expect(account(r, 2028, "x").requiredDistribution).toBeCloseTo(pmt, 4);
    expect(period(r, 2027).taxes.total).toBeCloseTo(pmt * 0.2, 4);
    expect(r.warnings.some((w) => w.code === "EARLY_WITHDRAWAL_PENALTY")).toBe(false);
  });
});

const house = (over: Partial<RealAssetInput> = {}): RealAssetInput => ({
  id: "h",
  name: "House",
  type: "house",
  owner: "me",
  currentValue: 500_000,
  purchasePrice: 300_000,
  ...over,
});

describe("real assets", () => {
  it("buys a financed asset in the future with a down payment from cash", () => {
    const planned: Omit<PlannedRealAsset, "behaviour" | "archived"> & { behaviour?: object } = {
      id: "new",
      name: "New home",
      type: "house",
      owner: "me",
      purchase: {
        at: { kind: "date", date: "2028-01", offsetMonths: 0 },
        price: { value: 300_000, basis: "real" },
        downPayment: { value: 60_000, basis: "real" },
        financing: {
          id: "mort",
          interest: { apr: 0.06, method: "compound", compounding: "monthly" },
          monthlyPayment: { value: 1_500, basis: "nominal" },
        },
        fundFromAccountIds: ["c"],
      },
    };
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 100_000)],
        plan: { plannedRealAssets: [planned as never] },
        years: 2,
      }),
    );
    const ra = period(r, 2028).realAssets.find((x) => x.assetId === "new")!;
    let bal = 240_000;
    for (let k = 0; k < 12; k++) bal = bal * 1.005 - 1_500;
    expect(period(r, 2027).realAssets[0]!.owned).toBe(false);
    expect(ra.owned).toBe(true);
    expect(ra.purchasePrice).toBeCloseTo(300_000, 6);
    expect(ra.loanBalance).toBeCloseTo(bal, 4);
    expect(account(r, 2028, "c").closing).toBeCloseTo(100_000 - 60_000 - 18_000, 4);
    expect(period(r, 2028).totals.netWorth).toBeCloseTo(
      100_000 - 60_000 - 18_000 + 300_000 - bal,
      4,
    );
    expectInvariants(r);
  });

  it("repeats purchases (car every 3 years) with scaling, selling each one", () => {
    const car = (keepLast: boolean) => ({
      id: "car",
      name: "Car",
      type: "car",
      owner: "me",
      purchase: { at: { kind: "date", date: "2027-01" }, price: { value: 30_000 } },
      behaviour: {
        appreciation: { kind: "rate", rate: -0.1 },
        sale: { at: { kind: "date", date: "2030-01" }, brokerFeeRate: 0 },
        recurrence: {
          yearsBetween: 0,
          scalingRate: 0.1,
          until: { kind: "date", date: "2036-01" },
          keepLast,
        },
      },
    });
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 200_000)],
        plan: { plannedRealAssets: [car(false) as never] },
        years: 10,
      }),
    );
    const rows = r.periods.map((p) => p.realAssets[0]!);
    expect(rows.map((x) => Math.round(x.purchasePrice ?? 0))).toEqual([
      30_000, 0, 0, 33_000, 0, 0, 36_300, 0, 0, 0,
    ]);
    expect(rows[3]!.saleProceeds).toBeCloseTo(30_000 * 0.9 ** 3, 6);
    expect(rows[9]!.owned).toBe(false);
    expect(rows[9]!.saleProceeds).toBeCloseTo(36_300 * 0.9 ** 3, 6);
    const kept = simulate(
      sim({
        accounts: [acct("c", "cash", 200_000)],
        plan: { plannedRealAssets: [car(true) as never] },
        years: 10,
      }),
    );
    expect(kept.periods[9]!.realAssets[0]!.owned).toBe(true);
    expectInvariants(r);
  });

  it("sells at a date with broker fee, gain reduction and loan payoff", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 0)],
        finances: {
          realAssets: [
            house({
              loan: {
                id: "l",
                balance: 100_000,
                interest: { apr: 0 },
                monthlyPayment: { value: 0, basis: "nominal" },
              },
              behaviour: {
                appreciation: { kind: "none" },
                sale: {
                  at: { kind: "date", date: "2028-01" },
                  brokerFeeRate: 0.05,
                  gainReduction: 0.5,
                },
              },
            }),
          ],
        },
        plan: { tax: flatTax(0, 0.2) },
        years: 2,
      }),
    );
    const p = period(r, 2028);
    expect(p.realAssets[0]!.saleProceeds).toBeCloseTo(375_000, 6);
    expect(p.taxes.total).toBeCloseTo(0.2 * 0.5 * 175_000, 6);
    expect(account(r, 2028, "c").closing).toBeCloseTo(375_000 - 17_500, 6);
    expect(p.totals.netWorth).toBeCloseTo(375_000 - 17_500, 6);
    expect(p.totals.income).toBe(0);
    expectInvariants(r);
  });

  it("rental income with vacancy, management, costs and estimated deductions", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 0)],
        finances: {
          realAssets: [
            house({
              currentValue: 200_000,
              type: "rental-property",
              behaviour: {
                usage: "investment",
                appreciation: { kind: "none" },
                maintenance: { kind: "percentOfValue", rate: 0.01 },
                rental: {
                  enabled: true,
                  income: { kind: "percentOfValue", rate: 0.06 },
                  occupancy: 0.9,
                  management: { kind: "percentOfValue", rate: 0.1 },
                  taxSettings: { estimateDeductions: true, buildingValue: 110_000 },
                },
              },
            }),
          ],
        },
        plan: { tax: flatTax(0.2) },
        years: 1,
      }),
    );
    const p = period(r, 2027);
    expect(p.realAssets[0]!.rentalIncome).toBeCloseTo(10_800, 6);
    expect(p.totals.passiveIncome).toBeCloseTo(10_800, 6);
    expect(p.taxes.total).toBeCloseTo((10_800 - (2_000 + 1_080 + 4_000)) * 0.2, 6);
    expect(p.totals.spending).toBe(0);
    expect(account(r, 2027, "c").closing).toBeCloseTo(10_800 - 2_000 - 1_080 - 744, 6);
  });

  it("caps reassessed property tax (Prop 13 auto in California; ratcheting)", () => {
    const run = (reassessment: object, location?: { country: string; region?: string }) =>
      simulate(
        sim({
          accounts: [acct("c", "cash", 1_000_000)],
          ...(location ? { location } : {}),
          finances: {
            realAssets: [
              house({
                behaviour: {
                  appreciation: {
                    kind: "schedule",
                    valueKind: "rate",
                    interpolation: "step",
                    points: [
                      { at: { kind: "date", date: "2027-01" }, value: -0.2 },
                      { at: { kind: "date", date: "2028-01" }, value: 0.5 },
                    ],
                  },
                  propertyTax: {
                    cost: { kind: "percentOfValue", rate: 0.01 },
                    reassessment: reassessment as never,
                  },
                },
              }),
            ],
          },
          years: 3,
        }),
      ).periods.map((p) => p.realAssets[0]!.ownershipCosts);
    const capped = run({ kind: "capped", maxGrowth: 0.02 });
    expect(capped[0]).toBeCloseTo(5_000, 6);
    expect(capped[1]).toBeCloseTo(4_000, 6);
    expect(capped[2]).toBeCloseTo(5_202, 6);
    const ratchet = run({ kind: "ratcheting", maxGrowth: 0.02 });
    expect(ratchet[2]).toBeCloseTo(4_080, 6);
    expect(run({ kind: "auto" }, { country: "US", region: "CA" })[2]).toBeCloseTo(5_202, 6);
    expect(run({ kind: "auto" })[2]).toBeCloseTo(6_000, 6);
  });

  it("liquidates an asset in drawdown order when cash runs out", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 0)],
        finances: {
          realAssets: [
            house({
              id: "land",
              type: "land",
              currentValue: 100_000,
              purchasePrice: 100_000,
              behaviour: { appreciation: { kind: "none" }, liquidateIfNeeded: true },
            }),
          ],
        },
        plan: { expenses: [spend(50_000)] },
        years: 2,
      }),
    );
    expect(period(r, 2027).realAssets[0]!.owned).toBe(false);
    expect(account(r, 2027, "c").closing).toBeCloseTo(94_000 - 50_000, 6);
    expect(period(r, 2027).status).toBe("ok");
    expect(r.trace.some((t) => t.code === "ASSET_LIQUIDATED")).toBe(true);
    expectInvariants(r);
  });

  it("ends payments at the loan term with a balloon", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 200_000)],
        finances: {
          realAssets: [
            house({
              loan: {
                id: "l",
                balance: 100_000,
                interest: { apr: 0 },
                monthlyPayment: { value: 1_000, basis: "nominal" },
                termEnd: { kind: "date", date: "2027-07" },
              },
              behaviour: { appreciation: { kind: "none" } },
            }),
          ],
        },
        years: 1,
      }),
    );
    const ra = period(r, 2027).realAssets[0]!;
    expect(ra.loanPayments).toBeCloseTo(100_000, 6);
    expect(ra.loanBalance).toBe(0);
    expect(r.trace.some((t) => t.code === "LOAN_BALLOON")).toBe(true);
  });
});

describe("debts", () => {
  const loan = (extra: object = {}) => ({
    id: "d",
    name: "Student loan",
    type: "student-loan" as const,
    owner: "me",
    balance: 50_000,
    interest: { apr: 0 },
    monthlyPayment: { value: 0, basis: "nominal" as const },
    ...extra,
  });

  it("forgives a debt at a date and taxes it when taxable", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 100_000)],
        finances: {
          debts: [
            loan({
              behaviour: { forgiveness: { at: { kind: "date", date: "2028-01" }, taxable: true } },
            }),
          ],
        },
        plan: { tax: flatTax(0.2) },
        years: 2,
      }),
    );
    expect(period(r, 2027).debts[0]!.closing).toBeCloseTo(50_000, 6);
    expect(period(r, 2028).debts[0]!.forgiven).toBeCloseTo(50_000, 6);
    expect(period(r, 2028).taxes.total).toBeCloseTo(10_000, 6);
  });

  it("pays scheduled payments from specific accounts and deducts interest", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 50_000), acct("isa", "uk-isa", 50_000)],
        finances: {
          debts: [
            loan({
              interest: { apr: 0.12, method: "simple" },
              monthlyPayment: { value: 1_000, basis: "nominal" },
              behaviour: {
                payFrom: { kind: "accounts", accountIds: ["isa"] },
                interestTaxDeductible: true,
              },
            }),
          ],
        },
        years: 1,
      }),
    );
    const d = period(r, 2027).debts[0]!;
    expect(d.payments).toBeCloseTo(12_000, 6);
    expect(account(r, 2027, "isa").withdrawals).toBeCloseTo(12_000, 6);
    expect(account(r, 2027, "c").withdrawals).toBe(0);
    expectInvariants(r);
  });
});

describe("between helper sanity", () => {
  it("builds ranges", () => {
    expect(between("2027-01", "2028-01").end.date).toBe("2028-01");
  });
});

describe("more distribution and asset cases", () => {
  it("inherited stretch uses the single life table, reducing the divisor each year", () => {
    const r = simulate(
      sim({
        accounts: [
          acct("c", "cash", 0),
          acct("inh", "inherited-ira", 100_000, {
            inherited: {
              originalOwnerBirthMonth: "1950-01",
              originalOwnerDeathMonth: "2026-03",
              beneficiaryClass: "eligible-designated",
            },
            behaviour: { distributions: { kind: "required", rule: "us-inherited-stretch" } },
          }),
        ],
        years: 2,
      }),
    );
    const d0 = singleLifeExpectancy(47);
    expect(account(r, 2027, "inh").requiredDistribution).toBeCloseTo(100_000 / d0, 6);
    expect(account(r, 2028, "inh").requiredDistribution).toBeCloseTo(
      (100_000 - 100_000 / d0) / (d0 - 1),
      6,
    );
  });

  it("house hacking: the personal share of costs is spending, the rented share is not", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 100_000)],
        finances: {
          realAssets: [
            house({
              currentValue: 400_000,
              behaviour: {
                appreciation: { kind: "none" },
                maintenance: { kind: "percentOfValue", rate: 0.01 },
                rental: {
                  enabled: true,
                  income: { kind: "amountPerMonth", amount: { value: 1_000 } },
                  rentedShare: 0.25,
                  taxSettings: { estimateDeductions: false },
                },
              },
            }),
          ],
        },
        years: 1,
      }),
    );
    const p = period(r, 2027);
    expect(p.realAssets[0]!.rentalIncome).toBeCloseTo(12_000, 6);
    expect(p.totals.spending).toBeCloseTo(4_000 * 0.75, 6);
    expect(p.totals.expenses).toBeCloseTo(4_000, 6);
  });
});
