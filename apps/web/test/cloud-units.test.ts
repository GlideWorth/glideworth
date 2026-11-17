import { describe, expect, it, vi } from "vitest";
import { describeQuota, onApiProblem, reportApiProblem } from "../src/lib/api-problems";
import { csrfHeaders, interpretSession, modeOf } from "../src/lib/auth";
import { billingView, bannerFor } from "../src/features/cloud/billing-state";
import { applyHandoff, parseHandoff } from "../src/features/cloud/handoff";
import { readFragmentParam } from "../src/features/cloud/fragment";
import { safeNext } from "../src/features/cloud/next";
import { passwordProblem } from "../src/features/cloud/password-rules";
import { encodeQr } from "../src/features/cloud/qr";
import { daysLeft, daysText, fmtPrice } from "../src/features/cloud/format";
import { ApiRequestError } from "../src/lib/api-error";
import type { BillingInfo } from "../src/features/cloud/client";
import { describeError } from "../src/features/cloud/ui";

describe("server error messages", () => {
  it("are shown as sentences, not raw lowercase fragments", () => {
    const err = (message: string) => new ApiRequestError(401, "UNAUTHORIZED", message);
    expect(describeError(err("the password is wrong"))).toBe("The password is wrong.");
    expect(describeError(err("the code is wrong; check the time on your device"))).toBe(
      "The code is wrong; check the time on your device.",
    );
    expect(describeError(err("Already a sentence."))).toBe("Already a sentence.");
  });
});

describe("the `next` redirect validator", () => {
  const origin = "https://app.glideworth.com";
  it("keeps same-origin relative paths, with query and fragment", () => {
    expect(safeNext("/settings/billing", origin)).toBe("/settings/billing");
    expect(safeNext("/plans/p1?tab=x#top", origin)).toBe("/plans/p1?tab=x#top");
  });
  it.each([
    "https://evil.example/",
    "//evil.example/x",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "/ok\nSet-Cookie: x=1",
    "evil",
    "",
    undefined,
    42,
    `/${"a".repeat(3000)}`,
  ])("refuses %j", (v) => {
    expect(safeNext(v, origin)).toBe("/");
  });
  // Dot segments are removed by the URL parser, which can leave a path that starts with `//`. Returned as is,
  // that is a protocol-relative URL to another host.
  it.each([
    "/.//evil.example",
    "/x/..//evil.example/y",
    "/%2e//evil.example",
    "/a/%2E%2E//evil.example?q=1",
  ])("refuses %j, which normalises to //host", (v) => {
    expect(safeNext(v, origin)).toBe("/");
  });
  it("never sends a signed-in person back to a sign-in page", () => {
    expect(safeNext("/signin", origin)).toBe("/");
    expect(safeNext("/signup?x=1", origin)).toBe("/");
  });
});

describe("the URL fragment token", () => {
  it("reads token=… from the fragment only", () => {
    expect(readFragmentParam("token", "#token=abc123")).toBe("abc123");
    expect(readFragmentParam("token", "#a=1&token=zz%2Fy")).toBe("zz/y");
    expect(readFragmentParam("token", "")).toBeNull();
    expect(readFragmentParam("token", `#token=${"x".repeat(300)}`)).toBeNull();
  });
});

