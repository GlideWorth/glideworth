import { describe, expect, it } from "vitest";
import { CloudError } from "../src/errors.js";
import {
  createLogger,
  describeErrorForLog,
  LOG_FIELD_ALLOWLIST,
  type Logger,
} from "../src/log/index.js";

const capture = <X extends string = never>(extra: readonly X[] = []) => {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({
    level: "info",
    sink: (l) => lines.push(JSON.parse(l)),
    extraFields: extra,
    now: () => new Date("2026-11-16T00:00:00Z"),
  });
  return { lines, log };
};

describe("logger", () => {
  it("writes { level, time, event, ...allowlisted fields }", () => {
    const { lines, log } = capture();
    log.info("auth.signin", { userId: "u_abc", durationMs: 12 });
    expect(lines).toEqual([
      {
        level: "info",
        time: "2026-11-16T00:00:00.000Z",
        event: "auth.signin",
        userId: "u_abc",
        durationMs: 12,
      },
    ]);
  });

  it("drops fields outside the allowlist and counts them", () => {
    const { lines, log } = capture();
    const sneaky = {
      userId: "u_1",
      body: '{"amount":12345}',
      password: "pw",
      query: "token=abc",
    } as Record<string, unknown>;
    log.info("x.y", sneaky as never);
    expect(lines[0]).toEqual({
      level: "info",
      time: expect.any(String),
      event: "x.y",
      userId: "u_1",
      droppedFields: 3,
    });
  });

  it("drops object values (an Error, a request, a body) even under an allowlisted name", () => {
    const { lines, log } = capture();
    log.info("x.y", { status: new Error("household Smith has 1,234,567") as never, count: 1 });
    expect(JSON.stringify(lines)).not.toContain("Smith");
    expect(lines[0]).toMatchObject({ count: 1, droppedFields: 1 });
  });

  it("scrubs string values that look like secrets, addresses or prose", () => {
    const { lines, log } = capture();
    log.info("x.y", {
      reason: "jane@example.org",
      route: "/api/v1/workspace/invitations/accept",
      kind: "gwk_tabcdefghijklmno_abcdefgh_xyz",
      outcome: "A".repeat(43),
      category: "the plan for retirement",
      method: "POST",
    });
    expect(lines[0]).toMatchObject({
      reason: "[redacted]",
      route: "/api/v1/workspace/invitations/accept",
      kind: "[redacted]",
      outcome: "[redacted]",
      category: "[redacted]",
      method: "POST",
    });
  });

  it("refuses event names that are not dotted identifiers", () => {
    const { lines, log } = capture();
    log.info('Failed to load plan "Retire at 55"');
    expect(lines[0]?.event).toBe("invalid_event");
  });

  it("respects the level and merges child fields", () => {
    const { lines, log } = capture();
    log.debug("x.debug");
    const child = log.child({ accountId: "tabcdefghijklmno", component: "jobs" });
    child.warn("x.warn", { count: 2 });
    expect(lines).toEqual([
      {
        level: "warn",
        time: expect.any(String),
        event: "x.warn",
        accountId: "tabcdefghijklmno",
        component: "jobs",
        count: 2,
      },
    ]);
  });

  it("extra fields can be allowed per logger", () => {
    const { lines, log } = capture(["tenantCount"]);
    log.info("x.y", { tenantCount: 3 });
    expect(lines[0]).toMatchObject({ tenantCount: 3 });
  });

  it("logs errors only through describeErrorForLog: never the message", () => {
    const { lines, log } = capture();
    const err = Object.assign(new Error('plan "Early retirement" balance 98765.43'), {
      code: "SQLITE_FULL",
    });
    log.error("job.failed", { jobId: "j1", err });
    const text = JSON.stringify(lines);
    expect(text).not.toContain("98765");
    expect(text).not.toContain("Early retirement");
    expect(lines[0]).toMatchObject({
      errName: "Error",
      errCode: "SQLITE_FULL",
      errFingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
  });

  it("does not throw when the sink throws", () => {
    const log = createLogger({
      level: "info",
      sink: () => {
        throw new Error("disk full");
      },
    });
    expect(() => log.info("x.y")).not.toThrow();
  });

  it("has the documented allowlist shape", () => {
    expect(LOG_FIELD_ALLOWLIST).toContain("accountId");
    expect(LOG_FIELD_ALLOWLIST).not.toContain("message");
    expect(LOG_FIELD_ALLOWLIST).not.toContain("email");
    expect(LOG_FIELD_ALLOWLIST).not.toContain("body");
    expect(LOG_FIELD_ALLOWLIST).not.toContain("query");
  });

  it("the type system refuses bodies, messages and arbitrary names (compile-time checks)", () => {
    const log: Logger = createLogger({ level: "error", sink: () => {} });
    const err = new Error("secret message");
    const body = { amount: 1 };
    // @ts-expect-error: `message` is not a log field
    log.info("x.y", { message: err.message });
    // @ts-expect-error: `body` is not a log field
    log.info("x.y", { body });
    // @ts-expect-error: object values are not LogValues
    log.info("x.y", { status: body });
    // @ts-expect-error: an Error is not a LogValue
    log.info("x.y", { reason: err });
    const fromRequest = { email: "a@b.c", password: "x" };
    // @ts-expect-error: an object sharing no allowlisted name is rejected (weak type detection)
    log.info("x.y", fromRequest);
    log.error("x.y", { err }); // the one sanctioned way
    expect(true).toBe(true);
  });
});

describe("describeErrorForLog", () => {
  it("name, code, fingerprint and frames only; never any message line", () => {
    const err = new CloudError(
      400,
      "VALIDATION",
      "line one with jane@example.org\nline two 12,345.67",
    );
    const d = describeErrorForLog(err);
    expect(d.errName).toBe("CloudError");
    expect(d.errCode).toBe("VALIDATION");
    expect(d.errFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(d.stack).toMatch(/^at /);
    const text = JSON.stringify(d);
    expect(text).not.toContain("jane");
    expect(text).not.toContain("12,345");
    expect(text).not.toContain("line two");
  });
  it("same message, same fingerprint; different message, different fingerprint", () => {
    expect(describeErrorForLog(new Error("a")).errFingerprint).toBe(
      describeErrorForLog(new TypeError("a")).errFingerprint,
    );
    expect(describeErrorForLog(new Error("a")).errFingerprint).not.toBe(
      describeErrorForLog(new Error("b")).errFingerprint,
    );
  });
  it("handles non-errors and hostile names or codes", () => {
    expect(describeErrorForLog("raw string with secret")).toMatchObject({
      errName: "string",
      errCode: null,
      stack: null,
    });
    expect(describeErrorForLog(null).errName).toBe("object");
    const weird = { name: "name with spaces and a@b.c", code: "code with spaces", message: "m" };
    expect(describeErrorForLog(weird)).toMatchObject({ errName: "Error", errCode: null });
  });
});
