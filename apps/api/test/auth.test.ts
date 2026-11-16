/**
 * Browser authentication: first-run setup, login, httpOnly SameSite=Strict session cookie, logout,
 * expiry, CSRF for cookie-authenticated writes, scrypt hashing, login throttling, and API keys
 * continuing to work. Plus static serving of the built web app with SPA fallback.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassphrase, verifyPassphrase } from "../src/services/auth.js";
import { type Harness, setup, WRITE_KEY } from "./helpers.js";

let h: Harness;
afterEach(() => h?.close());
const PASS = "correct horse battery staple";
const A = "/api/v1/auth";

/** A minimal cookie jar over app.request, the way a browser would behave. */
function browser(app: Harness["app"], opts: { origin?: string } = {}) {
  const jar = new Map<string, string>();
  const raw: string[] = [];
  async function req(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (opts.origin && init.method && init.method !== "GET") headers.origin = opts.origin;
    const res = await app.request(path, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    for (const c of res.headers.getSetCookie()) {
      raw.push(c);
      const [pair] = c.split(";");
      const [k, ...v] = pair!.split("=");
      const value = v.join("=");
      if (/max-age=0/i.test(c) || value === "") jar.delete(k!);
      else jar.set(k!, value);
    }
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      json: text ? JSON.parse(text) : undefined,
      text,
    };
  }
  return { req, jar, raw, csrf: () => jar.get("glideworth_csrf") };
}

describe("hashing", () => {
  it("uses salted scrypt and verifies in constant time", async () => {
    const a = await hashPassphrase(PASS);
    const b = await hashPassphrase(PASS);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(a).not.toBe(b); // random salt
    expect(await verifyPassphrase(PASS, a)).toBe(true);
    expect(await verifyPassphrase("wrong", a)).toBe(false);
    expect(await verifyPassphrase(PASS, "garbage")).toBe(false);
  });
});

