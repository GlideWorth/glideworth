import { randomBytes, scryptSync } from "node:crypto";
import { render } from "@glideworth/email";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeEmail } from "../src/accounts/email.js";
import { staticCaptcha } from "../src/abuse/captcha.js";
import { memoryRateLimiter } from "../src/abuse/rate-limiter.js";
import { ACCOUNT_LIMITS, ACCOUNT_TTL, AccountsService } from "../src/accounts/service.js";
import {
  accounts,
  knownDevices,
  memberships,
  recoveryCodes,
  sessions,
  users,
  userTokens,
} from "../src/control/schema.js";
import { sha256Hex } from "../src/crypto/random.js";
import { CloudError } from "../src/errors.js";
import type { SessionContext } from "../src/types.js";
import {
  assertAuditClean,
  auditRows,
  ctxOf,
  type Env,
  logLines,
  makeEnv,
  newEmail,
  newPassword,
  remember,
  signUpVerified,
  totpNow,
  userRow,
} from "./helpers.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

async function code(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    if (typeof p === "function") p();
    else await p;
  } catch (e) {
    if (e instanceof CloudError) return e.code;
    throw e;
  }
  return undefined;
}

let env: Env;
beforeEach(() => {
  env = makeEnv();
});
afterEach(async () => {
  await env.accounts.settled();
  assertAuditClean(env.db);
  env.close();
});

/** The `__Host-gw_signup` cookie value of the browser most tests sign up and verify in. */
const BROWSER = randomBytes(32).toString("base64url");
const sameBrowser = { browser: BROWSER };
const otherBrowser = () => ({ browser: randomBytes(32).toString("base64url") });

const signUpInput = (email: string, password: string, browser: string | null = BROWSER) => ({
  browser,
  email,
  password,
  name: "Sam Example",
  captchaToken: "captcha-ok",
  termsVersion: "2026-11",
  adultConfirmed: true,
});

/** Enable TOTP for a signed-in, recently authenticated user; returns the secret and recovery codes. */
async function enableTotp(ctx: SessionContext) {
  const { secret } = env.accounts.beginTotp(ctx);
  remember(secret);
  const { recoveryCodes } = env.accounts.confirmTotp(ctx, totpNow(env, secret));
  for (const c of recoveryCodes) remember(c);
  env.advance(30_000); // the enrolment code's step is spent
  return { secret, recoveryCodes };
}

async function median(fn: () => Promise<unknown>, n = 5): Promise<number> {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn().catch(() => {});
    xs.push(performance.now() - t);
  }
  return xs.sort((a, b) => a - b)[Math.floor(n / 2)] as number;
}

