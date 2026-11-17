/**
 * "Sign in with Google" in the web app: the button (a plain link, no Google script), the sign-up step for a new
 * Google user, the "account already exists" page, the second step after a Google sign-in, the Sign-in methods
 * settings, and re-authentication for an account without a password.
 */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmHost } from "../src/components/ui/confirm-dialog";
import { Toaster } from "../src/components/ui/toaster";
import { nav } from "../src/features/cloud/next";
import { ReauthHost } from "../src/features/cloud/reauth-dialog";
import { holdInvitation } from "../src/features/cloud/held-invitation";
import {
  GoogleExistsPage,
  GoogleLinkPage,
  GoogleSignUpPage,
} from "../src/features/cloud/screens/google";
import { SignInPage, TwoFactorPage } from "../src/features/cloud/screens/signin";
import { SignUpPage } from "../src/features/cloud/screens/signup";
import { setChallenge } from "../src/features/cloud/session-flow";
import { SecuritySection } from "../src/features/cloud/settings/security-section";
import { withReauth } from "../src/lib/reauth";
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

beforeEach(() => {
  navigateSpy.mockReset();
  setChallenge(null);
  window.history.replaceState(null, "", "/");
  withCsrfCookie("csrf-tok");
  vi.spyOn(nav, "go").mockImplementation(() => undefined);
  vi.spyOn(nav, "replace").mockImplementation(() => undefined);
  holdInvitation(null);
  Element.prototype.scrollIntoView ??= vi.fn();
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const googleLink = () =>
  screen.getByRole("link", { name: "Continue with Google" }) as HTMLAnchorElement;

describe("the button", () => {
  it("is absent unless the server offers Google sign-in", () => {
    renderWithClient(<SignInPage />, signedOut());
    expect(screen.queryByRole("link", { name: "Continue with Google" })).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("on sign-in: below the form after an 'or' divider, a plain link to our server carrying the validated next", () => {
    window.history.replaceState(null, "", "/signin?next=%2Fplans%2F7");
    renderWithClient(<SignInPage />, signedOut({ googleSignIn: true }));
    const a = googleLink();
    expect(a.getAttribute("href")).toBe("/api/v1/auth/google/start?next=%2Fplans%2F7");
    expect(screen.getByRole("separator").textContent).toBe("or");
    // Order: the password button, then the divider, then Google.
    const signIn = screen.getByRole("button", { name: "Sign in" });
    expect(signIn.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The logo is local and decorative; no Google script, font or image is requested.
    expect(a.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(
      document.querySelector('script[src*="google"], link[href*="google"], img[src*="google"]'),
    ).toBeNull();
  });

  it("an open-redirect next is dropped before it reaches the link", () => {
    window.history.replaceState(null, "", "/signin?next=%2F%2Fevil.example");
    renderWithClient(<SignInPage />, signedOut({ googleSignIn: true }));
    expect(googleLink().getAttribute("href")).toBe("/api/v1/auth/google/start");
  });

  it("on sign-up too", () => {
    renderWithClient(<SignUpPage />, signedOut({ googleSignIn: true }));
    expect(googleLink().getAttribute("href")).toBe("/api/v1/auth/google/start");
  });

  it("explains a failed Google round trip on the sign-in page", () => {
    window.history.replaceState(null, "", "/signin?google=expired");
    renderWithClient(<SignInPage />, signedOut({ googleSignIn: true }));
    expect(screen.getByRole("alert").textContent).toMatch(
      /took too long or was opened in another browser/,
    );
  });
});

describe("second step after a Google sign-in", () => {
  it("takes the challenge from the URL fragment, clears it, and sends it with the code", async () => {
    window.history.replaceState(
      null,
      "",
      "/signin/2fa#challenge=chal-from-google&next=%2Fplans%2F2",
    );
    const api = mockFetch({
      "POST /api/v1/auth/signin/totp": { status: "signed-in", redirectTo: "/plans/2" },
      "GET /api/v1/auth/status": { mode: "cloud", authenticated: false },
    });
    renderWithClient(<TwoFactorPage />, signedOut());
    await waitFor(() => expect(window.location.hash).toBe(""));
    fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Verify and sign in/ }));
    await waitFor(() => expect(api.last("POST /api/v1/auth/signin/totp")).toBeTruthy());
    expect(api.last("POST /api/v1/auth/signin/totp")!.body).toEqual({
      challenge: "chal-from-google",
      code: "123456",
      next: "/plans/2",
    });
  });
});

describe("from an invitation page", () => {
  it("the button carries the invitation held in this tab, on sign-up and on sign-in", () => {
    holdInvitation({
      token: "inv-tok",
      offer: { workspaceName: "Example Household", role: "viewer" },
    });
    renderWithClient(<SignUpPage />, signedOut({ googleSignIn: true }));
    expect(googleLink().getAttribute("href")).toBe("/api/v1/auth/google/start?invitation=inv-tok");
    cleanup();
    window.history.replaceState(null, "", "/signin?next=%2Finvite");
    renderWithClient(<SignInPage />, signedOut({ googleSignIn: true }));
    expect(googleLink().getAttribute("href")).toBe(
      "/api/v1/auth/google/start?next=%2Finvite&invitation=inv-tok",
    );
  });

  it("the sign-up step names the workspace instead of a trial, and goes where the server says (the invitation)", async () => {
    mockFetch({
      "GET /api/v1/auth/google/pending": {
        name: "Gus Guest",
        email: "gus@gmail.com",
        invitedTo: "Example Household",
      },
      "POST /api/v1/auth/google/complete": {
        status: "signed-in",
        redirectTo: "/invite#token=inv-tok",
      },
      "GET /api/v1/auth/status": { mode: "cloud", authenticated: false },
    });
    renderWithClient(<GoogleSignUpPage />, signedOut());
    expect(
      await screen.findByText(/take you back to the invitation to join Example Household/),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/free trial/);
    fireEvent.click(screen.getByRole("checkbox", { name: /18 or over/ }));
    fireEvent.click(screen.getByRole("button", { name: /Create account/ }));
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ to: "/invite", hash: "token=inv-tok" }),
      ),
    );
  });
});

