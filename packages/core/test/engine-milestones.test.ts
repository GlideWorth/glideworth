import { describe, expect, it } from "vitest";
import { createDefaultTaxRegistry, simulate } from "../src/index.js";
import type { MilestoneInput } from "../src/schema/milestones.js";
import type { TaxJurisdiction, TaxYearInput } from "../src/tax/types.js";
import { account, acct, always, expectInvariants, flatTax, period, sim } from "./engine-helpers.js";

const salary = (value: number, owner = "me", id = "sal", extra: object = {}) => ({
  id,
  type: "salary" as const,
  name: `Salary ${owner}`,
  owner,
  amount: { value },
  frequency: "yearly" as const,
  range: always,
  ...extra,
});
const nw = (value: number) => ({
  kind: "metric" as const,
  metric: { kind: "netWorth" as const },
  comparator: ">=" as const,
  threshold: { kind: "amount" as const, amount: { value } },
});
const month = (r: ReturnType<typeof simulate>, id: string) =>
  r.milestones.find((m) => m.milestoneId === id)?.month;

/** A registry whose flat jurisdiction records every TaxYearInput it sees. */
function capturing() {
  const seen: TaxYearInput[] = [];
  const reg = createDefaultTaxRegistry();
  const flat = reg.get("flat");
  const spy: TaxJurisdiction = {
    ...flat,
    computeYear(input, prior) {
      seen.push(input);
      return flat.computeYear(input, prior);
    },
  };
  reg.register(spy);
  return { reg, seen };
}

