/**
 * Runs in every test file: after the file's tests, no captured log line may contain a secret the tests
 * created (password, token, session, email address, synthetic amounts and household names), anything shaped
 * like an email address, a 43-character token or a money amount, or a CloudError message. Every service in the tests logs through `testLog`, so this covers the suite.
 */
import { afterAll, expect } from "vitest";
import { logLines, secrets } from "./helpers.js";

afterAll(() => {
  const leaks: string[] = [];
  for (const raw of logLines) {
    for (const s of secrets) if (raw.includes(s)) leaks.push("secret");
    // Stack frames carry file paths (long hyphenated directory names); shape checks apply to the rest.
    const { stack: _stack, ...rest } = JSON.parse(raw) as Record<string, unknown>;
    const line = JSON.stringify(rest);
    if (/[^\s"@]+@[^\s"@]+\.[a-z]{2,}/i.test(line)) leaks.push("email-like");
    if (/[A-Za-z0-9_-]{43}/.test(line)) leaks.push("token-like");
    // Money-shaped values (synthetic figures in the fixtures look like 918273.64); timestamps are excluded.
    const { time: _time, ...rest2 } = rest;
    if (/\b\d{3,}\.\d{2}\b/.test(JSON.stringify(rest2))) leaks.push("amount-like");
    if (/"message"\s*:/.test(line)) leaks.push("message field");
  }
  expect(leaks).toEqual([]);
});
