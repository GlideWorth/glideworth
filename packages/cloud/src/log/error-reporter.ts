/**
 * Server error reports for the hosted service (design 6.4): an `ErrorReporter` that sends PostHog `$exception`
 * events, and `reportingLogger`, which feeds it every `log.error(event, { err })` line.
 *
 * What is sent is built from `describeErrorForLog` only: the error's name, code, the 12-hex fingerprint of its
 * message and its stack frames (code locations). Never the message, a request, a body, a figure, a name or an
 * email address. Tags are a short allowlist (`REPORT_TAGS`) scrubbed like log values; the PostHog distinct id
 * is the workspace's account id when the line carries one, otherwise a fixed server id. No person profile is
 * created and PostHog's GeoIP lookup is off (the request comes from our server, never a customer's browser).
 *
 * Plain `fetch` to PostHog's capture endpoint (`<host>/i/v0/e/`), not `posthog-node`: its `captureException`
 * reads the error's message and, for Node, the source lines around each frame, which this rule forbids; one
 * small request per report needs no client library.
 *
 * Never blocks or throws into the caller: `capture` is synchronous and queues one request with a short
 * timeout. A storm cannot flood PostHog: the same error (name, code, fingerprint, top frame, log event) is
 * sent at most once per `dedupeMs`, the next one carrying how many were suppressed; at most `maxPerMinute`
 * reports leave the process per minute and at most `maxInFlight` requests are open; the rest are dropped and
 * counted. `flush` waits (bounded) for the open requests; the server calls it on shutdown and on a crash.
 */
import {
  describeErrorForLog,
  type ErrorReporter,
  type LogFields,
  type Logger,
  type LogValue,
  scrubLogValue,
} from "./index.js";

/** The tags a report may carry (a subset of the log allowlist: no user, operator or session ids). */
const REPORT_TAGS = [
  "accountId",
  "route",
  "method",
  "statusCode",
  "component",
  "kind",
  "template",
  "jobId",
  "commandId",
  "backupId",
  "exportId",
  "step",
  "attempt",
] as const satisfies ReadonlyArray<keyof LogFields>;

/** The distinct id of reports that belong to no workspace. */
export const SERVER_DISTINCT_ID = "glideworth-server";

export interface PostHogReporterOptions {
  /** The PostHog project token (public by design; the web app uses the same one). */
  token: string;
  /** The PostHog ingestion host, e.g. `https://us.i.posthog.com`. */
  host: string;
  /** The image tag, sent as `release` so a report maps to a deploy. */
  release?: string | null;
  /** Warnings about the reporter itself (never at error level, so they are never reported). */
  log?: Logger;
  fetch?: typeof fetch;
  now?: () => number;
  /** The same error is sent at most once per this window (default 10 minutes). */
  dedupeMs?: number;
  /** Reports per minute for the whole process (default 30). */
  maxPerMinute?: number;
  /** Open requests at once (default 4). */
  maxInFlight?: number;
  /** Per request (default 5 seconds). */
  timeoutMs?: number;
}

interface Frame {
  platform: "node:javascript";
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

const FRAME_RE = /^at (?:(.+?) \()?(.+?)(?::(\d+))?(?::(\d+))?\)?$/;

/** `describeErrorForLog` frames (innermost first) as PostHog raw frames (outermost first, Sentry order). */
export function toPostHogFrames(stack: string | null): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split("\n")) {
    const m = FRAME_RE.exec(line.trim());
    if (!m) continue;
    const filename = (m[2] as string).replace(/^async /, "");
    frames.push({
      platform: "node:javascript",
      filename,
      function: (m[1] ?? "<anonymous>").replace(/^async /, ""),
      ...(m[3] ? { lineno: Number(m[3]) } : {}),
      ...(m[4] ? { colno: Number(m[4]) } : {}),
      in_app: !filename.startsWith("node:") && !filename.includes("/node_modules/"),
    });
  }
  return frames.reverse();
}

