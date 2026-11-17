/**
 * Accounts and authentication for cloud mode (spec 3.1-3.5, 3.7, 3.8 personal data, 3.9 delete user).
 *
 * Security properties this class is responsible for (each has a test in test/accounts*.test.ts):
 * - every secret handed out (session, verification, reset, email change, challenge, device) is a random
 *   256-bit value stored only as SHA-256 (or HMAC for devices) and compared in constant time; one-time tokens
 *   are claimed with expiry and single use checked in one transaction;
 * - sign-up, resend, forgot-password and sign-in do not reveal whether an address has an account: same
 *   status and body, the same scrypt work (a dummy hash for unknown addresses) and mail sent in the
 *   background so provider latency does not show in the response time;
 * - sign-in throttling escalates to CAPTCHA, never to a lock-out; 2FA challenges die after 5 attempts;
 * - TOTP codes are never accepted twice (`totp_last_step` advanced with a conditional update); recovery codes
 *   are single use;
 * - a new session is issued on every sign-in, second factor and password change (the old token never gains
 *   privilege); password change and reset revoke every other session; a reset also revokes the person's
 *   OAuth grants in every workspace (API keys stay);
 * - sensitive actions require a re-authentication within 10 minutes;
 * - error messages are fixed strings; nothing user-supplied is logged or written to the audit trail;
 * - federated sign-in ("Sign in with Google", federation/) finds a person by the provider's subject only.
 *   `createFromIdentity` applies the sign-up rules (adults only, terms, disposable domains, sign-up limits,
 *   one trial per address) and never takes over a verified account; `signInWithIdentity` still asks for
 *   TOTP; a Google sign-in never counts as a re-authentication. An account without a password costs the
 *   same scrypt work on a password sign-in as any other (no timing signal that it exists);
 * - a verification link alone verifies an account only in the browser whose sign-up set its password
 *   (`browser`, the `__Host-gw_signup` cookie; its hash travels with the link's token). Anywhere else the
 *   link also needs the account's current password, under the sign-in limits and without using up the link.
 *   So "the newest sign-up wins" cannot leave a person with an account whose password somebody else chose.
 */
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { CaptchaVerifier } from "../abuse/captcha.js";
import { isDisposableEmail } from "../abuse/disposable.js";
import { networkPrefix } from "../abuse/ip.js";
import type { RateLimiter } from "../abuse/rate-limiter.js";
import { SurgeDetector } from "../abuse/surge.js";
import type { ControlAudit } from "../audit.js";
import type { ControlDb } from "../control/db.js";
import {
  accounts,
  auditEvents,
  invitations,
  knownDevices,
  memberships,
  oidcFlows,
  recoveryCodes,
  sessions,
  users,
  userTokens,
} from "../control/schema.js";
import type { Keyring } from "../crypto/keyring.js";
import { newId, newUserId, randomToken, safeEqual, sha256Hex, TOKEN_RE } from "../crypto/random.js";
import {
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "../crypto/totp.js";
import { CloudError } from "../errors.js";
import type { Address, Mailer, TemplateData, TemplateId } from "../external-types.js";
import { type Logger, silentLogger } from "../log/index.js";
import {
  assertPasswordPolicy,
  DUMMY_HASH,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "../password.js";
import { stripControl } from "../text.js";
import type {
  AccountId,
  IssuedSession,
  RequestMeta,
  SessionContext,
  SessionView,
  SignInResult,
  UserId,
} from "../types.js";
import type { WorkspacesService } from "../workspaces/service.js";
import { identitiesOfUser, insertIdentity, type Provider } from "../federation/identities.js";
import { describeDevice } from "./device.js";
import { emailDomain, normalizeEmail } from "./email.js";
import { assertRecentAuthIn } from "./reauth.js";
import { claimTokenTx, dropUnused, invalidToken, issueToken, peekToken } from "./tokens.js";

export interface AccountsDeps {
  db: ControlDb;
  keys: Keyring;
  mailer: Mailer;
  captcha: CaptchaVerifier;
  limiter: RateLimiter;
  audit: ControlAudit;
  workspaces: () => WorkspacesService;
  publicUrl: string;
  now?: () => Date;
  /** Not in spec 8.3: structured logger (defaults to silent). */
  log?: Logger;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const ACCOUNT_TTL = {
  verifyEmail: 48 * HOUR,
  resetPassword: 30 * MINUTE,
  emailChange: 24 * HOUR,
  signinChallenge: 5 * MINUTE,
  sessionAbsolute: 30 * DAY,
  sessionIdle: 7 * DAY,
  sessionTouch: MINUTE,
  unverifiedUser: 7 * DAY,
} as const;

/** [limit, window] pairs (spec 3.2, 3.4, 3.7). */
export const ACCOUNT_LIMITS = {
  signinAddressIp: [5, 15 * MINUTE],
  signinIp: [20, 15 * MINUTE],
  signinAddress: [100, 15 * MINUTE],
  challengeAttempts: 5,
  secondFactorPerUser: [10, 15 * MINUTE],
  signupIpHour: [5, HOUR],
  signupIpDay: [20, DAY],
  signupNetworkDay: [50, DAY],
  resendIp: [10, HOUR],
  forgotIp: [20, HOUR],
  forgotAddress: [3, HOUR],
  mailPerAddress: [5, HOUR],
  /**
   * Security notices (a setting changed, a new sign-in) have their own budget: only a signed-in person can
   * trigger them, and anonymous mail (verification, password reset) must never use it up, or a change made
   * right after someone requested resets for the address would go unannounced.
   */
  securityMailPerAddress: [20, HOUR],
  reauthPerUser: [10, 15 * MINUTE],
  emailChangePerUser: [5, HOUR],
  signinFailedAudit: [5, HOUR],
} as const;

const NAME_MAX = 100;
const DEFAULT_WORKSPACE_NAME = "My workspace";
const TERMS_RE = /^[A-Za-z0-9._-]{1,32}$/;

type UserRow = typeof users.$inferSelect;
type Limit = readonly [number, number];

const unauthorized = () => new CloudError(401, "UNAUTHORIZED", "email or password is wrong");
const wrongCode = () => new CloudError(401, "UNAUTHORIZED", "the code is wrong");
const validation = (message: string) => new CloudError(400, "VALIDATION", message);

function cleanName(name: unknown): string {
  if (typeof name !== "string") throw validation("name is required");
  const s = stripControl(name.normalize("NFKC")).trim();
  if (s.length < 1 || s.length > NAME_MAX)
    throw validation(`name must be 1-${NAME_MAX} characters`);
  return s;
}

/** What a verification token remembers of the browser that signed up: the hash of its cookie value. */
const browserBinding = (browser: unknown): { browser?: string } =>
  typeof browser === "string" && TOKEN_RE.test(browser) ? { browser: sha256Hex(browser) } : {};

/** False for an account created through a federated sign-in that has not set a password (schema.ts). */
export const hasPassword = (u: { passwordHash: string }): boolean => u.passwordHash !== "";

type SignInMethod = "password" | "google";

const noPassword = () =>
  new CloudError(
    409,
    "CONFLICT",
    "your account has no password yet; use a two-step code, or set a password from the emailed link",
    { reason: "no-password" },
  );

const isConstraintError = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  String((err as { code?: unknown }).code).startsWith("SQLITE_CONSTRAINT");

export class AccountsService {
  private readonly db: ControlDb;
  private readonly log: Logger;
  private readonly clock: () => Date;
  private readonly publicUrl: string;
  private readonly pending = new Set<Promise<void>>();
  private readonly surge: SurgeDetector;

  constructor(private readonly d: AccountsDeps) {
    this.db = d.db;
    this.log = d.log ?? silentLogger;
    this.clock = d.now ?? (() => new Date());
    this.publicUrl = d.publicUrl.replace(/\/+$/, "");
    this.surge = new SurgeDetector(this.log);
  }

  // =============================================================================================== sign-up
  async signUp(
    i: {
      email: string;
      password: string;
      name: string;
      captchaToken?: string;
      termsVersion: string;
      /** Terms: the service is for adults. Must be `true`; stored as the time of confirmation. */
      adultConfirmed: boolean;
      /**
       * The submitting browser's `__Host-gw_signup` cookie value (the host sets it on every answer). Its hash
       * is stored with the verification link, which then works without the password in that browser only.
       */
      browser?: string | null;
      /**
       * The token of the invitation the person signed up from (the invitation page held it). Carried, sealed,
       * with the verification link, so confirming the address leads back to that invitation (`verifyEmail`).
       * Ignored unless the invitation is live; the answer is the same either way.
       */
      invitation?: string | null;
    },
    m: RequestMeta,
  ): Promise<void> {
    await this.requireCaptcha(i.captchaToken, m.ip);
    this.limit(`signup:ip:${m.ip}`, ACCOUNT_LIMITS.signupIpHour);
    this.limit(`signup:ipd:${m.ip}`, ACCOUNT_LIMITS.signupIpDay);
    this.limit(`signup:net:${networkPrefix(m.ip)}`, ACCOUNT_LIMITS.signupNetworkDay);
    const email = this.requireEmail(i.email);
    if (isDisposableEmail(emailDomain(email)))
      throw new CloudError(
        400,
        "DISPOSABLE_EMAIL",
        "addresses from disposable email services are not accepted",
      );
    const name = cleanName(i.name);
    if (typeof i.termsVersion !== "string" || !TERMS_RE.test(i.termsVersion))
      throw validation("termsVersion is required");
    if (i.adultConfirmed !== true) throw validation("confirm that you are 18 or over");
    assertPasswordPolicy({ password: i.password, email });
    // The same scrypt work whether or not the address exists.
    const passwordHash = await hashPassword(i.password);
    const display = i.email.trim();
    const now = this.clock();
    const payload = { email, ...browserBinding(i.browser), ...this.carryInvitation(i.invitation) };

    const existing = this.userByEmail(email);
    if (existing?.emailVerifiedAt) {
      this.sendMail(
        { email: existing.email, name: existing.name },
        email,
        "signup-existing-account",
        existing.id,
        {
          signInUrl: `${this.publicUrl}/signin`,
          resetUrl: `${this.publicUrl}/forgot-password`,
        },
      );
      return;
    }

    let userId: string;
    let token: string;
    try {
      ({ userId, token } = this.db.transaction((tx) => {
        if (existing) {
          // An unverified sign-up for this address exists. The newest sign-up wins: whoever controls the
          // inbox verifies, and an abandoned or squatted registration cannot block the real owner. The new
          // link is bound to this browser, so a person who signed up earlier elsewhere and follows it is
          // asked for a password they do not know (`verifyEmail`) instead of inheriting this one.
          tx.update(users)
            .set({
              email: display,
              name,
              passwordHash,
              termsVersion: i.termsVersion,
              adultConfirmedAt: now.toISOString(),
              updatedAt: now.toISOString(),
            })
            .where(eq(users.id, existing.id))
            .run();
          dropUnused(tx, existing.id, "verify_email");
          const t = issueToken(tx, {
            userId: existing.id,
            purpose: "verify_email",
            ttlMs: ACCOUNT_TTL.verifyEmail,
            now,
            payload,
          });
          return { userId: existing.id, token: t.token };
        }
        const id = newUserId();
        tx.insert(users)
          .values({
            id,
            email: display,
            emailNormalized: email,
            name,
            passwordHash,
            termsVersion: i.termsVersion,
            adultConfirmedAt: now.toISOString(),
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          })
          .run();
        const t = issueToken(tx, {
          userId: id,
          purpose: "verify_email",
          ttlMs: ACCOUNT_TTL.verifyEmail,
          now,
          payload,
        });
        return { userId: id, token: t.token };
      }));
    } catch (err) {
      // A concurrent sign-up for the same address won the unique index. Same answer as any other case.
      if (isConstraintError(err)) return;
      throw err;
    }
    if (!existing) {
      this.d.audit.record({
        actorType: "user",
        actorId: userId,
        subjectUserId: userId,
        event: "user.signup",
        ip: m.ip,
        userAgent: m.userAgent,
      });
      this.surge.record(now.getTime());
    }
    this.sendMail({ email: display, name }, email, "verify-email", userId, {
      name,
      url: this.link("/verify-email", token),
      expiresInHours: ACCOUNT_TTL.verifyEmail / HOUR,
    });
  }

  async resendVerification(email: string, m: RequestMeta): Promise<void> {
    this.limit(`resend:ip:${m.ip}`, ACCOUNT_LIMITS.resendIp);
    const norm = normalizeEmail(email);
    if (!norm) return;
    const user = this.userByEmail(norm);
    if (!user || user.emailVerifiedAt || user.disabledAt) return;
    const now = this.clock();
    const { token } = this.db.transaction((tx) => {
      // A resend changes neither the password nor who set it, so the new link keeps the browser binding of
      // the link it replaces: whoever asks, it opens without the password only where the password was chosen.
      const previous = tx
        .select({ payload: userTokens.payload })
        .from(userTokens)
        .where(
          and(
            eq(userTokens.userId, user.id),
            eq(userTokens.purpose, "verify_email"),
            isNull(userTokens.usedAt),
          ),
        )
        .orderBy(desc(userTokens.createdAt))
        .get();
      const browser = previous?.payload?.browser;
      // The invitation the sign-up came from, if any, still waits at the end of the new link.
      const invitation = previous?.payload?.invitation;
      dropUnused(tx, user.id, "verify_email");
      return issueToken(tx, {
        userId: user.id,
        purpose: "verify_email",
        ttlMs: ACCOUNT_TTL.verifyEmail,
        now,
        payload: {
          email: norm,
          ...(typeof browser === "string" ? { browser } : {}),
          ...(typeof invitation === "string" ? { invitation } : {}),
        },
      });
    });
    this.sendMail({ email: user.email, name: user.name }, norm, "verify-email", user.id, {
      name: user.name,
      url: this.link("/verify-email", token),
      expiresInHours: ACCOUNT_TTL.verifyEmail / HOUR,
    });
  }

  /**
   * Confirm the address with the emailed link. The link alone is enough only in the browser that submitted
   * the sign-up (`proof.browser`, the `__Host-gw_signup` cookie, matches the hash stored with the token).
   * Any other browser must also give the account's current password: none -> `PASSWORD_REQUIRED`; wrong ->
   * the answer of a wrong sign-in, counted against the sign-in limits (a CAPTCHA once they are passed). The
   * link is used up only by a success. A link that is not live answers `INVALID_TOKEN` whatever else is sent.
   */
  async verifyEmail(
    token: string,
    m: RequestMeta,
    proof: { browser?: string | null; password?: string; captchaToken?: string } = {},
  ): Promise<{
    userId: UserId;
    session: IssuedSession;
    accountId: AccountId | null;
    /**
     * The token of the invitation the sign-up came from, when it is still live and was sent to this address,
     * so the caller can open it next. Only ever handed to someone who has just proven the address.
     */
    invitation: string | null;
  }> {
    const now = this.clock();
    const peek = peekToken(this.db, token, "verify_email", now);
    const before = peek ? this.userById(peek.userId) : undefined;
    // The link is bound to the address it was sent to.
    if (!peek || !before || before.disabledAt || peek.payload?.email !== before.emailNormalized)
      throw invalidToken();
    const stored = peek.payload?.browser;
    const sameBrowser =
      typeof stored === "string" &&
      typeof proof.browser === "string" &&
      TOKEN_RE.test(proof.browser) &&
      safeEqual(sha256Hex(proof.browser), stored);
    if (!sameBrowser) {
      if (typeof proof.password !== "string" || proof.password === "")
        throw new CloudError(
          403,
          "PASSWORD_REQUIRED",
          "enter the password you chose when you signed up",
        );
      // The same counters as sign-in, so this is no extra way to guess a password.
      await this.throttleSignIn(before.emailNormalized, proof.captchaToken, m);
      const ok = await verifyPassword(
        proof.password,
        hasPassword(before) ? before.passwordHash : DUMMY_HASH,
      );
      if (!ok || !hasPassword(before)) {
        this.auditSigninFailed(before.id, m, "password");
        throw unauthorized();
      }
    }
    const user = this.db.transaction((tx) => {
      // A sign-up that replaced the password since the check above also dropped this token: the claim fails.
      const row = claimTokenTx(tx, token, "verify_email", this.clock());
      if (!row) return null;
      const u = tx.select().from(users).where(eq(users.id, row.userId)).get();
      if (!u || u.disabledAt || row.payload?.email !== u.emailNormalized) return null;
      if (!u.emailVerifiedAt)
        tx.update(users)
          .set({ emailVerifiedAt: now.toISOString(), updatedAt: now.toISOString() })
          .where(eq(users.id, u.id))
          .run();
      dropUnused(tx, u.id, "verify_email");
      return u;
    });
    if (!user) throw invalidToken();
    this.d.audit.record({
      actorType: "user",
      actorId: user.id,
      subjectUserId: user.id,
      event: "user.email_verified",
      ip: m.ip,
      userAgent: m.userAgent,
    });
    const started = await this.startVerifiedAccount(user, m);
    return { ...started, invitation: this.carriedInvitation(peek.payload?.invitation, user) };
  }

  /** The verification payload's part for an invitation (`signUp`): the live invitation's token, sealed. */
  private carryInvitation(token: unknown): { invitation?: string } {
    if (!this.d.workspaces().liveInvitation(token)) return {};
    return {
      invitation: this.d.keys.seal(
        "signup-invitation",
        new Uint8Array(Buffer.from(token as string, "utf8")),
      ),
    };
  }

  /** The carried invitation's token, if it is still live and addressed to this person; otherwise null. */
  private carriedInvitation(sealed: unknown, user: UserRow): string | null {
    if (typeof sealed !== "string") return null;
    let token: string;
    try {
      token = Buffer.from(this.d.keys.open("signup-invitation", sealed)).toString("utf8");
    } catch {
      return null;
    }
    const inv = this.d.workspaces().liveInvitation(token);
    return inv && safeEqual(inv.emailNormalized, user.emailNormalized) ? token : null;
  }

  /**
   * After an address is proven (verification link, or a provider that asserts a verified address): the first
   * workspace and trial (`WorkspacesService.create` grants a trial only once per address), unless the person
   * was invited somewhere, then a fresh session.
   */
  private async startVerifiedAccount(
    user: UserRow,
    m: RequestMeta,
  ): Promise<{ userId: UserId; session: IssuedSession; accountId: AccountId | null }> {
    const now = this.clock();
    let accountId: AccountId | null = this.defaultAccount(user.id);
    const invited = this.db
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.emailNormalized, user.emailNormalized),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          sql`${invitations.expiresAt} > ${now.toISOString()}`,
        ),
      )
      .get();
    // An invitee joins the inviting workspace instead (no workspace, no trial).
    if (!accountId && !invited) {
      try {
        accountId = await this.d.workspaces().create(user.id, DEFAULT_WORKSPACE_NAME);
      } catch (err) {
        this.log.error("accounts.workspace_create_failed", { userId: user.id, err });
        accountId = null;
      }
    }
    const session = this.issueSession(user.id, m, {
      mfa: false,
      reauth: false,
      activeAccountId: accountId,
    });
    session.newDeviceToken = this.recognizeDevice(user.id, m.deviceToken).newToken;
    this.db
      .update(users)
      .set({ lastSigninAt: now.toISOString() })
      .where(eq(users.id, user.id))
      .run();
    return { userId: user.id, session, accountId };
  }

  // =============================================================================================== sign-in
  async signIn(
    i: { email: string; password: string; captchaToken?: string },
    m: RequestMeta,
  ): Promise<SignInResult> {
    const norm = normalizeEmail(i.email);
    await this.throttleSignIn(
      norm ?? `invalid:${typeof i.email === "string" ? i.email.slice(0, 300) : ""}`,
      i.captchaToken,
      m,
    );

    const password = typeof i.password === "string" ? i.password : "";
    const user = norm ? this.userByEmail(norm) : undefined;
    if (!user || user.disabledAt) {
      await verifyPassword(password, DUMMY_HASH);
      throw unauthorized();
    }
    // No password (a Google-only account): the same scrypt work and the same answer as a wrong password.
    if (!hasPassword(user)) {
      await verifyPassword(password, DUMMY_HASH);
      this.auditSigninFailed(user.id, m, "password");
      throw unauthorized();
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      this.auditSigninFailed(user.id, m, "password");
      throw unauthorized();
    }
    if (needsRehash(user.passwordHash)) {
      const upgraded = await hashPassword(password);
      this.db.update(users).set({ passwordHash: upgraded }).where(eq(users.id, user.id)).run();
    }
    // The password proves ownership of the account, so saying "not verified" reveals nothing new.
    if (!user.emailVerifiedAt)
      throw new CloudError(
        403,
        "EMAIL_NOT_VERIFIED",
        "confirm your email address first; check your inbox",
      );
    if (user.totpEnabledAt) return this.challenge(user.id, "password");
    return {
      kind: "signed-in",
      session: this.finishSignIn(user, m, { mfa: false, reauth: true, method: "password" }),
      userId: user.id,
    };
  }

  /**
   * Sign-in through a linked federated identity (the caller has validated the provider's ID token and found
   * the link by subject). The provider replaces the password step only: TOTP still applies. The session is
   * NOT marked re-authenticated (spec 3.2 sensitive actions still ask for a password or a TOTP code).
   */
  signInWithIdentity(userId: UserId, method: Exclude<SignInMethod, "password">, m: RequestMeta) {
    const user = this.userById(userId);
    if (!user || user.disabledAt || !user.emailVerifiedAt)
      throw new CloudError(401, "UNAUTHORIZED", "this sign-in is not available");
    if (user.totpEnabledAt) return this.challenge(user.id, method);
    return {
      kind: "signed-in" as const,
      session: this.finishSignIn(user, m, { mfa: false, reauth: false, method }),
      userId: user.id,
    };
  }

  /**
   * A new person from a federated sign-in, after they confirmed the sign-up step (name, adults only, terms).
   * The same rules as `signUp`, except the CAPTCHA (the provider's sign-in is the human check) and the email
   * round trip (the provider asserted a verified address, `email_verified === true`).
   *
   * Never a takeover: a verified account with this address is refused (`account-exists`; the person signs in
   * with their password and links the provider in settings). An UNVERIFIED registration of the address is
   * discarded instead (spec 3.1 "newest sign-up wins"): whoever created it never proved the inbox, it has no
   * workspace, membership or data, and its password is never carried over, so nothing of it survives to be
   * used against the person who just proved the address.
   */
  async createFromIdentity(
    i: {
      provider: Provider;
      subject: string;
      email: string;
      name: string;
      termsVersion: string;
      adultConfirmed: boolean;
    },
    m: RequestMeta,
  ): Promise<{ userId: UserId; session: IssuedSession; accountId: AccountId | null }> {
    this.limit(`signup:ip:${m.ip}`, ACCOUNT_LIMITS.signupIpHour);
    this.limit(`signup:ipd:${m.ip}`, ACCOUNT_LIMITS.signupIpDay);
    this.limit(`signup:net:${networkPrefix(m.ip)}`, ACCOUNT_LIMITS.signupNetworkDay);
    const email = this.requireEmail(i.email);
    if (isDisposableEmail(emailDomain(email)))
      throw new CloudError(
        400,
        "DISPOSABLE_EMAIL",
        "addresses from disposable email services are not accepted",
      );
    const name = cleanName(i.name);
    if (typeof i.termsVersion !== "string" || !TERMS_RE.test(i.termsVersion))
      throw validation("termsVersion is required");
    if (i.adultConfirmed !== true) throw validation("confirm that you are 18 or over");
    const display = i.email.trim();
    const now = this.clock();
    const exists = () =>
      new CloudError(409, "CONFLICT", "an account with this email address already exists", {
        reason: "account-exists",
      });
    let user: UserRow;
    try {
      user = this.db.transaction((tx) => {
        const existing = tx.select().from(users).where(eq(users.emailNormalized, email)).get();
        if (existing?.emailVerifiedAt || existing?.disabledAt) throw exists();
        if (existing) {
          // Unverified: never merged. Its pending links die with it (cascade), so a verification email the
          // squatter triggered can no longer confirm anything.
          tx.delete(users).where(eq(users.id, existing.id)).run();
        }
        const id = newUserId();
        tx.insert(users)
          .values({
            id,
            email: display,
            emailNormalized: email,
            name,
            passwordHash: "",
            emailVerifiedAt: now.toISOString(),
            termsVersion: i.termsVersion,
            adultConfirmedAt: now.toISOString(),
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          })
          .run();
        insertIdentity(tx, {
          userId: id,
          provider: i.provider,
          subject: i.subject,
          email: display,
          now,
        });
        return tx.select().from(users).where(eq(users.id, id)).get() as UserRow;
      });
    } catch (err) {
      // A concurrent sign-up for the address, or the same Google account finishing twice.
      if (isConstraintError(err)) throw exists();
      throw err;
    }
    for (const event of ["user.signup", "user.email_verified", "identity.linked"] as const)
      this.d.audit.record({
        actorType: "user",
        actorId: user.id,
        subjectUserId: user.id,
        event,
        ip: m.ip,
        userAgent: m.userAgent,
        detail: { method: i.provider },
      });
    this.surge.record(now.getTime());
    this.log.info("auth.signup", { userId: user.id, method: i.provider });
    return this.startVerifiedAccount(user, m);
  }

  async completeSecondFactor(
    i: { challenge: string; code?: string; recoveryCode?: string },
    m: RequestMeta,
  ): Promise<{ session: IssuedSession; userId: UserId }> {
    if (!i.code && !i.recoveryCode) throw validation("code or recoveryCode is required");
    const now = this.clock();
    // Count the attempt first, in one transaction; the fifth attempt kills the challenge.
    const row = this.db.transaction((tx) => {
      const r = peekToken(tx, i.challenge, "signin_challenge", now);
      if (!r) return null;
      const attempts = Number(r.payload?.attempts ?? 0) + 1;
      tx.update(userTokens)
        .set({
          payload: { ...(r.payload ?? {}), attempts },
          usedAt: attempts >= ACCOUNT_LIMITS.challengeAttempts ? now.toISOString() : null,
        })
        .where(and(eq(userTokens.id, r.id), isNull(userTokens.usedAt)))
        .run();
      return { ...r, attempts };
    });
    if (!row) throw invalidToken();
    this.limit(`2fa:${row.userId}`, ACCOUNT_LIMITS.secondFactorPerUser);
    const user = this.userById(row.userId);
    if (!user || user.disabledAt || !user.totpEnabledAt) throw invalidToken();

    let method: "totp" | "recovery";
    let ok: boolean;
    if (i.code) {
      method = "totp";
      ok = this.consumeTotp(user, i.code, now);
    } else {
      method = "recovery";
      ok = this.consumeRecoveryCode(user.id, i.recoveryCode ?? "", now);
    }
    if (!ok) {
      this.auditSigninFailed(user.id, m, method);
      throw wrongCode();
    }
    // Claim the challenge itself (single use, even if two requests raced with two valid codes).
    const claimed = this.db
      .update(userTokens)
      .set({ usedAt: now.toISOString() })
      .where(and(eq(userTokens.id, row.id), isNull(userTokens.usedAt)))
      .run();
    if (claimed.changes !== 1) throw invalidToken();
    if (method === "recovery") {
      const left = this.remainingRecoveryCodes(user.id);
      this.d.audit.record({
        actorType: "user",
        actorId: user.id,
        subjectUserId: user.id,
        event: "user.recovery_codes_used",
        ip: m.ip,
        userAgent: m.userAgent,
        detail: { count: left },
      });
      this.securityMail(user, "recovery-code-used");
    }
    const first: SignInMethod = row.payload?.method === "google" ? "google" : "password";
    return {
      session: this.finishSignIn(user, m, { mfa: true, reauth: true, method: first }),
      userId: user.id,
    };
  }

  // ============================================================================================== sessions
  resolveSession(token: string | undefined): SessionContext | null {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
    const id = sha256Hex(token);
    const row = this.db
      .select({ s: sessions, u: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, id))
      .get();
    if (!row || !safeEqual(row.s.id, id)) return null;
    const now = this.clock();
    const idleLimit = new Date(now.getTime() - ACCOUNT_TTL.sessionIdle).toISOString();
    if (row.s.expiresAt <= now.toISOString() || row.s.lastSeenAt < idleLimit) {
      this.db.delete(sessions).where(eq(sessions.id, id)).run();
      return null;
    }
    if (row.u.disabledAt || !row.u.emailVerifiedAt) return null;
    if (now.getTime() - Date.parse(row.s.lastSeenAt) > ACCOUNT_TTL.sessionTouch)
      this.db
        .update(sessions)
        .set({ lastSeenAt: now.toISOString() })
        .where(eq(sessions.id, id))
        .run();
    let active = row.s.activeAccountId;
    if (active && !this.isMember(active, row.u.id)) {
      // Removed from the workspace: the session survives, the access does not.
      this.db.update(sessions).set({ activeAccountId: null }).where(eq(sessions.id, id)).run();
      active = null;
    }
    return {
      sessionId: id,
      userId: row.u.id,
      email: row.u.email,
      name: row.u.name,
      csrf: row.s.csrf,
      activeAccountId: active,
      mfa: row.s.mfa,
      reauthAt: row.s.reauthAt ? new Date(row.s.reauthAt) : null,
      expiresAt: new Date(row.s.expiresAt),
    };
  }

  signOut(token: string | undefined): void {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return;
    const id = sha256Hex(token);
    const row = this.db
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    if (!row) return;
    this.db.delete(sessions).where(eq(sessions.id, id)).run();
    this.d.audit.record({
      actorType: "user",
      actorId: row.userId,
      subjectUserId: row.userId,
      event: "user.signout",
    });
  }

  /**
   * Re-authentication (spec 3.2) with session rotation (review finding 5): the old session row is replaced by a
   * new one (new cookie value and CSRF token, same absolute expiry, `reauth_at` now), so a session token that
   * leaked before the re-authentication never carries the elevated state. `s` is updated in place and the new
   * session is returned for the host to set as cookies.
   */
  async reauthenticate(
    s: SessionContext,
    i: { password?: string; totpCode?: string },
    m: RequestMeta,
  ): Promise<IssuedSession> {
    this.limit(`reauth:${s.userId}`, ACCOUNT_LIMITS.reauthPerUser);
    const user = this.requireUser(s.userId);
    const now = this.clock();
    let ok = false;
    let method: "password" | "totp";
    if (i.totpCode) {
      method = "totp";
      ok = !!user.totpEnabledAt && this.consumeTotp(user, i.totpCode, now);
    } else if (i.password) {
      method = "password";
      if (!hasPassword(user)) {
        await verifyPassword(i.password, DUMMY_HASH);
        throw noPassword();
      }
      ok = await verifyPassword(i.password, user.passwordHash);
    } else throw validation("password or totpCode is required");
    if (!ok) {
      this.auditSigninFailed(user.id, m, method);
      throw method === "totp"
        ? wrongCode()
        : new CloudError(401, "UNAUTHORIZED", "the password is wrong");
    }
    const old = this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, s.sessionId), eq(sessions.userId, s.userId)))
      .get();
    if (!old) throw new CloudError(401, "UNAUTHORIZED", "sign in again");
    const issued = this.db.transaction(() => {
      this.db.delete(sessions).where(eq(sessions.id, old.id)).run();
      return this.issueSession(user.id, m, {
        mfa: old.mfa || method === "totp",
        reauth: true,
        activeAccountId: old.activeAccountId,
        expiresAt: new Date(old.expiresAt),
      });
    });
    s.sessionId = sha256Hex(issued.token);
    s.csrf = issued.csrf;
    s.reauthAt = now;
    s.mfa = old.mfa || method === "totp";
    s.expiresAt = issued.expiresAt;
    this.d.audit.record({
      actorType: "user",
      actorId: user.id,
      subjectUserId: user.id,
      event: "user.reauthenticated",
      ip: m.ip,
      userAgent: m.userAgent,
      detail: { method },
    });
    return issued;
  }

  assertRecentAuth(s: SessionContext): void {
    assertRecentAuthIn(this.db, s, this.clock());
  }

  listSessions(s: SessionContext): SessionView[] {
    const now = this.clock();
    const idleLimit = new Date(now.getTime() - ACCOUNT_TTL.sessionIdle).toISOString();
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, s.userId))
      .orderBy(desc(sessions.lastSeenAt))
      .all()
      .filter((r) => r.expiresAt > now.toISOString() && r.lastSeenAt >= idleLimit)
      .map((r) => ({
        id: publicSessionId(r.id),
        device: describeDevice(r.userAgent),
        ip: r.ip,
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
        current: r.id === s.sessionId,
      }));
  }

  revokeSession(s: SessionContext, id: string): void {
    if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id))
      throw new CloudError(404, "NOT_FOUND", "no such session");
    const target = this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, s.userId))
      .all()
      .find((r) => safeEqual(publicSessionId(r.id), id));
    if (!target) throw new CloudError(404, "NOT_FOUND", "no such session");
    this.db
      .delete(sessions)
      .where(and(eq(sessions.id, target.id), eq(sessions.userId, s.userId)))
      .run();
    this.d.audit.record({
      actorType: "user",
      actorId: s.userId,
      subjectUserId: s.userId,
      event: "user.session_revoked",
      detail: { sessionId: id, count: 1 },
    });
  }

  revokeOtherSessions(s: SessionContext): number {
    const n = this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, s.userId), ne(sessions.id, s.sessionId)))
      .run().changes;
    this.d.audit.record({
      actorType: "user",
      actorId: s.userId,
      subjectUserId: s.userId,
      event: "user.session_revoked",
      detail: { count: n },
    });
    return n;
  }

  setActiveAccount(s: SessionContext, accountId: AccountId): void {
    if (typeof accountId !== "string" || !this.isMember(accountId, s.userId))
      throw new CloudError(403, "FORBIDDEN", "you are not a member of that workspace");
    this.db
      .update(sessions)
      .set({ activeAccountId: accountId })
      .where(and(eq(sessions.id, s.sessionId), eq(sessions.userId, s.userId)))
      .run();
    s.activeAccountId = accountId;
  }

  // ============================================================================================= passwords
  async requestPasswordReset(
    email: string,
    captchaToken: string | undefined,
    m: RequestMeta,
  ): Promise<void> {
    await this.requireCaptcha(captchaToken, m.ip);
    this.limit(`forgot:ip:${m.ip}`, ACCOUNT_LIMITS.forgotIp);
    const norm = normalizeEmail(email);
    if (!norm) return;
    // Per-address limit is silent: answering differently would say something about the address.
    if (
      !this.d.limiter.hit(`forgot:a:${this.emailKey(norm)}`, ...ACCOUNT_LIMITS.forgotAddress)
        .allowed
    )
      return;
    const user = this.userByEmail(norm);
    if (!user || user.disabledAt || !user.emailVerifiedAt) return;
    const now = this.clock();
    const { token } = this.db.transaction((tx) => {
      dropUnused(tx, user.id, "reset_password");
      return issueToken(tx, {
        userId: user.id,
        purpose: "reset_password",
        ttlMs: ACCOUNT_TTL.resetPassword,
        now,
      });
    });
    this.sendMail({ email: user.email, name: user.name }, norm, "password-reset", user.id, {
      name: user.name,
      url: this.link("/reset-password", token),
      expiresInMinutes: ACCOUNT_TTL.resetPassword / MINUTE,
    });
  }

  /**
   * Not in spec 3.4: a signed-in person without a password (Google-only) asks for a link to set their first
   * one. It is the password-reset email to their own verified address: following it proves control of the
   * inbox now (the fresh check for this action), sets the password, signs out everywhere and signs in again
   * (TOTP still applies). Same per-address limit as forgot-password.
   */
  requestPasswordSetup(s: SessionContext): void {
    const user = this.requireUser(s.userId);
    if (hasPassword(user))
      throw new CloudError(409, "CONFLICT", "you already have a password; change it instead");
    // Only the signed-in person can ask for this link, so neither its limit nor its mail budget is shared
    // with forgot-password and sign-up, which anyone can spend (security review finding 9).
    this.limit(`setup:u:${user.id}`, ACCOUNT_LIMITS.forgotAddress);
    const now = this.clock();
    const { token } = this.db.transaction((tx) => {
      dropUnused(tx, user.id, "reset_password");
      return issueToken(tx, {
        userId: user.id,
        purpose: "reset_password",
        ttlMs: ACCOUNT_TTL.resetPassword,
        now,
      });
    });
    this.sendMail(
      { email: user.email, name: user.name },
      user.emailNormalized,
      "password-reset",
      user.id,
      {
        name: user.name,
        url: this.link("/reset-password", token),
        expiresInMinutes: ACCOUNT_TTL.resetPassword / MINUTE,
      },
      "security",
    );
  }

  /**
   * Sets the password, signs out everywhere, then signs in. 2FA is never bypassed: TOTP users get a challenge.
   * Not in spec 3.4: the person's connected apps (OAuth access tokens, refresh tokens, unused authorization
   * codes) are revoked in every workspace they belong to; API keys keep working. A workspace that cannot be
   * opened never fails the reset: its revocation happens before its next lease (tenancy/registry.ts).
   */
  async resetPassword(token: string, password: string, m: RequestMeta): Promise<SignInResult> {
    const now = this.clock();
    const peek = peekToken(this.db, token, "reset_password", now);
    if (!peek) throw invalidToken();
    const before = this.userById(peek.userId);
    if (!before || before.disabledAt) throw invalidToken();
    assertPasswordPolicy({ password, email: before.emailNormalized });
    const passwordHash = await hashPassword(password);
    const user = this.db.transaction((tx) => {
      const row = claimTokenTx(tx, token, "reset_password", this.clock());
      if (!row) return null;
      tx.update(users)
        .set({ passwordHash, updatedAt: now.toISOString() })
        .where(eq(users.id, row.userId))
        .run();
      tx.delete(sessions).where(eq(sessions.userId, row.userId)).run();
      // Connected apps (OAuth grants) live in each workspace's database: owed here, in the same transaction
      // as the new password, and carried out by the tenant registry before the next lease of each workspace.
      tx.update(memberships)
        .set({ oauthRevokePendingAt: now.toISOString() })
        .where(eq(memberships.userId, row.userId))
        .run();
      dropUnused(tx, row.userId, "reset_password");
      dropUnused(tx, row.userId, "signin_challenge");
      // A pending email change was asked for by whoever held the account before this reset. Left alive, its
      // link would move the account to their address afterwards, and the next reset would go to them.
      dropUnused(tx, row.userId, "email_change");
      return tx.select().from(users).where(eq(users.id, row.userId)).get() ?? null;
    });
    if (!user) throw invalidToken();
    await this.d.workspaces().revokeOAuthGrantsNow(user.id);
    this.d.audit.record({
      actorType: "user",
      actorId: user.id,
      subjectUserId: user.id,
      event: "user.password_reset",
      ip: m.ip,
      userAgent: m.userAgent,
    });
    this.securityMail(user, "password-reset");
    if (user.totpEnabledAt) return this.challenge(user.id, "password");
    return {
      kind: "signed-in",
      session: this.finishSignIn(user, m, { mfa: false, reauth: false, method: "password" }),
      userId: user.id,
    };
  }

  /**
   * The current password is the re-authentication for this action. Every session of the user, including the
   * calling one, is revoked and a fresh session is returned (rotation).
   */
  async changePassword(
    s: SessionContext,
    current: string,
    next: string,
    m: RequestMeta,
  ): Promise<IssuedSession> {
    this.limit(`reauth:${s.userId}`, ACCOUNT_LIMITS.reauthPerUser);
    const user = this.requireUser(s.userId);
    if (!hasPassword(user)) throw noPassword();
    if (!(await verifyPassword(typeof current === "string" ? current : "", user.passwordHash))) {
      this.auditSigninFailed(user.id, m, "password");
      throw new CloudError(401, "UNAUTHORIZED", "the current password is wrong");
    }
    assertPasswordPolicy({ password: next, email: user.emailNormalized });
    const passwordHash = await hashPassword(next);
    const now = this.clock();
    const old = this.db.select().from(sessions).where(eq(sessions.id, s.sessionId)).get();
    this.db.transaction((tx) => {
      tx.update(users)
        .set({ passwordHash, updatedAt: now.toISOString() })
        .where(eq(users.id, user.id))
        .run();
      tx.delete(sessions).where(eq(sessions.userId, user.id)).run();
      dropUnused(tx, user.id, "reset_password");
      dropUnused(tx, user.id, "email_change");
    });
    const issued = this.issueSession(user.id, m, {
      mfa: old?.mfa ?? false,
      reauth: true,
      activeAccountId: old?.activeAccountId ?? null,
    });
    this.d.audit.record({
      actorType: "user",
      actorId: user.id,
      subjectUserId: user.id,
      event: "user.password_changed",
      ip: m.ip,
      userAgent: m.userAgent,
    });
    this.securityMail(user, "password-changed");
    return issued;
  }

  // ========================================================================================= email change
  async requestEmailChange(s: SessionContext, newEmail: string, _m: RequestMeta): Promise<void> {
    this.assertRecentAuth(s);
    this.limit(`emailchange:${s.userId}`, ACCOUNT_LIMITS.emailChangePerUser);
    const norm = this.requireEmail(newEmail);
    if (isDisposableEmail(emailDomain(norm)))
      throw new CloudError(
        400,
        "DISPOSABLE_EMAIL",
        "addresses from disposable email services are not accepted",
      );
    const user = this.requireUser(s.userId);
    if (norm === user.emailNormalized) throw validation("that is already your address");
    const taken = !!this.userByEmail(norm);
    const display = newEmail.trim();
    const now = this.clock();
    const issued = this.db.transaction((tx) => {
      dropUnused(tx, user.id, "email_change");
      // An address that belongs to someone else gets nothing, and the caller is told nothing.
      if (taken) return null;
      return issueToken(tx, {
        userId: user.id,
        purpose: "email_change",
        ttlMs: ACCOUNT_TTL.emailChange,
        now,
        payload: { email: display, emailNormalized: norm, from: user.emailNormalized },
      });
    });
    if (issued)
      this.sendMail({ email: display, name: user.name }, norm, "email-change-confirm", user.id, {
        name: user.name,
        url: this.link("/confirm-email", issued.token),
        newEmail: display,
        expiresInHours: ACCOUNT_TTL.emailChange / HOUR,
      });
    // Warn the current address at once, so its owner can react before the change is confirmed. It is told a
    // change was requested, not that it happened (that notice follows on confirmation).
    this.sendMail(
      { email: user.email, name: user.name },
      user.emailNormalized,
      "email-change-requested",
      user.id,
      {
        name: user.name,
        newEmail: display,
        at: now.toISOString(),
        expiresInHours: ACCOUNT_TTL.emailChange / HOUR,
        securityUrl: `${this.publicUrl}/settings/security`,
      },
      "security",
    );
  }

  async confirmEmailChange(token: string, m: RequestMeta): Promise<void> {
    const now = this.clock();
    let changed: { old: UserRow; email: string } | null;
    try {
      changed = this.db.transaction((tx) => {
        const row = claimTokenTx(tx, token, "email_change", now);
        if (!row) return null;
        const p = row.payload ?? {};
        const email = typeof p.email === "string" ? p.email : null;
        const norm = typeof p.emailNormalized === "string" ? p.emailNormalized : null;
        const u = tx.select().from(users).where(eq(users.id, row.userId)).get();
        // Bound to the address the user had when asking: a second change in between voids the link.
        if (!email || !norm || !u || u.disabledAt || p.from !== u.emailNormalized) return null;
        tx.update(users)
          .set({
            email,
            emailNormalized: norm,
            emailVerifiedAt: now.toISOString(),
            updatedAt: now.toISOString(),
          })
          .where(eq(users.id, u.id))
          .run();
        // Links already mailed to the old address must not keep working.
        dropUnused(tx, u.id, "reset_password");
        dropUnused(tx, u.id, "verify_email");
        return { old: u, email };
      });
    } catch (err) {
      if (isConstraintError(err))
        throw new CloudError(409, "CONFLICT", "that address is already in use");
      throw err;
    }
    if (!changed) throw invalidToken();
    const userId = changed.old.id;
    this.d.audit.record({
      actorType: "user",
      actorId: userId,
      subjectUserId: userId,
      event: "user.email_changed",
      ip: m.ip,
      userAgent: m.userAgent,
    });
    // The old address learns the change happened (it was told of the request earlier).
    this.sendMail(
      { email: changed.old.email, name: changed.old.name },
      changed.old.emailNormalized,
      "security-change",
      userId,
      {
        name: changed.old.name,
        change: "email-changed",
        newEmail: changed.email,
        at: now.toISOString(),
        securityUrl: `${this.publicUrl}/settings/security`,
      },
      "security",
    );
  }

  // ================================================================================================ TOTP
  beginTotp(s: SessionContext): { secret: string; otpauthUri: string } {
    this.assertRecentAuth(s);
    const user = this.requireUser(s.userId);
    if (user.totpEnabledAt)
      throw new CloudError(409, "CONFLICT", "two-factor authentication is already on");
    const secret = newTotpSecret();
    this.db
      .update(users)
      .set({
        totpSecretEnc: this.d.keys.seal("totp", Buffer.from(secret, "utf8")),
        totpLastStep: null,
      })
      .where(and(eq(users.id, user.id), isNull(users.totpEnabledAt)))
      .run();
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  }

  confirmTotp(s: SessionContext, code: string): { recoveryCodes: string[] } {
    this.assertRecentAuth(s);
    this.limit(`totpconfirm:${s.userId}`, ACCOUNT_LIMITS.reauthPerUser);
    const user = this.requireUser(s.userId);
    if (user.totpEnabledAt)
      throw new CloudError(409, "CONFLICT", "two-factor authentication is already on");
    if (!user.totpSecretEnc)
      throw new CloudError(409, "CONFLICT", "start two-factor enrolment first");
    const now = this.clock();
    const step = verifyTotp(this.openTotp(user.totpSecretEnc), code, now.getTime(), null);
    if (step === null)
      throw new CloudError(400, "VALIDATION", "the code is wrong; check the time on your device");
    const codes = newRecoveryCodes();
    const enabled = this.db.transaction((tx) => {
      const res = tx
        .update(users)
        .set({ totpEnabledAt: now.toISOString(), totpLastStep: step, updatedAt: now.toISOString() })
        .where(and(eq(users.id, user.id), isNull(users.totpEnabledAt)))
        .run();
      if (res.changes !== 1) return false;
      this.replaceRecoveryCodes(tx, user.id, codes, now);
      tx.update(sessions).set({ mfa: true }).where(eq(sessions.id, s.sessionId)).run();
      return true;
    });
    if (!enabled) throw new CloudError(409, "CONFLICT", "two-factor authentication is already on");
    s.mfa = true;
    this.d.audit.record({
      actorType: "user",
      actorId: user.id,
      subjectUserId: user.id,
      event: "user.totp_enabled",
    });
    this.securityMail(user, "totp-enabled");
    return { recoveryCodes: codes };
  }

  /** The code (a TOTP code, or a recovery code for someone who lost the device) is the re-authentication. */
  async disableTotp(s: SessionContext, code: string, m: RequestMeta): Promise<void> {
    this.limit(`reauth:${s.userId}`, ACCOUNT_LIMITS.reauthPerUser);
    const user = this.requireUser(s.userId);
    if (!user.totpEnabledAt)
      throw new CloudError(409, "CONFLICT", "two-factor authentication is not on");
    const now = this.clock();
    const ok =
      typeof code === "string" && /^\s*\d[\d\s]*$/.test(code)
        ? this.consumeTotp(user, code, now)
        : this.consumeRecoveryCode(user.id, code, now);
    if (!ok) {
      this.auditSigninFailed(user.id, m, "totp");
      throw wrongCode();
    }
    this.db.transaction((tx) => {
      tx.update(users)
        .set({
          totpSecretEnc: null,
          totpEnabledAt: null,
          totpLastStep: null,
          updatedAt: now.toISOString(),
        })
        .where(eq(users.id, user.id))
        .run();
      tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id)).run();
      dropUnused(tx, user.id, "email_change");
    });
    this.d.audit.record({
      actorType: "user",
      actorId: user.id,
      subjectUserId: user.id,
      event: "user.totp_disabled",
      ip: m.ip,
      userAgent: m.userAgent,
    });
    this.securityMail(user, "totp-disabled");
  }

  regenerateRecoveryCodes(s: SessionContext): { recoveryCodes: string[] } {
    this.assertRecentAuth(s);
    const user = this.requireUser(s.userId);
    if (!user.totpEnabledAt)
      throw new CloudError(409, "CONFLICT", "two-factor authentication is not on");
    const codes = newRecoveryCodes();
    const now = this.clock();
    this.db.transaction((tx) => this.replaceRecoveryCodes(tx, user.id, codes, now));
    this.d.audit.record({
      actorType: "user",
      actorId: user.id,
      subjectUserId: user.id,
      event: "user.recovery_codes_regenerated",
    });
    this.securityMail(user, "recovery-codes-regenerated");
    return { recoveryCodes: codes };
  }

  // ============================================================================================= profile
  /**
   * Validation and the control-plane write happen before this returns (a bad value throws at once). A new
   * name is then copied into the member mirror of each of the person's workspaces; the returned promise
   * settles when that is done (it never rejects; a workspace it could not reach is corrected when it next
   * opens, `TenantRegistry` reconciliation).
   */
  updateProfile(
    s: SessionContext,
    p: { name?: string; signinAlerts?: boolean; checkinEmails?: boolean },
  ): Promise<void> {
    const set: Partial<typeof users.$inferInsert> = {};
    if (p.name !== undefined) set.name = cleanName(p.name);
    if (p.signinAlerts !== undefined) {
      if (typeof p.signinAlerts !== "boolean") throw validation("signinAlerts must be a boolean");
      set.signinAlerts = p.signinAlerts;
    }
    if (p.checkinEmails !== undefined) {
      if (typeof p.checkinEmails !== "boolean") throw validation("checkinEmails must be a boolean");
      set.checkinEmails = p.checkinEmails;
    }
    if (Object.keys(set).length === 0) return Promise.resolve();
    set.updatedAt = this.clock().toISOString();
    this.db.update(users).set(set).where(eq(users.id, s.userId)).run();
    if (!set.name) return Promise.resolve();
    s.name = set.name;
    const sync: Promise<void> = this.d
      .workspaces()
      .syncMemberName(s.userId)
      .catch((err: unknown) => this.log.error("accounts.member_name_sync_error", { err }))
      .finally(() => {
        this.pending.delete(sync);
      });
    this.pending.add(sync);
    return sync;
  }

  /** The person's control-plane data (spec 3.8). No password hash, TOTP secret, token or code. */
  personalData(s: SessionContext): Record<string, unknown> {
    const u = this.requireUser(s.userId);
    const ms = this.db
      .select({
        accountId: memberships.accountId,
        role: memberships.role,
        joinedAt: memberships.createdAt,
        workspaceName: accounts.name,
      })
      .from(memberships)
      .innerJoin(accounts, eq(accounts.id, memberships.accountId))
      .where(eq(memberships.userId, u.id))
      .all();
    const events = this.db
      .select({
        at: auditEvents.at,
        event: auditEvents.event,
        accountId: auditEvents.accountId,
        ip: auditEvents.ip,
        userAgent: auditEvents.userAgent,
        detail: auditEvents.detail,
      })
      .from(auditEvents)
      .where(or(eq(auditEvents.subjectUserId, u.id), eq(auditEvents.actorId, u.id)))
      .orderBy(desc(auditEvents.at))
      .limit(1000)
      .all();
    return {
      exportedAt: this.clock().toISOString(),
      profile: {
        id: u.id,
        email: u.email,
        name: u.name,
        emailVerifiedAt: u.emailVerifiedAt,
        twoFactorEnabled: !!u.totpEnabledAt,
        signinAlerts: u.signinAlerts,
        checkinEmails: u.checkinEmails,
        termsVersion: u.termsVersion,
        adultConfirmedAt: u.adultConfirmedAt,
        createdAt: u.createdAt,
        lastSigninAt: u.lastSigninAt,
      },
      memberships: ms,
      // Linked sign-in providers: which one and when. No provider token exists to export (none is stored).
      identities: this.identities(u.id),
      sessions: this.listSessions(s),
      knownDevices: this.db
        .select({ firstSeenAt: knownDevices.firstSeenAt, lastSeenAt: knownDevices.lastSeenAt })
        .from(knownDevices)
        .where(eq(knownDevices.userId, u.id))
        .all(),
      securityEvents: events,
    };
  }

  /** How this person can sign in (security settings, auth status). */
  signInMethods(userId: UserId): {
    passwordSet: boolean;
    identities: ReturnType<AccountsService["identities"]>;
  } {
    const u = this.requireUser(userId);
    return { passwordSet: hasPassword(u), identities: this.identities(u.id) };
  }

  /** The person's linked sign-in providers (settings, personal data). */
  identities(userId: UserId): Array<{
    provider: Provider;
    email: string | null;
    linkedAt: string;
    lastUsedAt: string | null;
  }> {
    return identitiesOfUser(this.db, userId).map((r) => ({
      provider: r.provider,
      email: r.emailAtLink,
      linkedAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    }));
  }

  /**
   * Delete the person (spec 3.9) and email them a confirmation (`user-account-deleted`, a security notice:
   * its own mail budget, like `securityMail`). Refused while they own a workspace with other members. Everything else is a
   * resumable task in `WorkspacesService.deleteUserAccount` (review finding 5): the user is disabled and signed
   * out at once; their sole-owner workspace is deleted through the same internal path as an owner's deletion
   * (no made-up session); memberships elsewhere are left (tenant mirror first); then the user row goes and with
   * it (cascade) sessions, tokens, recovery codes and devices. `trial_grants` keeps only the address HMAC.
   */
  async deleteUser(s: SessionContext, m: RequestMeta): Promise<void> {
    this.assertRecentAuth(s);
    const user = this.requireUser(s.userId);
    const owned = this.db
      .select({ accountId: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.ownerUserId, user.id),
          inArray(accounts.status, ["active", "suspended", "migration_failed", "deleting"]),
        ),
      )
      .all();
    for (const o of owned) {
      const others = this.db
        .select({ n: sql<number>`count(*)` })
        .from(memberships)
        .where(and(eq(memberships.accountId, o.accountId), ne(memberships.userId, user.id)))
        .get();
      if ((others?.n ?? 0) > 0)
        throw new CloudError(
          409,
          "CONFLICT",
          "you own a workspace with other members; transfer ownership or delete the workspace first",
        );
    }
    await this.d.workspaces().deleteUserAccount(user.id, { ip: m.ip, userAgent: m.userAgent });
    // A security notice to the address the account had (read above: the row is gone now). Access ended in
    // deleteUserAccount's first step, so this is true even if a later step is still to be resumed.
    this.sendMail(
      { email: user.email, name: user.name },
      user.emailNormalized,
      "user-account-deleted",
      user.id,
      { name: user.name, deletedAt: this.clock().toISOString().slice(0, 10) },
      "security",
    );
  }

  // ========================================================================================= maintenance
  /**
   * Not in spec 8.3. Periodic clean-up (run from the host's sweeper): unverified users older than 7 days with no
   * membership, used or expired tokens older than a day, expired sessions.
   */
  maintenance(): { users: number; tokens: number; sessions: number } {
    const now = this.clock();
    const cutoff = new Date(now.getTime() - ACCOUNT_TTL.unverifiedUser).toISOString();
    const dayAgo = new Date(now.getTime() - DAY).toISOString();
    const idle = new Date(now.getTime() - ACCOUNT_TTL.sessionIdle).toISOString();
    const stale = this.db
      .select({ id: users.id })
      .from(users)
      .where(and(isNull(users.emailVerifiedAt), lt(users.createdAt, cutoff)))
      .all()
      .map((r) => r.id)
      .filter((id) => !this.db.select().from(memberships).where(eq(memberships.userId, id)).get());
    const removedUsers = stale.length
      ? this.db.delete(users).where(inArray(users.id, stale)).run().changes
      : 0;
    const tokens = this.db
      .delete(userTokens)
      .where(
        or(
          lt(userTokens.expiresAt, dayAgo),
          and(sql`${userTokens.usedAt} IS NOT NULL`, lt(userTokens.usedAt, dayAgo)),
        ),
      )
      .run().changes;
    const sess = this.db
      .delete(sessions)
      .where(or(lt(sessions.expiresAt, now.toISOString()), lt(sessions.lastSeenAt, idle)))
      .run().changes;
    // Federated sign-in state (federation/flows.ts): single use, minutes long.
    this.db.delete(oidcFlows).where(lt(oidcFlows.expiresAt, dayAgo)).run();
    return { users: removedUsers, tokens, sessions: sess };
  }

  /** Not in spec 8.3. Resolves when every background email started so far has been handed to the mailer. */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  // ============================================================================================ internals
  private link(path: string, token: string): string {
    // In the fragment: never sent to the server, so it cannot reach access logs or a Referer header.
    return `${this.publicUrl}${path}#token=${encodeURIComponent(token)}`;
  }

  private emailKey(normalized: string): string {
    return this.d.keys.hmac("ratelimit", normalized).slice(0, 32);
  }

  private limit(key: string, [limit, windowMs]: Limit): void {
    const r = this.d.limiter.hit(key, limit, windowMs);
    if (!r.allowed)
      throw new CloudError(429, "RATE_LIMITED", "too many attempts; try again later", {
        retryAfterSeconds: Math.max(1, Math.ceil(r.retryAfterMs / 1000)),
      });
  }

  /**
   * One password attempt for an address (sign-in, or a verification link opened in another browser).
   * Attempts are counted before the slow hash (a parallel burst cannot slip past) and escalate to a
   * CAPTCHA, never to a lock-out, so nobody can lock a victim out by guessing.
   */
  private async throttleSignIn(
    address: string,
    captchaToken: string | undefined,
    m: RequestMeta,
  ): Promise<void> {
    const ek = this.emailKey(address);
    const throttled = [
      this.d.limiter.hit(`signin:ai:${ek}:${m.ip}`, ...ACCOUNT_LIMITS.signinAddressIp),
      this.d.limiter.hit(`signin:i:${m.ip}`, ...ACCOUNT_LIMITS.signinIp),
      this.d.limiter.hit(`signin:a:${ek}`, ...ACCOUNT_LIMITS.signinAddress),
    ].some((h) => !h.allowed);
    if (throttled) await this.requireCaptcha(captchaToken, m.ip);
  }

  private async requireCaptcha(token: string | undefined, ip: string): Promise<void> {
    if (!(await this.d.captcha.verify(token, ip)))
      throw new CloudError(403, "CAPTCHA_REQUIRED", "complete the CAPTCHA to continue");
  }

  private requireEmail(email: unknown): string {
    const norm = typeof email === "string" ? normalizeEmail(email) : null;
    if (!norm) throw validation("a valid email address is required");
    return norm;
  }

  private userByEmail(norm: string): UserRow | undefined {
    return this.db.select().from(users).where(eq(users.emailNormalized, norm)).get();
  }

  private userById(id: string): UserRow | undefined {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }

  private requireUser(id: string): UserRow {
    const u = this.userById(id);
    if (!u || u.disabledAt) throw new CloudError(401, "UNAUTHORIZED", "sign in again");
    return u;
  }

  private isMember(accountId: string, userId: string): boolean {
    return !!this.db
      .select({ a: memberships.accountId })
      .from(memberships)
      .innerJoin(accounts, eq(accounts.id, memberships.accountId))
      .where(
        and(
          eq(memberships.accountId, accountId),
          eq(memberships.userId, userId),
          inArray(accounts.status, ["active", "suspended", "migration_failed"]),
        ),
      )
      .get();
  }

  /** The workspace a fresh session opens on: the one the user owns, else the oldest membership. */
  private defaultAccount(userId: string): AccountId | null {
    const rows = this.db
      .select({ accountId: memberships.accountId, role: memberships.role })
      .from(memberships)
      .innerJoin(accounts, eq(accounts.id, memberships.accountId))
      .where(and(eq(memberships.userId, userId), inArray(accounts.status, ["active", "suspended"])))
      .orderBy(asc(memberships.createdAt))
      .all();
    return (rows.find((r) => r.role === "owner") ?? rows[0])?.accountId ?? null;
  }

  private challenge(userId: string, method: SignInMethod): SignInResult {
    const now = this.clock();
    const t = this.db.transaction((tx) => {
      dropUnused(tx, userId, "signin_challenge");
      return issueToken(tx, {
        userId,
        purpose: "signin_challenge",
        ttlMs: ACCOUNT_TTL.signinChallenge,
        now,
        payload: { attempts: 0, method },
      });
    });
    return { kind: "totp-required", challenge: t.token, expiresAt: t.expiresAt };
  }

  private issueSession(
    userId: string,
    m: RequestMeta,
    o: { mfa: boolean; reauth: boolean; activeAccountId: AccountId | null; expiresAt?: Date },
  ): IssuedSession {
    const now = this.clock();
    const token = randomToken();
    const csrf = randomBytes(24).toString("base64url");
    const expiresAt = o.expiresAt ?? new Date(now.getTime() + ACCOUNT_TTL.sessionAbsolute);
    this.db
      .insert(sessions)
      .values({
        id: sha256Hex(token),
        userId,
        csrf,
        activeAccountId: o.activeAccountId,
        mfa: o.mfa,
        reauthAt: o.reauth ? now.toISOString() : null,
        userAgent: typeof m.userAgent === "string" ? m.userAgent.slice(0, 256) : null,
        ip: typeof m.ip === "string" ? m.ip.slice(0, 64) : null,
        createdAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      })
      .run();
    return {
      token,
      csrf,
      expiresAt,
      maxAgeSeconds: Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)),
      newDeviceToken: null,
    };
  }

  private finishSignIn(
    user: UserRow,
    m: RequestMeta,
    o: { mfa: boolean; reauth: boolean; method: SignInMethod },
  ): IssuedSession {
    const now = this.clock();
    const session = this.issueSession(user.id, m, {
      mfa: o.mfa,
      reauth: o.reauth,
      activeAccountId: this.defaultAccount(user.id),
    });
    this.db
      .update(users)
      .set({ lastSigninAt: now.toISOString() })
      .where(eq(users.id, user.id))
      .run();
    const device = this.recognizeDevice(user.id, m.deviceToken);
    session.newDeviceToken = device.newToken;
    if (!device.known) {
      this.d.audit.record({
        actorType: "user",
        actorId: user.id,
        subjectUserId: user.id,
        event: "user.signin_new_device",
        ip: m.ip,
        userAgent: m.userAgent,
      });
      if (user.signinAlerts)
        this.sendMail(
          { email: user.email, name: user.name },
          user.emailNormalized,
          "signin-alert",
          user.id,
          {
            name: user.name,
            at: now.toISOString(),
            device: describeDevice(m.userAgent),
            ip: m.ip,
            sessionsUrl: `${this.publicUrl}/settings/security`,
          },
          "security",
        );
    }
    this.d.audit.record({
      actorType: "user",
      actorId: user.id,
      subjectUserId: user.id,
      event: "user.signin",
      ip: m.ip,
      userAgent: m.userAgent,
      detail: { mfa: o.mfa, newDevice: !device.known, method: o.method },
    });
    this.log.info("auth.signin", {
      userId: user.id,
      outcome: o.mfa ? "mfa" : o.method,
      method: o.method,
    });
    return session;
  }

  /**
   * Device recognition for sign-in alerts. The cookie value is a random token; only its HMAC is stored per user.
   * A browser without a well-formed cookie gets a new one (`newToken`).
   */
  private recognizeDevice(
    userId: string,
    deviceToken: string | null,
  ): { known: boolean; newToken: string | null } {
    const now = this.clock().toISOString();
    const valid = typeof deviceToken === "string" && TOKEN_RE.test(deviceToken);
    const token = valid ? (deviceToken as string) : randomToken();
    const h = this.d.keys.hmac("device", token);
    const known = valid
      ? this.db
          .update(knownDevices)
          .set({ lastSeenAt: now })
          .where(and(eq(knownDevices.userId, userId), eq(knownDevices.deviceHmac, h)))
          .run().changes === 1
      : false;
    if (!known)
      this.db
        .insert(knownDevices)
        .values({ userId, deviceHmac: h, firstSeenAt: now, lastSeenAt: now })
        .onConflictDoNothing()
        .run();
    return { known, newToken: valid ? null : token };
  }

  private openTotp(sealed: string): string {
    return Buffer.from(this.d.keys.open("totp", sealed)).toString("utf8");
  }

  /** Verify a TOTP code and advance `totp_last_step` atomically; false for a wrong or replayed code. */
  private consumeTotp(user: UserRow, code: string, now: Date): boolean {
    if (!user.totpSecretEnc || !user.totpEnabledAt) return false;
    const fresh = this.userById(user.id);
    const step = verifyTotp(
      this.openTotp(user.totpSecretEnc),
      code,
      now.getTime(),
      fresh?.totpLastStep ?? null,
    );
    if (step === null) return false;
    return (
      this.db
        .update(users)
        .set({ totpLastStep: step })
        .where(
          and(eq(users.id, user.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))),
        )
        .run().changes === 1
    );
  }

  private consumeRecoveryCode(userId: string, input: string, now: Date): boolean {
    const code = normalizeRecoveryCode(input);
    if (!code) return false;
    const h = this.d.keys.hmac("recovery-code", `${userId}:${code}`);
    return (
      this.db
        .update(recoveryCodes)
        .set({ usedAt: now.toISOString() })
        .where(
          and(
            eq(recoveryCodes.userId, userId),
            eq(recoveryCodes.codeHmac, h),
            isNull(recoveryCodes.usedAt),
          ),
        )
        .run().changes === 1
    );
  }

  private remainingRecoveryCodes(userId: string): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(recoveryCodes)
        .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
        .get()?.n ?? 0
    );
  }

  private replaceRecoveryCodes(
    tx: Pick<ControlDb, "insert" | "delete">,
    userId: string,
    codes: string[],
    now: Date,
  ): void {
    tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
    for (const c of codes)
      tx.insert(recoveryCodes)
        .values({
          id: newId("rc"),
          userId,
          codeHmac: this.d.keys.hmac("recovery-code", `${userId}:${c}`),
          createdAt: now.toISOString(),
        })
        .run();
  }

  /** `user.signin_failed`, sampled: the first 5 per address per hour. */
  private auditSigninFailed(
    userId: string,
    m: RequestMeta,
    method: "password" | "totp" | "recovery",
  ): void {
    if (!this.d.limiter.hit(`audit:sf:${userId}`, ...ACCOUNT_LIMITS.signinFailedAudit).allowed)
      return;
    this.d.audit.record({
      actorType: "user",
      actorId: null,
      subjectUserId: userId,
      event: "user.signin_failed",
      ip: m.ip,
      userAgent: m.userAgent,
      detail: { method },
    });
  }

  private securityMail(user: UserRow, change: TemplateData["security-change"]["change"]): void {
    this.sendMail(
      { email: user.email, name: user.name },
      user.emailNormalized,
      "security-change",
      user.id,
      {
        name: user.name,
        change,
        at: this.clock().toISOString(),
        securityUrl: `${this.publicUrl}/settings/security`,
      },
      "security",
    );
  }

  /**
   * Send in the background (response time must not depend on the provider, or on whether a mail is sent at
   * all), within the per-address budget of 5 account emails an hour (mail-bombing guard, spec 3.7). Security
   * notices, and mail only the signed-in person can ask for (the first-password link, the deletion notice),
   * count against their own, larger budget (`securityMailPerAddress`), which anonymous requests cannot spend.
   */
  private sendMail<T extends TemplateId>(
    to: Address,
    normalized: string,
    id: T,
    userId: string | null,
    data: TemplateData[T],
    budget: "account" | "security" = "account",
  ): void {
    const security = budget === "security";
    const [max, windowMs]: Limit = security
      ? ACCOUNT_LIMITS.securityMailPerAddress
      : ACCOUNT_LIMITS.mailPerAddress;
    const key = `${security ? "mail-security" : "mail"}:${this.emailKey(normalized)}`;
    if (!this.d.limiter.hit(key, max, windowMs).allowed) {
      this.log.warn("accounts.mail_throttled", { template: id, userId });
      return;
    }
    const p: Promise<void> = Promise.resolve()
      .then(() => this.d.mailer.send(to, id, data, userId ? { userId } : {}))
      .then((outcome) => {
        if (outcome.status === "failed")
          this.log.warn("accounts.mail_failed", { template: id, userId, errCode: outcome.code });
      })
      .catch((err: unknown) => this.log.error("accounts.mail_error", { template: id, userId, err }))
      .finally(() => {
        this.pending.delete(p);
      });
    this.pending.add(p);
  }
}

/** The id shown in the sessions list: a prefix of the stored hash (itself a hash of the cookie). */
export const publicSessionId = (storedId: string): string => storedId.slice(0, 16);
