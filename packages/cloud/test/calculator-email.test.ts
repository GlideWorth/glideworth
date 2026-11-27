/**
 * "Email me this result" on the marketing site's calculators (marketing/, routes/calculator-email.ts): off by
 * default; one result email built only from the catalog and checked numbers; the double opt-in; the list
 * unsubscribe; limits per client, per recipient and in total; the same answer for every address. All addresses
 * are synthetic.
 */
import { render } from "@glideworth/email";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeEmail } from "../src/accounts/email.js";
import { controlEmailStores } from "../src/control/email-stores.js";
import { pruneControlData } from "../src/control/retention.js";
import { mailOutbox, marketingConsents } from "../src/control/schema.js";
import type { ProductEvents, ServerProductEvent } from "../src/log/product-events.js";
import {
  CALCULATORS,
  CONSENT_TEXT,
  CONSENT_VERSION,
  shapeOf,
} from "../src/marketing/calculator-email.js";
import {
  type Cloud,
  makeCloud,
  PUBLIC_URL,
  removeTempDirs,
  SITE_ORIGIN,
  uniqueEmail,
} from "./cloud-fixture.js";

let cloud: Cloud;
let events: Array<{ id: string; e: ServerProductEvent }>;
beforeEach(async () => {
  events = [];
  const capture: ProductEvents = {
    capture: (id, e) => void events.push({ id, e }),
    flush: async () => {},
  };
  cloud = await makeCloud({ calculatorEmail: { events: capture } });
});
afterEach(async () => {
  await cloud.close();
  removeTempDirs();
});

const COAST = CALCULATORS["coast-fire"]!;

interface FormInput {
  email?: string;
  tool?: string;
  q?: string;
  figures?: [string, string][];
  updates?: string;
  website?: string;
}
function form(i: FormInput): string {
  const p = new URLSearchParams();
  p.set("email", i.email ?? "sam@example.test");
  p.set("tool", i.tool ?? "coast-fire");
  p.set("q", i.q ?? "age=40&retire=62&balance=150000&cur=USD&v=1");
  for (const [l, v] of i.figures ?? []) {
    p.append("fl", l);
    p.append("fv", v);
  }
  if (i.updates) p.set("updates", i.updates);
  p.set("website", i.website ?? "");
  return p.toString();
}
const post = (
  i: FormInput,
  o: { json?: boolean; origin?: string | null; ip?: string; type?: string } = {},
) =>
  cloud.app.request("/email/calculator", {
    method: "POST",
    headers: {
      "content-type": o.type ?? "application/x-www-form-urlencoded",
      accept: o.json === false ? "text/html" : "application/json",
      "x-forwarded-for": o.ip ?? "203.0.113.7",
      ...(o.origin === null ? {} : { origin: o.origin ?? SITE_ORIGIN }),
    },
    body: form(i),
  });

async function sentTo(email: string) {
  await cloud.outbox.drain();
  return cloud.mailer.to(email, "calculator-result");
}
const consentOf = (email: string) =>
  cloud.db
    .select()
    .from(marketingConsents)
    .where(eq(marketingConsents.emailNormalized, normalizeEmail(email) as string))
    .get();
const tokenFrom = (url: string) => new URL(url).searchParams.get("t") as string;
const confirm = (t: string) =>
  cloud.app.request("/email/calculator/confirm", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: PUBLIC_URL },
    body: new URLSearchParams({ t }).toString(),
  });

