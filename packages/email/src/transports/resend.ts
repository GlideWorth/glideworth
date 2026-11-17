import { type Address, type EmailTransport, EmailTransportError } from "../types.js";
import { guard } from "./memory.js";

const ENDPOINT = "https://api.resend.com/emails";
/** Resend allows a few requests a second per team (2 by default); pace below that. */
const DEFAULT_MIN_INTERVAL_MS = 550;
/** Cap on how long a Retry-After from Resend may hold up one send. */
const MAX_RETRY_AFTER_MS = 60_000;
const EMAIL_RE = /[^\s<>"'`,;:]+@[^\s<>"'`,;:]+/g;
const TAG_RE = /^[A-Za-z0-9_-]{1,256}$/;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function formatAddress(a: Address): string {
  if (!a.name) return a.email;
  return `"${a.name.replace(/[\\"]/g, "\\$&")}" <${a.email}>`;
}

/** Retry-After is seconds (or an HTTP date); Resend sends seconds. Returns ms, capped, or undefined. */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/**
 * Resend HTTP API (`POST https://api.resend.com/emails`, JSON, `Authorization: Bearer <key>`). No SDK.
 *
 * - Requests are paced (`minIntervalMs`, default 550 ms) so a burst stays under Resend's per-second limit; a 429
 *   with Retry-After pushes the next request back by that much and is retryable. Daily or monthly quota errors
 *   are not retryable here: the outbox tries again hours later.
 * - `idempotencyKey` is sent as `Idempotency-Key`, so a retry after a timeout does not send twice (Resend keeps
 *   keys for 24 hours). A 409 saying the key was already used with another payload means Resend accepted an
 *   earlier attempt, so it counts as sent.
 * - Open and click tracking are settings of the domain at Resend and must stay off there.
 * - Error messages never include the API key or an email address.
 */
export function resendTransport(o: {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  minIntervalMs?: number;
}): EmailTransport {
  if (!o.apiKey) throw new Error("resend apiKey is required");
  if (/\s/.test(o.apiKey)) throw new Error("resend apiKey must not contain whitespace");
  const doFetch = o.fetch ?? fetch;
  const auth = `Bearer ${o.apiKey}`;
  const minInterval = o.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  // Sends start one at a time, each at least minInterval after the previous one actually started, and not
  // before `notBefore` (set from a 429's Retry-After).
  let gate: Promise<void> = Promise.resolve();
  let lastStart = Number.NEGATIVE_INFINITY;
  let notBefore = 0;
  const pace = (): Promise<void> => {
    const turn = gate.then(async () => {
      const wait = Math.max(lastStart + minInterval, notBefore) - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
    });
    gate = turn;
    return turn;
  };
  const clean = (s: string) => s.replaceAll(o.apiKey, "[key]").replace(EMAIL_RE, "[address]");

  return {
    name: "resend",
    async send(msg) {
      guard("resend", msg);
      const body: Record<string, unknown> = {
        from: formatAddress(msg.from),
        to: [formatAddress(msg.to)],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        headers: msg.headers,
      };
      if (msg.replyTo) body.reply_to = formatAddress(msg.replyTo);
      if (TAG_RE.test(msg.template)) body.tags = [{ name: "template", value: msg.template }];
      const headers: Record<string, string> = {
        Authorization: auth,
        "Content-Type": "application/json",
        "User-Agent": "glideworth-email",
      };
      if (msg.idempotencyKey && msg.idempotencyKey.length <= 256)
        headers["Idempotency-Key"] = msg.idempotencyKey;

      await pace();
      let res: Response;
      try {
        res = await doFetch(ENDPOINT, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
        });
      } catch {
        throw new EmailTransportError("resend", "network", true, "could not reach Resend");
      }

      let json: { id?: unknown; name?: unknown; message?: unknown } = {};
      try {
        json = (await res.json()) as typeof json;
      } catch {
        // No JSON body.
      }
      if (res.ok) return { providerMessageId: typeof json.id === "string" ? json.id : null };

      const s = res.status;
      const name = typeof json.name === "string" ? json.name : "";
      const detail = typeof json.message === "string" ? clean(json.message).slice(0, 200) : "";
      const text = `Resend returned ${s}${name ? ` ${name}` : ""}${detail ? `: ${detail}` : ""}`;
      const err = (code: string, retryable: boolean, after?: number) =>
        new EmailTransportError("resend", code, retryable, text, after);

      if (s === 429) {
        if (/quota/i.test(name)) throw err("quota_exceeded", false);
        const after = retryAfterMs(res) ?? 1000;
        notBefore = Math.max(notBefore, Date.now() + after);
        throw err("rate_limited", true, after);
      }
      if (s === 409) {
        if (name === "invalid_idempotent_request") return { providerMessageId: null };
        throw err("idempotency_busy", true);
      }
      if (s >= 500) throw err("provider_error", true);
      if (s === 401 || s === 403) throw err("auth", false);
      if (s === 404) throw err("not_found", false);
      throw err("rejected", false);
    },
  };
}
