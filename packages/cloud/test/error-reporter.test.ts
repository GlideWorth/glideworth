import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadCloudConfig } from "../src/config.js";
import {
  createPostHogErrorReporter,
  reportingLogger,
  SERVER_DISTINCT_ID,
  toPostHogFrames,
} from "../src/log/error-reporter.js";
import { createLogger, describeErrorForLog } from "../src/log/index.js";

const TOKEN = "phc_testprojecttoken123";
const HOST = "https://us.i.posthog.com";

/** A fake PostHog capture endpoint: records each request body. */
function fakePostHog(status = 200) {
  // oxlint-disable-next-line typescript/no-explicit-any -- captured request bodies are untyped JSON
  const sent: Array<{ url: string; body: Record<string, any> }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}

const secretError = () => {
  const e = new Error(
    "plan 'Robin Example retirement' for robin@example.org with 918273.64 failed\nsecond line",
  );
  (e as Error & { code: string }).code = "E_BROKEN";
  return e;
};

describe("PostHog error reporter", () => {
  it("sends a $exception with describeErrorForLog fields and allowlisted tags only", async () => {
    const ph = fakePostHog();
    const r = createPostHogErrorReporter({
      token: TOKEN,
      host: `${HOST}/`,
      release: "sha-abc123",
      fetch: ph.fetch,
    });
    const err = secretError();
    r.capture(
      err,
      {
        accountId: "acc_123",
        route: "/api/v1/plans/:id",
        method: "POST",
        userId: "u_secret",
        tenantUserId: "tu_secret",
        reason: "robin@example.org",
      },
      "http.unhandled",
    );
    await r.flush();
    expect(ph.sent).toHaveLength(1);
    const { url, body } = ph.sent[0]!;
    expect(url).toBe(`${HOST}/i/v0/e/`);
    const d = describeErrorForLog(err);
    expect(body).toMatchObject({
      api_key: TOKEN,
      event: "$exception",
      distinct_id: "acc_123",
      properties: {
        $exception_list: [
          {
            type: "Error",
            value: `E_BROKEN (message ${d.errFingerprint})`,
            stacktrace: { type: "raw" },
          },
        ],
        $process_person_profile: false,
        $geoip_disable: true,
        release: "sha-abc123",
        logEvent: "http.unhandled",
        errName: "Error",
        errCode: "E_BROKEN",
        errFingerprint: d.errFingerprint,
        accountId: "acc_123",
        route: "/api/v1/plans/:id",
        method: "POST",
      },
    });
    const frames = body.properties.$exception_list[0].stacktrace.frames;
    expect(frames.length).toBeGreaterThan(0);
    // outermost first; this test file is the innermost frame
    expect(frames.at(-1).filename).toContain("error-reporter.test.ts");
    expect(frames.at(-1).in_app).toBe(true);
    const all = JSON.stringify(body);
    for (const s of [
      "Robin",
      "robin@example.org",
      "918273.64",
      "second line",
      "u_secret",
      "tu_secret",
      "userId",
    ])
      expect(all).not.toContain(s);
  });

  it("uses the fixed server id when no account is known", async () => {
    const ph = fakePostHog();
    const r = createPostHogErrorReporter({ token: TOKEN, host: HOST, fetch: ph.fetch });
    r.capture(new TypeError("x"), { kind: "backup_control" }, "cloud.task_failed");
    r.capture("a thrown string with secrets", {}, "x.y");
    await r.flush();
    expect(ph.sent.map((s) => s.body.distinct_id)).toEqual([
      SERVER_DISTINCT_ID,
      SERVER_DISTINCT_ID,
    ]);
    expect(JSON.stringify(ph.sent[1]!.body)).not.toContain("secrets");
  });

  it("dedupes the same error and reports the suppressed count with the next one", async () => {
    let t = 1_000_000;
    const ph = fakePostHog();
    const r = createPostHogErrorReporter({
      token: TOKEN,
      host: HOST,
      fetch: ph.fetch,
      now: () => t,
      dedupeMs: 60_000,
    });
    const boom = () => new Error("same message");
    for (let i = 0; i < 50; i++) r.capture(boom(), {}, "x.y");
    r.capture(new Error("another message"), {}, "x.y");
    await r.flush();
    expect(ph.sent).toHaveLength(2);
    t += 61_000;
    r.capture(boom(), {}, "x.y");
    await r.flush();
    expect(ph.sent).toHaveLength(3);
    expect(ph.sent[2]!.body.properties.suppressedCount).toBe(49);
  });

  it("caps reports per minute and open requests; a storm cannot flood PostHog", async () => {
    let t = 0;
    const warned: string[] = [];
    const log = createLogger({ level: "debug", sink: (l) => warned.push(l) });
    const ph = fakePostHog();
    const r = createPostHogErrorReporter({
      token: TOKEN,
      host: HOST,
      fetch: ph.fetch,
      now: () => t,
      maxPerMinute: 5,
      log,
    });
    for (let i = 0; i < 100; i++) {
      r.capture(new Error(`distinct ${i}`), {}, "x.y");
      await r.flush();
    }
    expect(ph.sent).toHaveLength(5);
    expect(warned.filter((l) => l.includes("error_report.not_sent"))).toHaveLength(1);
    t += 60_000;
    r.capture(new Error("after a minute"), {}, "x.y");
    await r.flush();
    expect(ph.sent).toHaveLength(6);

    // open requests: a PostHog that never answers holds at most maxInFlight
    let calls = 0;
    const hanging = createPostHogErrorReporter({
      token: TOKEN,
      host: HOST,
      maxInFlight: 2,
      fetch: (() => {
        calls++;
        return new Promise(() => {});
      }) as never,
    });
    for (let i = 0; i < 10; i++) hanging.capture(new Error(`h${i}`));
    await new Promise((res) => setTimeout(res, 10));
    expect(calls).toBe(2);
    await hanging.flush(20); // bounded: returns although the requests never finish
  });

  it("never throws into the caller and survives PostHog failures", async () => {
    const warned: string[] = [];
    const log = createLogger({ level: "debug", sink: (l) => warned.push(l) });
    const r = createPostHogErrorReporter({
      token: TOKEN,
      host: HOST,
      log,
      fetch: (() => {
        throw new Error("network down");
      }) as never,
    });
    expect(() => r.capture(new Error("x"), {}, "x.y")).not.toThrow();
    await r.flush();
    const bad = createPostHogErrorReporter({
      token: TOKEN,
      host: HOST,
      fetch: fakePostHog(500).fetch,
    });
    bad.capture(new Error("y"));
    await bad.flush();
    expect(warned.join("\n")).toContain("network_error");
    expect(warned.join("\n")).not.toContain("network down");
  });
});