describe("finishing a link (/google-link)", () => {
  it("posts once with the CSRF token, then returns to security settings with the answer", async () => {
    const api = mockFetch({
      "POST /api/v1/account/identities/google/finish": { google: "linked" },
    });
    renderWithClient(<GoogleLinkPage />, signedIn("owner", undefined, { googleSignIn: true }));
    expect(screen.getByRole("heading", { name: "Linking your Google account" })).toBeTruthy();
    await waitFor(() =>
      expect(nav.replace).toHaveBeenCalledWith("/settings/security?google=linked"),
    );
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.path)).toEqual(["/api/v1/account/identities/google/finish"]);
    expect(posts[0]?.headers.get("x-csrf-token")).toBe("csrf-tok");
  });

  it("a refusal is shown on security settings; a failed request says so here", async () => {
    mockFetch({ "POST /api/v1/account/identities/google/finish": { google: "session" } });
    renderWithClient(<GoogleLinkPage />, signedIn("owner"));
    await waitFor(() =>
      expect(nav.replace).toHaveBeenCalledWith("/settings/security?google=session"),
    );
    cleanup();
    mockFetch({
      "POST /api/v1/account/identities/google/finish": () =>
        apiError(503, "TENANT_UNAVAILABLE", "try again shortly"),
    });
    renderWithClient(<GoogleLinkPage />, signedIn("owner"));
    expect(await screen.findByRole("heading", { name: "Google was not linked" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Back to Security settings" }).getAttribute("href"),
    ).toBeTruthy();
  });
});

