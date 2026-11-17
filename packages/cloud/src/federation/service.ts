/**
 * "Sign in with Google" for cloud mode: Glideworth as an OpenID Connect client (relying party) of Google.
 * Not to be confused with apps/api's OAuth server for MCP clients, where Glideworth is the provider.
 *
 * Identity mapping (each rule has a test in test/federation-*.test.ts):
 * 1. Google's `sub` already linked: sign in as that user (TOTP still asked when enabled).
 * 2. Unknown `sub`, no account with that address: the claims are parked server side and the person confirms a
 *    sign-up step (name, 18 or over, terms) before any account exists; then `createFromIdentity` applies the
 *    password sign-up's rules and the first-workspace and trial path.
 * 3. Unknown `sub`, a VERIFIED account has that address: nothing happens: no sign-in, no link. The person is
 *    told an account exists and that they can sign in with their password and link Google in settings
 *    (proof of control of the existing account first). Google's word about an address never opens an
 *    existing account, which defends against a Google account asserting an address it no longer controls.
 * 4. Unknown `sub`, an UNVERIFIED registration has that address: treated as 2; the unverified row is
 *    discarded when the Google user confirms ("newest sign-up wins", accounts/service.ts), never merged.
 * 5. A Google account whose address later changes still maps by `sub`; the Glideworth address is not touched.
 * 6. Linking (from security settings): a signed-in, recently re-authenticated session starts the flow, and
 *    only that session in that browser can finish it. A `sub` linked to someone else is refused. The callback
 *    cannot finish it: it is a navigation from Google's page, so the browser leaves out the `SameSite=Strict`
 *    session cookie (security review finding 13). It parks the verified claims (flows.ts `pending_link`) and
 *    sends the browser to the web app's `/google-link` page, whose same-origin POST (session and CSRF token)
 *    calls `finishLink`.
 * 7. Unlinking: only when a password exists (the account would otherwise have no way in), re-auth required.
 * 8. Invitations: a sign-in or sign-up started from an invitation page carries the invitation's token through
 *    the flow (sealed, server side) and ends on that invitation (`/invite#token=…`) while it can still be
 *    accepted, as the email sign-up does (accounts/service.ts `signUp`).
 *
 * Abuse and privacy: per-address flood limits on every route plus a per-address callback limit; audit
 * `user.signin` (method google), `identity.linked`, `identity.unlinked`; nothing from Google (email, name,
 * picture, tokens) is logged; the ID token is used once and dropped; access tokens are never read.
 */
import type { AccountsService } from "../accounts/service.js";
import { hasPassword } from "../accounts/service.js";
import { emailDomain, normalizeEmail } from "../accounts/email.js";
import { isDisposableEmail } from "../abuse/disposable.js";
import type { RateLimiter } from "../abuse/rate-limiter.js";
import type { ControlAudit } from "../audit.js";
import type { ControlDb } from "../control/db.js";
import { users, userIdentities } from "../control/schema.js";
import type { Keyring } from "../crypto/keyring.js";
import { CloudError } from "../errors.js";
import { type Logger, silentLogger } from "../log/index.js";
import type { AccountId, IssuedSession, RequestMeta, SessionContext, UserId } from "../types.js";
import { and, eq } from "drizzle-orm";
import { FlowStore, type ClaimFailure } from "./flows.js";
import { identityBySubject, identityOfUser, insertIdentity, touchIdentity } from "./identities.js";
import { type OidcClient, OidcError } from "./oidc.js";

const MINUTE = 60 * 1000;
const FEDERATION_LIMITS = {
  /** Authorization requests started per address. */
  startIp: [30, 15 * MINUTE],
  /** Callbacks per address (each one costs a token exchange). */
  callbackIp: [30, 15 * MINUTE],
} as const;

/** Where the browser goes after the callback: fixed paths of the web app, codes from a closed set. */
export type CallbackOutcome =
  | { kind: "signed-in"; session: IssuedSession; next: string }
  | { kind: "totp"; challenge: string; next: string }
  | { kind: "pending-signup"; pendingToken: string }
  | { kind: "pending-link"; linkToken: string }
  | { kind: "failed"; code: CallbackError; intent: "signin" | "link" };

/** The answer of `finishLink`: "linked", or why not (the web app shows it on the security settings page). */
export type LinkOutcome =
  | "linked"
  | Extract<CallbackError, "expired" | "taken" | "already-linked" | "session">;

