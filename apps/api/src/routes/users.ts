/** Collaboration: users and roles, invites, passphrase resets, audit log, "me", own API keys, OAuth grants. */
import { z } from "@hono/zod-openapi";
import { ROLES, SCOPES } from "../auth.js";
import { ApiError } from "../errors.js";
import { PageQuery, pageOf, paginate } from "../util.js";
import { actorOf, Deleted, IdParam, json, pathId, type RouteCtx, route } from "./helpers.js";

const Role = z.enum(ROLES as [string, ...string[]]);
const UserInfo = z
  .object({
    id: z.string(),
    login: z.string().describe("Sign-in name."),
    name: z.string(),
    role: Role,
    status: z.enum(["active", "invited", "disabled"]),
    createdAt: z.string(),
    lastLoginAt: z.string().nullable(),
    disabledAt: z.string().nullable(),
  })
  .meta({ id: "User" });
const Token = z.object({
  token: z
    .string()
    .describe("One-time secret. Shown once; hand it to the person (usually inside a link)."),
  kind: z.enum(["invite", "reset"]),
  expiresAt: z.string(),
});
const Invited = z.object({ user: UserInfo, invite: Token }).meta({ id: "UserInvite" });
const Reset = z.object({ user: UserInfo, reset: Token }).meta({ id: "UserReset" });
const AuditEntry = z
  .object({
    id: z.number().int(),
    at: z.string(),
    userId: z.string().nullable(),
    userName: z.string().nullable(),
    via: z.string().describe("'session', 'key', 'oauth', 'mcp' or 'system'."),
    credentialId: z.string().nullable(),
    action: z.string().describe("'METHOD /api/v1/route/:pattern', 'mcp:<tool>' or an auth event."),
    resourceType: z.string().nullable(),
    resourceId: z.string().nullable(),
    status: z.number().int().nullable(),
    detail: z.unknown(),
  })
  .meta({ id: "AuditEntry" });
const KeyInfo = z
  .object({
    id: z.string(),
    userId: z.string().nullable(),
    userName: z.string().nullable(),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(z.enum(SCOPES as [string, ...string[]])),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
  })
  .meta({ id: "ApiKeyInfo" });
