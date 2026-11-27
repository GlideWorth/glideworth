import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudConfigError, loadCloudConfig, parseKey32 } from "../src/config.js";

const secret = randomBytes(32).toString("hex");
const kek = randomBytes(32).toString("base64");
const base = {
  GLIDEWORTH_PUBLIC_URL: "https://app.example.test/",
  GLIDEWORTH_SECRETS_KEY: secret,
  GLIDEWORTH_BACKUP_KEK: kek,
  GLIDEWORTH_PRICING_FILE: "/etc/glideworth/pricing.json",
};

describe("loadCloudConfig", () => {
  it("parses a minimal development environment with defaults", () => {
    const c = loadCloudConfig({ ...base });
    expect(c.publicUrl).toBe("https://app.example.test");
    expect(c.secretsKey).toHaveLength(32);
    expect(c.backupKek).toMatchObject({ id: "k1" });
    expect(c.backupKek.key).toHaveLength(32);
    expect(c).toMatchObject({
      dataDir: "/data",
      tenantCacheSize: 256,
      opsListen: { host: "127.0.0.1", port: 8789 },
      production: false,
    });
    expect(c.maxJobs).toBeGreaterThanOrEqual(1);
  });

  it("lists every problem at once, by name, never echoing values", () => {
    const env = {
      NODE_ENV: "production",
      GLIDEWORTH_PUBLIC_URL: "http://app.example.test",
      GLIDEWORTH_SECRETS_KEY: "too-short-secret-value",
      GLIDEWORTH_DB_PATH: "/x.db",
      CAIRN_DB_PATH: "/x.db",
      CAIRN_SETUP_TOKEN: "setup-token-value",
      GLIDEWORTH_BOOTSTRAP_KEY: "bootstrap-key-value",
      CAIRN_WEBHOOK_ALLOW_PRIVATE: "true",
      GLIDEWORTH_WEBHOOK_ALLOW_PRIVATE: "true",
      GLIDEWORTH_OPS_LISTEN: "nonsense",
      GLIDEWORTH_TENANT_CACHE_SIZE: "-1",
    };
    try {
      loadCloudConfig(env);
      expect.unreachable();
    } catch (e) {
      const err = e as CloudConfigError;
      expect(err).toBeInstanceOf(CloudConfigError);
      const text = err.problems.join("\n");
      for (const name of [
        "GLIDEWORTH_PUBLIC_URL",
        "GLIDEWORTH_SECRETS_KEY",
        "GLIDEWORTH_BACKUP_KEK",
        "GLIDEWORTH_DB_PATH",
        "CAIRN_DB_PATH",
        "CAIRN_SETUP_TOKEN",
        "GLIDEWORTH_BOOTSTRAP_KEY",
        "CAIRN_WEBHOOK_ALLOW_PRIVATE",
        "GLIDEWORTH_WEBHOOK_ALLOW_PRIVATE",
        "GLIDEWORTH_EMAIL_TRANSPORT",
        "GLIDEWORTH_BILLING",
        "GLIDEWORTH_TURNSTILE_SECRET",
        "GLIDEWORTH_OPS_LISTEN",
        "GLIDEWORTH_TENANT_CACHE_SIZE",
        "GLIDEWORTH_PRICING_FILE",
      ])
        expect(text).toContain(name);
      expect(err.message).not.toContain("too-short-secret-value");
      expect(err.message).not.toContain("setup-token-value");
      expect(err.message).not.toContain("bootstrap-key-value");
    }
  });

  it("refuses the same key for secrets and backups", () => {
    expect(() => loadCloudConfig({ ...base, GLIDEWORTH_BACKUP_KEK: secret })).toThrow(
      /must differ/,
    );
  });

  it("accepts a complete production environment", () => {
    const c = loadCloudConfig({
      ...base,
      NODE_ENV: "production",
      GLIDEWORTH_EMAIL_TRANSPORT: "mailgun",
      GLIDEWORTH_BILLING: "stripe",
      GLIDEWORTH_TURNSTILE_SECRET: "x",
      GLIDEWORTH_OPS_LISTEN: "[::1]:9000",
    });
    expect(c.production).toBe(true);
    expect(c.opsListen).toEqual({ host: "::1", port: 9000 });
  });

  it("accepts the resend transport only with an API key, and refuses unknown transports", () => {
    const prod = {
      ...base,
      NODE_ENV: "production",
      GLIDEWORTH_BILLING: "stripe",
      GLIDEWORTH_TURNSTILE_SECRET: "x",
    };
    expect(
      loadCloudConfig({
        ...prod,
        GLIDEWORTH_EMAIL_TRANSPORT: "resend",
        GLIDEWORTH_RESEND_API_KEY: "re_test",
      }).production,
    ).toBe(true);
    expect(() => loadCloudConfig({ ...prod, GLIDEWORTH_EMAIL_TRANSPORT: "resend" })).toThrow(
      /GLIDEWORTH_RESEND_API_KEY is required/,
    );
    expect(() => loadCloudConfig({ ...prod, GLIDEWORTH_EMAIL_TRANSPORT: "sendgrid" })).toThrow(
      /must be one of file, smtp, mailgun, resend/,
    );
  });

  it("heartbeat URLs are optional, https only, and reported by name", () => {
    expect(loadCloudConfig({ ...base }).heartbeats).toEqual({
      backup: null,
      restoreTest: null,
      liveness: null,
    });
    expect(
      loadCloudConfig({ ...base, GLIDEWORTH_HEARTBEAT_LIVENESS_URL: "https://hc.example.test/p/1" })
        .heartbeats.liveness,
    ).toBe("https://hc.example.test/p/1");
    expect(() =>
      loadCloudConfig({ ...base, GLIDEWORTH_HEARTBEAT_BACKUP_URL: "http://hc.example.test/p/2" }),
    ).toThrow(/GLIDEWORTH_HEARTBEAT_BACKUP_URL must be an https URL/);
  });

  it("parseKey32 accepts hex and base64 of exactly 32 bytes", () => {
    expect(parseKey32(secret)).toHaveLength(32);
    expect(parseKey32(randomBytes(32).toString("base64url"))).toHaveLength(32);
    expect(parseKey32(randomBytes(31).toString("hex"))).toBeNull();
    expect(parseKey32(randomBytes(33).toString("base64"))).toBeNull();
    expect(parseKey32(undefined)).toBeNull();
  });

  it("the calculator email form is off unless the site origin is set, and only an origin is accepted", () => {
    expect(loadCloudConfig({ ...base }).calculatorEmail).toBeNull();
    expect(
      loadCloudConfig({ ...base, GLIDEWORTH_CALCULATOR_EMAIL_ORIGIN: "https://site.example.test/" })
        .calculatorEmail,
    ).toEqual({ siteOrigin: "https://site.example.test", dailyLimit: 50 });
    expect(
      loadCloudConfig({
        ...base,
        GLIDEWORTH_CALCULATOR_EMAIL_ORIGIN: "http://localhost:4321",
        GLIDEWORTH_CALCULATOR_EMAIL_DAILY_LIMIT: "20",
      }).calculatorEmail,
    ).toEqual({ siteOrigin: "http://localhost:4321", dailyLimit: 20 });
    for (const bad of [
      "https://site.example.test/tools",
      "http://site.example.test",
      "site.example",
    ])
      expect(() => loadCloudConfig({ ...base, GLIDEWORTH_CALCULATOR_EMAIL_ORIGIN: bad })).toThrow(
        /GLIDEWORTH_CALCULATOR_EMAIL_ORIGIN/,
      );
    expect(() =>
      loadCloudConfig({
        ...base,
        GLIDEWORTH_CALCULATOR_EMAIL_ORIGIN: "https://site.example.test",
        GLIDEWORTH_CALCULATOR_EMAIL_DAILY_LIMIT: "0",
      }),
    ).toThrow(/GLIDEWORTH_CALCULATOR_EMAIL_DAILY_LIMIT/);
  });
});
