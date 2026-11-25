/* oxlint-disable typescript/no-explicit-any -- tests probe arbitrary JSON responses */
/** Scheduled re-runs and check-ins: health history, change detection, notifications, webhooks, MCP. */
import type { MonteCarloResult } from "@glideworth/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { fakeSimulate, type Harness, READ_KEY, setup } from "./helpers.js";

let h: Harness;
afterEach(() => {
  h?.services.checkins.stop();
  h?.close();
});

/** Mutable knobs the fake engine and Monte Carlo read, so a test can "change the world" between check-ins. */
const world = {
  rate: 0.9,
  fiMonth: "2040-01",
  findings: [] as { code: string; severity: "info" | "warning" | "critical"; refs: string[] }[],
};
let clock = Date.now();

function make(extra: Parameters<typeof setup>[0] = {}) {
  world.rate = 0.9;
  world.fiMonth = "2040-01";
  world.findings = [];
  h = setup({
    deps: {
      simulate: ((input: Parameters<typeof fakeSimulate>[0]) => {
        const r = fakeSimulate(input);
        r.milestones = r.milestones.map(
          (m) => ({ ...m, month: m.milestoneId === "ms-fi" ? world.fiMonth : m.month }) as never,
        );
        return r;
      }) as never,
      runMonteCarloAsync: (async () =>
        ({
          successRate: world.rate,
          trials: 200,
          seed: 1,
          method: "x",
          outcomeCounts: {},
          percentiles: [],
        }) as unknown as MonteCarloResult) as never,
      auditAssumptions: (() =>
        world.findings.map((f) => ({
          ...f,
          title: `Finding ${f.code}`,
          message: "m",
          periodIndex: null,
          evidence: [],
        }))) as never,
    },
    ...extra,
  });
  clock = Date.now();
  return h;
}
// the fake clock is injected through the service options after construction
const useClock = () => {
  (h.services.checkins as any).opts.now = () => clock;
};
const edit = (value: number) =>
  h.call("/api/v1/plans/plan-main", {
    method: "PATCH",
    body: [
      { op: "replace", path: "/expenses/[id=exp-living]/amount/value", value: value + 10_000 },
    ],
    headers: { "content-type": "application/json-patch+json" },
  });
const checkin = async () => {
  const r = await h.call("/api/v1/plans/plan-main/checkins", { method: "POST" });
  expect(r.status, r.text).toBe(200);
  return r.json as {
    health: any;
    previous: any;
    changes: { kind: string; severity: string; title: string }[];
    notifications: any[];
  };
};

