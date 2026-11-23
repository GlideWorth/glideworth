/**
 * Schema 1 -> 2 (moving country removed): documents, stored plan bodies and branch patches written
 * with residency timelines, relocate effects and the removed cross-border switches still load, with
 * those fields gone and everything else intact.
 */
import { describe, expect, it } from "vitest";
import { simulate } from "../src/engine/simulate.js";
import { applyPlanPatch } from "../src/insights/patch.js";
import { buildSimulationInput } from "../src/scenario.js";
import { createUkSampleDocument, UK_SAMPLE_PLAN_ID } from "../src/samples/index.js";
import { migrateDocument, migratePlan, SCHEMA_VERSION } from "../src/schema/document.js";

type Json = Record<string, unknown>;

const relocate = { kind: "relocate", location: { country: "AE" } };
const fileJointly = { kind: "setFilingStatus", filingStatus: "married-joint" };
const moveMilestone = {
  id: "move",
  name: "Move to Dubai",
  kind: "custom",
  criteria: [{ kind: "date", date: "2030-01" }],
  effects: [fileJointly, relocate],
};

/** A v1 export (synthetic UK sample) carrying every field the migration removes. */
function v1Document(): Json {
  const doc = JSON.parse(JSON.stringify(createUkSampleDocument())) as Json;
  doc.schemaVersion = 1;
  const household = doc.household as Json;
  household.people = (household.people as Json[]).map((p) => ({
    ...p,
    citizenships: ["GB"],
    residenceHistory: [{ country: "GB", from: "1990-01" }],
    statePensionRecords: [{ country: "GB", qualifyingYears: 20 }],
  }));
  const main = (doc.plans as Json[])[0]!;
  main.residency = [
    { id: "to-ae", from: { kind: "date", date: "2030-01" }, location: { country: "AE" } },
  ];
  main.milestones = [...(main.milestones as Json[]), moveMilestone];
  main.tax = {
    ...(main.tax as Json),
    crossBorder: {
      mode: "auto",
      departureTax: "defer",
      ukTemporaryNonResidence: false,
      freezeStatePensionAbroad: false,
      wrapperRecognition: { "AE:GB:uk-isa": true },
    },
  };
  const branch: Json = {
    ...main,
    id: "branch",
    name: "Branch",
    isMain: false,
    lineage: {
      parentPlanId: main.id,
      parentVersion: null,
      patch: [
        { op: "add", path: "/residency/-", value: { id: "x", from: { kind: "planStart" } } },
        { op: "replace", path: "/tax/crossBorder/departureTax", value: "apply" },
        { op: "add", path: "/milestones/-", value: { ...moveMilestone, id: "move-2" } },
        { op: "add", path: "/milestones/0/effects/-", value: relocate },
        { op: "replace", path: "/name", value: "Branch" },
      ],
    },
  };
  doc.plans = [main, branch];
  return doc;
}

function expectClean(plan: Json, expectedMilestones: number) {
  expect(plan).not.toHaveProperty("residency");
  const milestones = plan.milestones as Json[];
  expect(milestones).toHaveLength(expectedMilestones);
  const move = milestones.find((m) => m.id === "move")!;
  expect(move.effects).toEqual([fileJointly]);
  expect((plan.tax as Json).crossBorder).toEqual({
    mode: "auto",
    wrapperRecognition: { "AE:GB:uk-isa": true },
  });
}

describe("schema 1 -> 2: moving country removed", () => {
  it("migrateDocument drops residency, relocate effects, removed switches and past residence", () => {
    const raw = v1Document();
    const before = (raw.plans as Json[])[0]!.milestones as Json[];
    const doc = migrateDocument(raw);
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    for (const p of doc.household.people) {
      expect(p).not.toHaveProperty("residenceHistory");
      expect(p).not.toHaveProperty("statePensionRecords");
      expect(p.citizenships).toEqual(["GB"]);
    }
    const [main, branch] = doc.plans as unknown as Json[];
    expectClean(main!, before.length);
    // Branch patch: ops on removed fields go; a milestone added with a relocate effect keeps the rest.
    const patch = (branch!.lineage as Json).patch as Json[];
    expect(patch).toEqual([
      {
        op: "add",
        path: "/milestones/-",
        value: { ...moveMilestone, id: "move-2", effects: [fileJointly] },
      },
      { op: "replace", path: "/name", value: "Branch" },
    ]);
    // The cleaned patch still applies to the migrated parent, and the plan simulates.
    const applied = applyPlanPatch(doc.plans[0]!, patch as never);
    expect(applied.milestones.find((m) => m.id === "move-2")!.effects).toEqual([fileJointly]);
    const r = simulate(buildSimulationInput(doc, UK_SAMPLE_PLAN_ID));
    expect(r.periods.length).toBeGreaterThan(0);
  });

  it("migratePlan upgrades a stored v1 plan body the same way", () => {
    const raw = v1Document();
    const main = (raw.plans as Json[])[0]!;
    const plan = migratePlan(structuredClone(main), 1);
    expectClean(plan as unknown as Json, (main.milestones as Json[]).length);
    // Everything else is untouched.
    const untouched = migrateDocument({ ...createUkSampleDocument(), schemaVersion: 1 }).plans[0]!;
    expect({ ...plan, milestones: untouched.milestones, tax: untouched.tax }).toEqual(untouched);
  });

  it("a current plan is not migrated again", () => {
    const plan = createUkSampleDocument().plans[0]!;
    expect(migratePlan(structuredClone(plan))).toEqual(plan);
  });
});
