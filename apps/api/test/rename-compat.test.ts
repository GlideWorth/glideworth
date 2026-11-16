/**
 * Upgrading from Cairn: credentials, cookies, share links and export files created before the rename keep
 * working, and everything new is issued under the Glideworth names.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey, insertKey } from "../src/auth.js";
import { browser } from "./browser.js";
import { type Harness, setup } from "./helpers.js";

let h: Harness;
afterEach(() => h?.close());
const PASS = "correct horse battery staple";
const A = "/api/v1/auth";

describe("API keys", () => {
  it("a key minted before the rename (cairn_<prefix>_<secret>) still authenticates; new keys are glideworth_", async () => {
    h = setup();
    const old = "cairn_oldkey01_0123456789abcdefABCDEF0123456789ab";
    insertKey(h.ctx.db, old, "pre-rename", ["read"]);
    expect((await h.call("/api/v1/plans", { key: old })).status).toBe(200);
    expect((await h.call("/api/v1/plans", { key: `${old}x` })).status).toBe(401);
    expect(generateKey().key).toMatch(/^glideworth_[a-z0-9]{8}_[A-Za-z0-9]{32,}$/);
    const created = await h.call("/api/v1/keys", {
      method: "POST",
      body: { name: "new", scopes: ["read"] },
    });
    expect(created.status).toBe(201);
    expect(created.json.key).toMatch(/^glideworth_/);
  });
});

describe("browser sessions", () => {
  it("a session cookie set before the rename (cairn_session) is accepted and moved to the new cookie names", async () => {
    h = setup();
    await h.services.auth.setup(PASS, undefined);
    const login = browser(h.app);
    expect(
      (await login.req(`${A}/login`, { method: "POST", body: { passphrase: PASS } })).status,
    ).toBe(200);
    const token = login.jar.get("glideworth_session")!;
    const csrf = login.csrf()!;

    // A browser that signed in on the old build carries the old cookie names.
    const old = browser(h.app);
    old.jar.set("cairn_session", token);
    old.jar.set("cairn_csrf", csrf);
    expect((await old.req("/api/v1/plans")).status).toBe(200);
    const write = await old.req("/api/v1/plans/plan-main/expenses/exp-living", {
      method: "PATCH",
      body: { name: "Living (renamed)" },
      headers: { "x-csrf-token": csrf },
    });
    expect(write.status).toBe(200);

    const status = await old.req(`${A}/status`);
    expect(status.json).toMatchObject({ authenticated: true, via: "session", csrfToken: csrf });
    expect(old.jar.get("glideworth_session")).toBe(token);
    expect(old.jar.get("glideworth_csrf")).toBe(csrf);
    expect(old.jar.has("cairn_session")).toBe(false);
    expect(old.jar.has("cairn_csrf")).toBe(false);
    expect((await old.req("/api/v1/plans")).status).toBe(200);

    // Logging out clears the old names too.
    const again = browser(h.app);
    again.jar.set("cairn_session", token);
    again.jar.set("cairn_csrf", csrf);
    expect(
      (await again.req(`${A}/logout`, { method: "POST", headers: { "x-csrf-token": csrf } }))
        .status,
    ).toBe(204);
    expect(
      (await h.app.request("/api/v1/plans", { headers: { cookie: `cairn_session=${token}` } }))
        .status,
    ).toBe(401);
  });
});

describe("share links", () => {
  it("a link shared before the rename (cairn_share_…) still opens; new links are glideworth_share_", async () => {
    h = setup();
    const c = await h.call("/api/v1/plans/plan-main/share-links", {
      method: "POST",
      body: { includeSuccessRate: false },
    });
    expect(c.status).toBe(201);
    expect(c.json.token).toMatch(/^glideworth_share_/);
    // Re-key the stored link as if the old build had issued it.
    const old = `cairn_share_${c.json.token.slice("glideworth_share_".length)}`;
    const hash = createHash("sha256").update(`cairn-share:${old}`).digest("hex");
    h.ctx.sqlite
      .prepare("update share_links set token_hash = ? where id = ?")
      .run(hash, c.json.link.id);
    const r = await h.call(`/api/v1/shared/${old}`, { key: null });
    expect(r.status).toBe(200);
    expect(r.json.kind).toBe("glideworth-shared-plan");
  });
});

describe("export files", () => {
  it('imports a workspace exported before the rename (app: "cairn"), auto-detected or named either way', async () => {
    h = setup();
    const exported = await h.call("/api/v1/households/hh-sample/export");
    expect(exported.json.app).toBe("glideworth");
    expect(exported.headers.get("content-disposition")).toContain("glideworth-hh-sample.json");
    const legacy = { ...exported.json, app: "cairn" };
    for (const format of [undefined, "glideworth", "cairn"]) {
      const r = await h.call("/api/v1/import", {
        method: "POST",
        body: { data: legacy, dryRun: true, ...(format ? { format } : {}) },
      });
      expect(r.status, r.text).toBe(200);
      expect(r.json).toMatchObject({ imported: false, stats: { plans: 2 } });
    }
    const replaced = await h.call("/api/v1/import", {
      method: "POST",
      body: { data: legacy, mode: "replace" },
    });
    expect(replaced.json).toMatchObject({ imported: true, householdId: "hh-sample" });
    expect((await h.call("/api/v1/households/hh-sample/export")).json.app).toBe("glideworth");
  });
});
