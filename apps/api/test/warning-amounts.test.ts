/**
 * Compact and full projection responses fill warning placeholders in the response's money basis,
 * so an API or MCP client never sees a raw number or a `{token}`.
 */
import type { ProjectionResult, SimWarning } from "@glideworth/core";
import { describe, expect, it } from "vitest";
import { presentedWarnings } from "../src/views.js";

const warning: SimWarning = {
  code: "SHORTFALL",
  severity: "error",
  message:
    "In 2085, £425,237 of expenses could not be funded: income and every account that could be drawn on were used up.",
  template:
    "In 2085, {shortfall} of expenses could not be funded: income and every account that could be drawn on were used up.",
  periodIndex: 0,
  refs: [],
  amounts: [{ token: "shortfall", nominal: 425_237.47, measure: "flow" }],
};

const result = {
  meta: { currency: "GBP" },
  periods: [{ priceIndex: 2, priceIndexStart: 2 }],
  warnings: [warning],
} as unknown as ProjectionResult;

describe("presentedWarnings", () => {
  it("formats today's money with a currency symbol and thousands separators", () => {
    const [shown] = presentedWarnings(result, "real", "en-GB");
    expect(shown!.message).toBe(
      "In 2085, £212,619 of expenses could not be funded: income and every account that could be drawn on were used up.",
    );
    expect(shown!.amounts).toEqual(warning.amounts);
  });

  it("formats future money when the view asks for nominal", () => {
    const [shown] = presentedWarnings(result, "nominal", "en-GB");
    expect(shown!.message).toContain("£425,237");
    expect(shown!.message).not.toContain("{shortfall}");
  });
});