describe("a check-in", () => {
  it("stores the success rate, FI year and net worth versus plan as a time series", async () => {
    make();
    useClock();
    const a = await checkin();
    expect(a.previous).toBeNull();
    expect(a.changes).toEqual([]); // no baseline yet: nothing to compare
    expect(a.health).toMatchObject({
      planId: "plan-main",
      successRate: 0.9,
      fiYear: 2040,
      trigger: "api",
    });
    expect(a.health.actualNetWorth).toEqual(expect.any(Number));
    clock += 86_400_000;
    await edit(5100);
    const b = await checkin();
    expect(b.previous.id).toBe(a.health.id);
    const hist = (await h.call("/api/v1/plans/plan-main/health")).json.items;
    expect(hist.map((x: any) => x.id)).toEqual([b.health.id, a.health.id]);
    expect(hist[0].planVersion).toBeGreaterThan(hist[1].planVersion);
    // net worth versus plan: compared with what the previous check-in projected for today
    expect(b.health.plannedNetWorth).toEqual(expect.any(Number));
    expect(b.health.netWorthVsPlan).toMatchObject({
      delta: expect.any(Number),
      ratio: expect.any(Number),
    });
  });

  it("detects a chance-of-success change above the threshold, stores a notification and fires webhooks", async () => {
    make();
    useClock();
    const events: string[] = [];
    h.services.events.on("event", (e: { name: string }) => events.push(e.name));
    await checkin();
    world.rate = 0.62;
    await edit(5200);
    const b = await checkin();
    const c = b.changes.find((x) => x.kind === "success-rate-change")!;
    expect(c).toMatchObject({ severity: "critical" });
    expect(c.title).toContain("90%");
    expect(c.title).toContain("62%");
    const n = (await h.call("/api/v1/notifications?unread=true")).json;
    expect(n.unread).toBe(b.notifications.length);
    expect(n.items[0]).toMatchObject({
      kind: "success-rate-change",
      planId: "plan-main",
      read: false,
    });
    expect(events).toContain("checkin.completed");
    expect(events).toContain("notification.created");
    // marking read
    const id = n.items[0].id;
    expect(
      (await h.call("/api/v1/notifications/read", { method: "POST", body: { ids: [id] } })).json
        .marked,
    ).toBe(1);
    expect(
      (await h.call("/api/v1/notifications?unread=true")).json.items.some((x: any) => x.id === id),
    ).toBe(false);
    expect((await h.call("/api/v1/notifications/read", { method: "POST", body: {} })).status).toBe(
      400,
    );
  });

  it("ignores a change below the threshold; thresholds are configurable", async () => {
    make();
    useClock();
    await checkin();
    world.rate = 0.87;
    await edit(5300);
    expect((await checkin()).changes).toEqual([]);
    await h.call("/api/v1/schedule", {
      method: "PATCH",
      body: { thresholds: { successRateDelta: 0.01 } },
    });
    world.rate = 0.8;
    await edit(5400);
    expect((await checkin()).changes.map((c) => c.kind)).toContain("success-rate-change");
  });

  it("detects a slipped milestone and a milestone that is no longer reached", async () => {
    make();
    useClock();
    await checkin();
    world.fiMonth = "2041-03"; // 14 months later
    await edit(5500);
    const b = await checkin();
    const slip = b.changes.find((c) => c.kind === "milestone-slipped")!;
    expect(slip.title).toContain("2040-01");
    expect(slip.title).toContain("2041-03");
    expect(b.health.fiYear).toBe(2041);
    world.fiMonth = "2041-04"; // one month: below the 6 month threshold
    await edit(5600);
    expect((await checkin()).changes.filter((c) => c.kind === "milestone-slipped")).toEqual([]);
  });

  it("detects an audit finding that was not there before (and not repeats of old ones)", async () => {
    make();
    useClock();
    world.findings = [{ code: "OLD", severity: "warning", refs: ["a"] }];
    await checkin();
    world.findings = [
      { code: "OLD", severity: "warning", refs: ["a"] },
      { code: "NEW", severity: "critical", refs: ["b"] },
      { code: "MINOR", severity: "info", refs: [] },
    ];
    await edit(5700);
    const b = await checkin();
    const f = b.changes.filter((c) => c.kind === "audit-finding");
    expect(f).toHaveLength(1);
    expect(f[0]!.title).toContain("NEW");
    expect(f[0]!.severity).toBe("critical");
  });

  it("flags net worth that is behind what the last check-in projected", async () => {
    make();
    useClock();
    await checkin();
    // the household loses most of its balances
    h.ctx.sqlite
      .prepare("update households set finances = json_set(finances, '$.accounts[0].balance', 0)")
      .run();
    const accounts = h.services.households.get("hh-sample").finances.accounts;
    for (const a of accounts)
      await h.call(`/api/v1/households/hh-sample/accounts/${a.id}`, {
        method: "PATCH",
        body: { balance: 1 },
      });
    clock += 2 * 86_400_000;
    const b = await checkin();
    expect(b.changes.map((c) => c.kind)).toContain("behind-plan");
  });

  it("a webhook subscription receives checkin.completed and notification.created", async () => {
    const calls: string[] = [];
    make({
      fetch: (async (_u: unknown, init: RequestInit) => {
        calls.push(String(init.body));
        return new Response("ok");
      }) as never,
    });
    useClock();
    const hook = await h.call("/api/v1/webhooks", {
      method: "POST",
      body: {
        url: "https://example.com/hook",
        events: ["checkin.completed", "notification.created"],
      },
    });
    expect(hook.status, hook.text).toBe(201);
    await checkin();
    world.rate = 0.5;
    await edit(5800);
    await checkin();
    await h.services.webhooks.flush();
    const names = calls.map((c) => JSON.parse(c).event ?? JSON.parse(c).name);
    expect(names).toContain("checkin.completed");
    expect(names).toContain("notification.created");
  });
});

