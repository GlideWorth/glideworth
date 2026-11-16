import { createHmac, timingSafeEqual } from "node:crypto";
import type { EmailCategory, UnsubscribeSigner } from "./types.js";

const DOMAIN = "glideworth-unsubscribe-v1";
const TOKEN_RE = /^[A-Za-z0-9_-]{1,1024}\.[A-Za-z0-9_-]{43}$/;

export interface HmacUnsubscribeSignerOptions {
  key: Uint8Array;
  baseUrl: string;
  /** Optional token lifetime. Default: tokens never expire (old mail must keep working). */
  ttlMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/**
 * Stateless signed one-click unsubscribe tokens: `<base64url(json)>.<base64url(hmac-sha256)>`.
 * The payload carries the (normalised) address and category and the issue time; the MAC covers a fixed
 * domain-separation prefix plus the payload. Only non-essential categories can be signed.
 */
export function hmacUnsubscribeSigner(o: HmacUnsubscribeSignerOptions): UnsubscribeSigner {
  if (!(o.key instanceof Uint8Array) || o.key.length < 16) {
    throw new Error("unsubscribe key must be at least 16 bytes");
  }
  const base = o.baseUrl.replace(/\/+$/, "");
  const now = o.now ?? Date.now;
  const mac = (payload: string) =>
    createHmac("sha256", o.key).update(`${DOMAIN}\n${payload}`).digest();

  return {
    url(emailNormalized, category) {
      if (category === "essential") throw new Error("essential mail cannot be unsubscribed from");
      const payload = Buffer.from(
        JSON.stringify({ e: emailNormalized, c: category, t: Math.floor(now() / 1000) }),
        "utf8",
      ).toString("base64url");
      const token = `${payload}.${mac(payload).toString("base64url")}`;
      return `${base}/email/unsubscribe?t=${token}`;
    },
    verify(token) {
      if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
      const [payload = "", sig = ""] = token.split(".");
      const given = Buffer.from(sig, "base64url");
      const expected = mac(payload);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      // 32 bytes encode to 43 characters with two unused trailing bits, so up to four different
      // strings decode to the same MAC. Accept only the canonical spelling: one token, one string.
      if (given.toString("base64url") !== sig) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      if (typeof parsed !== "object" || parsed === null) return null;
      const { e, c, t } = parsed as { e?: unknown; c?: unknown; t?: unknown };
      if (typeof e !== "string" || typeof t !== "number") return null;
      if (c !== "checkin") return null;
      if (o.ttlMs !== undefined && now() - t * 1000 > o.ttlMs) return null;
      return { email: e, category: c as EmailCategory };
    },
  };
}
