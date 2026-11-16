/** Environment variable names (GLIDEWORTH_* with the pre-rename CAIRN_* aliases) and the database file fallback. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { envVar, legacyEnvUse, loadConfig, resolveDbPath } from "../src/config.js";

/** Every variable apps/api reads, with a non-default value and the config field it sets. */
const SETTINGS: [name: string, value: string, field: string, expected: unknown][] = [
  ["API_PORT", "9123", "port", 9123],
  ["HOST", "127.0.0.1", "host", "127.0.0.1"],
  ["SERVE_WEB", "true", "serveWeb", true],
  ["WEB_DIST", "/srv/web", "webDist", "/srv/web"],
  ["DB_PATH", "/srv/data/x.db", "dbPath", "/srv/data/x.db"],
  [
    "BOOTSTRAP_KEY",
    "glideworth_abcdefgh_0123456789abcdef0123456789abcdef",
    "bootstrapKey",
    "glideworth_abcdefgh_0123456789abcdef0123456789abcdef",
  ],
  ["SEED_SAMPLE", "false", "seedSample", false],
  ["WEB_ORIGIN", "http://localhost:9999", "webOrigin", "http://localhost:9999"],
  ["MCP_ALLOW_WRITES", "true", "mcpAllowWrites", true],
  ["MAX_JOBS", "5", "maxConcurrentJobs", 5],
  ["RATE_LIMIT_PER_MIN", "42", "rateLimitPerMinute", 42],
  ["MC_SHARDS", "3", "mcShards", 3],
  ["BROWSER_AUTH", "false", "browserAuth", false],
  ["SESSION_TTL_HOURS", "12", "sessionTtlHours", 12],
  ["SESSION_IDLE_HOURS", "2", "sessionIdleHours", 2],
  ["SETUP_TOKEN", "setup-token-1234", "setupToken", "setup-token-1234"],
  ["COOKIE_SECURE", "true", "cookieSecure", "true"],
  ["TRUST_PROXY", "true", "trustProxy", true],
  ["MAX_BODY_MB", "20", "maxBodyMb", 20],
  ["WEBHOOK_ALLOW_PRIVATE", "true", "webhookAllowPrivate", true],
  ["PUBLIC_URL", "https://plan.example.org", "publicUrl", "https://plan.example.org"],
  ["SHARE_RATE_LIMIT_PER_MIN", "7", "shareRateLimitPerMinute", 7],
  ["SCHEDULER", "false", "scheduler", false],
  ["LOGIN_MAX_ATTEMPTS", "9", "loginMaxAttempts", 9],
  ["LOGIN_WINDOW_MINUTES", "30", "loginWindowMinutes", 30],
];

const quiet = { warn: () => {}, exists: () => false };

