/**
 * Server-side OpenID Connect state (`oidc_flows`).
 *
 * An authorization request gets a row keyed by SHA-256 of its `state`, holding (sealed) the PKCE verifier,
 * the nonce, the intent and the validated `next`. The row is bound to the browser that started it: the
 * browser holds a random `__Host-gw_oidc` cookie (HttpOnly, Secure, SameSite=Lax so it survives the
 * top-level redirect back from Google, 10 minutes) and the row stores SHA-256 of it. On the callback the row
 * is claimed in one statement (`used_at IS NULL AND expires_at > now`): a missing, unknown, reused or expired
 * state, or a browser whose cookie does not match, is refused before the code is ever exchanged.
 *
 * That binding is what stops login CSRF: an attacker can obtain a valid `code` + `state` for their own Google
 * account, but the `state` belongs to the attacker's browser cookie. Delivered to a victim's browser, the
 * victim's cookie (or its absence) does not match, so the victim is never signed in to the attacker's account
 * (and, for linking, the attacker's Google account is never linked to the victim's Glideworth account).
 *
 * A new Google user's confirmed claims wait in a `pending_signup` row (sealed; 15 minutes) keyed by SHA-256
 * of a second random cookie, `__Host-gw_oidc_signup` (SameSite=Strict), until they accept the terms.
 *
 * Linking from settings ends the same way: the callback is a navigation started on Google's page, so the
 * browser does not send the `SameSite=Strict` session cookie with it and the callback cannot tell who is
 * signed in. The verified claims wait in a `pending_link` row (sealed; 10 minutes, with the user and session
 * that started the link) keyed by SHA-256 of a third random cookie, `__Host-gw_oidc_link`. The web app's
 * `/google-link` page then finishes the link with an ordinary same-origin POST, which carries the session and
 * the CSRF token (`FederationService.finishLink`).
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import type { ControlDb } from "../control/db.js";
import { oidcFlows } from "../control/schema.js";
import type { Keyring } from "../crypto/keyring.js";
import { randomToken, safeEqual, sha256Hex, TOKEN_RE } from "../crypto/random.js";
import type { Provider } from "./identities.js";

const MINUTE = 60 * 1000;
const FLOW_TTL = { authorize: 10 * MINUTE, pending: 15 * MINUTE, link: 10 * MINUTE } as const;
const SEAL_PURPOSE = "oidc-flow";

export type Intent = "signin" | "link";

export interface AuthorizeState {
  verifier: string;
  nonce: string;
  intent: Intent;
  next: string;
  /** Sign-in from an invitation page: the invitation's token, so the person ends on it (`/invite`). */
  invitation?: string;
}

export interface PendingSignup {
  subject: string;
  email: string;
  name: string | null;
  next: string;
  invitation?: string;
}

/** A Google account's verified claims, waiting for the session that started the link to claim them. */
export interface PendingLink {
  subject: string;
  email: string;
}

export type ClaimFailure = "missing" | "unknown" | "browser" | "used" | "expired";

export class FlowStore {
  constructor(
    private readonly db: ControlDb,
    private readonly keys: Keyring,
    private readonly clock: () => Date,
  ) {}

  /** A fresh browser binding value (the `__Host-gw_oidc` cookie), or the browser's current one if well formed. */
  static browserToken(current: string | null | undefined): { token: string; fresh: boolean } {
    if (typeof current === "string" && TOKEN_RE.test(current))
      return { token: current, fresh: false };
    return { token: randomToken(), fresh: true };
  }