const OAuthClient = z
  .object({
    id: z.string(),
    name: z.string(),
    redirectUris: z.array(z.string()),
    scope: z.string().nullable(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    activeTokens: z.number().int(),
  })
  .meta({ id: "OAuthClient" });
const Grant = z
  .object({
    id: z.string(),
    clientId: z.string(),
    clientName: z.string(),
    scopes: z.array(z.string()),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    refreshExpiresAt: z.string(),
  })
  .meta({ id: "OAuthGrant" });

export function userRoutes({ app, svc, mode }: RouteCtx) {
  const U = "/api/v1/users";

  function instanceUserRoutes() {
    // ----------------------------------------------------------------------------- users (owner)
    app.openapi(
      route(
        "write",
        {
          method: "get",
          path: U,
          operationId: "listUsers",
          tags: ["Users"],
          summary: "List the people who can sign in to this instance",
          responses: { 200: json(z.object({ items: z.array(UserInfo) }), "Users") },
        },
        { owner: true },
      ),
      (c) => c.json({ items: svc(c).users.list() } as never, 200),
    );

    app.openapi(
      route(
        "write",
        {
          method: "post",
          path: U,
          operationId: "inviteUser",
          tags: ["Users"],
          summary: "Invite a partner (editor) or a read-only viewer such as an adviser",
          description:
            "Creates the user (status `invited`) and returns a one-time invite token. Give it to the person: they open it, choose their own passphrase (`POST /auth/accept`) and are signed in. Roles: `editor` can do everything except manage users, webhooks and the audit log; `viewer` can only read and run projections.",
          request: {
            body: {
              content: {
                "application/json": {
                  schema: z
                    .object({
                      name: z.string().min(1).max(80),
                      role: z.enum(["editor", "viewer"]),
                      login: z
                        .string()
                        .min(1)
                        .max(64)
                        .optional()
                        .describe("Sign-in name (default: derived from `name`)."),
                    })
                    .meta({ id: "UserInviteRequest", examples: [{ name: "Sam", role: "editor" }] }),
                },
              },
              required: true,
            },
          },
          responses: { 201: json(Invited, "Invited") },
        },
        { owner: true },
      ),
      (c) =>
        c.json(
          svc(c).users.invite(c.req.valid("json") as never, c.get("principal").userId) as never,
          201,
        ),
    );

    app.openapi(
      route(
        "write",
        {
          method: "patch",
          path: `${U}/{id}`,
          operationId: "updateUser",
          tags: ["Users"],
          summary: "Rename, change the role of, or disable/enable a user",
          description:
            "A role change or a disable takes effect immediately on every credential of that user (sessions, API keys, OAuth tokens are capped or refused). The owner cannot be demoted or disabled.",
          request: {
            params: IdParam,
            body: {
              content: {
                "application/json": {
                  schema: z.object({
                    name: z.string().min(1).max(80).optional(),
                    role: z.enum(["editor", "viewer"]).optional(),
                    disabled: z.boolean().optional(),
                  }),
                },
              },
              required: true,
            },
          },
          responses: { 200: json(UserInfo, "Updated") },
        },
        { owner: true },
      ),
      (c) =>
        c.json(
          svc(c).users.update(c.req.valid("param").id, c.req.valid("json") as never) as never,
          200,
        ),
    );

    app.openapi(
      route(
        "write",
        {
          method: "delete",
          path: `${U}/{id}`,
          operationId: "deleteUser",
          tags: ["Users"],
          summary:
            "Remove a user (their sessions, API keys and OAuth grants go too; history keeps their name)",
          request: { params: IdParam },
          responses: Deleted,
        },
        { owner: true },
      ),
      (c) => {
        svc(c).users.delete(c.req.valid("param").id);
        return c.body(null, 204);
      },
    );

    app.openapi(
      route(
        "write",
        {
          method: "post",
          path: `${U}/{id}/reset-passphrase`,
          operationId: "resetUserPassphrase",
          tags: ["Users"],
          summary:
            "Reset someone’s passphrase: signs them out everywhere and returns a one-time token",
          description:
            "The user opens the token (`POST /auth/accept`) and chooses a new passphrase. The owner never sees it. For the owner’s own passphrase use `POST /auth/change-passphrase`, or on the server `pnpm cli reset-owner-passphrase`.",
          request: { params: IdParam },
          responses: { 200: json(Reset, "Reset token") },
        },
        { owner: true },
      ),
      (c) => {
        const id = c.req.valid("param").id;
        if (id === "owner")
          throw new ApiError(
            409,
            "OWNER_PROTECTED",
            "use change-passphrase for your own passphrase",
          );
        return c.json(svc(c).users.reset(id) as never, 200);
      },
    );

    app.openapi(
      route(
        "write",
        {
          method: "post",
          path: `${U}/{id}/invite`,
          operationId: "reinviteUser",
          tags: ["Users"],
          summary: "Issue a fresh invite token for a user who has not accepted yet",
          request: { params: IdParam },
          responses: { 200: json(Invited, "Invite") },
        },
        { owner: true },
      ),
      (c) => c.json(svc(c).users.reinvite(c.req.valid("param").id) as never, 200),
    );
  }

  // Cloud: people are members of the workspace, managed by the control plane (invitations, roles, removal);
  // these instance-user routes do not exist there (spec 3.6).
  if (mode === "selfhost") instanceUserRoutes();

  // ----------------------------------------------------------------------------- audit log (owner)
  app.openapi(
    route(
      "read",
      {
        method: "get",
        path: "/api/v1/audit-log",
        operationId: "listAuditLog",
        tags: ["Users"],
        summary: "Who changed what (newest first)",
        description:
          "Every write by a user, API key, OAuth client or MCP tool, with the person behind it. Plan edits are also stamped on the plan’s version history (`GET /plans/{id}/versions` → `actor`).",
        request: {
          query: z.object({
            userId: z.string().optional(),
            resourceType: z
              .string()
              .optional()
              .describe("e.g. 'plan', 'household', 'user', 'share-link'."),
            resourceId: z.string().optional(),
            limit: z.coerce.number().int().min(1).max(500).default(100),
            before: z.coerce
              .number()
              .int()
              .optional()
              .describe("Return entries older than this id (paging)."),
          }),
        },
        responses: {
          200: json(
            z.object({ items: z.array(AuditEntry), nextBefore: z.number().int().nullable() }),
            "Entries",
          ),
        },
      },
      { owner: true },
    ),
    (c) => {
      const q = c.req.valid("query");
      const items = svc(c).audit.list(q);
      return c.json(
        {
          items,
          nextBefore: items.length === q.limit ? (items[items.length - 1]?.id ?? null) : null,
        } as never,
        200,
      );
    },
  );

  // ----------------------------------------------------------------------------- me
  app.openapi(
    route("simulate", {
      method: "get",
      path: "/api/v1/me",
      operationId: "whoAmI",
      tags: ["Keys"],
      summary: "Who am I? The credential, the person behind it, their role and effective scopes",
      responses: {
        200: json(
          z.object({
            keyId: z.string(),
            name: z.string(),
            scopes: z.array(z.string()),
            via: z.enum(["key", "session", "oauth"]).optional(),
            userId: z.string(),
            userName: z.string(),
            role: Role,
          }),
          "Principal",
        ),
      },
    }),
    (c) => c.json(c.get("principal") as never, 200),
  );

  /** Keys of the signed-in person: a viewer may mint a read-only key for their own tools. */
  const ownKeysAllowed = (c: { get: (k: "principal") => import("../auth.js").Principal }) => {
    const p = c.get("principal");
    if (p.via !== "session" && !p.scopes.includes("write"))
      throw new ApiError(
        403,
        "FORBIDDEN",
        "sign in with your passphrase (or use a write key) to manage API keys",
      );
    return p;
  };
  app.openapi(
    route("read", {
      method: "get",
      path: "/api/v1/me/keys",
      operationId: "listMyApiKeys",
      tags: ["Keys"],
      summary: "Your own API keys (any role)",
      responses: { 200: json(z.object({ items: z.array(KeyInfo) }), "Keys") },
    }),
    (c) => {
      const p = c.get("principal");
      return c.json({ items: svc(c).keys.list({ id: p.userId, role: "self" }) } as never, 200);
    },
  );
  app.openapi(
    route("read", {
      method: "post",
      path: "/api/v1/me/keys",
      operationId: "createMyApiKey",
      tags: ["Keys"],
      summary:
        "Create an API key for yourself; scopes are capped by your role (a viewer gets read/simulate only)",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                name: z.string().min(1).max(80),
                scopes: z.array(z.enum(SCOPES as [string, ...string[]])).min(1),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        201: json(KeyInfo.extend({ key: z.string().describe("Shown once.") }), "Created"),
      },
    }),
    (c) => {
      const p = ownKeysAllowed(c);
      const b = c.req.valid("json");
      // A session carries the role's scopes; a write key may only mint what it has.
      return c.json(
        svc(c).keys.create(b.name, b.scopes as never, p.scopes, p.userId) as never,
        201,
      );
    },
  );
  app.openapi(
    route("read", {
      method: "delete",
      path: "/api/v1/me/keys/{id}",
      operationId: "revokeMyApiKey",
      tags: ["Keys"],
      summary: "Revoke one of your own API keys (needs a signed-in session or a write key)",
      "x-session-or-write": true,
      request: { params: IdParam },
      responses: { 200: json(KeyInfo, "Revoked") },
    }),
    (c) => {
      const p = ownKeysAllowed(c);
      return c.json(
        svc(c).keys.revoke(c.req.valid("param").id, { id: p.userId, role: "self" }) as never,
        200,
      );
    },
  );

  // ----------------------------------------------------------------------------- OAuth grants and clients
  app.openapi(
    route("read", {
      method: "get",
      path: "/api/v1/me/oauth-grants",
      operationId: "listMyOAuthGrants",
      tags: ["OAuth"],
      summary: "MCP clients you have connected (OAuth)",
      responses: { 200: json(z.object({ items: z.array(Grant) }), "Grants") },
    }),
    (c) => c.json({ items: svc(c).oauth.grantsOf(c.get("principal").userId) } as never, 200),
  );
  app.openapi(
    route("read", {
      method: "delete",
      path: "/api/v1/me/oauth-grants/{grantId}",
      operationId: "revokeMyOAuthGrant",
      tags: ["OAuth"],
      summary: "Disconnect an MCP client (revokes its tokens)",
      request: { params: z.object({ grantId: pathId("grantId") }) },
      responses: Deleted,
    }),
    (c) => {
      const p = c.get("principal");
      svc(c).oauth.revokeGrant(p.userId, c.req.valid("param").grantId, p.role === "owner");
      return c.body(null, 204);
    },
  );
  app.openapi(
    route(
      "write",
      {
        method: "get",
        path: "/api/v1/oauth/clients",
        operationId: "listOAuthClients",
        tags: ["OAuth"],
        summary: "Registered OAuth clients (dynamic registration)",
        request: { query: PageQuery },
        responses: { 200: json(pageOf(OAuthClient), "Clients") },
      },
      { owner: true },
    ),
    (c) => c.json(paginate(svc(c).oauth.listClients(), c.req.valid("query")) as never, 200),
  );
  app.openapi(
    route(
      "write",
      {
        method: "delete",
        path: "/api/v1/oauth/clients/{id}",
        operationId: "deleteOAuthClient",
        tags: ["OAuth"],
        summary: "Remove an OAuth client and revoke every token it holds",
        request: { params: IdParam },
        responses: Deleted,
      },
      { owner: true },
    ),
    (c) => {
      svc(c).oauth.deleteClient(c.req.valid("param").id);
      return c.body(null, 204);
    },
  );
  void actorOf;
}
