import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createMailer,
  EmailTransportError,
  fileTransport,
  hmacUnsubscribeSigner,
  mailgunTransport,
  memorySuppressionStore,
  memoryTransport,
  type OutgoingEmail,
  render,
  smtpTransport,
} from "../src/index.js";
import { type FakeSmtp, startFakeSmtp } from "./fake-smtp.js";
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

const HOSTILE: [string, Partial<OutgoingEmail>][] = [
  ["subject newline", { subject: "Hi\r\nBcc: a@b.test" }],
  ["empty subject", { subject: "" }],
  ["header value newline", { headers: { "X-A": "x\r\nBcc: a@b.test" } }],
  ["header name newline", { headers: { "X-A\r\nBcc": "x" } }],
  ["header name colon", { headers: { "X-A: b": "x" } }],
  ["recipient newline", { to: { email: "a@b.test\r\nBcc: c@d.test" } }],
  ["recipient name newline", { to: { email: "a@b.test", name: "A\r\nBcc: c@d.test" } }],
  ["from newline", { from: { email: "a@b.test\nx" } }],
  ["reply-to newline", { replyTo: { email: "a@b.test", name: "x\ny" } }],
];

describe("all transports refuse header injection (defence in depth)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-email-inj-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const calls: unknown[] = [];
  const transports = {
    memory: memoryTransport(),
    file: fileTransport({ dir }),
    smtp: smtpTransport({
      url: "smtp://127.0.0.1:1",
      transporter: nodemailer.createTransport({ jsonTransport: true }),
    }),
    mailgun: mailgunTransport({
      apiKey: "k",
      domain: "mg.example.test",
      region: "eu",
      fetch: async (...a) => {
        calls.push(a);
        return new Response("{}", { status: 200 });
      },
    }),
  };
  for (const [tname, t] of Object.entries(transports)) {
    it.each(HOSTILE)(`${tname}: %s`, async (_n, over) => {
      await expect(t.send(message(over))).rejects.toMatchObject({
        name: "EmailTransportError",
        retryable: false,
      });
    });
  }
  it("nothing was sent or written", () => {
    expect(calls).toHaveLength(0);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

describe("memoryTransport", () => {
  it("records and clears", async () => {
    const t = memoryTransport();
    expect(await t.send(message())).toEqual({ providerMessageId: "memory-1" });
    expect(t.sent).toHaveLength(1);
    t.clear();
    expect(t.sent).toHaveLength(0);
  });
});

describe("fileTransport", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = join(mkdtempSync(join(tmpdir(), "gw-email-")), "mail-outbox");
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(join(d, ".."), { recursive: true, force: true });
  });

  it("writes .eml and .json, creating the directory, and indexes the message", async () => {
    const dir = tmp();
    const t = fileTransport({ dir });
    expect(t.name).toBe("file");
    const res = await t.send(message());
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^\d{8}T\d{9}Z-[0-9a-f-]{36}\.eml$/);
    expect(files[1]).toMatch(/\.json$/);
    expect(files[0]?.replace(".eml", "")).toBe(files[1]?.replace(".json", ""));
    expect(files[0]).toContain(res.providerMessageId ?? "x");

    const eml = readFileSync(join(dir, files[0] as string), "utf8");
    expect(eml).toContain("Subject: Confirm your email address for Glideworth");
    expect(eml).toMatch(/^To: "?Sam Example"? <sam@example\.test>/m);
    expect(eml).toContain("Auto-Submitted: auto-generated");
    expect(eml).toContain("multipart/alternative");

    const json = JSON.parse(readFileSync(join(dir, files[1] as string), "utf8"));
    expect(json.message.template).toBe("verify-email");
    expect(t.list()).toHaveLength(1);
  });

  it("latestTo returns the latest message and its links, case-insensitively", async () => {
    const t = fileTransport({ dir: tmp() });
    await t.send(message());
    const second = render(
      "verify-email",
      { ...FIXTURES["verify-email"], url: "https://app.example.test/verify?t=second" },
      CTX,
    );
    await t.send(message({ text: second.text, html: second.html }));
    const latest = t.latestTo("SAM@example.test");
    expect(latest?.links[0]).toBe("https://app.example.test/verify?t=second");
    expect(t.latestTo("nobody@example.test")).toBeUndefined();
  });

  it("extracts each distinct link once without trailing punctuation", async () => {
    const t = fileTransport({ dir: tmp() });
    await t.send(
      message({
        text: "See https://a.example.test/x?y=1. And (https://a.example.test/x?y=1) and http://localhost:5173/z",
      }),
    );
    expect(t.list()[0]?.links).toEqual(["https://a.example.test/x?y=1", "http://localhost:5173/z"]);
  });

  it("reloads the index from disk and clear() removes files and index", async () => {
    const dir = tmp();
    await fileTransport({ dir }).send(message());
    const again = fileTransport({ dir });
    expect(again.list()).toHaveLength(1);
    expect(again.latestTo("sam@example.test")?.message.subject).toContain("Confirm");
    again.clear();
    expect(again.list()).toHaveLength(0);
    expect(readdirSync(dir)).toHaveLength(0);
    expect(existsSync(dir)).toBe(true);
  });

  it("works end to end through the mailer: a test can read the verification link", async () => {
    const t = fileTransport({ dir: tmp() });
    const mailer = createMailer({
      transport: t,
      from: { email: "no-reply@example.test" },
      context: CTX,
      suppressions: memorySuppressionStore(),
      unsubscribe: hmacUnsubscribeSigner({ key: new Uint8Array(32), baseUrl: CTX.appUrl }),
    });
    await mailer.send({ email: "sam@example.test" }, "verify-email", FIXTURES["verify-email"]);
    expect(t.latestTo("sam@example.test")?.links[0]).toBe(FIXTURES["verify-email"].url);
  });
});