describe("reportingLogger", () => {
  it("reports error lines that carry an err, with child bindings as tags", async () => {
    const lines: string[] = [];
    const captured: Array<{ tags: unknown; event: unknown }> = [];
    const log = reportingLogger(createLogger({ level: "debug", sink: (l) => lines.push(l) }), {
      capture: (_err, tags, event) => captured.push({ tags, event }),
      flush: async () => {},
    });
    log.error("billing.operator_alert", { kind: "x" });
    log.warn("x.warned", { err: new Error("w") });
    log.child({ accountId: "acc_9" }).error("job.failed", { kind: "backup", err: new Error("e") });
    expect(lines).toHaveLength(3);
    expect(captured).toEqual([
      { tags: { accountId: "acc_9", kind: "backup" }, event: "job.failed" },
    ]);
  });
});

describe("toPostHogFrames", () => {
  it("parses Node frames, outermost first", () => {
    expect(
      toPostHogFrames(
        [
          "at inner (file:///app/dist/a.js:10:5)",
          "at async Promise.all (index 0)",
          "at file:///app/node_modules/hono/dist/x.js:3:7",
          "at node:internal/process/task_queues:105:5",
        ].join("\n"),
      ),
    ).toEqual([
      expect.objectContaining({ filename: "node:internal/process/task_queues", in_app: false }),
      expect.objectContaining({
        filename: "file:///app/node_modules/hono/dist/x.js",
        lineno: 3,
        colno: 7,
        in_app: false,
      }),
      expect.objectContaining({ function: "Promise.all" }),
      {
        platform: "node:javascript",
        filename: "file:///app/dist/a.js",
        function: "inner",
        lineno: 10,
        colno: 5,
        in_app: true,
      },
    ]);
  });
});

describe("configuration", () => {
  const base = {
    GLIDEWORTH_PUBLIC_URL: "https://app.example.test",
    GLIDEWORTH_SECRETS_KEY: randomBytes(32).toString("hex"),
    GLIDEWORTH_BACKUP_KEK: randomBytes(32).toString("hex"),
    GLIDEWORTH_PRICING_FILE: "/etc/glideworth/pricing.json",
  };

  it("is off unless both the token and the host are set", () => {
    expect(loadCloudConfig(base).errorReports).toBeNull();
    expect(
      loadCloudConfig({ ...base, GLIDEWORTH_POSTHOG_PROJECT_TOKEN: TOKEN }).errorReports,
    ).toBeNull();
    expect(loadCloudConfig({ ...base, GLIDEWORTH_POSTHOG_HOST: HOST }).errorReports).toBeNull();
    expect(
      loadCloudConfig({
        ...base,
        GLIDEWORTH_POSTHOG_PROJECT_TOKEN: TOKEN,
        GLIDEWORTH_POSTHOG_HOST: `${HOST}/`,
        GLIDEWORTH_RELEASE: "sha-abc123",
      }).errorReports,
    ).toEqual({ token: TOKEN, host: HOST, release: "sha-abc123" });
  });

  it("refuses a bad token or host by name, without echoing values", () => {
    expect(() =>
      loadCloudConfig({
        ...base,
        GLIDEWORTH_POSTHOG_PROJECT_TOKEN: "bad token!",
        GLIDEWORTH_POSTHOG_HOST: HOST,
      }),
    ).toThrow(/GLIDEWORTH_POSTHOG_PROJECT_TOKEN is not a valid project token/);
    expect(() =>
      loadCloudConfig({
        ...base,
        GLIDEWORTH_POSTHOG_PROJECT_TOKEN: TOKEN,
        GLIDEWORTH_POSTHOG_HOST: "http://posthog.example.test",
      }),
    ).toThrow(/GLIDEWORTH_POSTHOG_HOST must be an https URL/);
  });
});
