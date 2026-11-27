import { describe, expect, it } from "vitest";
import { pluralDuration } from "../src/insights/format.js";

describe("pluralDuration", () => {
  it("pluralises months at 0, 1 and 2", () => {
    expect(pluralDuration(0, "month")).toBe("0 months");
    expect(pluralDuration(1, "month")).toBe("1 month");
    expect(pluralDuration(2, "month")).toBe("2 months");
  });

  it("pluralises years at 0, 1 and 2", () => {
    expect(pluralDuration(0, "year")).toBe("0 years");
    expect(pluralDuration(1, "year")).toBe("1 year");
    expect(pluralDuration(2, "year")).toBe("2 years");
  });

  it("keeps a negative count and still uses the singular for one", () => {
    expect(pluralDuration(-1, "month")).toBe("-1 month");
    expect(pluralDuration(-2, "year")).toBe("-2 years");
  });
});
