/**
 * Structured logging for both modes (design 6.4). Rule: no financial value, plan content, household or plan
 * name, notification title, request body, query string, cookie, token, email address or error message text
 * ever reaches a log line.
 *
 * Cloud mode logs through `@glideworth/cloud/log` (the cloud host installs that logger with `setLogger`).
 * Self-host mode must not load any cloud package (design section 1, test T-MODE), so this module carries the
 * same mechanism for it: allowlisted field names, scalar values only, a value scrub (email addresses,
 * credentials, long tokens and prose become `[redacted]`), and errors reduced to name, code, a fingerprint of
 * the message and stack frames, never the message itself. `test/log.test.ts` checks it line for line against
 * the cloud implementation.
 */
import { createHash } from "node:crypto";

export type LogValue = string | number | boolean | null | undefined;
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Same list as `@glideworth/cloud/log` (checked by test). */
export const LOG_FIELD_ALLOWLIST = [
  "accountId",
  "userId",
  "operatorId",
  "tenantUserId",
  "sessionCount",
  "requestId",
  "jobId",
  "eventId",
  "exportId",
  "backupId",
  "invitationId",
  "component",
  "kind",
  "eventType",
  "template",
  "category",
  "metric",
  "outcome",
  "reason",
  "role",
  "method",
  "route",
  "status",
  "statusCode",
  "provider",
  "transport",
  "level",
  "count",
  "attempt",
  "attempts",
  "durationMs",
  "bytes",
  "limit",
  "remaining",
  "retryAfterMs",
  "schemaVersion",
  "open",
  "leased",
  "busy",
  "waiting",
  "running",
  "step",
  "commandId",
  "port",
  "errName",
  "errCode",
  "errFingerprint",
  "stack",
] as const;

export type LogField = (typeof LOG_FIELD_ALLOWLIST)[number];
export type LogFields = { [K in LogField]?: LogValue };

/** Structurally the cloud package's `Logger`, so either implementation can be installed. */
export interface Logger {
  debug(event: string, f?: LogFields): void;
  info(event: string, f?: LogFields): void;
  warn(event: string, f?: LogFields & { err?: unknown }): void;
  error(event: string, f?: LogFields & { err?: unknown }): void;
  child(f: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const EVENT_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const RESERVED = new Set(["level", "time", "event", "droppedFields"]);
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const CREDENTIAL_LIKE = /\b(gw[karcs]|glideworth|cairn|scrypt)[_$]/i;
const TOKEN_LIKE =
  /[A-Za-z0-9_-]{32,}|(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]{32,}/;
const PROSE_LIKE = /\S+\s+\S+\s+\S+/;
const MAX_STRING = 200;

function scrubValue(field: string, v: LogValue): LogValue {
  if (typeof v !== "string") {
    if (typeof v === "number" && !Number.isFinite(v)) return null;
    return v;
  }
  if (field === "stack") return v.slice(0, 4000);
  if (EMAIL_LIKE.test(v) || CREDENTIAL_LIKE.test(v) || TOKEN_LIKE.test(v) || PROSE_LIKE.test(v))
    return "[redacted]";
  return v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v;
}

/** Name, code, a fingerprint of the message and the stack frames. Never the message. */
function describeErrorForLog(err: unknown): {
  errName: string;
  errCode: string | null;
  errFingerprint: string;
  stack: string | null;
} {
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    stack?: unknown;
  };
  const rawName = typeof e.name === "string" ? e.name : typeof err;
  const errName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(rawName) ? rawName : "Error";
  const errCode =
    typeof e.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(e.code) ? e.code : null;
  const message =
    typeof e.message === "string" ? e.message : typeof err === "string" ? err : String(errName);
  const errFingerprint = createHash("sha256").update(message, "utf8").digest("hex").slice(0, 12);
  const frames =
    typeof e.stack === "string"
      ? e.stack
          .split("\n")
          .filter((l) => /^\s+at\s/.test(l))
          .map((l) => l.trim())
          .slice(0, 30)
      : [];
  return { errName, errCode, errFingerprint, stack: frames.length ? frames.join("\n") : null };
}

export function createLogger(o: {
  level: LogLevel;
  sink?: (line: string) => void;
  now?: () => Date;
}): Logger {
  const allowed = new Set<string>(LOG_FIELD_ALLOWLIST);
  for (const r of RESERVED) allowed.delete(r);
  // stderr: the MCP stdio server owns stdout.
  const sink = o.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const min = LEVELS[o.level] ?? LEVELS.info;
  const clock = o.now ?? (() => new Date());
  const make = (base: Record<string, LogValue>): Logger => {
    const emit = (level: LogLevel, event: string, fields: Record<string, unknown> | undefined) => {
      if (LEVELS[level] < min) return;
      const line: Record<string, unknown> = {
        level,
        time: clock().toISOString(),
        event:
          typeof event === "string" && EVENT_RE.test(event) && event.length <= 100
            ? event
            : "invalid_event",
      };
      let dropped = 0;
      const put = (k: string, v: unknown) => {
        if (!allowed.has(k)) {
          dropped++;
          return;
        }
        if (v === undefined) return;
        if (
          (v !== null && typeof v === "object") ||
          typeof v === "function" ||
          typeof v === "symbol" ||
          typeof v === "bigint"
        ) {
          dropped++;
          return;
        }
        line[k] = scrubValue(k, v as LogValue);
      };
      for (const [k, v] of Object.entries(base)) put(k, v);
      for (const [k, v] of Object.entries(fields ?? {})) {
        if (k === "err") {
          if (v !== undefined)
            for (const [ek, ev] of Object.entries(describeErrorForLog(v))) put(ek, ev);
          continue;
        }
        put(k, v);
      }
      if (dropped > 0) line.droppedFields = dropped;
      try {
        sink(JSON.stringify(line));
      } catch {
        // a logger never throws into its caller
      }
    };
    return {
      debug: (e, f) => emit("debug", e, f),
      info: (e, f) => emit("info", e, f),
      warn: (e, f) => emit("warn", e, f),
      error: (e, f) => emit("error", e, f),
      child: (f) => {
        const merged: Record<string, LogValue> = { ...base };
        for (const [k, v] of Object.entries(f as Record<string, unknown>))
          if (allowed.has(k) && (v === null || typeof v !== "object")) merged[k] = v as LogValue;
        return make(merged);
      },
    };
  };
  return make({});
}

const levelFromEnv = (): LogLevel => {
  const v = (process.env.GLIDEWORTH_LOG_LEVEL ?? process.env.CAIRN_LOG_LEVEL ?? "info") as LogLevel;
  return v in LEVELS ? v : "info";
};

let current: Logger = createLogger({ level: levelFromEnv() });

/** The process logger (errors.ts, services without an injected logger). */
export const log: Logger = {
  debug: (e, f) => current.debug(e, f),
  info: (e, f) => current.info(e, f),
  warn: (e, f) => current.warn(e, f),
  error: (e, f) => current.error(e, f),
  child: (f) => current.child(f),
};

/** Install another logger (cloud mode: the cloud package's; tests: a capturing sink). Returns the previous one. */
export function setLogger(next: Logger): Logger {
  const prev = current;
  current = next;
  return prev;
}
