import { describe, expect, it } from "vitest";
import { render, SUBJECTS, TEMPLATE_CATEGORY, TEMPLATE_IDS } from "../src/index.js";
import { CHECKIN_CTX, CTX, FIXTURES, FIXTURES_ALT } from "./fixtures.js";

const ctxFor = (id: (typeof TEMPLATE_IDS)[number]) =>
  TEMPLATE_CATEGORY[id] === "checkin" ? CHECKIN_CTX : CTX;

describe("no financial figures in subjects (spec 5.3)", () => {
  it.each(TEMPLATE_IDS)(
    "%s: subject identical across fixtures that differ in every field",
    (id) => {
      const a = render(id, FIXTURES[id] as never, ctxFor(id));
      const b = render(id, FIXTURES_ALT[id] as never, ctxFor(id));
      expect(a.subject).toBe(b.subject);
      expect(a.subject).toBe(SUBJECTS[id]);
    },
  );

  it("every subject is a plain literal: no digits, currency symbols, percentages or placeholders", () => {
    for (const id of TEMPLATE_IDS) {
      expect(SUBJECTS[id]).toMatch(/^[A-Za-z][A-Za-z' :-]*$/);
    }
  });

  it("subjects are frozen and cannot be changed by a caller", () => {
    expect(Object.isFrozen(SUBJECTS)).toBe(true);
  });

  it("hostile data cannot reach a subject", () => {
    const r = render(
      "invitation",
      { ...FIXTURES.invitation, inviterName: "x\r\nBcc: a@b.test", workspaceName: "£1,000,000" },
      CTX,
    );
    expect(r.subject).toBe(SUBJECTS.invitation);
  });
});

describe("checkin-summary has no amounts (spec 5.3)", () => {
  const alt = render("checkin-summary", FIXTURES_ALT["checkin-summary"], CHECKIN_CTX);

  it("does not contain any fixture free text or figure", () => {
    for (const s of ["£", "48,000", "7.5", "%", "Alex"]) {
      expect(alt.text).not.toContain(s);
      expect(alt.html).not.toContain(s);
    }
  });

  it("contains only the plan count and kinds of change", () => {
    expect(alt.text).toContain("We checked 12 plans.");
    expect(alt.text).toContain("At least one plan is behind plan.");
    // The only digits are the plan count and the link/token.
    const withoutLinks = alt.text.replace(/https?:\/\/\S+/g, "");
    expect(withoutLinks.replace(/12/, "")).not.toMatch(/\d/);
  });
});