describe("mode contract (GET /api/v1/auth/status)", () => {
  it("is self-host when the answer carries no mode field", () => {
    expect(modeOf(interpretSession(200, { setupRequired: false, authenticated: false }))).toBe(
      "selfhost",
    );
    expect(
      modeOf(interpretSession(200, { mode: "selfhost", authenticated: true, via: "session" })),
    ).toBe("selfhost");
    expect(modeOf(interpretSession(404, null))).toBe("selfhost");
    expect(modeOf(undefined)).toBe("selfhost");
  });
  it("reads cloud signed out, with the CAPTCHA site key and terms version when the server sends them", () => {
    const s = interpretSession(200, {
      mode: "cloud",
      authenticated: false,
      captcha: { siteKey: "0x4AAA" },
      terms: { version: "2026-11-16" },
    });
    expect(s).toEqual({
      kind: "cloud-signed-out",
      captchaSiteKey: "0x4AAA",
      termsVersion: "2026-11-16",
    });
    expect(modeOf(s)).toBe("cloud");
    expect(interpretSession(200, { mode: "cloud", authenticated: false, csrfToken: null })).toEqual(
      {
        kind: "cloud-signed-out",
      },
    );
  });
  it("reads the signed-in person, workspace role, access and trial end", () => {
    const s = interpretSession(200, {
      mode: "cloud",
      authenticated: true,
      user: { id: "u1", email: "a@b.co", name: "Ada", role: "owner", totp: true },
      workspace: {
        id: "acc_1",
        name: "Home",
        role: "owner",
        access: { level: "full", reason: "trial", changesAt: "2026-12-16T00:00:00Z" },
        trialEndsAt: "2026-12-16T00:00:00Z",
      },
      workspaces: [{ id: "acc_1", name: "Home", role: "owner", access: null }],
      expiresAt: "2027-01-01T00:00:00Z",
    });
    expect(s).toMatchObject({
      kind: "authenticated",
      via: "session",
      user: { id: "u1", name: "Ada", role: "owner" },
      cloud: {
        user: { email: "a@b.co", totp: true },
        workspace: {
          role: "owner",
          trialEndsAt: "2026-12-16T00:00:00Z",
          access: { level: "full", reason: "trial" },
        },
      },
    });
  });
  it("treats an unreadable cloud answer as unreachable, not as signed out", () => {
    expect(interpretSession(500, { mode: "cloud" }).kind).toBe("unreachable");
  });
});

describe("CSRF header", () => {
  it("echoes the cloud cookie on writes only", () => {
    const spy = vi
      .spyOn(Document.prototype, "cookie", "get")
      .mockReturnValue("a=1; __Host-gw_csrf=tok%2B1; b=2");
    expect(csrfHeaders("GET")).toEqual({});
    expect(csrfHeaders("DELETE")).toEqual({ "x-csrf-token": "tok+1" });
    spy.mockRestore();
  });
});

describe("password rules (mirror of the server policy)", () => {
  it("needs 12 characters and refuses the email address", () => {
    expect(passwordProblem("short", "a@b.co")).toMatch(/at least 12/);
    expect(passwordProblem("a long enough one", "a@b.co")).toBeNull();
    expect(passwordProblem("ada.lovelace@example.com", "ada.lovelace@example.com")).toMatch(
      /email/,
    );
    expect(passwordProblem("my-ada.lovelace-password", "ada.lovelace@example.com")).toMatch(
      /email/,
    );
    // A password that only contains the name part says so, not just "your email address".
    expect(passwordProblem("carol long passphrase", "carol@example.com")).toMatch(
      /part before the @/,
    );
    expect(passwordProblem("x".repeat(1025), "a@b.co")).toMatch(/at most/);
  });
});

describe("calculator hand-off", () => {
  const q =
    "?from=tool&tool=fire&v=1&cur=GBP&timing=mid&age=35&balance=120000&spend=30000&save=20000&ret=5&tax=12.5&junk=1&seed=abc";
  it("parses known keys, ignores unknown ones and invalid values", () => {
    const h = parseHandoff(q)!;
    expect(h.tool).toBe("fire");
    expect(h.values).toMatchObject({
      cur: "GBP",
      timing: "mid",
      age: "35",
      balance: "120000",
      tax: "12.5",
    });
    expect(h.values.junk).toBeUndefined();
    expect(h.values.seed).toBeUndefined();
  });
  it("refuses anything that is not a version 1 hand-off from a known calculator", () => {
    expect(parseHandoff("?tool=fire&v=1")).toBeNull();
    expect(parseHandoff("?from=tool&tool=fire&v=2")).toBeNull();
    expect(parseHandoff("?from=tool&tool=nope&v=1")).toBeNull();
    expect(parseHandoff("?from=tool&tool=fire&v=1&balance=1e9999")?.values.balance).toBeUndefined();
  });
  it("fills the guided setup: currency and country, age, balance, spending, retirement", () => {
    const now = new Date(Date.UTC(2026, 10, 16));
    const { answers, used, skipped } = applyHandoff(
      parseHandoff(
        "?from=tool&tool=coast-fire&v=1&cur=USD&age=35&retire=62&balance=150000&spend=48000&ret=5&save=12000",
      )!,
      now,
    );
    expect(answers.country).toBe("US");
    expect(answers.currency).toBe("USD");
    expect(answers.you.birthMonth).toBe("1991-01");
    expect(answers.retirementAge).toBe(62);
    expect(answers.spending).toEqual({ essential: 48000, discretionary: 0, frequency: "yearly" });
    expect(answers.accounts.some((a) => a.balance === 150000)).toBe(true);
    expect(used.join(" ")).toMatch(/currency USD/);
    expect(skipped).toEqual(expect.arrayContaining(["ret", "save"]));
  });
  it("Barista FIRE: the age is the age leaving full-time work", () => {
    const { answers } = applyHandoff(
      parseHandoff("?from=tool&tool=barista-fire&v=1&age=45&planTo=95&spend=30000&balance=300000")!,
    );
    expect(answers.retirementAge).toBe(45);
    expect(answers.lifeExpectancy).toBe(95);
  });
});

