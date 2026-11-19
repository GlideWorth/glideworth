/**
 * The public demo at /demo: the real planner on the synthetic sample household, with no account and no
 * server. These tests pin the route, the isolation from real workspaces (no request reaches the server,
 * even for a visitor who is signed in, and nothing a real workspace stored is read), the account-only
 * pages, "Reset demo" and the two analytics events.
 */
import { createSampleDocument } from "@glideworth/core/samples";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDemoDocument } from "../src/features/demo/demo-data";
import { sectionsForMode } from "../src/features/settings/sections";
import {
  allowedInDemo,
  clearDemoStorage,
  DEMO_KEYS,
  demoFetch,
  DemoNetworkBlocked,
  isDemoPath,
  setDemoModeForTests,
} from "../src/lib/demo";
import { createAppRouter } from "../src/router";
import { useUi } from "../src/stores/ui";
import { json } from "./cloud-helpers";

const posthog = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("@posthog/react", async (original) => ({
  ...(await original<typeof import("@posthog/react")>()),
  usePostHog: () => posthog,
}));

/** A real workspace on the server: it must never appear in, or be requested by, the demo. */
const REAL_MARKER = "Real-Workspace-Person";
function realDocument() {
  const doc = createSampleDocument();
  doc.household.name = "Real household";
  doc.household.people[0]!.name = REAL_MARKER;
  return doc;
}

