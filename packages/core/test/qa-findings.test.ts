/**
 * Regression tests for the QA findings logged against packages/core during internal QA: each
 * failed before its fix. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import {
  applyPatch,
  applyPlanPatch,
  buildSimulationInput,
  defaultsForCountry,
  deflator,
  diffPlans,
  ExpenseEvent,
  emptyFinances,
  evaluateGuardrails,
  fromBasis,
  GlideworthDocument,
  IncomeEvent,
  MonteCarloSettings,
  monthOf,
  PERIOD_TOTALS_MEASURE,
  periodAge,
  planDefaultsForHousehold,
  runMonteCarlo,
  simulate,
  solveRequiredSavings,
  toBasis,
  totalsMeasure,
} from "../src/index.js";
import {
  createSampleDocument,
  createUkSampleDocument,
  UK_SAMPLE_PLAN_ID,
} from "../src/samples/index.js";
import { always, expectInvariants, sim } from "./engine-helpers.js";
import { expense, fakeMonteCarlo, makeInput } from "./solvers-helpers.js";

const UK_SPENDING = ["uk-living", "uk-travel"];

describe("Q1: today's money for flows uses the start-of-period price index", () => {
  const doc = createUkSampleDocument();
  const input = buildSimulationInput(doc, UK_SAMPLE_PLAN_ID, { trace: "off" });
  const r = simulate(input);
  const spend = (i: number) =>
    r.periods[i]!.expenses.filter((e) => UK_SPENDING.includes(e.sourceId)).reduce(
      (s, e) => s + e.requested,
      0,
    );

  it("£2,300 a month + £4,000 a year entered in today’s money reads £31,600 in every full year", () => {
    // First (partial) period: Nov 2026 - Mar 2027 under the UK tax-year alignment.
    const p0 = r.periods[0]!;
    expect(p0.months).toBe(5);
    expect(toBasis(spend(0), p0, "real", "flow")).toBeCloseTo((31_600 * 5) / 12, 6);
    // Every full year while both run (travel stops at 80, in 2058).
    for (let i = 1; i < r.periods.length; i++) {
      const p = r.periods[i]!;
      if (p.months < 12 || p.year >= 2058) continue;
      expect(toBasis(spend(i), p, "real", "flow"), `${p.year}`).toBeCloseTo(31_600, 6);
    }
    // The old convention (end-of-period index for everything) read 1/(1+inflation) low.
    const p1 = r.periods[1]!;
    expect(toBasis(spend(1), p1, "real", "stock")).toBeCloseTo(31_600 / 1.025, 4);
  });

  it("conversion is consistent: flows by the start index, stocks by the end index, inverse holds", () => {
    for (const p of r.periods) {
      expect(p.priceIndexStart).toBeDefined();
      expect(deflator(p, "flow")).toBeCloseTo(p.priceIndexStart!, 12);
      expect(p.priceIndex / p.priceIndexStart!).toBeCloseTo(
        (1 + p.market.inflation) ** (p.months / 12),
        12,
      );
      expect(fromBasis(toBasis(123.45, p, "real", "flow"), p, "real", "flow")).toBeCloseTo(
        123.45,
        9,
      );
    }
    expect(r.periods[0]!.priceIndexStart).toBe(1);
    // Results cached before `priceIndexStart` existed still convert correctly.
    const { priceIndexStart: _, ...old } = r.periods[3]!;
    expect(deflator(old, "flow")).toBeCloseTo(r.periods[3]!.priceIndexStart!, 12);
    expect(PERIOD_TOTALS_MEASURE.spending).toBe("flow");
    expect(PERIOD_TOTALS_MEASURE.netWorth).toBe("stock");
    expect(totalsMeasure("savingsRate")).toBeNull();
  });

  it("a whole-plan summary of a flow uses the flow deflator", () => {
    const want = r.periods.reduce((s, p) => s + p.totals.taxes / p.priceIndexStart!, 0);
    expect(r.summary.lifetimeTaxesReal).toBeCloseTo(want, 6);
  });

  it("Monte Carlo real percentiles of flows are exact in today’s money whatever inflation a trial draws", () => {
    const mc = runMonteCarlo(
      { ...input, plan: { ...input.plan, expenses: input.plan.expenses } },
      MonteCarloSettings.parse({ method: "normal", trials: 25, seed: 7 }),
      { metrics: ["expenses", "netWorth"], keepTrials: false },
    );
    const band = mc.percentiles.find((s) => s.metric === "expenses")!;
    for (const b of band.bands) expect(b.values[1]).toBeCloseTo(31_600, 4);
  });
});

describe("Q2: guardrails never contradict themselves", () => {
  const plan = (essential: number, fun: number) =>
    makeInput({
      accounts: [{ id: "inv", name: "Stocks", type: "taxable", owner: "me", balance: 1_000_000 }],
      plan: {
        expenses: [
          expense("ess", essential),
          expense("fun", fun, { spendingType: "discretionary", type: "travel" }),
        ],
      },
      years: 30,
    });
  const g = {
    start: { kind: "planStart" as const },
    targetSuccess: 0.8,
    lowerGuardrail: 0.7,
    upperGuardrail: 0.95,
  };

  it("says when discretionary cuts alone cannot reach the target, and never offers a raise equal to the cut", async () => {
    const r = await evaluateGuardrails(plan(70_000, 8_000), g, {
      evaluate: fakeMonteCarlo({ trials: 40 }),
    });
    expect(r.current.action).toBe("cut");
    expect(r.targetReachable).toBe(false);
    expect(r.thresholds!.targetReachable).toBe(false);
    expect(r.current.successRate).toBeLessThan(0.8);
    expect(r.thresholds!.recommendedSpending).toBeCloseTo(70_000, 6);
    expect(r.explanation).toMatch(/cannot get it back to 80%/);
    expect(r.explanation).not.toMatch(/to get back to 80%/);
    // Whole percentages only ("54%", never "54.33%").
    expect(r.explanation).not.toMatch(/\d\.\d+%/);
    const t = r.thresholds!;
    if (t.raiseTo !== null) expect(t.raiseTo).toBeGreaterThan(t.recommendedSpending + 1);
    // Nothing left to cut: no "cut further" threshold.
    expect(t.cutTo).toBeNull();
  });

  it("a reachable cut keeps distinct cut and raise levels", async () => {
    const r = await evaluateGuardrails(plan(20_000, 40_000), g, {
      evaluate: fakeMonteCarlo({ trials: 40 }),
    });
    expect(r.targetReachable).toBe(true);
    const t = r.thresholds!;
    if (t.cutTo !== null) expect(t.cutTo).toBeLessThan(t.recommendedSpending);
    if (t.raiseTo !== null) expect(t.raiseTo).toBeGreaterThan(t.recommendedSpending);
  });
});

describe("Q3: savings rate is saving out of after-tax regular income, never above 100%", () => {
  it("excludes sale proceeds and windfalls, counts employer contributions on both sides", () => {
    const r = simulate(
      sim({
        years: 4,
        accounts: [
          { id: "cash", name: "Cash", type: "cash", owner: "me", balance: 1_000 },
          { id: "brk", name: "Brokerage", type: "taxable", owner: "me", balance: 0 },
        ],
        finances: {
          realAssets: [
            {
              id: "flat",
              name: "Flat",
              type: "house",
              owner: "me",
              currentValue: 300_000,
              behaviour: {
                sale: {
                  at: { kind: "date", date: "2028-06" },
                  brokerFeeRate: 0,
                  proceedsTo: { kind: "accounts", accountIds: ["brk"] },
                },
              },
            },
          ],
        },
        plan: {
          income: [
            {
              id: "sal",
              type: "salary",
              name: "Salary",
              owner: "me",
              amount: { value: 50_000 },
              frequency: "yearly",
              range: always,
            },
            {
              id: "gift",
              type: "inheritance",
              name: "Inheritance",
              owner: "me",
              amount: { value: 200_000 },
              frequency: "once",
              range: { start: { kind: "date", date: "2029-03" }, end: { kind: "never" } },
            },
          ],
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
          leftover: { kind: "save", accountId: "cash" },
        },
      }),
    );
    expectInvariants(r);
    for (const p of r.periods) {
      expect(p.totals.savingsRate).not.toBeNull();
      expect(p.totals.savingsRate!).toBeGreaterThanOrEqual(0);
      expect(p.totals.savingsRate!).toBeLessThanOrEqual(1);
      expect(p.totals.savingsRate!, `${p.year}`).toBeCloseTo(20_000 / 50_000, 9);
    }
    const sale = r.periods.find((p) => p.year === 2028)!;
    expect(sale.totals.oneOffInflows).toBeCloseTo(300_000, 6);
    const inh = r.periods.find((p) => p.year === 2029)!;
    expect(inh.totals.oneOffInflows).toBeCloseTo(200_000, 6);
    expect(inh.totals.afterTaxIncome).toBeCloseTo(50_000, 6);
    expect(inh.totals.savedFromIncome).toBeCloseTo(20_000, 6);
  });
});

describe("Q4: negative income and expense amounts are rejected by validation", () => {
  it("rejects a negative salary and a negative expense", () => {
    const salary = {
      id: "sal",
      type: "salary",
      name: "Salary",
      owner: "me",
      amount: { value: -500 },
      frequency: "monthly",
      range: always,
    };
    expect(IncomeEvent.safeParse(salary).success).toBe(false);
    expect(IncomeEvent.safeParse({ ...salary, amount: { value: 500 } }).success).toBe(true);
    expect(
      ExpenseEvent.safeParse({ ...salary, type: "living", amount: { value: -1 } }).error?.issues[0]
        ?.message,
    ).toBe("amount must not be negative");
  });
});

describe("C1: the patch engine cannot pollute prototypes", () => {
  const plan = createSampleDocument().plans[0]!;
  it.each([
    "/__proto__/polluted",
    "/constructor/prototype/polluted",
    "/income/0/__proto__/polluted",
    "/assumptions/prototype",
  ])("refuses %s", (path) => {
    expect(() => applyPlanPatch(plan, [{ op: "add", path, value: "yes" }])).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("never writes through or reads inherited members and refuses unsafe keys inside values", () => {
    expect(() => applyPatch({ a: {} }, [{ op: "replace", path: "/a/toString", value: 1 }])).toThrow(
      /does not exist/,
    );
    expect(() => applyPatch({ a: {} }, [{ op: "remove", path: "/a/hasOwnProperty" }])).toThrow();
    const value = JSON.parse('{"__proto__": {"polluted": "yes"}}');
    expect(() => applyPatch({ a: {} }, [{ op: "add", path: "/a/b", value }])).toThrow(
      /forbidden key/,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Ordinary patches still work and an IncomeEvent still parses afterwards.
    const p = applyPlanPatch(plan, [{ op: "replace", path: "/name", value: "Renamed" }]);
    expect(p.name).toBe("Renamed");
  });
});

describe("C2/Q5: country defaults drive samples, templates and imports", () => {
  it("the UK sample uses UK tax rules, the UK tax year and the GB default market history", () => {
    const plan = createUkSampleDocument().plans[0]!;
    // GB defaults to US 1928-2025 (the open UK set is too short and too favourable; see defaults).
    expect(plan.monteCarlo.dataset).toBe("us-1928");
    expect(plan.tax.mode).toBe("estimate");
    expect(plan.assumptions.yearAlignment).toEqual({ kind: "fiscal", startMonth: 4 });
    const r = simulate(
      buildSimulationInput(createUkSampleDocument(), UK_SAMPLE_PLAN_ID, { trace: "off" }),
    );
    const lines = new Set(r.periods[1]!.taxes.lines.map((l) => l.jurisdictionId));
    expect(lines.has("uk")).toBe(true);
    expect(lines.has("flat")).toBe(false);
  });

  it("defaultsForCountry covers jurisdiction, region, dataset, account types and state pension", () => {
    const gb = defaultsForCountry("GB", { birthMonth: "1978-06" });
    expect(gb.tax.mode).toBe("estimate");
    expect(gb.tax.jurisdictions).toEqual(["uk"]);
    expect(gb.defaultRegion).toBe("ENG");
    expect(gb.monteCarlo.dataset).toBe("us-1928");
    // The note says why, and states the limits of the UK set the user can switch to.
    expect(gb.monteCarlo.note).toMatch(/UK plans use US history 1928-2025/);
    expect(gb.monteCarlo.note).toMatch(/US shares in sterling/);
    expect(gb.monteCarlo.note).toMatch(/more favourable than long-run UK history/);
    expect(gb.taxYear).toMatchObject({ startMonth: 4, startDay: 6 });
    expect(gb.accountTypes.taxFree).toBe("uk-isa");
    expect(gb.statePension).toMatchObject({
      incomeType: "state-pension",
      startAge: 68,
      deferralUplift: true,
    });
    expect(gb.statePension!.annualAmount).toBeGreaterThan(11_000);
    expect(gb.currency).toBe("GBP");
    const us = defaultsForCountry("US", { region: "CO" });
    expect(us.tax.jurisdictions).toEqual(["us-federal", "us-payroll", "us-state:CO"]);
    expect(us.monteCarlo.dataset).toBe("us-1928");
    expect(defaultsForCountry("US").tax.mode).toBe("flat");
    const unknown = defaultsForCountry("PT");
    expect(unknown.tax.mode).toBe("flat");
    expect(unknown.monteCarlo.note).toMatch(/US history is used/);
    const pd = planDefaultsForHousehold({
      location: { country: "GB" },
      people: [{ role: "primary", birthMonth: "1980-01" }],
    });
    expect(pd.monteCarlo?.dataset).toBe("us-1928");
    expect(pd.tax?.mode).toBe("estimate");
  });

  it("a household created without balances is dated the month it was created", () => {
    expect(monthOf(new Date(Date.UTC(2026, 10, 16)))).toBe("2026-11");
    expect(emptyFinances(new Date(Date.UTC(2031, 0, 2))).asOf).toBe("2031-01");
  });
});

describe("C3: solver errors name the method and the flows that can be solved for", () => {
  it("reports the flow method, not its kind", async () => {
    const doc = GlideworthDocument.parse(createUkSampleDocument());
    const input = buildSimulationInput(doc, UK_SAMPLE_PLAN_ID);
    await expect(solveRequiredSavings(input, { flowId: "uk-fl-isa" })).rejects.toThrow(
      /uses method 'max'.*uk-fl-workplace, uk-fl-sipp/,
    );
  });
});

describe("C4: comparing plans of different households fails clearly", () => {
  it("names the problem instead of an unknown person", () => {
    const a = createSampleDocument().plans[0]!;
    const b = createUkSampleDocument().plans[0]!;
    expect(() => diffPlans(a, b)).toThrow(/different households/);
  });
});

describe("periodAge: the age reached during the year", () => {
  it("labels the year someone turns 60 as 60", () => {
    // Born June 1978; a calendar 2038 period starts at 59.58.
    expect(periodAge({ ages: { s: 59 + 7 / 12 }, months: 12 }, "s")).toBe(60);
    expect(periodAge({ ages: { s: 60 }, months: 12 }, "s")).toBe(60);
    expect(periodAge({ ages: { s: 59 + 1 / 12 }, months: 12 }, "s")).toBe(60);
    expect(periodAge({ ages: { s: 59 }, months: 1 }, "s")).toBe(59);
    expect(periodAge({ ages: {}, months: 12 }, "s")).toBeNull();
  });
});
