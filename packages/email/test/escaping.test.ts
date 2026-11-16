import { describe, expect, it } from "vitest";
import {
  createMailer,
  EmailValidationError,
  hmacUnsubscribeSigner,
  memoryEmailLog,
  memorySuppressionStore,
  memoryTransport,
  render,
  TEMPLATE_CATEGORY,
  TEMPLATE_IDS,
} from "../src/index.js";
import { CHECKIN_CTX, CTX, FIXTURES } from "./fixtures.js";

const EVIL = `<script>alert("x")</script>&'"<img src=x onerror=alert(1)>`;

// Free-text string fields per template (everything that is not a URL, enum or number).
const FREE_TEXT_FIELDS: Record<string, string[]> = {
  "verify-email": ["name"],
  "password-reset": ["name"],
  "email-change-confirm": ["name"],
  "signin-alert": ["name", "at", "device", "ip"],
  "security-change": ["name", "at"],
  invitation: ["inviterName", "workspaceName"],
  "trial-ending": ["name", "trialEndsOn"],
  "trial-expired": ["name"],
  "renewal-reminder": ["name", "renewsOn"],
  "payment-receipt": ["name", "amountText"],
  "payment-problem": ["name", "readOnlyFrom"],
  "subscription-canceled": ["name", "accessUntil"],
  "export-ready": ["name", "expiresAt"],
  "deletion-warning": ["name", "workspaceName", "deletesOn"],
  "account-deleted": ["name", "workspaceName", "deletedAt", "backupsPurgedBy"],
};

describe("HTML escaping of every interpolated string", () => {
  for (const [id, fields] of Object.entries(FREE_TEXT_FIELDS)) {
    for (const f of fields) {
      it(`${id}.${f}`, () => {
        const data = { ...(FIXTURES as Record<string, object>)[id], [f]: EVIL };
        const r = render(id as never, data as never, CTX);
        expect(r.html).not.toContain("<script");
        expect(r.html).not.toContain("<img");
        expect(r.html).not.toContain("onerror=alert(1)>");
        expect(r.html).toContain("&lt;script&gt;");
        expect(r.html).toContain("&quot;");
        expect(r.html).toContain("&#39;");
      });
    }
  }

  it("escapes the product name and the new email address context", () => {
    const r = render("verify-email", FIXTURES["verify-email"], {
      ...CTX,
      productName: "<b>Glide</b>",
    });
    expect(r.html).not.toContain("<b>Glide");
    expect(r.html).toContain("&lt;b&gt;Glide");
  });

  it("escapes ampersands and quotes inside URLs placed in attributes", () => {
    const r = render(
      "verify-email",
      { ...FIXTURES["verify-email"], url: 'https://app.example.test/v?a=1&b="2"' },
      CTX,
    );
    // The URL parser percent-encodes the quote; the ampersand is escaped for HTML.
    expect(r.html).toContain("a=1&amp;b=%222%22");
    expect(r.html).not.toMatch(/href="[^"]*"[^>]*"2"/);
  });
});

describe("newlines in free text are neutralised in the body", () => {
  it("collapses CR/LF, tabs and unicode line separators to a single space", () => {
    const r = render(
      "verify-email",
      { ...FIXTURES["verify-email"], name: "Sam\r\nBcc: attacker@example.test x\ty" },
      CTX,
    );
    expect(r.text).toContain("Hello Sam Bcc: attacker@example.test x y,");
    expect(r.text.split("\n").some((l) => l.startsWith("Bcc:"))).toBe(false);
  });

  it("truncates very long values", () => {
    const r = render("verify-email", { ...FIXTURES["verify-email"], name: "a".repeat(5000) }, CTX);
    expect(r.text.length).toBeLessThan(2000);
  });
});

