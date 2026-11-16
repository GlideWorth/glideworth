/**
 * T-ISO at the level of `tenantAuth` + registry (spec 10): two workspaces A and B in real SQLite files, every
 * credential kind, crossed between them. A credential is either accepted in exactly the tenant it was minted
 * for, or refused with the same 401 body as a credential that never existed.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accounts, sessions } from "../src/control/schema.js";
import { sha256Hex } from "../src/crypto/random.js";
import { mintRouted } from "../src/crypto/routed.js";
import { UNAUTHORIZED_BODY } from "../src/http/tenant-auth.js";
import {
  Browser,
  type Cloud,
  type FakeRuntime,
  makeCloud,
  mintKeyIn,
  mintOauthIn,
  PUBLIC_URL,
  removeTempDirs,
  SENTINEL_AMOUNT,
  SENTINEL_HOUSEHOLD,
  signedUpBrowser,
  uniqueEmail,
} from "./cloud-fixture.js";
import { remember } from "./helpers.js";

let cloud: Cloud;
let A: Awaited<ReturnType<typeof signedUpBrowser>>;
let B: Awaited<ReturnType<typeof signedUpBrowser>>;
const ids = () => ({ a: A.accountId as string, b: B.accountId as string });

async function runtimeOf(id: string): Promise<FakeRuntime> {
  return cloud.registry.with(id, (r) => r as FakeRuntime);
}

beforeEach(async () => {
  cloud = await makeCloud();
  A = await signedUpBrowser(cloud, { name: "Ann A" });
  B = await signedUpBrowser(cloud, { name: "Bob B" });
  (await runtimeOf(ids().a)).addHousehold("hh_a", SENTINEL_HOUSEHOLD, Number(SENTINEL_AMOUNT));
});
afterEach(async () => {
  await cloud.close();
  removeTempDirs();
});

const bearer = (token: string, path = "/api/v1/whoami", method = "GET") =>
  cloud.app.request(path, { method, headers: { authorization: `Bearer ${token}` } });
const mcp = (token: string) =>
  cloud.app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}` } });

/** Swap the account id inside a routed credential (the attack: A's secret, B's id). */
const swapAccount = (token: string, to: string) => `${token.slice(0, 4)}${to}${token.slice(20)}`;

async function expectUniform401(res: Response | Promise<Response>) {
  const r = await res;
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual(UNAUTHORIZED_BODY);
}

describe("bearer credentials resolve only in the tenant they name", () => {
  it("API keys: valid in A; with B’s id, any other id, or garbage: the same 401", async () => {
    const { a, b } = ids();
    const keyA = mintKeyIn(await runtimeOf(a));
    const ok = await bearer(keyA);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { accountId: string }).accountId).toBe(a);
    await expectUniform401(bearer(swapAccount(keyA, b))); // B exists: checked inside B, where it cannot match
    const opened = cloud.opener.opened.length;
    await expectUniform401(bearer(swapAccount(keyA, "taaaaaaaaaaaaaaa"))); // unknown: no file opened
    expect(cloud.opener.opened.length).toBe(opened);
    await expectUniform401(bearer(`${keyA}x`));
    await expectUniform401(bearer(keyA.toUpperCase()));
    await expectUniform401(bearer("glideworth_devlocal_0123456789abcdef0123456789abcdef"));
    await expectUniform401(bearer(swapAccount(keyA, "../../../../etc/p")));
    const r = await cloud.app.request("/api/v1/households", {
      headers: { authorization: `Bearer ${swapAccount(keyA, b)}` },
    });
    expect(await r.text()).not.toContain(SENTINEL_HOUSEHOLD);
  });

  it("a key prefix that exists in both tenants still only verifies where its whole hash is stored", async () => {
    const { a, b } = ids();
    const ra = await runtimeOf(a);
    const rb = await runtimeOf(b);
    const keyA = mintKeyIn(ra);
    const prefix = keyA.split("_")[2] as string;
    // B has a key with the same prefix (different secret, different account id inside the hash).
    const keyB = remember(`gwk_${b}_${prefix}_${"b".repeat(52)}`);
    rb.db
      .prepare("INSERT INTO api_keys (id, prefix, hash, user_id, scopes) VALUES (?, ?, ?, ?, ?)")
      .run(`key_${prefix}`, prefix, sha256Hex(keyB), "owner", '["read","write"]');
    expect(((await (await bearer(keyB)).json()) as { accountId: string }).accountId).toBe(b);
    expect(((await (await bearer(keyA)).json()) as { accountId: string }).accountId).toBe(a);
    await expectUniform401(bearer(swapAccount(keyA, b)));
    await expectUniform401(bearer(swapAccount(keyB, a)));
  });

  it("OAuth access tokens: valid in A on /mcp only; on /api, swapped to B or with the wrong resource: 401", async () => {
    const { a, b } = ids();
    const tokA = mintOauthIn(await runtimeOf(a), `${PUBLIC_URL}/mcp`);
    expect((await mcp(tokA)).status).toBe(200);
    await expectUniform401(bearer(tokA));
    await expectUniform401(mcp(swapAccount(tokA, b)));
    await expectUniform401(bearer(swapAccount(tokA, b)));
    const wrongResource = mintOauthIn(await runtimeOf(a), "https://evil.example/mcp");
    await expectUniform401(mcp(wrongResource));
  });

  it("refresh tokens, authorization codes and share tokens are never bearer credentials", async () => {
    const { a } = ids();
    for (const kind of ["oauth_refresh", "oauth_code", "share"] as const) {
      const t = remember(mintRouted(kind, a));
      await expectUniform401(bearer(t));
      await expectUniform401(mcp(t));
    }
  });

  it("deleted, deleting and suspended workspaces: the same 401 as an unknown credential, without opening a file", async () => {
    const { a } = ids();
    const keyA = mintKeyIn(await runtimeOf(a));
    await cloud.registry.close(a);
    const opened = cloud.opener.opened.length;
    for (const status of ["suspended", "deleting", "deleted"] as const) {
      cloud.db.update(accounts).set({ status }).where(eq(accounts.id, a)).run();
      await expectUniform401(bearer(keyA));
      await expectUniform401(mcp(keyA));
    }
    expect(cloud.opener.opened.length).toBe(opened);
    cloud.db.update(accounts).set({ status: "migration_failed" }).where(eq(accounts.id, a)).run();
    expect((await bearer(keyA)).status).toBe(503);
  });

  it("a member removed from A loses their API key at once (mirror removal deletes it)", async () => {
    const { a } = ids();
    const email = uniqueEmail("member");
    await A.browser.post("/api/v1/workspace/invitations", { email, role: "editor" });
    const invite = decodeURIComponent(
      String(cloud.mailer.last(email, "invitation")?.data.url).split("#token=")[1] ?? "",
    );
    remember(invite);
    const m = await signedUpBrowser(cloud, { email });
    expect(
      (await m.browser.post("/api/v1/workspace/invitations/accept", { token: invite })).status,
    ).toBe(200);
    const membership = cloud.workspaces.membership(a, m.userId);
    const keyM = mintKeyIn(await runtimeOf(a), membership?.tenantUserId);
    expect((await bearer(keyM)).status).toBe(200);
    expect((await m.browser.get("/api/v1/whoami")).status).toBe(200);
    expect((await A.browser.del(`/api/v1/workspace/members/${m.userId}`)).status).toBe(204);
    await expectUniform401(bearer(keyM));
    expect((await m.browser.get("/api/v1/whoami")).status).toBe(403);
  });
});

