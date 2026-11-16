/**
 * Logging (design 6.4) in both modes: apps/api's self-host logger behaves exactly like `@glideworth/cloud/log`
 * (self-host must not load the cloud package), errors are logged by name, code and fingerprint (never the
 * message), and the places the design review listed (errors.ts, check-ins, plan branches) log through it.
 */
import {
  createLogger as cloudCreateLogger,
  LOG_FIELD_ALLOWLIST as CLOUD_ALLOWLIST,
} from "@glideworth/cloud/log";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { describeError, toErrorResponse } from "../src/errors.js";
import { createLogger, LOG_FIELD_ALLOWLIST, log, setLogger } from "../src/log.js";
import { captured } from "./log-capture.js";

const NOW = () => new Date("2026-11-16T00:00:00.000Z");

describe("the self-host logger", () => {
  it("has the cloud package's allowlist and produces the same lines", () => {
    expect([...LOG_FIELD_ALLOWLIST]).toEqual([...CLOUD_ALLOWLIST]);
    const mine: string[] = [];
    const theirs: string[] = [];
    const a = createLogger({ level: "debug", sink: (l) => mine.push(l), now: NOW });
    const b = cloudCreateLogger({ level: "debug", sink: (l) => theirs.push(l), now: NOW });
    const err = Object.assign(new Error("household 'Avery and Jordan' has 918273.64 in savings"), {
      code: "SQLITE_CONSTRAINT",
    });
    const cases: Array<[string, Record<string, unknown>]> = [
      ["http.request", { route: "/api/v1/plans/:id", status: 200, durationMs: 12 }],
      ["x.email", { reason: "robin@example.org" }],
      ["x.token", { reason: "gwk_taaaaaaaaaaaaaaa_aaaaaaaa_xyz" }],
      ["x.prose", { reason: "Avery and Jordan household" }],
      ["x.long", { kind: "a".repeat(300) }],
      ["x.object", { count: { nested: 1 } as never }],
      ["x.unknown", { message: "secret", body: "{}" } as never],
      ["x.error", { err }],
      ["Bad Event", { count: 1 }],
      ["x.nan", { count: Number.NaN }],
    ];
    for (const [event, fields] of cases) {
      a.warn(event, fields as never);
      b.warn(event, fields as never);
    }
    a.child({ accountId: "t1", kind: "child" }).info("x.child", { count: 2 });
    b.child({ accountId: "t1", kind: "child" }).info("x.child", { count: 2 });
    expect(mine).toEqual(theirs);
    const all = mine.join("\n");
    for (const s of ["robin@example.org", "gwk_", "Avery", "918273.64", "secret"])
      expect(all).not.toContain(s);
  });

  it("logs an unhandled HTTP error without its message", async () => {
    captured.length = 0;
    const app = new Hono();
    app.onError((e, c) => toErrorResponse(e, c));
    app.get("/boom/:id", () => {
      throw new Error("plan 'Robin Example retirement' with 918273.64 is broken");
    });
    const r = await app.request("/boom/x?token=abc");
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain("918273.64");
    const line = captured.find((l) => l.includes("http.unhandled"));
    expect(line).toBeDefined();
    expect(line).toContain('"route":"/boom/:id"');
    expect(line).toContain("errFingerprint");
    expect(line).not.toContain("918273.64");
    expect(line).not.toContain("token=abc");
    expect(describeError(new Error("Robin Example 918273.64")).message).toBe(
      "internal error; see the server log",
    );
    captured.length = 0;
  });

  it("can be replaced (cloud mode installs the cloud logger)", () => {
    const lines: string[] = [];
    const prev = setLogger(createLogger({ level: "info", sink: (l) => lines.push(l) }));
    log.info("x.replaced", { count: 1 });
    setLogger(prev);
    expect(lines).toHaveLength(1);
  });
});
