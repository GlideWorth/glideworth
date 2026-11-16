import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

/**
 * Environment variables are documented as `GLIDEWORTH_<NAME>`. Every pre-rename `CAIRN_<NAME>` keeps
 * working as an alias: the new name wins when both are set, and start-up warns once (names only, never
 * values) when an old name is used. Every reader of these variables goes through `envVar`.
 */
export const ENV_PREFIX = "GLIDEWORTH_";
export const LEGACY_ENV_PREFIX = "CAIRN_";

/** Old variable names seen while reading the environment: used (no new name set) or ignored (new name set). */
export interface LegacyEnvUse {
  used: Set<string>;
  ignored: Set<string>;
}

export const legacyEnvUse = (): LegacyEnvUse => ({ used: new Set(), ignored: new Set() });

const isSet = (v: string | undefined): v is string => v !== undefined && v !== "";

/**
 * `GLIDEWORTH_<name>`, else the old `CAIRN_<name>`. An empty value counts as unset when choosing between the
 * two, so a blank `GLIDEWORTH_HOST=` line does not hide a `CAIRN_HOST` that is set.
 */
export function envVar(
  env: NodeJS.ProcessEnv,
  name: string,
  use?: LegacyEnvUse,
): string | undefined {
  const next = env[ENV_PREFIX + name];
  const old = env[LEGACY_ENV_PREFIX + name];
  if (isSet(next)) {
    if (isSet(old) && old !== next) use?.ignored.add(LEGACY_ENV_PREFIX + name);
    return next;
  }
  if (isSet(old) || (next === undefined && old !== undefined)) {
    use?.used.add(LEGACY_ENV_PREFIX + name);
    return old;
  }
  return next;
}

/** The one start-up warning about old variable names (null when none is in use). Names only, never values. */
export function legacyEnvWarning(use: LegacyEnvUse): string | null {
  const parts: string[] = [];
  const renamed = (names: Set<string>) =>
    [...names].sort().map((n) => `${n} -> ${ENV_PREFIX}${n.slice(LEGACY_ENV_PREFIX.length)}`);
  if (use.used.size)
    parts.push(
      `deprecated environment variable names in use (they still work; rename them): ${renamed(use.used).join(", ")}`,
    );
  if (use.ignored.size)
    parts.push(`ignored because the new name is also set: ${[...use.ignored].sort().join(", ")}`);
  return parts.length ? `[glideworth] ${parts.join(". ")}.` : null;
}

/** The database file name before the rename. */
export const LEGACY_DB_FILE = "cairn.db";
export const DB_FILE = "glideworth.db";

/**
 * The database to open. When the configured file is a `glideworth.db` that does not exist yet and a
 * pre-rename `cairn.db` exists in the same directory, the old file stays in use (it is never moved or copied).
 */
export function resolveDbPath(
  dbPath: string,
  exists: (p: string) => boolean = existsSync,
): { path: string; legacy: boolean } {
  if (dbPath === ":memory:" || basename(dbPath) !== DB_FILE || exists(dbPath))
    return { path: dbPath, legacy: false };
  const old = join(dirname(dbPath), LEGACY_DB_FILE);
  return exists(old) ? { path: old, legacy: true } : { path: dbPath, legacy: false };
}

/** `GLIDEWORTH_MODE` (alias `CAIRN_MODE`): `selfhost` (default) or `cloud` (design section 1). */
export type Mode = "selfhost" | "cloud";

class ModeError extends Error {
  constructor() {
    super("GLIDEWORTH_MODE must be selfhost or cloud");
    this.name = "ModeError";
  }
}

/** The deployment mode. Read before anything else: cloud mode never parses the self-host configuration. */
export function resolveMode(env: NodeJS.ProcessEnv = process.env): Mode {
  const raw = envVar(env, "MODE")?.trim().toLowerCase();
  if (!raw || raw === "selfhost" || raw === "self-host") return "selfhost";
  if (raw === "cloud") return "cloud";
  throw new ModeError();
}