describe("browser sessions", () => {
  it("reach only the active workspace, re-checked on every request", async () => {
    const { a, b } = ids();
    const r = await A.browser.get("/api/v1/households");
    expect(r.status).toBe(200);
    expect(r.text).toContain(SENTINEL_HOUSEHOLD);
    // B's session cannot see A's data, and cannot switch to A.
    expect((await B.browser.get("/api/v1/households")).text).not.toContain(SENTINEL_HOUSEHOLD);
    expect((await B.browser.post(`/api/v1/workspaces/${a}/activate`)).status).toBe(403);
    // Forcing B's session to point at A in the database: refused on the next request (membership is re-read).
    cloud.db
      .update(sessions)
      .set({ activeAccountId: a })
      .where(eq(sessions.id, sha256Hex(B.browser.jar.get("__Host-gw_session") as string)))
      .run();
    const forced = await B.browser.get("/api/v1/households");
    expect(forced.status).toBe(403);
    expect(forced.text).not.toContain(SENTINEL_HOUSEHOLD);
    expect(b).not.toBe(a);
  });

  it("cookie writes need the CSRF token and a same-origin request; MCP never accepts cookies", async () => {
    const body = { id: "hh_x", name: "X", netWorth: 1 };
    expect((await A.browser.post("/api/v1/households", body, { csrf: false })).status).toBe(403);
    expect(
      (await A.browser.post("/api/v1/households", body, { origin: "https://evil.example" })).status,
    ).toBe(403);
    expect(
      (
        await A.browser.post("/api/v1/households", body, {
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    expect((await A.browser.post("/api/v1/households", body)).status).toBe(201);
    const viaMcp = await A.browser.post("/mcp", {});
    expect(viaMcp.status).toBe(401);
  });

  it("a session cookie of A with a bearer key of B: the bearer decides, and only B is reachable", async () => {
    const { b } = ids();
    const keyB = mintKeyIn(await runtimeOf(b));
    const r = await A.browser.get("/api/v1/whoami", {
      headers: { authorization: `Bearer ${keyB}` },
    });
    expect((r.body as { accountId: string }).accountId).toBe(b);
  });
});

describe("quotas are per workspace", () => {
  it("exhausting A’s per-minute budget does not throttle B, and keys are namespaced by account", async () => {
    const { a, b } = ids();
    const keyA = mintKeyIn(await runtimeOf(a));
    const keyB = mintKeyIn(await runtimeOf(b));
    const perMinute = cloud.entitlements.get(a).limits.apiRequestsPerMinute;
    for (let i = 0; i < perMinute; i++) cloud.quotas.admitRequest(a);
    const limited = await bearer(keyA);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await bearer(keyB)).status).toBe(200);
    // Junk credentials naming B never spend B's quota.
    const before = cloud.quotas.usage(b).api_request;
    for (let i = 0; i < 20; i++) await bearer(swapAccount(keyA, b));
    expect(cloud.quotas.usage(b).api_request).toBe(before);
  });
});

describe("unknown browser", () => {
  it("no cookie and no bearer: 401 with the same body", async () => {
    await expectUniform401(
      new Browser(cloud.app)
        .get("/api/v1/whoami")
        .then((r) => new Response(r.text, { status: r.status })),
    );
  });
});
