import { describe, expect, it } from "vitest";
import {
  AccountBehaviourPatch,
  DebtBehaviourPatch,
  migrateDocument,
  migratePlan,
  Plan,
  RealAssetBehaviourPatch,
  SCHEMA_VERSION,
  successRateBand,
} from "../src/index.js";

describe("behaviour patches are sparse", () => {
  it("a one-key account override parses to exactly that key", () => {
    expect(AccountBehaviourPatch.parse({ liquid: "never" })).toEqual({ liquid: "never" });
    expect(AccountBehaviourPatch.parse({})).toEqual({});
  });
  it("real asset and debt patches keep only the keys given", () => {
    expect(RealAssetBehaviourPatch.parse({ liquidateIfNeeded: true })).toEqual({
      liquidateIfNeeded: true,
    });
    expect(DebtBehaviourPatch.parse({ interestTaxDeductible: true })).toEqual({
      interestTaxDeductible: true,
    });
  });
  it("plan settings records stay sparse after a full plan parse", () => {
    const plan = Plan.parse({
      id: "p",
      householdId: "h",
      name: "P",
      accountSettings: { a: { liquid: "never" } },
      realAssetSettings: { r: { usage: "investment" } },
      debtSettings: { d: { interestTaxDeductible: true } },
    });
    expect(plan.accountSettings.a).toEqual({ liquid: "never" });
    expect(plan.realAssetSettings.r).toEqual({ usage: "investment" });
    expect(plan.debtSettings.d).toEqual({ interestTaxDeductible: true });
  });
  it("still validates the values it is given", () => {
    expect(AccountBehaviourPatch.safeParse({ liquid: "sometimes" }).success).toBe(false);
  });
});

describe("migrations", () => {
  it("migratePlan validates a current plan body", () => {
    const p = migratePlan({ id: "p", householdId: "h", name: "P" });
    expect(p.flows).toEqual([]);
    expect(() => migratePlan({ id: "p" })).toThrow(/invalid plan/);
    expect(() => migratePlan({ id: "p", householdId: "h", name: "P" }, SCHEMA_VERSION + 1)).toThrow(
      /newer/,
    );
  });
  it("migrateDocument still rejects unversioned documents", () => {
    expect(() => migrateDocument({ app: "glideworth" })).toThrow(/no migration/);
  });
});

describe("success-rate bands", () => {
  it("picks the highest band at or below the rate", () => {
    const s = {
      successRateBands: [
        { name: "Good", minRate: 0.75 },
        { name: "Excellent", minRate: 0.9 },
        { name: "Poor", minRate: 0 },
      ],
    };
    expect(successRateBand(s, 0.93)?.name).toBe("Excellent");
    expect(successRateBand(s, 0.8)?.name).toBe("Good");
    expect(successRateBand(s, 0.1)?.name).toBe("Poor");
    expect(successRateBand({}, 0.5)).toBeNull();
  });
});
