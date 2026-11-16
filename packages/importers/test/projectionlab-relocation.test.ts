/** ProjectionLab Move milestones -> the residency timeline (relocate effects). Structure only. */
import { buildSimulationInput, simulate } from "@glideworth/core";
import { describe, expect, it } from "vitest";
import { importProjectionLab } from "../src/index.js";
import { buildSyntheticExport } from "./fixtures/projectionlab-synthetic.js";

type Json = Record<string, unknown>;

describe("ProjectionLab relocation fields", () => {
  it("maps a Move milestone destination (location / relocation / taxResidence) to a relocate effect", () => {
    for (const key of ["location", "relocation", "taxResidence"] as const) {
      const raw = buildSyntheticExport();
      const plan = (raw.plans as Json[])[0]!;
      const milestones = plan.milestones as Json[];
      milestones.push({
        id: "move-abroad",
        name: "Move abroad",
        criteria: [{ type: "year", value: 2035 }],
        [key]:
          key === "relocation" ? { location: { country: "AE" } } : { country: "UK", state: "SCT" },
      });
      const r = importProjectionLab(raw);
      const m = r.document.plans[0]!.milestones.find((x) => x.id === "move-abroad")!;
      expect(m.kind).toBe("move");
      expect(m.effects).toEqual([
        {
          kind: "relocate",
          location: key === "relocation" ? { country: "AE" } : { country: "GB", region: "SCT" },
        },
      ]);
      expect(JSON.stringify(r.report)).toMatch(/pl\.relocation/);
    }
  });

  it("an imported move runs through the residency timeline", () => {
    const raw = buildSyntheticExport();
    const plan = (raw.plans as Json[])[0]!;
    (plan.milestones as Json[]).push({
      id: "move-abroad",
      name: "Move abroad",
      criteria: [{ type: "year", value: 2030 }],
      location: { country: "CA", state: "ON" },
    });
    const r = importProjectionLab(raw);
    const doc = r.document;
    const input = buildSimulationInput(doc, doc.plans[0]!.id, { trace: "off" });
    const res = simulate({
      ...input,
      plan: { ...input.plan, tax: { ...input.plan.tax, mode: "flat" } },
    });
    expect(res.periods.length).toBeGreaterThan(0);
  });

  it("drops an unrecognised destination country with an issue", () => {
    const raw = buildSyntheticExport();
    const plan = (raw.plans as Json[])[0]!;
    (plan.milestones as Json[]).push({
      id: "move-x",
      name: "Move",
      criteria: [{ type: "year", value: 2030 }],
      location: { country: "Atlantis" },
    });
    const r = importProjectionLab(raw);
    expect(r.document.plans[0]!.milestones.find((x) => x.id === "move-x")!.effects).toEqual([]);
  });
});
