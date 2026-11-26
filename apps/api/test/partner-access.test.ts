/* oxlint-disable typescript/no-explicit-any -- tests probe arbitrary JSON responses */
/**
 * A partner with view-only access (self-host): the invitation's lifecycle, removal ending every credential at
 * once, and the partner summary they land on, whose figures must be the engine's own.
 */
import { afterEach, describe, expect, it } from "vitest";
import { type Browser, browser } from "./browser.js";
import { type Harness, setup } from "./helpers.js";
import { mcpCall, oauthTokenFor } from "./oauth-flow.js";

let h: Harness;
afterEach(async () => {
  await h?.services.jobs.close(30_000);
  h?.close();
});
const OWNER_PASS = "owner passphrase one two";
const PAT_PASS = "pat passphrase five six";
const A = "/api/v1/auth";

async function ownerSession(): Promise<Browser> {
  const o = browser(h.app);
  expect(
    (await o.req(`${A}/setup`, { method: "POST", body: { passphrase: OWNER_PASS } })).status,
  ).toBe(201);
  return o;
}

async function invitePartner(o: Browser) {
  const inv = await o.req("/api/v1/users", {
    method: "POST",
    body: { name: "Pat", role: "viewer", login: "pat" },
  });
  expect(inv.status).toBe(201);
  return { id: inv.json.user.id as string, token: inv.json.invite.token as string };
}

const accept = (token: string) =>
  browser(h.app).req(`${A}/accept`, { method: "POST", body: { token, passphrase: PAT_PASS } });

describe("invitation lifecycle", () => {
  it("expires, works once, is replaced by a re-issue, and every refusal looks the same", async () => {
    h = setup();
    const o = await ownerSession();
    const first = await invitePartner(o);

    // A re-issued invite replaces the first one.
    const again = await o.req(`/api/v1/users/${first.id}/invite`, { method: "POST" });
    expect(again.status).toBe(200);
    const replaced = await accept(first.token);
    expect(replaced.status).toBe(400);

    // Expired.
    h.ctx.sqlite.prepare("update user_tokens set expires_at = '2000-01-01T00:00:00.000Z'").run();
    const expired = await accept(again.json.invite.token);
    expect(expired.status).toBe(400);

    // Fresh, accepted once, then reused.
    const fresh = (await o.req(`/api/v1/users/${first.id}/invite`, { method: "POST" })).json.invite
      .token as string;
    expect((await accept(fresh)).status).toBe(200);
    const reused = await accept(fresh);
    expect(reused.status).toBe(400);

    // Unknown token: the same answer as every other refusal, so a token says nothing about who exists.
    const unknown = await accept(`glideworth-invite-${"A".repeat(43)}`);
    for (const r of [replaced, expired, reused]) expect(r.json).toEqual(unknown.json);
    expect(unknown.json.error.code).toBe("INVALID_TOKEN");
    expect(unknown.text).not.toMatch(/pat/i);
  });

  it("a viewer cannot invite, re-invite, share, or mint a key with more rights than they have", async () => {
    h = setup();
    const o = await ownerSession();
    const { id, token } = await invitePartner(o);
    const pat = browser(h.app);
    await pat.req(`${A}/accept`, { method: "POST", body: { token, passphrase: PAT_PASS } });
    const refused = [
      await pat.req("/api/v1/users", { method: "POST", body: { name: "Eve", role: "viewer" } }),
      await pat.req(`/api/v1/users/${id}/invite`, { method: "POST" }),
      await pat.req(`/api/v1/users/${id}`, { method: "PATCH", body: { role: "editor" } }),
      await pat.req("/api/v1/plans/plan-main/share-links", { method: "POST", body: {} }),
      await pat.req("/api/v1/keys", {
        method: "POST",
        body: { name: "k", scopes: ["read", "write"] },
      }),
      await pat.req("/api/v1/me/keys", {
        method: "POST",
        body: { name: "k", scopes: ["read", "write"] },
      }),
    ];
    for (const r of refused) expect(r.status, r.text).toBe(403);
    // Consenting to every scope on the OAuth screen still yields a read-only grant.
    const t = await oauthTokenFor(h, { user: "pat", pass: PAT_PASS });
    expect(t.scope.split(" ").sort()).toEqual(["read", "simulate"]);
    // A read-only key, though, is theirs to make.
    const k = await pat.req("/api/v1/me/keys", {
      method: "POST",
      body: { name: "k", scopes: ["read", "simulate"] },
    });
    expect(k.status).toBe(201);
    // ...and a later promotion does not silently widen what was stored for it.
    expect(k.json.scopes).toEqual(["read", "simulate"]);
  });
});