describe("the scheduler", () => {
  it("runs on a cadence, not before it is due, and not when disabled", async () => {
    make();
    useClock();
    const ck = h.services.checkins;
    expect((await ck.tick()).length).toBe(1); // never run: baseline now
    expect(await ck.tick()).toEqual([]);
    clock += 6 * 86_400_000;
    expect(await ck.tick()).toEqual([]);
    clock += 2 * 86_400_000; // 8 days: weekly is due
    await edit(5900);
    expect((await ck.tick()).length).toBe(1);
    expect(ck.getConfig()).toMatchObject({
      lastRunAt: new Date(clock).toISOString(),
      cadence: "weekly",
    });
    await h.call("/api/v1/schedule", { method: "PATCH", body: { cadence: "daily" } });
    clock += 86_400_000 + 1000;
    await edit(6000);
    expect((await ck.tick()).length).toBe(1);
    await h.call("/api/v1/schedule", { method: "PATCH", body: { enabled: false } });
    clock += 30 * 86_400_000;
    expect(await ck.tick()).toEqual([]);
    expect(ck.getConfig().nextRunAt).toBeNull();
    expect(((await h.call("/api/v1/plans/plan-main/health")).json.items as unknown[]).length).toBe(
      3,
    );
  });

  it("a custom interval overrides the cadence; the timer can start and stop", async () => {
    make();
    useClock();
    await h.call("/api/v1/schedule", { method: "PATCH", body: { intervalHours: 2 } });
    const ck = h.services.checkins;
    await ck.tick();
    clock += 3 * 3_600_000;
    expect((await ck.tick()).length).toBe(1);
    ck.start(10_000);
    ck.stop();
    expect(ck.getConfig().intervalHours).toBe(2);
  });

  it("one plan per household: only the active main plan is re-run", async () => {
    make();
    useClock();
    const hs = await h.services.checkins.tick();
    expect(hs.map((x) => x.planId)).toEqual(["plan-main"]);
  });

  it("validates the schedule", async () => {
    make();
    expect(
      (await h.call("/api/v1/schedule", { method: "PATCH", body: { cadence: "hourly" } })).status,
    ).toBe(400);
    expect(
      (
        await h.call("/api/v1/schedule", {
          method: "PATCH",
          body: { thresholds: { successRateDelta: 5 } },
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.call("/api/v1/schedule", { method: "PATCH", body: { intervalHours: 0 } })).status,
    ).toBe(400);
    expect((await h.call("/api/v1/schedule", { key: READ_KEY })).status).toBe(200);
    expect(
      (await h.call("/api/v1/schedule", { method: "PATCH", key: READ_KEY, body: {} })).status,
    ).toBe(403);
  });
});

describe("what changed since my last check-in", () => {
  it("W4-3: the note is plain language for people, not API instructions", async () => {
    make();
    useClock();
    const none = (await h.call("/api/v1/plans/plan-main/changes-since-checkin")).json
      .note as string;
    await checkin();
    const after = (await h.call("/api/v1/plans/plan-main/changes-since-checkin")).json
      .note as string;
    for (const note of [none, after]) {
      expect(note).toMatch(/check[- ]in/i);
      expect(note).not.toMatch(/refresh=|POST |\/plans\/|\{id\}|Monte Carlo/);
    }
  });
  it("lists the edits since and by whom, net worth movement and material changes", async () => {
    make();
    useClock();
    expect((await h.call("/api/v1/plans/plan-main/changes-since-checkin")).json).toMatchObject({
      lastCheckIn: null,
      changes: [],
    });
    await checkin();
    clock += 86_400_000;
    world.fiMonth = "2042-01";
    await edit(6100);
    const r = (await h.call("/api/v1/plans/plan-main/changes-since-checkin")).json;
    expect(r.lastCheckIn).toBeTruthy();
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0].actor).toMatchObject({ kind: "api-key", label: "test-write" });
    expect(r.planVersionNow).toBeGreaterThan(r.planVersionAtCheckIn);
    expect(r.changes.map((c: any) => c.kind)).toContain("milestone-slipped");
    expect(r.current.successRate).toBe(0.9); // stored value: no Monte Carlo re-run
    expect(r.netWorth).toMatchObject({ atCheckIn: expect.any(Number), now: expect.any(Number) });
  });

  it("refresh=true takes a new check-in and needs write access", async () => {
    make();
    useClock();
    await checkin();
    world.rate = 0.4;
    await edit(6200);
    const denied = await h.call("/api/v1/plans/plan-main/changes-since-checkin?refresh=true", {
      key: READ_KEY,
    });
    expect(denied.status).toBe(403);
    const r = (await h.call("/api/v1/plans/plan-main/changes-since-checkin?refresh=true")).json;
    expect(r.changes.map((c: any) => c.kind)).toContain("success-rate-change");
    expect(r.current.successRate).toBe(0.4);
    expect((await h.call("/api/v1/plans/plan-main/health")).json.items).toHaveLength(2);
  });

  it("is available to read keys (viewers) but running a check-in is not", async () => {
    make();
    expect((await h.call("/api/v1/plans/plan-main/health", { key: READ_KEY })).status).toBe(200);
    expect((await h.call("/api/v1/notifications", { key: READ_KEY })).status).toBe(200);
    expect(
      (await h.call("/api/v1/plans/plan-main/checkins", { method: "POST", key: READ_KEY })).status,
    ).toBe(403);
    expect((await h.call("/api/v1/plans/nope/health")).status).toBe(404);
  });
});

