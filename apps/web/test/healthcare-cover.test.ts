import { describe, expect, it } from "vitest";
import { usHealthcarePresentation } from "../src/features/plan-editor/sections/events";

describe("US healthcare fields", () => {
  it("hides ACA and Medicare on a standard expense outside the US", () => {
    expect(usHealthcarePresentation("GB", "standard")).toBe("hidden");
    expect(usHealthcarePresentation("CA", "standard")).toBe("hidden");
    expect(usHealthcarePresentation("US", "standard")).toBe("shown");
    expect(usHealthcarePresentation("US", "aca")).toBe("shown");
  });

  it("keeps an existing US cover editable, collapsed, outside the US", () => {
    expect(usHealthcarePresentation("GB", "aca")).toBe("collapsed");
    expect(usHealthcarePresentation("GB", "medicare")).toBe("collapsed");
  });
});
