/**
 * Mode gating, end to end through the real router and app shell: a self-host server shows no cloud screen
 * and is never asked for a cloud endpoint; a cloud server shows the cloud screens and hides the self-host
 * passphrase and people screens.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPublicPath } from "../src/components/layout/app-shell";
import { CLOUD_SECTION_IDS, sectionsForMode } from "../src/features/settings/sections";
import { createAppRouter } from "../src/router";
import { apiError, json } from "./cloud-helpers";

const CLOUD_ENDPOINT =
  /^\/api\/v1\/(billing|workspace|workspaces|account)(\/|$)|^\/api\/v1\/auth\/(signup|signin|verify|reauth|password|resend-verification|signout)/;

const SELFHOST_STATUS = {
  setupRequired: false,
  authenticated: true,
  via: "session",
  user: { id: "owner", name: "Owner", role: "owner" },
};
const CLOUD_SIGNED_IN = {
  mode: "cloud",
  authenticated: true,
  user: { id: "u1", email: "ada@example.com", name: "Ada", role: "owner", totp: false },
  workspace: {
    id: "acc_1",
    name: "Home",
    role: "owner",
    access: { level: "full", reason: "active", changesAt: null },
    trialEndsAt: null,
  },
  workspaces: [{ id: "acc_1", name: "Home", role: "owner", access: null }],
};

function stubFetch(status: object | null, extra: Record<string, () => Response> = {}) {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      paths.push(url.pathname);
      const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
      if (url.pathname === "/api/v1/auth/status") return json(status);
      if (extra[key]) return extra[key]!();
      return apiError(404, "NOT_FOUND", "not found");
    }),
  );
  return paths;
}

let router: ReturnType<typeof createAppRouter>;
async function open(path: string) {
  router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
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
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("self-host (no `mode` in the status answer)", () => {
  it.each([
    "/signup",
    "/signin",
    "/check-email",
    "/verify-email",
    "/forgot-password",
    "/reset-password",
    "/invite",
    "/confirm-email",
    "/signin/2fa",
    "/settings/billing",
    "/settings/members",
    "/settings/account",
    "/settings/security",
    "/settings/workspace",
  ])("%s is not a page, and no cloud endpoint is requested", async (path) => {
    const paths = stubFetch(SELFHOST_STATUS);
    await open(path);
    expect(await screen.findByText("There is no page here")).toBeTruthy();
    expect(screen.queryByText("Create your account")).toBeNull();
    expect(screen.queryByText("Billing")).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(paths.filter((p) => CLOUD_ENDPOINT.test(p))).toEqual([]);
  });

  it("keeps its own settings: people and access, and the passphrase security group", async () => {
    const paths = stubFetch(SELFHOST_STATUS);
    await open("/settings/people");
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getByRole("link", { name: /People & access/ })).toBeTruthy();
    expect(within(nav).queryByRole("link", { name: /Billing|Members|Security/ })).toBeNull();
    expect(paths.filter((p) => CLOUD_ENDPOINT.test(p))).toEqual([]);
  });

  it("serves the passphrase invite page at /accept", async () => {
    stubFetch({ setupRequired: false, authenticated: false });
    await open("/accept?token=abc");
    expect(await screen.findByText("Choose your passphrase")).toBeTruthy();
  });

  it("lists no cloud section and treats cloud ids as unknown", () => {
    expect(sectionsForMode("selfhost").some((s) => CLOUD_SECTION_IDS.includes(s.id))).toBe(false);
    expect(isPublicPath("/signup", "selfhost")).toBe(false);
    expect(isPublicPath("/accept", "selfhost")).toBe(true);
  });
});

describe("cloud", () => {
  it("a signed-out visitor is sent to the sign-in page, which asks for email and password", async () => {
    stubFetch({ mode: "cloud", authenticated: false });
    await open("/plans");
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/signin");
    expect(router.state.location.search).toMatchObject({ next: "/plans" });
    expect(screen.queryByLabelText("Passphrase")).toBeNull();
  });

  it("sign-up is a public page in cloud mode", async () => {
    stubFetch({ mode: "cloud", authenticated: false });
    await open("/signup");
    expect(await screen.findByRole("heading", { name: "Create your account" })).toBeTruthy();
  });

  it("settings show Account, Security, Workspace, Members and Billing, and hide People & access", async () => {
    stubFetch(CLOUD_SIGNED_IN);
    await open("/settings/account");
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    for (const name of [/Account/, /Security/, /Workspace/, /Members/, /Billing/])
      expect(within(nav).getByRole("link", { name })).toBeTruthy();
    expect(within(nav).queryByRole("link", { name: /People & access/ })).toBeNull();
    expect(sectionsForMode("cloud").some((s) => s.id === "people")).toBe(false);
  });

  it("the passphrase security group is gone from Profile and the self-host /accept page is not found", async () => {
    stubFetch(CLOUD_SIGNED_IN);
    await open("/settings/profile");
    await screen.findByRole("heading", { name: "Profile & locale" });
    expect(screen.queryByText("Change passphrase")).toBeNull();
    cleanup();
    await open("/accept?token=abc");
    expect(await screen.findByText("There is no page here")).toBeTruthy();
  });

  it("API keys show the cloud key format", async () => {
    stubFetch(CLOUD_SIGNED_IN, { "GET /api/v1/keys": () => json({ items: [] }) });
    await open("/settings/keys");
    expect(await screen.findByText(/starts with gwk_/)).toBeTruthy();
  });

  it("a read-only workspace shows the banner and a Billing call to action for its owner", async () => {
    stubFetch({
      ...CLOUD_SIGNED_IN,
      workspace: {
        ...CLOUD_SIGNED_IN.workspace,
        access: { level: "read_only", reason: "trial_expired", changesAt: null },
      },
    });
    await open("/plans");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/free trial has ended/),
    );
    expect(screen.getByRole("link", { name: "Subscribe" })).toBeTruthy();
  });

  it("a suspended workspace shows the suspended page instead of the app", async () => {
    stubFetch({
      ...CLOUD_SIGNED_IN,
      workspace: {
        ...CLOUD_SIGNED_IN.workspace,
        access: { level: "suspended", reason: "suspended", changesAt: null },
      },
    });
    await open("/plans");
    expect(
      await screen.findByRole("heading", { name: "This workspace is suspended" }),
    ).toBeTruthy();
  });
});
