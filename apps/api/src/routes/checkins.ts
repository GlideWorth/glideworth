/** Scheduled check-ins: plan health history, notifications, "what changed since my last check-in". */
import { z } from "@hono/zod-openapi";
import { ApiError } from "../errors.js";
import { ScheduleConfig } from "../services/checkins.js";
import { actorOf, IdParam, json, type RouteCtx, route } from "./helpers.js";

const Milestone = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["reached", "never", "disabled"]),
  month: z.string().nullable(),
});
const Health = z
  .object({
    id: z.string(),
    planId: z.string(),
    planName: z.string(),
    takenAt: z.string(),
    trigger: z.enum(["scheduled", "manual", "api"]),
    planVersion: z.number().int(),
    householdVersion: z.number().int(),
    successRate: z.number().nullable().describe("Monte Carlo chance of success, 0..1."),
    fiYear: z
      .number()
      .int()
      .nullable()
      .describe("Financial-independence year (or the retirement year)."),
    actualNetWorth: z
      .number()
      .nullable()
      .describe("Net worth from the household’s current finances."),
    plannedNetWorth: z
      .number()
      .nullable()
      .describe("What the previous check-in projected for today."),
    netWorthVsPlan: z.object({ delta: z.number(), ratio: z.number() }).nullable(),
    endNetWorthReal: z.number().nullable(),
    depletionYear: z.number().int().nullable(),
    milestones: z.array(Milestone),
    findings: z.array(
      z.object({ key: z.string(), code: z.string(), severity: z.string(), title: z.string() }),
    ),
    currency: z.string(),
  })
  .meta({ id: "PlanHealth" });
const Change = z
  .object({
    kind: z.enum(["success-rate-change", "milestone-slipped", "audit-finding", "behind-plan"]),
    severity: z.enum(["info", "warning", "critical"]),
    title: z.string(),
    detail: z.record(z.string(), z.unknown()),
  })
  .meta({ id: "CheckInChange" });
const Notification = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    kind: z.string(),
    severity: z.enum(["info", "warning", "critical"]),
    planId: z.string().nullable(),
    healthId: z.string().nullable(),
    title: z.string(),
    body: z.unknown(),
    read: z.boolean(),
  })
  .meta({ id: "Notification" });
const Schedule = ScheduleConfig.extend({
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  running: z.boolean(),
}).meta({ id: "Schedule" });
const SchedulePatch = z
  .object({
    enabled: z.boolean(),
    cadence: z.enum(["daily", "weekly", "monthly", "quarterly"]),
    intervalHours: z
      .number()
      .min(1)
      .max(24 * 366)
      .nullable(),
    thresholds: z
      .object({
        successRateDelta: z.number().min(0.001).max(1),
        milestoneSlipMonths: z.number().int().min(1).max(600),
        netWorthBehindPlan: z.number().min(0.01).max(1),
      })
      .partial(),
    monteCarloTrials: z.number().int().min(100).max(20_000).nullable(),
  })
  .partial()
  .meta({ id: "SchedulePatch" });