describe("billing wording for every state", () => {
  const base: BillingInfo = {
    status: "active",
    plan: "Glideworth Cloud",
    interval: "month",
    currentPeriodEnd: "2027-01-15T00:00:00Z",
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    access: { level: "full", reason: "active", changesAt: null },
    role: "owner",
  };
  const now = new Date("2026-11-16T12:00:00Z");
  const offered: BillingInfo["offered"] = [
    {
      lookupKey: "cloud_yearly_v1",
      interval: "year",
      unitAmount: 9000,
      currency: "usd",
      taxBehavior: "exclusive",
    },
    {
      lookupKey: "cloud_monthly_v1",
      interval: "month",
      unitAmount: 900,
      currency: "usd",
      taxBehavior: "exclusive",
    },
  ];
  it("trialing (Stripe trial with a card): days left, the first charge and how to cancel", () => {
    const v = billingView(
      {
        ...base,
        status: "trialing",
        lookupKey: "cloud_monthly_v1",
        offered,
        access: { level: "full", reason: "trial", changesAt: null },
        trialEndsAt: "2026-11-23T12:00:00Z",
      },
      now,
      "en-GB",
    );
    expect(v).toMatchObject({ state: "trialing", trialDaysLeft: 7, action: "portal" });
    expect(v.headline).toBe("Free trial: 7 days left");
    expect(v.body.join(" ")).toMatch(
      /charged US\$9 plus any tax on 23 Nov 2026, and then every month/,
    );
    expect(v.body.join(" ")).toMatch(/Manage billing/);
  });
  it("a trial cancelled before it ends: never charged, access until the trial end", () => {
    const v = billingView(
      {
        ...base,
        status: "trialing",
        cancelAtPeriodEnd: true,
        access: { level: "full", reason: "trial", changesAt: "2026-11-23T12:00:00Z" },
        trialEndsAt: "2026-11-23T12:00:00Z",
      },
      now,
      "en-GB",
    );
    expect(v).toMatchObject({ state: "cancelling", action: "portal" });
    expect(v.body[0]).toMatch(/will not be charged/);
  });
  it("not started, trial available: the 7-day offer, the price in USD and the first charge date", () => {
    const v = billingView(
      {
        ...base,
        status: "trialing_local",
        offered,
        trialDays: 7,
        access: { level: "read_only", reason: "no_subscription", changesAt: null },
      },
      now,
      "en-GB",
    );
    expect(v).toMatchObject({ state: "not-started", action: "subscribe", trialDays: 7 });
    expect(v.headline).toBe("Start your 7-day free trial");
    expect(v.body[0]).toMatch(/US\$9 a month or US\$90 a year, charged in USD/);
    expect(v.body[1]).toBe(
      "You will not be charged until 23 Nov 2026. Cancel any time before then in Billing.",
    );
  });
  it("not started, trial already used: charged when subscribing; members are told to ask the owner", () => {
    const info: BillingInfo = {
      ...base,
      status: "trialing_local",
      offered,
      trialDays: null,
      access: { level: "read_only", reason: "no_subscription", changesAt: null },
    };
    const v = billingView(info, now, "en-GB");
    expect(v.headline).toBe("Choose a plan");
    expect(v.body[0]).toMatch(/already had a free trial/);
    expect(billingView({ ...info, role: "editor" }, now).body[0]).toMatch(/owner has not started/);
  });
  it("active: renews, manage in the portal", () => {
    const v = billingView(base, now, "en-GB");
    expect(v).toMatchObject({ state: "active", action: "portal" });
    expect(v.body[0]).toMatch(/renews on/);
  });
  it("cancelling at period end: access until then", () => {
    const v = billingView({ ...base, cancelAtPeriodEnd: true }, now, "en-GB");
    expect(v.state).toBe("cancelling");
    expect(v.headline).toMatch(/ends on/);
  });
  it("past due inside the grace period: still full access, fix the payment", () => {
    const v = billingView(
      {
        ...base,
        status: "past_due",
        access: { level: "full", reason: "past_due_grace", changesAt: "2026-11-20T00:00:00Z" },
      },
      now,
      "en-GB",
    );
    expect(v).toMatchObject({ state: "past-due", action: "portal" });
  });
  it.each([
    ["canceled", "subscribe", /subscription has ended/],
    ["past_due", "portal", /grace period is over/],
    ["unpaid", "portal", /Payment failed/],
    ["paused", "portal", /paused/],
    ["incomplete", "subscribe", /not completed/],
  ])("read-only (%s) tells the owner what to do", (reason, action, why) => {
    const v = billingView(
      { ...base, access: { level: "read_only", reason, changesAt: null } },
      now,
      "en-GB",
    );
    expect(v).toMatchObject({ state: "read-only", action });
    expect(v.body[0]).toMatch(why);
    expect(v.body.join(" ")).toMatch(/12 months/);
  });
  it("read-only: speaks to the owner directly, and points anyone else to the owner", () => {
    const ro: BillingInfo = {
      ...base,
      access: { level: "read_only", reason: "canceled", changesAt: null },
    };
    expect(billingView(ro, now, "en-GB").body.join(" ")).toMatch(/Subscribe below to edit again/);
    expect(billingView(ro, now, "en-GB").body.join(" ")).not.toMatch(/The owner can/);
    expect(billingView({ ...ro, role: "editor" }, now, "en-GB").body.join(" ")).toMatch(
      /The owner can subscribe/,
    );
  });
  it("suspended: no action, support address", () => {
    const v = billingView(
      { ...base, access: { level: "suspended", reason: "suspended", changesAt: null } },
      now,
    );
    expect(v).toMatchObject({ state: "suspended", action: "none" });
    expect(v.body.join(" ")).toMatch(/support@glideworth.com/);
  });
  it("banners: owner and member get different calls to action", () => {
    const trial = { level: "full", reason: "trial", changesAt: null };
    expect(bannerFor(trial, "2026-11-18T12:00:00Z", true, now)).toMatchObject({
      tone: "warning",
      cta: "Billing",
    });
    expect(bannerFor(trial, "2026-11-18T12:00:00Z", true, now)?.text).toMatch(
      /card is charged on .* unless you cancel in Billing/,
    );
    expect(bannerFor(trial, "2026-11-19T12:00:00Z", false, now)?.cta).toBeNull();
    expect(
      bannerFor({ level: "read_only", reason: "canceled", changesAt: null }, null, true),
    ).toMatchObject({ tone: "danger", cta: "Subscribe" });
    // Not started: the start-trial page says it all, no banner.
    expect(
      bannerFor({ level: "read_only", reason: "no_subscription", changesAt: null }, null, true),
    ).toBeNull();
    expect(
      bannerFor({ level: "read_only", reason: "past_due", changesAt: null }, null, true)?.cta,
    ).toBe("Fix payment");
    expect(
      bannerFor({ level: "read_only", reason: "canceled", changesAt: null }, null, false),
    ).toMatchObject({ tone: "danger", cta: null });
    expect(bannerFor({ level: "full", reason: "active", changesAt: null }, null, true)).toBeNull();
    expect(
      bannerFor({ level: "suspended", reason: "suspended", changesAt: null }, null, true),
    ).toBeNull();
  });
});

