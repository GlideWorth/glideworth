/** Plan optimiser (solvers/optimise-plan.ts) on the synthetic sample plan, checked against the engine. */
import { describe, expect, it } from "vitest";
import {
  applyPlanPatch,
  buildSimulationInput,
  formatMonth,
  milestoneAtMonthPatch,
  optimisePlan,
  parseMonth,
  type SimulationInput,
  simulate,
} from "../src/index.js";
import { createSampleDocument, SAMPLE_PLAN_ID } from "../src/samples/index.js";

const sample = (): SimulationInput =>
  buildSimulationInput(createSampleDocument(), SAMPLE_PLAN_ID, { trace: "off" });

/** The sample plan with a mortgage overpayment flow (the "overpay or invest?" question). */
function withOverpayment(): SimulationInput {
  const input = sample();
  const plan = applyPlanPatch(input.plan, [
    {
      op: "add",
      path: "/flows/0",
      value: {
        kind: "debtPaydown",
        id: "fl-overpay",
        name: "Overpay the mortgage",
        owner: "joint",
        targetId: "ra-home",
        range: {
          start: { kind: "planStart" },
          end: { kind: "milestone", milestoneId: "ms-retire" },
        },
        method: { kind: "amount", amount: { value: 12_000, basis: "real" }, frequency: "yearly" },
      },
    },
  ]);
  return { ...input, plan };
}

const run = (input: SimulationInput, ops: Parameters<typeof applyPlanPatch>[1]) =>
  simulate({ ...input, plan: applyPlanPatch(input.plan, ops), options: { ...input.options } });

