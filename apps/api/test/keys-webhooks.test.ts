import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, READ_KEY, setup, WRITE_KEY } from "./helpers.js";

let h: Harness;
afterEach(() => h?.close());
type Key = { id: string; key: string; scopes: string[]; revokedAt: string | null };

describe("API keys", () => {
  it("create / list / revoke with last-used, no escalation, and revoked keys stop working", async () => {
    h = setup();
    const created = await h.call<Key>("/api/v1/keys", {
      method: "POST",
      body: { name: "sim bot", scopes: ["simulate"] },
    });
    expect(created.status).toBe(201);
    const k = created.json;
    expect(k.scopes).toEqual(["simulate"]);
    expect((await h.call("/api/v1/me", { key: k.key })).status).toBe(200);
    const list = await h.call<{ items: (Key & { lastUsedAt: string | null; hash?: string })[] }>(
      "/api/v1/keys",
    );
    const row = list.json.items.find((i) => i.id === k.id)!;
    expect(row.lastUsedAt).toBeTruthy();
    expect(row.hash).toBeUndefined();
    // A read-only key cannot manage keys, and a write key can mint any scope.
    expect((await h.call("/api/v1/keys", { key: READ_KEY })).status).toBe(403);
    expect(
      (
        await h.call("/api/v1/keys", {
          method: "POST",
          key: READ_KEY,
          body: { name: "x", scopes: ["read"] },
        })
      ).status,
    ).toBe(403);
    // A key cannot grant scopes it lacks.
    const writer = await h.call<Key>("/api/v1/keys", {
      method: "POST",
      body: { name: "w", scopes: ["write"] },
    });
    expect(writer.json.scopes).toEqual(["write"]);
    const revoked = await h.call<Key>(`/api/v1/keys/${k.id}`, { method: "DELETE" });
    expect(revoked.json.revokedAt).toBeTruthy();
    expect((await h.call("/api/v1/me", { key: k.key })).status).toBe(401);
    expect((await h.call("/api/v1/keys/nope", { method: "DELETE" })).status).toBe(404);
    expect(
      (await h.call("/api/v1/keys", { method: "POST", body: { name: "x", scopes: ["admin"] } }))
        .status,
    ).toBe(400);
  });

  it("never persists one-time secrets in the idempotency store", async () => {
    h = setup();
    const headers = { "idempotency-key": "same" };
    const a = await h.call<Key>("/api/v1/keys", {
      method: "POST",
      headers,
      body: { name: "a", scopes: ["read"] },
    });
    const b = await h.call<Key>("/api/v1/keys", {
      method: "POST",
      headers,
      body: { name: "a", scopes: ["read"] },
    });
    expect(a.json.key).not.toBe(b.json.key); // not replayed
    const stored = h.ctx.sqlite.prepare("select response from idempotency_keys").all();
    expect(JSON.stringify(stored)).not.toContain(a.json.key.split("_")[2]);
  });

  it("refuses to revoke the last active write key", async () => {
    h = setup();
    // test-write is the only key with write scope.
    const r = await h.call("/api/v1/keys/key_testwrit", { method: "DELETE" });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: { code: "LAST_WRITE_KEY" } });
  });

  it("never logs key material", async () => {
    const logs: string[] = [];
    const orig = [console.log, console.error, console.warn] as [
      typeof console.log,
      typeof console.error,
      typeof console.warn,
    ];
    console.log = console.error = console.warn = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      h = setup();
      await h.call("/api/v1/keys", { method: "POST", body: { name: "z", scopes: ["read"] } });
      await h.call("/api/v1/plans/nope", { key: WRITE_KEY });
      await h.call("/api/v1/plans", { key: `glideworth_badbadba_${"x".repeat(40)}` });
    } finally {
      [console.log, console.error, console.warn] = orig;
    }
    expect(logs.join("\n")).not.toMatch(/(glideworth|cairn)_[a-z0-9]{8}_/);
    expect(logs.join("\n")).not.toContain("0123456789abcdef");
  });
});

