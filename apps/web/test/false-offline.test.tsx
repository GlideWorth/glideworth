/**
 * A new workspace has no household yet, so the app shows the bundled sample. That is not an outage:
 * the server answered. Import must be applicable (it creates the plan), and settings must not say
 * the server is offline while that answer is still on its way. A failed request still is offline.
 */
import { createUkSampleDocument } from "@glideworth/core/samples";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingSection } from "../src/features/cloud/settings/billing-section";
import { fmtDateTime } from "../src/features/cloud/format";
import { createStarterDocument } from "../src/features/import/starter";
import { createAppRouter } from "../src/router";
import { useUi } from "../src/stores/ui";
import { apiError, json, renderWithClient, signedIn } from "./cloud-helpers";

const CLOUD_SIGNED_IN = {
  mode: "cloud",
  authenticated: true,
  user: { id: "u1", email: "ada@example.com", name: "Ada", role: "owner", totp: false },
  workspace: {
    id: "acc_1",
    name: "Home",
    role: "owner",
    access: { level: "full", reason: "trial", changesAt: null },
    trialEndsAt: "2026-12-02T22:08:00.000Z",
  },
  workspaces: [{ id: "acc_1", name: "Home", role: "owner", access: null }],
};

const MONARCH = `Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags
2026-10-01,Employer Inc,Paycheck,Checking,PAYROLL,,5000.00,
2026-10-03,Landlord,Rent,Checking,RENT OCT,,-1800.00,
2026-10-05,Grocery Mart,Groceries,Credit Card,GROCERY MART,,-123.45,
2026-10-12,Coffee Spot,Restaurants,Credit Card,COFFEE,,-4.50,
2026-11-01,Employer Inc,Paycheck,Checking,PAYROLL,,5000.00,
2026-11-03,Landlord,Rent,Checking,RENT NOV,,-1800.00,
`;

const IMPORTED = {
  format: "glideworth",
  dryRun: false,
  imported: true,
  householdId: "hh-main",
  issues: [],
  stats: {},
};

type Route = (body: unknown) => Response | Promise<Response>;

function stubFetch(routes: Record<string, Route> = {}) {
  const calls: { key: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ key, body });
      if (url.pathname === "/api/v1/auth/status") return json(CLOUD_SIGNED_IN);
      const r = routes[key];
      if (r) return r(body);
      return apiError(404, "NOT_FOUND", "not found");
    }),
  );
  return calls;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function open(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function chooseFile(name: string, text: string, type: string) {
  const input = document.querySelector("input[type=file]") as HTMLInputElement;
  const file = new File([text], name, { type });
  fireEvent.change(input, { target: { files: [file] } });
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
});

afterEach(() => {
  cleanup();
  useUi.getState().setNavOpen(false);
  vi.unstubAllGlobals();
});

describe("settings while the workspace is still loading", () => {
  it("does not say the server is offline or that there are no plans", async () => {
    const households = deferred<unknown>();
    const document = deferred<unknown>();
    stubFetch({
      "GET /api/v1/households": () => households.promise.then((body) => json(body)),
      "GET /api/v1/households/hh-main/document": () => document.promise.then((body) => json(body)),
    });
    await open("/settings/profile");
    expect(await screen.findByText("Loading your settings…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Loading plans" })).toBeTruthy();
    expect(screen.queryByText(/server is offline/i)).toBeNull();
    expect(screen.queryByText("No plans yet")).toBeNull();

    const saved = createStarterDocument({
      personName: "Ada",
      locale: "en-GB",
      now: new Date("2026-11-19T00:00:00Z"),
    });
    households.resolve({ items: [saved.household] });
    document.resolve(saved);
    expect(
      await screen.findByRole("button", { name: "Active plan: My plan. Change plan" }),
    ).toBeTruthy();
    expect(screen.getByText("Changes save as you make them.")).toBeTruthy();
    expect(screen.queryByText(/server is offline/i)).toBeNull();
  });
});