describe("URL validation", () => {
  const bad = [
    "http://evil.example.test/x",
    "javascript:alert(1)",
    "data:text/html,hi",
    "ftp://example.test/x",
    "https://user:pw@app.example.test/x",
    "https://app.example.test/x\r\nBcc: a@b.test",
    "https://app.example.test/ x",
    "https://app.example.test/x\ny",
    "//evil.example.test",
    "/relative",
    "",
    "not a url",
  ];
  it.each(bad)("rejects %j", (url) => {
    expect(() => render("verify-email", { ...FIXTURES["verify-email"], url }, CTX)).toThrow(
      EmailValidationError,
    );
  });

  it("accepts https anywhere and http only on the configured public URL", () => {
    const dev = { ...CTX, appUrl: "http://localhost:5173" };
    expect(() =>
      render(
        "verify-email",
        { ...FIXTURES["verify-email"], url: "http://localhost:5173/v?t=1" },
        dev,
      ),
    ).not.toThrow();
    expect(() =>
      render("verify-email", { ...FIXTURES["verify-email"], url: "http://localhost:9999/v" }, dev),
    ).toThrow();
    expect(() =>
      render(
        "verify-email",
        { ...FIXTURES["verify-email"], url: "https://elsewhere.example.test/v" },
        CTX,
      ),
    ).not.toThrow();
  });

  it("validates every URL field of every template, and the unsubscribe URL", () => {
    for (const id of TEMPLATE_IDS) {
      const data = FIXTURES[id] as Record<string, unknown>;
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === "string" && v.startsWith("https://")) {
          const ctx = TEMPLATE_CATEGORY[id] === "checkin" ? CHECKIN_CTX : CTX;
          expect(
            () => render(id, { ...data, [k]: "javascript:alert(1)" } as never, ctx),
            `${id}.${k}`,
          ).toThrow(EmailValidationError);
        }
      }
    }
    expect(() =>
      render("checkin-summary", FIXTURES["checkin-summary"], {
        ...CTX,
        unsubscribeUrl: "http://evil.example.test/u",
      }),
    ).toThrow(EmailValidationError);
  });

  it("rejects an invalid new email address in email-change-confirm", () => {
    expect(() =>
      render(
        "email-change-confirm",
        { ...FIXTURES["email-change-confirm"], newEmail: "a@b.test\r\nBcc: x@y.test" },
        CTX,
      ),
    ).toThrow(EmailValidationError);
  });
});

describe("header injection through the mailer", () => {
  const setup = () => {
    const transport = memoryTransport();
    const log = memoryEmailLog();
    const mailer = createMailer({
      transport,
      from: { email: "no-reply@example.test", name: "Glideworth" },
      context: CTX,
      suppressions: memorySuppressionStore(),
      log,
      unsubscribe: hmacUnsubscribeSigner({ key: new Uint8Array(32).fill(7), baseUrl: CTX.appUrl }),
      retryDelaysMs: [0, 0, 0],
    });
    return { transport, log, mailer };
  };

  it.each([
    "victim@example.test\r\nBcc: attacker@example.test",
    "victim@example.test\nBcc: attacker@example.test",
    "victim@example.test,attacker@example.test",
    "a b@example.test",
    '"victim"@example.test',
    "victim@example.test>",
    "not-an-email",
    "",
  ])("rejects recipient address %j", async (email) => {
    const { mailer, transport, log } = setup();
    const out = await mailer.send({ email }, "verify-email", FIXTURES["verify-email"]);
    expect(out).toEqual({ status: "failed", code: "invalid_address" });
    expect(transport.sent).toHaveLength(0);
    expect(log.entries[0]?.status).toBe("failed");
  });

  it.each(["Sam\r\nBcc: attacker@example.test", "Sam\nx", "Sam\u0000"])(
    "rejects recipient name %j",
    async (name) => {
      const { mailer, transport } = setup();
      const out = await mailer.send(
        { email: "sam@example.test", name },
        "verify-email",
        FIXTURES["verify-email"],
      );
      expect(out).toEqual({ status: "failed", code: "invalid_address" });
      expect(transport.sent).toHaveLength(0);
    },
  );

  it("a hostile name inside template data cannot add headers or change the subject", async () => {
    const { mailer, transport } = setup();
    const out = await mailer.send({ email: "sam@example.test" }, "verify-email", {
      ...FIXTURES["verify-email"],
      name: "Sam\r\nBcc: attacker@example.test\r\nSubject: hijack",
    });
    expect(out.status).toBe("sent");
    const m = transport.sent[0];
    expect(m?.subject).toBe("Confirm your email address for Glideworth");
    expect(JSON.stringify(m?.headers)).not.toMatch(/[\r\n]/);
    expect(Object.keys(m?.headers ?? {})).toEqual(["Auto-Submitted"]);
  });

  it("rejects an invalid configured from address", async () => {
    const transport = memoryTransport();
    const mailer = createMailer({
      transport,
      from: { email: "bad\r\nx@example.test" },
      context: CTX,
      suppressions: memorySuppressionStore(),
      unsubscribe: hmacUnsubscribeSigner({ key: new Uint8Array(32), baseUrl: CTX.appUrl }),
    });
    expect(
      await mailer.send({ email: "sam@example.test" }, "verify-email", FIXTURES["verify-email"]),
    ).toEqual({
      status: "failed",
      code: "invalid_address",
    });
  });

  it("does not throw on malformed template data: returns a failed outcome", async () => {
    const { mailer, transport } = setup();
    const out = await mailer.send({ email: "sam@example.test" }, "verify-email", {
      ...FIXTURES["verify-email"],
      url: "javascript:alert(1)",
    });
    expect(out).toEqual({ status: "failed", code: "invalid_url" });
    expect(transport.sent).toHaveLength(0);
  });
});
