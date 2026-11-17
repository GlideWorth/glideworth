/**
 * Optional dead-man's-switch pings (Healthchecks.io style). Each URL is pinged when its job succeeds and
 * `<URL>/fail` when it fails; a monitor that stops hearing from the app alerts by itself.
 *
 *   GLIDEWORTH_HEARTBEAT_BACKUP_URL        after each backup sweep (tenants and the control database)
 *   GLIDEWORTH_HEARTBEAT_RESTORE_TEST_URL  after each daily restore test
 *   GLIDEWORTH_HEARTBEAT_LIVENESS_URL      every 5 minutes while the server runs and can read its database
 *
 * The request is a bare GET: no body, no query, no custom header, nothing about customers. It has a short
 * timeout and is never awaited by the job. The URL itself is treated as a secret (it is the check's only
 * credential), so it is never logged.
 */
import type { Logger } from "./log/index.js";

export interface HeartbeatConfig {
  backup: string | null;
  restoreTest: string | null;
  liveness: string | null;
}

export const HEARTBEAT_ENV = {
  backup: "GLIDEWORTH_HEARTBEAT_BACKUP_URL",
  restoreTest: "GLIDEWORTH_HEARTBEAT_RESTORE_TEST_URL",
  liveness: "GLIDEWORTH_HEARTBEAT_LIVENESS_URL",
} as const satisfies Record<keyof HeartbeatConfig, string>;

export const HEARTBEAT_TIMEOUT_MS = 5_000;
export const LIVENESS_MS = 5 * 60_000;

/** Parse the three optional URLs; problems are pushed by variable name only. */
export function loadHeartbeats(env: NodeJS.ProcessEnv, problems: string[]): HeartbeatConfig {
  const one = (name: string): string | null => {
    const raw = env[name]?.trim();
    if (!raw) return null;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      problems.push(`${name} must be an absolute URL`);
      return null;
    }
    if (u.protocol !== "https:") {
      problems.push(`${name} must be an https URL`);
      return null;
    }
    if (u.username || u.password || u.search || u.hash) {
      problems.push(`${name} must not contain credentials, a query or a fragment`);
      return null;
    }
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  };
  return {
    backup: one(HEARTBEAT_ENV.backup),
    restoreTest: one(HEARTBEAT_ENV.restoreTest),
    liveness: one(HEARTBEAT_ENV.liveness),
  };
}

export type Ping = (kind: keyof HeartbeatConfig, ok: boolean) => void;

/**
 * A pinger for the configured URLs. Fire and forget: errors and non-2xx answers are logged as a warning
 * (kind and status only) and never thrown.
 */
export function createPinger(
  config: HeartbeatConfig,
  log: Logger,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = HEARTBEAT_TIMEOUT_MS,
): Ping {
  return (kind, ok) => {
    const base = config[kind];
    if (!base) return;
    const url = ok ? base : `${base}/fail`;
    let p: Promise<Response>;
    try {
      p = fetchImpl(url, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      log.warn("heartbeat.ping_failed", { kind, err });
      return;
    }
    p.then(
      (res) => {
        if (!res.ok) log.warn("heartbeat.ping_failed", { kind, statusCode: res.status });
        void res.body?.cancel().catch(() => {});
      },
      (err: unknown) => log.warn("heartbeat.ping_failed", { kind, err }),
    );
  };
}