export function checkinRoutes({ app, svc }: RouteCtx) {
  app.openapi(
    route("read", {
      method: "get",
      path: "/api/v1/schedule",
      operationId: "getSchedule",
      tags: ["Check-ins"],
      summary: "The check-in schedule: cadence, thresholds, last and next run",
      responses: { 200: json(Schedule, "Schedule") },
    }),
    (c) => c.json(svc(c).checkins.getConfig() as never, 200),
  );
  app.openapi(
    route("write", {
      method: "patch",
      path: "/api/v1/schedule",
      operationId: "updateSchedule",
      tags: ["Check-ins"],
      summary: "Change the schedule (partial update; null clears intervalHours / monteCarloTrials)",
      request: {
        body: { content: { "application/json": { schema: SchedulePatch } }, required: true },
      },
      responses: { 200: json(Schedule, "Schedule") },
    }),
    (c) => {
      const p = c.req.valid("json") as Record<string, unknown>;
      for (const k of ["intervalHours", "monteCarloTrials"]) if (p[k] === null) p[k] = undefined;
      return c.json(svc(c).checkins.setConfig(p) as never, 200);
    },
  );

  app.openapi(
    route("write", {
      method: "post",
      path: "/api/v1/plans/{id}/checkins",
      operationId: "runCheckin",
      tags: ["Check-ins"],
      summary:
        "Check in on this plan now: re-run projection, chance of success and audit; store the result",
      description:
        "Same work as a scheduled run. Waits for Monte Carlo (seconds). Returns the stored health record, the check-in before it, and any material changes (also stored as notifications and sent as the `checkin.completed` / `notification.created` webhooks).",
      request: { params: IdParam },
      responses: {
        200: json(
          z.object({
            health: Health,
            previous: Health.nullable(),
            changes: z.array(Change),
            notifications: z.array(Notification),
          }),
          "Check-in",
        ),
      },
    }),
    async (c) =>
      c.json(
        (await svc(c).checkins.runPlan(c.req.valid("param").id, "api", actorOf(c))) as never,
        200,
      ),
  );

  app.openapi(
    route("read", {
      method: "get",
      path: "/api/v1/plans/{id}/health",
      operationId: "planHealthHistory",
      tags: ["Check-ins"],
      summary:
        "Plan health history: success rate, FI year and net worth versus plan over time (newest first)",
      request: {
        params: IdParam,
        query: z.object({
          limit: z.coerce.number().int().min(1).max(500).default(50),
          since: z.string().optional().describe("ISO timestamp: only check-ins after it."),
        }),
      },
      responses: { 200: json(z.object({ items: z.array(Health) }), "History") },
    }),
    (c) => {
      const q = c.req.valid("query");
      return c.json({ items: svc(c).checkins.history(c.req.valid("param").id, q) } as never, 200);
    },
  );

  app.openapi(
    route("read", {
      method: "get",
      path: "/api/v1/plans/{id}/changes-since-checkin",
      operationId: "changesSinceCheckin",
      tags: ["Check-ins"],
      summary: "What changed since my last check-in",
      description:
        "Compares the plan and household as they are now (deterministic recompute; the chance of success is the stored one) with the last check-in: material changes, the plan edits made since and by whom, net worth moved, notifications raised. " +
        "`refresh=true` first takes a new check-in (re-runs Monte Carlo; needs `write`) and reports what changed against the previous one. `since` overrides the baseline time.",
      request: {
        params: IdParam,
        query: z.object({
          since: z.string().optional(),
          refresh: z.enum(["true", "false"]).default("false"),
        }),
      },
      responses: {
        200: json(z.record(z.string(), z.unknown()).meta({ id: "ChangesSinceCheckin" }), "Changes"),
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const p = c.get("principal");
      if (q.refresh === "true" && !p.scopes.includes("write"))
        throw new ApiError(
          403,
          "FORBIDDEN",
          "refresh=true takes a check-in and needs the write scope",
          {
            required: "write",
          },
        );
      return c.json(
        (await svc(c).checkins.sinceLastCheckin(
          c.req.valid("param").id,
          { since: q.since, refresh: q.refresh === "true" },
          actorOf(c),
        )) as never,
        200,
      );
    },
  );

  app.openapi(
    route("read", {
      method: "get",
      path: "/api/v1/notifications",
      operationId: "listNotifications",
      tags: ["Check-ins"],
      summary: "Notifications raised by check-ins (newest first)",
      request: {
        query: z.object({
          unread: z.enum(["true", "false"]).default("false"),
          planId: z.string().optional(),
          since: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(50),
        }),
      },
      responses: {
        200: json(
          z.object({ items: z.array(Notification), unread: z.number().int() }),
          "Notifications",
        ),
      },
    }),
    (c) => {
      const q = c.req.valid("query");
      return c.json(
        {
          items: svc(c).checkins.notifications({ ...q, unread: q.unread === "true" }),
          unread: svc(c).checkins.unreadCount(),
        } as never,
        200,
      );
    },
  );
  app.openapi(
    route(
      "write",
      {
        method: "post",
        path: "/api/v1/notifications/read",
        operationId: "markNotificationsRead",
        tags: ["Check-ins"],
        summary: "Mark notifications read (`ids`, or `all`)",
        request: {
          body: {
            content: {
              "application/json": {
                schema: z.object({
                  ids: z.array(z.string()).max(500).optional(),
                  all: z.boolean().optional(),
                }),
              },
            },
            required: true,
          },
        },
        responses: { 200: json(z.object({ marked: z.number().int() }), "Marked") },
      },
      { allowWhenReadOnly: true },
    ),
    (c) => {
      const b = c.req.valid("json");
      if (!b.all && !b.ids?.length)
        throw new ApiError(400, "VALIDATION", "give `ids` or `all: true`");
      return c.json({ marked: svc(c).checkins.markRead(b.all ? "all" : (b.ids ?? [])) }, 200);
    },
  );
}
