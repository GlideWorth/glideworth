/**
 * `registerCloudRoutes(app, deps)` (spec 8.3): every cloud-only HTTP route, declared with `@hono/zod-openapi`
 * so it appears in the API's OpenAPI document (cloud mode only). Request bodies are limited per route group
 * (64 KiB JSON; the Stripe webhook 1 MiB; Mailgun 256 KiB) before any handler reads them.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CloudError } from "../../errors.js";
import { cloudErrorResponse } from "../common.js";
import { type CloudHttpDeps, RouteKit } from "../kit.js";
import { accountRoutes } from "./account.js";
import { authRoutes } from "./auth.js";
import { billingRoutes } from "./billing.js";
import { emailRoutes } from "./email.js";
import { workspaceRoutes } from "./workspace.js";

const JSON_LIMIT = 64 * 1024;

// oxlint-disable-next-line typescript/no-explicit-any -- the host's app has its own Env; the cloud routes only add routes.
export function registerCloudRoutes(app: OpenAPIHono<any>, d: CloudHttpDeps): void {
  const limit = (maxSize: number): MiddlewareHandler =>
    bodyLimit({
      maxSize,
      onError: (c) =>
        cloudErrorResponse(new CloudError(413, "PAYLOAD_TOO_LARGE", "request body too large"), c),
    });
  for (const p of [
    "/api/v1/auth/*",
    "/api/v1/account",
    "/api/v1/account/*",
    "/api/v1/workspaces",
    "/api/v1/workspaces/*",
    "/api/v1/workspace",
    "/api/v1/workspace/*",
    "/api/v1/billing",
    "/api/v1/billing/*",
    "/email/unsubscribe",
  ])
    app.use(p, limit(JSON_LIMIT));
  app.use("/stripe/webhook", limit(1024 * 1024));
  app.use("/email/webhooks/*", limit(256 * 1024));
  app.openAPIRegistry.registerComponent("securitySchemes", "cloudSession", {
    type: "apiKey",
    in: "cookie",
    name: "__Host-gw_session",
    description:
      "Browser session (cloud). Writes also send `X-CSRF-Token` with the `__Host-gw_csrf` value.",
  });
  const k = new RouteKit(app as never, d);
  authRoutes(k);
  accountRoutes(k);
  workspaceRoutes(k);
  billingRoutes(k);
  emailRoutes(k);
}