describe("sign-up step for a new Google user", () => {
  const pending = { name: "Gwen Googler", email: "gwen@gmail.com" };

  it("prefills the name (editable), shows the address, and sends nothing until 18-or-over is ticked", async () => {
    const api = mockFetch({
      "GET /api/v1/auth/google/pending": pending,
      "POST /api/v1/auth/google/complete": { status: "signed-in", redirectTo: "/" },
      "GET /api/v1/auth/status": { mode: "cloud", authenticated: false },
    });
    renderWithClient(<GoogleSignUpPage />, signedOut({ termsVersion: "2026-11-16" }));
    const name = (await screen.findByLabelText("Your name")) as HTMLInputElement;
    expect(name.value).toBe("Gwen Googler");
    expect(name.autocomplete).toBe("name");
    expect(screen.getByText("gwen@gmail.com")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Terms of Service/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Privacy Policy/ })).toBeTruthy();
    fireEvent.change(name, { target: { value: "Gwen G." } });
    fireEvent.click(screen.getByRole("button", { name: /Create account/ }));
    const box = screen.getByRole("checkbox", { name: /18 or over/ });
    await waitFor(() => expect(box.getAttribute("aria-invalid")).toBe("true"));
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: /Create account/ }));
    await waitFor(() => expect(api.last("POST /api/v1/auth/google/complete")).toBeTruthy());
    const call = api.last("POST /api/v1/auth/google/complete")!;
    expect(call.body).toEqual({
      name: "Gwen G.",
      termsVersion: "2026-11-16",
      adultConfirmed: true,
    });
    expect(call.headers.get("x-csrf-token")).toBe("csrf-tok");
  });

  it("an expired or foreign sign-up says start again and creates nothing", async () => {
    mockFetch({
      "GET /api/v1/auth/google/pending": () =>
        apiError(400, "INVALID_TOKEN", "this sign-up has expired; continue with Google again"),
    });
    renderWithClient(<GoogleSignUpPage />, signedOut());
    expect(await screen.findByRole("heading", { name: "Start again" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to sign-up" }).getAttribute("href")).toBe(
      "/signup",
    );
  });

  it("an address that meanwhile has an account goes to the neutral page", async () => {
    mockFetch({
      "GET /api/v1/auth/google/pending": pending,
      "POST /api/v1/auth/google/complete": () =>
        apiError(409, "CONFLICT", "an account with this email address already exists", {
          reason: "account-exists",
        }),
    });
    renderWithClient(<GoogleSignUpPage />, signedOut());
    await screen.findByLabelText("Your name");
    fireEvent.click(screen.getByRole("checkbox", { name: /18 or over/ }));
    fireEvent.click(screen.getByRole("button", { name: /Create account/ }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: "/signin/google-exists" }));
  });
});

describe("account already exists", () => {
  it("is neutral (no address), signs nobody in, and points to password sign-in then linking", () => {
    renderWithClient(<GoogleExistsPage />, signedOut());
    expect(screen.getByRole("heading", { name: "You already have an account" })).toBeTruthy();
    expect(screen.getByText(/we did not sign you in with Google/)).toBeTruthy();
    expect(screen.getByText(/link Google under Settings → Security/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Sign in with your password/ }).getAttribute("href"),
    ).toBe("/signin");
    expect(document.body.textContent).not.toMatch(/@/);
  });
});

