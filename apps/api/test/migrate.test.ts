/** Stored plan bodies are read through core's `migratePlan`, with the schema version they were written at. */
import { SCHEMA_VERSION } from "@glideworth/core";
import { createSampleDocument } from "@glideworth/core/samples";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { plans } from "../src/db/schema.js";

const migratePlan = vi.hoisted(() => vi.fn());
vi.mock("@glideworth/core", async (original) => {
  const real = await original<typeof import("@glideworth/core")>();
  migratePlan.mockImplementation(real.migratePlan);
  return { ...real, migratePlan };
});

describe("plan migration on read", () => {
  it("every plan read from the database goes through migratePlan with its stored schema version", async () => {
    const { setup } = await import("./helpers.js");
    const h = setup();
    migratePlan.mockClear();
    const plan = h.services.plans.get("plan-main");
    expect(plan.id).toBe("plan-main");
    expect(migratePlan).toHaveBeenCalledTimes(1);
    expect(migratePlan.mock.calls[0]![1]).toBe(SCHEMA_VERSION);
    migratePlan.mockClear();
    h.services.plans.list({ householdId: "hh-sample" });
    expect(migratePlan).toHaveBeenCalledTimes(2);
    h.services.plans.versionBody("plan-main", 1);
    expect(migratePlan).toHaveBeenCalledTimes(3);
    h.close();
  });

  it("a migration that rewrites the body is applied before the plan is parsed", async () => {
    const { readPlanBody } = await import("../src/services/migrate.js");
    const plan = createSampleDocument().plans[0]!;
    migratePlan.mockImplementationOnce((raw: unknown) => ({
      ...(raw as object),
      name: "migrated by core",
    }));
    expect(readPlanBody(JSON.parse(JSON.stringify(plan)), 1).name).toBe("migrated by core");
  });

  it("a plan stored at schema version 1 with a move (residency, relocate effect) loads, simulates and is rewritten at the current version", async () => {
    const { setup } = await import("./helpers.js");
    const h = setup();
    const where = eq(plans.id, "plan-main");
    const row = h.services.db.select().from(plans).where(where).get()!;
    // oxlint-disable-next-line typescript/no-explicit-any -- a stored body as raw JSON
    const body = row.body as Record<string, any>;
    const [first, ...rest] = body.milestones;
    const relocate = { kind: "relocate", location: { country: "AE" } };
    const v1 = {
      ...body,
      residency: [
        { id: "res-1", from: { kind: "date", date: "2031-01" }, location: { country: "AE" } },
      ],
      milestones: [{ ...first, effects: [...(first.effects ?? []), relocate] }, ...rest],
    };
    h.services.db.update(plans).set({ schemaVersion: 1, body: v1 }).where(where).run();

    const got = await h.call("/api/v1/plans/plan-main");
    expect(got.status).toBe(200);
    expect(got.json.residency).toBeUndefined();
    expect(got.json.milestones[0].effects).toEqual(first.effects ?? []);
    expect(
      (await h.call("/api/v1/plans/plan-main/simulate", { method: "POST", body: {} })).status,
    ).toBe(200);

    const renamed = await h.call("/api/v1/plans/plan-main", {
      method: "PATCH",
      body: [{ op: "replace", path: "/name", value: "Renamed" }],
    });
    expect(renamed.status).toBe(200);
    const stored = h.services.db.select().from(plans).where(where).get()!;
    expect(stored.schemaVersion).toBe(SCHEMA_VERSION);
    expect(stored.body).not.toHaveProperty("residency");
    h.close();
  });
});