type CallbackError =
  /** The person cancelled at Google, or Google reported an error. */
  | "cancelled"
  /** Missing, unknown, reused or expired state, or another browser's state. */
  | "expired"
  /** Exchange or token validation failed. */
  | "failed"
  /** Google says the address is not verified. */
  | "unverified"
  /** An account with this address exists and is not linked to this Google account. */
  | "exists"
  | "disposable"
  /** Linking: this Google account belongs to another Glideworth account. */
  | "taken"
  /** Linking: another Google account is linked already. */
  | "already-linked"
  /** Linking: the session that started the link is not this browser's session any more. */
  | "session"
  | "unavailable"
  | "rate-limited";

export interface FederationDeps {
  db: ControlDb;
  keys: Keyring;
  accounts: AccountsService;
  audit: ControlAudit;
  limiter: RateLimiter;
  oidc: OidcClient;
  /** The workspace name of an invitation that can still be accepted, or null (WorkspacesService). */
  invitation?: (token: unknown) => { workspaceName: string } | null;
  now?: () => Date;
  log?: Logger;
}

export class FederationService {
  readonly provider = "google" as const;
  private readonly flows: FlowStore;
  private readonly clock: () => Date;
  private readonly log: Logger;

  constructor(private readonly d: FederationDeps) {
    this.clock = d.now ?? (() => new Date());
    this.log = d.log ?? silentLogger;
    this.flows = new FlowStore(d.db, d.keys, this.clock);
  }

  // ------------------------------------------------------------------------------------------ start
  /**
   * Sign-in or sign-up from the Google button. `next` must already be `safeNext`-validated. `invitation` is the
   * token of the invitation page the person came from; it is kept only while it can be accepted.
   */
  async startSignIn(
    browserCookie: string | null | undefined,
    next: string,
    m: RequestMeta,
    invitation?: string | null,
  ): Promise<{ url: string; browser: string }> {
    this.limit(`oidc:start:${m.ip}`, FEDERATION_LIMITS.startIp);
    const live = invitation && this.d.invitation?.(invitation) ? invitation : null;
    return this.start(browserCookie, { intent: "signin", next, invitation: live });
  }

  /** Link Google to the signed-in account (security settings). Needs a re-authentication in the last 10 min. */
  async startLink(
    s: SessionContext,
    browserCookie: string | null | undefined,
    m: RequestMeta,
  ): Promise<{ url: string; browser: string }> {
    this.d.accounts.assertRecentAuth(s);
    this.limit(`oidc:start:${m.ip}`, FEDERATION_LIMITS.startIp);
    if (identityOfUser(this.d.db, s.userId, this.provider))
      throw new CloudError(409, "CONFLICT", "a Google account is already linked; unlink it first", {
        reason: "already-linked",
      });
    return this.start(browserCookie, {
      intent: "link",
      next: "/settings/security",
      userId: s.userId,
      sessionId: s.sessionId,
    });
  }

  private async start(
    browserCookie: string | null | undefined,
    o: {
      intent: "signin" | "link";
      next: string;
      userId?: string;
      sessionId?: string;
      invitation?: string | null;
    },
  ): Promise<{ url: string; browser: string }> {
    const browser = FlowStore.browserToken(browserCookie).token;
    const f = this.flows.createAuthorize({ provider: this.provider, browser, ...o });
    let url: string;
    try {
      url = await this.d.oidc.authorizationUrl(f);
    } catch (err) {
      if (err instanceof OidcError) throw unavailable();
      throw err;
    }
    return { url, browser };
  }

