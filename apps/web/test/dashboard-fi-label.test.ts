import { createSampleDocument } from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import { fiTargetLabel } from "../src/features/dashboard/dashboard-view";

describe("fiTargetLabel", () => {
  it("names the multiple the sample's FI milestone asks for", () => {
    const plan = createSampleDocument().plans.find((p) => p.isMain);
    expect(fiTargetLabel(plan)).toBe("25× spending");
  });

  it("is null without a multiple-of-spending FI milestone", () => {
    const plan = createSampleDocument().plans.find((p) => p.isMain)!;
    expect(fiTargetLabel({ ...plan, milestones: [] })).toBeNull();
    expect(fiTargetLabel(undefined)).toBeNull();
  });
});
