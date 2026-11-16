/** Stored plan bodies are read through core's `migratePlan`, with the schema version they were written at. */
import { createSampleDocument } from "@glideworth/core/samples";
import { describe, expect, it, vi } from "vitest";

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
    expect(migratePlan.mock.calls[0]![1]).toBe(1);
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
});
