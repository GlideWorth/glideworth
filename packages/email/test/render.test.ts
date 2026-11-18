import { describe, expect, it } from "vitest";
import {
  dateText,
  EmailValidationError,
  render,
  SUBJECTS,
  TEMPLATE_CATEGORY,
  TEMPLATE_IDS,
} from "../src/index.js";
import { CHECKIN_CTX, CTX, FIXTURES } from "./fixtures.js";

const ctxFor = (id: (typeof TEMPLATE_IDS)[number]) =>
  TEMPLATE_CATEGORY[id] === "checkin" ? CHECKIN_CTX : CTX;

describe("templates", () => {
  it("covers every template in the spec (17), the account deletion, email change request and removal notices, the two-step guessing alert and the first-password link", () => {
    expect(TEMPLATE_IDS).toHaveLength(22);
    expect(Object.keys(FIXTURES).sort()).toEqual([...TEMPLATE_IDS].sort());
  });

  it("only checkin-summary is non-essential", () => {
    expect(TEMPLATE_IDS.filter((i) => TEMPLATE_CATEGORY[i] !== "essential")).toEqual([
      "checkin-summary",
    ]);
  });

  describe.each(TEMPLATE_IDS)("%s", (id) => {
    const r = render(id, FIXTURES[id] as never, ctxFor(id));

    it("text snapshot", () => {
      expect(`Subject: ${r.subject}\n\n${r.text}`).toMatchSnapshot();
    });

    it("has a static subject from the registry and the right category", () => {
      expect(r.subject).toBe(SUBJECTS[id]);
      expect(r.category).toBe(TEMPLATE_CATEGORY[id]);
    });

    it("html is simple, accessible and self-contained", () => {
      const h = r.html;
      expect(h.startsWith("<!doctype html>")).toBe(true);
      expect(h).toContain('<html lang="en">');
      expect(h).toContain('<meta charset="utf-8">');
      expect(h).toContain(`<title>${SUBJECTS[id]}</title>`);
      expect((h.match(/<h1[ >]/g) ?? []).length).toBe(1);
      expect(h).toContain('style="');
      // No images, scripts, remote resources, forms or trackers.
      expect(h).not.toMatch(/<(img|script|link|iframe|form|object|embed|video|audio|style)\b/i);
      expect(h).not.toMatch(/\bsrc\s*=/i);
      expect(h).not.toMatch(/url\(/i);
      expect(h).not.toMatch(/@import/i);
    });

    it("every link is https or on the public URL, and every link in html is also in the text", () => {
      const hrefs = [...r.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? "");
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        if (href.startsWith("mailto:")) continue;
        const u = new URL(href.replace(/&amp;/g, "&"));
        expect(u.protocol === "https:" || u.origin === new URL(CTX.appUrl).origin).toBe(true);
        expect(r.text).toContain(href.replace(/&amp;/g, "&"));
      }
    });

    it("text has branding, support address and no html", () => {
      expect(r.text).toContain("Glideworth");
      expect(r.text).toContain(CTX.supportEmail);
      expect(r.text).not.toMatch(/<[a-z/][^>]*>/i);
    });

    it("unsubscribe footer only on non-essential mail", () => {
      if (TEMPLATE_CATEGORY[id] === "checkin") {
        expect(r.text).toContain("Unsubscribe: https://app.example.test/email/unsubscribe");
        expect(r.html).toContain(">Unsubscribe</a>");
      } else {
        const withUnsub = render(id, FIXTURES[id] as never, {
          ...CTX,
          unsubscribeUrl: CHECKIN_CTX.unsubscribeUrl,
        });
        expect(withUnsub.text).not.toContain("unsubscribe?t=");
        expect(withUnsub.html).not.toContain("unsubscribe?t=");
        expect(r.text).toContain("cannot unsubscribe");
      }
    });
  });

  it("security-change covers all twelve kinds with distinct text", () => {
    const kinds = [
      "password-changed",
      "password-reset",
      "password-set",
      "email-changed",
      "totp-enabled",
      "totp-disabled",
      "recovery-codes-regenerated",
      "recovery-code-used",
      "api-key-created",
      "mcp-app-connected",
      "ownership-transferred",
      "support-access-used",
    ] as const;
    const bodies = kinds.map(
      (change) => render("security-change", { ...FIXTURES["security-change"], change }, CTX).text,
    );
    expect(new Set(bodies).size).toBe(12);
  });

  it("password-setup invites a first password and never uses reset wording; password-reset keeps it", () => {
    const setup = render("password-setup", FIXTURES["password-setup"], CTX);
    expect(setup.subject).toBe("Set a password for your Glideworth account");
    expect(setup.category).toBe("essential");
    expect(setup.text).toContain("Set a password for your Glideworth account");
    expect(setup.text).toContain("Set your password");
    expect(setup.text).toContain("https://app.example.test/set-password?t=sample-token");
    expect(setup.text.toLowerCase()).not.toContain("reset");
    expect(setup.html.toLowerCase()).not.toContain("reset");
    expect(setup.text).not.toContain("\u2014");
    const reset = render("password-reset", FIXTURES["password-reset"], CTX);
    expect(reset.subject).toBe("Reset your Glideworth password");
    expect(reset.text).toContain("We received a request to reset the password");
    expect(reset.text).toContain("Choose a new password");
  });

  it("second-factor-failures says what happened and links to the password reset and security settings (finding 8)", () => {
    const r = render("second-factor-failures", FIXTURES["second-factor-failures"], CTX);
    expect(r.subject).toBe("Someone is guessing your Glideworth two-step code");
    expect(r.category).toBe("essential");
    expect(r.text).toContain(
      "Someone entered the wrong two-step code 10 times. They have your password. Change it now.",
    );
    expect(r.text).toContain("https://app.example.test/forgot-password?t=sample-token");
    expect(r.text).toContain("https://app.example.test/settings/security?t=sample-token");
    expect(r.text).not.toContain("\u2014");
  });

  it("user-account-deleted is about the person's account, not a workspace (QA 14)", () => {
    const r = render("user-account-deleted", FIXTURES["user-account-deleted"], CTX);
    expect(r.subject).toBe("Your Glideworth account has been deleted");
    expect(r.text).toContain("Your Glideworth account was deleted on 16 November 2026.");
    expect(r.text).toContain("signed out everywhere");
    expect(r.text).toContain("If you did not ask for this, write to support@example.test");
    expect(r.text).not.toMatch(/workspace "|backup/i);
  });

  it("rejects an unknown security change, role and change kind", () => {
    expect(() =>
      render("security-change", { ...FIXTURES["security-change"], change: "nope" as never }, CTX),
    ).toThrow(EmailValidationError);
    expect(() =>
      render("invitation", { ...FIXTURES.invitation, role: "owner" as never }, CTX),
    ).toThrow(EmailValidationError);
    expect(() =>
      render(
        "checkin-summary",
        { ...FIXTURES["checkin-summary"], changeKinds: ["toString" as never] },
        CHECKIN_CTX,
      ),
    ).toThrow(EmailValidationError);
  });

  it("rejects bad numbers", () => {
    for (const daysLeft of [0, 1.5, -3])
      expect(() =>
        render("deletion-warning", { ...FIXTURES["deletion-warning"], daysLeft }, CTX),
      ).toThrow(EmailValidationError);
    expect(() =>
      render("verify-email", { ...FIXTURES["verify-email"], expiresInHours: 0 }, CTX),
    ).toThrow(EmailValidationError);
    expect(() =>
      render("verify-email", { ...FIXTURES["verify-email"], expiresInHours: 1.5 }, CTX),
    ).toThrow(EmailValidationError);
    expect(() =>
      render("checkin-summary", { ...FIXTURES["checkin-summary"], plansChecked: -1 }, CHECKIN_CTX),
    ).toThrow(EmailValidationError);
  });

  it("pluralises", () => {
    expect(
      render("verify-email", { ...FIXTURES["verify-email"], expiresInHours: 1 }, CTX).text,
    ).toContain("1 hour.");
    expect(render("invitation", { ...FIXTURES.invitation, expiresInDays: 1 }, CTX).text).toContain(
      "1 day.",
    );
  });

  it("checkin-summary with no changes says so", () => {
    const r = render(
      "checkin-summary",
      { ...FIXTURES["checkin-summary"], changeKinds: [], plansChecked: 1 },
      CHECKIN_CTX,
    );
    expect(r.text).toContain("We checked 1 plan.");
    expect(r.text).toContain("Nothing needs your attention.");
  });

  it("renewal-reminder carries the date and a link but never an amount", () => {
    const r = render("renewal-reminder", FIXTURES["renewal-reminder"], CTX);
    expect(r.text).toContain("30 November 2026");
    expect(r.text).toContain("https://app.example.test/billing");
    expect(r.text).toContain("14 days");
    expect(r.text).not.toMatch(/[£$€]|\d+\.\d\d|per year|a year/i);
    expect("amountText" in FIXTURES["renewal-reminder"]).toBe(false);
  });

  it("deletion-warning names the date, the days left and both links", () => {
    for (const daysLeft of [30, 7, 1]) {
      const r = render("deletion-warning", { ...FIXTURES["deletion-warning"], daysLeft }, CTX);
      expect(r.text).toContain(`in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}`);
      expect(r.text).toContain("16 November 2027");
      expect(r.text).toContain("https://app.example.test/billing");
      expect(r.text).toContain("https://app.example.test/settings/workspace");
      expect(r.subject).toBe(SUBJECTS["deletion-warning"]);
    }
  });

  it("support-access-used does not tell the owner to secure the account", () => {
    const r = render(
      "security-change",
      { ...FIXTURES["security-change"], change: "support-access-used" },
      CTX,
    );
    expect(r.text).toContain("support");
    expect(r.text).not.toContain("secure your account");
  });
});

describe("dates and times", () => {
  it("formats ISO dates and timestamps unambiguously, in UTC, and leaves other text alone", () => {
    expect(dateText("2026-11-18T06:00:00.000Z", "at")).toBe("18 November 2026, 06:00 UTC");
    expect(dateText("2026-11-17T05:51:45.364Z", "at")).toBe("17 November 2026, 05:51 UTC");
    expect(dateText("2026-11-18T07:30:00+01:00", "at")).toBe("18 November 2026, 06:30 UTC");
    expect(dateText("2026-12-01", "on")).toBe("1 December 2026");
    expect(dateText("16 November 2026", "on")).toBe("16 November 2026");
    expect(dateText("2026-13-45", "on")).toBe("2026-13-45");
  });

  it("no email shows a raw ISO timestamp", () => {
    const iso = "2026-11-18T05:54:51.238Z";
    const data: Record<string, Record<string, unknown>> = {
      "security-change": { ...FIXTURES["security-change"], at: iso },
      "signin-alert": { ...FIXTURES["signin-alert"], at: iso },
      "second-factor-failures": { ...FIXTURES["second-factor-failures"], at: iso },
      "export-ready": { ...FIXTURES["export-ready"], expiresAt: iso },
      "email-change-requested": { ...FIXTURES["email-change-requested"], at: iso },
      "account-deleted": { ...FIXTURES["account-deleted"], deletedAt: iso, backupsPurgedBy: iso },
      "user-account-deleted": { ...FIXTURES["user-account-deleted"], deletedAt: iso },
      "trial-ending": { ...FIXTURES["trial-ending"], trialEndsOn: iso },
      "renewal-reminder": { ...FIXTURES["renewal-reminder"], renewsOn: iso },
      "payment-problem": { ...FIXTURES["payment-problem"], readOnlyFrom: iso },
      "subscription-canceled": { ...FIXTURES["subscription-canceled"], accessUntil: iso },
      "deletion-warning": { ...FIXTURES["deletion-warning"], deletesOn: iso },
    };
    for (const [id, d] of Object.entries(data)) {
      const r = render(id as never, d as never, CTX);
      expect(r.text, id).not.toContain("2026-11-18T");
      expect(r.text, id).toContain("18 November 2026, 05:54 UTC");
    }
  });
});

describe("change of email address", () => {
  it("the request notice says a change was asked for, to which address, and what to do if it was not you", () => {
    const r = render("email-change-requested", FIXTURES["email-change-requested"], CTX);
    expect(r.subject).toBe("Someone asked to change your Glideworth email address");
    expect(r.text).toContain("asked to change its email address to sam.new@example.test");
    expect(r.text).toContain("Nothing has changed yet.");
    expect(r.text).toContain("If you did not, change your password now");
    expect(r.text).toContain("16 November 2026, 09:14 UTC");
    expect(r.text).not.toMatch(/was changed/);
  });

  it("the confirmation notice names the new address", () => {
    const r = render(
      "security-change",
      { ...FIXTURES["security-change"], change: "email-changed", newEmail: "sam.new@example.test" },
      CTX,
    );
    expect(r.text).toContain(
      "The email address on your account was changed to sam.new@example.test.",
    );
  });

  it("rejects a hostile new address in the request notice", () => {
    expect(() =>
      render(
        "email-change-requested",
        { ...FIXTURES["email-change-requested"], newEmail: "a@b.test\r\nBcc: x@y.test" },
        CTX,
      ),
    ).toThrow(EmailValidationError);
  });
});

describe("removal from a workspace", () => {
  it("names the workspace and nothing else from it", () => {
    const r = render("member-removed", FIXTURES["member-removed"], CTX);
    expect(r.subject).toBe("You have been removed from a Glideworth workspace");
    expect(r.text).toContain(
      'The owner of the Glideworth workspace "Sample household" has removed you',
    );
    expect(r.text).toContain("Your own Glideworth account is not affected");
  });
});

describe("trial-ending", () => {
  it("without a card says nothing is charged and the workspace becomes read-only", () => {
    const r = render("trial-ending", FIXTURES["trial-ending"], CTX);
    expect(r.text).toContain("nothing will be charged");
    expect(r.text).toContain("read-only");
    expect(r.text).not.toContain("Cancel subscription");
  });

  it("after subscribing during the trial names the first charge and how to cancel", () => {
    const r = render(
      "trial-ending",
      { ...FIXTURES["trial-ending"], amountText: "$90.00 USD a year" },
      CTX,
    );
    expect(r.text).toContain("we will charge $90.00 USD a year");
    expect(r.text).toContain("Cancel subscription");
    expect(r.text).not.toContain("read-only");
  });
});
