import { createSampleDocument } from "@glideworth/core/samples";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { describeDateRef } from "../src/components/ui/date-ref-picker";
import { Segmented } from "../src/components/ui/segmented";

function Harness() {
  const [v, setV] = useState<"real" | "nominal">("real");
  return (
    <Segmented
      aria-label="Basis"
      value={v}
      onChange={setV}
      options={[
        { value: "real", label: "Today" },
        { value: "nominal", label: "Future" },
      ]}
    />
  );
}

describe("components", () => {
  it("describes date references in plain language", () => {
    const doc = createSampleDocument();
    const plan = doc.plans[0]!;
    expect(
      describeDateRef(
        { kind: "milestone", milestoneId: "ms-retire", offsetMonths: -6 },
        doc.household.people,
        plan.milestones,
      ),
    ).toBe("Retirement −6 mo");
    expect(
      describeDateRef(
        { kind: "age", personId: "p-avery", age: 67, offsetMonths: 0 },
        doc.household.people,
        plan.milestones,
      ),
    ).toBe("Avery age 67");
  });

  it("segmented control is an accessible radio group", () => {
    render(<Harness />);
    const future = screen.getByRole("radio", { name: "Future" });
    expect(future.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(future);
    expect(future.getAttribute("aria-checked")).toBe("true");
  });
});