describe("webhooks", () => {
  type Call = { url: string; headers: Record<string, string>; body: string };
  function capture(statuses: number[] = []) {
    const calls: Call[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({
        url: String(url),
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        ),
        body: String(init?.body),
      });
      return new Response("ok", { status: statuses.shift() ?? 200 });
    };
    return { calls, fetchFn };
  }
  type Hook = { id: string; secret?: string; events: string[] };

  it("delivers signed plan.updated and snapshot.created payloads that verify with the secret", async () => {
    const cap = capture();
    h = setup({ fetch: cap.fetchFn });
    const hook = await h.call<Hook>("/api/v1/webhooks", {
      method: "POST",
      body: { url: "https://example.test/hook", events: ["plan.updated", "snapshot.created"] },
    });
    expect(hook.status).toBe(201);
    const secret = hook.json.secret!;
    expect(secret).toMatch(/^whsec_/);
    await h.call("/api/v1/plans/plan-main/expenses/exp-living", {
      method: "PATCH",
      body: { name: "new name" },
    });
    await h.call("/api/v1/households/hh-sample/snapshots/record", { method: "POST", body: {} });
    await h.services.webhooks.flush();
    expect(cap.calls.map((c) => JSON.parse(c.body).event).sort()).toEqual([
      "plan.updated",
      "snapshot.created",
    ]);
    for (const c of cap.calls) {
      const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(c.headers["x-glideworth-signature"]!);
      expect(m).toBeTruthy();
      expect(createHmac("sha256", secret).update(`${m![1]}.${c.body}`).digest("hex")).toBe(m![2]);
      expect(c.headers["x-glideworth-event"]).toBeTruthy();
      // Deprecated pre-rename names carry the same values for receivers written before the rename.
      expect(c.headers["x-cairn-signature"]).toBe(c.headers["x-glideworth-signature"]);
      expect(c.headers["x-cairn-event"]).toBe(c.headers["x-glideworth-event"]);
      expect(c.headers["x-cairn-delivery"]).toBe(c.headers["x-glideworth-delivery"]);
    }
    const upd = JSON.parse(
      cap.calls.find((c) => JSON.parse(c.body).event === "plan.updated")!.body,
    );
    expect(upd.data).toMatchObject({ planId: "plan-main", version: 2, change: "updated" });
    const del = await h.call<{ items: { status: string; attempts: number }[] }>(
      `/api/v1/webhooks/${hook.json.id}/deliveries`,
    );
    expect(del.json.items.every((d) => d.status === "succeeded")).toBe(true);
    // The secret is only shown at creation.
    expect((await h.call(`/api/v1/webhooks/${hook.json.id}`)).text).not.toContain(secret);
    expect((await h.call("/api/v1/webhooks")).text).not.toContain(secret);
  });

  it("only sends subscribed events, retries failures, and records a permanent failure", async () => {
    const cap = capture([500, 500, 500]);
    h = setup({ fetch: cap.fetchFn });
    const hook = await h.call<Hook>("/api/v1/webhooks", {
      method: "POST",
      body: { url: "https://hooks.example.test/x", events: ["snapshot.created"] },
    });
    await h.call("/api/v1/plans/plan-main/expenses/exp-living", {
      method: "PATCH",
      body: { name: "n" },
    }); // not subscribed
    await h.services.webhooks.flush();
    expect(cap.calls).toHaveLength(0);
    await h.call("/api/v1/households/hh-sample/snapshots/record", { method: "POST", body: {} });
    await h.services.webhooks.flush();
    expect(cap.calls).toHaveLength(3); // initial + 2 retries (delays [0, 0])
    const del = await h.call<{
      items: { status: string; attempts: number; lastStatusCode: number }[];
    }>(`/api/v1/webhooks/${hook.json.id}/deliveries`);
    expect(del.json.items[0]).toMatchObject({ status: "failed", attempts: 3, lastStatusCode: 500 });
  });

  it("retry succeeds after a transient failure; simulation.completed fires for jobs; ping works; inactive hooks are skipped", async () => {
    const cap = capture([503]);
    h = setup({ fetch: cap.fetchFn });
    const hook = await h.call<Hook>("/api/v1/webhooks", {
      method: "POST",
      body: { url: "https://example.test/h", events: ["simulation.completed"] },
    });
    const job = await h.call<{ id: string }>("/api/v1/plans/plan-main/historical?wait=5", {
      method: "POST",
      body: {},
    });
    await h.services.jobs.waitFor(job.json.id, 5000);
    await h.services.webhooks.flush();
    const events = cap.calls.map((c) => JSON.parse(c.body));
    expect(events.length).toBe(2); // 503 then success
    expect(events[0]).toMatchObject({
      event: "simulation.completed",
      data: { kind: "historical", planId: "plan-main" },
    });
    expect((await h.call(`/api/v1/webhooks/${hook.json.id}/ping`, { method: "POST" })).status).toBe(
      202,
    );
    await h.services.webhooks.flush();
    expect(JSON.parse(cap.calls.at(-1)!.body).event).toBe("webhook.ping");
    await h.call(`/api/v1/webhooks/${hook.json.id}`, { method: "PATCH", body: { active: false } });
    const n = cap.calls.length;
    await h.call("/api/v1/plans/plan-main/historical?wait=5", {
      method: "POST",
      body: { startYears: [1990] },
    });
    await h.services.webhooks.flush();
    expect(cap.calls.length).toBe(n);
    expect((await h.call(`/api/v1/webhooks/${hook.json.id}`, { method: "DELETE" })).status).toBe(
      204,
    );
  });

  it("validates urls and event names; webhooks need write scope", async () => {
    h = setup();
    expect(
      (
        await h.call("/api/v1/webhooks", {
          method: "POST",
          body: { url: "ftp://x/y", events: ["plan.updated"] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.call("/api/v1/webhooks", {
          method: "POST",
          body: { url: "https://x.test", events: ["nope"] },
        })
      ).status,
    ).toBe(400);
    expect((await h.call("/api/v1/webhooks", { key: READ_KEY })).status).toBe(403);
  });
});
