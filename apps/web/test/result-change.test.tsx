/** "Why the numbers moved" in the dashboard's check-in card: what it shows for a split, nothing, and old check-ins. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ResultChangeView } from "../src/features/checkins/result-change";
import type { ResultChangeReport } from "../src/lib/api";

afterEach(cleanup);

const wrap = (node: ReactNode) =>
  render(createElement(QueryClientProvider, { client: new QueryClient() }, node));

const context = {
  planId: "plan-main",
  planName: "Main",
  currency: "USD",
  from: { checkInId: "chk_1", takenAt: "2026-10-01T00:00:00.000Z" },
  to: { checkInId: null, takenAt: "2026-11-26T00:00:00.000Z" },
};
const fp = { engineVersion: "0.7.0", taxTables: "a", marketData: "b" };
const parts = (d: Record<string, number>) =>
  (["glideworth", "time", "balances", "household", "plan"] as const).map((cause) => ({
    cause,
    label: {
      glideworth: "Changes on Glideworth's side (engine, tax tables, market history)",
      time: "The passage of time (a later start)",
      balances: "Updated balances (actual versus what the plan expected)",
      household: "Household details you changed",
      plan: "Plan edits you made",
    }[cause],
    delta: d[cause] ?? 0,
  }));

const split: ResultChangeReport = {
  ...context,
  available: true,
  noChange: false,
  order: ["glideworth", "time", "balances", "household", "plan"],
  method: "one at a time",
  fingerprints: { before: fp, after: null, now: fp },
  steps: [
    {
      cause: "plan",
      label: "Plan edits you made",
      changed: true,
      details: ["Living costs raised"],
    },
  ],
  metrics: [
    {
      metric: "successRate",
      label: "Chance of success",
      unit: "fraction",
      before: 0.82,
      after: 0.76,
      total: -0.06,
      parts: parts({ balances: -0.02, plan: -0.04 }),
      unexplained: 0,
    },
  ],
  summary: [],
  notes: [],
};

describe("ResultChangeView", () => {
  it("shows each cause with its own size and the order caveat", () => {
    wrap(createElement(ResultChangeView, { report: split }));
    expect(screen.getByText("Chance of success")).toBeTruthy();
    expect(screen.getByText("82% → 76%")).toBeTruthy();
    expect(screen.getByText("(−6 pts)")).toBeTruthy();
    expect(screen.getByText("Plan edits you made")).toBeTruthy();
    expect(screen.getByText("−4 pts")).toBeTruthy();
    expect(screen.getByText("−2 pts")).toBeTruthy();
    // Causes that moved nothing are left out.
    expect(screen.queryByText(/passage of time/)).toBeNull();
    expect(screen.getByText(/another order could split the same total differently/)).toBeTruthy();
    expect(screen.getByText(/not advice/)).toBeTruthy();
  });

  it("says so when nothing changed", () => {
    wrap(createElement(ResultChangeView, { report: { ...split, noChange: true } }));
    expect(screen.getByText(/^Nothing changed since the check-in/)).toBeTruthy();
    expect(screen.queryByText("Chance of success")).toBeNull();
  });

  it("an old check-in: the total and the reason the split is unavailable", () => {
    wrap(
      createElement(ResultChangeView, {
        report: {
          ...context,
          available: false,
          reason: "The split by cause is not available for check-ins taken before this version.",
          metrics: [
            {
              metric: "successRate",
              label: "Chance of success",
              unit: "fraction",
              before: 0.82,
              after: 0.76,
              total: -0.06,
            },
          ],
          summary: [],
          notes: [],
        },
      }),
    );
    expect(screen.getByText(/not available for check-ins taken before/)).toBeTruthy();
    expect(screen.getByText("(−6 pts)")).toBeTruthy();
    expect(screen.queryByText(/another order/)).toBeNull();
  });
});
