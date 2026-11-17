import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accounts,
  invitations,
  memberships,
  sessions,
  supportGrants,
} from "../src/control/schema.js";
import { sha256Hex } from "../src/crypto/random.js";
import { CloudError } from "../src/errors.js";
import {
  assertAuditClean,
  auditRows,
  ctxOf,
  type Env,
  LIMITS,
  makeEnv,
  newEmail,
  remember,
  signUpVerified,
} from "./helpers.js";

const DAY = 24 * 3600 * 1000;

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
  await new Promise((r) => setTimeout(r, 0));
  assertAuditClean(env.db);
  env.close();
});

const inviteToken = (email: string) =>
  remember(
    decodeURIComponent(
      String(env.mailer.last(email, "invitation")?.data.url).split("#token=")[1] ?? "",
    ),
  );

async function ownerAndInvitee(role: "editor" | "viewer" = "editor") {
  const owner = await signUpVerified(env, { name: "Olive Owner" });
  const email = newEmail("invitee");
  const view = await env.workspaces.invite(owner.ctx, email, role);
  await new Promise((r) => setTimeout(r, 0));
  const token = inviteToken(email);
  const invitee = await signUpVerified(env, { email, name: "Ivy Invitee" });
  return { owner, invitee, token, view, email };
}

const reauth = async (v: {
  ctx: Parameters<Env["accounts"]["assertRecentAuth"]>[0];
  password: string;
}) => env.accounts.reauthenticate(v.ctx, { password: v.password }, env.meta());

