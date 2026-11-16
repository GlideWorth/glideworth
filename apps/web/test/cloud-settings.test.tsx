import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiProblemHost } from "../src/components/layout/api-problems-host";
import { ConfirmHost } from "../src/components/ui/confirm-dialog";
import { Toaster } from "../src/components/ui/toaster";
import { cloudApi } from "../src/features/cloud/client";
import { nav } from "../src/features/cloud/next";
import { ReauthHost } from "../src/features/cloud/reauth-dialog";
import { AccountSection } from "../src/features/cloud/settings/account-section";
import { BillingSection } from "../src/features/cloud/settings/billing-section";
import { MembersSection } from "../src/features/cloud/settings/members-section";
import { SecuritySection } from "../src/features/cloud/settings/security-section";
import { WorkspaceSection } from "../src/features/cloud/settings/workspace-section";
import { CloudBanners, SuspendedPage, WorkspaceSwitcher } from "../src/features/cloud/shell-parts";
import {
  apiError,
  mockFetch,
  navigateSpy,
  renderWithClient,
  signedIn,
  withCsrfCookie,
} from "./cloud-helpers";

vi.mock("@tanstack/react-router", async (importOriginal) =>
  (await import("./cloud-helpers")).routerMock(importOriginal as never),
);

const profile = (over: object = {}) => ({
  id: "u1",
  email: "ada@example.com",
  name: "Ada",
  twoFactorEnabled: false,
  signinAlerts: true,
  checkinEmails: true,
  ...over,
});
const isWrite = (c: { method: string }) => c.method !== "GET";

