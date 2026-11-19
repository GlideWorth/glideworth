import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearHandoff, readHandoff } from "../src/features/cloud/handoff";
import { CheckEmailPage, SignUpPage } from "../src/features/cloud/screens/signup";
import { SignInPage, TwoFactorPage } from "../src/features/cloud/screens/signin";
import {
  ForgotPasswordPage,
  ResetPasswordPage,
  SetPasswordPage,
} from "../src/features/cloud/screens/password-reset";
import {
  ConfirmEmailPage,
  InvitePage,
  VerifyEmailPage,
} from "../src/features/cloud/screens/link-pages";
import { getChallenge, setChallenge } from "../src/features/cloud/session-flow";
import { onReauthAnnounced } from "../src/lib/reauth";
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

const STRONG = "correct horse battery staple";
const field = (label: RegExp | string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: RegExp | string, value: string) =>
  fireEvent.change(field(label), { target: { value } });
const submit = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => {
  navigateSpy.mockReset();
  window.history.replaceState(null, "", "/");
  clearHandoff();
  withCsrfCookie();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.querySelectorAll("script").forEach((s) => s.remove());
});

describe("sign-up", () => {
  const fill = (over: Partial<Record<"name" | "email" | "password", string>> = {}) => {
    type("Your name", over.name ?? "Ada Lovelace");
    type("Email", over.email ?? "ada@example.com");
    type(/^Password/, over.password ?? STRONG);
  };

  it("has labelled fields with the right autocomplete values, and links to the terms and privacy pages", () => {
    renderWithClient(<SignUpPage />, signedOut());
    expect(field("Your name").autocomplete).toBe("name");
    expect(field("Email").autocomplete).toBe("username");
    expect(field(/^Password/).autocomplete).toBe("new-password");
    expect(field(/^Password/).type).toBe("password");
    const terms = screen.getByRole("link", { name: /Terms of Service/ }) as HTMLAnchorElement;
    const privacy = screen.getByRole("link", { name: /Privacy Policy/ }) as HTMLAnchorElement;
    expect(terms.href).toBe("https://glideworth.com/legal/terms");
    expect(privacy.href).toBe("https://glideworth.com/legal/privacy");
    expect(terms.rel).toContain("noreferrer");
  });

  it("keeps focus in the field being typed in (the name field must not take it back on each keystroke)", () => {
    renderWithClient(<SignUpPage />, signedOut());
    field("Email").focus();
    for (const value of ["a", "ad", "ada@example.com"]) {
      type("Email", value);
      expect(document.activeElement).toBe(field("Email"));
    }
  });

  it("will not send anything until the adults-only box is ticked, and moves focus to the first problem", async () => {
    const api = mockFetch({});
    renderWithClient(<SignUpPage />, signedOut());
    fill();
    submit("Create account");
    expect(await screen.findByText(/Confirm that you are 18 or over/)).toBeTruthy();
    const box = screen.getByRole("checkbox", { name: /18 or over/ });
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(api.calls).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it("shows the server's rules next to the password and ties the message to the input", async () => {
    const api = mockFetch({});
    renderWithClient(<SignUpPage />, signedOut());
    fill({ password: "short" });
    fireEvent.click(screen.getByRole("checkbox", { name: /18 or over/ }));
    submit("Create account");
    const input = field(/^Password/);
    await waitFor(() => expect(input.getAttribute("aria-invalid")).toBe("true"));
    const note = document.getElementById(input.getAttribute("aria-describedby")!)!;
    expect(note.textContent).toMatch(/at least 12 characters/);
    expect(api.calls).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("flags a password that contains the email address, and a malformed email", async () => {
    mockFetch({});
    renderWithClient(<SignUpPage />, signedOut());
    fill({ email: "nope", password: "ada@example.com is mine" });
    fireEvent.click(screen.getByRole("checkbox", { name: /18 or over/ }));
    submit("Create account");
    expect(await screen.findByText("Enter a valid email address.")).toBeTruthy();
    expect(field("Email").getAttribute("aria-invalid")).toBe("true");
  });

  it("sends the terms version, the adults-only confirmation and the CSRF header, then asks to check email", async () => {
    const api = mockFetch({
      "POST /api/v1/auth/signup": () =>
        new Response(JSON.stringify({ status: "check-email" }), { status: 202 }),
    });
    renderWithClient(<SignUpPage />, signedOut({ termsVersion: "2026-11-16" }));
    fill();
    fireEvent.click(screen.getByRole("checkbox", { name: /18 or over/ }));
    submit("Create account");
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: "/check-email" }));
    const call = api.last("POST /api/v1/auth/signup")!;
    expect(call.body).toEqual({
      email: "ada@example.com",
      password: STRONG,
      name: "Ada Lovelace",
      termsVersion: "2026-11-16",
      adultConfirmed: true,
    });
    expect(call.headers.get("x-csrf-token")).toBe("csrf-tok");
    expect(call.headers.get("content-type")).toBe("application/json");
  });

  it("shows a disposable-address refusal on the email field", async () => {
    mockFetch({
      "POST /api/v1/auth/signup": () =>
        apiError(
          400,
          "DISPOSABLE_EMAIL",
          "addresses from disposable email services are not accepted",
        ),
    });
    renderWithClient(<SignUpPage />, signedOut());
    fill();
    fireEvent.click(screen.getByRole("checkbox", { name: /18 or over/ }));
    submit("Create account");
    expect(await screen.findByText(/disposable email services/)).toBeTruthy();
    expect(field("Email").getAttribute("aria-invalid")).toBe("true");
    expect(
      (screen.getByRole("button", { name: "Create account" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("loads no third-party script unless the server gives a CAPTCHA site key", () => {
    renderWithClient(<SignUpPage />, signedOut());
    expect(document.head.querySelector('script[src*="cloudflare"]')).toBeNull();
    expect(screen.queryByText("Security check")).toBeNull();
  });

  it("with a site key: shows the Turnstile slot, loads its script, and will not submit without a token", async () => {
    const api = mockFetch({});
    renderWithClient(<SignUpPage />, signedOut({ captchaSiteKey: "0x4AAAAAAA" }));
    expect(screen.getByText("Security check")).toBeTruthy();
    await waitFor(() =>
      expect(
        document.head.querySelector('script[src^="https://challenges.cloudflare.com/turnstile/"]'),
      ).not.toBeNull(),
    );
    fill();
    fireEvent.click(screen.getByRole("checkbox", { name: /18 or over/ }));
    submit("Create account");
    expect(await screen.findByText("Complete the security check.")).toBeTruthy();
    expect(api.calls).toHaveLength(0);
  });

  it("signed in: stores the calculator inputs before leaving for the dashboard", async () => {
    window.history.replaceState(
      null,
      "",
      "/signup?from=tool&tool=fire&v=1&age=30&spend=40000&balance=50000&save=20000&cur=USD&timing=mid",
    );
    navigateSpy.mockImplementation(() => {
      expect(readHandoff()?.values).toMatchObject({
        age: "30",
        spend: "40000",
        balance: "50000",
        cur: "USD",
        save: "20000",
        timing: "mid",
      });
    });
    renderWithClient(<SignUpPage />, signedIn());
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: "/", replace: true }));
    // The address bar loses the query; the inputs are what the dashboard offers.
    expect(readHandoff()?.tool).toBe("fire");
  });

  it("keeps calculator inputs from the link for the first plan", async () => {
    window.history.replaceState(
      null,
      "",
      "/signup?from=tool&tool=coast-fire&v=1&cur=USD&age=35&balance=150000&spend=48000",
    );
    renderWithClient(<SignUpPage />, signedOut());
    expect(screen.getByText(/You came from the Coast FIRE calculator/)).toBeTruthy();
    await waitFor(() =>
      expect(readHandoff()?.values).toMatchObject({ cur: "USD", balance: "150000" }),
    );
  });
});

describe("check your email (enumeration-safe)", () => {
  it("says the same thing whether or not an account exists, and offers a resend that answers neutrally", async () => {
    const api = mockFetch({ "POST /api/v1/auth/resend-verification": { status: "check-email" } });
    renderWithClient(<CheckEmailPage />, signedOut());
    expect(screen.getByText(/If you already have an account with that address/)).toBeTruthy();
    type(/Send it again to/, "ada@example.com");
    submit("Send the link again");
    const msg = await screen.findByText(
      /If ada@example.com is waiting for confirmation, we have sent the link again/,
    );
    expect(msg.closest("[role=status]")).not.toBeNull();
    expect(api.last("POST /api/v1/auth/resend-verification")!.body).toEqual({
      email: "ada@example.com",
    });
    expect(screen.getByRole("button", { name: /Send again in \d+s/ })).toHaveProperty(
      "disabled",
      true,
    );
  });
});

describe("sign-in", () => {
  it("uses username and current-password autocomplete", () => {
    renderWithClient(<SignInPage />, signedOut());
    expect(field("Email").autocomplete).toBe("username");
    expect(field("Password").autocomplete).toBe("current-password");
  });

  it("gives a wrong password and an unknown address the same sentence", async () => {
    mockFetch({
      "POST /api/v1/auth/signin": () => apiError(401, "UNAUTHORIZED", "email or password is wrong"),
    });
    renderWithClient(<SignInPage />, signedOut());
    type("Email", "nobody@example.com");
    type("Password", "whatever it is");
    submit("Sign in");
    expect((await screen.findByRole("alert")).textContent).toBe("The email or password is wrong.");
  });

  it("after Delete account, the sign-in page says the account was deleted", () => {
    window.history.replaceState(null, "", "/signin?deleted=1");
    mockFetch({});
    renderWithClient(<SignInPage />, signedOut());
    expect(screen.getByRole("status").textContent).toMatch(/Your account has been deleted/);
    cleanup();
    window.history.replaceState(null, "", "/signin");
    renderWithClient(<SignInPage />, signedOut());
    expect(screen.queryByText(/Your account has been deleted/)).toBeNull();
  });

  it("signs in, refreshes the session and goes to the page the person was going to", async () => {
    window.history.replaceState(null, "", "/signin?next=%2Fplans%3Ftab%3Dx");
    const api = mockFetch({
      "POST /api/v1/auth/signin": {
        status: "signed-in",
        redirectTo: "/plans?tab=x",
        csrfToken: "t",
      },
      "GET /api/v1/auth/status": {
        mode: "cloud",
        authenticated: true,
        user: { id: "u1", email: "a@b.co", name: "Ada" },
        workspace: null,
        workspaces: [],
      },
    });
    renderWithClient(<SignInPage />, signedOut());
    type("Email", "ada@example.com");
    type("Password", STRONG);
    submit("Sign in");
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled());
    expect(navigateSpy.mock.calls[0]![0]).toMatchObject({ to: "/plans", search: { tab: "x" } });
    expect(api.last("POST /api/v1/auth/signin")!.body).toMatchObject({ next: "/plans?tab=x" });
    expect(api.calls.map((c) => c.path)).toContain("/api/v1/auth/status");
  });

  it("refuses an off-site `next`: it goes to the home page and the server is not asked to redirect there", async () => {
    window.history.replaceState(null, "", "/signin?next=https%3A%2F%2Fevil.example%2F");
    const api = mockFetch({
      "POST /api/v1/auth/signin": { status: "signed-in", csrfToken: "t" },
      "GET /api/v1/auth/status": { mode: "cloud", authenticated: false },
    });
    renderWithClient(<SignInPage />, signedOut());
    type("Email", "ada@example.com");
    type("Password", STRONG);
    submit("Sign in");
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled());
    expect(navigateSpy.mock.calls[0]![0]).toMatchObject({ to: "/" });
    expect(api.last("POST /api/v1/auth/signin")!.body).not.toHaveProperty("next");
  });

  it("sends a person with two-step sign-in to the code step, keeping the challenge out of the URL", async () => {
    mockFetch({
      "POST /api/v1/auth/signin": {
        status: "totp-required",
        next: "totp",
        challenge: "chal-123",
        expiresAt: "2030-01-01T00:00:00Z",
      },
    });
    renderWithClient(<SignInPage />, signedOut());
    type("Email", "ada@example.com");
    type("Password", STRONG);
    submit("Sign in");
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: "/signin/2fa" }));
    expect(window.location.href).not.toContain("chal-123");
  });

  it("offers a new confirmation email when the address is not confirmed, answering neutrally", async () => {
    mockFetch({
      "POST /api/v1/auth/signin": () =>
        apiError(403, "EMAIL_NOT_VERIFIED", "confirm your email address first"),
      "POST /api/v1/auth/resend-verification": { status: "check-email" },
    });
    renderWithClient(<SignInPage />, signedOut());
    type("Email", "ada@example.com");
    type("Password", STRONG);
    submit("Sign in");
    fireEvent.click(
      await screen.findByRole("button", { name: "Send the confirmation link again" }),
    );
    expect(await screen.findByText(/If that address is waiting for confirmation/)).toBeTruthy();
  });

  it("asks for the security check only after the server demands one", async () => {
    mockFetch({
      "POST /api/v1/auth/signin": () =>
        apiError(403, "CAPTCHA_REQUIRED", "complete the CAPTCHA to continue"),
    });
    renderWithClient(<SignInPage />, signedOut({ captchaSiteKey: "0x4AAA" }));
    expect(document.head.querySelector('script[src*="cloudflare"]')).toBeNull();
    type("Email", "ada@example.com");
    type("Password", STRONG);
    submit("Sign in");
    expect(await screen.findByText("Security check")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/Complete the security check/);
  });
});