describe("MCP", () => {
  async function client(canWrite: boolean) {
    const server = createMcpServer({
      services: h.services,
      scopes: canWrite ? ["read", "simulate", "write"] : ["read", "simulate"],
      canWrite,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), c.connect(b)]);
    return c;
  }
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: !!r.isError, json: JSON.parse(r.content[0]!.text) };
  };

  it("exposes health history, notifications, schedule and what-changed; write tools only with write access", async () => {
    make();
    useClock();
    const ro = await client(false);
    const names = (await ro.listTools()).tools.map((t) => t.name);
    for (const n of [
      "get_plan_health_history",
      "list_notifications",
      "get_checkin_schedule",
      "what_changed_since_checkin",
    ])
      expect(names).toContain(n);
    for (const n of [
      "run_checkin",
      "set_checkin_schedule",
      "mark_notifications_read",
      "create_share_link",
      "revoke_share_link",
    ])
      expect(names).not.toContain(n);
    const rw = await client(true);
    const run = await call(rw, "run_checkin");
    expect(run.isError).toBe(false);
    world.rate = 0.5;
    await edit(6300);
    const second = await call(rw, "run_checkin", {});
    expect(second.json.changes.map((c: any) => c.kind)).toContain("success-rate-change");
    const hist = await call(ro, "get_plan_health_history");
    expect(hist.json.items).toHaveLength(2);
    expect((await call(ro, "list_notifications")).json.unread).toBeGreaterThan(0);
    const since = await call(ro, "what_changed_since_checkin");
    expect(since.json.lastCheckIn).toBeTruthy();
    // Read-only means no check-in is stored, even when a write connection passes the old refresh flag.
    const tools = (await rw.listTools()).tools;
    const whatChanged = tools.find((t) => t.name === "what_changed_since_checkin")!;
    expect(whatChanged.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(whatChanged.inputSchema.properties ?? {})).not.toContain("refresh");
    await call(rw, "what_changed_since_checkin", { refresh: true });
    expect((await call(ro, "get_plan_health_history")).json.items).toHaveLength(2);
    expect((await call(rw, "set_checkin_schedule", { cadence: "monthly" })).json.cadence).toBe(
      "monthly",
    );
    expect((await call(rw, "mark_notifications_read", { all: true })).json.marked).toBeGreaterThan(
      0,
    );
    const link = await call(rw, "create_share_link", { privacy: "hidden" });
    expect(link.json.path).toMatch(/^\/share\/glideworth_share_/);
    expect((await call(rw, "list_share_links")).json.items).toHaveLength(1);
    expect((await call(rw, "revoke_share_link", { linkId: link.json.link.id })).json.status).toBe(
      "revoked",
    );
  });
});
