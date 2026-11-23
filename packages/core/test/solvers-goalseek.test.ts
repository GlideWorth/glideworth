import { describe, expect, it } from "vitest";
import {
  applyPlanPatch,
  DEFAULT_SOLVER_SEED,
  goalSeek,
  type ProjectionResult,
  type SimulationInput,
  simulate,
  solveEarliestRetirement,
  solveMaxSpending,
  solveRequiredPortfolio,
  solveRequiredSavings,
  solveSafeWithdrawalRate,
} from "../src/index.js";
import { always, expense, fakeMonteCarlo, makeInput } from "./solvers-helpers.js";

const cashOnly = (balance: number, spend: number, years: number) =>
  makeInput({
    accounts: [{ id: "c", name: "Cash", type: "cash", owner: "me", balance }],
    plan: { expenses: [expense("liv", spend)] },
    years,
  });

describe("goalSeek: planted answers", () => {
  it("recovers a planted threshold through an injected engine (pure bisection)", async () => {
    const input = cashOnly(100_000, 10_000, 5);
    const planted = 0.3737;
    const fake = (i: SimulationInput) => {
      const v =
        i.plan.assumptions.stockReturn.kind === "fixed" ? i.plan.assumptions.stockReturn.rate : 0;
      return { summary: { success: v <= planted } } as unknown as ProjectionResult;
    };
    const r = await goalSeek(
      input,
      {
        variable: { kind: "path", path: "/assumptions/stockReturn/rate" },
        objective: { kind: "noShortfall" },
        direction: "maximize",
        bounds: { min: 0, max: 1 },
        tolerance: 1e-6,
        maxEvaluations: 40,
      },
      { simulate: fake },
    );
    expect(r.status).toBe("solved");
    expect(r.converged).toBe(true);
    expect(r.value!).toBeLessThanOrEqual(planted);
    expect(planted - r.value!).toBeLessThan(1e-6);
    expect(r.bracket!.infeasible! - r.bracket!.feasible!).toBeLessThanOrEqual(1e-6);
    expect(r.patch).toEqual([
      { op: "replace", path: "/assumptions/stockReturn/rate", value: r.value },
    ]);
  });

  it("finds the spending level that leaves a target end net worth (smooth objective, interpolation)", async () => {
    const input = cashOnly(100_000, 1_000, 20);
    const r = await goalSeek(input, {
      variable: { kind: "path", path: "/expenses/[id=liv]/amount/value" },
      objective: { kind: "endNetWorth", target: { value: 50_000, basis: "real" } },
      direction: "maximize",
      bounds: { min: 0, max: 20_000 },
      tolerance: 0.01,
    });
    expect(r.value!).toBeCloseTo(2_500, 1);
    // Interpolation lands on a linear objective in very few evaluations.
    expect(r.evaluations.length).toBeLessThanOrEqual(8); // bisection alone needs ~21
    expect(r.achieved!).toBeGreaterThanOrEqual(50_000 - 1e-6);
  });

  it("reports infeasible and at-bound outcomes honestly", async () => {
    const input = cashOnly(100_000, 10_000, 20);
    const infeasible = await goalSeek(input, {
      variable: { kind: "spendingScale" },
      objective: { kind: "noShortfall" },
      direction: "maximize",
      bounds: { min: 0.6, max: 2 },
    });
    expect(infeasible.status).toBe("infeasible");
    expect(infeasible.value).toBeNull();
    const atBound = await goalSeek(input, {
      variable: { kind: "spendingScale" },
      objective: { kind: "noShortfall" },
      direction: "maximize",
      bounds: { min: 0, max: 0.4 },
    });
    expect(atBound.status).toBe("at-bound");
    expect(atBound.value).toBe(0.4);
  });

  it("respects maxEvaluations and keeps the best feasible value", async () => {
    const input = cashOnly(100_000, 10_000, 20);
    const r = await goalSeek(input, {
      variable: { kind: "spendingScale" },
      objective: { kind: "noShortfall" },
      direction: "maximize",
      bounds: { min: 0, max: 4 },
      tolerance: 1e-9,
      maxEvaluations: 6,
    });
    expect(r.status).toBe("max-evaluations");
    expect(r.converged).toBe(false);
    expect(r.evaluations.length).toBeLessThanOrEqual(8); // bisection alone needs ~21
    expect(r.value!).toBeLessThanOrEqual(0.5);
  });
});