describe("billing dates", () => {
  it("waits for the household locale instead of the browser's", async () => {
    Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });
    const end = "2026-12-02T22:08:00.000Z";
    const us = fmtDateTime(end, "en-US");
    const gb = fmtDateTime(end, "en-GB");
    expect(us).not.toBe(gb);

    const saved = createStarterDocument({
      personName: "Ada",
      locale: "en-GB",
      now: new Date("2026-11-19T00:00:00Z"),
    });
    const document = deferred<unknown>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/v1/billing") {
          return json({
            status: "trialing_local",
            plan: null,
            lookupKey: null,
            interval: null,
            trialEndsAt: end,
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
            access: { level: "full", reason: "trial", changesAt: end },
            role: "owner",
            offered: [],
          });
        }
        if (url.pathname === "/api/v1/households") return json({ items: [saved.household] });
        if (url.pathname === "/api/v1/households/hh-main/document")
          return json(await document.promise);
        return apiError(404, "NOT_FOUND", url.pathname);
      }),
    );
    renderWithClient(<BillingSection />, signedIn("owner", { level: "full", reason: "trial" }));
    expect(await screen.findByText("Loading billing…")).toBeTruthy();
    expect(screen.queryByText(new RegExp(us.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeNull();
    expect(screen.queryByText(/Trial ends/)).toBeNull();

    document.resolve(saved);
    expect(await screen.findByText(`Trial ends ${gb}`)).toBeTruthy();
    expect(screen.queryByText(new RegExp(us.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeNull();
  });
});

describe("first import before a plan exists", () => {
  const noHousehold = { "GET /api/v1/households": () => json({ items: [] }) };

  it("applies a CSV by creating the plan, and does not save the sample", async () => {
    const calls = stubFetch({
      ...noHousehold,
      "POST /api/v1/import": () => json(IMPORTED),
    });
    await open("/import?tab=csv");
    await screen.findByText("What is in the file?");
    fireEvent.click(screen.getByRole("radio", { name: /Transactions/ }));
    await chooseFile("monarch-sample.csv", MONARCH, "text/csv");
    expect(await screen.findByText(/Applying this import creates your plan/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/not reachable|server is offline/i);
    const apply = await screen.findByRole("button", { name: "Apply import" });
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(apply);
    await screen.findByText("CSV imported");
    const posted = calls.find((c) => c.key === "POST /api/v1/import")?.body as {
      mode: string;
      data: {
        plans: { name: string; expenses: unknown[] }[];
        household: { people: { name: string }[] };
      };
    };
    expect(posted.mode).toBe("create");
    expect(posted.data.plans[0]?.name).toBe("My plan");
    expect(posted.data.plans[0]?.expenses.length).toBeGreaterThan(0);
    expect(posted.data.household.people.map((p) => p.name)).not.toContain("Avery");
  });

  it("still refuses to apply when the server cannot be reached", async () => {
    stubFetch({
      "GET /api/v1/households": () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await open("/import?tab=csv");
    await screen.findByText("What is in the file?");
    await chooseFile("balances.csv", "Name,Balance\nCash,10\n", "text/csv");
    expect(await screen.findByText(/not reachable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply import" })).toHaveProperty("disabled", true);
  });
});

describe("starter household", () => {
  it("is a blank plan in the locale's country, not the bundled sample", () => {
    const doc = createStarterDocument({
      personName: "Ada",
      locale: "en-GB",
      now: new Date("2026-11-19T00:00:00Z"),
    });
    expect(doc.plans[0]?.name).toBe("My plan");
    expect(doc.household.currency).toBe("GBP");
    expect(doc.household.locale).toBe("en-GB");
    expect(doc.household.people.map((p) => p.name)).toEqual(["Ada"]);
    expect(doc.finances.accounts).toEqual([]);
    expect(doc.plans[0]?.expenses).toEqual([]);
    // The sample is a different household; this one must not borrow it.
    expect(createUkSampleDocument().household.id).not.toBe(doc.household.id);
  });
});
