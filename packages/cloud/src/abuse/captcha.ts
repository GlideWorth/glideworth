/**
 * CAPTCHA verification (spec 3.7). Production: Cloudflare Turnstile siteverify. Tests and development: a
 * static verifier that accepts one fixed token. Every failure, including network errors and timeouts, is a
 * refusal (fail closed).
 */
import { safeEqual } from "../crypto/random.js";

export interface CaptchaVerifier {
  verify(token: string | undefined, ip: string): Promise<boolean>;
}

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN = 2048;

export function turnstileVerifier(o: {
  secret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): CaptchaVerifier {
  if (!o.secret) throw new Error("turnstile secret required");
  const doFetch = o.fetch ?? globalThis.fetch;
  return {
    async verify(token, ip) {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN) return false;
      const body = new URLSearchParams({ secret: o.secret, response: token });
      if (ip) body.set("remoteip", ip);
      try {
        const res = await doFetch(TURNSTILE_VERIFY_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
        });
        if (!res.ok) return false;
        const json = (await res.json()) as { success?: unknown };
        return json?.success === true;
      } catch {
        return false;
      }
    },
  };
}

export function staticCaptcha(acceptToken: string): CaptchaVerifier {
  if (!acceptToken) throw new Error("static captcha token required");
  return {
    async verify(token) {
      return typeof token === "string" && safeEqual(token, acceptToken);
    },
  };
}