describe("milestones", () => {
  it("combines time and metric criteria with OR / AND", () => {
    const run = (combinator: "any" | "all", threshold: number) =>
      simulate(
        sim({
          accounts: [acct("c", "cash", 0)],
          plan: {
            income: [salary(10_000)],
            milestones: [
              {
                id: "m",
                name: "M",
                kind: "custom",
                combinator,
                criteria: [{ kind: "age", personId: "me", age: 50 }, nw(threshold)],
              },
            ],
          },
          years: 5,
        }),
      );
    expect(month(run("any", 25_000), "m")).toBe("2029-12");
    expect(month(run("any", 1e12), "m")).toBe("2030-01");
    expect(month(run("all", 25_000), "m")).toBe("2030-12");
  });

  it("resolves offsets and per-person ages", () => {
    const r = simulate(
      sim({
        births: ["1980-01", "1983-07"],
        accounts: [acct("c", "cash", 0, { owner: "joint" })],
        plan: {
          milestones: [
            {
              id: "ret-b",
              name: "B retires",
              kind: "retirement",
              personId: "b",
              criteria: [{ kind: "age", personId: "b", age: 45 }],
            },
            {
              id: "before",
              name: "Six months before",
              kind: "custom",
              criteria: [{ kind: "milestone", milestoneId: "ret-b", offsetMonths: -6 }],
            },
          ],
        },
        years: 3,
      }),
    );
    expect(month(r, "ret-b")).toBe("2028-07");
    expect(month(r, "before")).toBe("2028-01");
  });

  it("'average' measurement uses mean projected spending over the remaining plan", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 400_000)],
        plan: {
          expenses: [
            {
              id: "a",
              type: "living",
              name: "A",
              owner: "me",
              amount: { value: 40_000 },
              frequency: "yearly",
              range: { start: { kind: "planStart" }, end: { kind: "date", date: "2029-01" } },
            },
            {
              id: "b",
              type: "living",
              name: "B",
              owner: "me",
              amount: { value: 20_000 },
              frequency: "yearly",
              range: { start: { kind: "date", date: "2029-01" }, end: { kind: "planEnd" } },
            },
          ],
          milestones: [
            {
              id: "fi",
              name: "FI",
              kind: "financial-independence",
              criteria: [
                {
                  kind: "metric",
                  metric: { kind: "netWorth" },
                  comparator: ">=",
                  threshold: {
                    kind: "multipleOf",
                    multiple: 10,
                    of: "spending",
                    measurement: "average",
                  },
                },
              ],
            },
          ],
        },
        years: 4,
      }),
    );
    // End 2027: NW 360k; average over 2027-2030 = (40+40+20+20)/4 = 30k -> 300k threshold: reached.
    expect(month(r, "fi")).toBe("2027-12");
  });

  it("'average' expenses include real-asset running costs and loan payments, loans only until repaid (regression)", () => {
    // Living 20k/yr from an expense event + 10k/yr upkeep on a property (no event) + a 12k/yr
    // loan with 18k outstanding. 'expenses' (the metric the chart shows) includes all three, so
    // "10x average expenses over 3 years" must too. Previously the average counted only the 20k
    // living event (threshold 200k), so FI fired in year 1 on a 240k pot.
    const fi = (years?: number) =>
      simulate(
        sim({
          accounts: [acct("c", "cash", 290_000)],
          finances: {
            realAssets: [
              {
                id: "h",
                name: "H",
                type: "house",
                owner: "me",
                currentValue: 0,
                behaviour: {
                  appreciation: { kind: "none" },
                  maintenance: {
                    kind: "amountPerYear",
                    amount: { value: 10_000, basis: "nominal" },
                  },
                },
              },
            ],
            debts: [
              {
                id: "d",
                name: "D",
                type: "personal-loan",
                owner: "me",
                balance: 30_000,
                interest: { apr: 0 },
                monthlyPayment: { value: 1_000, basis: "nominal" },
              },
            ],
          },
          plan: {
            expenses: [
              {
                id: "live",
                type: "living",
                name: "Living",
                owner: "me",
                amount: { value: 20_000 },
                frequency: "yearly",
                range: always,
              },
            ],
            milestones: [
              {
                id: "fi",
                name: "FI",
                kind: "financial-independence",
                criteria: [
                  {
                    kind: "metric",
                    metric: { kind: "liquidNetWorth" },
                    comparator: ">=",
                    threshold: {
                      kind: "multipleOf",
                      multiple: 10,
                      of: "expenses",
                      measurement: "average",
                      ...(years ? { averageYears: years } : {}),
                    },
                  },
                ],
              },
            ],
          },
          years: 6,
        }),
      );
    const r = fi(3);
    // 2027: spend 20+10+12 = 42k; cash 248k, debt 18k -> LNW 230k. Window 2027-29: 42 + (30 + 12)
    // + (30 + 6, the loan repaid half-way) = 120k / 3 = 40k -> 400k: not reached.
    // Later years: average 30k -> 300k; LNW stays ~230k (spending matches the debt fall): never.
    expect(period(r, 2027).totals.expenses).toBeCloseTo(42_000, 6);
    expect(month(r, "fi")).toBeNull();
    // With only the living event counted the threshold would be 200k and FI would fire in 2027.
    expect(period(r, 2027).totals.liquidNetWorth).toBeGreaterThan(200_000);
  });

  it("opens a planned account when a metric milestone is reached", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 0)],
        plan: {
          income: [salary(10_000)],
          milestones: [{ id: "rich", name: "Rich", kind: "custom", criteria: [nw(15_000)] }],
          plannedAccounts: [
            {
              id: "isa",
              name: "ISA",
              type: "uk-isa",
              owner: "me",
              balance: 0,
              opensAt: { kind: "milestone", milestoneId: "rich" },
            },
          ],
          flows: [
            {
              kind: "contribution",
              id: "f",
              name: "ISA",
              owner: "me",
              range: always,
              accountId: "isa",
              method: { kind: "amount", amount: { value: 1_000 } },
            },
          ],
        },
        years: 4,
      }),
    );
    expect(month(r, "rich")).toBe("2028-12");
    expect(account(r, 2028, "isa").contributions).toBe(0);
    expect(account(r, 2029, "isa").contributions).toBeCloseTo(1_000, 6);
  });

  it("applies filing-status and withholding effects from the next period", () => {
    const { reg, seen } = capturing();
    simulate(
      sim({
        accounts: [acct("c", "cash", 0)],
        plan: {
          tax: { ...flatTax(0.1), filingStatus: "single" },
          income: [salary(10_000)],
          milestones: [
            {
              id: "wed",
              name: "Wedding",
              kind: "custom",
              criteria: [{ kind: "date", date: "2027-06" }],
              effects: [
                { kind: "setFilingStatus", filingStatus: "married-joint" },
                { kind: "setWithholding", taxDeferred: 0.2 },
              ],
            },
          ],
        },
        years: 2,
      }),
      { taxRegistry: reg },
    );
    const y27 = seen.findLast((s) => s.year === 2027)!;
    const y28 = seen.findLast((s) => s.year === 2028)!;
    expect(y27.filingStatus).toBe("single");
    expect(y28.filingStatus).toBe("married-joint");
    expect(y28.config.withholding.taxDeferred).toBe(0.2);
  });
});

