import { describe, expect, it } from "vitest";
import {
  buildPeriods,
  buildSimulationInput,
  NotImplementedError,
  parseMonth,
  ScenarioError,
  series,
  simulate,
  toBasis,
} from "../src/index.js";
import { createSampleDocument } from "../src/samples/index.js";
import { always, scenario } from "./helpers.js";

describe("periods", () => {
  it("splits calendar years with a partial first period", () => {
    const p = buildPeriods(parseMonth("2026-11"), parseMonth("2029-01"), 0);
    expect(p.map((x) => [x.year, x.months])).toEqual([
      [2026, 2],
      [2027, 12],
      [2028, 12],
    ]);
  });
});

describe("simulate: growth", () => {
  it("compounds a cash account at the cash rate", () => {
    const r = simulate(
      scenario({
        accounts: [{ id: "c", name: "Cash", type: "cash", owner: "me", balance: 10_000 }],
        plan: { assumptions: { cashReturn: { kind: "fixed", rate: 0.02 } } },
      }),
    );
    expect(r.periods).toHaveLength(3);
    expect(r.periods[0]!.totals.netWorth).toBeCloseTo(10_200, 6);
    expect(r.periods[2]!.totals.netWorth).toBeCloseTo(10_000 * 1.02 ** 3, 6);
  });

  it("blends stocks and bonds by the bond allocation and adds reinvested dividends", () => {
    const r = simulate(
      scenario({
        accounts: [{ id: "t", name: "Brokerage", type: "taxable", owner: "me", balance: 100_000 }],
        plan: {
          assumptions: {
            stockReturn: { kind: "fixed", rate: 0.08 },
            bondReturn: { kind: "fixed", rate: 0.02 },
            dividendYield: { kind: "fixed", rate: 0.02 },
            bondAllocation: { kind: "fixed", share: 0.5 },
          },
        },
        years: 1,
      }),
    );
    const acct = r.periods[0]!.accounts[0]!;
    expect(acct.growth).toBeCloseTo(5_000, 6);
    expect(acct.dividends).toBeCloseTo(1_000, 6); // 50% stocks x 2% + 50% bonds x 0% bond yield
    expect(acct.closing).toBeCloseTo(106_000, 6);
  });
});