  // --------------------------------------------------------------------------------------- callback
  /**
   * The redirect back from Google. Never throws for a protocol failure: the outcome is a fixed code the route
   * turns into a redirect. It does not look at the session: browsers do not send the `SameSite=Strict` session
   * cookie on this navigation, which starts on Google's page, so a link is finished later by `finishLink`.
   */
  async callback(
    q: { code?: string | undefined; state?: string | undefined; error?: string | undefined },
    browserCookie: string | null | undefined,
    m: RequestMeta,
  ): Promise<CallbackOutcome> {
    if (!this.d.limiter.hit(`oidc:cb:${m.ip}`, ...FEDERATION_LIMITS.callbackIp).allowed)
      return { kind: "failed", code: "rate-limited", intent: "signin" };
    // The state is checked (and used up) first, whatever else the request says.
    const claim = this.flows.claimAuthorize(q.state, browserCookie);
    if (!claim.ok) {
      this.note("state", claim.reason);
      return { kind: "failed", code: "expired", intent: "signin" };
    }
    const { flow } = claim;
    const fail = (code: CallbackError): CallbackOutcome => ({
      kind: "failed",
      code,
      intent: flow.intent,
    });
    if (q.error !== undefined || typeof q.code !== "string" || q.code.length === 0)
      return fail("cancelled");
    if (q.code.length > 2048) return fail("failed");

    let claims: { subject: string; email: string; name: string | null };
    try {
      const idToken = await this.d.oidc.exchangeCode(q.code, flow.verifier);
      claims = await this.d.oidc.verifyIdToken(idToken, flow.nonce);
    } catch (err) {
      if (err instanceof OidcError) {
        this.note("token", err.reason);
        return fail(err.reason === "email_unverified" ? "unverified" : "failed");
      }
      throw err;
    }

    if (flow.intent === "link") {
      // Parked for the session that started the link; the web app's same-origin POST finishes it.
      if (!claim.userId || !claim.sessionId) return fail("session");
      const linkToken = this.flows.createPendingLink(
        this.provider,
        { userId: claim.userId, sessionId: claim.sessionId },
        { subject: claims.subject, email: claims.email },
      );
      return { kind: "pending-link", linkToken };
    }

    // Rule 1: a known subject.
    const known = identityBySubject(this.d.db, this.provider, claims.subject);
    if (known) {
      let r: ReturnType<AccountsService["signInWithIdentity"]>;
      try {
        r = this.d.accounts.signInWithIdentity(known.userId, this.provider, m);
      } catch (err) {
        if (err instanceof CloudError) return fail("failed");
        throw err;
      }
      touchIdentity(this.d.db, known.id, this.clock());
      const next = this.nextFor(flow);
      return r.kind === "signed-in"
        ? { kind: "signed-in", session: r.session, next }
        : { kind: "totp", challenge: r.challenge, next };
    }

    const norm = normalizeEmail(claims.email);
    if (!norm) return fail("failed");
    // Rule 3: a verified account with this address. No sign-in, no link: proof of the account comes first.
    const existing = this.d.db.select().from(users).where(eq(users.emailNormalized, norm)).get();
    if (existing && (existing.emailVerifiedAt || existing.disabledAt)) return fail("exists");
    if (isDisposableEmail(emailDomain(norm))) return fail("disposable");
    // Rules 2 and 4: a new person (an unverified registration of the address is replaced on confirmation).
    const pendingToken = this.flows.createPending(this.provider, {
      subject: claims.subject,
      email: claims.email,
      name: claims.name,
      next: flow.next,
      ...(flow.invitation ? { invitation: flow.invitation } : {}),
    });
    return { kind: "pending-signup", pendingToken };
  }

  /** Where a sign-in ends: the invitation it started from while that can still be accepted, else `next`. */
  private nextFor(f: { next: string; invitation?: string | undefined }): string {
    if (f.invitation && this.d.invitation?.(f.invitation))
      return `/invite#token=${encodeURIComponent(f.invitation)}`;
    return f.next;
  }

  // ------------------------------------------------------------------------------------ finish link
  /**
   * Finish a link parked by the callback (`linkToken`, the `__Host-gw_oidc_link` cookie). Called by the web
   * app's same-origin POST, so `s` is this browser's session and the route has checked the CSRF token. Only
   * the session that started the link can finish it. The parked claims are used up whatever the outcome.
   */
  finishLink(s: SessionContext, linkToken: string | null | undefined, m: RequestMeta): LinkOutcome {
    const parked = this.flows.claimPendingLink(linkToken);
    if (!parked) return "expired";
    const { link: claims, userId } = parked;
    // The browser finishing the link must still be signed in as the session that started it.
    if (!userId || s.userId !== userId || s.sessionId !== parked.sessionId) return "session";
    const known = identityBySubject(this.d.db, this.provider, claims.subject);
    if (known) return known.userId === userId ? "linked" : "taken";
    if (identityOfUser(this.d.db, userId, this.provider)) return "already-linked";
    try {
      insertIdentity(this.d.db, {
        userId,
        provider: this.provider,
        subject: claims.subject,
        email: claims.email,
        now: this.clock(),
      });
    } catch (err) {
      if (String((err as { code?: unknown })?.code).startsWith("SQLITE_CONSTRAINT")) return "taken";
      throw err;
    }
    this.d.audit.record({
      actorType: "user",
      actorId: userId,
      subjectUserId: userId,
      event: "identity.linked",
      ip: m.ip,
      userAgent: m.userAgent,
      detail: { method: this.provider },
    });
    this.log.info("auth.identity_linked", { userId, provider: this.provider });
    return "linked";
  }

