/**
 * The four papercuts in issue #99: one age per calendar year, no empty-state flash while a
 * projection is still loading, and the demo chance page reusing the dashboard's run.
 */
import { periodAge, type MonteCarloResult } from "@glideworth/core";
import { createSampleDocument } from "@glideworth/core/samples";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showDemoRunLoading, showNoRunYet } from "../src/features/chance/chance-display";
import { useMcStore } from "../src/features/chance/mc-store";
import {
  readDemoChance,
  useRememberedChance,
  writeDemoChance,
} from "../src/features/demo/demo-chance";
import {
  editEntity,
  type HouseholdEntity,
  loadDocument,
  resetEditorStore,
} from "../src/features/plan-editor/state/doc-store";
import { monthIndex, timelineYearAge } from "../src/features/plan-editor/state/finance-math";
import { awaitingProjection } from "../src/features/results/use-active-projection";
import { setDemoModeForTests } from "../src/lib/demo";

const BIRTH = "1994-11";
/** A plan that covers the QA household's working years in full calendar years. */
const FULL = { start: 2026 * 12, end: 2060 * 12 };

describe("timeline ages match the results table", () => {
  it("labels a year with the age reached in it, not the birthday that sits on the previous tick", () => {
    // Born November 1994. The timeline used to draw "35" at November 2029, which sits on the
    // 2030 year tick, while results (and "32 this year" on Current finances) say 36 for 2030.
    expect(timelineYearAge(BIRTH, 2029, FULL)).toBe(35);
    expect(timelineYearAge(BIRTH, 2030, FULL)).toBe(36);
    expect(timelineYearAge(BIRTH, 2035, FULL)).toBe(41);
    expect(timelineYearAge(BIRTH, 2050, FULL)).toBe(56);
    expect(timelineYearAge(BIRTH, 2055, FULL)).toBe(61);
    for (const year of [2029, 2030, 2035, 2050, 2055]) {
      const start = year * 12;
      const atStart = (start - monthIndex(BIRTH)) / 12;
      expect(timelineYearAge(BIRTH, year, FULL)).toBe(
        periodAge({ ages: { p: atStart }, months: 12 }, "p"),
      );
    }
  });

  it("matches a partial year that ends before the birthday", () => {
    const start = 2030 * 12;
    const end = start + 3;
    const atStart = (start - monthIndex(BIRTH)) / 12;
    expect(timelineYearAge(BIRTH, 2030, { start, end })).toBe(35);
    expect(timelineYearAge(BIRTH, 2030, { start, end })).toBe(
      periodAge({ ages: { p: atStart }, months: 3 }, "p"),
    );
  });
});

describe("results stays in a loading state until there is really no plan", () => {
  const pending = {
    workspacePending: true,
    hasPlan: false,
    projectionPending: true,
    hasResult: false,
  };

  it("waits while the household is still loading", () => {
    expect(awaitingProjection(pending)).toBe(true);
  });

  it("waits while the plan is known and the projection has not arrived", () => {
    expect(awaitingProjection({ ...pending, workspacePending: false, hasPlan: true })).toBe(true);
  });

  it("is the empty state only once the workspace has loaded without a plan", () => {
    expect(awaitingProjection({ ...pending, workspacePending: false })).toBe(false);
  });

  it("stops waiting when the projection is on screen", () => {
    expect(
      awaitingProjection({
        workspacePending: false,
        hasPlan: true,
        projectionPending: false,
        hasResult: true,
      }),
    ).toBe(false);
  });
});

describe("the demo chance page does not contradict the dashboard", () => {
  const idle = {
    hasResult: false,
    status: "idle" as const,
    projectionLoading: false,
    demo: true,
    demoPhase: undefined,
  };

  it("shows a loading state instead of 'No run yet' while the demo run is outstanding", () => {
    expect(showNoRunYet(idle)).toBe(false);
    expect(showDemoRunLoading(idle)).toBe(true);
    expect(showNoRunYet({ ...idle, demoPhase: "running" })).toBe(false);
  });

  it("shows the result, and offers Run now only when the demo run cannot", () => {
    expect(showNoRunYet({ ...idle, hasResult: true })).toBe(false);
    expect(showDemoRunLoading({ ...idle, hasResult: true })).toBe(false);
    expect(showNoRunYet({ ...idle, demoPhase: "failed" })).toBe(true);
    expect(showNoRunYet({ ...idle, demoPhase: "unavailable" })).toBe(true);
    expect(showNoRunYet({ ...idle, demo: false })).toBe(true);
    expect(showNoRunYet({ ...idle, demo: false, projectionLoading: true })).toBe(false);
  });
});

const remembered = {
  planId: "plan-main",
  planVersion: 4,
  at: 10,
  result: { successRate: 0.88, trials: 1000 } as MonteCarloResult,
};