describe("specific solvers (deterministic known answers)", () => {
  it("solveMaxSpending: 100k cash, 20 years, no growth -> half the planned 10k/yr", async () => {
    const r = await solveMaxSpending(cashOnly(100_000, 10_000, 20), {
      objective: { kind: "noShortfall" },
    });
    expect(r.value!).toBeCloseTo(0.5, 2);
    expect(r.value!).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(r.details!.annualSpending as number).toBeCloseTo(5_000, -1);
    expect(r.explanation).toMatch(/£5,0\d\d a year/);
    // The returned patch applies the answer.
    const plan = applyPlanPatch(cashOnly(100_000, 10_000, 20).plan, r.patch!);
    expect(plan.expenses[0]!.amount.value).toBeCloseTo(10_000 * r.value!, 6);
  });

  it("solveEarliestRetirement: salary 50k, spend 29k, 20 years -> 140 months (t = 0.4 * E years)", async () => {
    const input = makeInput({
      accounts: [{ id: "c", name: "Cash", type: "cash", owner: "me", balance: 0 }],
      plan: {
        milestones: [
          {
            id: "ret",
            name: "Retirement",
            kind: "retirement",
            personId: "me",
            criteria: [{ kind: "age", personId: "me", age: 65 }],
          },
        ],
        income: [
          {
            id: "sal",
            type: "salary",
            name: "Salary",
            owner: "me",
            amount: { value: 50_000 },
            frequency: "yearly",
            range: { start: { kind: "planStart" }, end: { kind: "milestone", milestoneId: "ret" } },
          },
        ],
        expenses: [expense("liv", 29_000)],
      },
      years: 20,
    });
    const r = await solveEarliestRetirement(input, {
      milestoneId: "ret",
      objective: { kind: "noShortfall" },
    });
    expect(r.status).toBe("solved");
    expect(r.value).toBe(140);
    expect(r.details!.month).toBe("2038-09");
    expect(r.details!.age as number).toBeCloseTo(58 + 8 / 12, 9);
    // The milestone stays age-based in the patch.
    expect(r.patch).toEqual([
      {
        op: "replace",
        path: "/milestones/[id=ret]/criteria/0/age",
        value: (2038 * 12 + 8 - 1980 * 12) / 12,
      },
    ]);
    const ok = simulate({ ...input, plan: applyPlanPatch(input.plan, r.patch!) });
    expect(ok.summary.success).toBe(true);
    const oneEarlier = await solveEarliestRetirement(input, {
      milestoneId: "ret",
      objective: { kind: "noShortfall" },
      bounds: { min: 139, max: 139 },
    });
    expect(oneEarlier.status).toBe("infeasible");
    expect(r.explanation).toMatch(/Sep 2038/);
  });

  it("solveRequiredSavings: contribution must quadruple (5k -> 20k for 10 years funds 20k x 10)", async () => {
    const input = makeInput({
      accounts: [{ id: "inv", name: "Investments", type: "taxable", owner: "me", balance: 0 }],
      plan: {
        leftover: { kind: "spend" },
        income: [
          {
            id: "sal",
            type: "salary",
            name: "Salary",
            owner: "me",
            amount: { value: 50_000 },
            frequency: "yearly",
            range: { start: { kind: "planStart" }, end: { kind: "date", date: "2037-01" } },
          },
        ],
        expenses: [expense("liv", 20_000)],
        flows: [
          {
            kind: "contribution",
            id: "save",
            name: "Monthly investing",
            owner: "me",
            accountId: "inv",
            range: { start: { kind: "planStart" }, end: { kind: "date", date: "2037-01" } },
            method: { kind: "amount", amount: { value: 5_000 }, frequency: "yearly" },
          },
        ],
      },
      years: 20,
    });
    const r = await solveRequiredSavings(input, {
      flowId: "save",
      objective: { kind: "noShortfall" },
    });
    expect(r.value!).toBeCloseTo(4, 2);
    expect(r.value!).toBeGreaterThanOrEqual(4 - 1e-9);
    expect(r.details!.annualContribution as number).toBeCloseTo(20_000, -2);
  });

  it("solveRequiredPortfolio: 10k/yr for 20 years needs 200k invested", async () => {
    const input = makeInput({
      accounts: [{ id: "inv", name: "ISA", type: "uk-isa", owner: "me", balance: 100_000 }],
      plan: { expenses: [expense("liv", 10_000)] },
      years: 20,
    });
    const r = await solveRequiredPortfolio(input, { objective: { kind: "noShortfall" } });
    expect(r.value!).toBeCloseTo(2, 2);
    expect(r.details!.requiredPortfolio as number).toBeCloseTo(200_000, -3);
    expect(r.patch).toBeUndefined();
  });

  it("solveSafeWithdrawalRate: zero real return over 30 years -> 1/30", async () => {
    const input = makeInput({
      accounts: [
        { id: "inv", name: "GIA", type: "uk-gia", owner: "me", balance: 1_000_000 },
        { id: "c", name: "Cash", type: "cash", owner: "me", balance: 50_000 },
      ],
      plan: { expenses: [expense("liv", 80_000)] },
      years: 50,
    });
    const r = await solveSafeWithdrawalRate(input, {
      years: 30,
      objective: { kind: "noShortfall" },
    });
    expect(r.value!).toBeCloseTo(1 / 30, 4);
    expect(r.value!).toBeLessThanOrEqual(1 / 30 + 1e-12);
    expect(r.explanation).toMatch(/3\.33%/);
  });
});

