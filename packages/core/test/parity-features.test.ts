/**
 * Parity features: multi-currency, per-category inflation, debt payoff strategies, UK State
 * Pension deferral, cash ISA sub-limit, CGT on rebalancing, and the analytics data for the
 * strategy heatmap, income-by-rate heatmap and 72(t) comparison. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import {
  buildSimulationInput,
  compareDebtPayoffStrategies,
  compareSeppMethods,
  incomeByTaxRate,
  incomeByTaxRateForInput,
  MonteCarloSettings,
  runMonteCarlo,
  ScenarioError,
  SimulationInput,
  simulate,
  singleLifeExpectancy,
  strategyMetricsMatrix,
  toBasis,
} from "../src/index.js";
import { createUkSampleDocument, UK_SAMPLE_PLAN_ID } from "../src/samples/index.js";
import { acct, always, expectInvariants, period, sim } from "./engine-helpers.js";
import { fakeMonteCarlo } from "./solvers-helpers.js";

const living = (value: number, extra: Record<string, unknown> = {}) => ({
  id: "liv",
  type: "living" as const,
  name: "Living",
  owner: "me",
  amount: { value, basis: "real" as const },
  frequency: "yearly" as const,
  range: always,
  ...extra,
});

describe("multi-currency", () => {
  const fx = [
    { from: "USD", to: "GBP", rate: 0.8, annualDrift: -0.1 },
    { from: "GBP", to: "EUR", rate: 1 / 0.85 },
  ];
  const r = simulate(
    sim({
      years: 3,
      accounts: [
        acct("usd", "taxable", 10_000, { currency: "USD", costBasis: 10_000 }),
        acct("gbp", "cash", 50_000),
      ],
      finances: {
        fxRates: fx,
        debts: [
          {
            id: "loan",
            name: "US loan",
            type: "personal-loan",
            owner: "me",
            balance: 1_000,
            currency: "USD",
            interest: { apr: 0 },
            monthlyPayment: { value: 0, basis: "nominal" },
          },
        ],
      },
      plan: { expenses: [living(1_000, { currency: "EUR" })] },
      options: { trace: "summary" },
    }),
  );

  it("converts balances, debts and events to the base currency and keeps the original-currency detail", () => {
    expectInvariants(r);
    expect(r.meta.currency).toBe("GBP");
    expect(r.meta.fxRates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currency: "USD", rate: 0.8, annualDrift: -0.1 }),
      ]),
    );
    const y1 = period(r, 2027);
    const usd = y1.accounts.find((a) => a.accountId === "usd")!;
    // 10,000 USD at 0.8 = 8,000 GBP; the dollar falls 10% over the year.
    expect(usd.opening).toBeCloseTo(8_000, 6);
    expect(usd.closing).toBeCloseTo(7_200, 6);
    expect(usd.fxGain).toBeCloseTo(-800, 6);
    expect(usd.currency).toBe("USD");
    expect(usd.closingOriginal).toBeCloseTo(10_000, 6);
    expect(usd.fxRate).toBeCloseTo(0.72, 9);
    // EUR expense through the inverse pair GBP->EUR.
    const e = y1.expenses.find((x) => x.sourceId === "liv")!;
    expect(e.requested).toBeCloseTo(850, 6);
    expect(e.currency).toBe("EUR");
    expect(e.requestedOriginal).toBeCloseTo(1_000, 6);
    const d = y1.debts.find((x) => x.debtId === "loan")!;
    expect(d.opening).toBeCloseTo(800, 6);
    expect(d.closing).toBeCloseTo(720, 6);
    expect(d.closingOriginal).toBeCloseTo(1_000, 6);
  });

  it("a currency without an FX rate is a scenario error", () => {
    expect(() =>
      simulate(
        sim({
          accounts: [acct("chf", "cash", 100, { currency: "CHF" })],
          finances: { fxRates: fx },
        }),
      ),
    ).toThrow(/no exchange rate between CHF and the household currency GBP/);
  });

  it("plan-level FX assumptions replace the household table pair by pair", () => {
    const r2 = simulate(
      sim({
        accounts: [acct("usd", "cash", 10_000, { currency: "USD" })],
        finances: { fxRates: fx },
        plan: { assumptions: { fxRates: [{ from: "USD", to: "GBP", rate: 0.5 }] } },
      }),
    );
    expect(r2.periods[0]!.accounts[0]!.opening).toBeCloseTo(5_000, 6);
  });
});

describe("per-category inflation", () => {
  const categories = [
    {
      id: "health",
      name: "Healthcare",
      kind: "healthcare" as const,
      mode: "premium" as const,
      rate: { kind: "fixed" as const, rate: 0.03 },
    },
    {
      id: "school",
      name: "Education",
      kind: "education" as const,
      mode: "rate" as const,
      rate: { kind: "fixed" as const, rate: 0.06 },
    },
  ];
  const input = sim({
    years: 3,
    inflation: 0.02,
    accounts: [acct("cash", "cash", 1_000_000)],
    plan: {
      assumptions: { inflationCategories: categories },
      expenses: [
        living(1_000, { id: "gen", name: "General" }),
        living(1_000, { id: "med", name: "Care", type: "healthcare", inflationCategory: "health" }),
        living(1_000, { id: "fees", name: "Fees", type: "education", inflationCategory: "school" }),
      ],
    },
  });
  const req = (r: ReturnType<typeof simulate>, year: number, id: string) =>
    period(r, year).expenses.find((e) => e.sourceId === id)!.requested;

  it("grows each event with its category and reports the category indices", () => {
    const r = simulate(input);
    expect(req(r, 2028, "gen")).toBeCloseTo(1_000 * 1.02, 6);
    expect(req(r, 2028, "med")).toBeCloseTo(1_000 * 1.05, 6);
    expect(req(r, 2029, "fees")).toBeCloseTo(1_000 * 1.06 ** 2, 6);
    expect(period(r, 2029).categoryPriceIndexStart).toEqual({
      health: expect.closeTo(1.05 ** 2, 9),
      school: expect.closeTo(1.06 ** 2, 9),
    });
  });

  it("moves coherently with the general inflation a trial draws (premium one-for-one, rate by passThrough)", () => {
    const periods = Array.from({ length: 3 }, () => ({
      stocks: 0,
      bonds: 0,
      cash: 0,
      inflation: 0.1,
      dividendYield: 0,
      bondYield: 0,
      crypto: 0,
    }));
    const r = simulate({ ...input, options: { market: { periods } } });
    expect(req(r, 2028, "gen")).toBeCloseTo(1_100, 6);
    expect(req(r, 2028, "med")).toBeCloseTo(1_000 * 1.13, 6);
    // own 6% + 1.0 x (10% sampled - 2% assumed) = 14%.
    expect(req(r, 2028, "fees")).toBeCloseTo(1_000 * 1.14, 6);
    const mc = runMonteCarlo(
      input,
      MonteCarloSettings.parse({ method: "normal", trials: 20, seed: 3 }),
      {
        metrics: ["expenses"],
        keepTrials: false,
      },
    );
    expect(mc.trials).toBe(20);
  });

  it("rejects an unknown category", () => {
    const bad = sim({ plan: { expenses: [living(10, { inflationCategory: "nope" })] } });
    expect(() => simulate(bad)).toThrow(ScenarioError);
  });
});

describe("debt payoff strategies", () => {
  const debt = (id: string, balance: number, apr: number, payment: number) => ({
    id,
    name: id,
    type: "credit-card" as const,
    owner: "me",
    balance,
    interest: { apr, method: "compound" as const, compounding: "monthly" as const },
    monthlyPayment: { value: payment, basis: "nominal" as const },
  });
  const input = SimulationInput.parse(
    sim({
      years: 6,
      accounts: [acct("cash", "cash", 0)],
      finances: { debts: [debt("card", 6_000, 0.22, 120), debt("car", 2_000, 0.05, 60)] },
      plan: {
        income: [
          {
            id: "sal",
            type: "salary",
            name: "Salary",
            owner: "me",
            amount: { value: 30_000, basis: "nominal" },
            frequency: "yearly",
            range: always,
          },
        ],
        expenses: [living(20_000)],
      },
    }),
  );

  it("avalanche pays the highest rate first, snowball the smallest balance first", () => {
    const flow = (strategy: "avalanche" | "snowball") => ({
      kind: "debtPaydown" as const,
      id: "extra",
      name: "Extra",
      owner: "me",
      range: always,
      targetId: "card",
      method: {
        kind: "amount" as const,
        amount: { value: 1_500, basis: "nominal" as const },
        frequency: "yearly" as const,
      },
      allocation: { strategy },
    });
    const av = simulate({ ...input, plan: { ...input.plan, flows: [flow("avalanche")] } as never });
    const sb = simulate({ ...input, plan: { ...input.plan, flows: [flow("snowball")] } as never });
    expectInvariants(av);
    const extra = (r: typeof av, id: string) =>
      r.periods[0]!.debts.find((d) => d.debtId === id)!.extraPayments ?? 0;
    expect(extra(av, "card")).toBeCloseTo(1_500, 6);
    expect(extra(av, "car")).toBe(0);
    // Snowball clears the smaller car loan (its whole remaining balance), then the card gets the rest.
    const carLeft = sb.periods[0]!.debts.find((d) => d.debtId === "car")!;
    expect(carLeft.closing).toBeCloseTo(0, 6);
    expect(extra(sb, "car")).toBeGreaterThan(1_000);
    expect(extra(sb, "car") + extra(sb, "card")).toBeCloseTo(1_500, 6);
  });

  it("compares strategies: interest saved and payoff dates", async () => {
    const c = await compareDebtPayoffStrategies(input, { extraPerMonth: 150 });
    const by = (id: string) => c.strategies.find((s) => s.id === id)!;
    expect(by("minimum").interestSaved).toBe(0);
    expect(by("avalanche").interestSaved).toBeGreaterThan(0);
    expect(by("snowball").interestSaved).toBeGreaterThan(0);
    expect(by("avalanche").totalInterest).toBeLessThanOrEqual(by("snowball").totalInterest + 1e-6);
    expect(c.best).toBe("avalanche");
    expect(by("avalanche").debtFreeBy).not.toBeNull();
    expect(by("avalanche").debtFreeBy! < (by("minimum").debtFreeBy ?? "9999-12")).toBe(true);
    expect(
      by("snowball").debts.find((d) => d.id === "car")!.paidOffBy! <=
        by("snowball").debts.find((d) => d.id === "card")!.paidOffBy!,
    ).toBe(true);
    expect(c.explanation).toMatch(/avalanche/);
    expect(c.extraPerYear).toBe(1_800);
  });
});

describe("UK: State Pension deferral, cash ISA sub-limit, CGT on rebalancing", () => {
  const sp = (extra: Record<string, unknown> = {}) => ({
    id: "sp",
    type: "state-pension" as const,
    name: "State Pension",
    owner: "me",
    country: "GB",
    amount: { value: 12_000, basis: "nominal" as const },
    frequency: "yearly" as const,
    change: { kind: "none" as const },
    range: {
      start: { kind: "age" as const, personId: "me", age: 67 },
      end: { kind: "planEnd" as const },
    },
    ...extra,
  });

  it("adds 1% per 9 weeks deferred past State Pension age (about 5.8% a year)", () => {
    // Born Jan 1960: State Pension age 66 (Jan 2026); claiming at 67 defers 12 months.
    const base = { births: ["1960-01"], start: "2026-01", years: 3, location: { country: "GB" } };
    const r = simulate(sim({ ...base, plan: { income: [sp()] } }));
    const amount = period(r, 2028).income.find((l) => l.sourceId === "sp")!.amount;
    expect(amount).toBeCloseTo(12_000 * (1 + 52 / 9 / 100), 6);
    const none = simulate(sim({ ...base, plan: { income: [sp({ deferral: { kind: "none" } })] } }));
    expect(period(none, 2028).income.find((l) => l.sourceId === "sp")!.amount).toBeCloseTo(
      12_000,
      6,
    );
    // Claimed at State Pension age: no uplift.
    const atSpa = simulate(
      sim({
        ...base,
        plan: {
          income: [
            sp({
              range: { start: { kind: "age", personId: "me", age: 66 }, end: { kind: "planEnd" } },
            }),
          ],
        },
      }),
    );
    expect(period(atSpa, 2027).income.find((l) => l.sourceId === "sp")!.amount).toBeCloseTo(
      12_000,
      6,
    );
  });

  it("caps cash ISA contributions at the sub-limit from April 2027 for under-65s", () => {
    const run = (cfg?: Record<string, unknown>) =>
      simulate(
        sim({
          births: ["1990-01"],
          start: "2026-01",
          years: 3,
          location: { country: "GB" },
          accounts: [acct("isa", "uk-isa", 0, { ukIsaType: "cash" }), acct("cash", "cash", 0)],
          plan: {
            ...(cfg
              ? {
                  tax: {
                    mode: "flat",
                    flat: { ordinary: 0, capitalGains: 0, dividends: 0, local: 0 },
                    uk: { cashIsaLimit: cfg },
                  },
                }
              : {}),
            income: [
              {
                id: "sal",
                type: "salary",
                name: "Salary",
                owner: "me",
                amount: { value: 60_000, basis: "nominal" },
                frequency: "yearly",
                range: always,
              },
            ],
            flows: [
              {
                kind: "contribution",
                id: "isa",
                name: "Cash ISA",
                owner: "me",
                accountId: "isa",
                range: always,
                method: { kind: "max" },
                limit: { kind: "jurisdiction" },
              },
            ],
          },
        }),
      );
    const c = (r: ReturnType<typeof simulate>, y: number) =>
      period(r, y).accounts.find((a) => a.accountId === "isa")!.contributions;
    const r = run();
    expect(c(r, 2026)).toBeCloseTo(20_000, 6);
    // Calendar 2027: Jan-Mar under the old rules (3/12 of 20k), Apr-Dec capped at 9/12 of 12k.
    expect(c(r, 2027)).toBeCloseTo(Math.min(20_000, 12_000 * (9 / 12) + 0), 6);
    expect(c(r, 2028)).toBeCloseTo(12_000, 6);
    expect(c(run({ enabled: false }), 2028)).toBeCloseTo(20_000, 6);
    expect(c(run({ amount: 15_000 }), 2028)).toBeCloseTo(15_000, 6);
  });

  it("realises capital gains when a glide path rebalances a taxable account (optional)", () => {
    const run = (on: boolean) =>
      simulate(
        sim({
          years: 3,
          accounts: [
            acct("gia", "taxable", 100_000, { costBasis: 40_000 }),
            acct("cash", "cash", 50_000),
          ],
          plan: {
            tax: { mode: "flat", flat: { ordinary: 0, capitalGains: 0.2, dividends: 0, local: 0 } },
            assumptions: {
              rebalancingGains: on,
              bondAllocation: {
                kind: "glidepath",
                interpolation: "step",
                points: [
                  { at: { kind: "date", date: "2027-01" }, value: 0 },
                  { at: { kind: "date", date: "2028-01" }, value: 0.5 },
                ],
              },
            },
          },
        }),
      );
    const off = run(false);
    const onR = run(true);
    expect(period(off, 2028).taxes.total).toBeCloseTo(0, 6);
    // 50% of 100,000 sold; 60% of it is gain: 30,000 at 20%.
    expect(period(onR, 2028).taxes.total).toBeCloseTo(6_000, 6);
    expect(period(onR, 2027).taxes.total).toBeCloseTo(0, 6);
    expect(onR.trace.some((t) => t.code === "REBALANCE_GAIN")).toBe(true);
  });
});

describe("analytics data", () => {
  it("income by tax rate: per-year amounts per band, sorted, in today’s money", () => {
    const doc = createUkSampleDocument();
    const input = buildSimulationInput(doc, UK_SAMPLE_PLAN_ID);
    const m = incomeByTaxRateForInput(input);
    expect(m.jurisdictionId).toBe("uk");
    expect(m.columns.map((c) => c.rate)).toEqual(
      [...m.columns.map((c) => c.rate)].sort((a, b) => a - b),
    );
    expect(m.columns.some((c) => c.rate === 0.2)).toBe(true);
    expect(m.cells).toHaveLength(m.years.length);
    const y = m.years.indexOf(2030);
    const basic = m.cells[y]![m.columns.findIndex((c) => c.rate === 0.2)]!;
    expect(basic).toBeGreaterThan(0);
    expect(() => incomeByTaxRate(simulate({ ...input, options: { trace: "off" } }))).toThrow(
      /trace 'full'/,
    );
    const full = simulate({ ...input, options: { trace: "full" } });
    const p = full.periods[y]!;
    const total = m.cells[y]!.reduce((s, v) => s + v, 0);
    expect(total).toBeGreaterThanOrEqual(toBasis(p.taxes.grossIncome, p, "real", "flow") - 1);
  });

  it("strategies x metrics matrix with heatmap scores", async () => {
    const input = buildSimulationInput(createUkSampleDocument(), UK_SAMPLE_PLAN_ID);
    const mx = await strategyMetricsMatrix(
      input,
      [
        {
          id: "isa-first",
          label: "ISA first",
          description: "Draw the ISA before pensions",
          patch: [
            {
              op: "replace",
              path: "/drawdown/order",
              value: [
                { kind: "category", category: "cash" },
                { kind: "category", category: "tax-free" },
                { kind: "category", category: "taxable" },
                { kind: "category", category: "tax-deferred" },
              ],
            },
          ],
        },
      ],
      {},
      { evaluate: fakeMonteCarlo({ trials: 10 }) },
    );
    expect(mx.columns.map((c) => c.id)).toEqual([
      "lifetimeTaxesReal",
      "netLegacyReal",
      "successRate",
      "endNetWorthReal",
    ]);
    expect(mx.rows.map((r) => r.id)).toEqual(["baseline", "isa-first"]);
    for (const r of mx.rows) {
      expect(r.status).toBe("ok");
      expect(r.values.every((v) => v !== null)).toBe(true);
      for (const s of r.scores) if (s !== null) expect(s).toBeGreaterThanOrEqual(0);
    }
    expect(mx.rows[0]!.deltas.every((d) => d === 0)).toBe(true);
    expect(mx.best[0]).not.toBeNull();
  });

  it("72(t) method comparison table", () => {
    const t = compareSeppMethods({ balance: 500_000, startAge: 50, interestRate: 0.05 });
    const by = (id: string) => t.rows.find((r) => r.method === id)!;
    expect(t.lifeExpectancy).toBeCloseTo(singleLifeExpectancy(50), 9);
    expect(by("rmd").firstYearPayment).toBeCloseTo(500_000 / singleLifeExpectancy(50), 6);
    expect(by("fixed-amortization").firstYearPayment).toBeGreaterThan(by("rmd").firstYearPayment);
    expect(by("fixed-annuitization").firstYearPayment).toBeLessThan(
      by("fixed-amortization").firstYearPayment,
    );
    expect(by("rmd").years).toBe(10);
    expect(
      by("fixed-amortization").payments.every(
        (p) => p === by("fixed-amortization").firstYearPayment,
      ),
    ).toBe(true);
    expect(compareSeppMethods({ balance: 1, startAge: 57 }).rows[0]!.years).toBe(5);
  });
});