describe("simulate: cash flow", () => {
  it("taxes income with the flat plug-in and saves the surplus", () => {
    const r = simulate(
      scenario({
        accounts: [{ id: "c", name: "Cash", type: "cash", owner: "me", balance: 0 }],
        plan: {
          tax: { mode: "flat", flat: { ordinary: 0.2, capitalGains: 0, dividends: 0, local: 0 } },
          income: [
            {
              id: "sal",
              type: "salary",
              name: "Salary",
              owner: "me",
              amount: { value: 100_000 },
              frequency: "yearly",
              range: always,
            },
          ],
          expenses: [
            {
              id: "liv",
              type: "living",
              name: "Living",
              owner: "me",
              amount: { value: 50_000 },
              frequency: "yearly",
              range: always,
            },
          ],
        },
        years: 1,
      }),
    );
    const p = r.periods[0]!;
    expect(p.taxes.total).toBeCloseTo(20_000, 6);
    expect(p.totals.cash).toBeCloseTo(30_000, 6);
    expect(p.status).toBe("ok");
    // Ledger conserves money through the pool.
    const into = p.ledger.filter((e) => e.to === "pool").reduce((s, e) => s + e.amount, 0);
    const out = p.ledger.filter((e) => e.from === "pool").reduce((s, e) => s + e.amount, 0);
    expect(into).toBeCloseTo(out, 6);
  });

  it("draws down cash first, then taxable with gains tax grossed up", () => {
    const r = simulate(
      scenario({
        accounts: [
          { id: "c", name: "Cash", type: "cash", owner: "me", balance: 10_000 },
          {
            id: "t",
            name: "Brokerage",
            type: "taxable",
            owner: "me",
            balance: 100_000,
            costBasis: 50_000,
          },
        ],
        plan: {
          tax: {
            mode: "flat",
            flat: { ordinary: 0.3, capitalGains: 0.15, dividends: 0, local: 0 },
          },
          expenses: [
            {
              id: "liv",
              type: "living",
              name: "Living",
              owner: "me",
              amount: { value: 30_000 },
              frequency: "yearly",
              range: always,
            },
          ],
        },
        years: 1,
      }),
    );
    const p = r.periods[0]!;
    const taxable = p.accounts.find((a) => a.accountId === "t")!;
    const cash = p.accounts.find((a) => a.accountId === "c")!;
    expect(cash.withdrawals).toBeCloseTo(10_000, 6);
    // w = 20_000 + 0.15 * 0.5 * w  =>  w = 20_000 / 0.925
    expect(taxable.withdrawals).toBeCloseTo(20_000 / 0.925, 1);
    expect(p.taxes.total).toBeCloseTo((20_000 / 0.925) * 0.075, 1);
    expect(r.trace.some((t) => t.code === "WITHDRAWAL" && t.refs.includes("t"))).toBe(true);
  });

  it("records an unfunded shortfall, cutting discretionary spending first", () => {
    const r = simulate(
      scenario({
        accounts: [{ id: "c", name: "Cash", type: "cash", owner: "me", balance: 5_000 }],
        plan: {
          expenses: [
            {
              id: "ess",
              type: "living",
              name: "Essentials",
              owner: "me",
              amount: { value: 6_000 },
              frequency: "yearly",
              range: always,
            },
            {
              id: "fun",
              type: "travel",
              name: "Travel",
              owner: "me",
              amount: { value: 2_000 },
              frequency: "yearly",
              range: always,
              spendingType: "discretionary",
            },
          ],
        },
        years: 1,
      }),
    );
    const p = r.periods[0]!;
    expect(p.totals.shortfall).toBeCloseTo(3_000, 6);
    expect(p.expenses.find((e) => e.sourceId === "fun")!.funded).toBeCloseTo(0, 6);
    expect(p.expenses.find((e) => e.sourceId === "ess")!.funded).toBeCloseTo(5_000, 6);
    expect(r.summary.success).toBe(false);
    expect(r.warnings.some((w) => w.code === "SHORTFALL")).toBe(true);
  });
});

describe("simulate: milestones", () => {
  it("resolves an age milestone and ends income bound to it", () => {
    const r = simulate(
      scenario({
        accounts: [{ id: "c", name: "Cash", type: "cash", owner: "me", balance: 0 }],
        plan: {
          milestones: [
            {
              id: "ret",
              name: "Retire",
              kind: "retirement",
              criteria: [{ kind: "age", personId: "me", age: 48.5 }],
            },
          ],
          income: [
            {
              id: "sal",
              type: "salary",
              name: "Salary",
              owner: "me",
              amount: { value: 12_000 },
              frequency: "yearly",
              range: {
                start: { kind: "planStart" },
                end: { kind: "milestone", milestoneId: "ret" },
              },
            },
          ],
        },
        years: 3,
      }),
    );
    const ms = r.milestones.find((m) => m.milestoneId === "ret")!;
    expect(ms.month).toBe("2028-07"); // born 1980-01 + 48.5y
    expect(r.periods.map((p) => p.totals.income)).toEqual([12_000, 6_000, 0]);
    expect(r.summary.retirementYear).toBe(2028);
  });

  it("resolves a metric milestone at period end; bound events start next period", () => {
    const r = simulate(
      scenario({
        accounts: [{ id: "c", name: "Cash", type: "cash", owner: "me", balance: 0 }],
        plan: {
          milestones: [
            {
              id: "rich",
              name: "Net worth 20k",
              kind: "custom",
              criteria: [
                {
                  kind: "metric",
                  metric: { kind: "netWorth" },
                  comparator: ">=",
                  threshold: { kind: "amount", amount: { value: 20_000 } },
                },
              ],
            },
          ],
          income: [
            {
              id: "sal",
              type: "salary",
              name: "Salary",
              owner: "me",
              amount: { value: 10_000 },
              frequency: "yearly",
              range: always,
            },
          ],
          expenses: [
            {
              id: "treat",
              type: "travel",
              name: "Treat",
              owner: "me",
              amount: { value: 1_000 },
              frequency: "yearly",
              range: {
                start: { kind: "milestone", milestoneId: "rich" },
                end: { kind: "planEnd" },
              },
            },
          ],
        },
        years: 4,
      }),
    );
    const ms = r.milestones.find((m) => m.milestoneId === "rich")!;
    expect(ms.status).toBe("reached");
    expect(ms.periodIndex).toBe(1);
    expect(r.periods.map((p) => p.totals.expenses)).toEqual([0, 0, 1_000, 1_000]);
  });

  it("rejects circular milestone references", () => {
    expect(() =>
      simulate(
        scenario({
          plan: {
            milestones: [
              {
                id: "a",
                name: "A",
                kind: "custom",
                criteria: [{ kind: "milestone", milestoneId: "b" }],
              },
              {
                id: "b",
                name: "B",
                kind: "custom",
                criteria: [{ kind: "milestone", milestoneId: "a" }],
              },
            ],
          },
        }),
      ),
    ).toThrow(ScenarioError);
  });
});

