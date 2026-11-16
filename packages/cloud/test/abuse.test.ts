import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { staticCaptcha, TURNSTILE_VERIFY_URL, turnstileVerifier } from "../src/abuse/captcha.js";
import {
  configureDisposableDomains,
  isDisposableEmail,
  loadDisposableOverrideFile,
} from "../src/abuse/disposable.js";
import { networkPrefix } from "../src/abuse/ip.js";
import { memoryRateLimiter } from "../src/abuse/rate-limiter.js";
import { SurgeDetector } from "../src/abuse/surge.js";
import { createLogger } from "../src/log/index.js";

describe("memoryRateLimiter", () => {
  it("sliding window: allows `limit` hits per window and reports retry time", () => {
    let t = 0;
    const l = memoryRateLimiter({ now: () => t });
    for (let i = 0; i < 3; i++)
      expect(l.hit("k", 3, 1000)).toMatchObject({ allowed: true, remaining: 2 - i });
    expect(l.hit("k", 3, 1000)).toEqual({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    t = 600;
    expect(l.hit("k", 3, 1000)).toEqual({ allowed: false, remaining: 0, retryAfterMs: 400 });
    t = 1000;
    expect(l.hit("k", 3, 1000).allowed).toBe(true);
    expect(l.hit("other", 3, 1000).allowed).toBe(true);
  });

  it("refused hits do not extend the block", () => {
    let t = 0;
    const l = memoryRateLimiter({ now: () => t });
    l.hit("k", 1, 1000);
    for (t = 1; t < 1000; t += 100) expect(l.hit("k", 1, 1000).allowed).toBe(false);
    t = 1000;
    expect(l.hit("k", 1, 1000).allowed).toBe(true);
  });

  it("memory is bounded: keys are capped (LRU) and per-key state is capped by the limit", () => {
    let t = 0;
    const l = memoryRateLimiter({ maxKeys: 100, now: () => t });
    for (let i = 0; i < 10_000; i++) l.hit(`attacker-${i}`, 5, 60_000);
    expect(l.size()).toBeLessThanOrEqual(100);
    // The most recently used key survives a flood that evicts older ones.
    l.hit("victim", 1, 60_000);
    for (let i = 0; i < 99; i++) l.hit(`more-${i}`, 5, 60_000);
    expect(l.hit("victim", 1, 60_000).allowed).toBe(false);
    // Expired keys are pruned lazily.
    t = 10 * 60_000;
    for (let i = 0; i < 20; i++) l.hit(`late-${i}`, 5, 1000);
    expect(l.size()).toBeLessThanOrEqual(100);
    // Very long keys are truncated, not stored whole.
    expect(l.hit("x".repeat(100_000), 1, 1000).allowed).toBe(true);
  });

  it("rejects invalid arguments", () => {
    const l = memoryRateLimiter();
    expect(() => l.hit("", 1, 1)).toThrow();
    expect(() => l.hit("k", Number.NaN, 1)).toThrow();
    expect(() => l.hit("k", 1, 0)).toThrow();
    expect(() => memoryRateLimiter({ maxKeys: 0 })).toThrow();
  });
});

describe("captcha", () => {
  it("static verifier accepts only its token", async () => {
    const c = staticCaptcha("ok-token");
    expect(await c.verify("ok-token", "1.2.3.4")).toBe(true);
    expect(await c.verify("ok-tokeN", "1.2.3.4")).toBe(false);
    expect(await c.verify(undefined, "1.2.3.4")).toBe(false);
  });

  it("turnstile posts the documented form and fails closed", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let reply: () => Promise<Response> = async () =>
      new Response(JSON.stringify({ success: true }));
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return reply();
    }) as unknown as typeof fetch;
    const v = turnstileVerifier({ secret: "sk-test", fetch: fakeFetch });
    expect(await v.verify("tok", "203.0.113.9")).toBe(true);
    expect(calls[0]?.url).toBe(TURNSTILE_VERIFY_URL);
    expect(calls[0]?.init.method).toBe("POST");
    const form = new URLSearchParams(String(calls[0]?.init.body));
    expect(Object.fromEntries(form)).toEqual({
      secret: "sk-test",
      response: "tok",
      remoteip: "203.0.113.9",
    });

    reply = async () =>
      new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }));
    expect(await v.verify("tok", "203.0.113.9")).toBe(false);
    reply = async () => new Response("oops", { status: 500 });
    expect(await v.verify("tok", "203.0.113.9")).toBe(false);
    reply = async () => new Response("not json");
    expect(await v.verify("tok", "203.0.113.9")).toBe(false);
    reply = async () => {
      throw new Error("network down");
    };
    expect(await v.verify("tok", "203.0.113.9")).toBe(false);
    reply = async () => new Response(JSON.stringify({ success: "true" }));
    expect(await v.verify("tok", "203.0.113.9")).toBe(false);

    const before = calls.length;
    expect(await v.verify(undefined, "1.1.1.1")).toBe(false);
    expect(await v.verify("", "1.1.1.1")).toBe(false);
    expect(await v.verify("x".repeat(5000), "1.1.1.1")).toBe(false);
    expect(calls.length).toBe(before); // no request for an absent or oversized token
  });
});