describe("Monte Carlo objective (common random numbers)", () => {
  const input = makeInput({
    accounts: [{ id: "inv", name: "Stocks", type: "taxable", owner: "me", balance: 1_000_000 }],
    plan: { expenses: [expense("liv", 40_000)] },
    years: 30,
  });

  it("solveMaxSpending hits the target with a fixed seed and gives a monotone sensitivity band", async () => {
    const calls: { seed: number | null }[] = [];
    const evaluate = fakeMonteCarlo({ trials: 60, calls });
    const progress: number[] = [];
    const r = await solveMaxSpending(
      input,
      { targetSuccessRate: 0.8 },
      { evaluate, onProgress: (n) => progress.push(n) },
    );
    expect(r.status).toBe("solved");
    expect(r.seed).toBe(DEFAULT_SOLVER_SEED);
    expect(new Set(calls.map((c) => c.seed))).toEqual(new Set([DEFAULT_SOLVER_SEED]));
    expect(r.achieved!).toBeGreaterThanOrEqual(0.8);
    // Just above the answer the target fails (the boundary is real, not noise).
    const plan = applyPlanPatch(input.plan, [
      {
        op: "replace",
        path: "/expenses/[id=liv]/amount/value",
        value: 40_000 * r.bracket!.infeasible!,
      },
      { op: "replace", path: "/monteCarlo/seed", value: DEFAULT_SOLVER_SEED },
    ]);
    const above = await evaluate({ ...input, plan });
    expect(above.successRate).toBeLessThan(0.8);
    const [at75, at85] = r.sensitivity;
    expect(at75!.label).toMatch(/75%/);
    expect(at85!.label).toMatch(/85%/);
    expect(at75!.value!).toBeGreaterThanOrEqual(r.value!);
    expect(at85!.value!).toBeLessThanOrEqual(r.value!);
    // Evaluations: monotone metric in the variable (CRN => no noise).
    const sorted = [...r.evaluations].sort((a, b) => a.value - b.value);
    for (let i = 1; i < sorted.length; i++)
      expect(sorted[i]!.metric).toBeLessThanOrEqual(sorted[i - 1]!.metric + 1e-12);
    expect(progress.length).toBeGreaterThan(3);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    // Neighbouring targets (the sensitivity band) keep reporting, so the count reaches every
    // evaluation the search actually ran, not only the main target.
    expect(progress.at(-1)).toBe(r.evaluations.length);
  });

  it("honours a seed in the request settings", async () => {
    const calls: { seed: number | null }[] = [];
    await solveMaxSpending(
      input,
      {
        targetSuccessRate: 0.5,
        monteCarlo: { ...input.plan.monteCarlo, seed: 7 },
        maxEvaluations: 4,
        sensitivityDeltas: [],
      },
      { evaluate: fakeMonteCarlo({ trials: 10, calls }) },
    );
    expect(calls.every((c) => c.seed === 7)).toBe(true);
  });

  it("can be cancelled before or during a run", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      solveMaxSpending(
        input,
        { targetSuccessRate: 0.8 },
        { evaluate: fakeMonteCarlo({ trials: 5 }), signal: ac.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    const ac2 = new AbortController();
    let seen = 0;
    await expect(
      solveMaxSpending(
        input,
        { targetSuccessRate: 0.8 },
        {
          evaluate: fakeMonteCarlo({ trials: 5 }),
          signal: ac2.signal,
          onProgress: (n) => {
            seen = n;
            if (n >= 2) ac2.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toBe(2);
  });
});

void always;

describe("integration with the real Monte Carlo runner (workstream c)", () => {
  it("solves max spending on the sample plan with the default evaluator, cancellably", async () => {
    const { buildSimulationInput } = await import("../src/index.js");
    const { createSampleDocument } = await import("../src/samples/index.js");
    const input = buildSimulationInput(createSampleDocument(), "plan-main");
    const mc = { ...input.plan.monteCarlo, method: "normal" as const, trials: 60, seed: 11 };
    const t0 = performance.now();
    const r = await solveMaxSpending(input, {
      targetSuccessRate: 0.8,
      monteCarlo: mc,
      maxEvaluations: 12,
      sensitivityDeltas: [],
    });
    const ms = performance.now() - t0;
    expect(r.seed).toBe(11);
    expect(["solved", "max-evaluations", "at-bound", "infeasible"]).toContain(r.status);
    if (r.value !== null) expect(r.achieved!).toBeGreaterThanOrEqual(0.8);
    expect(ms).toBeLessThan(30_000);
    const ac = new AbortController();
    const p = solveMaxSpending(
      input,
      { targetSuccessRate: 0.8, monteCarlo: mc },
      { signal: ac.signal, onProgress: () => ac.abort() },
    );
    await expect(p).rejects.toBeTruthy();
  }, 60_000);
});