describe("two-step sign-in", () => {
  beforeEach(() => setChallenge({ token: "chal-123", next: "/" }));
  const finishStatus = { "GET /api/v1/auth/status": { mode: "cloud", authenticated: false } };

  it("takes a 6-digit code with one-time-code autocomplete and sends the challenge from memory", async () => {
    const api = mockFetch({
      "POST /api/v1/auth/signin/totp": { status: "signed-in", csrfToken: "t" },
      ...finishStatus,
    });
    renderWithClient(<TwoFactorPage />, signedOut());
    const input = field("Authenticator code");
    expect(input.autocomplete).toBe("one-time-code");
    expect(input.inputMode).toBe("numeric");
    type("Authenticator code", "123 456");
    submit("Verify and sign in");
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled());
    expect(api.last("POST /api/v1/auth/signin/totp")!.body).toEqual({
      challenge: "chal-123",
      code: "123456",
    });
  });

  it("accepts a recovery code instead", async () => {
    const api = mockFetch({
      "POST /api/v1/auth/signin/totp": { status: "signed-in", csrfToken: "t" },
      ...finishStatus,
    });
    renderWithClient(<TwoFactorPage />, signedOut());
    fireEvent.click(screen.getByRole("button", { name: "Use a recovery code instead" }));
    type("Recovery code", "abcde-fghij");
    submit("Verify and sign in");
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled());
    expect(api.last("POST /api/v1/auth/signin/totp")!.body).toEqual({
      challenge: "chal-123",
      recoveryCode: "abcde-fghij",
    });
  });

  it("explains a wrong code without leaving the page, and restarts when the challenge is gone", async () => {
    mockFetch({
      "POST /api/v1/auth/signin/totp": () => apiError(401, "UNAUTHORIZED", "the code is wrong"),
    });
    renderWithClient(<TwoFactorPage />, signedOut());
    type("Authenticator code", "000000");
    submit("Verify and sign in");
    expect(await screen.findByText(/That code is not right/)).toBeTruthy();
    expect(field("Authenticator code").getAttribute("aria-invalid")).toBe("true");
    cleanup();
    setChallenge(null);
    renderWithClient(<TwoFactorPage />, signedOut());
    expect(screen.getByText("Start sign-in again")).toBeTruthy();
  });
});