beforeEach(() => {
  navigateSpy.mockReset();
  withCsrfCookie("csrf-tok");
  vi.spyOn(nav, "go").mockImplementation(() => undefined);
  window.history.replaceState(null, "", "/settings/x");
  // Radix Select and dialogs lean on a few DOM methods jsdom lacks.
  Element.prototype.scrollIntoView ??= vi.fn();
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("security", () => {
  const sessionsRoute = {
    "GET /api/v1/account/sessions": {
      items: [
        {
          id: "aaaaaaaaaaaaaaaa",
          device: "Firefox on macOS",
          ip: "203.0.113.5",
          lastSeenAt: new Date().toISOString(),
          current: true,
        },
        {
          id: "bbbbbbbbbbbbbbbb",
          device: "Safari on iPhone",
          ip: "198.51.100.9",
          lastSeenAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
          current: false,
        },
      ],
    },
  };

  it("asks the person to confirm, then repeats the action the API refused (REAUTH_REQUIRED)", async () => {
    let begins = 0;
    const api = mockFetch({
      "GET /api/v1/account/profile": profile(),
      ...sessionsRoute,
      "POST /api/v1/account/totp/begin": () =>
        ++begins === 1
          ? apiError(403, "REAUTH_REQUIRED", "confirm your password to continue")
          : {
              secret: "JBSWY3DPEHPK3PXP",
              otpauthUri:
                "otpauth://totp/Glideworth:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Glideworth",
            },
      "POST /api/v1/auth/reauth": { status: "ok", csrfToken: "fresh" },
    });
    renderWithClient(
      <>
        <SecuritySection />
        <ReauthHost />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it is you" });
    const pw = within(dialog).getByLabelText("Password") as HTMLInputElement;
    expect(pw.autocomplete).toBe("current-password");
    fireEvent.change(pw, { target: { value: "my current password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    // The QR code is an inline SVG with a manual key beside it.
    expect(
      await screen.findByRole("img", { name: "QR code for your authenticator app" }),
    ).toBeTruthy();
    expect(screen.getByText("JBSW Y3DP EHPK 3PXP")).toBeTruthy();
    const order = api.calls.filter((c) => c.method === "POST").map((c) => c.path);
    expect(order).toEqual([
      "/api/v1/account/totp/begin",
      "/api/v1/auth/reauth",
      "/api/v1/account/totp/begin",
    ]);
    expect(api.last("POST /api/v1/auth/reauth")!.body).toEqual({ password: "my current password" });
  });

  it("sends the CSRF header on every write and never on a read", async () => {
    const api = mockFetch({
      "GET /api/v1/account/profile": profile({ twoFactorEnabled: true }),
      ...sessionsRoute,
      "DELETE /api/v1/account/sessions/bbbbbbbbbbbbbbbb": null,
      "POST /api/v1/account/sessions/revoke-others": { revoked: 1 },
    });
    renderWithClient(<SecuritySection />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out Safari on iPhone" }));
    await waitFor(() =>
      expect(api.last("DELETE /api/v1/account/sessions/bbbbbbbbbbbbbbbb")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Sign out all others/ }));
    await waitFor(() =>
      expect(api.last("POST /api/v1/account/sessions/revoke-others")).toBeTruthy(),
    );
    const writes = api.calls.filter(isWrite);
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes.every((c) => c.headers.get("x-csrf-token") === "csrf-tok")).toBe(true);
    expect(api.calls.filter((c) => !isWrite(c)).every((c) => !c.headers.has("x-csrf-token"))).toBe(
      true,
    );
  });

  it("lists browsers with device and last seen; this one cannot be signed out from here", async () => {
    mockFetch({ "GET /api/v1/account/profile": profile(), ...sessionsRoute });
    renderWithClient(<SecuritySection />);
    expect(await screen.findByText("Firefox on macOS")).toBeTruthy();
    expect(screen.getByText("This browser")).toBeTruthy();
    expect(screen.getByText(/Last active 3 days ago/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out Firefox on macOS" })).toBeNull();
  });

  it("shows the recovery codes once, with copy and download, and will not close until they are saved", async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `abcd${i}-efgh${i}`);
    const api = mockFetch({
      "GET /api/v1/account/profile": profile(),
      ...sessionsRoute,
      "POST /api/v1/account/totp/begin": {
        secret: "JBSWY3DPEHPK3PXP",
        otpauthUri: "otpauth://totp/G:a@b.co?secret=JBSWY3DPEHPK3PXP",
      },
      "POST /api/v1/account/totp/confirm": { recoveryCodes: codes },
    });
    renderWithClient(<SecuritySection />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    const enrol = await screen.findByRole("dialog", { name: "Turn on two-step sign-in" });
    const code = within(enrol).getByLabelText("6-digit code") as HTMLInputElement;
    expect(code.autocomplete).toBe("one-time-code");
    fireEvent.change(code, { target: { value: "12" } });
    fireEvent.click(within(enrol).getByRole("button", { name: "Turn on" }));
    expect(await within(enrol).findByText("Enter the 6-digit code from your app.")).toBeTruthy();
    fireEvent.change(code, { target: { value: "123 456" } });
    fireEvent.click(within(enrol).getByRole("button", { name: "Turn on" }));
    const dlg = await screen.findByRole("dialog", { name: "Save your recovery codes" });
    expect(
      within(within(dlg).getByRole("list", { name: "Recovery codes" })).getAllByRole("listitem"),
    ).toHaveLength(10);
    expect(within(dlg).getByRole("button", { name: /Copy all/ })).toBeTruthy();
    expect(within(dlg).getByRole("button", { name: /Download/ })).toBeTruthy();
    const done = within(dlg).getByRole("button", { name: "Done" }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.click(within(dlg).getByRole("checkbox"));
    expect(done.disabled).toBe(false);
    fireEvent.click(done);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.last("POST /api/v1/account/totp/confirm")!.body).toEqual({ code: "123456" });
  });

  it("turns two-step sign-in off with a code (DELETE with a body, CSRF header)", async () => {
    const api = mockFetch({
      "GET /api/v1/account/profile": profile({ twoFactorEnabled: true }),
      ...sessionsRoute,
      "DELETE /api/v1/account/totp": null,
    });
    renderWithClient(<SecuritySection />);
    fireEvent.click(await screen.findByRole("button", { name: /Turn off/ }));
    const dlg = await screen.findByRole("dialog", { name: "Turn off two-step sign-in?" });
    fireEvent.change(within(dlg).getByLabelText(/Authenticator or recovery code/), {
      target: { value: "654321" },
    });
    fireEvent.click(within(dlg).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(api.last("DELETE /api/v1/account/totp")).toBeTruthy());
    expect(api.last("DELETE /api/v1/account/totp")!.body).toEqual({ code: "654321" });
    expect(api.last("DELETE /api/v1/account/totp")!.headers.get("x-csrf-token")).toBe("csrf-tok");
  });

  it("changes the password: checks the new one first, then sends both", async () => {
    const api = mockFetch({
      "GET /api/v1/account/profile": profile(),
      ...sessionsRoute,
      "POST /api/v1/account/password": { status: "ok", csrfToken: "n" },
    });
    renderWithClient(<SecuritySection />);
    const cur = (await screen.findByLabelText("Current password")) as HTMLInputElement;
    expect(cur.autocomplete).toBe("current-password");
    expect((screen.getByLabelText("New password") as HTMLInputElement).autocomplete).toBe(
      "new-password",
    );
    fireEvent.change(cur, { target: { value: "old password here" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: /Change password/ }));
    expect(await screen.findByText(/at least 12 characters/, { selector: "p" })).toBeTruthy();
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "a much longer new password" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "a much longer new password" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Change password/ }));
    expect(await screen.findByText(/Every other signed-in browser was signed out/)).toBeTruthy();
    expect(api.last("POST /api/v1/account/password")!.body).toEqual({
      current: "old password here",
      next: "a much longer new password",
    });
  });
});

describe("account", () => {
  it("saves the name and the sign-in alert preference", async () => {
    const api = mockFetch({
      "GET /api/v1/account/profile": profile(),
      "PATCH /api/v1/account/profile": { status: "ok" },
    });
    renderWithClient(<AccountSection />);
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Ada King" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(api.last("PATCH /api/v1/account/profile")?.body).toEqual({ name: "Ada King" }),
    );
    fireEvent.click(screen.getByRole("switch", { name: /signs in from a new device/ }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(api.last("PATCH /api/v1/account/profile")!.body).toEqual({ signinAlerts: false });
    expect(
      api.calls.filter(isWrite).every((c) => c.headers.get("x-csrf-token") === "csrf-tok"),
    ).toBe(true);
  });

  it("changing the email is worded neutrally and goes through re-authentication", async () => {
    let n = 0;
    const api = mockFetch({
      "GET /api/v1/account/profile": profile(),
      "POST /api/v1/account/email": () =>
        ++n === 1 ? apiError(403, "REAUTH_REQUIRED", "confirm") : { status: "check-email" },
      "POST /api/v1/auth/reauth": { status: "ok", csrfToken: "x" },
    });
    renderWithClient(
      <>
        <AccountSection />
        <ReauthHost />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Change email" }));
    const dlg = await screen.findByRole("dialog", { name: "Change your email address" });
    fireEvent.change(within(dlg).getByLabelText("New email address"), {
      target: { value: "ada@new.example" },
    });
    fireEvent.click(within(dlg).getByRole("button", { name: "Send confirmation link" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it is you" });
    fireEvent.change(within(reauth).getByLabelText("Password"), {
      target: { value: "pw pw pw pw pw pw" },
    });
    fireEvent.click(within(reauth).getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText(/If ada@new.example can be used, we have sent a confirmation link/),
    ).toBeTruthy();
    expect(api.calls.filter((c) => c.path === "/api/v1/account/email")).toHaveLength(2);
  });

  it("deleting the account needs the typed email address", async () => {
    const api = mockFetch({
      "GET /api/v1/account/profile": profile(),
      "DELETE /api/v1/account": null,
    });
    renderWithClient(<AccountSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Delete account/ }));
    const dlg = await screen.findByRole("dialog", { name: "Delete your account?" });
    const confirm = within(dlg).getByRole("button", {
      name: "Delete account",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText(/Type your email address/), {
      target: { value: "wrong@example.com" },
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText(/Type your email address/), {
      target: { value: "ADA@example.com" },
    });
    expect(confirm.disabled).toBe(false);
    expect(within(dlg).getByText(/removed from storage within 30 days/)).toBeTruthy();
    fireEvent.click(confirm);
    await waitFor(() => expect(api.last("DELETE /api/v1/account")).toBeTruthy());
    await waitFor(() => expect(nav.go).toHaveBeenCalledWith("/signin?deleted=1"));
  });
});

describe("billing", () => {
  const owner = (over: object = {}) => ({
    status: "active",
    plan: "Glideworth Cloud",
    lookupKey: "cloud_monthly_v1",
    interval: "month",
    trialEndsAt: null,
    currentPeriodEnd: "2027-01-15T00:00:00Z",
    cancelAtPeriodEnd: false,
    access: { level: "full", reason: "active", changesAt: null },
    role: "owner",
    offered: [
      {
        lookupKey: "cloud_monthly_v1",
        interval: "month",
        product: "Glideworth Cloud",
        unitAmount: 900,
        currency: "usd",
        taxBehavior: "exclusive",
      },
      {
        lookupKey: "cloud_yearly_v1",
        interval: "year",
        product: "Glideworth Cloud",
        unitAmount: 9000,
        currency: "usd",
        taxBehavior: "exclusive",
      },
    ],
    ...over,
  });
  const show = async (b: object) => {
    const api = mockFetch({
      "GET /api/v1/billing": b,
      "POST /api/v1/billing/checkout": {
        url: "https://checkout.stripe.com/c/pay/cs_test_1",
        reused: false,
      },
      "POST /api/v1/billing/portal": { url: "https://billing.stripe.com/p/session/abc" },
    });
    renderWithClient(<BillingSection />);
    await screen.findByText("Your plan");
    return api;
  };

  it("trial: days left, no card, choose monthly or yearly with prices from the API", async () => {
    const end = new Date(Date.now() + 12 * 86400_000 + 3600_000).toISOString();
    await show(
      owner({
        status: "trialing_local",
        access: { level: "full", reason: "trial", changesAt: end },
        trialEndsAt: end,
        interval: null,
        plan: null,
        currentPeriodEnd: null,
      }),
    );
    expect(screen.getByText("Free trial: 13 days left")).toBeTruthy();
    expect(screen.getByText(/No card is needed for the trial/)).toBeTruthy();
    expect(screen.getByText("$9")).toBeTruthy();
    expect(screen.getByText("$90")).toBeTruthy();
    expect(screen.getByText("Save 17%")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Subscribe monthly" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Subscribe yearly" })).toBeTruthy();
  });

  it("shows whatever prices the API sends, with whether tax is added or included", async () => {
    await show(
      owner({
        status: "trialing_local",
        access: { level: "full", reason: "trial", changesAt: null },
        trialEndsAt: new Date(Date.now() + 5 * 86400_000).toISOString(),
        offered: [
          {
            lookupKey: "m",
            interval: "month",
            unitAmount: 1100,
            currency: "eur",
            taxBehavior: "inclusive",
          },
          {
            lookupKey: "y",
            interval: "year",
            unitAmount: 11000,
            currency: "eur",
            taxBehavior: "exclusive",
          },
        ],
      }),
    );
    expect(screen.getByText("€11")).toBeTruthy();
    expect(screen.getByText("€110")).toBeTruthy();
    expect(screen.getByText("tax included")).toBeTruthy();
    expect(screen.getByText("plus tax where it applies")).toBeTruthy();
    expect(screen.queryByText("Price shown at checkout")).toBeNull();
    expect(screen.queryByText("$9")).toBeNull();
  });

  it("starts Stripe Checkout for the chosen price (CSRF header) and leaves for Stripe", async () => {
    const api = await show(
      owner({
        status: null,
        access: { level: "read_only", reason: "no_subscription", changesAt: null },
      }),
    );
    api.calls.length = 0;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Subscribe yearly" }));
    await waitFor(() =>
      expect(nav.go).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_1"),
    );
    const call = api.last("POST /api/v1/billing/checkout")!;
    expect(call.body).toEqual({ lookupKey: "cloud_yearly_v1" });
    expect(call.headers.get("x-csrf-token")).toBe("csrf-tok");
  });

  it("active: renewal date and the portal; the 14-day refund note and how to ask", async () => {
    const api = await show(owner());
    expect(screen.getByText("Active: Glideworth Cloud, billed monthly")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Subscribe/ })).toBeNull();
    expect(screen.getByText(/14-day refund/)).toBeTruthy();
    expect(screen.getByText(/including tax/)).toBeTruthy();
    expect(
      (screen.getByRole("link", { name: "support@glideworth.com" }) as HTMLAnchorElement).href,
    ).toMatch(/^mailto:support@glideworth.com/);
    api.calls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Manage billing" }));
    await waitFor(() =>
      expect(nav.go).toHaveBeenCalledWith("https://billing.stripe.com/p/session/abc"),
    );
  });

  it("refuses to follow a non-https address from the server", async () => {
    mockFetch({
      "GET /api/v1/billing": owner(),
      "POST /api/v1/billing/portal": { url: "javascript:alert(1)" },
    });
    renderWithClient(<BillingSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage billing" }));
    expect(await screen.findByText(/address we did not recognise/)).toBeTruthy();
    expect(nav.go).not.toHaveBeenCalled();
  });

  it("cancelling at period end: says until when, offers the portal to resume", async () => {
    await show(owner({ cancelAtPeriodEnd: true }));
    expect(screen.getByText(/Your subscription ends on/)).toBeTruthy();
    expect(screen.getByText("Ending")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage billing" })).toBeTruthy();
  });

  it("past due: full access for now, update the payment method", async () => {
    await show(
      owner({
        status: "past_due",
        access: {
          level: "full",
          reason: "past_due_grace",
          changesAt: new Date(Date.now() + 4 * 86400_000).toISOString(),
        },
      }),
    );
    expect(screen.getByText("Your last payment did not go through")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update payment method" })).toBeTruthy();
  });

  it("read-only after the trial: explains what still works and the deletion schedule, owner can subscribe", async () => {
    await show(
      owner({
        status: "trialing_local",
        access: { level: "read_only", reason: "trial_expired", changesAt: null },
        interval: null,
        plan: null,
      }),
    );
    expect(screen.getByText("This workspace is read-only")).toBeTruthy();
    expect(screen.getByText(/Your free trial has ended/)).toBeTruthy();
    expect(screen.getByText(/deleted 12 months after/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Subscribe monthly" })).toBeTruthy();
  });

  it("read-only for a member: the same explanation, no buttons, a pointer to the owner", async () => {
    await show(
      owner({
        role: "editor",
        status: "canceled",
        access: { level: "read_only", reason: "canceled", changesAt: null },
      }),
    );
    expect(screen.getByText(/Only the workspace owner can change the plan/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Subscribe|Manage billing|Update payment/ }),
    ).toBeNull();
  });

  it("suspended: says so and points to support", async () => {
    await show(owner({ access: { level: "suspended", reason: "suspended", changesAt: null } }));
    expect(screen.getByText("This workspace is suspended")).toBeTruthy();
    expect(screen.getByText(/support@glideworth.com/, { selector: "p" })).toBeTruthy();
  });

  it("after Stripe sends the person back, thanks them and keeps looking until the subscription is active", async () => {
    window.history.replaceState(null, "", "/settings/billing?checkout=success");
    const api = mockFetch({
      "GET /api/v1/billing": owner({
        status: "incomplete",
        access: { level: "read_only", reason: "incomplete", changesAt: null },
      }),
    });
    renderWithClient(<BillingSection />);
    expect(await screen.findByText(/waiting for the payment to be confirmed/)).toBeTruthy();
    expect(window.location.search).toBe("");
    expect(api.calls.filter((c) => c.path === "/api/v1/billing").length).toBeGreaterThanOrEqual(1);
  });

  it("a request that fails shows an error with a retry, not a blank page", async () => {
    mockFetch({
      "GET /api/v1/billing": () => apiError(503, "TENANT_UNAVAILABLE", "billing unavailable"),
    });
    renderWithClient(<BillingSection />);
    expect(await screen.findByText("Billing could not be loaded")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
  });
});

describe("members and invitations", () => {
  const settings = (role = "owner", limits = { editors: 3, viewers: 2 }) => ({
    id: "acc_1",
    name: "Home",
    mcpWrites: false,
    role,
    limits,
  });
  const members = [
    { userId: "u1", role: "owner", name: "Ada", email: "ada@example.com" },
    { userId: "u2", role: "editor", name: "Grace", email: "grace@example.com" },
    { userId: "u3", role: "viewer", name: "Alan", email: "alan@example.com" },
  ];
  const routes = (role = "owner", extra: Record<string, unknown> = {}) => ({
    "GET /api/v1/workspace/settings": settings(role),
    "GET /api/v1/workspace/members": { items: members },
    "GET /api/v1/workspace/invitations": {
      items: [
        { id: "inv1", email: "pat@example.com", role: "editor", expiresAt: "2026-11-23T00:00:00Z" },
      ],
    },
    ...extra,
  });

  it("owner: lists people with roles, shows seat use including pending invitations", async () => {
    mockFetch(routes());
    renderWithClient(<MembersSection />, signedIn("owner"));
    expect(await screen.findByText("Grace")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    // owner + Grace + a pending editor invitation = 3 of 3; Alan is the one viewer
    expect(await screen.findByText("pat@example.com")).toBeTruthy();
    expect(screen.getByText("3 of 3 used")).toBeTruthy();
    expect(screen.getByText("1 of 2 used")).toBeTruthy();
  });

  it("invites by email with a role, and refuses before asking the server when every seat is taken", async () => {
    const api = mockFetch(
      routes("owner", { "POST /api/v1/workspace/invitations": { id: "inv2" } }),
    );
    renderWithClient(<MembersSection />, signedIn("owner"));
    await screen.findByText("pat@example.com");
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send invitation/ }));
    // editors are full (3 of 3), so no request is made
    expect(await screen.findByText(/All 3 editors on your plan are used/)).toBeTruthy();
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("sends the invitation when there is room, and tells the person", async () => {
    const api = mockFetch({
      "GET /api/v1/workspace/settings": settings("owner", { editors: 5, viewers: 2 }),
      "GET /api/v1/workspace/members": { items: members },
      "GET /api/v1/workspace/invitations": { items: [] },
      "POST /api/v1/workspace/invitations": { id: "inv2" },
    });
    renderWithClient(<MembersSection />, signedIn("owner"));
    await screen.findByText("Grace");
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send invitation/ }));
    expect(await screen.findByText("Invitation sent to new@example.com.")).toBeTruthy();
    const call = api.last("POST /api/v1/workspace/invitations")!;
    expect(call.body).toEqual({ email: "new@example.com", role: "editor" });
    expect(call.headers.get("x-csrf-token")).toBe("csrf-tok");
  });

  it("shows the server's seat-limit answer when it disagrees", async () => {
    mockFetch({
      "GET /api/v1/workspace/settings": settings("owner", { editors: 9, viewers: 9 }),
      "GET /api/v1/workspace/members": { items: members },
      "GET /api/v1/workspace/invitations": { items: [] },
      "POST /api/v1/workspace/invitations": () =>
        apiError(409, "SEAT_LIMIT", "your plan allows 1 editors", { role: "editor", limit: 1 }),
    });
    renderWithClient(<MembersSection />, signedIn("owner"));
    await screen.findByText("Grace");
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send invitation/ }));
    expect(await screen.findByText(/Your plan allows 1 editors, and all are in use/)).toBeTruthy();
  });

  it("shows each member's email to owners and editors, and names only when the API sends none", async () => {
    mockFetch(routes("owner"));
    const first = renderWithClient(<MembersSection />, signedIn("owner"));
    expect(await screen.findByText("grace@example.com")).toBeTruthy();
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    first.unmount();
    mockFetch({
      "GET /api/v1/workspace/settings": settings("viewer"),
      "GET /api/v1/workspace/members": {
        items: members.map(({ email: _email, ...rest }) => rest),
      },
    });
    renderWithClient(<MembersSection />, signedIn("viewer"));
    expect(await screen.findByText("Grace")).toBeTruthy();
    expect(screen.queryByText(/@example\.com/)).toBeNull();
  });

  it("withdraws a pending invitation and resends one with the resend endpoint", async () => {
    const api = mockFetch(
      routes("owner", {
        "DELETE /api/v1/workspace/invitations/inv1": null,
        "POST /api/v1/workspace/invitations/inv1/resend": { id: "inv1" },
      }),
    );
    renderWithClient(<MembersSection />, signedIn("owner"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Withdraw the invitation to pat@example.com" }),
    );
    await waitFor(() => expect(api.last("DELETE /api/v1/workspace/invitations/inv1")).toBeTruthy());
    api.calls.length = 0;
    fireEvent.click(
      screen.getByRole("button", { name: "Send the invitation to pat@example.com again" }),
    );
    await waitFor(() =>
      expect(api.last("POST /api/v1/workspace/invitations/inv1/resend")).toBeTruthy(),
    );
    expect(api.calls.filter(isWrite).map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/v1/workspace/invitations/inv1/resend",
    ]);
  });

  it("removes a member after confirmation, and transfers ownership to an editor with re-authentication", async () => {
    let n = 0;
    const api = mockFetch(
      routes("owner", {
        "DELETE /api/v1/workspace/members/u3": null,
        "POST /api/v1/workspace/transfer": () =>
          ++n === 1 ? apiError(403, "REAUTH_REQUIRED", "confirm") : null,
        "POST /api/v1/auth/reauth": { status: "ok", csrfToken: "x" },
      }),
    );
    renderWithClient(
      <>
        <MembersSection />
        <ConfirmHost />
        <ReauthHost />
      </>,
      signedIn("owner"),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Remove Alan" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.last("DELETE /api/v1/workspace/members/u3")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Make Alan the owner" })).toBeNull(); // viewers cannot be made owner
    fireEvent.click(screen.getByRole("button", { name: "Make Grace the owner" }));
    fireEvent.click(await screen.findByRole("button", { name: "Transfer ownership" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it is you" });
    fireEvent.change(within(reauth).getByLabelText("Password"), {
      target: { value: "pw pw pw pw pw pw" },
    });
    fireEvent.click(within(reauth).getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.path === "/api/v1/workspace/transfer")).toHaveLength(2),
    );
    expect(api.last("POST /api/v1/workspace/transfer")!.body).toEqual({ userId: "u2" });
  });

  it("a member can leave but cannot invite or remove anyone", async () => {
    const api = mockFetch({
      "GET /api/v1/workspace/settings": settings("editor"),
      "GET /api/v1/workspace/members": { items: members },
      "POST /api/v1/workspace/leave": null,
    });
    renderWithClient(
      <>
        <MembersSection />
        <ConfirmHost />
      </>,
      signedIn("editor"),
    );
    await screen.findByText("Grace");
    expect(screen.queryByRole("button", { name: /Send invitation/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    expect(api.calls.some((c) => c.path === "/api/v1/workspace/invitations")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Leave workspace/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Leave" }));
    await waitFor(() => expect(api.last("POST /api/v1/workspace/leave")).toBeTruthy());
    await waitFor(() => expect(nav.go).toHaveBeenCalledWith("/"));
  });
});

describe("workspace", () => {
  const w = (over: object = {}) => ({
    id: "acc_1",
    name: "Home",
    mcpWrites: false,
    role: "owner",
    limits: { editors: 3, viewers: 2 },
    ...over,
  });

  it("renames, toggles AI assistant changes, and lists support grants", async () => {
    const api = mockFetch({
      "GET /api/v1/workspace/settings": w(),
      "GET /api/v1/workspace/support-grants": {
        items: [
          {
            id: "g1",
            reason: "Import help",
            expiresAt: new Date(Date.now() + 86400_000).toISOString(),
            revokedAt: null,
          },
        ],
      },
      "PATCH /api/v1/workspace/settings": { status: "ok" },
      "DELETE /api/v1/workspace/support-grants/g1": null,
    });
    renderWithClient(<WorkspaceSection />);
    fireEvent.change(await screen.findByLabelText("Workspace name"), {
      target: { value: "Family plans" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(api.last("PATCH /api/v1/workspace/settings")?.body).toEqual({ name: "Family plans" }),
    );
    fireEvent.click(screen.getByRole("switch", { name: "Allow AI assistants to make changes" }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(api.last("PATCH /api/v1/workspace/settings")!.body).toEqual({ mcpWrites: true });
    expect(await screen.findByText("Import help")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End now" }));
    await waitFor(() =>
      expect(api.last("DELETE /api/v1/workspace/support-grants/g1")).toBeTruthy(),
    );
  });

  it("grants support access with a reason and a number of days", async () => {
    const api = mockFetch({
      "GET /api/v1/workspace/settings": w(),
      "GET /api/v1/workspace/support-grants": { items: [] },
      "POST /api/v1/workspace/support-grants": {
        id: "g2",
        expiresAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
      },
    });
    renderWithClient(<WorkspaceSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Grant access/ }));
    expect(await screen.findByText(/Tell us what you want help with/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("What do you need help with?"), {
      target: { value: "My import looks wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Grant access/ }));
    expect(await screen.findByText(/Support can see your workspace until/)).toBeTruthy();
    expect(api.last("POST /api/v1/workspace/support-grants")!.body).toEqual({
      reason: "My import looks wrong",
      days: 3,
    });
  });

  it("export asks for a recent password check, then offers a one-time download link", async () => {
    let n = 0;
    mockFetch({
      "GET /api/v1/workspace/settings": w(),
      "GET /api/v1/workspace/support-grants": { items: [] },
      "POST /api/v1/workspace/export": () =>
        ++n === 1
          ? apiError(403, "REAUTH_REQUIRED", "x")
          : { exportId: "exp_1", expiresAt: new Date(Date.now() + 86400_000).toISOString() },
      "POST /api/v1/auth/reauth": { status: "ok", csrfToken: "x" },
    });
    renderWithClient(
      <>
        <WorkspaceSection />
        <ReauthHost />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Prepare export/ }));
    const dlg = await screen.findByRole("dialog", { name: "Confirm it is you" });
    fireEvent.change(within(dlg).getByLabelText("Password"), {
      target: { value: "pw pw pw pw pw pw" },
    });
    fireEvent.click(within(dlg).getByRole("button", { name: "Continue" }));
    const link = (await screen.findByRole("link", { name: /Download/ })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/v1/workspace/exports/exp_1");
  });

  it("deleting the workspace needs its name typed exactly, and sends it", async () => {
    const api = mockFetch({
      "GET /api/v1/workspace/settings": w({ name: "Home" }),
      "GET /api/v1/workspace/support-grants": { items: [] },
      "DELETE /api/v1/workspace": null,
    });
    renderWithClient(<WorkspaceSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Delete workspace/ }));
    const dlg = await screen.findByRole("dialog", { name: "Delete this workspace?" });
    const go = within(dlg).getByRole("button", { name: "Delete workspace" }) as HTMLButtonElement;
    fireEvent.change(within(dlg).getByLabelText("Type the workspace name to confirm"), {
      target: { value: "home" },
    });
    expect(go.disabled).toBe(true); // case matters
    fireEvent.change(within(dlg).getByLabelText("Type the workspace name to confirm"), {
      target: { value: "Home" },
    });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(api.last("DELETE /api/v1/workspace")).toBeTruthy());
    expect(api.last("DELETE /api/v1/workspace")!.body).toEqual({ confirmName: "Home" });
    expect(api.last("DELETE /api/v1/workspace")!.headers.get("x-csrf-token")).toBe("csrf-tok");
  });

  it("a member sees the settings read-only, without delete or support controls", async () => {
    mockFetch({ "GET /api/v1/workspace/settings": w({ role: "editor" }) });
    renderWithClient(<WorkspaceSection />);
    const name = (await screen.findByLabelText("Workspace name")) as HTMLInputElement;
    expect(name.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Delete workspace/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Grant access/ })).toBeNull();
    expect(
      (
        screen.getByRole("switch", {
          name: "Allow AI assistants to make changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe("shell: banners, switcher, suspended page", () => {
  it("trial banner counts the days for the owner, with a way to choose a plan", () => {
    const end = new Date(Date.now() + 9 * 86400_000 + 3600_000).toISOString();
    renderWithClient(
      <CloudBanners />,
      signedIn("owner", { level: "full", reason: "trial" }, { trialEndsAt: end }),
    );
    const banner = screen.getByRole("status");
    expect(banner.textContent).toMatch(/Free trial: 10 days left/);
    expect(
      (
        within(banner).getByRole("link", { name: "Choose a plan" }) as HTMLAnchorElement
      ).getAttribute("href"),
    ).toBe("/settings/$section");
  });

  it("read-only banner: owners are told to subscribe, members to ask the owner (no button)", () => {
    const access = { level: "read_only", reason: "trial_expired" };
    renderWithClient(<CloudBanners />, signedIn("owner", access));
    expect(screen.getByRole("alert").textContent).toMatch(
      /free trial has ended.*subscribe to edit again/,
    );
    expect(screen.getByRole("link", { name: "Subscribe" })).toBeTruthy();
    cleanup();
    renderWithClient(<CloudBanners />, signedIn("editor", access));
    expect(screen.getByRole("alert").textContent).toMatch(/ask the workspace owner to subscribe/);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("no banner while the subscription is simply active", () => {
    renderWithClient(<CloudBanners />, signedIn("owner"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the workspace switcher appears only with more than one workspace and activates the chosen one", async () => {
    const api = mockFetch({ "POST /api/v1/workspaces/acc_2/activate": null });
    const { container } = renderWithClient(
      <WorkspaceSwitcher />,
      signedIn("owner", undefined, { workspaces: 1 }),
    );
    expect(container.innerHTML).toBe("");
    cleanup();
    renderWithClient(<WorkspaceSwitcher />, signedIn("owner", undefined, { workspaces: 2 }));
    const trigger = screen.getByRole("combobox", { name: "Workspace" });
    expect(trigger.textContent).toMatch(/Ada's workspace/);
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: /Shared/ }));
    await waitFor(() => expect(api.last("POST /api/v1/workspaces/acc_2/activate")).toBeTruthy());
    await waitFor(() => expect(nav.go).toHaveBeenCalledWith("/"));
  });

  it("signed in with no workspace: says nothing is saved and offers to create one", async () => {
    const api = mockFetch({ "POST /api/v1/workspaces": { id: "acc_new" } });
    const state = signedIn("owner");
    if (state.kind !== "authenticated" || !state.cloud) throw new Error("fixture");
    state.cloud.workspace = null;
    state.cloud.workspaces = [];
    renderWithClient(<CloudBanners />, state);
    expect(screen.getByRole("alert").textContent).toMatch(/not in a workspace yet/);
    fireEvent.click(screen.getByRole("button", { name: "Create my own workspace" }));
    await waitFor(() => expect(api.last("POST /api/v1/workspaces")).toBeTruthy());
    await waitFor(() => expect(nav.go).toHaveBeenCalledWith("/"));
  });

  it("the workspace switcher keeps its trigger a flex row whatever display classes the shell passes", () => {
    renderWithClient(
      <WorkspaceSwitcher className="hidden w-[180px] min-w-0 md:block" />,
      signedIn("owner", undefined, { workspaces: 2 }),
    );
    const trigger = screen.getByRole("combobox", { name: "Workspace" });
    expect(trigger.className).toMatch(/\bflex\b/);
    expect(trigger.className).not.toMatch(/\b(md:block|hidden)\b/);
    expect(trigger.parentElement?.className).toBe("hidden w-[180px] min-w-0 md:block");
  });

  it("the suspended page explains, points to support, and lets only the owner reach export and delete", () => {
    renderWithClient(
      <SuspendedPage />,
      signedIn("owner", { level: "suspended", reason: "suspended" }),
    );
    expect(screen.getByRole("heading", { name: "This workspace is suspended" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "support@glideworth.com" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Export or delete the workspace" })).toBeTruthy();
    cleanup();
    renderWithClient(
      <SuspendedPage />,
      signedIn("viewer", { level: "suspended", reason: "suspended" }),
    );
    expect(screen.queryByRole("link", { name: "Export or delete the workspace" })).toBeNull();
  });
});

describe("402 ACCOUNT_READ_ONLY and 429 QUOTA_EXCEEDED", () => {
  it("explains a refused write, says the change was not lost, and refreshes the session", async () => {
    mockFetch({
      "PATCH /api/v1/workspace/settings": () =>
        apiError(402, "ACCOUNT_READ_ONLY", "the workspace is read-only", {
          reason: "trial_expired",
          billingUrl: "/settings/billing",
        }),
      "GET /api/v1/auth/status": { mode: "cloud", authenticated: false },
    });
    const { qc } = renderWithClient(
      <>
        <ApiProblemHost />
        <Toaster />
      </>,
      signedIn("owner"),
    );
    const refetched = vi.spyOn(qc, "invalidateQueries");
    await expect(cloudApi.updateWorkspace({ name: "x" })).rejects.toMatchObject({
      status: 402,
      code: "ACCOUNT_READ_ONLY",
    });
    const toast = await screen.findByText("This workspace is read-only");
    expect(toast.closest("[role=alert]")!.textContent).toMatch(
      /Your change was not saved and is still on screen/,
    );
    expect(screen.getByRole("button", { name: "Open billing" })).toBeTruthy();
    expect(refetched).toHaveBeenCalledWith({ queryKey: ["session"] });
  });

  it("tells a member to ask the owner instead of offering billing", async () => {
    mockFetch({
      "PATCH /api/v1/workspace/settings": () =>
        apiError(402, "ACCOUNT_READ_ONLY", "ro", { reason: "canceled" }),
    });
    renderWithClient(
      <>
        <ApiProblemHost />
        <Toaster />
      </>,
      signedIn("editor"),
    );
    await cloudApi.updateWorkspace({ name: "x" }).catch(() => undefined);
    expect(await screen.findByText(/Ask the workspace owner to restore editing/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
  });

  it("names the limit and when it resets", async () => {
    mockFetch({
      "POST /api/v1/workspace/export": () =>
        apiError(429, "QUOTA_EXCEEDED", "the daily limit of your plan is used up", {
          metric: "job",
          limit: 100,
          resetsAt: "2026-11-17T00:00:00Z",
        }),
    });
    renderWithClient(
      <>
        <ApiProblemHost />
        <Toaster />
      </>,
      signedIn("owner"),
    );
    await cloudApi.exportWorkspace().catch(() => undefined);
    const text = (await screen.findByText(/You have used today's limit of 100 for background jobs/))
      .textContent!;
    expect(text).toMatch(/It resets .*2026/);
    expect(screen.getByText("Daily limit reached")).toBeTruthy();
  });
});