describe("security settings: sign-in methods", () => {
  const profile = (over: object = {}) => ({
    id: "u1",
    email: "ada@example.com",
    name: "Ada",
    twoFactorEnabled: false,
    signinAlerts: true,
    checkinEmails: true,
    passwordSet: true,
    identities: [],
    googleSignIn: true,
    ...over,
  });
  const base = { "GET /api/v1/account/sessions": { items: [] } };

  it("password set, Google not linked: links after the re-auth prompt by sending the browser to Google", async () => {
    let calls = 0;
    const api = mockFetch({
      ...base,
      "GET /api/v1/account/profile": profile(),
      "POST /api/v1/account/identities/google": () =>
        ++calls === 1
          ? apiError(403, "REAUTH_REQUIRED", "confirm your password or a 2FA code to continue")
          : { url: "https://accounts.google.com/o/oauth2/v2/auth?state=s" },
      "POST /api/v1/auth/reauth": { status: "ok", csrfToken: "fresh" },
    });
    renderWithClient(
      <>
        <SecuritySection />
        <ReauthHost />
      </>,
      signedIn("owner", undefined, { googleSignIn: true }),
    );
    expect(await screen.findByText(/^Set\. You can change it below\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Link Google account/ }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it is you" });
    fireEvent.change(within(dialog).getByLabelText("Password"), {
      target: { value: "my password" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(nav.go).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=s"),
    );
    expect(api.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      "/api/v1/account/identities/google",
      "/api/v1/auth/reauth",
      "/api/v1/account/identities/google",
    ]);
  });

  it("no password, Google linked: offers 'Set a password' by email, and Unlink is disabled", async () => {
    const api = mockFetch({
      ...base,
      "GET /api/v1/account/profile": profile({
        passwordSet: false,
        identities: [
          { provider: "google", email: "ada@gmail.com", linkedAt: "2026-11-01T00:00:00Z" },
        ],
      }),
      "POST /api/v1/account/password/setup": () =>
        new Response(JSON.stringify({ status: "check-email" }), { status: 202 }),
    });
    renderWithClient(
      <SecuritySection />,
      signedIn("owner", undefined, { password: false, google: true }),
    );
    expect(await screen.findByText(/Not set: you sign in with Google/)).toBeTruthy();
    expect(screen.getByText(/Linked to ada@gmail.com/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Unlink/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // No change-password form without a current password.
    expect(screen.queryByLabelText("Current password")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Set a password/ }));
    expect(await screen.findByText(/We sent a link to ada@example.com/)).toBeTruthy();
    expect(api.last("POST /api/v1/account/password/setup")!.headers.get("x-csrf-token")).toBe(
      "csrf-tok",
    );
  });

  it("password set, Google linked: unlinks after confirmation", async () => {
    const api = mockFetch({
      ...base,
      "GET /api/v1/account/profile": profile({
        identities: [
          { provider: "google", email: "ada@gmail.com", linkedAt: "2026-11-01T00:00:00Z" },
        ],
      }),
      "DELETE /api/v1/account/identities/google": null,
    });
    renderWithClient(
      <>
        <SecuritySection />
        <ConfirmHost />
        <Toaster />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Unlink/ }));
    expect(await screen.findByText("Unlink Google?")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Unlink" });
    fireEvent.click(buttons.at(-1) as HTMLElement);
    await waitFor(() => expect(api.last("DELETE /api/v1/account/identities/google")).toBeTruthy());
  });

  it("shows the outcome of the Google round trip", async () => {
    window.history.replaceState(null, "", "/settings/security?google=taken");
    mockFetch({ ...base, "GET /api/v1/account/profile": profile() });
    renderWithClient(<SecuritySection />);
    expect(await screen.findByText(/already linked to another Glideworth account/)).toBeTruthy();
  });

  it("hides Google when the server does not offer it and nothing is linked", async () => {
    mockFetch({ ...base, "GET /api/v1/account/profile": profile({ googleSignIn: false }) });
    renderWithClient(<SecuritySection />);
    await screen.findByText("Sign-in methods");
    expect(screen.queryByRole("button", { name: /Link Google account/ })).toBeNull();
  });
});

describe("re-authentication without a password", () => {
  it("with an authenticator: asks for the code only", async () => {
    const api = mockFetch({ "POST /api/v1/auth/reauth": { status: "ok", csrfToken: "x" } });
    renderWithClient(<ReauthHost />, signedIn("owner", undefined, { password: false, totp: true }));
    let attempt = 0;
    const done = withReauth(async () => {
      if (++attempt === 1)
        throw new (await import("../src/lib/api-error")).ApiRequestError(
          403,
          "REAUTH_REQUIRED",
          "confirm",
        );
      return "ok";
    });
    const dialog = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(within(dialog).queryByLabelText("Password")).toBeNull();
    expect(within(dialog).queryByText(/Use my password instead/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Authenticator code"), {
      target: { value: "123456" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(await done).toBe("ok");
    expect(api.last("POST /api/v1/auth/reauth")!.body).toEqual({ totpCode: "123456" });
  });

  it("without an authenticator: offers the emailed link that sets a password", async () => {
    const api = mockFetch({
      "POST /api/v1/account/password/setup": () =>
        new Response(JSON.stringify({ status: "check-email" }), { status: 202 }),
    });
    renderWithClient(<ReauthHost />, signedIn("owner", undefined, { password: false }));
    const done = withReauth(async () => {
      throw new (await import("../src/lib/api-error")).ApiRequestError(403, "REAUTH_REQUIRED", "x");
    }).catch((e: unknown) => e);
    const dialog = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(within(dialog).getByText(/Signing in with Google does not count/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /Email me the link/ }));
    expect(await within(dialog).findByText("Check your email for the link.")).toBeTruthy();
    expect(api.last("POST /api/v1/account/password/setup")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect((await done) as Error).toBeInstanceOf(Error);
  });
});