function RememberedProbe({ version }: { version: number }) {
  const run = useRememberedChance({ id: "plan-main", version });
  return <div>{run ? String(run.result.trials) : "none"}</div>;
}

describe("a saved demo run is reused for the same plan version", () => {
  beforeEach(() => {
    setDemoModeForTests(true);
    sessionStorage.clear();
    useMcStore.setState({ byPlan: {}, demoPhase: {} });
  });

  afterEach(() => {
    cleanup();
    setDemoModeForTests(false);
    sessionStorage.clear();
    useMcStore.setState({ byPlan: {}, demoPhase: {} });
  });

  it("round-trips the run and shows it before asking for another", () => {
    writeDemoChance(remembered);
    expect(readDemoChance()?.result.successRate).toBe(0.88);
    render(<RememberedProbe version={4} />);
    expect(screen.getByText("1000")).toBeTruthy();
    expect(
      showNoRunYet({
        hasResult: true,
        status: "idle",
        projectionLoading: false,
        demo: true,
        demoPhase: undefined,
      }),
    ).toBe(false);
  });

  it("ignores a run from a different plan version", () => {
    writeDemoChance(remembered);
    render(<RememberedProbe version={5} />);
    expect(screen.getByText("none")).toBeTruthy();
  });
});

describe("a workspace run survives a reload of this tab", () => {
  beforeEach(() => {
    setDemoModeForTests(false);
    sessionStorage.clear();
    useMcStore.setState({ byPlan: {}, demoPhase: {} });
    resetEditorStore();
    loadDocument(createSampleDocument(), "api");
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    useMcStore.setState({ byPlan: {}, demoPhase: {} });
    resetEditorStore();
  });

  const run = {
    result: remembered.result,
    planVersion: 4,
    example: false as const,
    at: 10,
  };

  it("restores the last run after the in-memory store is cleared", () => {
    useMcStore.getState().put("plan-main", run);
    useMcStore.setState({ byPlan: {}, demoPhase: {} });
    render(<RememberedProbe version={4} />);
    expect(screen.getByText("1000")).toBeTruthy();
  });

  it("does not restore a run saved for a different plan version", () => {
    useMcStore.getState().put("plan-main", run);
    useMcStore.setState({ byPlan: {}, demoPhase: {} });
    render(<RememberedProbe version={5} />);
    expect(screen.getByText("none")).toBeTruthy();
  });

  it("does not restore a run after the household it was computed from has changed", () => {
    useMcStore.getState().put("plan-main", run);
    useMcStore.setState({ byPlan: {}, demoPhase: {} });
    // A balance update changes the result and leaves the plan version alone.
    editEntity<HouseholdEntity>(
      "household",
      (h) => ({
        ...h,
        finances: {
          ...h.finances,
          accounts: h.finances.accounts.map((a, i) =>
            i === 0 ? { ...a, balance: a.balance + 5000 } : a,
          ),
        },
      }),
      "Update balance",
    );
    render(<RememberedProbe version={4} />);
    expect(screen.getByText("none")).toBeTruthy();
  });

  it("does not show one household's run to another household with the same plan id", () => {
    useMcStore.getState().put("plan-main", run);
    useMcStore.setState({ byPlan: {}, demoPhase: {} });
    const other = createSampleDocument();
    other.household.id = "hh-someone-else";
    resetEditorStore();
    loadDocument(other, "api");
    render(<RememberedProbe version={4} />);
    expect(screen.getByText("none")).toBeTruthy();
  });

  it("restores once the household has loaded, when the plan arrived first", () => {
    useMcStore.getState().put("plan-main", run);
    useMcStore.setState({ byPlan: {}, demoPhase: {} });
    const doc = createSampleDocument();
    resetEditorStore();
    render(<RememberedProbe version={4} />);
    expect(screen.getByText("none")).toBeTruthy();
    act(() => loadDocument(doc, "api"));
    expect(screen.getByText("1000")).toBeTruthy();
  });

  it("does not keep an example preview", () => {
    useMcStore.getState().put("plan-main", { ...run, example: true });
    useMcStore.setState({ byPlan: {}, demoPhase: {} });
    render(<RememberedProbe version={4} />);
    expect(screen.getByText("none")).toBeTruthy();
  });

  it("drops per-trial rows when session storage rejects the full result", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem");
    spy.mockImplementationOnce(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    try {
      useMcStore.getState().put("plan-main", {
        ...run,
        result: {
          ...remembered.result,
          trialSummaries: [{ t: 1 }] as unknown as MonteCarloResult["trialSummaries"],
        },
      });
      const saved = JSON.parse(
        sessionStorage.getItem("glideworth:chance:v2:hh-sample:plan-main") ?? "null",
      );
      expect(saved.result.successRate).toBe(0.88);
      expect(saved.result.trialSummaries).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
