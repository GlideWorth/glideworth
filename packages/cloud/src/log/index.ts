/**
 * `@glideworth/cloud/log`: the structured logger both modes use (spec 6.4). Imports nothing else from the
 * package so `apps/api` can load it in self-host mode.
 *
 * Rule: no financial value, plan content, household or plan name, notification title, request body, query
 * string, cookie, token, email address or error message text ever reaches a log line.
 *
 * Mechanism, in layers:
 *  1. Types. Field names are the `LogField` union (the allowlist), so `log.info('x', { body })` or
 *     `{ message: err.message }` does not compile. Values are scalars only: an `Error`, a request or a parsed
 *     body cannot be passed as a value. The only way to log an error is the `err` field, typed `unknown` and
 *     reduced by `describeErrorForLog`, which never reads `.message`.
 *  2. Runtime allowlist. Names outside `LOG_FIELD_ALLOWLIST` (+ `extraFields`) are dropped and counted in
 *     `droppedFields` (covers JavaScript callers and casts).
 *  3. Runtime value scrub. A string value that looks like an email address, a bearer credential, a long
 *     random token, or that contains whitespace runs typical of prose is replaced by `[redacted]`; strings
 *     are capped at 200 characters. Event names must be dotted identifiers (`auth.signin_failed`).
 */
import { createHash } from "node:crypto";

export type LogValue = string | number | boolean | null | undefined;
export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_FIELD_ALLOWLIST = [
  // identifiers (opaque, never secrets)
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
  // classification
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
  // numbers
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
  // error description (from describeErrorForLog only)
  "errName",
  "errCode",
  "errFingerprint",
  "stack",
] as const;

export type LogField = (typeof LOG_FIELD_ALLOWLIST)[number];

/** Allowlisted fields only. Weak-type checking also rejects an object that shares no name with the allowlist. */
export type LogFields<F extends string = LogField> = { [K in F]?: LogValue };

export interface Logger<F extends string = LogField> {
  debug(event: string, f?: LogFields<F>): void;
  info(event: string, f?: LogFields<F>): void;
  warn(event: string, f?: LogFields<F> & { err?: unknown }): void;
  error(event: string, f?: LogFields<F> & { err?: unknown }): void;
  child(f: LogFields<F>): Logger<F>;
}

/**
 * Error tracking (design 6.4), fed only by `describeErrorForLog` output and allowlisted tags. `capture` never
 * blocks or throws; `flush` waits (at most `timeoutMs`) for reports still being sent. See `./error-reporter.ts`.
 */
export interface ErrorReporter {
  capture(err: unknown, tags?: LogFields, event?: string): void;
  flush(timeoutMs?: number): Promise<void>;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const EVENT_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const RESERVED = new Set(["level", "time", "event", "droppedFields"]);

const EMAIL_LIKE = /[^\s@]@[^\s@]+\.[^\s@]/;
const CREDENTIAL_LIKE = /\b(gw[karcs]|glideworth|cairn|scrypt)[_$]/i;
/** 32+ characters of a base64url/base32/hex token, or of standard base64 (route templates do not match). */
const TOKEN_LIKE =
  /[A-Za-z0-9_-]{32,}|(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]{32,}/;
/** Three or more words: a message, a name or free text, never one of the identifiers or enums we log. */
const PROSE_LIKE = /\S\s+\S+\s+\S/;
const MAX_STRING = 200;

/** The value scrub every log line gets (also applied to error report tags). */
export function scrubLogValue(field: string, v: LogValue): LogValue {
  if (typeof v !== "string") {
    if (typeof v === "number" && !Number.isFinite(v)) return null;
    return v;
  }
  if (field === "stack") return v.slice(0, 4000); // already reduced to frames by describeErrorForLog
  if (EMAIL_LIKE.test(v) || CREDENTIAL_LIKE.test(v) || TOKEN_LIKE.test(v) || PROSE_LIKE.test(v))
    return "[redacted]";
  return v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v;
}

/**
 * Name, code, a fingerprint of the message (SHA-256, first 12 hex) and the stack frames only. The message
 * itself is never returned, and neither is any non-frame stack line (a multi-line message would otherwise
 * leak through the stack).
 */
export function describeErrorForLog(err: unknown): {
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

export function createLogger<X extends string = never>(o: {
  level: LogLevel;
  sink?: (line: string) => void;
  extraFields?: readonly X[];
  now?: () => Date;
}): Logger<LogField | X> {
  const allowed = new Set<string>([...LOG_FIELD_ALLOWLIST, ...(o.extraFields ?? [])]);
  for (const r of RESERVED) allowed.delete(r);
  const sink = o.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const min = LEVELS[o.level] ?? LEVELS.info;
  const clock = o.now ?? (() => new Date());

  const make = (base: Record<string, LogValue>): Logger<LogField | X> => {
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
        if (v !== null && typeof v === "object") {
          dropped++;
          return;
        }
        if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") {
          dropped++;
          return;
        }
        line[k] = scrubLogValue(k, v as LogValue);
      };
      for (const [k, v] of Object.entries(base)) put(k, v);
      if (fields) {
        for (const [k, v] of Object.entries(fields)) {
          if (k === "err") {
            if (v !== undefined)
              for (const [ek, ev] of Object.entries(describeErrorForLog(v))) put(ek, ev);
            continue;
          }
          put(k, v);
        }
      }
      if (dropped > 0) line.droppedFields = dropped;
      try {
        sink(JSON.stringify(line));
      } catch {
        // a logger must never throw into its caller
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

/** A logger that discards everything (default when none is injected). */
export const silentLogger: Logger = createLogger({ level: "error", sink: () => {} });