/** Answers like a signed-in hosted account with data, and records every request. */
function serverWithRealWorkspace() {
  const calls: string[] = [];
  const doc = realDocument();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`);
      if (url.pathname === "/api/v1/auth/status")
        return json({
          mode: "cloud",
          authenticated: true,
          user: { id: "u1", email: "real@example.com", name: REAL_MARKER, role: "owner" },
          workspace: { id: "acc_1", name: "Home", role: "owner", access: null },
          workspaces: [],
        });
      if (url.pathname === "/api/v1/households") return json({ items: [doc.household] });
      if (url.pathname.endsWith("/document")) return json(doc);
      return json({ items: [] });
    }),
  );
  return calls;
}

async function openDemo(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, qc };
}

beforeEach(() => {
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as never;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollTo ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
  localStorage.clear();
  sessionStorage.clear();
  posthog.capture.mockClear();
  setDemoModeForTests(true);
});

afterEach(() => {
  cleanup();
  setDemoModeForTests(false);
  useUi.getState().setNavOpen(false);
  vi.unstubAllGlobals();
});

describe("the /demo route", () => {
  it("matches /demo and paths under it, nothing else", () => {
    expect(isDemoPath("/demo")).toBe(true);
    expect(isDemoPath("/demo/")).toBe(true);
    expect(isDemoPath("/demo/results")).toBe(true);
    expect(isDemoPath("/demonstration")).toBe(false);
    expect(isDemoPath("/")).toBe(false);
    expect(isDemoPath("/plans/demo")).toBe(false);
  });

  it("opens the planner on the sample household, with the demo banner and a sign-up link", async () => {
    await openDemo("/demo");
    expect(await screen.findByText(/Good to see you, Avery/)).toBeTruthy();
    expect(screen.getByText("This is a demo with a sample household.")).toBeTruthy();
    const signUp = screen.getByRole("link", { name: "Start your free 14-day trial (no card)" });
    // Sign-up is outside the demo: a full page load to the hosted sign-up page.
    expect(signUp.getAttribute("href")).toBe("/signup");
    expect(screen.getByRole("button", { name: "Reset demo" })).toBeTruthy();
    // Not the offline fallback's badge: the banner says what this is.
    expect(screen.queryByText(/Sample data · offline/)).toBeNull();
  });

  it("keeps the app's links under /demo", async () => {
    const { router } = await openDemo("/demo/results");
    expect(router.state.location.pathname).toBe("/results");
    const plans = await screen.findAllByRole("link", { name: "Plans" });
    expect(plans.map((a) => a.getAttribute("href"))).toContain("/demo/plans");
    expect(plans.every((a) => a.getAttribute("href")?.startsWith("/demo/"))).toBe(true);
  });
});

describe("isolation from real workspaces", () => {
  it("sends no request to the server, even when the visitor is signed in with a real workspace", async () => {
    const calls = serverWithRealWorkspace();
    for (const path of [
      "/demo",
      "/demo/results",
      "/demo/plans",
      "/demo/settings",
      "/demo/finances",
    ]) {
      await openDemo(path);
      await screen.findByText("This is a demo with a sample household.");
      // Let queries, effects and lazy pages settle.
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByText(new RegExp(REAL_MARKER))).toBeNull();
      cleanup();
    }
    expect(calls).toEqual([]);
  });

  it("refuses the server's paths on a demo page, and allows build assets and the analytics relay", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const f = demoFetch(inner as unknown as typeof fetch);
    for (const blocked of [
      "/api/v1/households",
      "/api/v1/auth/status",
      "/api/v1/households/hh/document",
      "http://localhost:3000/api/v1/plans",
      "/mcp",
      "/health",
      "/docs",
      "/openapi.json",
      "/oauth/authorize",
      "/share/abc",
      "/signup",
      "//localhost:3000/api/v1/plans",
      "/assets/../api/v1/plans",
    ])
      await expect(f(blocked), blocked).rejects.toBeInstanceOf(DemoNetworkBlocked);
    await expect(f(new Request("http://localhost:3000/api/v1/me"))).rejects.toBeInstanceOf(
      DemoNetworkBlocked,
    );
    expect(inner).not.toHaveBeenCalled();
    await f("/assets/index-abc.js");
    await f("/relay/e/");
    await f("https://us.i.posthog.com/e/");
    expect(inner).toHaveBeenCalledTimes(3);
    expect(allowedInDemo("/assets/x.js")).toBe(true);
    expect(allowedInDemo("/api/v1/plans")).toBe(false);
  });

  it("reads only its own copy: never the offline sample or anything a real workspace stored", async () => {
    const offline = createSampleDocument();
    offline.household.people[0]!.name = "Offline-Copy";
    localStorage.setItem("glideworth:sample-doc:v1", JSON.stringify(offline));
    localStorage.setItem("glideworth:drafts:v1:hh-sample", JSON.stringify({ plans: {} }));
    expect(loadDemoDocument().household.people[0]!.name).toBe("Avery");

    const edited = createSampleDocument();
    edited.household.people[0]!.name = "Morgan";
    localStorage.setItem(DEMO_KEYS.doc, JSON.stringify(edited));
    expect(loadDemoDocument().household.people[0]!.name).toBe("Morgan");
    await openDemo("/demo");
    expect(await screen.findByText(/Good to see you, Morgan/)).toBeTruthy();

    // A corrupt copy falls back to the sample instead of breaking the demo.
    localStorage.setItem(DEMO_KEYS.doc, "{not json");
    expect(loadDemoDocument().household.people[0]!.name).toBe("Avery");
  });

  it("Reset demo forgets only the demo's own keys", () => {
    localStorage.setItem(DEMO_KEYS.doc, "{}");
    localStorage.setItem(DEMO_KEYS.settings, "{}");
    localStorage.setItem("glideworth:sample-doc:v1", "{}");
    localStorage.setItem("glideworth:settings:v1", "{}");
    localStorage.setItem("glideworth-ui", "{}");
    clearDemoStorage();
    expect(localStorage.getItem(DEMO_KEYS.doc)).toBeNull();
    expect(localStorage.getItem(DEMO_KEYS.settings)).toBeNull();
    expect(localStorage.getItem("glideworth:sample-doc:v1")).toBe("{}");
    expect(localStorage.getItem("glideworth:settings:v1")).toBe("{}");
    expect(localStorage.getItem("glideworth-ui")).toBe("{}");
  });
});

describe("account-only features", () => {
  it("lists only the settings that live in this browser", () => {
    expect(sectionsForMode("selfhost").map((s) => s.id)).toEqual([
      "profile",
      "appearance",
      "planning",
    ]);
    expect(sectionsForMode("cloud").map((s) => s.id)).toEqual([
      "profile",
      "appearance",
      "planning",
    ]);
    setDemoModeForTests(false);
    expect(sectionsForMode("cloud").map((s) => s.id)).toContain("billing");
    expect(sectionsForMode("selfhost").map((s) => s.id)).toContain("keys");
  });

  it("shows API keys, billing and the data section as not found", async () => {
    for (const section of ["keys", "billing", "data", "webhooks", "people"]) {
      await openDemo(`/demo/settings/${section}`);
      expect(await screen.findByText("This is a demo with a sample household.")).toBeTruthy();
      expect(await screen.findByText(/^404/)).toBeTruthy();
      cleanup();
    }
  });

  it("offers sign-up instead of import, onboarding and shared plans", async () => {
    await openDemo("/demo/import");
    expect(
      await screen.findByRole("heading", { name: "Import and export are part of your account" }),
    ).toBeTruthy();
    cleanup();
    await openDemo("/demo/welcome");
    expect(
      await screen.findByRole("heading", {
        name: "Setting up your own household is part of your account",
      }),
    ).toBeTruthy();
    cleanup();
    await openDemo("/demo/share/some-token");
    expect(
      await screen.findByRole("heading", { name: "Shared plans open outside the demo" }),
    ).toBeTruthy();
  });

  it("offers sign-up in place of share links", async () => {
    await openDemo("/demo/plans");
    const menu = await screen.findAllByRole("button", { name: /Actions for/ });
    fireEvent.pointerDown(menu[0]!, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Share/ }));
    expect(await screen.findByText("Share links are part of your account")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Start your free 14-day trial" }));
    expect(posthog.capture).toHaveBeenCalledWith("demo_signup_clicked", { placement: "share" });
  });
});

describe("analytics", () => {
  it("sends demo_started once per tab, and demo_signup_clicked from the banner", async () => {
    await openDemo("/demo/results");
    await screen.findByText("This is a demo with a sample household.");
    await waitFor(() =>
      expect(posthog.capture).toHaveBeenCalledWith("demo_started", {
        entry_path: "/results",
        has_saved_edits: false,
      }),
    );
    cleanup();
    await openDemo("/demo");
    await screen.findByText("This is a demo with a sample household.");
    expect(posthog.capture.mock.calls.filter(([e]) => e === "demo_started")).toHaveLength(1);

    fireEvent.click(screen.getByRole("link", { name: "Start your free 14-day trial (no card)" }));
    expect(posthog.capture).toHaveBeenCalledWith("demo_signup_clicked", { placement: "banner" });
  });
});

describe("outside the demo", () => {
  it("leaves the app as it was: no banner, the server is asked as usual", async () => {
    setDemoModeForTests(false);
    const calls = serverWithRealWorkspace();
    const router = createAppRouter(createMemoryHistory({ initialEntries: ["/"] }));
    await router.load();
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(calls).toContain("GET /api/v1/auth/status"));
    expect(screen.queryByText("This is a demo with a sample household.")).toBeNull();
  });
});
