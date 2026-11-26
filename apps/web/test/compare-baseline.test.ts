import { describe, expect, it } from "vitest";
import { defaultCompareIds } from "../src/features/compare/compare-model";

const plans = [{ id: "parent" }, { id: "other" }, { id: "branch", parentPlanId: "parent" }];

describe("compare opens with the parent as the baseline", () => {
  it("puts the parent first when the active plan is a branch", () => {
    // The branch is listed first, which used to make it the baseline.
    expect(
      defaultCompareIds([{ id: "branch", parentPlanId: "parent" }, { id: "parent" }], "branch", []),
    ).toEqual(["parent", "branch"]);
  });

  it("keeps the active plan as the baseline when it has no parent", () => {
    expect(defaultCompareIds(plans, "parent", [])).toEqual(["parent", "other"]);
  });

  it("keeps an explicit pair, such as a what-if sent from Insights", () => {
    expect(defaultCompareIds([...plans, { id: "whatif" }], "branch", ["branch", "whatif"])).toEqual(
      ["branch", "whatif"],
    );
  });
});
