import { describe, expect, it } from "vitest";
import { SECURITY_TXT, securityTxt } from "../src/security-txt.js";

const DAY = 24 * 60 * 60 * 1000;

describe("security.txt (RFC 9116)", () => {
  it("has the required fields, one per line, and the Canonical it was given", () => {
    const body = securityTxt("https://app.example.com/.well-known/security.txt");
    expect(body.endsWith("\n")).toBe(true);
    const lines = body.trimEnd().split("\n");
    expect(lines).toEqual([
      expect.stringMatching(/^# /),
      "Contact: mailto:security@glideworth.com",
      "Contact: https://github.com/GlideWorth/glideworth/security/advisories/new",
      `Expires: ${SECURITY_TXT.expires}`,
      "Preferred-Languages: en",
      "Canonical: https://app.example.com/.well-known/security.txt",
      "Policy: https://glideworth.com/security/",
    ]);
  });

  it("Expires is an RFC 3339 UTC date-time", () => {
    expect(SECURITY_TXT.expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(Number.isNaN(Date.parse(SECURITY_TXT.expires))).toBe(false);
  });

  // This test starts failing 30 days before the file expires, on purpose: renew SECURITY_TXT.expires in
  // packages/cloud/src/security-txt.ts (about a year ahead, at most 366 days).
  it("Expires is at least 30 days and at most about a year away (renew it when this fails)", () => {
    const left = Date.parse(SECURITY_TXT.expires) - Date.now();
    expect(left, `security.txt expires ${SECURITY_TXT.expires}: renew it`).toBeGreaterThan(
      30 * DAY,
    );
    expect(left).toBeLessThanOrEqual(366 * DAY);
  });
});