/**
 * The one data directory of both modes (`GLIDEWORTH_DATA_DIR`). Self-host keeps its database there as
 * `glideworth.db` unless `GLIDEWORTH_DB_PATH` names a file; cloud keeps the control plane and the workspaces.
 */
const defaultDbPath = (env: NodeJS.ProcessEnv, use?: LegacyEnvUse): string =>
  `${
    envVar(env, "DATA_DIR", use)
      ?.trim()
      .replace(/(.)\/+$/, "$1") || "./data"
  }/${DB_FILE}`;

const bool = (dflt: boolean) =>
  z
    .enum(["true", "false"])
    .default(dflt ? "true" : "false")
    .transform((v) => v === "true");

const Config = z.object({
  port: z.coerce.number().int().default(8787),
  /** Interface to listen on (default: all). Use 127.0.0.1 behind a reverse proxy on the same host. */
  host: z.string().optional(),
  /** `NODE_ENV=production` (set by `pnpm start` and the Docker image). */
  production: z.boolean().default(false),
  /** Serve the built web app. Default: on in production. */
  serveWeb: z.boolean().optional(),
  /** Built web app directory (default: apps/web/dist next to this package). */
  webDist: z.string().optional(),
  dbPath: z.string().default(`./data/${DB_FILE}`),
  bootstrapKey: z.string().optional(),
  seedSample: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /**
   * Origin allowed to call the API from a browser (CORS + CSRF host check): the Vite dev server.
   * Default `http://localhost:5173` in development; none in production (the web app is same-origin),
   * because a page on another localhost port is same-site and would otherwise be trusted with your session.
   */
  webOrigin: z.string().optional(),
  maxConcurrentJobs: z.coerce.number().int().min(1).max(16).default(2),
  /** Requests per minute per API key; 0 disables. */
  rateLimitPerMinute: z.coerce.number().int().min(0).default(600),
  /** MCP write tools are off unless explicitly enabled (and the key has write scope). */
  mcpAllowWrites: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Worker threads one Monte Carlo run is split across (1 = no sharding). Default min(CPUs, 4). */
  mcShards: z.coerce.number().int().min(1).max(32).optional(),
  /** Passphrase + session-cookie sign-in for the browser. API keys always work. */
  browserAuth: bool(true),
  /** Session lifetime and idle timeout, in hours. */
  sessionTtlHours: z.coerce.number().positive().default(168),
  sessionIdleHours: z.coerce.number().positive().default(24),
  /** Required in the first-run setup request when set (protects a fresh, internet-facing instance). */
  setupToken: z.string().min(8).optional(),
  /** Cookie Secure flag: auto = when the request is https (or X-Forwarded-Proto says so). */
  cookieSecure: z.enum(["auto", "true", "false"]).default("auto"),
  /** Trust X-Forwarded-For for login throttling (only behind a reverse proxy you control). */
  trustProxy: bool(false),
  /** Largest request body accepted, in megabytes. */
  maxBodyMb: z.coerce.number().positive().max(200).default(10),
  /** Let webhooks deliver to loopback/private/link-local addresses (off by default: SSRF guard). */
  webhookAllowPrivate: bool(false),
  /** Public base URL (https://glideworth.example.com): the OAuth issuer and the base of every OAuth endpoint. Default: the request's origin. */
  publicUrl: z.string().url().optional(),
  /** Public share-link reads per minute per client address (0 = unlimited). */
  shareRateLimitPerMinute: z.coerce.number().int().min(0).default(60),
  /** Run scheduled check-ins in this process (the schedule itself is set through the API). */
  scheduler: bool(true),
  loginMaxAttempts: z.coerce.number().int().min(1).default(5),
  loginWindowMinutes: z.coerce.number().positive().default(15),
  /** A background job (worker thread) running longer than this is stopped and fails with JOB_TIMEOUT. */
  maxJobSeconds: z.coerce.number().int().min(10).max(86_400).default(1800),
  /** Heap limit of one worker thread, in MiB (`resourceLimits.maxOldGenerationSizeMb`). */
  workerMaxMb: z.coerce.number().int().min(64).max(65_536).default(2048),
});
export type Config = z.infer<typeof Config>;