describe("environment variables: GLIDEWORTH_* with CAIRN_* aliases", () => {
  it.each(SETTINGS)(
    "%s is read under the new name and under the old one",
    (name, value, field, expected) => {
      expect(
        (loadConfig({ [`GLIDEWORTH_${name}`]: value }, quiet) as Record<string, unknown>)[field],
      ).toEqual(expected);
      expect(
        (loadConfig({ [`CAIRN_${name}`]: value }, quiet) as Record<string, unknown>)[field],
      ).toEqual(expected);
    },
  );

  it("the new name wins when both are set", () => {
    const c = loadConfig(
      { GLIDEWORTH_API_PORT: "9001", CAIRN_API_PORT: "9002", CAIRN_MAX_JOBS: "4" },
      quiet,
    );
    expect(c.port).toBe(9001);
    expect(c.maxConcurrentJobs).toBe(4);
  });

  it("an empty new value does not hide an old one that is set; empty alone behaves as before", () => {
    expect(loadConfig({ GLIDEWORTH_HOST: "", CAIRN_HOST: "::1" }, quiet).host).toBe("::1");
    expect(loadConfig({ GLIDEWORTH_HOST: "" }, quiet).host).toBeUndefined();
    const use = legacyEnvUse();
    expect(envVar({ GLIDEWORTH_X: "", CAIRN_X: "" }, "X", use)).toBe("");
    expect([...use.used]).toEqual([]);
  });

  it("warns once, naming old variables but never printing their values", () => {
    const warn = vi.fn();
    loadConfig(
      {
        CAIRN_SETUP_TOKEN: "secret-setup-token",
        CAIRN_MAX_JOBS: "3",
        GLIDEWORTH_HOST: "h",
        CAIRN_HOST: "other-host",
      },
      { warn, exists: () => false },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]![0]);
    expect(msg).toContain("CAIRN_SETUP_TOKEN -> GLIDEWORTH_SETUP_TOKEN");
    expect(msg).toContain("CAIRN_MAX_JOBS -> GLIDEWORTH_MAX_JOBS");
    expect(msg).toMatch(/ignored because the new name is also set: CAIRN_HOST/);
    expect(msg).not.toContain("secret-setup-token");
    expect(msg).not.toContain("other-host");
    expect(msg.split("\n")).toHaveLength(1);
  });

  it("says nothing when only new names (or identical values under both names) are used", () => {
    const warn = vi.fn();
    loadConfig(
      { GLIDEWORTH_MAX_JOBS: "3", GLIDEWORTH_HOST: "h", CAIRN_HOST: "h" },
      { warn, exists: () => false },
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("by default the warning is printed once per process, to stderr", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    loadConfig({ CAIRN_MAX_JOBS: "3" }, { exists: () => false });
    loadConfig({ CAIRN_MAX_JOBS: "3" }, { exists: () => false });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled(); // stdout belongs to the MCP stdio protocol
    spy.mockRestore();
    log.mockRestore();
  });
});

describe("database file: glideworth.db, falling back to an existing cairn.db", () => {
  it("defaults to ./data/glideworth.db", () => {
    expect(loadConfig({}, quiet).dbPath).toBe("./data/glideworth.db");
  });

  it("uses cairn.db in the same directory when glideworth.db does not exist, and says so once", () => {
    const dir = mkdtempSync(join(tmpdir(), "glideworth-config-"));
    writeFileSync(join(dir, "cairn.db"), "");
    const warn = vi.fn();
    const c = loadConfig({ GLIDEWORTH_DB_PATH: join(dir, "glideworth.db") }, { warn });
    expect(c.dbPath).toBe(join(dir, "cairn.db"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(
      /using the existing database .*cairn\.db.*not moved or copied/,
    );
    // Once glideworth.db exists it is used, and the old file is left alone.
    writeFileSync(join(dir, "glideworth.db"), "");
    const warn2 = vi.fn();
    expect(
      loadConfig({ GLIDEWORTH_DB_PATH: join(dir, "glideworth.db") }, { warn: warn2 }).dbPath,
    ).toBe(join(dir, "glideworth.db"));
    expect(warn2).not.toHaveBeenCalled();
  });

  it("only for the default file name; an explicit path (old variable included) is used as given", () => {
    const exists = (p: string) => p.endsWith("cairn.db");
    expect(resolveDbPath("/d/glideworth.db", exists)).toEqual({
      path: "/d/cairn.db",
      legacy: true,
    });
    expect(resolveDbPath("/d/glideworth.db", () => false)).toEqual({
      path: "/d/glideworth.db",
      legacy: false,
    });
    expect(resolveDbPath("/d/mine.db", exists)).toEqual({ path: "/d/mine.db", legacy: false });
    expect(resolveDbPath("/d/cairn.db", exists)).toEqual({ path: "/d/cairn.db", legacy: false });
    expect(resolveDbPath(":memory:", exists)).toEqual({ path: ":memory:", legacy: false });
    expect(loadConfig({ CAIRN_DB_PATH: "/srv/cairn.db" }, quiet).dbPath).toBe("/srv/cairn.db");
  });
});