describe("removing a partner ends every credential at once", () => {
  for (const how of ["delete", "disable"] as const)
    it(`${how}: browser session, API key and OAuth (MCP) token all stop working`, async () => {
      h = setup();
      const o = await ownerSession();
      const { id, token } = await invitePartner(o);
      const pat = browser(h.app);
      expect(
        (await pat.req(`${A}/accept`, { method: "POST", body: { token, passphrase: PAT_PASS } }))
          .status,
      ).toBe(200);
      const key = (
        await pat.req("/api/v1/me/keys", {
          method: "POST",
          body: { name: "k", scopes: ["read", "simulate"] },
        })
      ).json.key as string;
      const oauth = (await oauthTokenFor(h, { user: "pat", pass: PAT_PASS })).access;
      // All three work before.
      expect((await pat.req("/api/v1/plans/plan-main/partner-summary")).status).toBe(200);
      expect((await h.call("/api/v1/plans", { key })).status).toBe(200);
      expect((await mcpCall(h, oauth, "tools/list")).status).toBe(200);

      const r =
        how === "delete"
          ? await o.req(`/api/v1/users/${id}`, { method: "DELETE" })
          : await o.req(`/api/v1/users/${id}`, { method: "PATCH", body: { disabled: true } });
      expect(r.status).toBeLessThan(300);

      expect((await pat.req("/api/v1/plans/plan-main/partner-summary")).status).toBe(401);
      expect((await h.call("/api/v1/plans", { key })).status).toBe(401);
      expect((await mcpCall(h, oauth, "tools/list")).status).toBe(401);
      expect(
        (
          await browser(h.app).req(`${A}/login`, {
            method: "POST",
            body: { passphrase: PAT_PASS, user: "pat" },
          })
        ).status,
      ).toBe(401);
    });
});

describe("the partner summary", () => {
  it("is the viewer's to read, and its figures are the engine's results for the plan", async () => {
    h = setup({ realEngine: true });
    const o = await ownerSession();
    // Fewer trials keep the test quick; the summary reads whatever the plan's own settings produce.
    const trials = await o.req("/api/v1/plans/plan-main", {
      method: "PATCH",
      body: [{ op: "replace", path: "/monteCarlo/trials", value: 200 }],
      headers: { "content-type": "application/json-patch+json" },
    });
    expect(trials.status, trials.text).toBe(200);
    const { token } = await invitePartner(o);
    const pat = browser(h.app);
    await pat.req(`${A}/accept`, { method: "POST", body: { token, passphrase: PAT_PASS } });

    const s0 = await pat.req("/api/v1/plans/plan-main/partner-summary");
    expect(s0.status, s0.text).toBe(200);
    // No Monte Carlo has run for this version: no figure is invented for it.
    expect(s0.json.confidence).toMatchObject({ level: "unknown", successRate: null });

    // The deterministic projection the rest of the app shows.
    const sim = (await pat.req("/api/v1/plans/plan-main/simulate", { method: "POST", body: {} }))
      .json;
    expect(s0.json.stopWork.year).toBe(sim.summary.retirementYear);
    expect(s0.json.spending.allFunded).toBe(sim.summary.success);
    expect(s0.json.spending.firstShortfallYear).toBe(sim.summary.firstShortfallYear);
    const p = sim.periods.find((x: any) => x.year === s0.json.spending.year);
    const deflator = p.priceIndexStart ?? 1;
    expect(s0.json.spending.yearly).toBeCloseTo(p.totals.spending / deflator, 6);

    // The survivor answers are the survivor scenarios' own outcomes.
    const surv = (await pat.req("/api/v1/plans/plan-main/scenarios/survivor?evaluate=true")).json;
    for (const c of s0.json.survivor.cases) {
      const sc = surv.scenarios.find((x: any) => x.id === `survivor-${c.personId}-${c.age}`);
      expect(sc, `survivor-${c.personId}-${c.age}`).toBeTruthy();
      expect(c.firstShortfallYear).toBe(sc.after.depletionYear);
    }
    expect(s0.json.survivor.cases.length).toBeGreaterThan(0);

    // The viewer may run the chance of success (it stores no plan change); the summary then quotes it.
    const job = await pat.req("/api/v1/plans/plan-main/monte-carlo?wait=60", {
      method: "POST",
      body: {},
    });
    expect(job.status, job.text).toBe(200);
    const mc = (await pat.req(`/api/v1/jobs/${job.json.id}/result`)).json;
    const s1 = (await pat.req("/api/v1/plans/plan-main/partner-summary")).json;
    expect(s1.confidence.successRate).toBe(mc.successRate);
    expect(s1.confidence.trials).toBe(mc.trials);
    expect(s1.figures.find((f: any) => f.id === "successRate").value).toBe(mc.successRate);

    // And it is the same summary over MCP.
    const key = (
      await pat.req("/api/v1/me/keys", { method: "POST", body: { name: "k", scopes: ["read"] } })
    ).json.key as string;
    const viaMcp = await mcpCall(h, key, "tools/call", {
      name: "get_partner_summary",
      arguments: { planId: "plan-main" },
    });
    expect(JSON.parse(viaMcp.json.result.content[0].text).headline).toBe(s1.headline);
    expect(s1.confidence.trials).toBe(200);
    expect(h.services.plans.get("plan-main").version).toBe(2);
  }, 120_000);
});
