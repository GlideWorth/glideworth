/** Shareable read-only links (owner/editor) and the public route that serves them. */
import { createRoute, z } from "@hono/zod-openapi";
import { ApiError, ErrorBody } from "../errors.js";
import { actorOf, Deleted, IdParam, json, type RouteCtx, route } from "./helpers.js";

const Link = z
  .object({
    id: z.string(),
    planId: z.string(),
    label: z.string().nullable(),
    privacy: z.enum(["full", "percent", "hidden"]),
    basis: z.enum(["real", "nominal"]),
    createdAt: z.string(),
    expiresAt: z.string(),
    revokedAt: z.string().nullable(),
    status: z.enum(["active", "expired", "revoked"]),
    snapshotAt: z.string(),
    viewCount: z.number().int(),
    lastViewedAt: z.string().nullable(),
    createdBy: z.unknown(),
  })
  .meta({ id: "ShareLink" });

export function shareRoutes(
  { app, svc }: RouteCtx,
  publicLimiter: import("hono").MiddlewareHandler,
  /** Cloud: finds the workspace from the routed token (after the per-address limit). */
  publicTenant?: import("hono").MiddlewareHandler<import("../auth.js").AuthEnv>,
) {
  app.openapi(
    route("write", {
      method: "post",
      path: "/api/v1/plans/{id}/share-links",
      operationId: "createShareLink",
      tags: ["Share links"],
      summary: "Create an expiring, revocable read-only link to a plan’s results",
      description:
        "The link serves a snapshot of the plan’s computed results (taken now; `POST /share-links/{id}/refresh` retakes it): never the household, people, accounts or other plans. " +
        "`privacy`: `full` = amounts, `percent` = every amount as a percentage of the starting net worth (no currency), `hidden` = no amounts, only success rate, years and milestones. " +
        "The `token` is returned once; open it at `/share/<token>` in the web app or `GET /api/v1/shared/<token>` (no sign-in).",
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  label: z
                    .string()
                    .max(120)
                    .optional()
                    .describe("Shown on the shared page, e.g. “For Pat (adviser)”."),
                  privacy: z.enum(["full", "percent", "hidden"]).default("full"),
                  basis: z.enum(["real", "nominal"]).default("real"),
                  expiresInDays: z.number().int().min(1).max(365).default(30),
                  includeSuccessRate: z
                    .boolean()
                    .default(true)
                    .describe(
                      "Include the chance of success. Without deferMonteCarlo the request waits for the Monte Carlo run (often about half a minute the first time; a repeat is immediate).",
                    ),
                  deferMonteCarlo: z
                    .boolean()
                    .default(false)
                    .describe(
                      'With includeSuccessRate, return the link before the run finishes. The response then has monteCarlo.status "pending" and a jobId; the snapshot\'s chance of success is filled in when the job succeeds. A cached run is included immediately.',
                    ),
                })
                .meta({
                  id: "ShareLinkCreate",
                  examples: [{ privacy: "percent", expiresInDays: 14 }],
                }),
            },
          },
          required: false,
        },
      },
      responses: {
        201: json(
          z
            .object({
              link: Link,
              token: z.string(),
              path: z.string(),
              apiPath: z.string(),
              monteCarlo: z
                .object({
                  status: z.enum(["skipped", "included", "pending", "unavailable"]),
                  jobId: z.string().optional(),
                })
                .describe("Whether the chance of success is already on the snapshot."),
            })
            .meta({ id: "ShareLinkCreated" }),
          "Created",
        ),
      },
    }),
    async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const parsed = z
        .object({
          label: z.string().max(120).optional(),
          privacy: z.enum(["full", "percent", "hidden"]).default("full"),
          basis: z.enum(["real", "nominal"]).default("real"),
          expiresInDays: z.number().int().min(1).max(365).default(30),
          includeSuccessRate: z.boolean().default(true),
          deferMonteCarlo: z.boolean().default(false),
        })
        .safeParse(body ?? {});
      if (!parsed.success)
        throw new ApiError(400, "VALIDATION", "request validation failed", parsed.error.issues);
      const out = await svc(c).shares.create(c.req.valid("param").id, parsed.data, actorOf(c));
      return c.json(
        {
          link: out.link,
          token: out.token,
          path: `/share/${out.token}`,
          apiPath: `/api/v1/shared/${out.token}`,
          monteCarlo: out.monteCarlo,
        } as never,
        201,
      );
    },
  );

  app.openapi(
    route("write", {
      method: "get",
      path: "/api/v1/share-links",
      operationId: "listShareLinks",
      tags: ["Share links"],
      summary: "Share links (tokens are never retrievable), optionally for one plan",
      request: { query: z.object({ planId: z.string().optional() }) },
      responses: { 200: json(z.object({ items: z.array(Link) }), "Links") },
    }),
    (c) => c.json({ items: svc(c).shares.list(c.req.valid("query").planId) } as never, 200),
  );

  app.openapi(
    route(
      "write",
      {
        method: "delete",
        path: "/api/v1/share-links/{id}",
        operationId: "revokeShareLink",
        tags: ["Share links"],
        summary: "Revoke a share link (it stops working immediately)",
        request: { params: IdParam },
        responses: { 200: json(Link, "Revoked") },
      },
      { allowWhenReadOnly: true },
    ),
    (c) => c.json(svc(c).shares.revoke(c.req.valid("param").id) as never, 200),
  );

  app.openapi(
    route("write", {
      method: "post",
      path: "/api/v1/share-links/{id}/refresh",
      operationId: "refreshShareLink",
      tags: ["Share links"],
      summary: "Retake the snapshot (the plan changed); the token and expiry stay",
      request: { params: IdParam },
      responses: { 200: json(Link, "Refreshed") },
    }),
    async (c) =>
      c.json((await svc(c).shares.refresh(c.req.valid("param").id, actorOf(c))) as never, 200),
  );

  // ----------------------------------------------------------------------------- public
  const Public = z
    .object({ kind: z.literal("glideworth-shared-plan"), version: z.number().int() })
    .passthrough()
    .meta({ id: "SharedPlan" });
  app.use("/api/v1/shared/*", publicLimiter);
  if (publicTenant) app.use("/api/v1/shared/*", publicTenant);
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/shared/{token}",
      operationId: "getSharedPlan",
      tags: ["Share links"],
      security: [], // public: the unguessable token is the credential
      summary: "Public: the results behind a share link. No sign-in",
      description:
        "Serves only the snapshot stored with the link: plan name, summary, milestones and a year-by-year table whose amounts follow the link’s `privacy`. Rate limited per client address. Unknown, expired and revoked tokens are all a 404.",
      // 100, not pathId's 64: cloud share tokens are routed (`gws_<workspace>_<secret>`, 73 characters).
      request: {
        params: z.object({
          token: z
            .string()
            .min(1)
            .max(100)
            .openapi({ param: { name: "token", in: "path" } }),
        }),
      },
      responses: {
        200: json(Public, "The shared results"),
        400: json(ErrorBody, "Invalid token"),
        404: json(ErrorBody, "Unknown, expired or revoked"),
        429: json(ErrorBody, "Rate limited"),
      },
    }),
    (c) => {
      c.header("Cache-Control", "no-store");
      c.header("X-Robots-Tag", "noindex, nofollow");
      return c.json(svc(c).shares.publicView(c.req.valid("param").token) as never, 200);
    },
  );
  void Deleted;
}