  createAuthorize(o: {
    provider: Provider;
    browser: string;
    intent: Intent;
    next: string;
    userId?: string | null;
    sessionId?: string | null;
    invitation?: string | null;
  }): { state: string; nonce: string; verifier: string } {
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken(); // 43 base64url characters: the RFC 7636 minimum, 256 bits.
    const now = this.clock();
    const payload: AuthorizeState = {
      verifier,
      nonce,
      intent: o.intent,
      next: o.next,
      ...(o.invitation ? { invitation: o.invitation } : {}),
    };
    this.db
      .insert(oidcFlows)
      .values({
        id: sha256Hex(state),
        kind: "authorize",
        provider: o.provider,
        browserHash: sha256Hex(o.browser),
        userId: o.userId ?? null,
        sessionId: o.sessionId ?? null,
        payloadEnc: this.seal(payload),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + FLOW_TTL.authorize).toISOString(),
      })
      .run();
    return { state, nonce, verifier };
  }

  /**
   * Claim the flow named by `state` for this browser. Any lookup that finds the row uses it up, whatever
   * the outcome, so a state is good for exactly one callback.
   */
  claimAuthorize(
    state: unknown,
    browser: string | null | undefined,
  ):
    | { ok: true; flow: AuthorizeState; userId: string | null; sessionId: string | null }
    | { ok: false; reason: ClaimFailure } {
    if (typeof state !== "string" || !TOKEN_RE.test(state)) return { ok: false, reason: "missing" };
    const id = sha256Hex(state);
    const now = this.clock().toISOString();
    return this.db.transaction((tx) => {
      const row = tx.select().from(oidcFlows).where(eq(oidcFlows.id, id)).get();
      if (!row || row.kind !== "authorize" || !safeEqual(row.id, id))
        return { ok: false as const, reason: "unknown" as const };
      if (row.usedAt) return { ok: false as const, reason: "used" as const };
      const claimed = tx
        .update(oidcFlows)
        .set({ usedAt: now })
        .where(and(eq(oidcFlows.id, id), isNull(oidcFlows.usedAt)))
        .run();
      if (claimed.changes !== 1) return { ok: false as const, reason: "used" as const };
      if (row.expiresAt <= now) return { ok: false as const, reason: "expired" as const };
      const given = typeof browser === "string" && TOKEN_RE.test(browser) ? sha256Hex(browser) : "";
      if (!given || !safeEqual(given, row.browserHash))
        return { ok: false as const, reason: "browser" as const };
      return {
        ok: true as const,
        flow: this.open<AuthorizeState>(row.payloadEnc),
        userId: row.userId,
        sessionId: row.sessionId,
      };
    });
  }

  /** Park a new user's verified claims until they confirm the sign-up step. Returns the cookie value. */
  createPending(provider: Provider, p: PendingSignup): string {
    const token = randomToken();
    const now = this.clock();
    this.db
      .insert(oidcFlows)
      .values({
        id: sha256Hex(token),
        kind: "pending_signup",
        provider,
        browserHash: sha256Hex(token),
        payloadEnc: this.seal(p),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + FLOW_TTL.pending).toISOString(),
      })
      .run();
    return token;
  }

  peekPending(token: unknown): PendingSignup | null {
    const row = this.pendingRow(token, "pending_signup");
    return row ? this.open<PendingSignup>(row.payloadEnc) : null;
  }

  /** Use up the pending sign-up (single use). */
  claimPending(token: unknown): PendingSignup | null {
    const row = this.pendingRow(token, "pending_signup");
    if (!row || !this.use(row.id)) return null;
    return this.open<PendingSignup>(row.payloadEnc);
  }

  /** Park a Google account's verified claims for the link the user and session started. Returns the cookie. */
  createPendingLink(
    provider: Provider,
    o: { userId: string; sessionId: string },
    p: PendingLink,
  ): string {
    const token = randomToken();
    const now = this.clock();
    this.db
      .insert(oidcFlows)
      .values({
        id: sha256Hex(token),
        kind: "pending_link",
        provider,
        browserHash: sha256Hex(token),
        userId: o.userId,
        sessionId: o.sessionId,
        payloadEnc: this.seal(p),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + FLOW_TTL.link).toISOString(),
      })
      .run();
    return token;
  }

  /** Use up a parked link (single use, whatever the caller then decides). */
  claimPendingLink(
    token: unknown,
  ): { link: PendingLink; userId: string | null; sessionId: string | null } | null {
    const row = this.pendingRow(token, "pending_link");
    if (!row || !this.use(row.id)) return null;
    return {
      link: this.open<PendingLink>(row.payloadEnc),
      userId: row.userId,
      sessionId: row.sessionId,
    };
  }

  private use(id: string): boolean {
    const res = this.db
      .update(oidcFlows)
      .set({ usedAt: this.clock().toISOString() })
      .where(and(eq(oidcFlows.id, id), isNull(oidcFlows.usedAt)))
      .run();
    return res.changes === 1;
  }

  private pendingRow(token: unknown, kind: "pending_signup" | "pending_link") {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
    const id = sha256Hex(token);
    const row = this.db
      .select()
      .from(oidcFlows)
      .where(
        and(
          eq(oidcFlows.id, id),
          eq(oidcFlows.kind, kind),
          isNull(oidcFlows.usedAt),
          gt(oidcFlows.expiresAt, this.clock().toISOString()),
        ),
      )
      .get();
    return row && safeEqual(row.id, id) ? row : null;
  }

  private seal(v: unknown): string {
    return this.keys.seal(SEAL_PURPOSE, Buffer.from(JSON.stringify(v), "utf8"));
  }

  private open<T>(sealed: string): T {
    return JSON.parse(Buffer.from(this.keys.open(SEAL_PURPOSE, sealed)).toString("utf8")) as T;
  }
}
