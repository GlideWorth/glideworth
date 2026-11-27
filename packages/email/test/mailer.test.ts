import { describe, expect, it } from "vitest";
import {
  createMailer,
  type EmailTransport,
  EmailTransportError,
  hmacUnsubscribeSigner,
  memoryEmailLog,
  memorySuppressionStore,
  memoryTransport,
  type OutgoingEmail,
} from "../src/index.js";
import { CTX, FIXTURES } from "./fixtures.js";

const signer = hmacUnsubscribeSigner({ key: new Uint8Array(32).fill(3), baseUrl: CTX.appUrl });
const from = { email: "no-reply@example.test", name: "Glideworth" };
const sam = { email: "sam@example.test", name: "Sam Example" };

function setup(transport: EmailTransport = memoryTransport()) {
  const suppressions = memorySuppressionStore();
  const log = memoryEmailLog();
  const mailer = createMailer({
    transport,
    from,
    context: CTX,
    suppressions,
    log,
    unsubscribe: signer,
    retryDelaysMs: [0, 0, 0],
  });
  return { transport, suppressions, log, mailer };
}

describe("Mailer.send", () => {
  it("sends essential mail without List-Unsubscribe headers", async () => {
    const { mailer, transport, log } = setup();
    const out = await mailer.send(sam, "verify-email", FIXTURES["verify-email"], {
      userId: "usr_1",
    });
    expect(out).toEqual({ status: "sent", providerMessageId: "memory-1" });
    const m = (transport as ReturnType<typeof memoryTransport>).sent[0] as OutgoingEmail;
    expect(m.category).toBe("essential");
    expect(m.template).toBe("verify-email");
    expect(m.to).toEqual(sam);
    expect(m.from).toEqual(from);
    expect(m.headers["List-Unsubscribe"]).toBeUndefined();
    expect(m.headers["List-Unsubscribe-Post"]).toBeUndefined();
    expect(m.text).not.toContain("unsubscribe?t=");
    expect(log.entries).toEqual([
      {
        userId: "usr_1",
        template: "verify-email",
        category: "essential",
        status: "sent",
        providerMessageId: "memory-1",
      },
    ]);
  });

  it("adds RFC 8058 headers to check-in mail only, with a token that verifies", async () => {
    const { mailer, transport } = setup();
    await mailer.send(sam, "checkin-summary", FIXTURES["checkin-summary"]);
    const m = (transport as ReturnType<typeof memoryTransport>).sent[0] as OutgoingEmail;
    expect(m.category).toBe("checkin");
    const lu = m.headers["List-Unsubscribe"] ?? "";
    expect(lu).toMatch(/^<https:\/\/app\.example\.test\/email\/unsubscribe\?t=[^>\s]+>$/);
    expect(m.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const url = lu.slice(1, -1);
    expect(signer.verify(new URL(url).searchParams.get("t") ?? "")).toEqual({
      email: "sam@example.test",
      category: "checkin",
    });
    // The same link is in the body.
    expect(m.text).toContain(url);
    expect(m.html).toContain(url.replace(/&/g, "&amp;"));
  });

  it("puts the normalised address in the token", async () => {
    const { mailer, transport } = setup();
    await mailer.send(
      { email: "  Sam@Example.TEST " },
      "checkin-summary",
      FIXTURES["checkin-summary"],
    );
    const m = (transport as ReturnType<typeof memoryTransport>).sent[0] as OutgoingEmail;
    const t =
      new URL((m.headers["List-Unsubscribe"] ?? "").slice(1, -1)).searchParams.get("t") ?? "";
    expect(signer.verify(t)?.email).toBe("sam@example.test");
    expect(m.to.email).toBe("Sam@Example.TEST");
  });

  it("passes the idempotency key to the transport", async () => {
    const { mailer, transport } = setup();
    await mailer.send(sam, "verify-email", FIXTURES["verify-email"], { idempotencyKey: "k1" });
    expect((transport as ReturnType<typeof memoryTransport>).sent[0]?.idempotencyKey).toBe("k1");
  });
});

describe("requested mail (calculator result)", () => {
  it("carries no unsubscribe headers or link: it is one email the person asked for", async () => {
    const { mailer, transport } = setup();
    await mailer.send(sam, "calculator-result", FIXTURES["calculator-result"]);
    const m = (transport as ReturnType<typeof memoryTransport>).sent[0] as OutgoingEmail;
    expect(m.category).toBe("requested");
    expect(m.headers["List-Unsubscribe"]).toBeUndefined();
    expect(m.text).not.toContain("unsubscribe?t=");
  });

  it("is still sent after a marketing unsubscribe, and blocked by a bounce or complaint", async () => {
    const { mailer, suppressions } = setup();
    suppressions.suppress("sam@example.test", "marketing", "unsubscribe");
    expect(
      (await mailer.send(sam, "calculator-result", FIXTURES["calculator-result"])).status,
    ).toBe("sent");
    suppressions.suppress("sam@example.test", "all", "complaint");
    expect(await mailer.send(sam, "calculator-result", FIXTURES["calculator-result"])).toEqual({
      status: "suppressed",
      reason: "complaint",
    });
  });
});

describe("suppression", () => {
  it("honours a check-in unsubscribe for check-in mail, case-insensitively", async () => {
    const { mailer, transport, suppressions, log } = setup();
    suppressions.suppress("sam@example.test", "checkin", "unsubscribe");
    const out = await mailer.send(
      { email: "SAM@example.test" },
      "checkin-summary",
      FIXTURES["checkin-summary"],
    );
    expect(out).toEqual({ status: "suppressed", reason: "unsubscribe" });
    expect((transport as ReturnType<typeof memoryTransport>).sent).toHaveLength(0);
    expect(log.entries[0]).toMatchObject({ status: "suppressed", providerMessageId: null });
  });

  it("a check-in unsubscribe never affects essential mail", async () => {
    const { mailer, suppressions } = setup();
    suppressions.suppress("sam@example.test", "checkin", "unsubscribe");
    for (const id of ["signin-alert", "security-change", "trial-ending", "verify-email"] as const) {
      const out = await mailer.send(sam, id, FIXTURES[id] as never);
      expect(out.status, id).toBe("sent");
    }
  });

  it("verify-email and password-reset are always attempted, even after a bounce on all categories", async () => {
    const { mailer, suppressions } = setup();
    suppressions.suppress("sam@example.test", "all", "bounce");
    expect((await mailer.send(sam, "verify-email", FIXTURES["verify-email"])).status).toBe("sent");
    expect((await mailer.send(sam, "password-reset", FIXTURES["password-reset"])).status).toBe(
      "sent",
    );
  });

  it("bounces and complaints suppress other mail and report the reason (spec 5.4)", async () => {
    const { mailer, suppressions } = setup();
    suppressions.suppress("sam@example.test", "all", "complaint");
    expect(await mailer.send(sam, "signin-alert", FIXTURES["signin-alert"])).toEqual({
      status: "suppressed",
      reason: "complaint",
    });
    expect(await mailer.send(sam, "checkin-summary", FIXTURES["checkin-summary"])).toEqual({
      status: "suppressed",
      reason: "complaint",
    });
  });

  it("suppression is per address", async () => {
    const { mailer, suppressions } = setup();
    suppressions.suppress("sam@example.test", "checkin", "unsubscribe");
    const out = await mailer.send(
      { email: "robin@example.test" },
      "checkin-summary",
      FIXTURES["checkin-summary"],
    );
    expect(out.status).toBe("sent");
  });

  it("works with a store that cannot report reasons", async () => {
    const mailer = createMailer({
      transport: memoryTransport(),
      from,
      context: CTX,
      suppressions: { isSuppressed: () => true, suppress: () => {} },
      unsubscribe: signer,
    });
    expect(await mailer.send(sam, "checkin-summary", FIXTURES["checkin-summary"])).toEqual({
      status: "suppressed",
      reason: "unsubscribe",
    });
  });
});

describe("retries and error mapping", () => {
  function flaky(errors: EmailTransportError[]) {
    let calls = 0;
    const t: EmailTransport = {
      name: "flaky",
      async send() {
        const e = errors[calls++];
        if (e) throw e;
        return { providerMessageId: "ok-1" };
      },
    };
    return { t, calls: () => calls };
  }
  const retryable = () => new EmailTransportError("flaky", "rate_limited", true, "slow down");

  it("retries retryable errors and then succeeds", async () => {
    const f = flaky([retryable(), retryable()]);
    const { mailer, log } = setup(f.t);
    expect(await mailer.send(sam, "verify-email", FIXTURES["verify-email"])).toEqual({
      status: "sent",
      providerMessageId: "ok-1",
    });
    expect(f.calls()).toBe(3);
    expect(log.entries).toHaveLength(1);
  });

  it("gives up after 3 retries (4 attempts) with the transport error code", async () => {
    const f = flaky([retryable(), retryable(), retryable(), retryable(), retryable()]);
    const { mailer, log } = setup(f.t);
    expect(await mailer.send(sam, "verify-email", FIXTURES["verify-email"])).toEqual({
      status: "failed",
      code: "rate_limited",
    });
    expect(f.calls()).toBe(4);
    expect(log.entries[0]).toMatchObject({ status: "failed", providerMessageId: null });
  });

  it("does not retry non-retryable errors", async () => {
    const f = flaky([new EmailTransportError("flaky", "rejected", false, "no")]);
    const { mailer } = setup(f.t);
    expect(await mailer.send(sam, "verify-email", FIXTURES["verify-email"])).toEqual({
      status: "failed",
      code: "rejected",
    });
    expect(f.calls()).toBe(1);
  });

  it("does not retry unknown errors and does not leak their message", async () => {
    let calls = 0;
    const t: EmailTransport = {
      name: "x",
      async send() {
        calls++;
        throw new Error("secret-api-key-123 exploded");
      },
    };
    const { mailer } = setup(t);
    const out = await mailer.send(sam, "verify-email", FIXTURES["verify-email"]);
    expect(out).toEqual({ status: "failed", code: "transport_error" });
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(calls).toBe(1);
  });

  it("waits the default 1 s, 5 s, 30 s between retries", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    try {
      const f = flaky([retryable(), retryable(), retryable()]);
      const mailer = createMailer({
        transport: f.t,
        from,
        context: CTX,
        suppressions: memorySuppressionStore(),
        unsubscribe: signer,
      });
      const p = mailer.send(sam, "verify-email", FIXTURES["verify-email"]);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.calls()).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.calls()).toBe(2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.calls()).toBe(3);
      await vi.advanceTimersByTimeAsync(30000);
      expect(f.calls()).toBe(4);
      expect((await p).status).toBe("sent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throwing log store does not change the outcome", async () => {
    const mailer = createMailer({
      transport: memoryTransport(),
      from,
      context: CTX,
      suppressions: memorySuppressionStore(),
      log: {
        record() {
          throw new Error("db down");
        },
      },
      unsubscribe: signer,
    });
    expect((await mailer.send(sam, "verify-email", FIXTURES["verify-email"])).status).toBe("sent");
  });
});

describe('email log never stores bodies, tokens, addresses or subjects (spec 5.1: "no body")', () => {
  it("records exactly five fields", async () => {
    const { mailer, log } = setup();
    await mailer.send(sam, "checkin-summary", FIXTURES["checkin-summary"], { userId: "usr_1" });
    await mailer.send(sam, "verify-email", FIXTURES["verify-email"], { userId: "usr_1" });
    for (const e of log.entries) {
      expect(Object.keys(e).sort()).toEqual([
        "category",
        "providerMessageId",
        "status",
        "template",
        "userId",
      ]);
    }
    const dump = JSON.stringify(log.entries);
    expect(dump).not.toContain("sample-token");
    expect(dump).not.toContain("unsubscribe");
    expect(dump).not.toContain("sam@example.test");
    expect(dump).not.toContain("Confirm");
  });

  it("the store drops extra fields even if a caller passes them", () => {
    const log = memoryEmailLog();
    log.record({
      userId: null,
      template: "verify-email",
      category: "essential",
      status: "sent",
      providerMessageId: null,
      body: "secret",
    } as never);
    expect(JSON.stringify(log.entries)).not.toContain("secret");
  });
});