describe("first-run setup, login and logout", () => {
  it("reports setupRequired, accepts the first passphrase once, then requires login", async () => {
    h = setup();
    const b = browser(h.app);
    expect((await b.req(`${A}/status`)).json).toEqual({
      setupRequired: true,
      setupTokenRequired: false,
      multiUser: false,
      authenticated: false,
    });
    expect((await b.req("/api/v1/plans")).status).toBe(401);

    expect(
      (await b.req(`${A}/setup`, { method: "POST", body: { passphrase: "short" } })).status,
    ).toBe(400);
    const setupRes = await b.req(`${A}/setup`, { method: "POST", body: { passphrase: PASS } });
    expect(setupRes.status).toBe(201);
    expect(setupRes.json.csrfToken).toBeTruthy();
    // Signed in straight away.
    expect((await b.req(`${A}/status`)).json).toMatchObject({
      setupRequired: false,
      authenticated: true,
      via: "session",
    });
    expect((await b.req("/api/v1/plans")).status).toBe(200);

    // A second setup is refused, and the stored value is a scrypt hash, never the passphrase.
    const again = await browser(h.app).req(`${A}/setup`, {
      method: "POST",
      body: { passphrase: "another passphrase here" },
    });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("ALREADY_CONFIGURED");
    const row = h.ctx.sqlite.prepare("select hash from auth_credentials").get() as { hash: string };
    expect(row.hash).toMatch(/^scrypt\$/);
    expect(row.hash).not.toContain(PASS);
  });

  it("can require a setup token so a stranger cannot claim a fresh instance", async () => {
    h = setup({ auth: { setupToken: "let-me-in-please" } });
    const b = browser(h.app);
    expect((await b.req(`${A}/setup`, { method: "POST", body: { passphrase: PASS } })).status).toBe(
      403,
    );
    expect(
      (
        await b.req(`${A}/setup`, {
          method: "POST",
          body: { passphrase: PASS, setupToken: "wrong-token" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await b.req(`${A}/setup`, {
          method: "POST",
          body: { passphrase: PASS, setupToken: "let-me-in-please" },
        })
      ).status,
    ).toBe(201);
  });

  it("login issues an httpOnly, SameSite=Strict session cookie; the secret is stored only as a hash", async () => {
    h = setup();
    await h.services.auth.setup(PASS, undefined);
    const b = browser(h.app);
    expect(
      (await b.req(`${A}/login`, { method: "POST", body: { passphrase: "nope nope nope nope" } }))
        .status,
    ).toBe(401);
    const ok = await b.req(`${A}/login`, { method: "POST", body: { passphrase: PASS } });
    expect(ok.status).toBe(200);
    const session = b.raw.find((c) => c.startsWith("glideworth_session="))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Strict/i);
    expect(session).toMatch(/Path=\//);
    expect(session).toMatch(/Max-Age=\d+/i);
    const csrf = b.raw.find((c) => c.startsWith("glideworth_csrf="))!;
    expect(csrf).not.toMatch(/HttpOnly/i); // the web app must be able to read it
    expect(csrf).toMatch(/SameSite=Strict/i);
    const token = b.jar.get("glideworth_session")!;
    const stored = h.ctx.sqlite.prepare("select id from auth_sessions").all() as { id: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).not.toContain(token);
  });

  it("marks cookies Secure over https (or X-Forwarded-Proto)", async () => {
    h = setup();
    await h.services.auth.setup(PASS, undefined);
    const res = await h.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ passphrase: PASS }),
    });
    expect(res.headers.getSetCookie().every((c) => /Secure/i.test(c))).toBe(true);
    const plain = await h.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: PASS }),
    });
    expect(plain.headers.getSetCookie().some((c) => /Secure/i.test(c))).toBe(false);
  });

  it("logout ends the session server-side and clears the cookies", async () => {
    h = setup();
    await h.services.auth.setup(PASS, undefined);
    const b = browser(h.app);
    await b.req(`${A}/login`, { method: "POST", body: { passphrase: PASS } });
    const stolen = b.jar.get("glideworth_session")!;
    const csrf = b.csrf()!;
    expect((await b.req(`${A}/logout`, { method: "POST" })).status).toBe(403); // CSRF header missing
    expect(
      (await b.req(`${A}/logout`, { method: "POST", headers: { "x-csrf-token": csrf } })).status,
    ).toBe(204);
    expect(b.jar.has("glideworth_session")).toBe(false);
    // The old cookie is dead even if someone kept a copy.
    const replay = await h.app.request("/api/v1/plans", {
      headers: { cookie: `glideworth_session=${stolen}` },
    });
    expect(replay.status).toBe(401);
  });

  it("changing the passphrase signs out every other session", async () => {
    h = setup();
    await h.services.auth.setup(PASS, undefined);
    const a = browser(h.app);
    const other = browser(h.app);
    await a.req(`${A}/login`, { method: "POST", body: { passphrase: PASS } });
    await other.req(`${A}/login`, { method: "POST", body: { passphrase: PASS } });
    const r = await a.req(`${A}/change-passphrase`, {
      method: "POST",
      headers: { "x-csrf-token": a.csrf()! },
      body: { current: PASS, next: "a brand new passphrase!" },
    });
    expect(r.status).toBe(200);
    expect((await other.req("/api/v1/plans")).status).toBe(401);
    expect((await a.req("/api/v1/plans")).status).toBe(200); // the caller got a fresh session
    expect(
      (await browser(h.app).req(`${A}/login`, { method: "POST", body: { passphrase: PASS } }))
        .status,
    ).toBe(401);
  });
});

describe("session expiry", () => {
  it("expires after the absolute lifetime and after the idle timeout", async () => {
    let now = Date.now();
    h = setup({ auth: { now: () => now, sessionTtlMs: 3600_000, sessionIdleMs: 600_000 } });
    await h.services.auth.setup(PASS, undefined);
    const b = browser(h.app);
    await b.req(`${A}/login`, { method: "POST", body: { passphrase: PASS } });
    expect((await b.req("/api/v1/plans")).status).toBe(200);
    now += 5 * 60_000;
    expect((await b.req("/api/v1/plans")).status).toBe(200); // used within the idle window: stays alive
    now += 11 * 60_000;
    expect((await b.req("/api/v1/plans")).status).toBe(401); // idle too long
    expect(h.ctx.sqlite.prepare("select count(*) as n from auth_sessions").get()).toEqual({ n: 0 });

    await b.req(`${A}/login`, { method: "POST", body: { passphrase: PASS } });
    for (let i = 0; i < 6; i++) {
      now += 9 * 60_000; // always within the idle window (54 min in total)...
      expect((await b.req("/api/v1/plans")).status).toBe(200);
    }
    now += 9 * 60_000; // ...but never beyond the absolute lifetime (1 h)
    expect((await b.req("/api/v1/plans")).status).toBe(401);
  });
});