describe("simulate: real vs nominal", () => {
  it("inflation-matched amounts are constant in real terms", () => {
    const r = simulate(
      scenario({
        accounts: [{ id: "c", name: "Cash", type: "cash", owner: "me", balance: 1_000_000 }],
        plan: {
          expenses: [
            {
              id: "liv",
              type: "living",
              name: "Living",
              owner: "me",
              amount: { value: 12_000 },
              frequency: "yearly",
              range: always,
            },
          ],
        },
        inflation: 0.03,
        years: 3,
      }),
    );
    const nominal = r.periods.map((p) => p.totals.expenses);
    expect(nominal[1]).toBeCloseTo(12_000 * 1.03, 6);
    // Expenses are valued at period start; deflate with the period-start index (end / (1+i)).
    const realAtStart = r.periods.map((p) => p.totals.expenses / (p.priceIndex / 1.03));
    for (const v of realAtStart) expect(v).toBeCloseTo(12_000, 6);
    expect(toBasis(103, { priceIndex: 1.03 }, "real")).toBeCloseTo(100, 9);
    expect(series(r, (p) => p.totals.netWorth, "nominal")).toHaveLength(3);
  });
});

describe("simulate: strictness", () => {
  // A historical series with no data (crypto has no history) cannot be played deterministically.
  const withStrategy = () =>
    scenario({
      plan: {
        assumptions: { cryptoReturn: { kind: "historical", series: "crypto", startYear: 2000 } },
      },
    });

  it("throws a typed NotImplementedError in strict mode", () => {
    try {
      simulate(withStrategy());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(NotImplementedError);
      expect((e as NotImplementedError).feature).toBe("engine.historicalDeterministic");
      expect((e as NotImplementedError).workstream).toBe("c");
    }
  });

  it("warns instead in non-strict mode", () => {
    const input = withStrategy();
    const r = simulate({ ...input, options: { strict: false } });
    expect(r.warnings.some((w) => w.code === "FEATURE_NOT_MODELLED")).toBe(true);
  });

  it("throws ScenarioError on dangling references", () => {
    expect(() =>
      simulate(
        scenario({
          plan: {
            flows: [
              {
                kind: "contribution",
                id: "f",
                name: "F",
                owner: "me",
                accountId: "nope",
                range: always,
                method: { kind: "max" },
              },
            ],
          },
        }),
      ),
    ).toThrow(ScenarioError);
  });
});

describe("simulate: sample document", () => {
  it("runs the synthetic sample end to end", () => {
    const doc = createSampleDocument();
    const r = simulate(buildSimulationInput(doc, "plan-main"));
    expect(r.periods.length).toBeGreaterThan(50);
    expect(r.meta.currency).toBe("USD");
    expect(r.milestones.find((m) => m.milestoneId === "ms-retire")?.month).toBe("2041-03");
    for (const p of r.periods) {
      const into = p.ledger.filter((e) => e.to === "pool").reduce((s, e) => s + e.amount, 0);
      const out = p.ledger.filter((e) => e.from === "pool").reduce((s, e) => s + e.amount, 0);
      expect(into).toBeCloseTo(out, 4);
    }
    // deterministic
    expect(simulate(buildSimulationInput(doc, "plan-main"))).toEqual(r);
  });
});
