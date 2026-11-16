import { createHmac, timingSafeEqual } from "node:crypto";
import { BillingError } from "./errors.js";
import type { StripeEventView } from "./types.js";

/**
 * Stripe webhook signature verification, implemented on `node:crypto` without the SDK helper.
 *
 * Scheme (docs.stripe.com/webhooks, "Verify webhook signatures manually", checked 2026-11-16): the
 * `Stripe-Signature` header is a comma-separated list of `key=value` entries; `t` is the signing time in seconds,
 * each `v1` is hex HMAC-SHA256 of `${t}.${rawBody}` keyed with the endpoint secret. There may be several `v1`
 * entries (one per active secret while a secret is being rolled, for up to 7 days); at least one must match.
 * `v0` (sandbox) and the debug entries `secret`, `destination`, `payload` are unsigned and ignored. Unknown entries
 * are accepted, order is not significant.
 */

export const DEFAULT_TOLERANCE_SECONDS = 300;
const MAX_HEADER_LENGTH = 8192;
const MAX_V1_ENTRIES = 16;

export type SignatureFailure =
  | "missing_header"
  | "malformed_header"
  | "no_timestamp"
  | "no_signatures"
  | "no_secret"
  | "signature_mismatch"
  | "timestamp_outside_tolerance"
  | "malformed_event";

function fail(reason: SignatureFailure): never {
  throw new BillingError("SIGNATURE_INVALID", `Webhook signature rejected (${reason})`, { reason });
}

export interface ParsedSignatureHeader {
  timestamp: number;
  v1: Buffer[];
}

export function parseSignatureHeader(header: string | undefined | null): ParsedSignatureHeader {
  if (header === undefined || header === null || header.trim() === "") fail("missing_header");
  if (header.length > MAX_HEADER_LENGTH) fail("malformed_header");
  let timestamp: number | null = null;
  const v1: Buffer[] = [];
  for (const rawItem of header.split(",")) {
    const item = rawItem.trim();
    if (item === "") continue;
    const eq = item.indexOf("=");
    if (eq <= 0) fail("malformed_header");
    const key = item.slice(0, eq);
    const value = item.slice(eq + 1);
    if (key === "t") {
      // Exactly one timestamp: a second `t` could otherwise be used to confuse the age check.
      if (timestamp !== null || !/^\d{1,12}$/.test(value)) fail("malformed_header");
      timestamp = Number(value);
    } else if (key === "v1") {
      // A malformed v1 can never match; ignore it rather than reject the whole header.
      if (/^[0-9a-fA-F]{64}$/.test(value) && v1.length < MAX_V1_ENTRIES)
        v1.push(Buffer.from(value, "hex"));
    }
  }
  if (timestamp === null) fail("no_timestamp");
  if (v1.length === 0) fail("no_signatures");
  return { timestamp, v1 };
}

export function computeSignature(
  timestamp: number,
  rawBody: string | Uint8Array,
  secret: string,
): Buffer {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${timestamp}.`, "utf8");
  hmac.update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody);
  return hmac.digest();
}

/**
 * Verifies the header against the raw body. `secrets` may list several secrets (for example old and new during a
 * roll); any match passes. Throws `BillingError('SIGNATURE_INVALID', …, { reason })`.
 */
export function verifySignature(
  rawBody: string | Uint8Array,
  header: string | undefined | null,
  secrets: string | readonly string[],
  toleranceSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { timestamp: number } {
  if (!(toleranceSeconds > 0)) {
    // A tolerance of 0 disables the recency check in Stripe's libraries; we never allow that.
    throw new RangeError("toleranceSeconds must be positive");
  }
  const keys = (typeof secrets === "string" ? [secrets] : [...secrets]).filter((s) => s.length > 0);
  if (keys.length === 0) fail("no_secret");
  const parsed = parseSignatureHeader(header);
  let matched = false;
  for (const key of keys) {
    const expected = computeSignature(parsed.timestamp, rawBody, key);
    for (const candidate of parsed.v1) {
      // Both are 32 bytes (checked by the hex pattern), so timingSafeEqual cannot throw on length.
      if (timingSafeEqual(expected, candidate)) matched = true;
    }
  }
  if (!matched) fail("signature_mismatch");
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds)
    fail("timestamp_outside_tolerance");
  return { timestamp: parsed.timestamp };
}

/** Builds a `Stripe-Signature` header value; used by the fake gateway and tests. */
export function signPayload(
  rawBody: string,
  secrets: string | readonly string[],
  timestamp: number,
): string {
  const keys = typeof secrets === "string" ? [secrets] : secrets;
  return [
    `t=${timestamp}`,
    ...keys.map((k) => `v1=${computeSignature(timestamp, rawBody, k).toString("hex")}`),
  ].join(",");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parses a verified body into the event view; throws `SIGNATURE_INVALID` (`malformed_event`) on a bad shape. */
export function parseEventBody(rawBody: string | Uint8Array): StripeEventView {
  let json: unknown;
  try {
    json = JSON.parse(
      typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8"),
    );
  } catch {
    fail("malformed_event");
  }
  return eventViewFromObject(json);
}

export function eventViewFromObject(json: unknown): StripeEventView {
  if (!isRecord(json)) fail("malformed_event");
  const { id, type, created, livemode, data } = json;
  if (typeof id !== "string" || !/^evt_[A-Za-z0-9_]{1,250}$/.test(id)) fail("malformed_event");
  if (typeof type !== "string" || !/^[a-z0-9_.]{1,100}$/.test(type)) fail("malformed_event");
  if (typeof created !== "number" || !Number.isInteger(created) || created < 0)
    fail("malformed_event");
  if (typeof livemode !== "boolean") fail("malformed_event");
  if (!isRecord(data) || !isRecord(data.object)) fail("malformed_event");
  const object = data.object;
  if (typeof object.id !== "string" || object.id.length === 0 || object.id.length > 255)
    fail("malformed_event");
  return { id, type, created, livemode, objectId: object.id, object };
}

/** Signature check plus parse: the shared implementation of `StripeGateway.constructEvent`. */
export function constructEvent(
  rawBody: string,
  signatureHeader: string,
  secret: string | readonly string[],
  toleranceSeconds: number,
  nowSeconds?: number,
): StripeEventView {
  verifySignature(rawBody, signatureHeader, secret, toleranceSeconds, nowSeconds);
  return parseEventBody(rawBody);
}