describe("disposable email domains", () => {
  afterEach(() => configureDisposableDomains({}));
  it("uses the bundled list, parent domains and the wildcard list", () => {
    expect(isDisposableEmail("mailinator.com")).toBe(true);
    expect(isDisposableEmail("MAILINATOR.COM.")).toBe(true);
    expect(isDisposableEmail("someone@mailinator.com")).toBe(true);
    expect(isDisposableEmail("sub.mailinator.com")).toBe(true);
    expect(isDisposableEmail("gmail.com")).toBe(false);
    expect(isDisposableEmail("example.org")).toBe(false);
    expect(isDisposableEmail("")).toBe(false);
  });
  it("local override blocks and allows", () => {
    configureDisposableDomains({ block: ["burner.example"], allow: ["mailinator.com"] });
    expect(isDisposableEmail("burner.example")).toBe(true);
    expect(isDisposableEmail("x.burner.example")).toBe(true);
    expect(isDisposableEmail("mailinator.com")).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "gw-disposable-"));
    try {
      const f = join(dir, "override.txt");
      writeFileSync(f, "# comment\n+temp.example\n-mailinator.com\nplain.example\n");
      loadDisposableOverrideFile(f);
      expect(isDisposableEmail("temp.example")).toBe(true);
      expect(isDisposableEmail("plain.example")).toBe(true);
      expect(isDisposableEmail("burner.example")).toBe(false);
      expect(isDisposableEmail("mailinator.com")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("networkPrefix", () => {
  it("/24 for IPv4 (also when mapped), /48 for IPv6, one bucket for garbage", () => {
    expect(networkPrefix("203.0.113.7")).toBe("v4:203.0.113");
    expect(networkPrefix("::ffff:203.0.113.200")).toBe("v4:203.0.113");
    expect(networkPrefix("2001:db8:abcd:12::1")).toBe("v6:2001:db8:abcd");
    expect(networkPrefix("2001:db8:abcd:ffff:1:2:3:4")).toBe("v6:2001:db8:abcd");
    expect(networkPrefix("not an ip")).toBe("invalid");
    expect(networkPrefix("1.2.3")).toBe("invalid");
  });
});

describe("sign-up surge alert", () => {
  it("warns once when an hour exceeds 10x the trailing mean", () => {
    const lines: string[] = [];
    const s = new SurgeDetector(createLogger({ level: "debug", sink: (l) => lines.push(l) }), {
      floor: 5,
    });
    const H = 3600_000;
    for (let h = 0; h < 24; h++) s.record(h * H); // 1 per hour
    expect(lines).toHaveLength(0);
    for (let i = 0; i < 11; i++) s.record(24 * H + i);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ event: "signup.surge", count: 11 });
  });
});
