import { describe, expect, it } from "vitest";
import { buildSimulationInput, parseMonth, simulate } from "../src/index.js";
import {
  createSampleDocument,
  createUkSampleDocument,
  UK_SAMPLE_PLAN_ID,
} from "../src/samples/index.js";
import { acct, always, expectInvariants, sim } from "./engine-helpers.js";

const real = (p: { priceIndex: number }, v: number) => v / p.priceIndex;

describe("golden: UK single accumulate -> retire -> drawdown", () => {
  const doc = createUkSampleDocument();
  const r = simulate(buildSimulationInput(doc, UK_SAMPLE_PLAN_ID));

  it("runs to life expectancy, fully funded, conserving money every year", () => {
    expect(r.meta.currency).toBe("GBP");
    expect(r.periods[0]!.year).toBe(2026);
    expect(r.periods.at(-1)!.year).toBe(2070);
    expect(r.summary.success).toBe(true);
    expectInvariants(r);
  });

  it("retires at 60 and only touches pensions from the access age (57 for this cohort)", () => {
    expect(r.milestones.find((m) => m.milestoneId === "uk-retire")!.month).toBe("2038-06");
    const access = parseMonth("2035-06"); // born 1978-06 -> 55 after April 2028 -> 57
    for (const p of r.periods) {
      const start = parseMonth(p.startMonth);
      for (const a of p.accounts.filter(
        (x) => x.accountId === "uk-sipp" || x.accountId === "uk-workplace",
      ))
        if (start < access) expect(a.withdrawals).toBe(0);
    }
    const drawn = r.periods.filter((p) =>
      p.accounts.some((a) => a.accountId === "uk-sipp" && a.withdrawals > 0),
    );
    expect(drawn.length).toBeGreaterThan(0);
    // UFPLS: a quarter of pension withdrawals came out tax-free.
    expect(drawn.some((p) => (p.totals.taxFreePensionCash ?? 0) > 0)).toBe(true);
  });

  it("pays the State Pension from 68 (born 1978) with the triple lock and stops salary at retirement", () => {
    const sp = r.periods.map(
      (p) => p.income.find((l) => l.sourceId === "uk-state-pension")?.amount ?? 0,
    );
    const first = sp.findIndex((v) => v > 0);
    // Born June 1978: State Pension age 68, so the first payment is in 2046.
    expect(r.periods[first]!.year).toBe(2046);
    // Triple lock: earnings growth (2.5% inflation + 1%) beats the 2.5% floor.
    const full = sp.findIndex((v, i) => i > first && v > 0);
    expect(sp[full + 1]! / sp[full]!).toBeCloseTo(1.035, 9);
    const salaryAfter = r.periods
      .filter((p) => p.year > 2038)
      .flatMap((p) => p.income.filter((l) => l.sourceId === "uk-salary"));
    expect(salaryAfter).toHaveLength(0);
  });

  it("keeps contributions within the workplace pension/ISA allowances while working", () => {
    for (const p of r.periods.filter((x) => x.year < 2038)) {
      const isa = p.accounts.find((a) => a.accountId === "uk-isa")!;
      expect(isa.contributions).toBeLessThanOrEqual(20_000 + 1e-6);
    }
  });

  it("is stable (golden real net worth every 5 years, rounded to 100)", () => {
    const series = r.periods
      .filter((p) => p.year % 5 === 0)
      .map((p) => [p.year, Math.round(real(p, p.totals.netWorth) / 100) * 100]);
    expect(series).toMatchSnapshot();
  });
});

describe("golden: US couple sample (accumulate, retire, survivor)", () => {
  const doc = createSampleDocument();
  const r = simulate(buildSimulationInput(doc, "plan-main"));

  it("conserves money and transfers to the survivor after the first death", () => {
    expectInvariants(r, 1e-6);
    const avery = r.milestones.find((m) => m.milestoneId === "ms-le-avery")!;
    expect(avery.month).toBe("2076-03");
    const after = r.periods.find((p) => p.year === 2077)!;
    expect(after.alive).toEqual({ "p-avery": false, "p-jordan": true });
    expect(after.accounts.find((a) => a.accountId === "acc-avery-401k")!.owner).toBe("p-jordan");
    expect(after.income.some((l) => l.sourceId === "inc-avery-benefit")).toBe(false);
    expect(r.trace.some((t) => t.code === "SURVIVOR_TRANSFER")).toBe(true);
  });

  it("is stable", () => {
    expect({
      success: r.summary.success,
      retirementYear: r.summary.retirementYear,
      endNetWorthReal: Math.round(r.summary.endNetWorthReal / 1000) * 1000,
      lifetimeTaxesReal: Math.round(r.summary.lifetimeTaxesReal / 1000) * 1000,
      fi: r.milestones.find((m) => m.milestoneId === "ms-fi")!.month,
      mortgageFree: r.milestones.find((m) => m.milestoneId === "ms-mortgage-free")!.month,
    }).toMatchSnapshot();
  });
});