describe("invitations", () => {
  it("a live invitation's preview names the workspace and role only; any other token learns nothing (QA 13)", async () => {
    const owner = await signUpVerified(env, { name: "Olive Owner" });
    env.workspaces.rename(owner.ctx, "The Example Household");
    const email = newEmail("invitee");
    const view = await env.workspaces.invite(owner.ctx, email, "viewer");
    await new Promise((r) => setTimeout(r, 0));
    const token = inviteToken(email);

    const preview = env.workspaces.previewInvitation(token);
    expect(preview).toEqual({ workspaceName: "The Example Household", role: "viewer" });
    expect(JSON.stringify(preview)).not.toContain(email.toLowerCase());
    expect(JSON.stringify(preview)).not.toContain("Olive");

    // Unknown, malformed and guessed tokens: the same INVALID_TOKEN as accepting.
    // The guessed token differs from the real one in its last character (whatever that character is).
    const guessed = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    for (const bad of [undefined, "", "short", "x".repeat(43), guessed, 42])
      expect(await code(() => env.workspaces.previewInvitation(bad))).toBe("INVALID_TOKEN");
    // Withdrawn: nothing more than an unknown token.
    env.workspaces.revokeInvitation(owner.ctx, view.id);
    expect(await code(() => env.workspaces.previewInvitation(token))).toBe("INVALID_TOKEN");

    // Expired.
    const again = await env.workspaces.invite(owner.ctx, email, "editor");
    await new Promise((r) => setTimeout(r, 0));
    const fresh = inviteToken(email);
    expect(env.workspaces.previewInvitation(fresh).role).toBe("editor");
    env.advance(7 * DAY + 1);
    expect(await code(() => env.workspaces.previewInvitation(fresh))).toBe("INVALID_TOKEN");
    expect(again.id).toBeTruthy();
  });

  it("an accepted invitation, or one whose workspace is not active, has no preview", async () => {
    const { owner, invitee, token } = await ownerAndInvitee("editor");
    expect(env.workspaces.previewInvitation(token).role).toBe("editor");
    await env.workspaces.acceptInvitation(invitee.ctx, token);
    expect(await code(() => env.workspaces.previewInvitation(token))).toBe("INVALID_TOKEN");

    const email = newEmail("second");
    await env.workspaces.invite(owner.ctx, email, "viewer");
    await new Promise((r) => setTimeout(r, 0));
    const second = inviteToken(email);
    env.db
      .update(accounts)
      .set({ status: "suspended" })
      .where(eq(accounts.id, owner.accountId as string))
      .run();
    expect(await code(() => env.workspaces.previewInvitation(second))).toBe("INVALID_TOKEN");
  });

  it("owner invites, invitee accepts with the matching address, membership and tenant mirror are created", async () => {
    const { owner, invitee, token, view, email } = await ownerAndInvitee("editor");
    expect(view).toMatchObject({
      email: email.toLowerCase(),
      role: "editor",
      invitedBy: owner.userId,
    });
    const mail = env.mailer.last(email, "invitation");
    expect(mail?.data).toMatchObject({
      inviterName: "Olive Owner",
      role: "editor",
      expiresInDays: 7,
      workspaceName: "My workspace",
    });
    expect(JSON.stringify(env.db.select().from(invitations).all())).not.toContain(token);
    expect(env.db.select().from(invitations).get()?.tokenHash).toBe(sha256Hex(token));

    const m = await env.workspaces.acceptInvitation(invitee.ctx, token);
    expect(m).toMatchObject({
      accountId: owner.accountId,
      userId: invitee.userId,
      role: "editor",
      userName: "Ivy Invitee",
    });
    expect(m.tenantUserId).toMatch(/^usr_[a-z2-7]{16}$/);
    expect(env.reg.calls).toContainEqual({
      op: "upsert",
      accountId: owner.accountId,
      tenantUserId: m.tenantUserId,
      role: "editor",
    });
    expect(
      env.workspaces
        .members(owner.ctx)
        .map((x) => x.role)
        .sort(),
    ).toEqual(["editor", "owner"]);
    expect(env.workspaces.listForUser(invitee.userId).map((w) => w.accountId)).toEqual([
      owner.accountId,
    ]);
    env.accounts.setActiveAccount(invitee.ctx, owner.accountId as string);
    expect(env.workspaces.members(invitee.ctx)).toHaveLength(2);
    const events = auditRows(env.db).map((r) => r.event);
    expect(events).toEqual(expect.arrayContaining(["member.invited", "member.joined"]));
  });

  it("is bound to the invited address: another user cannot accept it, and the attempt does not consume it", async () => {
    const { token, invitee, owner } = await ownerAndInvitee();
    const stranger = await signUpVerified(env);
    const err = await env.workspaces.acceptInvitation(stranger.ctx, token).catch((e) => e);
    expect(err).toBeInstanceOf(CloudError);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).not.toContain("@");
    expect(env.workspaces.membership(owner.accountId as string, stranger.userId)).toBeNull();
    await env.workspaces.acceptInvitation(invitee.ctx, token);
  });

  it("is single use, expires after 7 days, and can be revoked", async () => {
    const { token, invitee } = await ownerAndInvitee();
    await env.workspaces.acceptInvitation(invitee.ctx, token);
    expect(await code(env.workspaces.acceptInvitation(invitee.ctx, token))).toBe("INVALID_TOKEN");

    const b = await ownerAndInvitee("viewer");
    env.advance(4 * DAY);
    ctxOf(env, b.invitee.session.token); // keep the session alive (7-day idle limit)
    env.advance(3 * DAY + 1);
    expect(
      await code(env.workspaces.acceptInvitation(ctxOf(env, b.invitee.session.token), b.token)),
    ).toBe("INVALID_TOKEN");
  });

  it("revoked invitations and malformed tokens are refused", async () => {
    const owner = await signUpVerified(env);
    const email = newEmail();
    const view = await env.workspaces.invite(owner.ctx, email, "viewer");
    await new Promise((r) => setTimeout(r, 0));
    const token = inviteToken(email);
    expect(env.workspaces.listInvitations(owner.ctx).map((i) => i.id)).toEqual([view.id]);
    env.workspaces.revokeInvitation(owner.ctx, view.id);
    expect(env.workspaces.listInvitations(owner.ctx)).toEqual([]);
    expect(await code(() => env.workspaces.revokeInvitation(owner.ctx, view.id))).toBe("NOT_FOUND");
    const invitee = await signUpVerified(env, { email });
    expect(await code(env.workspaces.acceptInvitation(invitee.ctx, token))).toBe("INVALID_TOKEN");
    for (const bad of ["", "x", "' OR 1=1 --", "A".repeat(43)])
      expect(await code(env.workspaces.acceptInvitation(invitee.ctx, bad))).toBe("INVALID_TOKEN");
  });

  it("a new invitation to the same address replaces the pending one", async () => {
    const owner = await signUpVerified(env);
    const email = newEmail();
    await env.workspaces.invite(owner.ctx, email, "viewer");
    await new Promise((r) => setTimeout(r, 0));
    const first = inviteToken(email);
    await env.workspaces.invite(owner.ctx, email, "editor");
    await new Promise((r) => setTimeout(r, 0));
    const second = inviteToken(email);
    const invitee = await signUpVerified(env, { email });
    expect(await code(env.workspaces.acceptInvitation(invitee.ctx, first))).toBe("INVALID_TOKEN");
    expect((await env.workspaces.acceptInvitation(invitee.ctx, second)).role).toBe("editor");
  });

  it("only the owner invites; members and members-to-be are refused clearly", async () => {
    const { owner, invitee, token } = await ownerAndInvitee("editor");
    await env.workspaces.acceptInvitation(invitee.ctx, token);
    env.accounts.setActiveAccount(invitee.ctx, owner.accountId as string);
    expect(await code(env.workspaces.invite(invitee.ctx, newEmail(), "viewer"))).toBe("FORBIDDEN");
    expect(await code(() => env.workspaces.listInvitations(invitee.ctx))).toBe("FORBIDDEN");
    expect(await code(env.workspaces.invite(owner.ctx, invitee.email, "viewer"))).toBe("CONFLICT");
    expect(await code(env.workspaces.invite(owner.ctx, "not-an-email", "viewer"))).toBe(
      "VALIDATION",
    );
    expect(await code(env.workspaces.invite(owner.ctx, newEmail(), "owner" as never))).toBe(
      "VALIDATION",
    );
  });

  it("seat limits: 2 editors including the owner, 3 viewers; pending invitations hold seats", async () => {
    expect(LIMITS).toMatchObject({ editors: 2, viewers: 3 });
    const owner = await signUpVerified(env);
    await env.workspaces.invite(owner.ctx, newEmail(), "editor");
    const err = await env.workspaces.invite(owner.ctx, newEmail(), "editor").catch((e) => e);
    expect(err.code).toBe("SEAT_LIMIT");
    expect(err.details).toEqual({ role: "editor", limit: 2 });
    for (let i = 0; i < 3; i++) await env.workspaces.invite(owner.ctx, newEmail(), "viewer");
    expect(await code(env.workspaces.invite(owner.ctx, newEmail(), "viewer"))).toBe("SEAT_LIMIT");
  });

  it("seat limits are checked again at acceptance and on upgrade", async () => {
    const { owner, invitee, token } = await ownerAndInvitee("viewer");
    await env.workspaces.acceptInvitation(invitee.ctx, token);
    const editorEmail = newEmail("editor");
    await env.workspaces.invite(owner.ctx, editorEmail, "editor");
    await new Promise((r) => setTimeout(r, 0));
    const editorToken = inviteToken(editorEmail);
    // Upgrading the viewer would need the seat the pending editor invitation holds; at upgrade only members count.
    await env.workspaces.changeRole(owner.ctx, invitee.userId, "editor");
    const editor = await signUpVerified(env, { email: editorEmail });
    expect(await code(env.workspaces.acceptInvitation(editor.ctx, editorToken))).toBe("SEAT_LIMIT");
    expect(
      env.db
        .select()
        .from(invitations)
        .where(eq(invitations.emailNormalized, editorEmail.toLowerCase()))
        .get()?.acceptedAt,
    ).toBeNull();
  });

  it("invitation mail is rate limited per address", async () => {
    const owner = await signUpVerified(env);
    const email = newEmail();
    for (let i = 0; i < 5; i++) await env.workspaces.invite(owner.ctx, email, "viewer");
    expect(await code(env.workspaces.invite(owner.ctx, email, "viewer"))).toBe("RATE_LIMITED");
  });
});

