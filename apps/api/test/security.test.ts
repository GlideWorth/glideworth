/**
 * Security regression tests: SSRF guard for webhooks, request-size limit, login/setup throttling
 * (including parallel guesses), scope enforcement on EVERY route, error-message hygiene, CORS and
 * response hardening headers.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { ensureBootstrapKey, PUBLIC_EXAMPLE_KEY } from "../src/auth.js";
import { openDb } from "../src/db/client.js";
import { toErrorResponse } from "../src/errors.js";
import { isPrivateAddress, safeDeliver, webhookUrlProblem } from "../src/security.js";
import { type Harness, READ_KEY, SIM_KEY, setup } from "./helpers.js";

let h: Harness;
afterEach(() => h?.close());

describe("SSRF guard", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a00:1",
    "64:ff9b::7f00:1",
    "2001:db8::1",
  ])("treats %s as private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.0.1",
    "172.32.0.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
  ])("treats %s as public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it.each([
    "http://127.0.0.1/x",
    "http://localhost:3000/x",
    "http://app.localhost/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/x",
    "http://[::ffff:127.0.0.1]/x",
    "http://2130706433/x", // 127.0.0.1 as one decimal number
    "http://0x7f.1/x",
    "http://10.1.2.3/x",
    "http://metadata.google.internal/x",
    "http://printer.local/x",
    "ftp://example.com/x",
    "file:///etc/passwd",
    "https://user:pw@example.com/x",
    "not a url",
  ])("rejects the webhook URL %s", async (url) => {
    h = setup();
    const r = await h.call("/api/v1/webhooks", {
      method: "POST",
      body: { url, events: ["plan.updated"] },
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("VALIDATION");
  });

  it("accepts a public https URL and lets the operator opt in to private ones", async () => {
    h = setup();
    const ok = await h.call("/api/v1/webhooks", {
      method: "POST",
      body: { url: "https://hooks.example.com/glideworth", events: ["plan.updated"] },
    });
    expect(ok.status).toBe(201);
    h.close();
    h = setup({ webhooks: { allowPrivate: true } });
    const priv = await h.call("/api/v1/webhooks", {
      method: "POST",
      body: { url: "http://127.0.0.1:9999/hook", events: ["plan.updated"] },
    });
    expect(priv.status).toBe(201);
    expect(webhookUrlProblem("http://127.0.0.1/x", false)).toMatch(/private/);
    expect(webhookUrlProblem("http://127.0.0.1/x", true)).toBeNull();
  });

  it("hosted mode takes https only, on port 443 or 1024 and above (security review finding 14)", async () => {
    h = setup({ webhooks: { httpsOnly: true } });
    const make = (url: string) =>
      h.call("/api/v1/webhooks", { method: "POST", body: { url, events: ["plan.updated"] } });
    for (const url of [
      "http://hooks.example.com/glideworth",
      "https://hooks.example.com:22/x",
      "https://hooks.example.com:80/x",
      "https://hooks.example.com:1023/x",
    ]) {
      const r = await make(url);
      expect(r.status, url).toBe(400);
      expect(r.json.error.code).toBe("VALIDATION");
    }
    for (const url of [
      "https://hooks.example.com/glideworth",
      "https://hooks.example.com:443/x",
      "https://hooks.example.com:8443/x",
    ])
      expect((await make(url)).status, url).toBe(201);
    // Changing an existing subscription to plain http is refused too.
    const list = await h.call<{ items: Array<{ id: string }> }>("/api/v1/webhooks");
    const id = list.json.items[0]?.id as string;
    const patch = await h.call(`/api/v1/webhooks/${id}`, {
      method: "PATCH",
      body: { url: "http://hooks.example.com/x" },
    });
    expect(patch.status).toBe(400);
    // Self-host keeps accepting http (a receiver on the same network).
    expect(webhookUrlProblem("http://hooks.example.com:80/x", false)).toBeNull();
  });

  it("blocks a private destination at connection time, by literal IP and by DNS name, unless allowed", async () => {
    let hits = 0;
    const srv = createServer((_req, res) => {
      hits++;
      res.end("ok");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const init = {
      method: "POST" as const,
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    };
    try {
      const guarded = safeDeliver({ allowPrivate: false });
      await expect(guarded(`http://127.0.0.1:${port}/`, init)).rejects.toThrow(/blocked/);
      // `localhost` is a DNS name: it passes the syntactic check but resolves to loopback.
      await expect(guarded(`http://localhost:${port}/`, init)).rejects.toThrow(/blocked/);
      expect(hits).toBe(0);
      const open = safeDeliver({ allowPrivate: true });
      const res = await open(`http://127.0.0.1:${port}/`, init);
      expect(res).toEqual({ status: 200, ok: true });
      expect(hits).toBe(1);
    } finally {
      srv.close();
    }
  });

  it("does not follow redirects", async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/" });
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    try {
      const res = await safeDeliver({ allowPrivate: true })(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {},
        body: "{}",
        signal: AbortSignal.timeout(5000),
      });
      expect(res).toEqual({ status: 302, ok: false });
    } finally {
      srv.close();
    }
  });
});

describe("request size limit", () => {
  it("answers 413 with a JSON error beyond the configured body size", async () => {
    h = setup({ appOptions: { maxBodyBytes: 2048 } });
    const big = { summary: "x".repeat(5000), ops: [] };
    const r = await h.call("/api/v1/plans/plan-main/change-sets", { method: "POST", body: big });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("PAYLOAD_TOO_LARGE");
    const mcp = await h.app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${READ_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ pad: "y".repeat(5000) }),
    });
    expect(mcp.status).toBe(413);
  });

  it("lets normal requests through", async () => {
    h = setup({ appOptions: { maxBodyBytes: 4096 } });
    expect((await h.call("/api/v1/plans")).status).toBe(200);
  });
});

describe("login and setup throttling", () => {
  const PASS = "correct horse battery staple";
  it("counts parallel wrong guesses, so a burst cannot slip past the limit while hashing", async () => {
    h = setup({ auth: { maxFailedLogins: 5 } });
    await h.app.request("/api/v1/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: PASS }),
    });
    const attempt = () =>
      h.app.request("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: "definitely wrong guess" }),
      });
    const codes = (await Promise.all(Array.from({ length: 15 }, attempt))).map((r) => r.status);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(5);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(10);
  });

  it("throttles wrong setup tokens and advertises that a token is required", async () => {
    h = setup({ auth: { setupToken: "right-token-123", maxFailedLogins: 3 } });
    const status = await h.app.request("/api/v1/auth/status");
    expect(await status.json()).toMatchObject({ setupRequired: true, setupTokenRequired: true });
    const post = (token: string) =>
      h.app.request("/api/v1/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: PASS, setupToken: token }),
      });
    expect([(await post("a")).status, (await post("b")).status, (await post("c")).status]).toEqual([
      403, 403, 403,
    ]);
    // Even the right token is refused until the window passes: guessing the token online is not viable.
    expect((await post("right-token-123")).status).toBe(429);
  });

  it("throttles guesses of the current passphrase on change-passphrase", async () => {
    h = setup({ auth: { maxFailedLogins: 3 } });
    await h.app.request("/api/v1/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: PASS }),
    });
    const change = (current: string) =>
      h.call("/api/v1/auth/change-passphrase", {
        method: "POST",
        body: { current, next: "another long passphrase" },
      });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await change(`wrong guess number ${i}`)).status);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });
});

describe("scope enforcement on every route", () => {
  it("rejects a read key on every write route and a simulate-only key on every read route", async () => {
    h = setup();
    const doc = (await (await h.app.request("/openapi.json")).json()) as {
      paths: Record<string, Record<string, { "x-required-scope"?: string; security?: unknown[] }>>;
    };
    const failures: string[] = [];
    let checked = 0;
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        const need = op["x-required-scope"];
        if (path.startsWith("/api/v1/auth/") || path.startsWith("/api/v1/shared/")) continue; // public: the route authenticates itself
        if (!need) {
          failures.push(`${method.toUpperCase()} ${path}: no x-required-scope`);
          continue;
        }
        const url = path.replace(/\{[^}]+\}/g, "x");
        const send = (key: string | null) =>
          h.app.request(url, {
            method: method.toUpperCase(),
            headers: {
              ...(key ? { authorization: `Bearer ${key}` } : {}),
              "content-type": "application/json",
            },
            ...(method === "get" || method === "delete" ? {} : { body: "{}" }),
          });
        checked++;
        const anon = await send(null);
        if (anon.status !== 401)
          failures.push(`${method.toUpperCase()} ${path}: anonymous got ${anon.status}`);
        if (need === "write") {
          const r = await send(READ_KEY);
          if (r.status !== 403)
            failures.push(`${method.toUpperCase()} ${path}: read key got ${r.status}`);
          const s = await send(SIM_KEY);
          if (s.status !== 403)
            failures.push(`${method.toUpperCase()} ${path}: simulate key got ${s.status}`);
        }
        if (need === "read") {
          const s = await send(SIM_KEY);
          if (s.status !== 403)
            failures.push(`${method.toUpperCase()} ${path}: simulate key got ${s.status}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(150);
    expect(failures).toEqual([]);
  });

  it("keeps cookies out of /mcp and out of API-key-only operations", async () => {
    h = setup();
    const r = await h.app.request("/mcp", {
      method: "POST",
      headers: { cookie: "glideworth_session=abc" },
    });
    expect(r.status).toBe(401);
  });
});

describe("error hygiene", () => {
  it("does not echo driver or runtime errors that happen to carry an UPPER_CASE code", async () => {
    const app = new Hono();
    app.onError((e, c) => toErrorResponse(e, c));
    app.get("/sqlite", () => {
      throw Object.assign(
        new Error("UNIQUE constraint failed: plans.id at /Users/me/glideworth.db"),
        {
          name: "SqliteError",
          code: "SQLITE_CONSTRAINT_PRIMARYKEY",
        },
      );
    });
    app.get("/type", () => {
      throw Object.assign(new TypeError("Invalid arg /etc/secret"), {
        code: "ERR_INVALID_ARG_TYPE",
      });
    });
    for (const path of ["/sqlite", "/type"]) {
      const res = await app.request(path);
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(text).not.toMatch(/Users|etc\/secret|constraint|SQLITE|ERR_/);
      expect(JSON.parse(text).error.code).toBe("INTERNAL");
    }
  });

  it("answers a malformed body with a clean 400", async () => {
    h = setup();
    const r = await h.call("/api/v1/plans/plan-main/change-sets", {
      method: "POST",
      body: "{nope",
    });
    expect(r.status).toBe(400);
    expect(r.text).not.toMatch(/at \w+|node_modules|\.ts:/);
  });
});

describe("CORS and response headers", () => {
  it("allows only the configured browser origin, and none when it is unset", async () => {
    h = setup({ appOptions: { webOrigin: "http://localhost:5173" } });
    const good = await h.app.request("/health", { headers: { origin: "http://localhost:5173" } });
    expect(good.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const evil = await h.app.request("/health", { headers: { origin: "https://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
    h.close();
    h = setup({ appOptions: { webOrigin: null } });
    const none = await h.app.request("/health", { headers: { origin: "http://localhost:5173" } });
    expect(none.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("marks API responses nosniff and no-store", async () => {
    h = setup();
    const r = await h.call("/api/v1/plans");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("marks every response noindex and serves a disallow-all robots.txt without the web app (issue #20)", async () => {
    h = setup();
    for (const [p, key] of [
      ["/api/v1/plans", undefined],
      ["/api/v1/plans", null],
      ["/no-such-route", null],
    ] as const) {
      const r = await h.call(p, { key });
      expect(r.headers.get("x-robots-tag"), `${p} key=${key}`).toBe("noindex, nofollow");
    }
    const robots = await h.call("/robots.txt", { key: null });
    expect(robots.status).toBe(200);
    expect(robots.text).toBe("User-agent: *\nDisallow: /\n");
  });

  it("has no security.txt: the hosted service's contact is not this instance's operator", async () => {
    h = setup();
    const r = await h.call("/.well-known/security.txt", { key: null });
    expect(r.status).toBe(404);
    expect(r.text).not.toContain("security@glideworth.com");
  });
});

describe("bootstrap key", () => {
  it("refuses the public example key in production but allows it in development", () => {
    const prod = openDb(":memory:");
    expect(ensureBootstrapKey(prod.db, PUBLIC_EXAMPLE_KEY, { production: true })).toBe(
      "refused-example-key",
    );
    // The example key published before the rename is just as public.
    expect(
      ensureBootstrapKey(prod.db, "cairn_devlocal_0123456789abcdef0123456789abcdef", {
        production: true,
      }),
    ).toBe("refused-example-key");
    expect(PUBLIC_EXAMPLE_KEY).toBe("glideworth_devlocal_0123456789abcdef0123456789abcdef");
    expect(
      ensureBootstrapKey(prod.db, "glideworth_mysecret_0123456789abcdef0123456789abcdef", {
        production: true,
      }),
    ).toBe("inserted");
    prod.close();
    const dev = openDb(":memory:");
    expect(ensureBootstrapKey(dev.db, PUBLIC_EXAMPLE_KEY, { production: false })).toBe("inserted");
    expect(ensureBootstrapKey(dev.db, PUBLIC_EXAMPLE_KEY, { production: false })).toBe("skipped"); // keys exist
    dev.close();
  });
});

describe("prototype pollution", () => {
  it("refuses patches and bodies that address Object.prototype, on every entry point", async () => {
    h = setup({ realEngine: true });
    const evil = [
      { op: "add", path: "/__proto__/polluted", value: "yes" },
      { op: "add", path: "/constructor/prototype/polluted", value: "yes" },
      { op: "add", path: "/expenses/[id=exp-living]/__proto__/polluted", value: "yes" },
      { op: "move", from: "/__proto__", path: "/notes" },
    ];
    for (const op of evil) {
      for (const [path, method, body] of [
        ["/api/v1/plans/plan-main/preview", "POST", { ops: [op] }],
        ["/api/v1/plans/plan-main/change-sets", "POST", { summary: "x", ops: [op] }],
        ["/api/v1/plans/plan-main/branches", "POST", { name: "x", patch: [op] }],
        ["/api/v1/plans/plan-main", "PATCH", [op]],
      ] as const) {
        const r = await h.call(path, {
          method,
          body,
          headers: method === "PATCH" ? { "content-type": "application/json-patch+json" } : {},
        });
        expect(r.status, `${method} ${path} ${JSON.stringify(op)}`).toBe(400);
        expect(r.json.error.message).toMatch(/forbidden/);
      }
    }
    const merge = await h.call("/api/v1/plans/plan-main/expenses/exp-living", {
      method: "PATCH",
      body: '{"__proto__":{"polluted":"yes"},"name":"X"}',
    });
    expect(merge.status).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Legitimate edits still work.
    const ok = await h.call("/api/v1/plans/plan-main/preview", {
      method: "POST",
      body: {
        ops: [{ op: "replace", path: "/expenses/[id=exp-living]/amount/value", value: 5000 }],
      },
    });
    expect(ok.status).toBe(200);
  });

  it("a key spelled with JSON escapes is refused at the door too (security review finding 12)", async () => {
    h = setup();
    for (const key of ["\\u005f_proto__", "__pro\\u0074o__", "\\u0063onstructor"]) {
      const r = await h.call("/api/v1/plans/plan-main/expenses/exp-living", {
        method: "PATCH",
        body: `{"${key}":{"polluted":"yes"},"name":"X"}`,
      });
      expect(r.status, key).toBe(400);
      expect(r.json.error.message).toMatch(/forbidden key/);
    }
    // An escape in an ordinary value is fine.
    const ok = await h.call("/api/v1/plans/plan-main/expenses/exp-living", {
      method: "PATCH",
      body: '{"name":"Living \\u00e9"}',
    });
    expect(ok.status, ok.text).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("mergePatch never follows a __proto__ key", async () => {
    const { mergePatch } = await import("../src/util.js");
    const out = mergePatch(
      { a: 1 },
      JSON.parse('{"__proto__":{"polluted":"yes"},"b":2}'),
    ) as Record<string, unknown>;
    expect(out).toEqual({ a: 1, b: 2 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