describe("402 and 429 reporting", () => {
  it("reports read-only and quota answers, and nothing else", () => {
    const seen: unknown[] = [];
    const off = onApiProblem((p) => seen.push(p));
    reportApiProblem(402, "ACCOUNT_READ_ONLY", {
      reason: "canceled",
      billingUrl: "/settings/billing",
    });
    reportApiProblem(429, "QUOTA_EXCEEDED", {
      metric: "job",
      limit: 100,
      resetsAt: "2026-11-17T00:00:00Z",
    });
    reportApiProblem(429, "RATE_LIMITED", {});
    reportApiProblem(403, "FORBIDDEN", null);
    reportApiProblem(402, "SOMETHING", null);
    off();
    expect(seen).toEqual([
      { kind: "read-only", reason: "canceled" },
      { kind: "quota", metric: "job", limit: 100, resetsAt: "2026-11-17T00:00:00Z" },
    ]);
  });
  it("says which limit and when it resets, when the API says", () => {
    const s = describeQuota(
      { kind: "quota", metric: "job", limit: 100, resetsAt: "2026-11-17T00:00:00Z" },
      "en-GB",
    );
    expect(s).toMatch(/limit of 100 for background jobs/);
    expect(s).toMatch(/resets .*2026/);
    expect(describeQuota({ kind: "quota" })).toMatch(/resets daily/);
  });
});

