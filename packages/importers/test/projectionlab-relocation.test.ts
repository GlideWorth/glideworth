/**
 * ProjectionLab Move milestones: Glideworth does not model moving country, so the milestone is kept
 * as a marker and its destination is reported, not imported. Structure only.
 */
import { buildSimulationInput, simulate } from "@glideworth/core";
import { describe, expect, it } from "vitest";
import { importProjectionLab } from "../src/index.js";
import { buildSyntheticExport } from "./fixtures/projectionlab-synthetic.js";

type Json = Record<string, unknown>;

function withMove(key: "location" | "relocation" | "taxResidence", country: string): Json {
  const raw = buildSyntheticExport();
  const plan = (raw.plans as Json[])[0]!;
  (plan.milestones as Json[]).push({
    id: "move-abroad",
    name: "Move abroad",
    criteria: [{ type: "year", value: 2030 }],
    [key]: key === "relocation" ? { location: { country } } : { country, state: "SCT" },
  });
  return raw;
}

describe("ProjectionLab Move milestones", () => {
  it("keeps a Move milestone as a marker with no effect and reports the ignored destination", () => {
    for (const key of ["location", "relocation", "taxResidence"] as const) {
      const r = importProjectionLab(withMove(key, key === "relocation" ? "AE" : "UK"));
      const m = r.document.plans[0]!.milestones.find((x) => x.id === "move-abroad")!;
      expect(m.kind).toBe("move");
      expect(m.effects).toEqual([]);
      const issue = r.report.issues.find((i) => i.code === "pl.relocation");
      expect(issue, key).toBeDefined();
      expect(issue!.sourcePath).toMatch(new RegExp(`\\.${key}`));
      expect(issue!.message).toMatch(/does not model moving country/);
    }
  });

  it("the household keeps its location and the imported plan simulates", () => {
    const raw = withMove("location", "CA");
    const r = importProjectionLab(raw);
    const doc = r.document;
    const input = buildSimulationInput(doc, doc.plans[0]!.id, { trace: "off" });
    const res = simulate({
      ...input,
      plan: { ...input.plan, tax: { ...input.plan.tax, mode: "flat" } },
    });
    expect(res.periods.length).toBeGreaterThan(0);
    expect(doc.household.location.country).not.toBe("CA");
  });
});