// =================================================================================================== sign-up
describe("sign-up and verification", () => {
  it("creates an unverified user, mails a verification link, and verifying creates the workspace and signs in", async () => {
    const email = newEmail();
    const password = newPassword();
    await env.accounts.signUp(signUpInput(email, password), env.meta());
    await env.accounts.settled();
    const u = userRow(env.db, email);
    expect(u?.emailVerifiedAt).toBeNull();
    expect(u?.passwordHash).toMatch(/^scrypt\$32768\$8\$1\$/);
    const mail = env.mailer.last(email, "verify-email");
    expect(mail?.data.url).toMatch(/^https:\/\/app\.example\.test\/verify-email#token=/);
    expect(mail?.data.expiresInHours).toBe(48);
    // Only the hash of the token is stored.
    const token = env.mailer.token(email, "verify-email");
    const stored = env.db.select().from(userTokens).all();
    expect(stored.map((r) => r.tokenHash)).toContain(sha256Hex(token));
    expect(JSON.stringify(stored)).not.toContain(token);

    const v = await env.accounts.verifyEmail(token, env.meta(), sameBrowser);
    expect(v.accountId).toMatch(/^t[a-z2-7]{15}$/);
    expect(env.workspaces.created).toEqual([v.accountId]);
    expect(v.session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(v.session.maxAgeSeconds).toBe(30 * 24 * 3600);
    expect(v.session.newDeviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ctx = ctxOf(env, v.session.token);
    expect(ctx).toMatchObject({
      userId: v.userId,
      activeAccountId: v.accountId,
      mfa: false,
      reauthAt: null,
    });
    expect(userRow(env.db, email)?.emailVerifiedAt).not.toBeNull();
    const events = auditRows(env.db).map((r) => r.event);
    expect(events).toEqual(expect.arrayContaining(["user.signup", "user.email_verified"]));
  });

  it("verification links are single use, expire after 48 hours, and are purpose-bound", async () => {
    const email = newEmail();
    await env.accounts.signUp(signUpInput(email, newPassword()), env.meta());
    await env.accounts.settled();
    const token = env.mailer.token(email, "verify-email");
    await env.accounts.verifyEmail(token, env.meta(), sameBrowser);
    expect(await code(env.accounts.verifyEmail(token, env.meta(), sameBrowser))).toBe(
      "INVALID_TOKEN",
    );

    const email2 = newEmail();
    await env.accounts.signUp(signUpInput(email2, newPassword()), env.meta());
    await env.accounts.settled();
    const token2 = env.mailer.token(email2, "verify-email");
    env.advance(48 * HOUR + 1);
    expect(await code(env.accounts.verifyEmail(token2, env.meta(), sameBrowser))).toBe(
      "INVALID_TOKEN",
    );
    expect(userRow(env.db, email2)?.emailVerifiedAt).toBeNull();

    for (const bad of ["", "x", `${token}x`, "A".repeat(43), "' OR 1=1 --"])
      expect(await code(env.accounts.verifyEmail(bad, env.meta(), sameBrowser))).toBe(
        "INVALID_TOKEN",
      );
  });

  it("concurrent claims of one verification link: exactly one wins", async () => {
    const email = newEmail();
    await env.accounts.signUp(signUpInput(email, newPassword()), env.meta());
    await env.accounts.settled();
    const token = env.mailer.token(email, "verify-email");
    const results = await Promise.allSettled([
      env.accounts.verifyEmail(token, env.meta(), sameBrowser),
      env.accounts.verifyEmail(token, env.meta(), sameBrowser),
      env.accounts.verifyEmail(token, env.meta(), sameBrowser),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(env.workspaces.created).toHaveLength(1);
  });

  it("does not reveal an existing address: same result, and the owner gets a different email", async () => {
    const { email } = await signUpVerified(env);
    const before = env.db.select().from(users).all().length;
    const res = await env.accounts.signUp(
      signUpInput(email.toUpperCase(), newPassword()),
      env.meta(),
    );
    expect(res).toBeUndefined();
    await env.accounts.settled();
    expect(env.db.select().from(users).all()).toHaveLength(before);
    expect(env.mailer.last(email, "signup-existing-account")).toBeDefined();
    expect(env.mailer.to(email, "verify-email")).toHaveLength(1); // only the original
  });

  it("sign-up timing does not depend on whether the address exists (same scrypt work)", async () => {
    const { email } = await signUpVerified(env);
    const known = await median(() =>
      env.accounts.signUp(signUpInput(email, newPassword()), env.meta()),
    );
    const unknown = await median(() =>
      env.accounts.signUp(signUpInput(newEmail(), newPassword()), env.meta()),
    );
    expect(Math.abs(known - unknown)).toBeLessThan(Math.max(known, unknown) * 0.5 + 15);
  });

  it("a newer sign-up replaces an unverified one: the older link dies, the newer password counts", async () => {
    const email = newEmail();
    const squatter = newPassword();
    const owner = newPassword();
    await env.accounts.signUp(signUpInput(email, squatter), env.meta());
    await env.accounts.settled();
    const oldToken = env.mailer.token(email, "verify-email");
    await env.accounts.signUp(signUpInput(email, owner), env.meta());
    await env.accounts.settled();
    const newToken = env.mailer.token(email, "verify-email");
    expect(await code(env.accounts.verifyEmail(oldToken, env.meta(), sameBrowser))).toBe(
      "INVALID_TOKEN",
    );
    await env.accounts.verifyEmail(newToken, env.meta(), sameBrowser);
    expect(await code(env.accounts.signIn({ email, password: squatter }, env.meta()))).toBe(
      "UNAUTHORIZED",
    );
    expect((await env.accounts.signIn({ email, password: owner }, env.meta())).kind).toBe(
      "signed-in",
    );
  });

  it("the link alone verifies only in the browser that signed up; any other browser needs the password", async () => {
    const email = newEmail();
    const password = newPassword();
    await env.accounts.signUp(signUpInput(email, password), env.meta());
    await env.accounts.settled();
    const token = env.mailer.token(email, "verify-email");
    // Only the hash of the browser value is stored with the token.
    const stored = env.db.select().from(userTokens).all();
    expect(stored[0]?.payload).toMatchObject({ browser: sha256Hex(BROWSER) });
    expect(JSON.stringify(stored)).not.toContain(BROWSER);

    // No cookie, another browser's cookie, a malformed one: the password is asked for.
    for (const proof of [{}, { browser: null }, otherBrowser(), { browser: "x" }, { password: "" }])
      expect(await code(env.accounts.verifyEmail(token, env.meta(), proof))).toBe(
        "PASSWORD_REQUIRED",
      );
    // A wrong password answers like a wrong sign-in and does not use the link up.
    const wrong = env.accounts
      .verifyEmail(token, env.meta(), { ...otherBrowser(), password: newPassword() })
      .catch((e) => e);
    expect(await wrong).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect((await wrong).message).toBe(
      (await env.accounts.signIn({ email, password: newPassword() }, env.meta()).catch((e) => e))
        .message,
    );
    expect(userRow(env.db, email)?.emailVerifiedAt).toBeNull();
    expect(env.workspaces.created).toHaveLength(0);
    expect(auditRows(env.db).map((r) => r.event)).toContain("user.signin_failed");
    // The right password verifies and signs in, from any browser.
    const v = await env.accounts.verifyEmail(token, env.meta(), { ...otherBrowser(), password });
    expect(ctxOf(env, v.session.token).userId).toBe(v.userId);
    expect(userRow(env.db, email)?.emailVerifiedAt).not.toBeNull();
    expect(await code(env.accounts.verifyEmail(token, env.meta(), sameBrowser))).toBe(
      "INVALID_TOKEN",
    );
  });

  it("a link that is not live says INVALID_TOKEN whatever else is sent (nothing about the account)", async () => {
    const email = newEmail();
    const password = newPassword();
    await env.accounts.signUp(signUpInput(email, password), env.meta());
    await env.accounts.settled();
    const token = env.mailer.token(email, "verify-email");
    env.advance(48 * HOUR + 1);
    for (const proof of [{}, sameBrowser, { password }, { password: newPassword() }])
      for (const t of [token, remember(randomBytes(32).toString("base64url"))])
        expect(await code(env.accounts.verifyEmail(t, env.meta(), proof))).toBe("INVALID_TOKEN");
  });

  it("sign-up squatting: the person who follows the squatter's newer link is asked for a password they do not know", async () => {
    const email = newEmail();
    const victimPassword = newPassword();
    const attackerPassword = newPassword();
    const victim = otherBrowser();
    const attacker = otherBrowser();
    await env.accounts.signUp(signUpInput(email, victimPassword, victim.browser), env.meta());
    await env.accounts.settled();
    const first = env.mailer.token(email, "verify-email");
    // The attacker repeats the sign-up: newest wins, so the password is now theirs and the first link dies.
    await env.accounts.signUp(signUpInput(email, attackerPassword, attacker.browser), env.meta());
    await env.accounts.settled();
    const second = env.mailer.token(email, "verify-email");
    expect(await code(env.accounts.verifyEmail(first, env.meta(), victim))).toBe("INVALID_TOKEN");
    // The victim follows the newer link in their own browser: not verified, not signed in.
    expect(await code(env.accounts.verifyEmail(second, env.meta(), victim))).toBe(
      "PASSWORD_REQUIRED",
    );
    expect(
      await code(
        env.accounts.verifyEmail(second, env.meta(), { ...victim, password: victimPassword }),
      ),
    ).toBe("UNAUTHORIZED");
    expect(userRow(env.db, email)?.emailVerifiedAt).toBeNull();
    // The attacker has the password but not the inbox: no verified account to sign in to.
    expect(await code(env.accounts.signIn({ email, password: attackerPassword }, env.meta()))).toBe(
      "EMAIL_NOT_VERIFIED",
    );
    // A resend, whoever asks, keeps the binding to the browser that set the current password.
    await env.accounts.resendVerification(email, env.meta());
    await env.accounts.settled();
    const resent = env.mailer.token(email, "verify-email");
    expect(resent).not.toBe(second);
    expect(await code(env.accounts.verifyEmail(resent, env.meta(), victim))).toBe(
      "PASSWORD_REQUIRED",
    );
    // The victim signs up again (the squatter cannot block them) and their own link works at once.
    await env.accounts.signUp(signUpInput(email, victimPassword, victim.browser), env.meta());
    await env.accounts.settled();
    const mine = env.mailer.token(email, "verify-email");
    expect(await code(env.accounts.verifyEmail(resent, env.meta(), attacker))).toBe(
      "INVALID_TOKEN",
    );
    await env.accounts.verifyEmail(mine, env.meta(), victim);
    expect(await code(env.accounts.signIn({ email, password: attackerPassword }, env.meta()))).toBe(
      "UNAUTHORIZED",
    );
    expect((await env.accounts.signIn({ email, password: victimPassword }, env.meta())).kind).toBe(
      "signed-in",
    );
  });

  it("a resent link still opens without the password in the browser that signed up, and only there", async () => {
    const email = newEmail();
    const password = newPassword();
    await env.accounts.signUp(signUpInput(email, password), env.meta());
    await env.accounts.settled();
    await env.accounts.resendVerification(email, env.meta());
    await env.accounts.settled();
    const token = env.mailer.token(email, "verify-email");
    expect(await code(env.accounts.verifyEmail(token, env.meta(), otherBrowser()))).toBe(
      "PASSWORD_REQUIRED",
    );
    await env.accounts.verifyEmail(token, env.meta(), sameBrowser);
    expect(userRow(env.db, email)?.emailVerifiedAt).not.toBeNull();
  });

  it("password guesses through a verification link share the sign-in limits (CAPTCHA, never a lock-out)", async () => {
    const email = newEmail();
    const password = newPassword();
    await env.accounts.signUp(signUpInput(email, password), env.meta());
    await env.accounts.settled();
    const token = env.mailer.token(email, "verify-email");
    const meta = env.meta();
    const [limit] = ACCOUNT_LIMITS.signinAddressIp;
    // Asking what is needed costs nothing.
    for (let i = 0; i < limit + 2; i++)
      expect(await code(env.accounts.verifyEmail(token, meta, {}))).toBe("PASSWORD_REQUIRED");
    // Two guesses at sign-in and the rest here count together.
    for (let i = 0; i < 2; i++)
      expect(await code(env.accounts.signIn({ email, password: newPassword() }, meta))).toBe(
        "UNAUTHORIZED",
      );
    for (let i = 2; i < limit; i++)
      expect(await code(env.accounts.verifyEmail(token, meta, { password: newPassword() }))).toBe(
        "UNAUTHORIZED",
      );
    // Now even the right password needs a CAPTCHA from this client, here and at sign-in.
    expect(await code(env.accounts.verifyEmail(token, meta, { password }))).toBe(
      "CAPTCHA_REQUIRED",
    );
    expect(
      await code(env.accounts.verifyEmail(token, meta, { password, captchaToken: "bad" })),
    ).toBe("CAPTCHA_REQUIRED");
    expect(await code(env.accounts.signIn({ email, password }, meta))).toBe("CAPTCHA_REQUIRED");
    expect(userRow(env.db, email)?.emailVerifiedAt).toBeNull();
    // The browser that signed up is not asked for a password, so it is never throttled; and with the
    // CAPTCHA the link still works for the right password.
    const v = await env.accounts.verifyEmail(token, meta, { password, captchaToken: "captcha-ok" });
    expect(ctxOf(env, v.session.token).userId).toBe(v.userId);
  });

  it("normalises addresses consistently (case, whitespace, NFKC, IDNA domain)", async () => {
    expect(normalizeEmail("  Jane.Doe@EXAMPLE.org ")).toBe("jane.doe@example.org");
    expect(normalizeEmail("ｊａｎｅ@ｅｘａｍｐｌｅ.org")).toBe("jane@example.org");
    expect(normalizeEmail("a@BÜCHER.example")).toBe("a@xn--bcher-kva.example");
    expect(normalizeEmail("a@xn--bcher-kva.example")).toBe("a@xn--bcher-kva.example");
    expect(normalizeEmail("jane+tag@example.org")).toBe("jane+tag@example.org");
    for (const bad of [
      "",
      "no-at",
      "a@b",
      "a@@b.org",
      "a b@c.org",
      "a@b.org\r\nBcc: x@y.org",
      "<a@b.org>",
      ".a@b.org",
      "a@-b.org",
    ])
      expect(normalizeEmail(bad)).toBeNull();

    const { email } = await signUpVerified(env, { email: remember("Ｍixed.Case@Example.ORG") });
    expect(userRow(env.db, email)?.emailNormalized).toBe("mixed.case@example.org");
    await env.accounts.signUp(signUpInput("mixed.case@example.org", newPassword()), env.meta());
    await env.accounts.settled();
    expect(
      env.db.select().from(users).where(eq(users.emailNormalized, "mixed.case@example.org")).all(),
    ).toHaveLength(1);
    const r = await env.accounts
      .signIn({ email: " MIXED.case@example.org", password: "wrong password here" }, env.meta())
      .catch((e) => e);
    expect((r as CloudError).code).toBe("UNAUTHORIZED");
  });

  it("refuses disposable domains, weak passwords, bad input, and requires the CAPTCHA", async () => {
    expect(
      await code(
        env.accounts.signUp(signUpInput(remember("x@mailinator.com"), newPassword()), env.meta()),
      ),
    ).toBe("DISPOSABLE_EMAIL");
    expect(await code(env.accounts.signUp(signUpInput(newEmail(), "short"), env.meta()))).toBe(
      "WEAK_PASSWORD",
    );
    expect(
      await code(env.accounts.signUp(signUpInput(newEmail(), "x".repeat(1025)), env.meta())),
    ).toBe("WEAK_PASSWORD");
    expect(
      await code(env.accounts.signUp(signUpInput("not-an-address", newPassword()), env.meta())),
    ).toBe("VALIDATION");
    expect(
      await code(
        env.accounts.signUp({ ...signUpInput(newEmail(), newPassword()), name: "" }, env.meta()),
      ),
    ).toBe("VALIDATION");
    expect(
      await code(
        env.accounts.signUp(
          { ...signUpInput(newEmail(), newPassword()), termsVersion: "" },
          env.meta(),
        ),
      ),
    ).toBe("VALIDATION");
    expect(
      await code(
        env.accounts.signUp(
          { ...signUpInput(newEmail(), newPassword()), captchaToken: "wrong" },
          env.meta(),
        ),
      ),
    ).toBe("CAPTCHA_REQUIRED");
    expect(env.db.select().from(users).all()).toHaveLength(0);
  });

  it("limits sign-ups per IP (5 per hour) and per network", async () => {
    const meta = env.meta({ ip: "203.0.113.50" });
    for (let i = 0; i < 5; i++)
      await env.accounts.signUp(signUpInput(newEmail(), newPassword()), meta);
    expect(await code(env.accounts.signUp(signUpInput(newEmail(), newPassword()), meta))).toBe(
      "RATE_LIMITED",
    );
    // Same /24, other addresses: allowed until the network limit.
    expect(
      await code(
        env.accounts.signUp(
          signUpInput(newEmail(), newPassword()),
          env.meta({ ip: "203.0.113.51" }),
        ),
      ),
    ).toBeUndefined();
  });

  it("resend is enumeration-safe and a new link supersedes the old one", async () => {
    const email = newEmail();
    await env.accounts.signUp(signUpInput(email, newPassword()), env.meta());
    await env.accounts.settled();
    const first = env.mailer.token(email, "verify-email");
    expect(await env.accounts.resendVerification(email, env.meta())).toBeUndefined();
    expect(await env.accounts.resendVerification(newEmail(), env.meta())).toBeUndefined();
    expect(await env.accounts.resendVerification("garbage", env.meta())).toBeUndefined();
    await env.accounts.settled();
    const second = env.mailer.token(email, "verify-email");
    expect(second).not.toBe(first);
    expect(await code(env.accounts.verifyEmail(first, env.meta(), sameBrowser))).toBe(
      "INVALID_TOKEN",
    );
    await env.accounts.verifyEmail(second, env.meta(), sameBrowser);
    // Verified: resend sends nothing more.
    const n = env.mailer.to(email).length;
    await env.accounts.resendVerification(email, env.meta());
    await env.accounts.settled();
    expect(env.mailer.to(email)).toHaveLength(n);
  });

  it("mail-bombing guard: at most 5 account emails per address per hour", async () => {
    const email = newEmail();
    await env.accounts.signUp(signUpInput(email, newPassword()), env.meta());
    for (let i = 0; i < 10; i++) await env.accounts.resendVerification(email, env.meta());
    await env.accounts.settled();
    expect(env.mailer.to(email)).toHaveLength(5);
    env.advance(HOUR + 1);
    await env.accounts.resendVerification(email, env.meta());
    await env.accounts.settled();
    expect(env.mailer.to(email)).toHaveLength(6);
    expect(logLines.some((l) => l.includes("accounts.mail_throttled"))).toBe(true);
  });

  it("an invitee who signs up gets no workspace (and so no trial) of their own", async () => {
    const owner = await signUpVerified(env);
    const inviteeEmail = newEmail("invitee");
    await env.workspaces.invite(owner.ctx, inviteeEmail, "editor");
    const v = await signUpVerified(env, { email: inviteeEmail });
    expect(v.accountId).toBeNull();
    expect(env.workspaces.created).toHaveLength(1);
  });

  it("a failing workspace creation still verifies and signs in (no-workspace state)", async () => {
    env.workspaces.create = async () => {
      throw new Error("disk full");
    };
    const v = await signUpVerified(env);
    expect(v.accountId).toBeNull();
    expect(v.ctx.activeAccountId).toBeNull();
    expect(logLines.some((l) => l.includes("accounts.workspace_create_failed"))).toBe(true);
  });
});

// ===================================================================================== sign-up from an invitation
describe("sign-up from an invitation (QA 13)", () => {
  async function invited(role: "editor" | "viewer" = "viewer") {
    const owner = await signUpVerified(env, { name: "Olive Owner" });
    const email = newEmail("invitee");
    const view = await env.workspaces.invite(owner.ctx, email, role);
    await env.accounts.settled();
    return { owner, email, view, invitation: env.mailer.token(email, "invitation") };
  }

  it("confirming the address hands back the invitation the sign-up came from, sealed while it waits", async () => {
    const { email, invitation } = await invited();
    await env.accounts.signUp({ ...signUpInput(email, newPassword()), invitation }, env.meta());
    await env.accounts.settled();
    // Never stored in the clear.
    expect(JSON.stringify(env.db.select().from(userTokens).all())).not.toContain(invitation);
    const v = await env.accounts.verifyEmail(
      env.mailer.token(email, "verify-email"),
      env.meta(),
      sameBrowser,
    );
    expect(v.invitation).toBe(invitation);
    expect(v.accountId).toBeNull(); // an invitee gets no workspace of their own
    // The token still accepts.
    const m = await env.workspaces.acceptInvitation(ctxOf(env, v.session.token), invitation);
    expect(m.role).toBe("viewer");
  });

  it("survives a resend and a verification in another browser (with the password)", async () => {
    const { email, invitation } = await invited("editor");
    const password = newPassword();
    await env.accounts.signUp({ ...signUpInput(email, password), invitation }, env.meta());
    await env.accounts.resendVerification(email, env.meta());
    await env.accounts.settled();
    const v = await env.accounts.verifyEmail(env.mailer.token(email, "verify-email"), env.meta(), {
      ...otherBrowser(),
      password,
    });
    expect(v.invitation).toBe(invitation);
  });

  it("hands back nothing for an invitation to another address, a withdrawn one, a made-up token or none", async () => {
    const a = await invited();
    // Someone else's invitation: signing up with a different address.
    const stranger = newEmail("stranger");
    await env.accounts.signUp(
      { ...signUpInput(stranger, newPassword()), invitation: a.invitation },
      env.meta(),
    );
    await env.accounts.settled();
    const s = await env.accounts.verifyEmail(
      env.mailer.token(stranger, "verify-email"),
      env.meta(),
      sameBrowser,
    );
    expect(s.invitation).toBeNull();

    // Withdrawn between sign-up and confirmation.
    const b = await invited();
    await env.accounts.signUp(
      { ...signUpInput(b.email, newPassword()), invitation: b.invitation },
      env.meta(),
    );
    await env.accounts.settled();
    env.workspaces.revokeInvitation(b.owner.ctx, b.view.id);
    const w = await env.accounts.verifyEmail(
      env.mailer.token(b.email, "verify-email"),
      env.meta(),
      sameBrowser,
    );
    expect(w.invitation).toBeNull();

    // A made-up token is ignored (the sign-up answers as usual), and so is no token.
    for (const invitation of ["x".repeat(43), "not a token", undefined]) {
      const e = newEmail();
      await env.accounts.signUp({ ...signUpInput(e, newPassword()), invitation }, env.meta());
      await env.accounts.settled();
      const r = await env.accounts.verifyEmail(
        env.mailer.token(e, "verify-email"),
        env.meta(),
        sameBrowser,
      );
      expect(r.invitation).toBeNull();
    }
  });
});

// =================================================================================================== sign-in
describe("sign-in", () => {
  it("unknown address and wrong password give the same error; timing is in the same class (dummy hash)", async () => {
    const { email } = await signUpVerified(env);
    const a = await env.accounts
      .signIn({ email, password: "definitely wrong pw" }, env.meta())
      .catch((e) => e);
    const b = await env.accounts
      .signIn({ email: newEmail(), password: "definitely wrong pw" }, env.meta())
      .catch((e) => e);
    expect(a).toBeInstanceOf(CloudError);
    expect(b).toBeInstanceOf(CloudError);
    expect({ s: a.status, c: a.code, m: a.message }).toEqual({
      s: b.status,
      c: b.code,
      m: b.message,
    });
    expect(a.status).toBe(401);

    const known = await median(() =>
      env.accounts.signIn({ email, password: "definitely wrong pw" }, env.meta()),
    );
    const unknown = await median(() =>
      env.accounts.signIn({ email: newEmail(), password: "definitely wrong pw" }, env.meta()),
    );
    // Both cost one scrypt (tens of ms); without the dummy hash the unknown case would take well under 1 ms.
    expect(unknown).toBeGreaterThan(known * 0.5);
    expect(Math.abs(known - unknown)).toBeLessThan(Math.max(known, unknown) * 0.5 + 15);
  });

  it("correct password but unverified: EMAIL_NOT_VERIFIED; wrong password unverified: UNAUTHORIZED", async () => {
    const email = newEmail();
    const password = newPassword();
    await env.accounts.signUp(signUpInput(email, password), env.meta());
    expect(await code(env.accounts.signIn({ email, password }, env.meta()))).toBe(
      "EMAIL_NOT_VERIFIED",
    );
    expect(
      await code(env.accounts.signIn({ email, password: "not the password" }, env.meta())),
    ).toBe("UNAUTHORIZED");
  });

  it("disabled users cannot sign in and their sessions stop resolving", async () => {
    const { email, password, session } = await signUpVerified(env);
    env.db
      .update(users)
      .set({ disabledAt: env.now().toISOString() })
      .where(eq(users.emailNormalized, email))
      .run();
    expect(await code(env.accounts.signIn({ email, password }, env.meta()))).toBe("UNAUTHORIZED");
    expect(env.accounts.resolveSession(session.token)).toBeNull();
  });

  it("issues a new session each time, with a fresh CSRF token, and stores only hashes", async () => {
    const { email, password } = await signUpVerified(env);
    const r1 = await env.accounts.signIn({ email, password }, env.meta());
    const r2 = await env.accounts.signIn({ email, password }, env.meta());
    if (r1.kind !== "signed-in" || r2.kind !== "signed-in") throw new Error("expected sessions");
    remember(r1.session.token);
    remember(r2.session.token);
    expect(r1.session.token).not.toBe(r2.session.token);
    expect(r1.session.csrf).not.toBe(r2.session.csrf);
    const ids = env.db
      .select({ id: sessions.id })
      .from(sessions)
      .all()
      .map((r) => r.id);
    expect(ids).toContain(sha256Hex(r1.session.token));
    expect(ids).not.toContain(r1.session.token);
    const ctx = ctxOf(env, r1.session.token);
    expect(ctx.reauthAt).not.toBeNull(); // a password sign-in counts as a fresh authentication
  });

  it("throttling escalates to CAPTCHA, never to a lock-out", async () => {
    const { email, password } = await signUpVerified(env);
    const meta = env.meta({ ip: "192.0.2.77" });
    const [limit] = ACCOUNT_LIMITS.signinAddressIp;
    for (let i = 0; i < limit; i++)
      expect(await code(env.accounts.signIn({ email, password: "wrong password!!" }, meta))).toBe(
        "UNAUTHORIZED",
      );
    // Even the right password now needs a CAPTCHA from this client...
    expect(await code(env.accounts.signIn({ email, password }, meta))).toBe("CAPTCHA_REQUIRED");
    expect(await code(env.accounts.signIn({ email, password, captchaToken: "bad" }, meta))).toBe(
      "CAPTCHA_REQUIRED",
    );
    // ...and with one it works: the attacker cannot lock the owner out.
    expect(
      (await env.accounts.signIn({ email, password, captchaToken: "captcha-ok" }, meta)).kind,
    ).toBe("signed-in");
    // Another client is unaffected.
    expect((await env.accounts.signIn({ email, password }, env.meta())).kind).toBe("signed-in");
    // After the window, no CAPTCHA.
    env.advance(15 * MIN + 1);
    expect((await env.accounts.signIn({ email, password }, meta)).kind).toBe("signed-in");
  });

  it("per-IP throttle across many addresses also asks for a CAPTCHA", async () => {
    const meta = env.meta({ ip: "192.0.2.88" });
    const [limit] = ACCOUNT_LIMITS.signinIp;
    for (let i = 0; i < limit; i++)
      await code(env.accounts.signIn({ email: newEmail(), password: "wrong password!!" }, meta));
    expect(
      await code(env.accounts.signIn({ email: newEmail(), password: "wrong password!!" }, meta)),
    ).toBe("CAPTCHA_REQUIRED");
  });

  it("upgrades a hash with old parameters on sign-in", async () => {
    const { email, password } = await signUpVerified(env);
    const salt = randomBytes(16);
    const old = `scrypt$16384$8$1$${salt.toString("base64")}$${scryptSync(password.normalize("NFKC"), salt, 32, { N: 16384, r: 8, p: 1 }).toString("base64")}`;
    env.db.update(users).set({ passwordHash: old }).where(eq(users.emailNormalized, email)).run();
    expect((await env.accounts.signIn({ email, password }, env.meta())).kind).toBe("signed-in");
    expect(userRow(env.db, email)?.passwordHash).toMatch(/^scrypt\$32768\$/);
  });

  it("device recognition: unknown devices get an alert and a cookie; known devices do not", async () => {
    const { email, password } = await signUpVerified(env);
    const first = await env.accounts.signIn({ email, password }, env.meta());
    if (first.kind !== "signed-in") throw new Error();
    await env.accounts.settled();
    // The verification browser got a device cookie; this sign-in is from a browser without one.
    expect(env.mailer.to(email, "signin-alert")).toHaveLength(1);
    const device = remember(first.session.newDeviceToken as string);
    expect(device).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const second = await env.accounts.signIn(
      { email, password },
      env.meta({ deviceToken: device }),
    );
    if (second.kind !== "signed-in") throw new Error();
    expect(second.session.newDeviceToken).toBeNull();
    await env.accounts.settled();
    expect(env.mailer.to(email, "signin-alert")).toHaveLength(1);
    // Only the HMAC of the device token is stored.
    expect(JSON.stringify(env.db.select().from(knownDevices).all())).not.toContain(device);
    // A forged or malformed device cookie is not trusted.
    const third = await env.accounts.signIn(
      { email, password },
      env.meta({ deviceToken: "../../etc" }),
    );
    if (third.kind !== "signed-in") throw new Error();
    expect(third.session.newDeviceToken).not.toBeNull();
    // Alerts can be turned off; the audit trail still records the new device.
    const ctx = ctxOf(env, third.session.token);
    env.accounts.updateProfile(ctx, { signinAlerts: false });
    await env.accounts.signIn({ email, password }, env.meta());
    await env.accounts.settled();
    expect(env.mailer.to(email, "signin-alert")).toHaveLength(2);
    expect(auditRows(env.db).filter((r) => r.event === "user.signin_new_device")).toHaveLength(3);
  });
});

// ================================================================================================== sessions
describe("sessions", () => {
  it("idle expiry after 7 days; activity keeps it alive up to the 30-day absolute limit", async () => {
    const { session } = await signUpVerified(env);
    for (let d = 0; d < 4; d++) {
      env.advance(6 * DAY);
      expect(env.accounts.resolveSession(session.token)).not.toBeNull();
    }
    env.advance(6 * DAY + 1); // 30 days and a bit
    expect(env.accounts.resolveSession(session.token)).toBeNull();

    const other = await signUpVerified(env);
    env.advance(7 * DAY + MIN);
    expect(env.accounts.resolveSession(other.session.token)).toBeNull();
  });

  it("last_seen_at is written at most once a minute", async () => {
    const { session } = await signUpVerified(env);
    const seen = () =>
      env.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sha256Hex(session.token)))
        .get()?.lastSeenAt;
    const t0 = seen();
    env.advance(30_000);
    env.accounts.resolveSession(session.token);
    expect(seen()).toBe(t0);
    env.advance(31_000);
    env.accounts.resolveSession(session.token);
    expect(seen()).not.toBe(t0);
  });

  it("rejects malformed and unknown tokens", async () => {
    for (const t of [
      undefined,
      "",
      "x",
      "A".repeat(43),
      "A".repeat(44),
      "'; DROP TABLE sessions; --",
    ])
      expect(env.accounts.resolveSession(t)).toBeNull();
  });

  it("sign-out, list, revoke one, revoke others", async () => {
    const { email, password, session } = await signUpVerified(env);
    const b = await env.accounts.signIn({ email, password }, env.meta());
    const c = await env.accounts.signIn({ email, password }, env.meta());
    if (b.kind !== "signed-in" || c.kind !== "signed-in") throw new Error();
    const ctxA = ctxOf(env, session.token);
    const list = env.accounts.listSessions(ctxA);
    expect(list).toHaveLength(3);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list[0]?.device).toBe("Firefox on macOS");
    for (const s of list) expect(s.id).toMatch(/^[0-9a-f]{16}$/);

    const target = list.find((s) => !s.current) as { id: string };
    env.accounts.revokeSession(ctxA, target.id);
    expect(env.accounts.listSessions(ctxA)).toHaveLength(2);
    expect(await code(() => env.accounts.revokeSession(ctxA, target.id))).toBe("NOT_FOUND");
    expect(await code(() => env.accounts.revokeSession(ctxA, "../../etc/passwd"))).toBe(
      "NOT_FOUND",
    );

    // Someone else's session id is not found for me.
    const other = await signUpVerified(env);
    const otherId = env.accounts.listSessions(other.ctx)[0]?.id as string;
    expect(await code(() => env.accounts.revokeSession(ctxA, otherId))).toBe("NOT_FOUND");
    expect(env.accounts.resolveSession(other.session.token)).not.toBeNull();

    expect(env.accounts.revokeOtherSessions(ctxA)).toBe(1);
    expect(env.accounts.resolveSession(b.session.token)).toBeNull();
    expect(env.accounts.resolveSession(c.session.token)).toBeNull();
    expect(env.accounts.resolveSession(session.token)).not.toBeNull();

    env.accounts.signOut(session.token);
    expect(env.accounts.resolveSession(session.token)).toBeNull();
    const events = auditRows(env.db).map((r) => r.event);
    expect(events).toEqual(expect.arrayContaining(["user.session_revoked", "user.signout"]));
  });

  it("switching the active workspace requires membership", async () => {
    const a = await signUpVerified(env);
    const b = await signUpVerified(env);
    expect(await code(() => env.accounts.setActiveAccount(a.ctx, b.accountId as string))).toBe(
      "FORBIDDEN",
    );
    expect(await code(() => env.accounts.setActiveAccount(a.ctx, "../t"))).toBe("FORBIDDEN");
    env.accounts.setActiveAccount(a.ctx, a.accountId as string);
    expect(ctxOf(env, a.session.token).activeAccountId).toBe(a.accountId);
  });
});

// =================================================================================================== re-auth
describe("re-authentication window", () => {
  it("sensitive actions need a re-authentication within 10 minutes", async () => {
    const { ctx, password } = await signUpVerified(env);
    // The verification link signs in without a password: not a re-authentication.
    expect(await code(() => env.accounts.beginTotp(ctx))).toBe("REAUTH_REQUIRED");
    expect(await code(env.accounts.requestEmailChange(ctx, newEmail(), env.meta()))).toBe(
      "REAUTH_REQUIRED",
    );
    expect(await code(() => env.accounts.regenerateRecoveryCodes(ctx))).toBe("REAUTH_REQUIRED");
    expect(await code(env.accounts.deleteUser(ctx, env.meta()))).toBe("REAUTH_REQUIRED");
    expect(await code(() => env.accounts.assertRecentAuth(ctx))).toBe("REAUTH_REQUIRED");

    expect(
      await code(env.accounts.reauthenticate(ctx, { password: "not my password" }, env.meta())),
    ).toBe("UNAUTHORIZED");
    expect(await code(env.accounts.reauthenticate(ctx, {}, env.meta()))).toBe("VALIDATION");
    await env.accounts.reauthenticate(ctx, { password }, env.meta());
    expect(await code(() => env.accounts.assertRecentAuth(ctx))).toBeUndefined();
    env.advance(10 * MIN - 1000);
    expect(await code(() => env.accounts.assertRecentAuth(ctx))).toBeUndefined();
    env.advance(2000);
    expect(await code(() => env.accounts.assertRecentAuth(ctx))).toBe("REAUTH_REQUIRED");
  });

  it("the stored time is authoritative, not the context object", async () => {
    const { ctx } = await signUpVerified(env);
    const forged = { ...ctx, reauthAt: env.now() };
    expect(await code(() => env.accounts.assertRecentAuth(forged))).toBe("REAUTH_REQUIRED");
  });
});

// ====================================================================================================== TOTP
describe("two-factor authentication", () => {
  async function signedInWithPassword() {
    const v = await signUpVerified(env);
    const r = await env.accounts.signIn({ email: v.email, password: v.password }, env.meta());
    if (r.kind !== "signed-in") throw new Error();
    remember(r.session.token);
    return { ...v, ctx: ctxOf(env, r.session.token), token: r.session.token };
  }

  it("enrolment stores the secret encrypted and returns 10 single-use recovery codes", async () => {
    const { ctx, email } = await signedInWithPassword();
    const { secret, recoveryCodes: codes } = await enableTotp(ctx);
    expect(codes).toHaveLength(10);
    const u = userRow(env.db, email);
    expect(u?.totpEnabledAt).not.toBeNull();
    expect(u?.totpSecretEnc).toMatch(/^v1\./);
    expect(u?.totpSecretEnc).not.toContain(secret);
    const stored = JSON.stringify(env.db.select().from(recoveryCodes).all());
    for (const c of codes) expect(stored).not.toContain(c);
    expect(env.db.select().from(sessions).where(eq(sessions.id, ctx.sessionId)).get()?.mfa).toBe(
      true,
    );
    await env.accounts.settled();
    expect(env.mailer.last(email, "security-change")?.data.change).toBe("totp-enabled");
    expect(await code(() => env.accounts.beginTotp(ctx))).toBe("CONFLICT");
  });

  it("security notices still go out after anonymous requests used up the address's mail budget", async () => {
    const { ctx, email } = await signedInWithPassword();
    // Anyone can make the service mail an address: password resets, and sign-ups with a taken address.
    for (let i = 0; i < 3; i++)
      await env.accounts.requestPasswordReset(email, "captcha-ok", env.meta());
    for (let i = 0; i < 3; i++)
      await env.accounts.signUp(signUpInput(email, newPassword(), null), env.meta());
    await env.accounts.settled();
    // The account budget is spent: the last of these were not sent.
    expect(env.mailer.to(email, "signup-existing-account").length).toBeLessThan(3);
    await enableTotp(ctx);
    await env.accounts.settled();
    expect(env.mailer.last(email, "security-change")?.data.change).toBe("totp-enabled");
  });

  it("a wrong confirmation code does not enable 2FA", async () => {
    const { ctx, email } = await signedInWithPassword();
    const { secret } = env.accounts.beginTotp(ctx);
    remember(secret);
    expect(await code(() => env.accounts.confirmTotp(ctx, "000000"))).toBe("VALIDATION");
    expect(userRow(env.db, email)?.totpEnabledAt).toBeNull();
  });

  it("sign-in requires the second factor; codes work in a ±1 step window and never twice", async () => {
    const { ctx, email, password } = await signedInWithPassword();
    const { secret } = await enableTotp(ctx);
    env.advance(30_000); // two steps past enrolment, so the previous step is usable
    const r = await env.accounts.signIn({ email, password }, env.meta());
    expect(r.kind).toBe("totp-required");
    if (r.kind !== "totp-required") throw new Error();
    remember(r.challenge);
    expect(r.expiresAt.getTime() - env.clock.t).toBe(5 * MIN);
    const c = totpNow(env, secret, -1);
    const done = await env.accounts.completeSecondFactor(
      { challenge: r.challenge, code: c },
      env.meta(),
    );
    remember(done.session.token);
    expect(ctxOf(env, done.session.token).mfa).toBe(true);
    // The challenge is spent.
    expect(
      await code(
        env.accounts.completeSecondFactor({ challenge: r.challenge, code: c }, env.meta()),
      ),
    ).toBe("INVALID_TOKEN");
    const fresh = async () => {
      const x = await env.accounts.signIn({ email, password }, env.meta());
      if (x.kind !== "totp-required") throw new Error();
      return remember(x.challenge);
    };
    // The same code (same step) on a fresh challenge is a replay.
    const r2 = await fresh();
    expect(
      await code(env.accounts.completeSecondFactor({ challenge: r2, code: c }, env.meta())),
    ).toBe("UNAUTHORIZED");
    const ok = await env.accounts.completeSecondFactor(
      { challenge: r2, code: totpNow(env, secret) },
      env.meta(),
    );
    remember(ok.session.token);
    // A step inside the window but before the last accepted one is refused; two steps ahead is outside it.
    const r3 = await fresh();
    expect(
      await code(
        env.accounts.completeSecondFactor(
          { challenge: r3, code: totpNow(env, secret, -1) },
          env.meta(),
        ),
      ),
    ).toBe("UNAUTHORIZED");
    expect(
      await code(
        env.accounts.completeSecondFactor(
          { challenge: r3, code: totpNow(env, secret, 2) },
          env.meta(),
        ),
      ),
    ).toBe("UNAUTHORIZED");
    const ahead = await env.accounts.completeSecondFactor(
      { challenge: r3, code: totpNow(env, secret, 1) },
      env.meta(),
    );
    remember(ahead.session.token);
  });

  it("a challenge dies after 5 attempts and after 5 minutes", async () => {
    const { ctx, email, password } = await signedInWithPassword();
    const { secret } = await enableTotp(ctx);
    const r = await env.accounts.signIn({ email, password }, env.meta());
    if (r.kind !== "totp-required") throw new Error();
    remember(r.challenge);
    for (let i = 0; i < 5; i++)
      expect(
        await code(
          env.accounts.completeSecondFactor({ challenge: r.challenge, code: "000000" }, env.meta()),
        ),
      ).toBe("UNAUTHORIZED");
    expect(
      await code(
        env.accounts.completeSecondFactor(
          { challenge: r.challenge, code: totpNow(env, secret) },
          env.meta(),
        ),
      ),
    ).toBe("INVALID_TOKEN");

    const r2 = await env.accounts.signIn({ email, password }, env.meta());
    if (r2.kind !== "totp-required") throw new Error();
    remember(r2.challenge);
    env.advance(5 * MIN + 1);
    expect(
      await code(
        env.accounts.completeSecondFactor(
          { challenge: r2.challenge, code: totpNow(env, secret) },
          env.meta(),
        ),
      ),
    ).toBe("INVALID_TOKEN");
    expect(
      await code(env.accounts.completeSecondFactor({ challenge: r2.challenge }, env.meta())),
    ).toBe("VALIDATION");
  });

  it("recovery codes work once each and the owner is told", async () => {
    const { ctx, email, password } = await signedInWithPassword();
    const { recoveryCodes: codes } = await enableTotp(ctx);
    const r = await env.accounts.signIn({ email, password }, env.meta());
    if (r.kind !== "totp-required") throw new Error();
    remember(r.challenge);
    const rc = codes[0] as string;
    const done = await env.accounts.completeSecondFactor(
      { challenge: r.challenge, recoveryCode: rc.toUpperCase() },
      env.meta(),
    );
    remember(done.session.token);
    await env.accounts.settled();
    expect(env.mailer.last(email, "security-change")?.data.change).toBe("recovery-code-used");
    expect(auditRows(env.db).find((x) => x.event === "user.recovery_codes_used")?.detail).toEqual({
      count: 9,
    });

    const r2 = await env.accounts.signIn({ email, password }, env.meta());
    if (r2.kind !== "totp-required") throw new Error();
    remember(r2.challenge);
    expect(
      await code(
        env.accounts.completeSecondFactor(
          { challenge: r2.challenge, recoveryCode: rc },
          env.meta(),
        ),
      ),
    ).toBe("UNAUTHORIZED");
    const ok = await env.accounts.completeSecondFactor(
      { challenge: r2.challenge, recoveryCode: codes[1] },
      env.meta(),
    );
    remember(ok.session.token);
  });

  it("wrong recovery codes use up the same 5 attempts; another person's recovery code never works", async () => {
    const a = await signedInWithPassword();
    const { recoveryCodes: aCodes } = await enableTotp(a.ctx);
    const b = await signedInWithPassword();
    await enableTotp(b.ctx);
    const r = await env.accounts.signIn({ email: b.email, password: b.password }, env.meta());
    if (r.kind !== "totp-required") throw new Error();
    remember(r.challenge);
    for (const rc of aCodes.slice(0, 5))
      expect(
        await code(
          env.accounts.completeSecondFactor(
            { challenge: r.challenge, recoveryCode: rc },
            env.meta(),
          ),
        ),
      ).toBe("UNAUTHORIZED");
    // The challenge is dead now, and A's codes were not used up by the attempts on B.
    expect(
      await code(
        env.accounts.completeSecondFactor(
          { challenge: r.challenge, recoveryCode: aCodes[5] as string },
          env.meta(),
        ),
      ),
    ).toBe("INVALID_TOKEN");
    const ra = await env.accounts.signIn({ email: a.email, password: a.password }, env.meta());
    if (ra.kind !== "totp-required") throw new Error();
    remember(ra.challenge);
    const ok = await env.accounts.completeSecondFactor(
      { challenge: ra.challenge, recoveryCode: aCodes[0] as string },
      env.meta(),
    );
    remember(ok.session.token);
  });

  it("regenerating recovery codes replaces the whole set", async () => {
    const { ctx, email, password } = await signedInWithPassword();
    const { recoveryCodes: oldCodes } = await enableTotp(ctx);
    const { recoveryCodes: fresh } = env.accounts.regenerateRecoveryCodes(ctx);
    for (const c of fresh) remember(c);
    expect(env.db.select().from(recoveryCodes).all()).toHaveLength(10);
    const r = await env.accounts.signIn({ email, password }, env.meta());
    if (r.kind !== "totp-required") throw new Error();
    remember(r.challenge);
    expect(
      await code(
        env.accounts.completeSecondFactor(
          { challenge: r.challenge, recoveryCode: oldCodes[2] },
          env.meta(),
        ),
      ),
    ).toBe("UNAUTHORIZED");
    const ok = await env.accounts.completeSecondFactor(
      { challenge: r.challenge, recoveryCode: fresh[0] },
      env.meta(),
    );
    remember(ok.session.token);
  });

  it("disabling needs a valid (unused) code, and removes the secret and recovery codes", async () => {
    const { ctx, email, password } = await signedInWithPassword();
    const { secret } = await enableTotp(ctx);
    expect(await code(env.accounts.disableTotp(ctx, "123456", env.meta()))).toBe("UNAUTHORIZED");
    await env.accounts.disableTotp(ctx, totpNow(env, secret), env.meta());
    const u = userRow(env.db, email);
    expect([u?.totpEnabledAt, u?.totpSecretEnc, u?.totpLastStep]).toEqual([null, null, null]);
    expect(env.db.select().from(recoveryCodes).all()).toHaveLength(0);
    expect((await env.accounts.signIn({ email, password }, env.meta())).kind).toBe("signed-in");
  });

  it("a recovery code can disable 2FA for someone who lost the device", async () => {
    const { ctx, email } = await signedInWithPassword();
    const { recoveryCodes: codes } = await enableTotp(ctx);
    await env.accounts.disableTotp(ctx, codes[3] as string, env.meta());
    expect(userRow(env.db, email)?.totpEnabledAt).toBeNull();
  });

  it("re-authentication with a TOTP code also respects replay protection", async () => {
    const { ctx, secret } = await (async () => {
      const s = await signedInWithPassword();
      const t = await enableTotp(s.ctx);
      return { ctx: s.ctx, secret: t.secret };
    })();
    const c = totpNow(env, secret);
    await env.accounts.reauthenticate(ctx, { totpCode: c }, env.meta());
    expect(await code(env.accounts.reauthenticate(ctx, { totpCode: c }, env.meta()))).toBe(
      "UNAUTHORIZED",
    );
  });

  describe("ten wrong codes in a row (security review finding 8)", () => {
    const alerts = (email: string) => env.mailer.to(email, "second-factor-failures");
    const alertAudits = () =>
      auditRows(env.db).filter((r) => r.event === "user.second_factor_failures");
    const failures = (email: string) => userRow(env.db, email)?.secondFactorFailures;

    /** `n` wrong codes on one fresh sign-in challenge (at most 5, the challenge's own limit). */
    async function wrongOnChallenge(email: string, password: string, n: number) {
      const r = await env.accounts.signIn({ email, password }, env.meta());
      if (r.kind !== "totp-required") throw new Error();
      remember(r.challenge);
      for (let i = 0; i < n; i++)
        expect(
          await code(
            env.accounts.completeSecondFactor(
              { challenge: r.challenge, code: "000000" },
              env.meta(),
            ),
          ),
        ).toBe("UNAUTHORIZED");
    }
    const wrongReauth = async (ctx: SessionContext) =>
      expect(await code(env.accounts.reauthenticate(ctx, { totpCode: "000000" }, env.meta()))).toBe(
        "UNAUTHORIZED",
      );

    it("sign-in and re-authentication codes add up; the 10th emails the owner once, audited; no lock-out", async () => {
      const { ctx, email, password } = await signedInWithPassword();
      const { secret } = await enableTotp(ctx);
      await wrongOnChallenge(email, password, 5);
      for (let i = 0; i < 4; i++) await wrongReauth(ctx);
      await env.accounts.settled();
      expect(failures(email)).toBe(9);
      expect(alerts(email)).toEqual([]);

      await wrongReauth(ctx);
      await env.accounts.settled();
      expect(alerts(email)).toHaveLength(1);
      const mail = env.mailer.last(email, "second-factor-failures");
      expect(mail?.data).toEqual({
        name: userRow(env.db, email)?.name,
        at: new Date(env.clock.t).toISOString(),
        resetUrl: "https://app.example.test/forgot-password",
        securityUrl: "https://app.example.test/settings/security",
      });
      const rendered = render("second-factor-failures", mail?.data as never, {
        productName: "Glideworth",
        appUrl: "https://app.example.test",
        supportEmail: "support@example.test",
      });
      expect(rendered.text).toContain(
        "Someone entered the wrong two-step code 10 times. They have your password. Change it now.",
      );
      expect(alertAudits()).toHaveLength(1);
      expect(alertAudits()[0]?.detail).toEqual({ count: 10, method: "totp", status: "mailed" });
      expect(alertAudits()[0]?.subjectUserId).toBe(userRow(env.db, email)?.id);
      // The run starts again, and nothing is locked: a correct code still signs in.
      expect(failures(email)).toBe(0);
      const r = await env.accounts.signIn({ email, password }, env.meta());
      if (r.kind !== "totp-required") throw new Error();
      remember(r.challenge);
      const ok = await env.accounts.completeSecondFactor(
        { challenge: r.challenge, code: totpNow(env, secret) },
        env.meta(),
      );
      remember(ok.session.token);
    });

    it("a correct code resets the run; turning two-step off counts too", async () => {
      const { ctx, email, secret } = await (async () => {
        const s = await signedInWithPassword();
        const t = await enableTotp(s.ctx);
        return { ...s, secret: t.secret };
      })();
      for (let i = 0; i < 5; i++) await wrongReauth(ctx);
      for (let i = 0; i < 4; i++)
        expect(await code(env.accounts.disableTotp(ctx, "111111", env.meta()))).toBe(
          "UNAUTHORIZED",
        );
      expect(failures(email)).toBe(9);
      await env.accounts.reauthenticate(ctx, { totpCode: totpNow(env, secret) }, env.meta());
      expect(failures(email)).toBe(0);
      env.advance(15 * MIN);
      await wrongReauth(ctx);
      await env.accounts.settled();
      expect(failures(email)).toBe(1);
      expect(alerts(email)).toEqual([]);
      expect(alertAudits()).toEqual([]);
      // A password re-authentication is not a code: it neither counts nor resets the run.
      await env.accounts
        .reauthenticate(ctx, { password: "wrong password!!" }, env.meta())
        .catch(() => {});
      expect(failures(email)).toBe(1);
    });

    it("at most one email per account per 24 hours, but every run of 10 is audited; the counter survives a restart", async () => {
      const { ctx, email, password } = await signedInWithPassword();
      await enableTotp(ctx);
      const run = async () => {
        await wrongOnChallenge(email, password, 5);
        for (let i = 0; i < 5; i++) await wrongReauth(ctx);
        env.advance(15 * MIN);
      };
      await run();
      await run();
      await env.accounts.settled();
      expect(alerts(email)).toHaveLength(1);
      expect(alertAudits().map((r) => r.detail?.status)).toEqual(["mailed", "mailed_recently"]);

      env.advance(DAY);
      // The count is in the control database: after a restart (a new service with fresh in-memory limits)
      // the run goes on where it was.
      await wrongOnChallenge(email, password, 5);
      for (let i = 0; i < 4; i++) await wrongReauth(ctx);
      expect(failures(email)).toBe(9);
      const restarted = new AccountsService({
        db: env.db,
        keys: env.keys,
        mailer: env.mailer,
        captcha: staticCaptcha("captcha-ok"),
        limiter: memoryRateLimiter({ now: () => env.clock.t }),
        audit: env.audit,
        workspaces: () => env.workspaces,
        publicUrl: "https://app.example.test",
        now: env.now,
      });
      expect(await code(restarted.reauthenticate(ctx, { totpCode: "000000" }, env.meta()))).toBe(
        "UNAUTHORIZED",
      );
      await restarted.settled();
      expect(alerts(email)).toHaveLength(2);
      expect(alertAudits().map((r) => r.detail?.status)).toEqual([
        "mailed",
        "mailed_recently",
        "mailed",
      ]);
    });

    it("the alert uses the security mail budget, so anonymous mail cannot silence it", async () => {
      const { ctx, email, password } = await signedInWithPassword();
      await enableTotp(ctx);
      for (let i = 0; i < 3; i++)
        await env.accounts.requestPasswordReset(email, "captcha-ok", env.meta());
      for (let i = 0; i < 3; i++)
        await env.accounts.signUp(signUpInput(email, newPassword(), null), env.meta());
      await wrongOnChallenge(email, password, 5);
      for (let i = 0; i < 5; i++) await wrongReauth(ctx);
      await env.accounts.settled();
      expect(alerts(email)).toHaveLength(1);
    });
  });
});

// ================================================================================================= passwords
describe("password change and reset", () => {
  it("change: needs the current password, rotates the session, revokes all others", async () => {
    const { email, password, session } = await signUpVerified(env);
    const other = await env.accounts.signIn({ email, password }, env.meta());
    if (other.kind !== "signed-in") throw new Error();
    remember(other.session.token);
    const ctx = ctxOf(env, session.token);
    const next = newPassword();
    expect(await code(env.accounts.changePassword(ctx, "wrong current pw", next, env.meta()))).toBe(
      "UNAUTHORIZED",
    );
    expect(await code(env.accounts.changePassword(ctx, password, "short", env.meta()))).toBe(
      "WEAK_PASSWORD",
    );
    const fresh = await env.accounts.changePassword(ctx, password, next, env.meta());
    remember(fresh.token);
    expect(env.accounts.resolveSession(other.session.token)).toBeNull();
    expect(env.accounts.resolveSession(session.token)).toBeNull();
    const nctx = ctxOf(env, fresh.token);
    expect(nctx.activeAccountId).toBe(ctx.activeAccountId);
    expect(await code(env.accounts.signIn({ email, password }, env.meta()))).toBe("UNAUTHORIZED");
    expect((await env.accounts.signIn({ email, password: next }, env.meta())).kind).toBe(
      "signed-in",
    );
    await env.accounts.settled();
    expect(env.mailer.last(email, "security-change")?.data.change).toBe("password-changed");
  });

  it("forgot-password is enumeration-safe, needs a CAPTCHA, and mails only verified addresses", async () => {
    const { email } = await signUpVerified(env);
    const unverified = newEmail();
    await env.accounts.signUp(signUpInput(unverified, newPassword()), env.meta());
    expect(await code(env.accounts.requestPasswordReset(email, undefined, env.meta()))).toBe(
      "CAPTCHA_REQUIRED",
    );
    const results = await Promise.all([
      env.accounts.requestPasswordReset(email, "captcha-ok", env.meta()),
      env.accounts.requestPasswordReset(newEmail(), "captcha-ok", env.meta()),
      env.accounts.requestPasswordReset(unverified, "captcha-ok", env.meta()),
      env.accounts.requestPasswordReset("garbage", "captcha-ok", env.meta()),
    ]);
    expect(results).toEqual([undefined, undefined, undefined, undefined]);
    await env.accounts.settled();
    expect(env.mailer.to(email, "password-reset")).toHaveLength(1);
    expect(env.mailer.to(unverified, "password-reset")).toHaveLength(0);
    expect(env.mailer.last(email, "password-reset")?.data.expiresInMinutes).toBe(30);
    const known = await median(() =>
      env.accounts.requestPasswordReset(email, "captcha-ok", env.meta()),
    );
    const unknown = await median(() =>
      env.accounts.requestPasswordReset(newEmail(), "captcha-ok", env.meta()),
    );
    expect(Math.max(known, unknown)).toBeLessThan(20); // no hashing, mail sent in the background
  });

  it("at most 3 reset mails per address per hour, silently", async () => {
    const { email } = await signUpVerified(env);
    for (let i = 0; i < 6; i++)
      await env.accounts.requestPasswordReset(email, "captcha-ok", env.meta());
    await env.accounts.settled();
    expect(env.mailer.to(email, "password-reset")).toHaveLength(3);
  });

  it("reset: single use, 30-minute expiry, revokes every session, signs in", async () => {
    const { email, password, session } = await signUpVerified(env);
    await env.accounts.requestPasswordReset(email, "captcha-ok", env.meta());
    await env.accounts.settled();
    const token = env.mailer.token(email, "password-reset");
    expect(await code(env.accounts.resetPassword(token, "short", env.meta()))).toBe(
      "WEAK_PASSWORD",
    );
    const next = newPassword();
    const r = await env.accounts.resetPassword(token, next, env.meta()); // the weak attempt did not consume it
    expect(r.kind).toBe("signed-in");
    if (r.kind === "signed-in") remember(r.session.token);
    expect(env.accounts.resolveSession(session.token)).toBeNull();
    expect(await code(env.accounts.resetPassword(token, newPassword(), env.meta()))).toBe(
      "INVALID_TOKEN",
    );
    expect(await code(env.accounts.signIn({ email, password }, env.meta()))).toBe("UNAUTHORIZED");
    await env.accounts.settled();
    expect(env.mailer.last(email, "security-change")?.data.change).toBe("password-reset");
    if (r.kind === "signed-in") expect(ctxOf(env, r.session.token).reauthAt).toBeNull();

    await env.accounts.requestPasswordReset(email, "captcha-ok", env.meta());
    await env.accounts.settled();
    const late = env.mailer.token(email, "password-reset");
    env.advance(30 * MIN + 1);
    expect(await code(env.accounts.resetPassword(late, newPassword(), env.meta()))).toBe(
      "INVALID_TOKEN",
    );
  });

  it("a reset token cannot verify an email, and a verification token cannot reset a password", async () => {
    const email = newEmail();
    await env.accounts.signUp(signUpInput(email, newPassword()), env.meta());
    await env.accounts.settled();
    const verify = env.mailer.token(email, "verify-email");
    expect(await code(env.accounts.resetPassword(verify, newPassword(), env.meta()))).toBe(
      "INVALID_TOKEN",
    );
    await env.accounts.verifyEmail(verify, env.meta(), sameBrowser);
    await env.accounts.requestPasswordReset(email, "captcha-ok", env.meta());
    await env.accounts.settled();
    const reset = env.mailer.token(email, "password-reset");
    expect(await code(env.accounts.verifyEmail(reset, env.meta(), sameBrowser))).toBe(
      "INVALID_TOKEN",
    );
    expect(await code(env.accounts.confirmEmailChange(reset, env.meta()))).toBe("INVALID_TOKEN");
  });

  it("reset never bypasses 2FA", async () => {
    const v = await signUpVerified(env);
    const s = await env.accounts.signIn({ email: v.email, password: v.password }, env.meta());
    if (s.kind !== "signed-in") throw new Error();
    remember(s.session.token);
    const { secret } = await enableTotp(ctxOf(env, s.session.token));
    await env.accounts.requestPasswordReset(v.email, "captcha-ok", env.meta());
    await env.accounts.settled();
    const r = await env.accounts.resetPassword(
      env.mailer.token(v.email, "password-reset"),
      newPassword(),
      env.meta(),
    );
    expect(r.kind).toBe("totp-required");
    if (r.kind !== "totp-required") throw new Error();
    remember(r.challenge);
    expect(userRow(env.db, v.email)?.totpEnabledAt).not.toBeNull();
    const done = await env.accounts.completeSecondFactor(
      { challenge: r.challenge, code: totpNow(env, secret) },
      env.meta(),
    );
    remember(done.session.token);
  });
});

// ============================================================================================== email change
describe("email change", () => {
  async function reauthed() {
    const v = await signUpVerified(env);
    await env.accounts.reauthenticate(v.ctx, { password: v.password }, env.meta());
    return v;
  }

  it("a pending change does not survive a password reset, a password change or turning two-step sign-in off (security review finding 5)", async () => {
    for (const how of ["reset", "change", "totp-off"] as const) {
      const v = await reauthed();
      const totp = how === "totp-off" ? await enableTotp(v.ctx) : null;
      const target = newEmail("intruder");
      await env.accounts.requestEmailChange(v.ctx, target, env.meta());
      await env.accounts.settled();
      const pending = env.mailer.token(target, "email-change-confirm");
      if (how === "reset") {
        await env.accounts.requestPasswordReset(v.email, "captcha-ok", env.meta());
        await env.accounts.settled();
        const reset = env.mailer.token(v.email, "password-reset");
        await env.accounts.resetPassword(reset, newPassword(), env.meta());
      } else if (how === "change") {
        await env.accounts.changePassword(v.ctx, v.password, newPassword(), env.meta());
      } else {
        await env.accounts.disableTotp(v.ctx, totpNow(env, totp?.secret as string), env.meta());
      }
      expect(await code(env.accounts.confirmEmailChange(pending, env.meta())), how).toBe(
        "INVALID_TOKEN",
      );
      const u = env.db.select().from(users).where(eq(users.id, v.userId)).get();
      expect(u?.emailNormalized, how).toBe(v.email.toLowerCase());
    }
  });

  it("confirms to the new address, warns the old one, and switches on confirmation", async () => {
    const v = await reauthed();
    await env.accounts.requestPasswordReset(v.email, "captcha-ok", env.meta());
    await env.accounts.settled();
    const staleReset = env.mailer.token(v.email, "password-reset");
    const target = newEmail("new");
    await env.accounts.requestEmailChange(v.ctx, `  ${target.toUpperCase()} `, env.meta());
    await env.accounts.settled();
    // At request time the old address is told a change was asked for, to which address; not that it happened.
    expect(env.mailer.to(v.email, "security-change")).toHaveLength(0);
    const requested = env.mailer.last(v.email, "email-change-requested");
    expect(requested?.data).toMatchObject({ newEmail: target.toUpperCase(), expiresInHours: 24 });
    const requestedText = render("email-change-requested", requested?.data as never, {
      productName: "Glideworth",
      appUrl: "https://app.example.test",
      supportEmail: "s@example.test",
    }).text;
    expect(requestedText).toContain(`asked to change its email address to ${target.toUpperCase()}`);
    expect(requestedText).toContain("Nothing has changed yet.");
    expect(requestedText).not.toContain("was changed");
    const token = env.mailer.token(target, "email-change-confirm");
    await env.accounts.confirmEmailChange(token, env.meta());
    await env.accounts.settled();
    // On confirmation the old address gets one "changed" notice naming the new address; the new one gets none.
    const changed = env.mailer.to(v.email, "security-change");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.data).toMatchObject({
      change: "email-changed",
      newEmail: target.toUpperCase(),
    });
    expect(env.mailer.to(target, "security-change")).toHaveLength(0);
    expect(env.mailer.to(v.email, "email-change-requested")).toHaveLength(1);
    const u = env.db.select().from(users).where(eq(users.id, v.userId)).get();
    expect(u?.emailNormalized).toBe(target.toLowerCase());
    expect(await code(env.accounts.confirmEmailChange(token, env.meta()))).toBe("INVALID_TOKEN");
    // A reset link mailed to the old address no longer works.
    expect(await code(env.accounts.resetPassword(staleReset, newPassword(), env.meta()))).toBe(
      "INVALID_TOKEN",
    );
    expect(
      (await env.accounts.signIn({ email: target, password: v.password }, env.meta())).kind,
    ).toBe("signed-in");
    expect(
      await code(env.accounts.signIn({ email: v.email, password: v.password }, env.meta())),
    ).toBe("UNAUTHORIZED");
  });

  it("an address in use gets nothing and the caller learns nothing; a race at confirmation is a conflict", async () => {
    const v = await reauthed();
    const taken = await signUpVerified(env);
    const before = env.mailer.to(taken.email).length;
    expect(await env.accounts.requestEmailChange(v.ctx, taken.email, env.meta())).toBeUndefined();
    await env.accounts.settled();
    expect(env.mailer.to(taken.email)).toHaveLength(before);

    const target = newEmail("race");
    await env.accounts.requestEmailChange(v.ctx, target, env.meta());
    await env.accounts.settled();
    const token = env.mailer.token(target, "email-change-confirm");
    await signUpVerified(env, { email: target });
    expect(await code(env.accounts.confirmEmailChange(token, env.meta()))).toBe("CONFLICT");
  });

  it("refuses the same address and disposable domains, and expires after 24 hours", async () => {
    const v = await reauthed();
    expect(await code(env.accounts.requestEmailChange(v.ctx, v.email, env.meta()))).toBe(
      "VALIDATION",
    );
    expect(await code(env.accounts.requestEmailChange(v.ctx, "a@mailinator.com", env.meta()))).toBe(
      "DISPOSABLE_EMAIL",
    );
    const target = newEmail();
    await env.accounts.requestEmailChange(v.ctx, target, env.meta());
    await env.accounts.settled();
    const token = env.mailer.token(target, "email-change-confirm");
    env.advance(24 * HOUR + 1);
    expect(await code(env.accounts.confirmEmailChange(token, env.meta()))).toBe("INVALID_TOKEN");
  });
});

// ============================================================================================ profile, data
describe("profile, personal data, deletion", () => {
  it("personal data contains the profile, memberships, sessions and events but no secrets", async () => {
    const v = await signUpVerified(env);
    env.accounts.updateProfile(v.ctx, { name: "  New  Name ", checkinEmails: false });
    expect(await code(() => env.accounts.updateProfile(v.ctx, { name: "" }))).toBe("VALIDATION");
    const data = env.accounts.personalData(v.ctx);
    const text = JSON.stringify(data);
    expect(data).toMatchObject({
      profile: { id: v.userId, name: "New  Name", checkinEmails: false },
    });
    expect((data.memberships as unknown[]).length).toBe(1);
    expect((data.securityEvents as unknown[]).length).toBeGreaterThan(0);
    expect(text).not.toContain("scrypt$");
    expect(text).not.toContain(v.session.token);
    expect(text).not.toContain(sha256Hex(v.session.token));
    expect(text).not.toMatch(/password|totpSecret|tokenHash|codeHmac|deviceHmac/i);
  });

  it("deleting a sole owner deletes their workspace, then the user and everything that hangs off them", async () => {
    const v = await signUpVerified(env);
    await env.accounts.reauthenticate(v.ctx, { password: v.password }, env.meta());
    await env.accounts.deleteUser(v.ctx, env.meta());
    expect(env.workspaces.deleted).toEqual([v.accountId]);
    expect(env.db.select().from(users).where(eq(users.id, v.userId)).get()).toBeUndefined();
    expect(env.db.select().from(sessions).where(eq(sessions.userId, v.userId)).all()).toHaveLength(
      0,
    );
    expect(
      env.db.select().from(userTokens).where(eq(userTokens.userId, v.userId)).all(),
    ).toHaveLength(0);
    expect(env.accounts.resolveSession(v.session.token)).toBeNull();
    expect(
      auditRows(env.db).some((r) => r.event === "user.deleted" && r.subjectUserId === v.userId),
    ).toBe(true);
    expect(
      await code(env.accounts.signIn({ email: v.email, password: v.password }, env.meta())),
    ).toBe("UNAUTHORIZED");
  });

  it("a new name is copied into the member list of every workspace, keeping each role (QA 12)", async () => {
    const owner = await signUpVerified(env, { name: "Olive Owner" });
    // The member has a workspace of their own and joins the owner's as a viewer.
    const member = await signUpVerified(env, { name: "Ada Tester" });
    await env.workspaces.invite(owner.ctx, member.email, "viewer");
    await env.accounts.settled();
    await env.workspaces.acceptInvitation(member.ctx, env.mailer.token(member.email, "invitation"));
    env.reg.names.length = 0;

    await env.accounts.updateProfile(member.ctx, { name: "Ada Lovelace" });
    expect(
      env.reg.names.map((n) => [n.accountId, n.role, n.name]).sort((a, b) => (a < b ? -1 : 1)),
    ).toEqual(
      [
        [member.accountId, "owner", "Ada Lovelace"],
        [owner.accountId, "viewer", "Ada Lovelace"],
      ].sort((a, b) => (a < b ? -1 : 1)),
    );
    // Settings that are not the name touch no workspace; a workspace that cannot be opened does not fail it.
    env.reg.names.length = 0;
    await env.accounts.updateProfile(member.ctx, { checkinEmails: false });
    expect(env.reg.names).toEqual([]);
    env.reg.failNext.v = true;
    await env.accounts.updateProfile(member.ctx, { name: "Ada King" });
    expect(env.reg.names.map((n) => n.name)).toEqual(["Ada King"]);
    expect(userRow(env.db, member.email)?.name).toBe("Ada King");
  });

  it("deleting an account emails a confirmation to its address, even after anonymous mail used up the budget (QA 14)", async () => {
    const v = await signUpVerified(env, { name: "Dee Leted" });
    // Anyone can make five "you already have an account" emails go to the address.
    for (let i = 0; i < ACCOUNT_LIMITS.mailPerAddress[0] + 1; i++)
      await env.accounts.signUp(signUpInput(v.email, newPassword()), env.meta());
    await env.accounts.settled();
    // The verification email was the first of the five; the last sign-ups were dropped.
    expect(env.mailer.to(v.email, "signup-existing-account")).toHaveLength(
      ACCOUNT_LIMITS.mailPerAddress[0] - 1,
    );
    await env.accounts.reauthenticate(v.ctx, { password: v.password }, env.meta());
    await env.accounts.deleteUser(v.ctx, env.meta());
    await env.accounts.settled();
    const mail = env.mailer.last(v.email, "user-account-deleted");
    expect(mail?.data).toEqual({ name: "Dee Leted", deletedAt: "2026-11-16" });
    expect(env.mailer.to(v.email, "user-account-deleted")).toHaveLength(1);
    // A refused deletion (an owner whose workspace has another member) sends nothing.
    const owner = await signUpVerified(env);
    const member = await signUpVerified(env);
    await env.workspaces.invite(owner.ctx, member.email, "viewer");
    await env.accounts.settled();
    await env.workspaces.acceptInvitation(member.ctx, env.mailer.token(member.email, "invitation"));
    await env.accounts.reauthenticate(owner.ctx, { password: owner.password }, env.meta());
    expect(await code(env.accounts.deleteUser(owner.ctx, env.meta()))).toBe("CONFLICT");
    await env.accounts.settled();
    expect(env.mailer.to(owner.email, "user-account-deleted")).toEqual([]);
  });

  it("refuses to delete an owner whose workspace has other members; members leave their workspaces", async () => {
    const owner = await signUpVerified(env);
    const memberEmail = newEmail("member");
    await env.workspaces.invite(owner.ctx, memberEmail, "viewer");
    await env.accounts.settled();
    const inviteToken = remember(
      decodeURIComponent(
        String(env.mailer.last(memberEmail, "invitation")?.data.url).split("#token=")[1] ?? "",
      ),
    );
    const member = await signUpVerified(env, { email: memberEmail });
    await env.workspaces.acceptInvitation(member.ctx, inviteToken);

    await env.accounts.reauthenticate(owner.ctx, { password: owner.password }, env.meta());
    expect(await code(env.accounts.deleteUser(owner.ctx, env.meta()))).toBe("CONFLICT");

    await env.accounts.reauthenticate(member.ctx, { password: member.password }, env.meta());
    await env.accounts.deleteUser(member.ctx, env.meta());
    expect(env.reg.calls.some((c) => c.op === "remove" && c.accountId === owner.accountId)).toBe(
      true,
    );
    expect(
      env.db
        .select()
        .from(memberships)
        .where(eq(memberships.accountId, owner.accountId as string))
        .all(),
    ).toHaveLength(1);
    expect(
      env.db
        .select()
        .from(accounts)
        .all()
        .every((a) => a.status === "active"),
    ).toBe(true);
  });
});

// ==================================================================================================== audit
describe("audit and maintenance", () => {
  it("records every security-relevant action without secret material", async () => {
    const v = await signUpVerified(env);
    await env.accounts.reauthenticate(v.ctx, { password: v.password }, env.meta());
    const { secret } = env.accounts.beginTotp(v.ctx);
    remember(secret);
    env.accounts.confirmTotp(v.ctx, totpNow(env, secret));
    env.advance(30_000);
    env.accounts.regenerateRecoveryCodes(v.ctx);
    await code(env.accounts.signIn({ email: v.email, password: "wrong password!!" }, env.meta()));
    await env.accounts.disableTotp(v.ctx, totpNow(env, secret), env.meta());
    const fresh = await env.accounts.changePassword(v.ctx, v.password, newPassword(), env.meta());
    remember(fresh.token);
    env.accounts.signOut(fresh.token);
    const events = new Set(auditRows(env.db).map((r) => r.event));
    for (const e of [
      "user.signup",
      "user.email_verified",
      "user.reauthenticated",
      "user.totp_enabled",
      "user.recovery_codes_regenerated",
      "user.signin_failed",
      "user.totp_disabled",
      "user.password_changed",
      "user.signout",
    ])
      expect(events).toContain(e);
    for (const r of auditRows(env.db)) expect(r.subjectUserId ?? r.actorId).toBe(v.userId);
    assertAuditClean(env.db);
  });

  it("sign-in failures are audited at most 5 times per address per hour", async () => {
    const v = await signUpVerified(env);
    for (let i = 0; i < 8; i++)
      await code(
        env.accounts.signIn(
          { email: v.email, password: "wrong password!!", captchaToken: "captcha-ok" },
          env.meta(),
        ),
      );
    expect(auditRows(env.db).filter((r) => r.event === "user.signin_failed")).toHaveLength(5);
  });

  it("maintenance purges stale unverified users, old tokens and expired sessions", async () => {
    const stale = newEmail();
    await env.accounts.signUp(signUpInput(stale, newPassword()), env.meta());
    const kept = await signUpVerified(env);
    env.advance(ACCOUNT_TTL.unverifiedUser + DAY);
    const r = env.accounts.maintenance();
    expect(r.users).toBe(1);
    expect(r.tokens).toBeGreaterThan(0);
    expect(r.sessions).toBeGreaterThan(0);
    expect(userRow(env.db, stale)).toBeUndefined();
    expect(userRow(env.db, kept.email)).toBeDefined();
  });

  it("services did log during the suite (the log-capture check in setup.ts is not vacuous)", () => {
    expect(logLines.length).toBeGreaterThan(0);
  });
});