describe("QR code (drawn locally)", () => {
  it("makes a square matrix with the three finder patterns and timing line", () => {
    const m = encodeQr(
      "otpauth://totp/Glideworth:ada@example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Glideworth",
    );
    const n = m.length;
    expect([21, 25, 29, 33, 37, 41, 45, 49, 53, 57]).toContain(n);
    expect(m.every((r) => r.length === n)).toBe(true);
    for (const [x, y] of [
      [0, 0],
      [n - 7, 0],
      [0, n - 7],
    ] as const) {
      expect(m[y]![x]).toBe(true);
      expect(m[y + 3]![x + 3]).toBe(true);
      expect(m[y + 1]![x + 1]).toBe(false);
      expect(m[y + 6]![x + 6]).toBe(true);
    }
    expect(m[6]![8]).toBe(true);
    expect(m[6]![9]).toBe(false);
    expect(m[n - 8]![8]).toBe(true); // the always-dark module
  });
  it("is deterministic and grows with the text", () => {
    expect(encodeQr("hello")).toEqual(encodeQr("hello"));
    expect(encodeQr("x".repeat(150)).length).toBeGreaterThan(encodeQr("hello").length);
    expect(() => encodeQr("x".repeat(400))).toThrow();
  });
});

describe("formatting", () => {
  it("counts whole trial days left as Stripe does, and prices in minor units", () => {
    // A 30-day trial a few minutes after it started: Stripe Checkout says "29 days free".
    expect(daysLeft("2026-12-17T05:41:00Z", new Date("2026-11-17T05:44:00Z"))).toBe(29);
    expect(daysLeft("2026-12-17T05:41:00Z", new Date("2026-11-17T05:41:00Z"))).toBe(30);
    expect(daysLeft("2026-11-17T01:00:00Z", new Date("2026-11-16T12:00:00Z"))).toBe(0);
    expect(daysLeft("2026-11-10T00:00:00Z", new Date("2026-11-16T12:00:00Z"))).toBe(0);
    expect(daysText(0)).toBe("less than a day");
    expect(daysText(1)).toBe("1 day");
    expect(daysText(29)).toBe("29 days");
    expect(fmtPrice(900, "usd", "en-US")).toBe("$9");
    expect(fmtPrice(9000, "usd", "en-US")).toBe("$90");
    expect(fmtPrice(950, "gbp", "en-GB")).toBe("£9.50");
  });
});
