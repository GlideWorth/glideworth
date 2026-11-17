/**
 * Household collaboration: several logins on one instance.
 *
 *   owner   created at first-run setup; exactly one; cannot be demoted, disabled or deleted.
 *   invite  the owner invites a partner (editor) or an adviser (viewer). The response carries a one-time
 *           token; the invitee opens it, picks their own passphrase and is signed in. The owner never
 *           learns it. Tokens expire after 7 days and work once.
 *   reset   the owner can issue a reset token for any other user (they forgot, or lost a device): it signs
 *           them out everywhere and lets them choose a new passphrase. The owner's own passphrase is changed
 *           with change-passphrase, or from the command line (`admin reset-owner-passphrase`).
 */
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { apiKeys, oauthCodes, oauthTokens, users, userTokens } from "../db/schema.js";
import { ApiError, conflict, notFound } from "../errors.js";
import { newId, nowIso, sha256 } from "../util.js";
import type { AuthService } from "./auth.js";
import type { ServiceCtx } from "./context.js";

export type UserRole = "owner" | "editor" | "viewer";
export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export interface UserInfo {
  id: string;
  login: string;
  name: string;
  role: UserRole;
  /** `invited` = no passphrase yet; `disabled` = cannot sign in. */
  status: "active" | "invited" | "disabled";
  createdAt: string;
  lastLoginAt: string | null;
  disabledAt: string | null;
}

export interface IssuedToken {
  /** The secret to hand to the user, shown once. */
  token: string;
  kind: "invite" | "reset";
  expiresAt: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

export class UsersService {
  constructor(
    private readonly ctx: ServiceCtx,
    private readonly auth: AuthService,
  ) {}
  private get db() {
    return this.ctx.db;
  }

  private info(r: typeof users.$inferSelect): UserInfo {
    const configured = r.id === "owner" ? this.auth.isConfigured() : !!r.hash;
    return {
      id: r.id,
      login: r.login,
      name: r.name,
      role: r.role,
      status: r.disabledAt ? "disabled" : configured ? "active" : "invited",
      createdAt: r.createdAt,
      lastLoginAt: r.lastLoginAt,
      disabledAt: r.disabledAt,
    };
  }

  list(): UserInfo[] {
    return this.db
      .select()
      .from(users)
      .all()
      .sort((a, b) =>
        a.id === "owner" ? -1 : b.id === "owner" ? 1 : a.createdAt < b.createdAt ? -1 : 1,
      )
      .map((r) => this.info(r));
  }

  get(id: string): UserInfo {
    const r = this.db.select().from(users).where(eq(users.id, id)).get();
    if (!r) throw notFound("user", id);
    return this.info(r);
  }