describe("survivor transitions", () => {
  const coupleDeath = (extra: Partial<MilestoneInput> = {}) => ({
    id: "death-a",
    name: "A dies",
    kind: "custom" as const,
    criteria: [{ kind: "date" as const, date: "2028-06" }],
    effects: [{ kind: "death" as const, personId: "a" }],
    ...extra,
  });

  it("stops income, transfers accounts with a basis step-up and changes filing status", () => {
    const { reg, seen } = capturing();
    const r = simulate(
      sim({
        births: ["1960-01", "1962-01"],
        accounts: [
          acct("ta", "taxable", 100_000, { owner: "a", costBasis: 50_000 }),
          acct("tj", "taxable", 100_000, { owner: "joint", costBasis: 40_000 }),
          acct("c", "cash", 0, { owner: "joint" }),
        ],
        plan: {
          tax: { ...flatTax(0), filingStatus: "married-joint" },
          milestones: [coupleDeath()],
          income: [
            salary(12_000, "a", "sal-a"),
            {
              id: "pen",
              type: "pension",
              name: "Pension",
              owner: "a",
              amount: { value: 12_000 },
              frequency: "yearly",
              range: always,
              survivorShare: 0.5,
            },
          ],
        },
        years: 3,
      }),
      { taxRegistry: reg },
    );
    const inc = (y: number, id: string) =>
      period(r, y)
        .income.filter((l) => l.sourceId.startsWith(id))
        .reduce((s, l) => s + l.amount, 0);
    expect(inc(2028, "sal-a")).toBeCloseTo(6_000, 6);
    expect(inc(2029, "sal-a")).toBe(0);
    expect(inc(2028, "pen")).toBeCloseTo(6_000 + 3_000, 6);
    expect(inc(2029, "pen")).toBeCloseTo(6_000, 6);
    expect(account(r, 2028, "ta").owner).toBe("a");
    expect(account(r, 2029, "ta").owner).toBe("b");
    expect(account(r, 2029, "ta").costBasis).toBeCloseTo(100_000, 6);
    expect(account(r, 2029, "tj").costBasis).toBeCloseTo(70_000, 6);
    expect(seen.findLast((s) => s.year === 2028)!.filingStatus).toBe("married-joint");
    expect(seen.findLast((s) => s.year === 2029)!.filingStatus).toBe("single");
    expect(period(r, 2029).alive).toEqual({ a: false, b: true });
    expect(r.trace.some((t) => t.code === "SURVIVOR_TRANSFER")).toBe(true);
    expectInvariants(r);
  });

  it("uses qualifying-surviving-spouse status for two years with a dependent at home", () => {
    const { reg, seen } = capturing();
    const input = sim({
      births: ["1980-01", "1980-01"],
      accounts: [acct("c", "cash", 0, { owner: "joint" })],
      plan: { tax: { ...flatTax(0), filingStatus: "married-joint" }, milestones: [coupleDeath()] },
      years: 5,
    });
    input.household.dependents = [{ id: "kid", name: "Kid", birthMonth: "2020-01" }];
    simulate(input, { taxRegistry: reg });
    const fs = (y: number) => seen.findLast((s) => s.year === y)!.filingStatus;
    expect([fs(2028), fs(2029), fs(2030), fs(2031)]).toEqual([
      "married-joint",
      "qualifying-surviving-spouse",
      "qualifying-surviving-spouse",
      "single",
    ]);
  });
});

describe("starting conditions, settlement and spending definition", () => {
  it("fixed-date snapshot plans ignore live finances", () => {
    const input = sim({ accounts: [acct("c", "cash", 1)] });
    const r = simulate({
      ...input,
      plan: {
        ...input.plan,
        startingConditions: {
          kind: "snapshot",
          finances: { asOf: "2027-01", accounts: [acct("s", "cash", 42_000)] },
        },
      },
    });
    expect(r.periods[0]!.accounts.map((a) => a.accountId)).toEqual(["s"]);
    expect(r.periods[0]!.totals.netWorth).toBeCloseTo(42_000, 6);
  });

  it("next-period settlement pays withholding now and the balance next year", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 0)],
        plan: {
          tax: { ...flatTax(0.2), settlement: "next-period" },
          income: [
            salary(100_000, "me", "sal", { tax: { withholding: { mode: "fixed", rate: 0.1 } } }),
          ],
        },
        years: 2,
      }),
    );
    const [p1, p2] = r.periods;
    expect(p1!.taxes.total).toBeCloseTo(20_000, 6);
    expect(p1!.taxes.withheld).toBeCloseTo(10_000, 6);
    expect(account(r, 2027, "c").closing).toBeCloseTo(90_000, 6);
    expect(p2!.taxes.settlement).toBeCloseTo(20_000, 6); // last year's balance + this year's true-up
    expect(account(r, 2028, "c").closing).toBeCloseTo(160_000, 6);
    expectInvariants(r);
  });

  it("honours the spending definition for mortgage interest/principal and taxes", () => {
    const input = sim({
      accounts: [acct("c", "cash", 100_000)],
      finances: {
        realAssets: [
          {
            id: "h",
            name: "Home",
            type: "house",
            owner: "me",
            currentValue: 300_000,
            loan: {
              id: "l",
              balance: 120_000,
              interest: { apr: 0.06, method: "simple" },
              monthlyPayment: { value: 1_000, basis: "nominal" },
            },
            behaviour: { appreciation: { kind: "none" } },
          },
        ],
      },
      plan: { tax: flatTax(0.1), income: [salary(10_000)] },
      years: 1,
    });
    const spending = (def?: object) =>
      period(simulate(def ? { ...input, options: { spendingDefinition: def } } : input), 2027)
        .totals.spending;
    let bal = 120_000;
    let interest = 0;
    for (let k = 0; k < 12; k++) {
      interest += bal * 0.005;
      bal = bal * 1.005 - 1_000;
    }
    expect(spending()).toBeCloseTo(interest, 6);
    expect(spending({ includeMortgagePrincipal: true })).toBeCloseTo(12_000, 6);
    expect(spending({ includeMortgage: false })).toBe(0);
    expect(spending({ includeMortgage: false, includeTaxes: true })).toBeCloseTo(1_000, 6);
  });
});
