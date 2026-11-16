import { UserSettings } from "@glideworth/core";
import { z } from "@hono/zod-openapi";
import { SCOPES } from "../auth.js";
import { WEBHOOK_EVENTS } from "../services/context.js";
import { PageQuery, pageOf, paginate } from "../util.js";
import {
  actorOf,
  Deleted,
  IdParam,
  json,
  MergePatchBody,
  type RouteCtx,
  route,
} from "./helpers.js";

const KeyInfo = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(z.enum(SCOPES as [string, ...string[]])),
    userId: z.string().nullable(),
    userName: z.string().nullable(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
  })
  .meta({ id: "ApiKeyInfo" });
const KeyCreated = KeyInfo.extend({
  key: z.string().describe("The secret. Shown ONCE; only its sha256 is stored."),
}).meta({ id: "ApiKeyCreated" });

const WebhookInfo = z
  .object({
    id: z.string(),
    url: z.string(),
    description: z.string().nullable(),
    events: z.array(z.string()),
    active: z.boolean(),
    createdAt: z.string(),
  })
  .meta({ id: "Webhook" });
const WebhookCreate = z
  .object({
    url: z.string().url().max(2000),
    events: z
      .array(z.enum(WEBHOOK_EVENTS as [string, ...string[]]))
      .min(1)
      .describe("plan.updated, simulation.completed, snapshot.created"),
    description: z.string().max(200).optional(),
  })
  .meta({
    id: "WebhookCreate",
    examples: [
      {
        url: "https://example.com/glideworth-hook",
        events: ["plan.updated", "simulation.completed"],
      },
    ],
  });
const Delivery = z
  .object({
    id: z.string(),
    webhookId: z.string(),
    event: z.string(),
    status: z.enum(["pending", "succeeded", "failed"]),
    attempts: z.number().int(),
    lastStatusCode: z.number().int().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.string(),
    deliveredAt: z.string().nullable(),
  })
  .meta({ id: "WebhookDelivery" });