export interface LoadConfigOptions {
  /** Where start-up notices go (stderr: the MCP stdio server owns stdout). Default: once per process. */
  warn?: (message: string) => void;
  /** File existence check for the old-database fallback (tests). */
  exists?: (path: string) => boolean;
}

let warnedOnce = false;
const warnOncePerProcess = (message: string) => {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(message);
};

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadConfigOptions = {},
): Config {
  const use = legacyEnvUse();
  const v = (name: string) => envVar(env, name, use);
  const serveWeb = v("SERVE_WEB");
  const config = Config.parse({
    port: v("API_PORT"),
    host: v("HOST") || undefined,
    production: env.NODE_ENV === "production",
    serveWeb: serveWeb ? serveWeb === "true" : undefined,
    webDist: v("WEB_DIST") || undefined,
    dbPath: v("DB_PATH") || defaultDbPath(env, use),
    bootstrapKey: v("BOOTSTRAP_KEY") || undefined,
    seedSample: v("SEED_SAMPLE"),
    webOrigin:
      v("WEB_ORIGIN") || (env.NODE_ENV === "production" ? undefined : "http://localhost:5173"),
    mcpAllowWrites: v("MCP_ALLOW_WRITES"),
    maxConcurrentJobs: v("MAX_JOBS"),
    rateLimitPerMinute: v("RATE_LIMIT_PER_MIN"),
    mcShards: v("MC_SHARDS") || undefined,
    browserAuth: v("BROWSER_AUTH") || undefined,
    sessionTtlHours: v("SESSION_TTL_HOURS") || undefined,
    sessionIdleHours: v("SESSION_IDLE_HOURS") || undefined,
    setupToken: v("SETUP_TOKEN") || undefined,
    cookieSecure: v("COOKIE_SECURE") || undefined,
    trustProxy: v("TRUST_PROXY") || undefined,
    maxBodyMb: v("MAX_BODY_MB") || undefined,
    webhookAllowPrivate: v("WEBHOOK_ALLOW_PRIVATE") || undefined,
    publicUrl: v("PUBLIC_URL") || undefined,
    shareRateLimitPerMinute: v("SHARE_RATE_LIMIT_PER_MIN") || undefined,
    scheduler: v("SCHEDULER") || undefined,
    loginMaxAttempts: v("LOGIN_MAX_ATTEMPTS") || undefined,
    loginWindowMinutes: v("LOGIN_WINDOW_MINUTES") || undefined,
    maxJobSeconds: v("MAX_JOB_SECONDS") || undefined,
    workerMaxMb: v("WORKER_MAX_MB") || undefined,
  });
  const warn = opts.warn ?? warnOncePerProcess;
  const notices: string[] = [];
  const legacy = legacyEnvWarning(use);
  if (legacy) notices.push(legacy);
  const db = resolveDbPath(config.dbPath, opts.exists);
  if (db.legacy) {
    notices.push(
      `[glideworth] using the existing database ${db.path} (pre-rename file name; ${config.dbPath} does not exist). It is not moved or copied.`,
    );
    config.dbPath = db.path;
  }
  if (notices.length) warn(notices.join("\n"));
  return config;
}

/** Directory of the built web app, when it should be served. */
export function resolveWebDist(config: Config, here: string): string | undefined {
  const serve = config.serveWeb ?? config.production;
  if (!serve) return undefined;
  return config.webDist ? resolve(config.webDist) : resolve(here, "..", "..", "web", "dist");
}

export function authOptions(config: Config) {
  return {
    sessionTtlMs: config.sessionTtlHours * 3600 * 1000,
    sessionIdleMs: config.sessionIdleHours * 3600 * 1000,
    maxFailedLogins: config.loginMaxAttempts,
    maxFailedLoginsGlobal: config.loginMaxAttempts * 5,
    loginWindowMs: config.loginWindowMinutes * 60 * 1000,
    setupToken: config.setupToken,
  };
}
