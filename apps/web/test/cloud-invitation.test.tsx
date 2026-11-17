/**
 * Hosted invitations (QA items 12 and 13): the invitation page names the workspace and the role, says only
 * "will not work" for a dead token, and a sign-up that starts there carries the invitation through email
 * confirmation back to the invitation page.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldInvitation, holdInvitation } from "../src/features/cloud/held-invitation";
import { safeNext } from "../src/features/cloud/next";
import { InvitePage, VerifyEmailPage } from "../src/features/cloud/screens/link-pages";
import { CheckEmailPage, SignUpPage } from "../src/features/cloud/screens/signup";
import {
  apiError,
  mockFetch,
  navigateSpy,
  renderWithClient,
  signedIn,
  signedOut,
  withCsrfCookie,
} from "./cloud-helpers";

vi.mock("@tanstack/react-router", async (importOriginal) =>
  (await import("./cloud-helpers")).routerMock(importOriginal as never),
);

const PREVIEW = "POST /api/v1/workspace/invitations/preview";

beforeEach(() => {
  navigateSpy.mockReset();
  holdInvitation(null);
  window.history.replaceState(null, "", "/");
  withCsrfCookie();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("invitation page", () => {
  it("signed out: names the workspace and the role from the preview, then offers sign-in or sign-up", async () => {
    window.history.replaceState(null, "", "/invite#token=inv-live");
    const api = mockFetch({
      [PREVIEW]: { workspaceName: "The Example Household", role: "viewer" },
    });
    renderWithClient(<InvitePage />, signedOut());
    expect(
      await screen.findByRole("heading", {
        name: "You have been invited to The Example Household",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/You would join as a viewer\. Viewers can see the plans/)).toBeTruthy();
    expect(api.last(PREVIEW)!.body).toEqual({ token: "inv-live" });
    expect(window.location.hash).toBe("");
    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toEqual(expect.arrayContaining(["/signin", "/signup"]));
    // The sign-up page can use what the preview said.
    await waitFor(() =>
      expect(heldInvitation()).toEqual({
        token: "inv-live",
        offer: { workspaceName: "The Example Household", role: "viewer" },
      }),
    );
  });

  it("signed in: asks to join the named workspace as an editor", async () => {
    window.history.replaceState(null, "", "/invite#token=inv-live");
    mockFetch({ [PREVIEW]: { workspaceName: "Robin's plans", role: "editor" } });
    renderWithClient(<InvitePage />, signedIn("viewer"));
    expect(await screen.findByRole("heading", { name: "Join Robin's plans" })).toBeTruthy();
    expect(screen.getByText(/You would join as an editor\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Join the workspace/ })).toBeTruthy();
  });

  it("a guessed, used or expired token shows only that the invitation will not work", async () => {
    window.history.replaceState(null, "", "/invite#token=inv-dead");
    holdInvitation({ token: "inv-dead" });
    mockFetch({ [PREVIEW]: () => apiError(400, "INVALID_TOKEN", "invalid") });
    renderWithClient(<InvitePage />, signedOut());
    expect(
      await screen.findByRole("heading", { name: "This invitation will not work" }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Join/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/editor|viewer|invited to /i);
    await waitFor(() => expect(heldInvitation()).toBeNull());
  });

  it("if the preview cannot be fetched, the page still works with general wording", async () => {
    window.history.replaceState(null, "", "/invite#token=inv-live");
    mockFetch({ [PREVIEW]: () => apiError(503, "TENANT_UNAVAILABLE", "try later") });
    renderWithClient(<InvitePage />, signedOut());
    expect(
      await screen.findByRole("heading", { name: "You have been invited to a workspace" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create an account" })).toBeTruthy();
  });
});

describe("sign-up from an invitation", () => {
  const fill = () => {
    for (const [label, value] of [
      ["Your name", "Ivy Invitee"],
      ["Email", "ivy@example.com"],
      [/^Password/, "correct horse battery staple"],
    ] as const)
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole("checkbox", { name: /18 or over/ }));
  };

  it("sends the invitation with the sign-up and does not promise a trial", async () => {
    holdInvitation({
      token: "inv-live",
      offer: { workspaceName: "Robin's plans", role: "viewer" },
    });
    const api = mockFetch({
      "POST /api/v1/auth/signup": () =>
        new Response(JSON.stringify({ status: "check-email" }), { status: 202 }),
    });
    renderWithClient(<SignUpPage />, signedOut());
    expect(screen.getByText(/take you back to the invitation to join Robin's plans/)).toBeTruthy();
    expect(screen.queryByText(/free trial/)).toBeNull();
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: "/check-email" }));
    expect(api.last("POST /api/v1/auth/signup")!.body).toMatchObject({
      email: "ivy@example.com",
      invitation: "inv-live",
    });
    cleanup();
    renderWithClient(<CheckEmailPage />, signedOut());
    expect(screen.getByText(/it will take you to your invitation/)).toBeTruthy();
    expect(screen.queryByText(/start your trial/)).toBeNull();
  });

  it("without an invitation nothing extra is sent", async () => {
    const api = mockFetch({
      "POST /api/v1/auth/signup": () =>
        new Response(JSON.stringify({ status: "check-email" }), { status: 202 }),
    });
    renderWithClient(<SignUpPage />, signedOut());
    expect(screen.getByText(/7-day free trial.*charged on day 8 unless you cancel/)).toBeTruthy();
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled());
    expect(api.last("POST /api/v1/auth/signup")!.body).not.toHaveProperty("invitation");
  });

  it("confirming the address goes to the invitation page with its token in the fragment", async () => {
    window.history.replaceState(null, "", "/verify-email#token=ver-tok");
    mockFetch({
      "POST /api/v1/auth/verify": {
        status: "signed-in",
        redirectTo: "/invite#token=inv-live",
        csrfToken: "t",
      },
      "GET /api/v1/auth/status": { mode: "cloud", authenticated: false },
    });
    renderWithClient(<VerifyEmailPage />, signedOut());
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled());
    expect(navigateSpy.mock.calls[0]![0]).toMatchObject({ to: "/invite", hash: "token=inv-live" });
  });

  it("the invitation page is a valid place to return to after signing in", () => {
    expect(safeNext("/invite", "http://localhost")).toBe("/invite");
    expect(safeNext("/invite#token=abc", "http://localhost")).toBe("/invite#token=abc");
    expect(safeNext("/signup", "http://localhost")).toBe("/");
  });
});
