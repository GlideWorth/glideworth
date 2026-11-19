/**
 * Signed-in calculator hand-off (issue #57). The marketing calculators link to
 * `/signup?from=tool&…`. A person who already has an account is sent to the dashboard; the inputs
 * must still be offered there, and the existing plan must not be changed.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalculatorHandoffBanner } from "../src/features/cloud/handoff-notice";
import {
  clearHandoff,
  parseHandoff,
  readHandoff,
  stashHandoff,
} from "../src/features/cloud/handoff";
import type { SessionState } from "../src/lib/auth";
import type { Workspace } from "../src/lib/workspace";
import { mockFetch, signedIn } from "./cloud-helpers";

vi.mock("@tanstack/react-router", async (importOriginal) =>
  (await import("./cloud-helpers")).routerMock(importOriginal as never),
);

const FIRE =
  "?from=tool&tool=fire&age=30&spend=40000&wr=4&balance=50000&save=20000&ret=5&tax=0&hy=30&stocks=60&timing=mid&cur=USD&v=1";

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    source: "api",
    doc: { plans: [], household: { people: [] } },
    ...over,
  } as Workspace;
}

/** Household data is in the cache before the banner mounts, the way the dashboard already has it. */
function renderBanner(session: SessionState = signedIn(), ws: Workspace | null = workspace()) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false },
    },
  });
  qc.setQueryData(["session"], session);
  if (ws) qc.setQueryData(["workspace"], ws);
  return render(
    <QueryClientProvider client={qc}>
      <CalculatorHandoffBanner />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  clearHandoff();
  mockFetch({});
});
afterEach(() => {
  cleanup();
  clearHandoff();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("signed-in calculator hand-off", () => {
  it("offers the FIRE inputs on the dashboard and does not touch the current plan", () => {
    stashHandoff(parseHandoff(FIRE)!);
    const api = mockFetch({});
    renderBanner();
    const offer = screen.getByRole("region", { name: "Calculator inputs" });
    expect(offer.textContent).toMatch(/FIRE calculator/);
    expect(offer.textContent).toMatch(/age 30/);
    expect(offer.textContent).toMatch(/\$40,000/);
    expect(offer.textContent).toMatch(/\$50,000/);
    expect(offer.textContent).toMatch(/USD/);
    expect(offer.textContent).toMatch(/unchanged/);
    expect(offer.textContent).toMatch(/Nothing is replaced until you finish and confirm/);
    const start = screen.getByRole("link", { name: /Start a new plan/ });
    expect(start.getAttribute("href")).toBe("/welcome/setup");
    // Opening setup is a navigation, not a write. The stored inputs stay until setup finishes.
    fireEvent.click(start);
    expect(readHandoff()?.values).toMatchObject({
      age: "30",
      spend: "40000",
      balance: "50000",
      cur: "USD",
    });
    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("drops the offer when the person keeps their current plan", () => {
    stashHandoff(parseHandoff(FIRE)!);
    renderBanner();
    fireEvent.click(screen.getByRole("button", { name: "Keep my current plan" }));
    expect(readHandoff()).toBeNull();
    expect(screen.queryByRole("region", { name: "Calculator inputs" })).toBeNull();
  });

  it("stays quiet for a new account, and tells a viewer the inputs were not applied", () => {
    stashHandoff(parseHandoff("?from=tool&tool=coast-fire&v=1&cur=USD&age=35&balance=150000")!);
    renderBanner(signedIn(), workspace({ firstRun: true, source: "sample" }));
    expect(screen.queryByRole("region", { name: "Calculator inputs" })).toBeNull();

    cleanup();
    stashHandoff(parseHandoff(FIRE)!);
    renderBanner(signedIn("viewer"));
    expect(screen.getByRole("region", { name: "Calculator inputs" }).textContent).toMatch(
      /not applied/,
    );
    expect(screen.queryByRole("link", { name: /Start a new plan/ })).toBeNull();
  });

  it("shows nothing when no calculator inputs were kept", () => {
    renderBanner();
    expect(screen.queryByRole("region", { name: "Calculator inputs" })).toBeNull();
  });

  it("reads a hand-off that is still on the dashboard URL", () => {
    window.history.replaceState(null, "", `/${FIRE}`);
    renderBanner();
    expect(screen.getByRole("region", { name: "Calculator inputs" }).textContent).toMatch(
      /\$40,000/,
    );
    expect(readHandoff()?.values.balance).toBe("50000");
    // Kept in this browser, then taken off the address bar so a later visit does not bring it back.
    expect(window.location.search).toBe("");
  });
});
