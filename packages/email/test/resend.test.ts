import { describe, expect, it } from "vitest";
import {
  createMailer,
  EmailTransportError,
  hmacUnsubscribeSigner,
  memorySuppressionStore,
  type OutgoingEmail,
  render,
  resendTransport,
} from "../src/index.js";
import { CHECKIN_CTX, CTX, FIXTURES } from "./fixtures.js";

function message(over: Partial<OutgoingEmail> = {}): OutgoingEmail {
  const r = render("verify-email", FIXTURES["verify-email"], CTX);
  return {
    to: { email: "sam@example.test", name: "Sam Example" },
    from: { email: "no-reply@example.test", name: "Glideworth" },
    subject: r.subject,
    text: r.text,
    html: r.html,
    headers: { "Auto-Submitted": "auto-generated" },
    category: "essential",
    template: "verify-email",
    ...over,
  };
}

type Call = { url: string; init: RequestInit; body: Record<string, unknown>; at: number };
/** A fake Resend API: records each request and answers with `respond`. */
function fakeResend(respond: (n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      at: Date.now(),
    });
    return respond(calls.length);
  }) as typeof fetch;
  return { f, calls };
}
const ok = () => new Response(JSON.stringify({ id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }));
const error = (status: number, name: string, message = "x", headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ statusCode: status, name, message }), { status, headers });