  private issueToken(userId: string, kind: "invite" | "reset"): IssuedToken {
    // One live token per user and kind.
    this.db
      .delete(userTokens)
      .where(
        and(eq(userTokens.userId, userId), eq(userTokens.kind, kind), isNull(userTokens.usedAt)),
      )
      .run();
    const token = `glideworth-${kind}-${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    this.db
      .insert(userTokens)
      .values({ id: newId("tok"), userId, kind, tokenHash: sha256(token), expiresAt })
      .run();
    return { token, kind, expiresAt };
  }

  /** Invite a partner or adviser. Returns the user (status `invited`) and the one-time invite token. */
  invite(
    input: { name: string; role: Exclude<UserRole, "owner">; login?: string | undefined },
    createdBy: string,
  ): { user: UserInfo; invite: IssuedToken } {
    if (!this.auth.isConfigured())
      throw new ApiError(409, "SETUP_REQUIRED", "finish first-run setup before inviting people");
    const login = slug(input.login ?? input.name);
    if (!login) throw new ApiError(400, "VALIDATION", "the sign-in name needs letters or digits");
    if (login === "owner" || this.db.select().from(users).where(eq(users.login, login)).get())
      throw conflict(
        `the sign-in name '${login}' is taken; choose another`,
        { login },
        "LOGIN_TAKEN",
      );
    const id = newId("usr");
    this.db
      .insert(users)
      .values({ id, login, name: input.name, role: input.role, createdBy })
      .run();
    return { user: this.get(id), invite: this.issueToken(id, "invite") };
  }

  /** A fresh invite for a user who has not accepted yet (the first one was lost or expired). */
  reinvite(id: string): { user: UserInfo; invite: IssuedToken } {
    const u = this.get(id);
    if (u.status !== "invited")
      throw conflict("this user has already accepted; issue a passphrase reset instead");
    return { user: u, invite: this.issueToken(id, "invite") };
  }

  /** Owner-issued passphrase reset: signs the user out everywhere and returns a one-time token. */
  reset(id: string): { user: UserInfo; reset: IssuedToken } {
    const u = this.get(id);
    if (u.status === "invited")
      throw conflict("this user has not accepted their invite yet; re-issue the invite");
    this.auth.logoutUser(id);
    return { user: u, reset: this.issueToken(id, "reset") };
  }

  /**
   * Accept an invite or a reset: the holder of the token chooses a passphrase. Returns the user id so the
   * route can open a session. A used, expired or unknown token is a 400 (one message: no oracle).
   */
  async accept(token: string, passphrase: string): Promise<UserInfo> {
    const bad = () =>
      new ApiError(400, "INVALID_TOKEN", "this invite or reset link is invalid, used or expired");
    const row = this.db
      .select()
      .from(userTokens)
      .where(
        and(
          eq(userTokens.tokenHash, sha256(token)),
          isNull(userTokens.usedAt),
          gt(userTokens.expiresAt, nowIso()),
        ),
      )
      .get();
    if (!row) throw bad();
    this.auth.checkStrength(passphrase);
    // Claim the token first so two simultaneous accepts cannot both win.
    const claimed = this.db
      .update(userTokens)
      .set({ usedAt: nowIso() })
      .where(and(eq(userTokens.id, row.id), isNull(userTokens.usedAt)))
      .run();
    if (claimed.changes !== 1) throw bad();
    const user = this.db.select().from(users).where(eq(users.id, row.userId)).get();
    if (!user || user.disabledAt) throw bad();
    await this.auth.setPassphrase(user.id, passphrase);
    return this.get(user.id);
  }

  /** Owner-only edits. The owner's own record cannot change role or be disabled. */
  update(
    id: string,
    patch: {
      name?: string | undefined;
      role?: "editor" | "viewer" | undefined;
      disabled?: boolean | undefined;
    },
  ): UserInfo {
    const cur = this.get(id);
    if (cur.id === "owner" && (patch.role !== undefined || patch.disabled))
      throw conflict("the owner cannot be demoted or disabled", undefined, "OWNER_PROTECTED");
    const set: Partial<typeof users.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.role !== undefined) set.role = patch.role;
    if (patch.disabled !== undefined) set.disabledAt = patch.disabled ? nowIso() : null;
    if (Object.keys(set).length) this.db.update(users).set(set).where(eq(users.id, id)).run();
    // A role change or a disable takes effect on every credential at once.
    if (patch.disabled || (patch.role !== undefined && patch.role !== cur.role))
      this.auth.logoutUser(id);
    if (patch.disabled)
      this.db
        .update(oauthTokens)
        .set({ revokedAt: nowIso() })
        .where(and(eq(oauthTokens.userId, id), isNull(oauthTokens.revokedAt)))
        .run();
    return this.get(id);
  }

  /** Remove a user: sessions, API keys and OAuth tokens go with them; history keeps their name. */
  delete(id: string): void {
    const cur = this.get(id);
    if (cur.id === "owner")
      throw conflict("the owner cannot be removed", undefined, "OWNER_PROTECTED");
    this.auth.logoutUser(id);
    this.db.delete(apiKeys).where(eq(apiKeys.userId, id)).run();
    this.db.delete(oauthTokens).where(eq(oauthTokens.userId, id)).run();
    this.db.delete(oauthCodes).where(eq(oauthCodes.userId, id)).run();
    this.db.delete(users).where(eq(users.id, id)).run();
  }

  // ----------------------------------------------------------------------------- cloud member mirror
  /**
   * Cloud (spec 3.6): the control plane's membership is the source of truth and this table mirrors it. Insert
   * a member (no passphrase: cloud people sign in through the control plane), or update an existing row's
   * name and role while keeping its login. A role change signs the person out, as `update` does.
   */
  upsertMember(m: { tenantUserId: string; login: string; name: string; role: UserRole }): void {
    const cur = this.db.select().from(users).where(eq(users.id, m.tenantUserId)).get();
    const role: UserRole =
      m.tenantUserId === "owner" ? "owner" : m.role === "owner" ? "editor" : m.role;
    const name = m.name.slice(0, 120) || "Member";
    if (cur) {
      this.db
        .update(users)
        .set({ name, role, disabledAt: null })
        .where(eq(users.id, m.tenantUserId))
        .run();
      if (cur.role !== role) this.auth.logoutUser(m.tenantUserId);
      return;
    }
    const base = slug(m.login) || "member";
    let login = base;
    for (let i = 2; this.db.select().from(users).where(eq(users.login, login)).get(); i++)
      login = `${base}-${i}`;
    this.db
      .insert(users)
      .values({ id: m.tenantUserId, login, name, role, hash: null, createdBy: "control-plane" })
      .run();
  }

  /** Cloud: every mirrored member, role and name (the registry corrects both on open). */
  listMembers(): Array<{ tenantUserId: string; role: UserRole; name: string }> {
    return this.db
      .select({ tenantUserId: users.id, role: users.role, name: users.name })
      .from(users)
      .all();
  }

  /**
   * Cloud: API keys, OAuth tokens and authorization codes of a person (ownership transfer swaps who `owner`
   * is). The codes go too: a code issued before the swap would otherwise mint a token for whoever holds the
   * tenant user id afterwards (security review finding 16).
   */
  revokeCredentials(id: string): void {
    this.auth.logoutUser(id);
    const keys = this.db.select().from(apiKeys).all();
    for (const k of keys)
      if ((k.userId ?? "owner") === id) this.db.delete(apiKeys).where(eq(apiKeys.id, k.id)).run();
    this.db.delete(oauthTokens).where(eq(oauthTokens.userId, id)).run();
    this.db.delete(oauthCodes).where(eq(oauthCodes.userId, id)).run();
  }

  /** Cloud: a member removed from the workspace (the owner row is never removed). */
  removeMember(id: string): void {
    if (id === "owner") return;
    if (!this.db.select().from(users).where(eq(users.id, id)).get()) return;
    this.delete(id);
  }

  /** Operator recovery (CLI): a reset token for the owner. */
  resetOwner(): IssuedToken {
    if (!this.auth.isConfigured())
      throw new ApiError(409, "SETUP_REQUIRED", "no owner passphrase is set yet");
    this.auth.logoutUser("owner");
    return this.issueToken("owner", "reset");
  }
}
