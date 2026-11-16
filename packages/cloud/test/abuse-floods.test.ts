/**
 * T-ABUSE in this package (spec 3.7, 6.1, 10): sign-up floods per address, per network and across the cell;
 * OAuth client registration floods from one address do not block others; never-consented clients are purged.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { controlOAuthClients, OAUTH_REGISTRATION_LIMITS } from "../src/control/oauth-clients.js";
import {
  Browser,
  type Cloud,
  makeCloud,
  removeTempDirs,
  strongPassword,
  uniqueEmail,
} from "./cloud-fixture.js";
import { logLines } from "./helpers.js";

let cloud: Cloud;
beforeEach(async () => {
  cloud = await makeCloud();
});
afterEach(async () => {
  await cloud.accounts.settled();
  await cloud.close();
  removeTempDirs();
});

const signup = (b: Browser, email = uniqueEmail("flood")) =>
  b.post("/api/v1/auth/signup", {
    email,
    password: strongPassword(),
    name: "F",
    captchaToken: "captcha-ok",
    termsVersion: "2026-11",
    adultConfirmed: true,
  });

describe("sign-up floods", () => {
  it("5 per hour per IP, 50 per day per /24, without the CAPTCHA nothing at all", async () => {
    const b = new Browser(cloud.app);
    b.ip = "198.51.100.7";
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await signup(b)).status);
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    // The same /24 from other addresses: 50 per day in total, then refused.
    let accepted = 5;
    let refused = 0;
    for (let i = 10; i < 80 && refused === 0; i++) {
      const other = new Browser(cloud.app);
      other.ip = `198.51.100.${i}`;
      const s = (await signup(other)).status;
      if (s === 202) accepted++;
      else refused++;
    }
    expect(accepted).toBe(50);
    expect(refused).toBe(1);
    const elsewhere = new Browser(cloud.app);
    elsewhere.ip = "192.0.2.10";
    expect((await signup(elsewhere)).status).toBe(202);
    const noCaptcha = await new Browser(cloud.app).post("/api/v1/auth/signup", {
      email: uniqueEmail(),
      password: strongPassword(),
      name: "N",
      termsVersion: "1",
      adultConfirmed: true,
    });
    expect(noCaptcha.status).toBe(403);
  });

  it("a cell-wide surge is alerted", async () => {
    for (let i = 0; i < 60; i++) {
      const b = new Browser(cloud.app);
      b.ip = `10.${Math.floor(i / 250)}.${i % 250}.9`;
      await signup(b);
    }
    expect(logLines.some((l) => l.includes("signup.surge"))).toBe(true);
  });
});

describe("OAuth client registration", () => {
  const client = (n: number) => ({
    id: `glideworth-client-${n}`,
    name: "MCP client",
    redirectUris: ["https://c.example/cb"],
    scope: null,
  });

  it("20 per minute and 200 per day per address; another address is not affected", () => {
    const reg = controlOAuthClients({ db: cloud.db, limiter: cloud.limiter, now: cloud.now });
    let n = 0;
    for (let i = 0; i < OAUTH_REGISTRATION_LIMITS.perMinute; i++)
      reg.register(client(n++), "203.0.113.5");
    expect(() => reg.register(client(n++), "203.0.113.5")).toThrow(/too many client registrations/);
    reg.register(client(n++), "203.0.113.6");
    // Over the day: minute windows pass, the daily count (from the table) stops it at 200.
    let refusedAt = -1;
    for (let i = 0; i < 300 && refusedAt < 0; i++) {
      if (i % 20 === 0) cloud.advance(61_000);
      try {
        reg.register(client(n++), "203.0.113.5");
      } catch {
        refusedAt = i;
      }
    }
    expect(refusedAt).toBe(OAUTH_REGISTRATION_LIMITS.perDay - OAUTH_REGISTRATION_LIMITS.perMinute);
    expect(() => reg.register(client(n++), "203.0.113.7")).not.toThrow();
  });

  it("never-consented clients are purged after 24 hours; consented ones stay", () => {
    const reg = controlOAuthClients({ db: cloud.db, limiter: cloud.limiter, now: cloud.now });
    reg.register(client(1), "203.0.113.8");
    reg.register(client(2), "203.0.113.8");
    reg.markConsented("glideworth-client-2");
    cloud.advance(25 * 3600_000);
    expect(reg.purge()).toBe(1);
    expect(reg.get("glideworth-client-1")).toBeNull();
    expect(reg.get("glideworth-client-2")?.redirectUris).toEqual(["https://c.example/cb"]);
  });
});