describe("off by default", () => {
  it("registers no route unless the site origin is configured", async () => {
    const plain = await makeCloud();
    try {
      const r = await plain.app.request("/email/calculator", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE_ORIGIN },
        body: form({}),
      });
      expect(r.status).toBe(404);
      expect((await plain.app.request("/email/calculator/confirm?t=x")).status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});

describe("the result email", () => {
  it("is sent with labelled inputs, checked figures and a reopen link; nothing is stored without the box", async () => {
    const email = uniqueEmail("result");
    const r = await post({
      email,
      q: "age=40&retire=62&balance=150000&spend=abc&wr=99&cur=USD&evil=<b>&v=1",
      figures: [
        ["FIRE number", "$1,250,000"],
        ["Coast age", "51"],
        ["Call us now", "$1"],
        ["FIRE number", "visit evil.example to claim $5,000"],
        ["Coast number at 40", "$480,000"],
      ],
    });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ status: "sent" });
    const [m] = await sentTo(email);
    expect(m).toBeDefined();
    const d = m!.data as Record<string, unknown>;
    expect(d.toolName).toBe(COAST.name);
    expect(d.figures).toEqual([
      ["FIRE number", "$1,250,000"],
      ["Coast age", "51"],
      ["Coast number at 40", "$480,000"],
    ]);
    const inputs = new Map(d.inputs as [string, string][]);
    expect(inputs.get("Your age now")).toBe("40");
    expect(inputs.get("Invested today")).toBe("$150,000");
    // Out of range or unreadable: the field's default, as the calculator page itself does.
    expect(inputs.get("Yearly spending in retirement")).toBe("$40,000");
    expect(inputs.get("Withdrawal rate")).toBe("4%");
    expect(JSON.stringify(d)).not.toContain("evil");
    expect(JSON.stringify(d)).not.toContain("<b>");
    const reopen = new URL(d.reopenUrl as string);
    expect(reopen.origin + reopen.pathname).toBe(`${SITE_ORIGIN}${COAST.path}`);
    expect(reopen.searchParams.get("balance")).toBe("150000");
    expect(reopen.searchParams.get("spend")).toBe("40000");
    expect(reopen.searchParams.get("evil")).toBeNull();
    expect(d.confirmUrl).toBeNull();
    expect(cloud.db.select().from(marketingConsents).all()).toHaveLength(0);
    // The real template renders what the server built.
    const out = render("calculator-result", m!.data as never, {
      productName: "Glideworth",
      appUrl: PUBLIC_URL,
      supportEmail: "support@example.test",
    });
    expect(out.text).toContain("FIRE number: $1,250,000");
    expect(out.text).not.toContain("Yes, send me the reminder");
    expect(events.map((x) => x.e)).toEqual([
      {
        event: "calculator_email_requested",
        properties: { tool: "coast-fire", updates_opt_in: false, $process_person_profile: false },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(email);
  });

  it("a plain form post (no JavaScript) gets a page with a link back to the calculator", async () => {
    const r = await post({}, { json: false });
    expect(r.status).toBe(200);
    const page = await r.text();
    expect(page).toContain("Check your inbox");
    expect(page).toContain(`href="${SITE_ORIGIN}${COAST.path}?`);
    expect(r.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    const bad = await post({ email: "not an address" }, { json: false });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Check the email address");
  });

  it("refuses bad input, unknown calculators, an unknown consent version and the honeypot", async () => {
    expect((await post({ email: "nope" })).status).toBe(400);
    expect((await post({ tool: "not-a-calculator" })).status).toBe(400);
    expect((await post({ updates: "calc-updates-0" })).status).toBe(400);
    expect((await post({ website: "https://spam.example" })).status).toBe(400);
    expect((await post({ q: `a=${"9".repeat(3000)}` })).status).toBe(400);
    await cloud.outbox.drain();
    expect(cloud.mailer.sent).toHaveLength(0);
  });

  it("accepts posts only from the site (or this origin), as form data", async () => {
    expect((await post({}, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post({}, { origin: "https://evil.example", json: false })).status).toBe(403);
    expect((await post({}, { origin: null })).status).toBe(202);
    expect((await post({}, { origin: PUBLIC_URL })).status).toBe(202);
    expect((await post({}, { type: "application/json" })).status).toBe(400);
  });

  it("answers the same for a suppressed address; the mailer then drops it", async () => {
    const email = uniqueEmail("bounced");
    controlEmailStores(cloud.db).suppressions.suppress(
      normalizeEmail(email) as string,
      "all",
      "bounce",
    );
    const a = await post({ email });
    const b = await post({ email: uniqueEmail("fine") });
    expect([a.status, await a.text()]).toEqual([b.status, await b.text()]);
    await cloud.outbox.drain();
    const rows = cloud.db.select().from(mailOutbox).all();
    expect(rows.every((x) => x.status === "sent")).toBe(true); // the capturing mailer stands in for the real one
  });
});

describe("limits", () => {
  it("at most three result emails a day to one address, whoever asks", async () => {
    const email = uniqueEmail("victim");
    for (let i = 0; i < 3; i++)
      expect((await post({ email }, { ip: `198.51.100.${i + 1}` })).status).toBe(202);
    const r = await post({ email: email.toUpperCase() }, { ip: "198.51.100.99" });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    expect(await sentTo(email)).toHaveLength(3);
    cloud.advance(24 * 3600_000 + 1000);
    expect((await post({ email }, { ip: "198.51.100.100" })).status).toBe(202);
  });

  it("at most five in ten minutes from one client address", async () => {
    for (let i = 0; i < 5; i++)
      expect((await post({ email: uniqueEmail(`ip${i}`) })).status).toBe(202);
    const r = await post({ email: uniqueEmail("ip5") }, { json: false });
    expect(r.status).toBe(429);
    expect(await r.text()).toContain("Try again later");
    expect((await post({ email: uniqueEmail("other") }, { ip: "192.0.2.50" })).status).toBe(202);
  });
});

describe("total a day", () => {
  it("stops at the operator's daily total, whoever asks and to whom", async () => {
    const small = await makeCloud({ calculatorEmail: { dailyLimit: 2 } });
    try {
      const send = (i: number) =>
        small.app.request("/email/calculator", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
            origin: SITE_ORIGIN,
            "x-forwarded-for": `192.0.2.${i}`,
          },
          body: form({ email: uniqueEmail(`t${i}`) }),
        });
      expect((await send(1)).status).toBe(202);
      expect((await send(2)).status).toBe(202);
      expect((await send(3)).status).toBe(429);
    } finally {
      await small.close();
    }
  });
});

describe("double opt-in, consent record and unsubscribe", () => {
  it("records the exact wording, sends the confirm link in the result email, and confirms only on POST", async () => {
    const email = uniqueEmail("optin");
    expect((await post({ email, updates: CONSENT_VERSION })).status).toBe(202);
    const row = consentOf(email)!;
    expect(row).toMatchObject({
      status: "pending",
      consentVersion: CONSENT_VERSION,
      consentText: CONSENT_TEXT,
      source: "calculator:coast-fire",
      tool: "coast-fire",
      confirmedAt: null,
    });
    expect(row.inputs).toMatchObject({ age: 40, retire: 62, balance: 150000, cur: "USD" });
    const [m] = await sentTo(email);
    const url = m!.data.confirmUrl as string;
    expect(url.startsWith(`${PUBLIC_URL}/email/calculator/confirm?t=`)).toBe(true);
    expect(row.confirmTokenHash).not.toContain(tokenFrom(url));

    const page = await cloud.app.request(`/email/calculator/confirm?t=${tokenFrom(url)}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<form method="post" action="/email/calculator/confirm">');
    expect(consentOf(email)!.status).toBe("pending");

    const done = await confirm(tokenFrom(url));
    expect(done.status).toBe(200);
    const html = await done.text();
    expect(html).toContain("You are on the list");
    const unsub = /href="([^"]*email\/unsubscribe\?t=[^"]+)"/.exec(html)?.[1] as string;
    expect(unsub).toBeTruthy();
    expect(consentOf(email)).toMatchObject({ status: "confirmed", confirmTokenHash: null });
    expect(consentOf(email)!.confirmedAt).toBeTruthy();
    expect((await confirm(tokenFrom(url))).status).toBe(400);
    expect(events.map((x) => x.e.event)).toEqual([
      "calculator_email_requested",
      "calculator_email_confirmed",
    ]);
    expect(events[0]!.id).toBe(events[1]!.id);

    // One-click unsubscribe from a mail provider (RFC 8058).
    const t = new URL(unsub.replace(/&amp;/g, "&")).searchParams.get("t") as string;
    const one = await cloud.app.request(`/email/unsubscribe?t=${encodeURIComponent(t)}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://mail.example",
      },
      body: "List-Unsubscribe=One-Click",
    });
    expect(one.status).toBe(200);
    expect(await one.text()).toContain("No more reminders or updates");
    expect(consentOf(email)).toMatchObject({ status: "unsubscribed", inputs: {} });
    expect(
      controlEmailStores(cloud.db).suppressions.reasonFor(
        normalizeEmail(email) as string,
        "marketing",
      ),
    ).toBe("unsubscribe");
    expect(events.at(-1)!.e.event).toBe("calculator_email_unsubscribed");
  });

  it("a new confirmed opt-in after an unsubscribe lifts the list suppression", async () => {
    const email = uniqueEmail("again");
    const norm = normalizeEmail(email) as string;
    await post({ email, updates: CONSENT_VERSION });
    await confirm(tokenFrom((await sentTo(email))[0]!.data.confirmUrl as string));
    const t = tokenFrom(cloud.unsubscribe.url(norm, "marketing"));
    await cloud.app.request(`/email/unsubscribe?t=${t}`, { method: "POST" });
    expect(consentOf(email)!.status).toBe("unsubscribed");
    await post({ email, updates: CONSENT_VERSION });
    expect(consentOf(email)!.status).toBe("pending");
    const second = (await sentTo(email)).at(-1)!;
    expect((await confirm(tokenFrom(second.data.confirmUrl as string))).status).toBe(200);
    expect(controlEmailStores(cloud.db).suppressions.isSuppressed(norm, "marketing")).toBe(false);
  });

  it("a request never changes a confirmed record; the email says the address is already on the list", async () => {
    const email = uniqueEmail("confirmed");
    await post({ email, updates: CONSENT_VERSION });
    await confirm(tokenFrom((await sentTo(email))[0]!.data.confirmUrl as string));
    const before = consentOf(email)!;
    await post({ email, tool: "fire", q: "", updates: CONSENT_VERSION });
    expect(consentOf(email)).toEqual(before);
    const last = (await sentTo(email)).at(-1)!;
    expect(last.data).toMatchObject({ confirmUrl: null, alreadySubscribed: true });
  });

  it("an expired, unknown or malformed link confirms nothing", async () => {
    const email = uniqueEmail("late");
    await post({ email, updates: CONSENT_VERSION });
    const t = tokenFrom((await sentTo(email))[0]!.data.confirmUrl as string);
    cloud.advance(8 * 24 * 3600_000);
    expect((await cloud.app.request(`/email/calculator/confirm?t=${t}`)).status).toBe(400);
    expect((await confirm(t)).status).toBe(400);
    expect((await confirm("A".repeat(43))).status).toBe(400);
    expect((await confirm("short")).status).toBe(400);
    expect(consentOf(email)!.status).toBe("pending");
  });

  it("the confirm form works with the Origin: null a no-referrer page posts with (the token is the authorisation)", async () => {
    const email = uniqueEmail("nullorigin");
    await post({ email, updates: CONSENT_VERSION });
    const t = tokenFrom((await sentTo(email))[0]!.data.confirmUrl as string);
    const r = await cloud.app.request("/email/calculator/confirm", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "null" },
      body: new URLSearchParams({ t }).toString(),
    });
    expect(r.status).toBe(200);
    expect(consentOf(email)!.status).toBe("confirmed");
  });

  it("retention deletes unconfirmed records after 30 days and unsubscribed ones after 12 months", async () => {
    const pending = uniqueEmail("never");
    const gone = uniqueEmail("gone");
    await post({ email: pending, updates: CONSENT_VERSION });
    await post({ email: gone, updates: CONSENT_VERSION }, { ip: "192.0.2.9" });
    await confirm(tokenFrom((await sentTo(gone))[0]!.data.confirmUrl as string));
    const t = tokenFrom(cloud.unsubscribe.url(normalizeEmail(gone) as string, "marketing"));
    await cloud.app.request(`/email/unsubscribe?t=${t}`, { method: "POST" });
    const prune = (days: number) =>
      pruneControlData(cloud.db, {
        trialDays: 14,
        now: () => new Date(cloud.now().getTime() + days * 24 * 3600_000),
      });
    expect((await prune(29)).counts.marketingConsents).toBe(0);
    expect((await prune(31)).counts.marketingConsents).toBe(1);
    expect(consentOf(pending)).toBeUndefined();
    expect(consentOf(gone)).toBeDefined();
    expect((await prune(370)).counts.marketingConsents).toBe(1);
    expect(consentOf(gone)).toBeUndefined();
  });
});

describe("catalog", () => {
  it("every figure shape is free of digits", () => {
    for (const entry of Object.values(CALCULATORS))
      for (const s of entry.labelShapes) expect(s, s).toBe(shapeOf(s));
  });
});
