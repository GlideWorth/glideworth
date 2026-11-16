import { buildSimulationInput, simulate } from "@glideworth/core";
import {
  createSampleDocument,
  createUkSampleDocument,
  UK_SAMPLE_PLAN_ID,
} from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import { SCENARIOS } from "../src/features/insights/insights-model";
import { inputFor } from "../src/features/insights/plan-edits";
import {
  buildSurvivorTemplates,
  buildTemplates,
  variantOf,
} from "../src/features/insights/scenario-templates";
import { runStrategyRequest } from "../src/features/insights/strategy-handle";

const households = [
  { name: "US couple", doc: createSampleDocument(), planId: "plan-main" },
  { name: "UK single", doc: createUkSampleDocument(), planId: UK_SAMPLE_PLAN_ID },
];

describe.each(households)("what-if templates: $name", ({ doc, planId }) => {
  const input = buildSimulationInput(doc, planId);
  const base = simulate(input);
  it("every template builds, applies and simulates", () => {
    const built = [...buildTemplates(input, base), ...buildSurvivorTemplates(input)];
    expect(built.length).toBeGreaterThan(0);
    expect(built.filter((b) => b.template).length).toBeGreaterThanOrEqual(6);
    for (const b of built) {
      if (!b.template) {
        // Only acceptable reasons: the plan lacks the thing the template changes.
        expect(b.error, b.id).toMatch(/no |needs|couple|fixed/i);
        continue;
      }
      const v = variantOf(input, b.template);
      const r = simulate(inputFor(input, v));
      expect(r.periods.length, b.id).toBeGreaterThan(0);
      expect(Number.isFinite(r.summary.endNetWorthReal), b.id).toBe(true);
    }
  });
});

describe.each(households)("scenario gallery: $name", ({ doc, planId }) => {
  const input = buildSimulationInput(doc, planId);
  const base = simulate(input);
  it("every scenario simulates, and persistable ones simulate as plain plans too", () => {
    for (const s of SCENARIOS) {
      const v = s.build(input.plan, base, input.finances.asOf);
      if (!v) continue;
      const r = simulate(inputFor(input, v));
      expect(r.periods.length, s.id).toBeGreaterThan(0);
      if (v.persist) {
        const p = simulate(inputFor(input, { plan: v.persist, changes: [] }));
        expect(p.periods.length, `${s.id} persisted`).toBeGreaterThan(0);
      }
    }
  });
});

describe("tax strategy ranking", () => {
  it("ranks UK drawdown candidates with the baseline included", async () => {
    const doc = createUkSampleDocument();
    const input = buildSimulationInput(doc, UK_SAMPLE_PLAN_ID);
    const cmp = await runStrategyRequest({ id: 1, input, objective: "endNetWorthReal" });
    expect(cmp.ranked.some((r) => r.id === "baseline")).toBe(true);
    expect(cmp.ranked.length).toBeGreaterThan(1);
    for (let i = 1; i < cmp.ranked.length; i++)
      expect(cmp.ranked[i - 1]!.score!).toBeGreaterThanOrEqual(cmp.ranked[i]!.score!);
    expect(cmp.explanation.length).toBeGreaterThan(0);
  });
});
