/**
 * Invitations and members over HTTP: resend (a new link and expiry, rate limited, audited) and the members
 * list (email addresses for owners and editors, names only for viewers).
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditEvents, invitations } from "../src/control/schema.js";
import { sha256Hex } from "../src/crypto/random.js";
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

/** The JSON body of a response, typed by the test that reads it. */
const bodyOf = <T = Record<string, unknown>>(r: { body: unknown }): T => r.body as T;
const idOf = (r: { body: unknown }): string => bodyOf<{ id: string }>(r).id;

const tokenOf = (email: string) =>
  remember(
    decodeURIComponent(
      String(cloud.mailer.last(email, "invitation")?.data.url).split("#token=")[1] ?? "",
    ),
  );

describe("POST /api/v1/workspace/invitations/{id}/resend", () => {
  it("sends a new link with a new expiry, invalidates the old one, and is audited", async () => {
    const owner = await signedUpBrowser(cloud);
    const email = uniqueEmail("guest");
    const created = await owner.browser.post("/api/v1/workspace/invitations", {
      email,
      role: "viewer",
    });
    expect(created.status).toBe(201);
    await new Promise((r) => setTimeout(r, 0));
    const first = tokenOf(email);
    cloud.advance(3 * 24 * 3600_000);

    const again = await owner.browser.post(
      `/api/v1/workspace/invitations/${idOf(created)}/resend`,
      {},
    );
    expect(again.status, again.text).toBe(200);
    expect(bodyOf(again)).toMatchObject({ id: idOf(created), role: "viewer" });
    expect(
      Math.abs(
        Date.parse(bodyOf<{ expiresAt: string }>(again).expiresAt) -
          (cloud.now().getTime() + 7 * 24 * 3600_000),
      ),
    ).toBeLessThan(5000);
    await new Promise((r) => setTimeout(r, 0));
    expect(cloud.mailer.to(email, "invitation")).toHaveLength(2);
    const second = tokenOf(email);
    expect(second).not.toBe(first);
    const row = cloud.db
      .select()
      .from(invitations)
      .where(eq(invitations.id, idOf(created)))
      .get();
    expect(row?.tokenHash).toBe(sha256Hex(second));
    expect(JSON.stringify(row)).not.toContain(second);
    expect(
      cloud.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.event, "member.invitation_resent"))
        .all(),
    ).toHaveLength(1);

    const guest = await signedUpBrowser(cloud, { email });
    expect(
      (await guest.browser.post("/api/v1/workspace/invitations/accept", { token: first })).status,
    ).toBe(400);
    expect(
      (await guest.browser.post("/api/v1/workspace/invitations/accept", { token: second })).status,
    ).toBe(200);
  });

  it("an invitation that expired unanswered can be sent again, once, with the same 7 days", async () => {
    const owner = await signedUpBrowser(cloud);
    const email = uniqueEmail("late");
    const created = await owner.browser.post("/api/v1/workspace/invitations", {
      email,
      role: "viewer",
    });
    cloud.db
      .update(invitations)
      .set({ expiresAt: new Date(cloud.now().getTime() - 60_000).toISOString() })
      .where(eq(invitations.id, idOf(created)))
      .run();
    const guest = await signedUpBrowser(cloud, { email });
    await new Promise((r) => setTimeout(r, 0));
    const stale = tokenOf(email);
    expect(
      (await guest.browser.post("/api/v1/workspace/invitations/accept", { token: stale })).status,
    ).toBe(400);
    const again = await owner.browser.post(
      `/api/v1/workspace/invitations/${idOf(created)}/resend`,
      {},
    );
    expect(again.status, again.text).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    const fresh = tokenOf(email);
    expect(
      (await guest.browser.post("/api/v1/workspace/invitations/accept", { token: fresh })).status,
    ).toBe(200);
    expect(
      (await owner.browser.post(`/api/v1/workspace/invitations/${idOf(created)}/resend`, {}))
        .status,
    ).toBe(404);
  });

  it("is for owners and pending invitations only", async () => {
    const owner = await signedUpBrowser(cloud);
    const email = uniqueEmail("guest");
    const created = await owner.browser.post("/api/v1/workspace/invitations", {
      email,
      role: "editor",
    });
    const guest = await signedUpBrowser(cloud, { email });
    const token = tokenOf(email);
    await guest.browser.post("/api/v1/workspace/invitations/accept", { token });
    // An accepted invitation is gone; so is one that never existed.
    expect(
      (await owner.browser.post(`/api/v1/workspace/invitations/${idOf(created)}/resend`, {}))
        .status,
    ).toBe(404);
    expect(
      (await owner.browser.post("/api/v1/workspace/invitations/inv_nope/resend", {})).status,
    ).toBe(404);
    const other = await owner.browser.post("/api/v1/workspace/invitations", {
      email: uniqueEmail("second"),
      role: "viewer",
    });
    expect(
      (await guest.browser.post(`/api/v1/workspace/invitations/${idOf(other)}/resend`, {})).status,
    ).toBe(403);
    const revoked = await owner.browser.del(`/api/v1/workspace/invitations/${idOf(other)}`);
    expect(revoked.status).toBe(204);
    expect(
      (await owner.browser.post(`/api/v1/workspace/invitations/${idOf(other)}/resend`, {})).status,
    ).toBe(404);
  });

  it("shares the invitation mail rate limit (5 per address per hour)", async () => {
    const owner = await signedUpBrowser(cloud);
    const email = uniqueEmail("guest");
    const created = await owner.browser.post("/api/v1/workspace/invitations", {
      email,
      role: "viewer",
    });
    const path = `/api/v1/workspace/invitations/${idOf(created)}/resend`;
    for (let i = 0; i < 4; i++) expect((await owner.browser.post(path, {})).status).toBe(200);
    const limited = await owner.browser.post(path, {});
    expect(limited.status).toBe(429);
    expect(bodyOf<{ error: { code: string } }>(limited).error.code).toBe("RATE_LIMITED");
  });
});