describe("invariants (property style)", () => {
  // Deterministic pseudo-random plans: varied balances, returns, incomes and expenses.
  function lcg(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  it("money is conserved and balances stay non-negative across random plans", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = lcg(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
      const input = sim({
        births: ["1965-01", "1968-06"],
        years: 30,
        inflation: rnd() * 0.05,
        accounts: [
          acct("c", "cash", rnd() * 50_000, { owner: "joint" }),
          acct("t", "taxable", rnd() * 300_000, { owner: "a", costBasis: rnd() * 200_000 }),
          acct("k", "401k", rnd() * 400_000, {
            owner: "a",
            behaviour: {
              earlyWithdrawal: { enabled: true, qualifiedAge: 59.5, penaltyRate: 0.1 },
              distributions: { kind: "required", rule: "us-rmd" },
            },
          }),
          acct("r", "roth-ira", rnd() * 100_000, { owner: "b", contributionBasis: rnd() * 50_000 }),
          acct("s", "uk-sipp", rnd() * 200_000, {
            owner: "b",
            behaviour: { ukDrawdownMethod: pick(["ufpls", "pcls"] as const) },
          }),
          acct("x", "crypto", rnd() * 20_000, { owner: "a" }),
        ],
        plan: {
          tax: {
            mode: "flat",
            flat: {
              ordinary: rnd() * 0.35,
              capitalGains: rnd() * 0.25,
              dividends: rnd() * 0.2,
              local: 0,
            },
            settlement: pick(["same-period", "next-period"] as const),
          },
          assumptions: {
            stockReturn: { kind: "fixed", rate: -0.05 + rnd() * 0.15 },
            dividendYield: { kind: "fixed", rate: rnd() * 0.03 },
            cashReturn: { kind: "fixed", rate: rnd() * 0.03 },
            cryptoReturn: { kind: "fixed", rate: -0.2 + rnd() * 0.5 },
            bondAllocation: { kind: "fixed", share: rnd() },
          },
          income: [
            {
              id: "sal",
              type: "salary",
              name: "Salary",
              owner: "a",
              amount: { value: rnd() * 120_000 },
              frequency: "yearly",
              range: {
                start: { kind: "planStart" },
                end: { kind: "age", personId: "a", age: 55 + rnd() * 12 },
              },
            },
            {
              id: "sp",
              type: "state-pension",
              name: "SP",
              owner: "b",
              amount: { value: 11_000 },
              frequency: "yearly",
              range: { start: { kind: "age", personId: "b", age: 67 }, end: { kind: "planEnd" } },
            },
          ],
          expenses: [
            {
              id: "liv",
              type: "living",
              name: "Living",
              owner: "joint",
              amount: { value: 20_000 + rnd() * 60_000 },
              frequency: "yearly",
              range: always,
            },
            {
              id: "fun",
              type: "travel",
              name: "Fun",
              owner: "joint",
              amount: { value: rnd() * 20_000 },
              frequency: "yearly",
              range: always,
              spendingType: "discretionary",
            },
          ],
          flows: [
            {
              kind: "contribution",
              id: "f1",
              name: "401k",
              owner: "a",
              range: always,
              accountId: "k",
              method: { kind: "percentOfIncome", incomeId: "sal", share: 0.1 },
              employer: { incomeId: "sal", matchShare: 0.5, upToShareOfPay: 0.06 },
              limit: { kind: "jurisdiction" },
            },
            {
              kind: "contribution",
              id: "f2",
              name: "Invest",
              owner: "joint",
              range: always,
              accountId: "t",
              method: { kind: "percentOfRemaining", share: rnd() },
            },
          ],
          drawdown: {
            withinCategory: pick(["ordered", "proportional"] as const),
            splitByOwner: rnd() > 0.5,
          },
          flexSpending: { enabled: rnd() > 0.5 },
        },
      });
      const r = simulate(input);
      expectInvariants(r, 1e-6);
      for (const p of r.periods) expect(Number.isFinite(p.totals.netWorth)).toBe(true);
    }
  });

  it("is deterministic and lean mode agrees with full mode on totals", () => {
    const doc = createUkSampleDocument();
    const full = simulate(buildSimulationInput(doc, UK_SAMPLE_PLAN_ID));
    expect(simulate(buildSimulationInput(doc, UK_SAMPLE_PLAN_ID))).toEqual(full);
    const lean = simulate(
      buildSimulationInput(doc, UK_SAMPLE_PLAN_ID, { lean: true, trace: "off" }),
    );
    expect(lean.periods.map((p) => p.totals)).toEqual(full.periods.map((p) => p.totals));
  });
});

describe("performance", () => {
  it("simulates a 60-year plan well under 10 ms", () => {
    const doc = createSampleDocument();
    const base = buildSimulationInput(doc, "plan-main", { lean: true, trace: "off" });
    const fullInput = buildSimulationInput(doc, "plan-main");
    expect(simulate(base).periods.length).toBeGreaterThanOrEqual(50);
    // Best of several batches: robust to other test files competing for the CPU.
    const time = (input: typeof base, n: number) => {
      for (let i = 0; i < 10; i++) simulate(input);
      let best = Number.POSITIVE_INFINITY;
      for (let b = 0; b < 5; b++) {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) simulate(input);
        best = Math.min(best, (performance.now() - t0) / n);
      }
      return best;
    };
    const lean = time(base, 20);
    const full = time(fullInput, 10);
    console.info(
      `[perf] ${simulate(base).periods.length}-period plan: lean ${lean.toFixed(2)} ms, full ${full.toFixed(2)} ms`,
    );
    // Shared CI runners are several times slower than a laptop and vary run to run (11.9 ms was seen for the
    // lean case); the limit there only catches an order-of-magnitude regression.
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env;
    const slack = env?.CI ? 5 : 1;
    expect(lean).toBeLessThan(10 * slack);
    expect(full).toBeLessThan(25 * slack);
  });
});
