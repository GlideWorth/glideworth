/**
 * Schema 1 -> 2 (moving country removed): documents, stored plan bodies and branch patches written
 * with residency timelines, relocate effects and the removed cross-border switches still load, with
 * those fields gone and everything else intact.
 */
import { describe, expect, it } from "vitest";
import { simulate } from "../src/engine/simulate.js";
import { applyPlanPatch } from "../src/insights/patch.js";
import { buildSimulationInput } from "../src/scenario.js";
import {
  createSampleDocument,
  createUkSampleDocument,
  SAMPLE_PLAN_ID,
  UK_SAMPLE_PLAN_ID,
} from "../src/samples/index.js";
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
    // Migrated through 1 -> 2 and every later step.
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

/**
 * The synthetic US sample stored as schema 2, estimating US tax, with an ACA expense whose size was
 * typed in.
 */
function v5UsDocument(householdSize: number): Json {
  const doc = JSON.parse(JSON.stringify(createSampleDocument())) as Json;
  doc.schemaVersion = 5;
  const main = (doc.plans as Json[]).find((p) => p.id === SAMPLE_PLAN_ID)!;
  main.tax = { mode: "estimate", filingStatus: "married-joint" };
  main.expenses = [
    ...(main.expenses as Json[]),
    {
      id: "exp-aca",
      type: "healthcare",
      name: "Marketplace cover",
      owner: "joint",
      amount: { value: 1_500, basis: "real" },
      frequency: "monthly",
      range: { start: { kind: "planStart" }, end: { kind: "milestone", milestoneId: "ms-retire" } },
      healthcare: { kind: "aca", benchmarkPremium: { value: 1_300 }, householdSize },
    },
  ];
  return doc;
}

const acaSizeOf = (plan: { expenses: unknown[] }) => {
  const e = plan.expenses.find((x) => (x as Json).id === "exp-aca") as Json;
  return (e.healthcare as Json).householdSize;
};

describe("schema 5 -> 6: ACA household size 'auto' and dependentAge dates", () => {
  it("is the current version", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
  });

  it("a stored ACA household size is kept as a manual override, and the engine uses it", () => {
    const doc = migrateDocument(v5UsDocument(5));
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    const main = doc.plans.find((p) => p.id === SAMPLE_PLAN_ID)!;
    expect(acaSizeOf(main)).toBe(5);
    const r = simulate(buildSimulationInput(doc, SAMPLE_PLAN_ID));
    const first = r.periods[0]!.taxes.facts;
    expect(first["us.acaHouseholdSize"]).toBe(5);
    expect(first["us.acaHouseholdSizeAuto"]).toBe(0);
  });

  it("migration leaves the rest of a v5 document exactly as stored", () => {
    const raw = v5UsDocument(3);
    const migrated = migrateDocument(structuredClone(raw));
    const reparsed = migrateDocument({ ...structuredClone(raw), schemaVersion: SCHEMA_VERSION });
    expect(migrated).toEqual(reparsed);
  });

  it("migratePlan keeps a stored v5 plan body's household size", () => {
    const raw = v5UsDocument(4);
    const body = (raw.plans as Json[]).find((p) => p.id === SAMPLE_PLAN_ID)!;
    expect(acaSizeOf(migratePlan(structuredClone(body), 5))).toBe(4);
  });

  it("a v6 document may use 'auto' and dependentAge; a newer one is refused", () => {
    const doc = v5UsDocument(3);
    doc.schemaVersion = 6;
    const main = (doc.plans as Json[]).find((p) => p.id === SAMPLE_PLAN_ID)!;
    const aca = (main.expenses as Json[]).find((e) => e.id === "exp-aca")!;
    (aca.healthcare as Json).householdSize = "auto";
    main.expenses = [
      ...(main.expenses as Json[]),
      {
        id: "exp-robin-college",
        type: "education",
        name: "Robin's college",
        owner: "joint",
        dependentId: "dep-robin",
        amount: { value: 20_000, basis: "real" },
        frequency: "yearly",
        range: {
          start: { kind: "dependentAge", dependentId: "dep-robin", age: 18 },
          end: { kind: "dependentAge", dependentId: "dep-robin", age: 22 },
        },
      },
    ];
    const loaded = migrateDocument(structuredClone(doc));
    const plan = loaded.plans.find((p) => p.id === SAMPLE_PLAN_ID)!;
    expect(acaSizeOf(plan)).toBe("auto");
    const r = simulate(buildSimulationInput(loaded, SAMPLE_PLAN_ID));
    // Robin (born 2017-05) is 18 from 2035-05 to 2039-05: four years of fees.
    const years = r.periods
      .filter((p) => p.expenses.some((e) => e.sourceId === "exp-robin-college" && e.requested > 0))
      .map((p) => p.year);
    expect(years[0]).toBe(2035);
    expect(years.at(-1)).toBeLessThanOrEqual(2039);
    expect(() => migrateDocument({ ...doc, schemaVersion: SCHEMA_VERSION + 1 })).toThrow(
      /newer than supported/,
    );
  });
});