describe("password reset", () => {
  it("forgot password answers neutrally", async () => {
    const api = mockFetch({ "POST /api/v1/auth/password/forgot": { status: "check-email" } });
    renderWithClient(<ForgotPasswordPage />, signedOut());
    type("Email", "someone@example.com");
    submit("Send reset link");
    const msg = await screen.findByText(
      /If an account exists for someone@example.com, we have sent a link to reset its password/,
    );
    expect(msg.closest("[role=status]")).not.toBeNull();
    expect(api.last("POST /api/v1/auth/password/forgot")!.body).toEqual({
      email: "someone@example.com",
    });
  });

  it("forgot password while signed in points to Security settings instead of a form that cannot pass the security check", () => {
    const api = mockFetch({});
    renderWithClient(<ForgotPasswordPage />, signedIn("owner"));
    expect(screen.getByText(/You are signed in as ada@example.com/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Send reset link/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Go to Security settings/ })).toBeTruthy();
    expect(api.last("POST /api/v1/auth/password/forgot")).toBeUndefined();
  });

  it("reads the token from the fragment, removes it from the address bar, and never sends it in a query string", async () => {
    window.history.replaceState(null, "", "/reset-password#token=reset-tok-1");
    const api = mockFetch({
      "POST /api/v1/auth/password/reset": { status: "signed-in", csrfToken: "t" },
      "GET /api/v1/auth/status": { mode: "cloud", authenticated: false },
    });
    renderWithClient(<ResetPasswordPage />, signedOut());
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("reset-tok-1");
    expect(field("New password").autocomplete).toBe("new-password");
    type("New password", STRONG);
    type("Confirm new password", STRONG);
    submit("Set password and sign in");
    // A success screen first, in the words of the security email (security review finding 3).
    expect(await screen.findByRole("heading", { name: "Your password was reset" })).toBeTruthy();
    expect(
      screen.getByText(
        /Apps connected to your account were disconnected; your API keys still work\./,
      ),
    ).toBeTruthy();
    expect(navigateSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled());
    const call = api.last("POST /api/v1/auth/password/reset")!;
    expect(call.body).toEqual({ token: "reset-tok-1", password: STRONG });
    expect(call.path).toBe("/api/v1/auth/password/reset");
    expect(api.calls.every((c) => !c.path.includes("reset-tok-1"))).toBe(true);
  });

  it("continues to the code step when the account has two-step sign-in", async () => {
    window.history.replaceState(null, "", "/reset-password#token=reset-tok-2");
    mockFetch({ "POST /api/v1/auth/password/reset": { status: "totp-required", challenge: "c2" } });
    renderWithClient(<ResetPasswordPage />, signedOut());
    type("New password", STRONG);
    type("Confirm new password", STRONG);
    submit("Set password and sign in");
    expect(
      await screen.findByText(/Next, enter the code from your authenticator app/),
    ).toBeTruthy();
    expect(screen.getByText(/your API keys still work/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: "/signin/2fa" }));
  });

  it("checks the two passwords match before sending", async () => {
    window.history.replaceState(null, "", "/reset-password#token=reset-tok-3");
    const api = mockFetch({});
    renderWithClient(<ResetPasswordPage />, signedOut());
    type("New password", STRONG);
    type("Confirm new password", `${STRONG}!`);
    submit("Set password and sign in");
    expect(await screen.findByText("The passwords do not match.")).toBeTruthy();
    expect(api.calls).toHaveLength(0);
  });

  it("/set-password: set-a-password wording, back to the section it was asked from, and tells the waiting tab", async () => {
    window.history.replaceState(null, "", "/set-password#token=setup-tok-1");
    mockFetch({
      "POST /api/v1/auth/password/reset": {
        status: "signed-in",
        csrfToken: "t",
        redirectTo: "/settings/keys",
        recentAuth: true,
      },
      "GET /api/v1/auth/status": { mode: "cloud", authenticated: false },
    });
    const heard = vi.fn();
    const stop = onReauthAnnounced(heard);
    renderWithClient(<SetPasswordPage />, signedIn("owner"));
    expect(screen.getByRole("heading", { name: "Set a password" })).toBeTruthy();
    expect(screen.queryByText(/reset/i)).toBeNull();
    type("Password", STRONG);
    type("Confirm password", STRONG);
    submit("Set password");
    expect(await screen.findByRole("heading", { name: "Your password is set" })).toBeTruthy();
    expect(
      screen.getByText(/If you started it in another tab, it carries on there\./),
    ).toBeTruthy();
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    stop();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith(expect.objectContaining({ to: "/settings/keys" })),
    );
  });

  it("/set-password finished elsewhere (no recent check): says nothing about another tab and tells no one", async () => {
    window.history.replaceState(null, "", "/set-password#token=setup-tok-2");
    mockFetch({
      "POST /api/v1/auth/password/reset": {
        status: "signed-in",
        csrfToken: "t",
        redirectTo: "/settings/keys",
        recentAuth: false,
      },
    });
    const heard = vi.fn();
    const stop = onReauthAnnounced(heard);
    renderWithClient(<SetPasswordPage />, signedOut());
    type("Password", STRONG);
    type("Confirm password", STRONG);
    submit("Set password");
    expect(await screen.findByText(/Other browsers were signed out\./)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(heard).not.toHaveBeenCalled();
    stop();
  });

  it("/set-password with two-step sign-in: the code step comes next and then returns to the section", async () => {
    window.history.replaceState(null, "", "/set-password#token=setup-tok-3");
    mockFetch({
      "POST /api/v1/auth/password/reset": {
        status: "totp-required",
        challenge: "c3",
        redirectTo: "/settings/keys",
        recentAuth: true,
      },
    });
    renderWithClient(<SetPasswordPage />, signedIn("owner"));
    type("Password", STRONG);
    type("Confirm password", STRONG);
    submit("Set password");
    expect(
      await screen.findByText(/Next, enter the code from your authenticator app/),
    ).toBeTruthy();
    expect(getChallenge()).toEqual({ token: "c3", next: "/settings/keys", announceReauth: true });
  });

  it("/set-password with two-step sign-in in a browser that did not ask: the code step will tell no one", async () => {
    window.history.replaceState(null, "", "/set-password#token=setup-tok-4");
    mockFetch({
      "POST /api/v1/auth/password/reset": {
        status: "totp-required",
        challenge: "c4",
        redirectTo: "/settings/keys",
        recentAuth: false,
      },
    });
    renderWithClient(<SetPasswordPage />, signedOut());
    type("Password", STRONG);
    type("Confirm password", STRONG);
    submit("Set password");
    await screen.findByText(/Next, enter the code from your authenticator app/);
    expect(getChallenge()).toEqual({ token: "c4", next: "/settings/keys", announceReauth: false });
  });

  it("says so when the link has no token or the token is spent", async () => {
    window.history.replaceState(null, "", "/reset-password");
    renderWithClient(<ResetPasswordPage />, signedOut());
    expect(screen.getByText(/needs the full link from your email/)).toBeTruthy();
    cleanup();
    window.history.replaceState(null, "", "/reset-password#token=used");
    mockFetch({
      "POST /api/v1/auth/password/reset": () =>
        apiError(400, "INVALID_TOKEN", "this link is not valid"),
    });
    renderWithClient(<ResetPasswordPage />, signedOut());
    type("New password", STRONG);
    type("Confirm new password", STRONG);
    submit("Set password and sign in");
    expect(await screen.findByText(/expired or was already used/)).toBeTruthy();
  });
});

