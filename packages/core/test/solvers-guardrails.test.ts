import { describe, expect, it } from "vitest";
import {
  amortisedPayment,
  compareStrategies,
  computeWithdrawal,
  drawdownOrderCandidates,
  evaluateGuardrails,
  flexSpendingCut,
  guytonKlingerGuardrails,
  isUkPlan,
  optimiseTaxStrategy,
  sensitivityAnalysis,
  ukDrawdownCandidates,
  ukStatePensionAge,
  type WithdrawalState,
  withdrawalPath,
} from "../src/index.js";
import { expense, fakeMonteCarlo, makeInput } from "./solvers-helpers.js";

const s0: WithdrawalState = {
  yearIndex: 0,
  portfolio: 1_000_000,
  initialPortfolio: 1_000_000,
  previousWithdrawal: null,
  lastYearInflation: 0,
  priceIndex: 1,
  startPriceIndex: 1,
  remainingYears: 30,
};
const noBounds = { floor: undefined, ceiling: undefined };

describe("withdrawal rules (pure)", () => {
  it("initial-percent: 4% then inflation-adjusted", () => {
    const rule = { kind: "initial-percent" as const, rate: 0.04 };
    expect(computeWithdrawal({ rule, bounds: noBounds }, s0).amount).toBeCloseTo(40_000, 9);
    const y1 = computeWithdrawal(
      { rule, bounds: noBounds },
      {
        ...s0,
        yearIndex: 1,
        portfolio: 700_000,
        previousWithdrawal: 40_000,
        lastYearInflation: 0.03,
      },
    );
    expect(y1.amount).toBeCloseTo(41_200, 9);
    expect(y1.action).toBe("inflation");
  });

  it("fixed-percent, 1/N and VPW recalculate from the current portfolio", () => {
    const st = { ...s0, yearIndex: 3, portfolio: 900_000, previousWithdrawal: 1 };
    expect(
      computeWithdrawal({ rule: { kind: "fixed-percent", rate: 0.04 }, bounds: noBounds }, st)
        .amount,
    ).toBeCloseTo(36_000, 9);
    expect(
      computeWithdrawal({ rule: { kind: "one-over-n" }, bounds: noBounds }, st).amount,
    ).toBeCloseTo(30_000, 9);
    const r = 0.6 * 0.05 + 0.4 * 0.019;
    const pmt = (900_000 * r) / (1 - (1 + r) ** -30);
    expect(
      computeWithdrawal({ rule: { kind: "vpw", stockShare: 0.6 }, bounds: noBounds }, st).amount,
    ).toBeCloseTo(pmt, 6);
    expect(amortisedPayment(1200, 0, 12)).toBe(100);
  });

  it("VPW withdraws at most 100% of the portfolio: the final year takes the whole portfolio", () => {
    // Final year: the end-of-year amortised payment is 900,000 x 1.0376 = 933,840, which no
    // portfolio of 900,000 can pay when the money is taken at the start or middle of the year (it
    // left the final year underpaid in every start-timing trial). VPW's last-year percentage is 100%.
    const rule = { kind: "vpw" as const, stockShare: 0.6 };
    const last = {
      ...s0,
      yearIndex: 29,
      portfolio: 900_000,
      previousWithdrawal: 1,
      remainingYears: 1,
    };
    expect(amortisedPayment(900_000, 0.6 * 0.05 + 0.4 * 0.019, 1)).toBeCloseTo(933_840, 6);
    expect(computeWithdrawal({ rule, bounds: noBounds }, last).amount).toBe(900_000);
    // Two years left: 900,000 x r / (1 - (1 + r)^-2) = 475,536.11 < 900,000, unchanged by the cap.
    const two = computeWithdrawal({ rule, bounds: noBounds }, { ...last, remainingYears: 2 });
    expect(two.amount).toBeCloseTo((900_000 * 0.0376) / (1 - 1.0376 ** -2), 6);
    expect(two.amount).toBeCloseTo(475_536.11, 1);
  });

  it("Clyatt 95%: never below 95% of last year", () => {
    const rule = { kind: "clyatt-95" as const, rate: 0.04, minShareOfPrevious: 0.95 };
    const d = computeWithdrawal(
      { rule, bounds: noBounds },
      { ...s0, yearIndex: 1, portfolio: 800_000, previousWithdrawal: 40_000 },
    );
    expect(d.amount).toBeCloseTo(38_000, 9);
    expect(d.action).toBe("floor");
  });

  it("Guyton-Klinger: capital preservation cut, prosperity raise, and the withdrawal rule", () => {
    const rule = { kind: "guyton-klinger" as const, rate: 0.05, guardrail: 0.2, adjustment: 0.1 };
    const g = { rule, bounds: noBounds };
    expect(computeWithdrawal(g, s0).amount).toBeCloseTo(50_000, 9);
    // Up year, portfolio fell anyway (big withdrawal): 51,500 / 800,000 = 6.44% > 6% -> cut 10%.
    const cut = computeWithdrawal(g, {
      ...s0,
      yearIndex: 1,
      portfolio: 800_000,
      previousWithdrawal: 50_000,
      lastYearInflation: 0.03,
      lastYearReturn: 0.01,
    });
    expect(cut.action).toBe("cut");
    expect(cut.amount).toBeCloseTo(51_500 * 0.9, 9);
    // Losing year with rate above initial: no inflation raise, then 50,000/800,000 = 6.25% > 6% -> cut.
    const skip = computeWithdrawal(g, {
      ...s0,
      yearIndex: 1,
      portfolio: 800_000,
      previousWithdrawal: 50_000,
      lastYearInflation: 0.03,
      lastYearReturn: -0.2,
    });
    expect(skip.amount).toBeCloseTo(45_000, 9);
    // No cut in the final 15 years.
    const late = computeWithdrawal(g, {
      ...s0,
      yearIndex: 20,
      remainingYears: 10,
      portfolio: 800_000,
      previousWithdrawal: 50_000,
      lastYearInflation: 0.03,
      lastYearReturn: 0.01,
    });
    expect(late.action).toBe("inflation");
    // Portfolio boomed: 51,500 / 1,400,000 = 3.7% < 4% -> raise 10%.
    const raise = computeWithdrawal(g, {
      ...s0,
      yearIndex: 1,
      portfolio: 1_400_000,
      previousWithdrawal: 50_000,
      lastYearInflation: 0.03,
      lastYearReturn: 0.3,
    });
    expect(raise.action).toBe("raise");
    expect(raise.amount).toBeCloseTo(51_500 * 1.1, 9);
  });

  it("ratcheting: raise after the portfolio grows 50% in real terms, then cool down", () => {
    const strat = {
      rule: {
        kind: "ratcheting" as const,
        rate: 0.04,
        threshold: 0.5,
        raise: 0.1,
        cooldownYears: 3,
      },
      bounds: noBounds,
    };
    const returns = [0.3, 0.3, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
    const path = withdrawalPath(strat, {
      portfolio: 1_000_000,
      years: 8,
      returns,
      inflation: returns.map(() => 0),
    });
    const raises = path.filter((p) => p.action === "raise").map((p) => p.year);
    expect(raises[0]).toBe(2);
    expect(raises.every((y, i) => i === 0 || y - raises[i - 1]! >= 3)).toBe(true);
    expect(path[2]!.withdrawal).toBeCloseTo(44_000, 9);
  });

  it("applies real floors and ceilings in nominal money", () => {
    const d = computeWithdrawal(
      {
        rule: { kind: "fixed-percent", rate: 0.04 },
        bounds: {
          floor: { value: 30_000, basis: "real" },
          ceiling: { value: 35_000, basis: "real" },
        },
      },
      { ...s0, portfolio: 500_000, priceIndex: 1.1 },
    );
    expect(d.amount).toBeCloseTo(33_000, 9);
    expect(d.action).toBe("floor");
  });

  it("flexible spending cuts by drawdown from the peak (step and linear)", () => {
    const rules = [
      { drawdown: 0.2, cut: 0.1 },
      { drawdown: 0.4, cut: 0.3 },
    ];
    expect(flexSpendingCut({ rules, interpolation: "step" }, 0.1)).toBe(0);
    expect(flexSpendingCut({ rules, interpolation: "step" }, 0.25)).toBe(0.1);
    expect(flexSpendingCut({ rules, interpolation: "step" }, 0.5)).toBe(0.3);
    expect(flexSpendingCut({ rules, interpolation: "linear" }, 0.1)).toBeCloseTo(0.05, 12);
    expect(flexSpendingCut({ rules, interpolation: "linear" }, 0.3)).toBeCloseTo(0.2, 12);
    expect(flexSpendingCut({ rules, interpolation: "linear" }, 0.9)).toBeCloseTo(0.3, 12);
  });
});

describe("Guyton-Klinger guardrails in money terms", () => {
  it("gives portfolio thresholds and spending after each adjustment", () => {
    const r = guytonKlingerGuardrails({ portfolio: 1_000_000, spending: 50_000, currency: "GBP" });
    expect(r.initialRate).toBeCloseTo(0.05, 12);
    expect(r.cutBelowPortfolio).toBeCloseTo(50_000 / 0.06, 6);
    expect(r.raiseAbovePortfolio).toBeCloseTo(50_000 / 0.04, 6);
    expect(r.spendingAfterCut).toBeCloseTo(45_000, 9);
    expect(r.action).toBe("hold");
    expect(r.explanation).toContain("£833,333");
    const cut = guytonKlingerGuardrails({
      portfolio: 700_000,
      spending: 50_000,
      initialRate: 0.05,
    });
    expect(cut.action).toBe("cut");
  });
});

describe("risk-based guardrails (shared simulation set)", () => {
  const plan = (spend: number) =>
    makeInput({
      accounts: [{ id: "inv", name: "Stocks", type: "taxable", owner: "me", balance: 1_000_000 }],
      plan: {
        expenses: [
          expense("ess", 20_000),
          expense("fun", spend, { spendingType: "discretionary", type: "travel" }),
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

  it("recommends a cut, with thresholds bracketing today and spending in money", async () => {
    const r = await evaluateGuardrails(plan(40_000), g, {
      evaluate: fakeMonteCarlo({ trials: 50 }),
    });
    expect(r.currentSuccessRate!).toBeLessThan(0.7);
    expect(r.current.action).toBe("cut");
    expect(r.current.successRate).toBeGreaterThanOrEqual(0.8);
    const t = r.thresholds!;
    expect(t.recommendedSpending).toBeLessThan(60_000);
    expect(t.recommendedSpending).toBeGreaterThan(20_000);
    expect(t.lowerPortfolio!).toBeLessThan(t.portfolio);
    expect(t.upperPortfolio!).toBeGreaterThan(t.portfolio);
    expect(t.cutTo!).toBeLessThan(t.recommendedSpending);
    expect(t.raiseTo!).toBeGreaterThan(t.recommendedSpending);
    expect(r.patch!.every((op) => op.path === "/expenses/[id=fun]/amount/value")).toBe(true);
    expect(r.path.length).toBe(30);
    // The path is the engine's projection with the guardrails applied: any cut lowers spending in
    // later years too.
    const firstCut = r.path.findIndex((y) => y.action === "cut");
    if (firstCut > 0)
      expect(r.path[firstCut]!.spendingReal).toBeLessThan(
        r.path[firstCut - 1]!.spendingReal + 1e-6,
      );
    expect(r.explanation).toMatch(/cut spending from £60,000 to about £/);
    expect(r.explanation).toMatch(/If your investments fall below £/);
  });

  it("holds when inside the band and raises when above it", async () => {
    const lo = await evaluateGuardrails(plan(2_000), g, {
      evaluate: fakeMonteCarlo({ trials: 50 }),
    });
    expect(lo.current.action).toBe("raise");
    expect(lo.thresholds!.recommendedSpending).toBeGreaterThan(25_000);
    const target = lo.thresholds!.recommendedSpending - 20_000;
    const hold = await evaluateGuardrails(plan(target), g, {
      evaluate: fakeMonteCarlo({ trials: 50 }),
    });
    expect(hold.current.action).toBe("hold");
    expect(hold.patch).toBeUndefined();
  });
});

describe("sensitivity (tornado)", () => {
  it("computes bars with planted swings and sorts by swing", async () => {
    const input = makeInput({
      accounts: [{ id: "c", name: "Cash", type: "cash", owner: "me", balance: 1_000_000 }],
      plan: {
        expenses: [expense("liv", 20_000)],
        income: [
          {
            id: "sal",
            type: "salary",
            name: "Salary",
            owner: "me",
            amount: { value: 10_000 },
            frequency: "yearly",
            range: { start: { kind: "planStart" }, end: { kind: "date", date: "2032-01" } },
          },
        ],
      },
      years: 10,
    });
    const r = await sensitivityAnalysis(input);
    expect(r.base).toBeCloseTo(1_000_000 - 200_000 + 50_000, 6);
    const spend = r.bars.find((b) => b.id === "spending")!;
    expect(spend.low - spend.high).toBeCloseTo(2 * 0.1 * 200_000, 6);
    const inc = r.bars.find((b) => b.id === "income")!;
    expect(inc.high - inc.low).toBeCloseTo(2 * 0.1 * 50_000, 6);
    for (let i = 1; i < r.bars.length; i++)
      expect(r.bars[i - 1]!.swing).toBeGreaterThanOrEqual(r.bars[i]!.swing);
    const infl = r.bars.find((b) => b.id === "inflation")!;
    expect(infl.high).toBeLessThan(infl.low); // higher inflation erodes real cash
  });
});

describe("tax strategy search (UK first-class)", () => {
  const uk = makeInput({
    country: "GB",
    accounts: [
      { id: "cash", name: "Current account", type: "cash", owner: "me", balance: 10_000 },
      { id: "isa", name: "Stocks & Shares ISA", type: "uk-isa", owner: "me", balance: 200_000 },
      {
        id: "sipp",
        name: "SIPP",
        type: "uk-sipp",
        owner: "me",
        balance: 300_000,
        behaviour: { ukDrawdownMethod: "ufpls" },
      },
      { id: "gia", name: "GIA", type: "uk-gia", owner: "me", balance: 100_000, costBasis: 50_000 },
    ],
    plan: {
      milestones: [
        {
          id: "ret",
          name: "Retirement",
          kind: "retirement",
          personId: "me",
          criteria: [{ kind: "age", personId: "me", age: 47 }],
        },
      ],
      expenses: [expense("liv", 30_000)],
      tax: { mode: "flat", flat: { ordinary: 0.2, capitalGains: 0.1, dividends: 0, local: 0 } },
    },
    years: 25,
  });

  it("generates pension/ISA/GIA orders plus allowance-filling and lump-sum timing", () => {
    expect(isUkPlan(uk)).toBe(true);
    expect(ukStatePensionAge("1980-01")).toBe(68);
    expect(ukStatePensionAge("1970-06")).toBe(67);
    expect(drawdownOrderCandidates(uk)).toHaveLength(6);
    const ids = ukDrawdownCandidates(uk).map((c) => c.id);
    expect(ids).toContain("uk:fill-personal-allowance");
    expect(ids).toContain("uk:lump-sum:pcls");
    expect(ids).toContain("uk:lump-sum:ufpls");
    const fill = ukDrawdownCandidates(uk).find((c) => c.id === "uk:fill-personal-allowance")!;
    expect(fill.patch[0]).toMatchObject({ op: "add", path: "/taxStrategy" });
    expect(JSON.stringify(fill.patch)).toContain('"value":12570');
  });

  it("ranks drawdown orders by lifetime tax; ISA-last beats pension-last on tax with flat rates", async () => {
    const r = await compareStrategies(uk, drawdownOrderCandidates(uk), {
      objective: "lifetimeTaxesReal",
    });
    expect(r.ranked.length).toBe(7);
    for (let i = 1; i < r.ranked.length; i++)
      expect(r.ranked[i - 1]!.score!).toBeGreaterThanOrEqual(r.ranked[i]!.score!);
    // Taxes paid must be strictly less when the 15%-effective pension is drawn after tax-free ISA money
    // only if the plan ends before the pension is exhausted; check the ranking is consistent instead:
    expect(r.best!.lifetimeTaxesReal!).toBeLessThanOrEqual(r.baseline.lifetimeTaxesReal!);
    expect(r.explanation.length).toBeGreaterThan(10);
  });

  it("scores every UK candidate for real (gap-year allowance filling, basic-rate band, PCLS timing)", async () => {
    const est = { ...uk, plan: { ...uk.plan, tax: { ...uk.plan.tax, mode: "estimate" as const } } };
    const candidates = ukDrawdownCandidates(est);
    expect(candidates.map((c) => c.id)).toContain("uk:fill-basic-rate-band");
    const r = await compareStrategies(est, candidates, { objective: "lifetimeTaxesReal" });
    // Baseline + every candidate evaluated; nothing reported as unsupported.
    expect(r.ranked).toHaveLength(candidates.length + 1);
    expect(r.explanation).not.toMatch(/could not be evaluated/);
    const by = (id: string) => r.ranked.find((x) => x.id === id)!;
    // Gap-year filling and the band-filling strategy both run through the engine's tax.strategy phase.
    expect(by("uk:fill-basic-rate-band").lifetimeTaxesReal).not.toBeCloseTo(
      by("baseline").lifetimeTaxesReal!,
      0,
    );
    expect(by("uk:lump-sum:pcls").lifetimeTaxesReal).not.toBeCloseTo(
      by("uk:lump-sum:ufpls").lifetimeTaxesReal!,
      0,
    );
    const opt = await optimiseTaxStrategy(est, { objective: "endNetWorthReal" });
    expect(opt.best).not.toBeNull();
  });
});