describe("GET /api/v1/workspace/members", () => {
  it("gives owners and editors each member's email, and viewers names only", async () => {
    const owner = await signedUpBrowser(cloud, { name: "Olive Owner" });
    const editorEmail = uniqueEmail("editor");
    const viewerEmail = uniqueEmail("viewer");
    const join = async (email: string, role: "editor" | "viewer", name: string) => {
      await owner.browser.post("/api/v1/workspace/invitations", { email, role });
      await new Promise((r) => setTimeout(r, 0));
      const m = await signedUpBrowser(cloud, { email, name });
      const ok = await m.browser.post("/api/v1/workspace/invitations/accept", {
        token: tokenOf(email),
      });
      expect(ok.status, ok.text).toBe(200);
      return m;
    };
    const editor = await join(editorEmail, "editor", "Ed Editor");
    const viewer = await join(viewerEmail, "viewer", "Vi Viewer");

    const emails = (items: Array<{ name: string; email?: string }>) =>
      Object.fromEntries(items.map((i) => [i.name, i.email]));
    for (const who of [owner, editor]) {
      const r = await who.browser.get("/api/v1/workspace/members");
      expect(r.status).toBe(200);
      expect(emails(bodyOf<{ items: Array<{ name: string; email?: string }> }>(r).items)).toEqual({
        "Olive Owner": owner.email,
        "Ed Editor": editorEmail,
        "Vi Viewer": viewerEmail,
      });
    }
    const v = await viewer.browser.get("/api/v1/workspace/members");
    expect(v.status).toBe(200);
    expect(
      bodyOf<{ items: Array<{ name: string }> }>(v)
        .items.map((i) => i.name)
        .sort(),
    ).toEqual(["Ed Editor", "Olive Owner", "Vi Viewer"]);
    for (const i of bodyOf<{ items: object[] }>(v).items) expect(i).not.toHaveProperty("email");
    expect(v.text).not.toContain("@");
  });
});