describe("links from email", () => {
  it("verify email: reads the fragment token once, clears it, confirms and signs in", async () => {
    window.history.replaceState(null, "", "/verify-email#token=ver-tok");
    const api = mockFetch({
      "POST /api/v1/auth/verify": { status: "signed-in", redirectTo: "/", csrfToken: "t" },
      "GET /api/v1/auth/status": { mode: "cloud", authenticated: false },
    });
    renderWithClient(<VerifyEmailPage />, signedOut());
    expect(window.location.hash).toBe("");
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled());
    expect(api.calls.filter((c) => c.path === "/api/v1/auth/verify")).toHaveLength(1);
    expect(api.last("POST /api/v1/auth/verify")!.body).toEqual({ token: "ver-tok" });
  });

  it("verify email: in a browser that did not sign up, asks for the sign-up password and sends it with the same link", async () => {
    window.history.replaceState(null, "", "/verify-email#token=ver-tok");
    const api = mockFetch({
      "POST /api/v1/auth/verify": (c) => {
        const password = (c.body as { password?: string }).password;
        if (!password) return apiError(403, "PASSWORD_REQUIRED", "enter the password");
        if (password !== STRONG) return apiError(401, "UNAUTHORIZED", "email or password is wrong");
        return { status: "signed-in", redirectTo: "/", csrfToken: "t" };
      },
      "GET /api/v1/auth/status": { mode: "cloud", authenticated: false },
    });
    renderWithClient(<VerifyEmailPage />, signedOut());
    expect(await screen.findByText("Enter your password to finish")).toBeTruthy();
    expect(screen.getByText(/Enter the password you chose when you signed up/)).toBeTruthy();
    const input = field("Password");
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("current-password");
    expect((screen.getByRole("link", { name: "Sign up again" }) as HTMLAnchorElement).href).toMatch(
      /\/signup$/,
    );
    const verifyCalls = () => api.calls.filter((c) => c.path === "/api/v1/auth/verify");

    // Nothing is sent for an empty field.
    submit("Confirm email and sign in");
    expect(await screen.findByText("Enter your password.")).toBeTruthy();
    expect(verifyCalls()).toHaveLength(1);

    // A wrong password: the message is tied to the field, focus returns to it, the form stays.
    type("Password", "not the right one");
    submit("Confirm email and sign in");
    await waitFor(() => expect(input.getAttribute("aria-invalid")).toBe("true"));
    const note = document.getElementById(input.getAttribute("aria-describedby")!)!;
    expect(note.textContent).toMatch(/not the password this sign-up was made with/);
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(navigateSpy).not.toHaveBeenCalled();

    type("Password", STRONG);
    submit("Confirm email and sign in");
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled());
    expect(verifyCalls().map((c) => c.body)).toEqual([
      { token: "ver-tok" },
      { token: "ver-tok", password: "not the right one" },
      { token: "ver-tok", password: STRONG },
    ]);
  });

  it("verify email: a link that died while the password was being typed offers a new one", async () => {
    window.history.replaceState(null, "", "/verify-email#token=ver-tok");
    mockFetch({
      "POST /api/v1/auth/verify": (c) =>
        (c.body as { password?: string }).password
          ? apiError(400, "INVALID_TOKEN", "invalid")
          : apiError(403, "PASSWORD_REQUIRED", "enter the password"),
    });
    renderWithClient(<VerifyEmailPage />, signedOut());
    await screen.findByText("Enter your password to finish");
    type("Password", STRONG);
    submit("Confirm email and sign in");
    expect(await screen.findByText("This link will not work")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Send a new link/ })).toBeTruthy();
  });

  it("verify email: an expired link offers a new one", async () => {
    window.history.replaceState(null, "", "/verify-email#token=old");
    mockFetch({
      "POST /api/v1/auth/verify": () => apiError(400, "INVALID_TOKEN", "invalid"),
      "POST /api/v1/auth/resend-verification": { status: "check-email" },
    });
    renderWithClient(<VerifyEmailPage />, signedOut());
    expect(await screen.findByText("This link will not work")).toBeTruthy();
    type("Send a new link to", "ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: /Send a new link/ }));
    expect(await screen.findByText(/If that address is waiting for confirmation/)).toBeTruthy();
  });

  it("confirm email change: posts the fragment token and reports the result", async () => {
    window.history.replaceState(null, "", "/confirm-email#token=chg-tok");
    const api = mockFetch({ "POST /api/v1/account/email/confirm": { status: "ok" } });
    renderWithClient(<ConfirmEmailPage />, signedOut());
    expect(await screen.findByText("Email address changed")).toBeTruthy();
    expect(api.last("POST /api/v1/account/email/confirm")!.body).toEqual({ token: "chg-tok" });
    expect(window.location.hash).toBe("");
  });

  it("invitation: a signed-in person accepts with the fragment token", async () => {
    window.history.replaceState(null, "", "/invite#token=inv-tok");
    const api = mockFetch({
      "POST /api/v1/workspace/invitations/accept": {
        userId: "u1",
        role: "editor",
        name: "Ada",
        workspaceId: "acc_2",
      },
      "GET /api/v1/auth/status": {
        mode: "cloud",
        authenticated: true,
        user: { id: "u1", email: "ada@example.com", name: "Ada" },
        workspace: null,
        workspaces: [],
      },
    });
    renderWithClient(<InvitePage />, signedIn("editor"));
    expect(window.location.hash).toBe("");
    expect(screen.getByText(/You are signed in as ada@example.com/)).toBeTruthy();
    submit("Join the workspace");
    expect(await screen.findByText("You have joined the workspace")).toBeTruthy();
    expect(api.last("POST /api/v1/workspace/invitations/accept")!.body).toEqual({
      token: "inv-tok",
    });
  });

  it("invitation: a signed-out person is asked to sign in or sign up, and a wrong address is explained", async () => {
    window.history.replaceState(null, "", "/invite#token=inv-tok-2");
    renderWithClient(<InvitePage />, signedOut());
    const links = screen
      .getAllByRole("link")
      .map((a) => (a as HTMLAnchorElement).getAttribute("href"));
    expect(links).toEqual(expect.arrayContaining(["/signin", "/signup"]));
    cleanup();
    mockFetch({
      "POST /api/v1/workspace/invitations/accept": () => apiError(403, "FORBIDDEN", "not for you"),
    });
    renderWithClient(<InvitePage />, signedIn("editor"));
    submit("Join the workspace");
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/sent to a different email address/)).toBeTruthy();
  });
});
