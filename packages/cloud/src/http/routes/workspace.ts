/**
 * `/api/v1/workspaces*` and `/api/v1/workspace*` (spec 3.6, 3.8, 3.9, 6.3 support grants). Every handler
 * re-reads the caller's membership of the session's active workspace; owner-only actions check the role.
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { accounts } from "../../control/schema.js";
import type { RouteKit } from "../kit.js";

const Role = z.enum(["editor", "viewer"]);
const Member = z
  .object({
    userId: z.string(),
    role: z.enum(["owner", "editor", "viewer"]),
    name: z.string(),
    /** Only in answers to owners and editors; viewers see names only. */
    email: z.string().optional(),
  })
  .openapi("WorkspaceMember");

export function workspaceRoutes(k: RouteKit): void {
  const { d } = k;
  const tag = "Cloud workspaces";
  const memberView = (m: {
    userId: string;
    role: "owner" | "editor" | "viewer";
    userName: string;
  }) => ({
    userId: m.userId,
    role: m.role,
    name: m.userName,
  });

  k.op(
    {
      method: "get",
      path: "/api/v1/workspaces",
      tag,
      summary: "Workspaces you belong to",
      auth: "session",
      ok: 200,
      okSchema: z.object({ items: z.array(z.object({ id: z.string() }).passthrough()) }),
    },
    (c) => {
      const s = k.session(c);
      return c.json(
        {
          items: d.workspaces.listForUser(s.userId).map((w) => ({
            id: w.accountId,
            name: w.name,
            role: w.role,
            access: w.access,
            active: w.accountId === s.activeAccountId,
          })),
        },
        200,
      );
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/workspaces",
      tag,
      summary: "Create your workspace (one per person) and switch to it",
      auth: "session",
      ok: 201,
      okSchema: z.object({ id: z.string() }),
      body: z.object({ name: z.string().max(400) }),
    },
    async (c, { body }) => {
      const s = k.session(c);
      const id = await d.workspaces.create(s.userId, (body as { name: string }).name);
      d.accounts.setActiveAccount(s, id);
      return c.json({ id }, 201);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/workspaces/{id}/activate",
      tag,
      summary: "Switch the active workspace (you must be a member)",
      auth: "session",
      ok: 204,
      params: z.object({ id: z.string().max(64) }),
    },
    (c, { params }) => {
      d.accounts.setActiveAccount(k.session(c), params.id as string);
      return c.body(null, 204);
    },
  );

  k.op(
    {
      method: "get",
      path: "/api/v1/workspace/settings",
      tag,
      summary: "Active workspace: name, MCP writes, your role, access level",
      auth: "session",
      ok: 200,
      okSchema: z.object({ id: z.string() }).passthrough(),
    },
    (c) => {
      const m = k.member(k.session(c));
      const row = d.db
        .select({ name: accounts.name, mcpWrites: accounts.mcpWrites, status: accounts.status })
        .from(accounts)
        .where(eq(accounts.id, m.accountId))
        .get();
      const e = d.entitlements.get(m.accountId);
      return c.json(
        {
          id: m.accountId,
          name: row?.name ?? "",
          mcpWrites: !!row?.mcpWrites,
          status: row?.status ?? null,
          role: m.role,
          access: { level: e.level, reason: e.reason, changesAt: e.changesAt },
          trialEndsAt: e.trialEndsAt,
          limits: e.limits,
        },
        200,
      );
    },
  );

  k.op(
    {
      method: "patch",
      path: "/api/v1/workspace/settings",
      tag,
      summary: "Rename the workspace or switch MCP write tools (owner)",
      auth: "session",
      ok: 200,
      okSchema: z.object({ status: z.literal("ok") }),
      body: z.object({ name: z.string().max(400).optional(), mcpWrites: z.boolean().optional() }),
    },
    (c, { body }) => {
      const s = k.session(c);
      const b = body as { name?: string; mcpWrites?: boolean };
      if (b.name !== undefined) d.workspaces.rename(s, b.name);
      if (b.mcpWrites !== undefined) d.workspaces.setMcpWrites(s, b.mcpWrites);
      return c.json({ status: "ok" as const }, 200);
    },
  );

  k.op(
    {
      method: "get",
      path: "/api/v1/workspace/members",
      tag,
      summary: "Members of the active workspace",
      auth: "session",
      ok: 200,
      okSchema: z.object({ items: z.array(Member) }),
    },
    (c) => {
      const s = k.session(c);
      const canSeeEmail = k.member(s).role !== "viewer";
      return c.json(
        {
          items: d.workspaces.members(s).map((m) => ({
            ...memberView(m),
            ...(canSeeEmail ? { email: m.userEmail } : {}),
          })),
        },
        200,
      );
    },
  );

  k.op(
    {
      method: "patch",
      path: "/api/v1/workspace/members/{userId}",
      tag,
      summary: "Change a member’s role (owner)",
      auth: "session",
      ok: 204,
      params: z.object({ userId: z.string().max(64) }),
      body: z.object({ role: Role }),
    },
    async (c, { params, body }) => {
      await d.workspaces.changeRole(
        k.session(c),
        params.userId as string,
        (body as { role: "editor" | "viewer" }).role,
      );
      return c.body(null, 204);
    },
  );

  k.op(
    {
      method: "delete",
      path: "/api/v1/workspace/members/{userId}",
      tag,
      summary: "Remove a member (owner); their keys and OAuth grants go with them",
      auth: "session",
      ok: 204,
      params: z.object({ userId: z.string().max(64) }),
    },
    async (c, { params }) => {
      await d.workspaces.removeMember(k.session(c), params.userId as string);
      return c.body(null, 204);
    },
  );

  k.op(
    {
      method: "get",
      path: "/api/v1/workspace/invitations",
      tag,
      summary: "Pending invitations (owner)",
      auth: "session",
      ok: 200,
      okSchema: z.object({ items: z.array(z.object({ id: z.string() }).passthrough()) }),
    },
    (c) => c.json({ items: d.workspaces.listInvitations(k.session(c)) }, 200),
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/workspace/invitations",
      tag,
      summary: "Invite someone by email (owner; seat limits apply)",
      auth: "session",
      ok: 201,
      okSchema: z.object({ id: z.string() }).passthrough(),
      body: z.object({ email: z.string().max(512), role: Role }),
    },
    async (c, { body }) => {
      const b = body as { email: string; role: "editor" | "viewer" };
      return c.json(await d.workspaces.invite(k.session(c), b.email, b.role), 201);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/workspace/invitations/{id}/resend",
      tag,
      summary: "Send an invitation again with a new link and a new 7-day expiry (owner)",
      auth: "session",
      ok: 200,
      okSchema: z.object({ id: z.string() }).passthrough(),
      params: z.object({ id: z.string().max(64) }),
    },
    async (c, { params }) =>
      c.json(await d.workspaces.resendInvitation(k.session(c), params.id as string), 200),
  );

  k.op(
    {
      method: "delete",
      path: "/api/v1/workspace/invitations/{id}",
      tag,
      summary: "Revoke an invitation (owner)",
      auth: "session",
      ok: 204,
      params: z.object({ id: z.string().max(64) }),
    },
    (c, { params }) => {
      d.workspaces.revokeInvitation(k.session(c), params.id as string);
      return c.body(null, 204);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/workspace/invitations/accept",
      tag,
      summary: "Accept an invitation sent to your (verified) address and switch to that workspace",
      auth: "session",
      ok: 200,
      okSchema: Member.extend({ workspaceId: z.string() }),
      body: z.object({ token: z.string().max(256) }),
    },
    async (c, { body }) => {
      const s = k.session(c);
      const m = await d.workspaces.acceptInvitation(s, (body as { token: string }).token);
      d.accounts.setActiveAccount(s, m.accountId);
      return c.json({ ...memberView(m), workspaceId: m.accountId }, 200);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/workspace/transfer",
      tag,
      summary: "Transfer ownership to an editor (owner, re-authentication)",
      auth: "session",
      ok: 204,
      body: z.object({ userId: z.string().max(64) }),
    },
    async (c, { body }) => {
      await d.workspaces.transferOwnership(k.session(c), (body as { userId: string }).userId);
      return c.body(null, 204);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/workspace/leave",
      tag,
      summary: "Leave the active workspace (not the owner)",
      auth: "session",
      ok: 204,
    },
    async (c) => {
      await d.workspaces.leave(k.session(c));
      return c.body(null, 204);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/workspace/export",
      tag,
      summary: "Export the workspace database (owner, re-authentication; 24 h, one download)",
      auth: "session",
      ok: 202,
      okSchema: z.object({ exportId: z.string(), expiresAt: z.string() }),
    },
    async (c) => c.json(await d.workspaces.exportDatabase(k.session(c)), 202),
  );

  k.op(
    {
      method: "get",
      path: "/api/v1/workspace/exports/{id}",
      tag,
      summary: "Download an export (owner of the same workspace, once, within 24 h)",
      auth: "session",
      ok: 200,
      params: z.object({ id: z.string().max(64) }),
      okSchema: z.string(),
      okContentType: "application/vnd.sqlite3",
    },
    (c, { params }) => {
      const id = params.id as string;
      const file = d.workspaces.openExport(k.session(c), id);
      const stream = createReadStream(file.path);
      stream.on("close", () => d.workspaces.finishExport(id));
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.sqlite3",
          "Content-Disposition": `attachment; filename="${file.filename}"`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  );

  k.op(
    {
      method: "get",
      path: "/api/v1/workspace/support-grants",
      tag,
      summary: "Support access grants (owner)",
      auth: "session",
      ok: 200,
      okSchema: z.object({ items: z.array(z.object({ id: z.string() }).passthrough()) }),
    },
    (c) => c.json({ items: d.workspaces.listSupportGrants(k.session(c)) }, 200),
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/workspace/support-grants",
      tag,
      summary: "Let support see this workspace read-only for up to 7 days (owner)",
      auth: "session",
      ok: 201,
      okSchema: z.object({ id: z.string(), expiresAt: z.string() }),
      body: z.object({ reason: z.string().max(500), days: z.number().int() }),
    },
    (c, { body }) => {
      const b = body as { reason: string; days: number };
      return c.json(d.workspaces.createSupportGrant(k.session(c), b.reason, b.days), 201);
    },
  );

  k.op(
    {
      method: "delete",
      path: "/api/v1/workspace/support-grants/{id}",
      tag,
      summary: "End a support grant early (owner)",
      auth: "session",
      ok: 204,
      params: z.object({ id: z.string().max(64) }),
    },
    (c, { params }) => {
      d.workspaces.revokeSupportGrant(k.session(c), params.id as string);
      return c.body(null, 204);
    },
  );

  k.op(
    {
      method: "delete",
      path: "/api/v1/workspace",
      tag,
      summary: "Delete the workspace (owner, re-authentication, type its name)",
      auth: "session",
      ok: 204,
      body: z.object({ confirmName: z.string().max(400) }),
    },
    async (c, { body }) => {
      await d.workspaces.delete(k.session(c), (body as { confirmName: string }).confirmName);
      return c.body(null, 204);
    },
  );
}
