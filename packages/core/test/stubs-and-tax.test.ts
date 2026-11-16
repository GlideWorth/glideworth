import { describe, expect, it } from "vitest";
import {
  buildSimulationInput,
  createDefaultTaxRegistry,
  createRng,
  deriveSeed,
  NotImplementedError,
  progressiveTax,
  runMonteCarlo,
} from "../src/index.js";
import { createSampleDocument } from "../src/samples/index.js";

describe("tax", () => {
  it("computes progressive brackets with indexation and proration", () => {
    const table = {
      brackets: [
        { from: 0, rate: 0.1 },
        { from: 10_000, rate: 0.2 },
        { from: 50_000, rate: 0.4 },
      ],
      basis: "real" as const,
    };
    expect(progressiveTax(60_000, table).tax).toBeCloseTo(1_000 + 8_000 + 4_000, 9);
    expect(progressiveTax(60_000, table).marginalRate).toBe(0.4);
    expect(progressiveTax(20_000, table, 2).tax).toBeCloseTo(2_000, 9);
    expect(progressiveTax(5_000, table, 1, 0.5).tax).toBeCloseTo(500, 9);
  });

  it("resolves implemented jurisdiction stacks; unknown countries throw NotImplementedError", () => {
    const reg = createDefaultTaxRegistry();
    const doc = createSampleDocument();
    const plan = doc.plans[0]!;
    const stack = reg.resolveStack(
      { ...plan.tax, mode: "estimate" },
      { country: "US", region: "CO" },
    );
    expect(stack.map((j) => j.id)).toEqual(["us-federal", "us-payroll", "us-state:CO"]);
    expect(stack.every((j) => j.status === "implemented")).toBe(true);
    expect(
      reg.resolveStack({ ...plan.tax, mode: "estimate" }, { country: "GB" }).map((j) => j.id),
    ).toEqual(["uk"]);
    // No estimate preset for this country: typed error pointing at workstream (b).
    expect(
      reg.resolveStack({ ...plan.tax, mode: "estimate" }, { country: "NL" }).map((j) => j.id),
    ).toEqual(["nl"]);
    expect(() => reg.resolveStack({ ...plan.tax, mode: "estimate" }, { country: "JP" })).toThrow(
      NotImplementedError,
    );
  });
});

describe("formerly stubbed features now run", () => {
  const doc = createSampleDocument();
  const input = buildSimulationInput(doc, "plan-main");
  it("stochastic: Monte Carlo runs on the sample plan", () => {
    const r = runMonteCarlo(input, { ...doc.plans[0]!.monteCarlo, trials: 20, seed: 1 });
    expect(r.successRate).toBeGreaterThanOrEqual(0);
    expect(r.successRate).toBeLessThanOrEqual(1);
  });
  // solvers / insights: see solvers-*.test.ts and insights-*.test.ts.
});

describe("rng", () => {
  it("is deterministic per seed and well distributed", () => {
    const a = createRng(42);
    const b = createRng(42);
    const xs = Array.from({ length: 1000 }, () => a.next());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b.next()));
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
    const n = createRng(7);
    const normals = Array.from({ length: 5000 }, () => n.normal());
    const m = normals.reduce((s, x) => s + x, 0) / normals.length;
    expect(Math.abs(m)).toBeLessThan(0.05);
    expect(deriveSeed(1, 0)).not.toBe(deriveSeed(1, 1));
  });
});
