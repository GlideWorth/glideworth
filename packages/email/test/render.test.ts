import { describe, expect, it } from "vitest";
import {
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
  it("covers every template in the spec (17) and the account deletion notice", () => {
    expect(TEMPLATE_IDS).toHaveLength(18);
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

  it("security-change covers all eleven kinds with distinct text", () => {
    const kinds = [
      "password-changed",
      "password-reset",
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
    expect(new Set(bodies).size).toBe(11);
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