describe("CSRF protection for cookie-authenticated writes", () => {
  async function signedIn(origin?: string) {
    h = setup();
    await h.services.auth.setup(PASS, undefined);
    const b = browser(h.app, origin ? { origin } : {});
    await b.req(`${A}/login`, { method: "POST", body: { passphrase: PASS } });
    return b;
  }

  it("rejects a write without the token, with a wrong token, or from another origin; reads need no token", async () => {
    const b = await signedIn();
    const write = { method: "PATCH", body: { name: "x" } };
    const url = "/api/v1/plans/plan-main/expenses/exp-living";
    expect((await b.req(url)).status).toBe(200);
    const none = await b.req(url, write);
    expect(none.status).toBe(403);
    expect(none.json.error.code).toBe("CSRF");
    expect(
      (await b.req(url, { ...write, headers: { "x-csrf-token": "wrong-token" } })).status,
    ).toBe(403);
    expect((await b.req(url, { ...write, headers: { "x-csrf-token": b.csrf()! } })).status).toBe(
      200,
    );
    const cross = await b.req(url, {
      ...write,
      headers: { "x-csrf-token": b.csrf()!, origin: "https://evil.example" },
    });
    expect(cross.status).toBe(403);
    const same = await b.req(url, {
      ...write,
      headers: { "x-csrf-token": b.csrf()!, origin: "http://localhost", host: "localhost" },
    });
    expect(same.status).toBe(200);
  });

  it("cookie sessions can use every scope (the single owner), attributed to the web app in plan history", async () => {
    const b = await signedIn();
    const r = await b.req("/api/v1/plans/plan-main/expenses/exp-living", {
      method: "PATCH",
      headers: { "x-csrf-token": b.csrf()! },
      body: { name: "by browser" },
    });
    expect(r.status).toBe(200);
    const versions = await b.req("/api/v1/plans/plan-main/versions");
    expect(versions.json.items[0].actor).toMatchObject({ kind: "user", label: "Owner" });
  });

  it("cookie-authenticated login/setup also refuse a foreign Origin", async () => {
    h = setup();
    const res = await h.app.request(`${A}/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ passphrase: PASS }),
    });
    expect(res.status).toBe(403);
  });
});

describe("login rate limiting", () => {
  it("blocks a client after repeated failures (429 + Retry-After), also for the right passphrase, until the window passes", async () => {
    let now = Date.now();
    h = setup({ auth: { now: () => now, maxFailedLogins: 3, loginWindowMs: 600_000 } });
    await h.services.auth.setup(PASS, undefined);
    const b = browser(h.app);
    for (let i = 0; i < 3; i++)
      expect(
        (
          await b.req(`${A}/login`, {
            method: "POST",
            body: { passphrase: `wrong passphrase ${i}!` },
          })
        ).status,
      ).toBe(401);
    const blocked = await b.req(`${A}/login`, { method: "POST", body: { passphrase: PASS } });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    now += 601_000;
    expect((await b.req(`${A}/login`, { method: "POST", body: { passphrase: PASS } })).status).toBe(
      200,
    );
  });

  it("a successful login clears the failure count; a global cap stops distributed guessing", async () => {
    h = setup({ auth: { maxFailedLogins: 2, maxFailedLoginsGlobal: 4 } });
    await h.services.auth.setup(PASS, undefined);
    const attempt = (client: string, p: string) =>
      h.services.auth.login(p, client).then(
        () => "ok",
        (e: { status: number }) => e.status,
      );
    expect(await attempt("1.1.1.1", "wrong one one one")).toBe(401);
    expect(await attempt("1.1.1.1", PASS)).toBe("ok"); // cleared
    expect(await attempt("1.1.1.1", "wrong one one one")).toBe(401);
    expect(await attempt("2.2.2.2", "wrong two two two")).toBe(401);
    expect(await attempt("3.3.3.3", "wrong three three")).toBe(401);
    expect(await attempt("4.4.4.4", PASS)).toBe(429); // global cap reached (4 failures in the window)
  });
});

describe("API keys keep working", () => {
  it("bearer keys authenticate with or without browser auth, need no CSRF token, and ignore cookies on /mcp", async () => {
    h = setup();
    await h.services.auth.setup(PASS, undefined);
    expect((await h.call("/api/v1/plans")).status).toBe(200);
    const write = await h.call("/api/v1/plans/plan-main/expenses/exp-living", {
      method: "PATCH",
      body: { name: "by key" },
    });
    expect(write.status).toBe(200);
    expect((await h.call(`${A}/status`)).json).toMatchObject({
      authenticated: true,
      via: "key",
      setupRequired: false,
    });
    expect((await h.call("/api/v1/me")).json).toMatchObject({ via: "key" });
    // A bad key is a 401 even if a valid session cookie is also sent.
    const b = browser(h.app);
    await b.req(`${A}/login`, { method: "POST", body: { passphrase: PASS } });
    const bad = await h.app.request("/api/v1/plans", {
      headers: {
        authorization: "Bearer glideworth_nope0000_0123456789abcdef0123456789abcdef",
        cookie: `glideworth_session=${b.jar.get("glideworth_session")}`,
      },
    });
    expect(bad.status).toBe(401);
    // MCP is bearer-only: the session cookie is not accepted there.
    const mcp = await h.app.request("/mcp", {
      method: "POST",
      headers: {
        cookie: `glideworth_session=${b.jar.get("glideworth_session")}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(401);
    void WRITE_KEY;
  });

  it("browser auth can be switched off entirely (keys only)", async () => {
    h = setup({ appOptions: { browserAuth: false } });
    expect((await h.call(`${A}/status`, { key: null })).status).toBe(401);
    expect((await h.call("/api/v1/plans")).status).toBe(200);
  });
});

describe("serving the built web app (one process, one port)", () => {
  function distDir() {
    const dir = mkdtempSync(join(tmpdir(), "glideworth-web-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(
      join(dir, "index.html"),
      '<!doctype html><title>Glideworth</title><div id="root"></div>',
    );
    writeFileSync(join(dir, "assets", "app-abc123.js"), 'console.log("app")');
    writeFileSync(join(dir, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    return dir;
  }

  it("serves index.html, hashed assets with long-lived caching, and falls back to index.html for client routes", async () => {
    h = setup({ appOptions: { webDist: distDir() } });
    const root = await h.call("/", { key: null });
    expect(root.status).toBe(200);
    expect(root.text).toContain('<div id="root">');
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(root.headers.get("cache-control")).toBe("no-cache");
    const spa = await h.call("/plans/plan-main/edit", { key: null });
    expect(spa.text).toContain('<div id="root">');
    const asset = await h.call("/assets/app-abc123.js", { key: null });
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await h.call("/favicon.svg", { key: null })).headers.get("content-type")).toBe(
      "image/svg+xml",
    );
    expect(root.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers conditional requests with 304 and 404s a missing asset instead of serving the shell", async () => {
    h = setup({ appOptions: { webDist: distDir() } });
    const first = await h.call("/assets/app-abc123.js", { key: null });
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    expect(
      (await h.call("/assets/app-abc123.js", { key: null, headers: { "if-none-match": etag } }))
        .status,
    ).toBe(304);
    expect((await h.call("/assets/missing.js", { key: null })).status).toBe(404);
  });

  it("never shadows the API: /health, /openapi.json, /docs, /mcp and unknown /api paths keep their own behaviour", async () => {
    h = setup({ appOptions: { webDist: distDir() } });
    expect((await h.call("/health", { key: null })).json).toMatchObject({ status: "ok" });
    expect((await h.call("/openapi.json", { key: null })).json.openapi).toBe("3.1.0");
    expect((await h.call("/docs", { key: null })).text).toContain("html");
    const unknown = await h.call("/api/v1/nope", { key: null });
    expect(unknown.status).toBe(401); // auth first, never the SPA shell
    const unknownAuthed = await h.call("/api/v1/nope");
    expect(unknownAuthed.status).toBe(404);
    expect(unknownAuthed.json.error.code).toBe("NOT_FOUND");
    expect((await h.call("/mcp", { key: null, method: "POST", body: {} })).status).toBe(401);
  });

  it("cannot be tricked into reading files outside the web directory", async () => {
    h = setup({ appOptions: { webDist: distDir() } });
    for (const p of [
      "/../package.json",
      "/..%2fpackage.json",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/assets/../../x.js",
    ]) {
      const r = await h.call(p, { key: null });
      expect([200, 400, 404]).toContain(r.status);
      expect(r.text).not.toContain('"name"');
      expect(r.text).not.toContain("root:");
    }
  });

  it("is off unless a directory is given", async () => {
    h = setup();
    const r = await h.call("/", { key: null });
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("NOT_FOUND");
  });
});