describe("optimisePlan", () => {
  it("max-end-net-worth: searches every combination of a small space and its best ops reproduce its numbers", async () => {
    const input = sample();
    const r = await optimisePlan(input, {
      goal: "max-end-net-worth",
      levers: [
        { kind: "toggle", flowId: "fl-roth" },
        { kind: "scale", flowId: "fl-401k", min: 0.5, max: 1.5, steps: 3 },
      ],
    });
    expect(r.method).toBe("exhaustive");
    expect(r.status).toBe("complete");
    expect(r.spaceSize).toBe(6);
    expect(r.candidatesEvaluated).toBe(6);
    expect(r.baseline.changes).toEqual([]);
    expect(r.baseline.ops).toEqual([]);
    const base = simulate(input);
    expect(r.baseline.endNetWorthReal).toBe(Math.round(base.summary.endNetWorthReal));
    // The best candidate is at least as good as every alternative and as the baseline.
    for (const c of [r.baseline, ...r.alternatives])
      if (c.feasible) expect(r.best.endNetWorthReal!).toBeGreaterThanOrEqual(c.endNetWorthReal!);
    const check = run(input, r.best.ops);
    expect(Math.round(check.summary.endNetWorthReal)).toBe(r.best.endNetWorthReal);
    expect(check.summary.success).toBe(r.best.feasible);
    expect(r.alternatives.length).toBe(5);
    expect(r.explanation).toMatch(/Net worth at the end/);
  });

  it("earliest-retirement: overpay the mortgage or invest the same money; the month found is the earliest without a shortfall", async () => {
    const input = withOverpayment();
    const r = await optimisePlan(input, {
      goal: "earliest-retirement",
      levers: [{ kind: "redirect", flowId: "fl-overpay", accountId: "acc-brokerage" }],
    });
    expect(r.milestoneId).toBe("ms-retire");
    expect(r.plannedMonth).toMatch(/^\d{4}-\d{2}$/);
    expect(r.method).toBe("exhaustive");
    expect(r.candidatesEvaluated).toBe(2);
    const both = [r.best, ...r.alternatives];
    expect(both.map((c) => c.changes.join())).toContain("");
    expect(both.map((c) => c.changes.join())).toContain(
      "Overpay the mortgage: contribute to Joint brokerage",
    );
    expect(r.best.month).not.toBeNull();
    for (const c of both) if (c.month) expect(c.month >= r.best.month!).toBe(true);
    // Retiring at the best month with the best ops has no shortfall; a month earlier does.
    const plan = applyPlanPatch(input.plan, r.best.ops);
    const at = (month: number) =>
      simulate({
        ...input,
        plan: applyPlanPatch(plan, milestoneAtMonthPatch({ ...input, plan }, "ms-retire", month)),
      }).summary.success;
    const m = parseMonth(r.best.month!);
    expect(at(m)).toBe(true);
    expect(at(m - 1)).toBe(false);
    // milestoneOps move retirement to that month on top of the lever ops.
    const moved = applyPlanPatch(plan, r.milestoneOps);
    expect(
      simulate({ ...input, plan: moved }).milestones.find((x) => x.milestoneId === "ms-retire")
        ?.month,
    ).toBe(formatMonth(m));
    // The redirected flow keeps its id, amount and dates.
    const redirected = applyPlanPatch(input.plan, both.find((c) => c.ops.length)!.ops);
    const f = redirected.flows.find((x) => x.id === "fl-overpay")!;
    expect(f.kind).toBe("contribution");
    expect(f.kind === "contribution" && f.accountId).toBe("acc-brokerage");
    expect(f.kind === "contribution" && f.method).toEqual({
      kind: "amount",
      amount: { value: 12_000, basis: "real" },
      frequency: "yearly",
    });
  });

  it("earliest-retirement by coordinate descent: the month found is still checked against the engine", async () => {
    const input = withOverpayment();
    const r = await optimisePlan(input, {
      goal: "earliest-retirement",
      levers: [
        { kind: "redirect", flowId: "fl-overpay", accountId: "acc-brokerage" },
        { kind: "scale", flowId: "fl-401k", min: 0.5, max: 1.5, steps: 5 },
      ],
      maxEvaluations: 60,
    });
    expect(r.method).toBe("coordinate-descent");
    expect(r.evaluations).toBeLessThanOrEqual(61);
    expect(r.best.month! <= r.baseline.month!).toBe(true);
    const plan = applyPlanPatch(input.plan, r.best.ops);
    const at = (month: number) =>
      simulate({
        ...input,
        plan: applyPlanPatch(plan, milestoneAtMonthPatch({ ...input, plan }, "ms-retire", month)),
      }).summary.success;
    expect(at(parseMonth(r.best.month!))).toBe(true);
    expect(at(parseMonth(r.best.month!) - 1)).toBe(false);
  });

  it("earliest-fi reads the financial-independence milestone", async () => {
    // The sample never reaches 25x spending; 12x is reachable, so the milestone has a month to move.
    const input = sample();
    const plan = applyPlanPatch(input.plan, [
      { op: "replace", path: "/milestones/[id=ms-fi]/criteria/0/threshold/multiple", value: 12 },
    ]);
    const r = await optimisePlan(
      { ...input, plan },
      {
        goal: "earliest-fi",
        levers: [{ kind: "scale", flowId: "fl-401k", min: 0, max: 2, steps: 3 }],
      },
    );
    expect(r.milestoneId).toBe("ms-fi");
    expect(r.best.month).toMatch(/^\d{4}-\d{2}$/);
    expect(r.baseline.month).toMatch(/^\d{4}-\d{2}$/);
    expect(r.best.month! <= r.baseline.month!).toBe(true);
    for (const c of r.alternatives)
      if (c.month && c.feasible) expect(c.month >= r.best.month!).toBe(true);
    // The month reported is the one the engine resolves for the best ops.
    const check = run({ ...input, plan }, r.best.ops);
    expect(check.milestones.find((m) => m.milestoneId === "ms-fi")?.month).toBe(r.best.month);
  });

  it("uses coordinate descent and stops at the evaluation cap when the space is large", async () => {
    const r = await optimisePlan(sample(), {
      goal: "max-end-net-worth",
      levers: [
        { kind: "scale", flowId: "fl-401k", min: 0, max: 2, steps: 9 },
        { kind: "scale", flowId: "fl-roth", min: 0, max: 2, steps: 9 },
        { kind: "toggle", flowId: "fl-taxable" },
      ],
      maxEvaluations: 12,
    });
    expect(r.method).toBe("coordinate-descent");
    expect(r.spaceSize).toBe(9 * 9 * 2);
    expect(r.evaluations).toBeLessThanOrEqual(13);
    expect(r.status).toBe("max-evaluations");
  });

  it("is deterministic", async () => {
    const req = {
      goal: "max-end-net-worth" as const,
      levers: [{ kind: "scale" as const, flowId: "fl-roth", min: 0, max: 2, steps: 5 }],
    };
    expect(await optimisePlan(sample(), req)).toEqual(await optimisePlan(sample(), req));
  });

  it("refuses levers it cannot apply, with the reason", async () => {
    const input = withOverpayment();
    await expect(
      optimisePlan(input, {
        goal: "max-end-net-worth",
        levers: [{ kind: "toggle", flowId: "nope" }],
      }),
    ).rejects.toThrow(/unknown flow 'nope'/);
    await expect(
      optimisePlan(input, {
        goal: "max-end-net-worth",
        levers: [{ kind: "scale", flowId: "fl-emergency" }],
      }),
    ).rejects.toThrow(/no fixed amount or share to scale/);
    await expect(
      optimisePlan(input, {
        goal: "max-end-net-worth",
        levers: [{ kind: "redirect", flowId: "fl-overpay" }],
      }),
    ).rejects.toThrow(/needs accountId/);
    await expect(
      optimisePlan(input, {
        goal: "max-end-net-worth",
        levers: [{ kind: "redirect", flowId: "fl-roth", targetId: "acc-cash" }],
      }),
    ).rejects.toThrow(/not a debt or a real asset with a loan/);
  });
});
