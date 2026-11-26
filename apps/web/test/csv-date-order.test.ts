import { describe, expect, it } from "vitest";
import { ambiguousDateOrderMessage } from "../src/features/import/csv-import";

describe("ambiguous CSV dates", () => {
  it("says which order the file is being read as, and asks the person to check", () => {
    expect(ambiguousDateOrderMessage("DD/MM/YYYY")).toContain("day first (DD/MM)");
    expect(ambiguousDateOrderMessage("MM/DD/YYYY")).toContain("month first (MM/DD)");
    expect(ambiguousDateOrderMessage("DD/MM/YYYY")).toContain("Check the date order");
  });
});