describe("mailgunTransport", () => {
  type Call = { url: string; init: RequestInit; form: FormData };
  function fake(respond: () => Response | Promise<Response>) {
    const calls: Call[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        init: init ?? {},
        form: (init?.body ?? new FormData()) as FormData,
      });
      return respond();
    }) as typeof fetch;
    return { f, calls };
  }
  const ok = () =>
    new Response(
      JSON.stringify({ id: "<20261116.1@mg.example.test>", message: "Queued. Thank you." }),
      {
        status: 200,
      },
    );
  const json = (status: number, message = "x") =>
    new Response(JSON.stringify({ message }), { status });

  it("sends a multipart form to the EU host with basic auth", async () => {
    const { f, calls } = fake(ok);
    const t = mailgunTransport({
      apiKey: "key-abc",
      domain: "mg.example.test",
      region: "eu",
      fetch: f,
    });
    const res = await t.send(
      message({
        replyTo: { email: "help@example.test", name: 'Help "Desk"' },
        headers: { "X-Test": "1", "Auto-Submitted": "auto-generated" },
      }),
    );
    expect(res).toEqual({ providerMessageId: "<20261116.1@mg.example.test>" });
    const c = calls[0] as Call;
    expect(c.url).toBe("https://api.eu.mailgun.net/v3/mg.example.test/messages");
    expect(c.init.method).toBe("POST");
    const headers = c.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("api:key-abc").toString("base64")}`);
    expect(c.form).toBeInstanceOf(FormData);
    expect(c.form.get("from")).toBe('"Glideworth" <no-reply@example.test>');
    expect(c.form.get("to")).toBe('"Sam Example" <sam@example.test>');
    expect(c.form.get("subject")).toBe("Confirm your email address for Glideworth");
    expect(c.form.get("text")).toContain("Confirm email address");
    expect(String(c.form.get("html"))).toContain("<!doctype html>");
    expect(c.form.get("h:Reply-To")).toBe('"Help \\"Desk\\"" <help@example.test>');
    expect(c.form.get("h:X-Test")).toBe("1");
    expect(c.form.get("h:Auto-Submitted")).toBe("auto-generated");
    expect(c.form.get("o:tracking")).toBe("no");
    expect(c.form.get("o:tracking-opens")).toBe("no");
    expect(c.form.get("o:tracking-clicks")).toBe("no");
    expect(c.form.get("o:tag")).toBe("verify-email");
    // The key must not be anywhere except the Authorization header.
    expect(JSON.stringify([...c.form.entries()])).not.toContain("key-abc");
  });

  it("uses the US host for region us", async () => {
    const { f, calls } = fake(ok);
    await mailgunTransport({ apiKey: "k", domain: "mg.example.test", region: "us", fetch: f }).send(
      message(),
    );
    expect(calls[0]?.url).toBe("https://api.mailgun.net/v3/mg.example.test/messages");
  });

  it("sends List-Unsubscribe headers as h: fields for check-in mail", async () => {
    const { f, calls } = fake(ok);
    const r = render("checkin-summary", FIXTURES["checkin-summary"], CHECKIN_CTX);
    await mailgunTransport({ apiKey: "k", domain: "mg.example.test", region: "eu", fetch: f }).send(
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
    expect(calls[0]?.form.get("h:List-Unsubscribe")).toBe(
      "<https://app.example.test/email/unsubscribe?t=abc>",
    );
    expect(calls[0]?.form.get("h:List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
  });

  it("succeeds with a null id when the body is not JSON", async () => {
    const { f } = fake(() => new Response("ok", { status: 200 }));
    const t = mailgunTransport({ apiKey: "k", domain: "mg.example.test", region: "eu", fetch: f });
    expect(await t.send(message())).toEqual({ providerMessageId: null });
  });

  describe("error mapping: retryable on 429/5xx and network failure only", () => {
    const cases: [string, () => Response | Promise<Response>, string, boolean][] = [
      ["429", () => json(429, "slow down"), "rate_limited", true],
      ["500", () => json(500), "provider_error", true],
      ["502", () => new Response("bad gateway", { status: 502 }), "provider_error", true],
      ["503", () => json(503), "provider_error", true],
      ["400", () => json(400, "'to' parameter is not a valid address"), "rejected", false],
      ["401", () => new Response("Forbidden", { status: 401 }), "auth", false],
      ["403", () => json(403), "auth", false],
      ["404", () => json(404), "not_found", false],
      ["413", () => json(413), "rejected", false],
      ["422", () => json(422), "rejected", false],
    ];
    it.each(cases)("%s", async (_n, respond, code, retryable) => {
      const { f } = fake(respond);
      const t = mailgunTransport({
        apiKey: "key-abc",
        domain: "mg.example.test",
        region: "eu",
        fetch: f,
      });
      const err = await t.send(message()).catch((e) => e);
      expect(err).toBeInstanceOf(EmailTransportError);
      expect(err).toMatchObject({ transport: "mailgun", code, retryable });
      expect(err.message).not.toContain("key-abc");
    });

    it("network failure is retryable and does not leak the cause", async () => {
      const f = (async () => {
        throw new TypeError("fetch failed: connect ECONNREFUSED key-abc");
      }) as typeof fetch;
      const t = mailgunTransport({
        apiKey: "key-abc",
        domain: "mg.example.test",
        region: "eu",
        fetch: f,
      });
      const err = await t.send(message()).catch((e) => e);
      expect(err).toMatchObject({ code: "network", retryable: true });
      expect(err.message).not.toContain("key-abc");
    });
  });

  it("works with the mailer: retries a 429 then succeeds", async () => {
    let n = 0;
    const { f, calls } = fake(() => (n++ < 1 ? json(429) : ok()));
    const mailer = createMailer({
      transport: mailgunTransport({
        apiKey: "k",
        domain: "mg.example.test",
        region: "eu",
        fetch: f,
      }),
      from: { email: "no-reply@example.test" },
      context: CTX,
      suppressions: memorySuppressionStore(),
      unsubscribe: hmacUnsubscribeSigner({ key: new Uint8Array(32), baseUrl: CTX.appUrl }),
      retryDelaysMs: [0, 0, 0],
    });
    const out = await mailer.send(
      { email: "sam@example.test" },
      "verify-email",
      FIXTURES["verify-email"],
    );
    expect(out.status).toBe("sent");
    expect(calls).toHaveLength(2);
  });

  it("validates its options", () => {
    expect(() =>
      mailgunTransport({ apiKey: "", domain: "mg.example.test", region: "eu" }),
    ).toThrow();
    expect(() =>
      mailgunTransport({ apiKey: "k", domain: "mg.example.test/../x", region: "eu" }),
    ).toThrow();
    expect(() =>
      mailgunTransport({ apiKey: "k", domain: "mg.example.test", region: "asia" as never }),
    ).toThrow();
  });
});

describe("smtpTransport", () => {
  let smtp: FakeSmtp;
  beforeAll(async () => {
    smtp = await startFakeSmtp();
  });
  afterAll(() => smtp.close());
  const url = () => `smtp://127.0.0.1:${smtp.port}/?ignoreTLS=true`;

  it("delivers to an in-process fake server with headers and both bodies", async () => {
    const t = smtpTransport({ url: url() });
    const before = smtp.messages.length;
    const res = await t.send(
      message({
        headers: {
          "Auto-Submitted": "auto-generated",
          "List-Unsubscribe": "<https://app.example.test/email/unsubscribe?t=abc>",
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        replyTo: { email: "help@example.test" },
      }),
    );
    expect(res.providerMessageId).toMatch(/^<.+@.+>$/);
    const m = smtp.messages[before];
    expect(m?.from).toBe("no-reply@example.test");
    expect(m?.to).toEqual(["sam@example.test"]);
    expect(m?.data).toContain("Subject: Confirm your email address for Glideworth");
    expect(m?.data).toContain(
      "List-Unsubscribe: <https://app.example.test/email/unsubscribe?t=abc>",
    );
    expect(m?.data).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(m?.data).toContain("Reply-To: help@example.test");
    expect(m?.data).toContain("multipart/alternative");
    expect(m?.data).toContain("text/plain");
    expect(m?.data).toContain("text/html");
  });

  it("maps a 550 recipient rejection to a non-retryable error", async () => {
    const err = await smtpTransport({ url: url() })
      .send(message({ to: { email: "reject-me@example.test" } }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(EmailTransportError);
    expect(err).toMatchObject({ transport: "smtp", retryable: false });
  });

  it("maps a 451 temporary failure to a retryable error", async () => {
    const err = await smtpTransport({ url: url() })
      .send(message({ to: { email: "defer-me@example.test" } }))
      .catch((e) => e);
    expect(err).toMatchObject({ transport: "smtp", code: "smtp_451", retryable: true });
  });

  it("maps connection refused to a retryable error without leaking the URL", async () => {
    const dead = await startFakeSmtp();
    const port = dead.port;
    await dead.close();
    const err = await smtpTransport({
      url: `smtp://user:hunter2@127.0.0.1:${port}/?ignoreTLS=true`,
    })
      .send(message())
      .catch((e) => e);
    expect(err).toBeInstanceOf(EmailTransportError);
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain("hunter2");
  });

  it("works with the mailer against the fake server", async () => {
    const mailer = createMailer({
      transport: smtpTransport({ url: url() }),
      from: { email: "no-reply@example.test", name: "Glideworth" },
      context: CTX,
      suppressions: memorySuppressionStore(),
      unsubscribe: hmacUnsubscribeSigner({ key: new Uint8Array(32), baseUrl: CTX.appUrl }),
      retryDelaysMs: [0, 0, 0],
    });
    const out = await mailer.send(
      { email: "sam@example.test" },
      "checkin-summary",
      FIXTURES["checkin-summary"],
    );
    expect(out.status).toBe("sent");
    const last = smtp.messages.at(-1);
    expect(last?.data).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    const bounced = await mailer.send(
      { email: "reject-x@example.test" },
      "verify-email",
      FIXTURES["verify-email"],
    );
    expect(bounced.status).toBe("failed");
  });

  it("works with a nodemailer stream/JSON transport and neutralises a name with quotes", async () => {
    const t = smtpTransport({
      url: "smtp://unused",
      transporter: nodemailer.createTransport({ jsonTransport: true }),
    });
    const res = await t.send(
      message({ to: { email: "sam@example.test", name: 'Sam "Bcc: x@y.test" <z@z.test>' } }),
    );
    expect(res.providerMessageId).toBeTruthy();
  });
});
