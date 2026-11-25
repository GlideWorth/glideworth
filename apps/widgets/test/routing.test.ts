import { describe, expect, it } from "vitest";
import {
  answerSpending,
  compareTemplate,
  errorResult,
  outcomeMonteCarlo,
  pending,
  resultOf,
  reviewProposed,
  taxView,
  yearView,
} from "../src/fixtures";
import { createFormatter } from "../src/format";
import { errorFrom, payloadFrom, routeToolResult } from "../src/routing";
import { WIDGET_META_KEY } from "../src/types";

describe("routing", () => {
  it.each([
    outcomeMonteCarlo,
    pending,
    compareTemplate,
    answerSpending,
    reviewProposed,
    yearView,
    taxView,
  ])("routes a $view payload from _meta", (payload) => {
    const routed = routeToolResult(resultOf(payload));
    expect(routed).toEqual({ kind: "payload", payload });
  });

  it("uses the same meta key as the server contract", () => {
    expect(WIDGET_META_KEY).toBe("glideworth/widget");
  });

  it("ignores payloads with an unknown view or no plan", () => {
    expect(payloadFrom({ _meta: { [WIDGET_META_KEY]: { view: "chart", plan: {} } } })).toBeNull();
    expect(payloadFrom({ _meta: { [WIDGET_META_KEY]: { view: "outcome" } } })).toBeNull();
    expect(routeToolResult({ content: [{ type: "text", text: "{}" }] })).toEqual({
      kind: "empty",
      reason: "none",
    });
  });

  it("reads the error message from an isError result", () => {
    const result = errorResult("NOT_FOUND", "plan plan_x not found", "Call list_plans.");
    expect(routeToolResult(result)).toEqual({ kind: "error", message: "Plan plan_x not found" });
    expect(errorFrom(result)).toMatchObject({ code: "NOT_FOUND", hint: "Call list_plans." });
  });

  it("is empty while waiting and when cancelled", () => {
    expect(routeToolResult(null)).toEqual({ kind: "empty", reason: "waiting" });
    expect(routeToolResult(null, { cancelled: true })).toEqual({
      kind: "empty",
      reason: "cancelled",
    });
  });
});

describe("format", () => {
  it("formats money in the plan currency and host locale", () => {
    const us = createFormatter("en-US", "USD");
    expect(us.money(1234567.4)).toBe("$1,234,567");
    expect(us.compact(1_240_000)).toBe("$1.2M");
    expect(us.percent(0.873, 0)).toBe("87%");
    expect(us.year(2041)).toBe("2041");
    expect(us.month("2034-06")).toBe("Jun 2034");
    expect(us.signedMoney(-8000)).toBe("−$8,000");
    const gb = createFormatter("en-GB", "GBP");
    expect(gb.money(5000)).toBe("£5,000");
  });

  it("falls back on an unknown locale or currency", () => {
    expect(createFormatter("not a locale", "???").money(10)).toBe("$10");
  });
});