/** The `$exception` event for one error: describeErrorForLog fields and allowlisted tags only. */
function exceptionEvent(
  err: unknown,
  tags: LogFields,
  event: string | undefined,
  o: { token: string; timestamp: string; suppressed?: number; release?: string | null },
): Record<string, unknown> {
  const d = describeErrorForLog(err);
  const props: Record<string, LogValue> = {};
  for (const k of REPORT_TAGS) {
    const v = tags[k];
    if (v === undefined || v === null) continue;
    const s = scrubLogValue(k, v);
    if (s !== undefined && s !== null && s !== "[redacted]") props[k] = s;
  }
  const accountId = typeof props.accountId === "string" ? props.accountId : null;
  return {
    api_key: o.token,
    event: "$exception",
    distinct_id: accountId ?? SERVER_DISTINCT_ID,
    timestamp: o.timestamp,
    properties: {
      $exception_list: [
        {
          type: d.errName,
          // The message is never sent: its fingerprint keeps different messages apart.
          value: `${d.errCode ?? d.errName} (message ${d.errFingerprint})`,
          mechanism: { handled: true, synthetic: false, type: "generic" },
          stacktrace: { type: "raw", frames: toPostHogFrames(d.stack) },
        },
      ],
      $exception_level: "error",
      $process_person_profile: false,
      $geoip_disable: true,
      $lib: "glideworth-server",
      source: "server",
      ...(o.release ? { release: o.release } : {}),
      logEvent: event ?? null,
      errName: d.errName,
      errCode: d.errCode,
      errFingerprint: d.errFingerprint,
      ...(o.suppressed ? { suppressedCount: o.suppressed } : {}),
      ...props,
    },
  };
}

const MAX_KEYS = 500;

export function createPostHogErrorReporter(o: PostHogReporterOptions): ErrorReporter {
  const send = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const dedupeMs = o.dedupeMs ?? 10 * 60_000;
  const maxPerMinute = o.maxPerMinute ?? 30;
  const maxInFlight = o.maxInFlight ?? 4;
  const timeoutMs = o.timeoutMs ?? 5_000;
  const url = `${o.host.replace(/\/+$/, "")}/i/v0/e/`;
  /** key -> when it was last sent and how many were suppressed since. */
  const seen = new Map<string, { at: number; suppressed: number }>();
  const inFlight = new Set<Promise<void>>();
  let tokens = maxPerMinute;
  let refilledAt = now();
  let dropped = 0;
  let warnedAt = Number.NEGATIVE_INFINITY;

  const warn = (reason: string, statusCode?: number) => {
    const t = now();
    if (t - warnedAt < 60_000) return;
    warnedAt = t;
    o.log?.warn("error_report.not_sent", {
      reason,
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(dropped ? { count: dropped } : {}),
    });
  };

  const takeToken = (): boolean => {
    const t = now();
    tokens = Math.min(maxPerMinute, tokens + ((t - refilledAt) / 60_000) * maxPerMinute);
    refilledAt = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  const capture = (err: unknown, tags: LogFields = {}, event?: string) => {
    const d = describeErrorForLog(err);
    const top = d.stack?.split("\n", 1)[0] ?? "";
    const key = [event ?? "", d.errName, d.errCode ?? "", d.errFingerprint, top].join("|");
    const t = now();
    const prev = seen.get(key);
    if (prev && t - prev.at < dedupeMs) {
      prev.suppressed++;
      return;
    }
    if (inFlight.size >= maxInFlight || !takeToken()) {
      dropped++;
      warn("rate_limited");
      return;
    }
    const suppressed = prev?.suppressed ?? 0;
    seen.delete(key);
    seen.set(key, { at: t, suppressed: 0 });
    if (seen.size > MAX_KEYS) seen.delete(seen.keys().next().value as string);

    const body = JSON.stringify(
      exceptionEvent(err, tags, event, {
        token: o.token,
        timestamp: new Date(t).toISOString(),
        suppressed,
        release: o.release ?? null,
      }),
    );
    const p: Promise<void> = Promise.resolve()
      .then(() =>
        send(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        }),
      )
      .then(
        (res) => {
          if (!res.ok) warn("http_error", res.status);
        },
        () => warn("network_error"),
      )
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  };

  return {
    capture(err, tags, event) {
      try {
        capture(err, tags, event);
      } catch {
        // never into the caller
      }
    },
    async flush(timeoutMs = 5_000) {
      if (!inFlight.size) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise<void>((r) => {
          timer = setTimeout(r, timeoutMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    },
  };
}

/**
 * `log` with every `error(event, { err })` line also sent to `reporter`, with the line's fields and those of
 * the logger's `child()` bindings as tags. Lines without an `err`, and other levels, are only logged.
 */
export function reportingLogger(
  log: Logger,
  reporter: ErrorReporter,
  bound: LogFields = {},
): Logger {
  return {
    debug: (e, f) => log.debug(e, f),
    info: (e, f) => log.info(e, f),
    warn: (e, f) => log.warn(e, f),
    error: (e, f) => {
      log.error(e, f);
      if (f?.err === undefined) return;
      const { err, ...fields } = f;
      reporter.capture(err, { ...bound, ...fields }, e);
    },
    child: (f) => reportingLogger(log.child(f), reporter, { ...bound, ...f }),
  };
}