describe("resendTransport", () => {
  it("posts JSON to the Resend API with a bearer key, headers, tag and idempotency key", async () => {
    const { f, calls } = fakeResend(ok);
    const t = resendTransport({ apiKey: "re_secret", fetch: f, minIntervalMs: 0 });
    const res = await t.send(
      message({
        replyTo: { email: "help@example.test", name: 'Help "Desk"' },
        headers: { "X-Test": "1", "Auto-Submitted": "auto-generated" },
        idempotencyKey: "outbox-123",
      }),
    );
    expect(res).toEqual({ providerMessageId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" });
    const c = calls[0] as Call;
    expect(c.url).toBe("https://api.resend.com/emails");
    expect(c.init.method).toBe("POST");
    const h = c.init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer re_secret");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["Idempotency-Key"]).toBe("outbox-123");
    expect(c.init.signal).toBeInstanceOf(AbortSignal);
    expect(c.body.from).toBe('"Glideworth" <no-reply@example.test>');
    expect(c.body.to).toEqual(['"Sam Example" <sam@example.test>']);
    expect(c.body.reply_to).toBe('"Help \\"Desk\\"" <help@example.test>');
    expect(c.body.subject).toBe("Confirm your email address for Glideworth");
    expect(String(c.body.text)).toContain("Confirm email address");
    expect(String(c.body.html)).toContain("<!doctype html>");
    expect(c.body.headers).toEqual({ "X-Test": "1", "Auto-Submitted": "auto-generated" });
    expect(c.body.tags).toEqual([{ name: "template", value: "verify-email" }]);
    expect(String(c.init.body)).not.toContain("re_secret");
  });

  it("sends List-Unsubscribe headers for check-in mail and no idempotency key when none is given", async () => {
    const { f, calls } = fakeResend(ok);
    const r = render("checkin-summary", FIXTURES["checkin-summary"], CHECKIN_CTX);
    await resendTransport({ apiKey: "k", fetch: f, minIntervalMs: 0 }).send(
      message({
        category: "checkin",
        template: "checkin-summary",
        subject: r.subject,
        text: r.text,
        html: r.html,
        headers: {
          "List-Unsubscribe": "<https://app.example.test/email/unsubscribe?t=abc>",
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    );
    expect(calls[0]?.body.headers).toEqual({
      "List-Unsubscribe": "<https://app.example.test/email/unsubscribe?t=abc>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    const sent = calls[0] as Call;
    expect((sent.init.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
  });

  it("succeeds with a null id when the body is not JSON", async () => {
    const { f } = fakeResend(() => new Response("ok", { status: 200 }));
    const t = resendTransport({ apiKey: "k", fetch: f, minIntervalMs: 0 });
    expect(await t.send(message())).toEqual({ providerMessageId: null });
  });

  describe("error mapping", () => {
    const cases: [string, () => Response, string, boolean][] = [
      ["429 rate limit", () => error(429, "rate_limit_exceeded"), "rate_limited", true],
      ["429 daily quota", () => error(429, "daily_quota_exceeded"), "quota_exceeded", false],
      ["429 monthly quota", () => error(429, "monthly_quota_exceeded"), "quota_exceeded", false],
      [
        "409 in progress",
        () => error(409, "concurrent_idempotent_requests"),
        "idempotency_busy",
        true,
      ],
      ["500", () => error(500, "internal_server_error"), "provider_error", true],
      ["502", () => new Response("bad gateway", { status: 502 }), "provider_error", true],
      ["400", () => error(400, "validation_error"), "rejected", false],
      ["401", () => error(401, "missing_api_key"), "auth", false],
      ["403", () => error(403, "invalid_api_key"), "auth", false],
      ["404", () => error(404, "not_found"), "not_found", false],
      ["422", () => error(422, "invalid_from_address"), "rejected", false],
    ];
    it.each(cases)("%s", async (_n, respond, code, retryable) => {
      const { f } = fakeResend(respond);
      const err = await resendTransport({ apiKey: "re_secret", fetch: f, minIntervalMs: 0 })
        .send(message())
        .catch((e) => e);
      expect(err).toBeInstanceOf(EmailTransportError);
      expect(err).toMatchObject({ transport: "resend", code, retryable });
      expect(err.message).not.toContain("re_secret");
    });

    it("never puts the key or an address in the error message", async () => {
      const { f } = fakeResend(() =>
        error(422, "validation_error", "Invalid `to` field: sam@example.test (key re_secret)"),
      );
      const err = await resendTransport({ apiKey: "re_secret", fetch: f, minIntervalMs: 0 })
        .send(message())
        .catch((e) => e);
      expect(err.message).toContain("validation_error");
      expect(err.message).not.toContain("sam@example.test");
      expect(err.message).not.toContain("re_secret");
    });

    it("a 409 for a key already used with another payload counts as sent", async () => {
      const { f } = fakeResend(() => error(409, "invalid_idempotent_request"));
      const t = resendTransport({ apiKey: "k", fetch: f, minIntervalMs: 0 });
      expect(await t.send(message({ idempotencyKey: "a" }))).toEqual({ providerMessageId: null });
    });

    it("network failure and timeouts are retryable and do not leak the cause", async () => {
      const f = (async () => {
        throw new TypeError("fetch failed: connect ECONNREFUSED re_secret");
      }) as typeof fetch;
      const err = await resendTransport({ apiKey: "re_secret", fetch: f, minIntervalMs: 0 })
        .send(message())
        .catch((e) => e);
      expect(err).toMatchObject({ code: "network", retryable: true });
      expect(err.message).not.toContain("re_secret");
    });

    it("aborts a request that takes longer than timeoutMs", async () => {
      const f = ((_u: unknown, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(init.signal?.reason));
        })) as typeof fetch;
      const err = await resendTransport({ apiKey: "k", fetch: f, minIntervalMs: 0, timeoutMs: 20 })
        .send(message())
        .catch((e) => e);
      expect(err).toMatchObject({ code: "network", retryable: true });
    });
  });

  describe("rate limits", () => {
    it("paces requests at least minIntervalMs apart", async () => {
      const { f, calls } = fakeResend(ok);
      const t = resendTransport({ apiKey: "k", fetch: f, minIntervalMs: 40 });
      await Promise.all([t.send(message()), t.send(message()), t.send(message())]);
      expect(calls).toHaveLength(3);
      const [a, b, c] = calls.map((x) => x.at) as [number, number, number];
      expect(b - a).toBeGreaterThanOrEqual(35);
      expect(c - b).toBeGreaterThanOrEqual(35);
    });

    it("holds later sends back after a 429 with Retry-After", async () => {
      const { f, calls } = fakeResend((n) =>
        n === 1 ? error(429, "rate_limit_exceeded", "x", { "retry-after": "0.08" }) : ok(),
      );
      const t = resendTransport({ apiKey: "k", fetch: f, minIntervalMs: 0 });
      await t.send(message()).catch(() => undefined);
      await t.send(message());
      const [a, b] = calls.map((x) => x.at) as [number, number];
      expect(b - a).toBeGreaterThanOrEqual(70);
    });

    it("reads Retry-After on a 429, caps it, and the mailer waits at least that long", async () => {
      const { f, calls } = fakeResend((n) =>
        n === 1 ? error(429, "rate_limit_exceeded", "slow down", { "retry-after": "0.05" }) : ok(),
      );
      const t = resendTransport({ apiKey: "k", fetch: f, minIntervalMs: 0 });
      const first = await t.send(message()).catch((e) => e);
      expect(first).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 50 });

      const capped = await resendTransport({
        apiKey: "k",
        minIntervalMs: 0,
        fetch: fakeResend(() => error(429, "rate_limit_exceeded", "x", { "retry-after": "3600" }))
          .f,
      })
        .send(message())
        .catch((e) => e);
      expect(capped.retryAfterMs).toBe(60_000);

      const mailer = createMailer({
        transport: resendTransport({
          apiKey: "k",
          minIntervalMs: 0,
          fetch: fakeResend((n) =>
            n === 1 ? error(429, "rate_limit_exceeded", "x", { "retry-after": "0.06" }) : ok(),
          ).f,
        }),
        from: { email: "no-reply@example.test" },
        context: CTX,
        suppressions: memorySuppressionStore(),
        unsubscribe: hmacUnsubscribeSigner({ key: new Uint8Array(32), baseUrl: CTX.appUrl }),
        retryDelaysMs: [0, 0, 0],
      });
      const started = Date.now();
      const out = await mailer.send(
        { email: "sam@example.test" },
        "verify-email",
        FIXTURES["verify-email"],
      );
      expect(out.status).toBe("sent");
      expect(Date.now() - started).toBeGreaterThanOrEqual(55);
      expect(calls).toHaveLength(1);
    });

    it("works with the mailer: a 5xx is retried, a quota error is not", async () => {
      const mk = (respond: (n: number) => Response) => {
        const fake = fakeResend(respond);
        const mailer = createMailer({
          transport: resendTransport({ apiKey: "k", fetch: fake.f, minIntervalMs: 0 }),
          from: { email: "no-reply@example.test" },
          context: CTX,
          suppressions: memorySuppressionStore(),
          unsubscribe: hmacUnsubscribeSigner({ key: new Uint8Array(32), baseUrl: CTX.appUrl }),
          retryDelaysMs: [0, 0, 0],
        });
        return { mailer, calls: fake.calls };
      };
      const a = mk((n) => (n === 1 ? error(503, "x") : ok()));
      const sent = await a.mailer.send(
        { email: "sam@example.test" },
        "verify-email",
        FIXTURES["verify-email"],
      );
      expect(sent.status).toBe("sent");
      expect(a.calls).toHaveLength(2);

      const b = mk(() => error(429, "daily_quota_exceeded"));
      const failed = await b.mailer.send(
        { email: "sam@example.test" },
        "verify-email",
        FIXTURES["verify-email"],
      );
      expect(failed).toEqual({ status: "failed", code: "quota_exceeded" });
      expect(b.calls).toHaveLength(1);
    });
  });

  it("validates its options", () => {
    expect(() => resendTransport({ apiKey: "" })).toThrow();
    expect(() => resendTransport({ apiKey: "re_a b" })).toThrow();
  });
});