describe("members", () => {
  async function team() {
    const { owner, invitee, token } = await ownerAndInvitee("editor");
    const m = await env.workspaces.acceptInvitation(invitee.ctx, token);
    env.accounts.setActiveAccount(invitee.ctx, owner.accountId as string);
    env.reg.calls.length = 0;
    return { owner, editor: invitee, editorTenantId: m.tenantUserId };
  }

  it("role change goes through the tenant mirror; the owner role cannot be changed this way", async () => {
    const { owner, editor, editorTenantId } = await team();
    await env.workspaces.changeRole(owner.ctx, editor.userId, "viewer");
    expect(env.reg.calls).toEqual([
      { op: "upsert", accountId: owner.accountId, tenantUserId: editorTenantId, role: "viewer" },
    ]);
    expect(env.workspaces.membership(owner.accountId as string, editor.userId)?.role).toBe(
      "viewer",
    );
    expect(await code(env.workspaces.changeRole(owner.ctx, owner.userId, "viewer"))).toBe(
      "CONFLICT",
    );
    expect(await code(env.workspaces.changeRole(editor.ctx, owner.userId, "viewer"))).toBe(
      "FORBIDDEN",
    );
    expect(await code(env.workspaces.changeRole(owner.ctx, "u_nobody", "viewer"))).toBe(
      "NOT_FOUND",
    );
    expect(auditRows(env.db).find((r) => r.event === "member.role_changed")?.detail).toEqual({
      from: "editor",
      to: "viewer",
    });
  });

  it("a downgrade that fails in the tenant leaves the control plane unchanged", async () => {
    const { owner, editor } = await team();
    env.reg.failNext.v = true;
    await expect(env.workspaces.changeRole(owner.ctx, editor.userId, "viewer")).rejects.toThrow();
    expect(env.workspaces.membership(owner.accountId as string, editor.userId)?.role).toBe(
      "editor",
    );
  });

  it("removal: tenant first, then membership; access ends at once; the owner can never be removed", async () => {
    const { owner, editor, editorTenantId } = await team();
    expect(await code(env.workspaces.removeMember(owner.ctx, owner.userId))).toBe("CONFLICT");
    expect(await code(env.workspaces.removeMember(editor.ctx, owner.userId))).toBe("FORBIDDEN");
    await env.workspaces.removeMember(owner.ctx, editor.userId);
    expect(env.reg.calls).toEqual([
      { op: "remove", accountId: owner.accountId, tenantUserId: editorTenantId },
    ]);
    expect(env.workspaces.membership(owner.accountId as string, editor.userId)).toBeNull();
    // The removed person's session no longer points at the workspace.
    expect(ctxOf(env, editor.session.token).activeAccountId).toBeNull();
    expect(await code(() => env.workspaces.members(ctxOf(env, editor.session.token)))).toBe(
      "FORBIDDEN",
    );
    expect(
      env.db.select().from(sessions).where(eq(sessions.userId, editor.userId)).get()
        ?.activeAccountId,
    ).toBeNull();
    // The removed person is told, with the workspace's name and nothing else from it.
    await new Promise((r) => setTimeout(r, 0));
    const notice = env.mailer.to(editor.email, "member-removed");
    expect(notice).toHaveLength(1);
    expect(Object.keys(notice[0]?.data ?? {}).sort()).toEqual(["name", "workspaceName"]);
    expect(notice[0]?.data.workspaceName).toBe(
      env.db
        .select()
        .from(accounts)
        .where(eq(accounts.id, owner.accountId as string))
        .get()?.name,
    );
    // Only the removed person is told.
    expect(env.mailer.to(owner.email, "member-removed")).toHaveLength(0);
  });

  it("a stale session context cannot act after removal (membership is re-read)", async () => {
    const { owner, editor } = await team();
    const stale = { ...editor.ctx, activeAccountId: owner.accountId };
    await env.workspaces.removeMember(owner.ctx, editor.userId);
    expect(await code(() => env.workspaces.members(stale))).toBe("FORBIDDEN");
  });

  it("leaving: members can, the owner cannot", async () => {
    const { owner, editor, editorTenantId } = await team();
    expect(await code(env.workspaces.leave(owner.ctx))).toBe("CONFLICT");
    await env.workspaces.leave(editor.ctx);
    expect(env.reg.calls).toEqual([
      { op: "remove", accountId: owner.accountId, tenantUserId: editorTenantId },
    ]);
    expect(env.workspaces.membership(owner.accountId as string, editor.userId)).toBeNull();
    expect(auditRows(env.db).some((r) => r.event === "member.left")).toBe(true);
  });

  it("ownership transfer: re-auth, editor only, credentials of both revoked first, tenant ids swapped", async () => {
    const { owner, editor, editorTenantId } = await team();
    expect(await code(env.workspaces.transferOwnership(owner.ctx, editor.userId))).toBe(
      "REAUTH_REQUIRED",
    );
    await reauth(owner);
    expect(await code(env.workspaces.transferOwnership(owner.ctx, "u_nobody"))).toBe("NOT_FOUND");
    expect(await code(env.workspaces.transferOwnership(editor.ctx, owner.userId))).toBe(
      "FORBIDDEN",
    );
    await env.workspaces.transferOwnership(owner.ctx, editor.userId);
    expect(env.reg.calls.slice(0, 2)).toEqual([
      { op: "revokeCredentials", accountId: owner.accountId, tenantUserId: "owner" },
      { op: "revokeCredentials", accountId: owner.accountId, tenantUserId: editorTenantId },
    ]);
    expect(env.reg.calls.slice(2)).toEqual([
      { op: "upsert", accountId: owner.accountId, tenantUserId: "owner", role: "owner" },
      { op: "upsert", accountId: owner.accountId, tenantUserId: editorTenantId, role: "editor" },
    ]);
    expect(env.workspaces.membership(owner.accountId as string, editor.userId)).toMatchObject({
      role: "owner",
      tenantUserId: "owner",
    });
    expect(env.workspaces.membership(owner.accountId as string, owner.userId)).toMatchObject({
      role: "editor",
      tenantUserId: editorTenantId,
    });
    expect(
      env.db
        .select()
        .from(accounts)
        .where(eq(accounts.id, owner.accountId as string))
        .get()?.ownerUserId,
    ).toBe(editor.userId);
    await new Promise((r) => setTimeout(r, 0));
    expect(env.mailer.last(editor.email, "security-change")?.data.change).toBe(
      "ownership-transferred",
    );
    expect(env.mailer.last(owner.email, "security-change")?.data.change).toBe(
      "ownership-transferred",
    );
    // The former owner can now leave; the new owner cannot.
    expect(await code(env.workspaces.leave(editor.ctx))).toBe("CONFLICT");
  });

  it("ownership goes only to an editor who does not own another workspace", async () => {
    const { owner, invitee, token } = await ownerAndInvitee("viewer");
    await env.workspaces.acceptInvitation(invitee.ctx, token);
    await reauth(owner);
    expect(await code(env.workspaces.transferOwnership(owner.ctx, invitee.userId))).toBe(
      "CONFLICT",
    );
    // Someone who owns a workspace of their own and joins as an editor cannot receive ownership.
    const other = await signUpVerified(env);
    await env.workspaces.invite(owner.ctx, other.email, "editor");
    await new Promise((r) => setTimeout(r, 0));
    await env.workspaces.acceptInvitation(other.ctx, inviteToken(other.email));
    expect(await code(env.workspaces.transferOwnership(owner.ctx, other.userId))).toBe("CONFLICT");
    expect(await code(env.workspaces.transferOwnership(owner.ctx, owner.userId))).toBe(
      "VALIDATION",
    );
  });
});