export function adminRoutes({ app, svc }: RouteCtx) {
  // ----------------------------------------------------------------------------- settings
  app.openapi(
    route("read", {
      method: "get",
      path: "/api/v1/settings",
      operationId: "getSettings",
      tags: ["Settings"],
      summary: "User settings",
      responses: { 200: json(UserSettings, "Settings") },
    }),
    (c) => c.json(svc(c).settings.get(), 200),
  );
  app.openapi(
    route("write", {
      method: "put",
      path: "/api/v1/settings",
      operationId: "replaceSettings",
      tags: ["Settings"],
      summary: "Replace settings",
      request: {
        body: { content: { "application/json": { schema: UserSettings } }, required: true },
      },
      responses: { 200: json(UserSettings, "Settings") },
    }),
    (c) => c.json(svc(c).settings.put(c.req.valid("json")), 200),
  );
  app.openapi(
    route("write", {
      method: "patch",
      path: "/api/v1/settings",
      operationId: "patchSettings",
      tags: ["Settings"],
      summary: "Merge-patch settings",
      request: {
        body: { content: { "application/json": { schema: MergePatchBody } }, required: true },
      },
      responses: { 200: json(UserSettings, "Settings") },
    }),
    (c) => c.json(svc(c).settings.patch(c.req.valid("json")), 200),
  );

  // ----------------------------------------------------------------------------- keys
  app.openapi(
    route("write", {
      method: "get",
      path: "/api/v1/keys",
      operationId: "listApiKeys",
      tags: ["Keys"],
      summary: "List API keys (metadata only; secrets are never retrievable)",
      request: { query: PageQuery },
      responses: { 200: json(pageOf(KeyInfo), "Keys") },
    }),
    (c) => {
      const p = c.get("principal");
      return c.json(
        paginate(svc(c).keys.list({ id: p.userId, role: p.role }), c.req.valid("query")) as never,
        200,
      );
    },
  );
  app.openapi(
    route("write", {
      method: "post",
      path: "/api/v1/keys",
      operationId: "createApiKey",
      tags: ["Keys"],
      summary: "Create an API key. The secret is returned once. Scopes: read, simulate, write",
      description: "A key cannot grant scopes it does not have itself.",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  name: z.string().min(1).max(80),
                  scopes: z.array(z.enum(SCOPES as [string, ...string[]])).min(1),
                })
                .meta({ id: "ApiKeyCreate" }),
            },
          },
          required: true,
        },
      },
      responses: { 201: json(KeyCreated, "Created") },
    }),
    (c) => {
      const b = c.req.valid("json");
      const p = c.get("principal");
      return c.json(
        svc(c).keys.create(b.name, b.scopes as never, p.scopes, p.userId) as never,
        201,
      );
    },
  );
  app.openapi(
    route(
      "write",
      {
        method: "delete",
        path: "/api/v1/keys/{id}",
        operationId: "revokeApiKey",
        tags: ["Keys"],
        summary:
          "Revoke an API key (409 if it is the last active write key). Editors can revoke only their own",
        request: { params: IdParam },
        responses: { 200: json(KeyInfo, "Revoked key") },
      },
      { allowWhenReadOnly: true },
    ),
    (c) => {
      const p = c.get("principal");
      return c.json(
        svc(c).keys.revoke(c.req.valid("param").id, { id: p.userId, role: p.role }) as never,
        200,
      );
    },
  );

  // ----------------------------------------------------------------------------- webhooks
  app.openapi(
    route(
      "write",
      {
        method: "get",
        path: "/api/v1/webhooks",
        operationId: "listWebhooks",
        tags: ["Webhooks"],
        summary: "List webhook subscriptions",
        responses: { 200: json(z.object({ items: z.array(WebhookInfo) }), "Webhooks") },
      },
      { owner: true },
    ),
    (c) => c.json({ items: svc(c).webhooks.list() }, 200),
  );
  app.openapi(
    route(
      "write",
      {
        method: "post",
        path: "/api/v1/webhooks",
        operationId: "createWebhook",
        tags: ["Webhooks"],
        summary: "Subscribe to events. The signing secret is returned once",
        description:
          'Deliveries are POSTed as JSON with `X-Glideworth-Signature: t=<unix>,v1=<hex>` where v1 = HMAC-SHA256(secret, "<t>.<raw body>"). Failed deliveries are retried with backoff.',
        request: {
          body: { content: { "application/json": { schema: WebhookCreate } }, required: true },
        },
        responses: { 201: json(WebhookInfo.extend({ secret: z.string() }), "Created") },
      },
      { owner: true },
    ),
    (c) => c.json(svc(c).webhooks.create(c.req.valid("json")), 201),
  );
  app.openapi(
    route(
      "write",
      {
        method: "get",
        path: "/api/v1/webhooks/{id}",
        operationId: "getWebhook",
        tags: ["Webhooks"],
        summary: "Get a webhook",
        request: { params: IdParam },
        responses: { 200: json(WebhookInfo, "Webhook") },
      },
      { owner: true },
    ),
    (c) => c.json(svc(c).webhooks.get(c.req.valid("param").id), 200),
  );
  app.openapi(
    route(
      "write",
      {
        method: "patch",
        path: "/api/v1/webhooks/{id}",
        operationId: "updateWebhook",
        tags: ["Webhooks"],
        summary: "Update url, events, description or active flag",
        request: {
          params: IdParam,
          body: {
            content: {
              "application/json": {
                schema: z.object({
                  url: z.string().url().optional(),
                  events: z
                    .array(z.enum(WEBHOOK_EVENTS as [string, ...string[]]))
                    .min(1)
                    .optional(),
                  active: z.boolean().optional(),
                  description: z.string().max(200).nullable().optional(),
                }),
              },
            },
            required: true,
          },
        },
        responses: { 200: json(WebhookInfo, "Updated") },
      },
      { owner: true },
    ),
    (c) => c.json(svc(c).webhooks.update(c.req.valid("param").id, c.req.valid("json")), 200),
  );
  app.openapi(
    route(
      "write",
      {
        method: "delete",
        path: "/api/v1/webhooks/{id}",
        operationId: "deleteWebhook",
        tags: ["Webhooks"],
        summary: "Delete a webhook",
        request: { params: IdParam },
        responses: Deleted,
      },
      { owner: true, allowWhenReadOnly: true },
    ),
    (c) => {
      svc(c).webhooks.delete(c.req.valid("param").id);
      return c.body(null, 204);
    },
  );
  app.openapi(
    route(
      "write",
      {
        method: "post",
        path: "/api/v1/webhooks/{id}/ping",
        operationId: "pingWebhook",
        tags: ["Webhooks"],
        summary: "Send a webhook.ping test delivery",
        request: { params: IdParam },
        responses: { 202: { description: "Queued" } },
      },
      { owner: true },
    ),
    (c) => {
      svc(c).webhooks.ping(c.req.valid("param").id);
      return c.body(null, 202);
    },
  );
  app.openapi(
    route(
      "write",
      {
        method: "get",
        path: "/api/v1/webhooks/{id}/deliveries",
        operationId: "listWebhookDeliveries",
        tags: ["Webhooks"],
        summary: "Recent deliveries (status, attempts, last error)",
        request: { params: IdParam },
        responses: { 200: json(z.object({ items: z.array(Delivery) }), "Deliveries") },
      },
      { owner: true },
    ),
    (c) => c.json({ items: svc(c).webhooks.deliveries(c.req.valid("param").id) }, 200),
  );
  void actorOf;
}
