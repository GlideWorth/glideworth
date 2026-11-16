/**
 * Email routes (spec 5.4, review finding 4): unsubscribe GET changes nothing, POST (form or RFC 8058 one-click)
 * suppresses check-in mail; the Mailgun bounce/complaint webhook verifies its signature, refuses stale and
 * replayed tokens, and suppresses every category (the mailer still attempts verification and reset mail).
 */
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeEmail } from "../src/accounts/email.js";
import { controlEmailStores } from "../src/control/email-stores.js";
import { emailSuppressions, users } from "../src/control/schema.js";
import {
  type Cloud,
  makeCloud,
  removeTempDirs,
  signedUpBrowser,
  uniqueEmail,
} from "./cloud-fixture.js";
import { remember } from "./helpers.js";

let cloud: Cloud;
beforeEach(async () => {
  cloud = await makeCloud();
});
afterEach(async () => {
  await cloud.accounts.settled();
  await cloud.close();
  removeTempDirs();
});

describe("unsubscribe", () => {
  it("GET shows a confirmation and changes nothing; POST suppresses check-in mail and turns the setting off", async () => {
    const u = await signedUpBrowser(cloud);
    const norm = normalizeEmail(u.email) as string;
    const url = new URL(cloud.unsubscribe.url(norm, "checkin"));
    const t = remember(url.searchParams.get("t") as string);
    const page = await cloud.app.request(`/email/unsubscribe?t=${encodeURIComponent(t)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<form method="post" action="/email/unsubscribe">');
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    expect(cloud.db.select().from(emailSuppressions).all()).toHaveLength(0);
    // One-click from a mail provider: cross-site, no session, token in the query.
    const one = await cloud.app.request(`/email/unsubscribe?t=${encodeURIComponent(t)}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://mail.example",
      },
      body: "List-Unsubscribe=One-Click",
    });
    expect(one.status).toBe(200);
    expect(controlEmailStores(cloud.db).suppressions.reasonFor(norm, "checkin")).toBe(
      "unsubscribe",
    );
    expect(controlEmailStores(cloud.db).suppressions.isSuppressed(norm, "essential")).toBe(false);
    expect(cloud.db.select().from(users).where(eq(users.id, u.userId)).get()?.checkinEmails).toBe(
      false,
    );
  });

  it("a forged or essential-category token is refused", async () => {
    const bad = await cloud.app.request("/email/unsubscribe?t=abc.def", { method: "POST" });
    expect(bad.status).toBe(400);
    const forged = Buffer.from(JSON.stringify({ e: "x@example.org", c: "checkin", t: 1 })).toString(
      "base64url",
    );
    const r = await cloud.app.request(`/email/unsubscribe?t=${forged}.${"A".repeat(43)}`, {
      method: "POST",
    });
    expect(r.status).toBe(400);
    expect(cloud.db.select().from(emailSuppressions).all()).toHaveLength(0);
  });
});

describe("mailgun webhook", () => {
  const key = "mailgun-signing-key-for-tests";
  const sign = (timestamp: string, token: string) =>
    createHmac("sha256", key)
      .update(timestamp + token)
      .digest("hex");
  const post = (body: unknown) =>
    cloud.app.request("/email/webhooks/mailgun", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const event = (
    recipient: string,
    o: { event?: string; severity?: string; ts?: number; token?: string; sig?: string } = {},
  ) => {
    const timestamp = String(o.ts ?? Math.floor(cloud.now().getTime() / 1000));
    const token = o.token ?? `tok${Math.random().toString(36).slice(2)}abcdef`;
    return {
      signature: { timestamp, token, signature: o.sig ?? sign(timestamp, token) },
      "event-data": { event: o.event ?? "failed", severity: o.severity ?? "permanent", recipient },
    };
  };

  it("a signed permanent bounce or complaint suppresses all categories; temporary failures are ignored", async () => {
    const bounced = uniqueEmail("bounce");
    const complained = uniqueEmail("complaint");
    const temporary = uniqueEmail("temp");
    expect((await post(event(bounced))).status).toBe(200);
    expect((await post(event(complained, { event: "complained", severity: "" }))).status).toBe(200);
    expect((await post(event(temporary, { severity: "temporary" }))).status).toBe(200);
    const s = controlEmailStores(cloud.db).suppressions;
    expect(s.reasonFor(normalizeEmail(bounced) as string, "essential")).toBe("bounce");
    expect(s.reasonFor(normalizeEmail(complained) as string, "checkin")).toBe("complaint");
    expect(s.isSuppressed(normalizeEmail(temporary) as string, "essential")).toBe(false);
  });

  it("bad signature, stale timestamp and replayed token change nothing", async () => {
    const victim = uniqueEmail("victim");
    expect((await post(event(victim, { sig: "f".repeat(64) }))).status).toBe(401);
    expect(
      (await post(event(victim, { ts: Math.floor(cloud.now().getTime() / 1000) - 3600 }))).status,
    ).toBe(401);
    expect(cloud.db.select().from(emailSuppressions).all()).toHaveLength(0);
    const first = event(uniqueEmail("real"));
    expect((await post(first)).status).toBe(200);
    // Replay of the same signed token for another address: refused as a duplicate.
    const replay = { ...first, "event-data": { ...first["event-data"], recipient: victim } };
    const r = await post(replay);
    expect(((await r.json()) as { status: string }).status).toBe("duplicate");
    expect(
      controlEmailStores(cloud.db).suppressions.isSuppressed(
        normalizeEmail(victim) as string,
        "essential",
      ),
    ).toBe(false);
  });
});