describe("workspace settings", () => {
  it("rename, MCP writes and support grants are owner-only and audited", async () => {
    const { owner, invitee, token } = await ownerAndInvitee("editor");
    await env.workspaces.acceptInvitation(invitee.ctx, token);
    env.accounts.setActiveAccount(invitee.ctx, owner.accountId as string);

    env.workspaces.rename(owner.ctx, "  Family finances ");
    expect(env.workspaces.listForUser(owner.userId)[0]).toMatchObject({
      name: "Family finances",
      role: "owner",
      access: { level: "full" },
    });
    expect(await code(() => env.workspaces.rename(owner.ctx, ""))).toBe("VALIDATION");
    expect(await code(() => env.workspaces.rename(invitee.ctx, "x"))).toBe("FORBIDDEN");

    env.workspaces.setMcpWrites(owner.ctx, true);
    expect(
      env.db
        .select()
        .from(accounts)
        .where(eq(accounts.id, owner.accountId as string))
        .get()?.mcpWrites,
    ).toBe(true);
    expect(await code(() => env.workspaces.setMcpWrites(invitee.ctx, false))).toBe("FORBIDDEN");

    const g = env.workspaces.createSupportGrant(owner.ctx, "help with import", 7);
    expect(Date.parse(g.expiresAt) - env.clock.t).toBe(7 * DAY);
    expect(await code(() => env.workspaces.createSupportGrant(owner.ctx, "x", 8))).toBe(
      "VALIDATION",
    );
    expect(await code(() => env.workspaces.createSupportGrant(owner.ctx, "", 1))).toBe(
      "VALIDATION",
    );
    expect(await code(() => env.workspaces.createSupportGrant(invitee.ctx, "x", 1))).toBe(
      "FORBIDDEN",
    );
    expect(env.db.select().from(supportGrants).all()).toHaveLength(1);

    const events = auditRows(env.db).map((r) => r.event);
    expect(events).toEqual(
      expect.arrayContaining([
        "workspace.renamed",
        "workspace.mcp_writes_changed",
        "support_grant.created",
      ]),
    );
    // Free text (workspace name, grant reason) never reaches the audit trail.
    expect(JSON.stringify(auditRows(env.db))).not.toMatch(/Family finances|help with import/);
  });

  it("membership() refuses crafted account ids without querying", async () => {
    const owner = await signUpVerified(env);
    for (const bad of [
      "../x",
      `${owner.accountId}/..`,
      (owner.accountId as string).toUpperCase(),
      "t",
    ])
      expect(env.workspaces.membership(bad, owner.userId)).toBeNull();
    expect(env.db.select().from(memberships).all()).toHaveLength(1);
  });
});