  // ------------------------------------------------------------------------------------- pending
  /**
   * What the sign-up step shows: the name to prefill (editable), the address (read-only), and the workspace
   * of the invitation the sign-up started from while it can still be accepted (no trial is started then).
   */
  pending(
    token: string | null | undefined,
  ): { name: string; email: string; invitedTo: string | null } | null {
    const p = this.flows.peekPending(token);
    if (!p) return null;
    const invited = p.invitation ? (this.d.invitation?.(p.invitation) ?? null) : null;
    return {
      name: (p.name ?? "").slice(0, 100),
      email: p.email,
      invitedTo: invited?.workspaceName ?? null,
    };
  }

  async completeSignup(
    token: string | null | undefined,
    i: { name: string; termsVersion: string; adultConfirmed: boolean },
    m: RequestMeta,
  ): Promise<{
    userId: UserId;
    session: IssuedSession;
    accountId: AccountId | null;
    next: string;
  }> {
    // Validate the form before using up the pending sign-up, so a mistake can be corrected.
    if (i.adultConfirmed !== true)
      throw new CloudError(400, "VALIDATION", "confirm that you are 18 or over");
    const name = typeof i.name === "string" ? i.name.normalize("NFKC").trim() : "";
    if (name.length < 1 || name.length > 100)
      throw new CloudError(400, "VALIDATION", "name must be 1-100 characters");
    if (typeof i.termsVersion !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(i.termsVersion))
      throw new CloudError(400, "VALIDATION", "termsVersion is required");
    if (!this.flows.peekPending(token))
      throw new CloudError(
        400,
        "INVALID_TOKEN",
        "this sign-up has expired; continue with Google again",
      );
    const p = this.flows.claimPending(token);
    if (!p)
      throw new CloudError(
        400,
        "INVALID_TOKEN",
        "this sign-up has expired; continue with Google again",
      );
    const r = await this.d.accounts.createFromIdentity(
      {
        provider: this.provider,
        subject: p.subject,
        email: p.email,
        name: i.name,
        termsVersion: i.termsVersion,
        adultConfirmed: i.adultConfirmed,
      },
      m,
    );
    return { ...r, next: this.nextFor(p) };
  }

  // -------------------------------------------------------------------------------------- unlink
  unlink(s: SessionContext, m: RequestMeta): void {
    this.d.accounts.assertRecentAuth(s);
    const user = this.d.db.select().from(users).where(eq(users.id, s.userId)).get();
    if (!user || user.disabledAt) throw new CloudError(401, "UNAUTHORIZED", "sign in again");
    const linked = identityOfUser(this.d.db, user.id, this.provider);
    if (!linked) throw new CloudError(404, "NOT_FOUND", "no Google account is linked");
    // Never leave an account with no way to sign in.
    if (!hasPassword(user))
      throw new CloudError(
        409,
        "CONFLICT",
        "set a password before you unlink Google, or you could not sign in",
        { reason: "no-password" },
      );
    this.d.db
      .delete(userIdentities)
      .where(and(eq(userIdentities.id, linked.id), eq(userIdentities.userId, user.id)))
      .run();
    this.d.audit.record({
      actorType: "user",
      actorId: user.id,
      subjectUserId: user.id,
      event: "identity.unlinked",
      ip: m.ip,
      userAgent: m.userAgent,
      detail: { method: this.provider },
    });
  }

  private note(stage: "state" | "token", reason: ClaimFailure | string): void {
    this.log.info("auth.oidc_refused", { provider: this.provider, kind: stage, reason });
  }

  private limit(key: string, [limit, windowMs]: readonly [number, number]): void {
    const r = this.d.limiter.hit(key, limit, windowMs);
    if (!r.allowed)
      throw new CloudError(429, "RATE_LIMITED", "too many attempts; try again later", {
        retryAfterSeconds: Math.max(1, Math.ceil(r.retryAfterMs / 1000)),
      });
  }
}

const unavailable = () =>
  new CloudError(
    503,
    "TENANT_UNAVAILABLE",
    "Google sign-in is unavailable right now; try again shortly",
  );
