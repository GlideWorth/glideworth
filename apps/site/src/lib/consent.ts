/**
 * The visitor's analytics choice on the marketing site (only builds with PUBLIC_GTM_ID ask for one).
 *
 * Stored in local storage, not a cookie, under CONSENT_KEY. A choice older than CONSENT_MAX_AGE_DAYS is
 * treated as no choice, so the banner asks again. Advertising storage is never offered: it stays denied.
 *
 * The inline loader in GoogleTagManager.astro reads the same key before gtm.js loads (it cannot import
 * this module); a test keeps the key, the version and the maximum age in step.
 */
export const CONSENT_KEY = "glideworth-consent";
export const CONSENT_VERSION = 1;
export const CONSENT_MAX_AGE_DAYS = 365;

export type AnalyticsChoice = "granted" | "denied";

export interface StoredConsent {
  v: number;
  analytics: AnalyticsChoice;
  /** When the visitor chose, as milliseconds since the epoch. */
  at: number;
}

/** The stored choice if it is well formed, of this version and not expired; otherwise undefined. */
export function readConsent(
  raw: string | null | undefined,
  now: number,
): StoredConsent | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { v, analytics, at } = value as Record<string, unknown>;
  if (v !== CONSENT_VERSION) return undefined;
  if (analytics !== "granted" && analytics !== "denied") return undefined;
  if (typeof at !== "number" || !Number.isFinite(at) || at > now) return undefined;
  if (now - at > CONSENT_MAX_AGE_DAYS * 86_400_000) return undefined;
  return { v, analytics, at };
}

export function writeConsent(analytics: AnalyticsChoice, now: number): string {
  const stored: StoredConsent = { v: CONSENT_VERSION, analytics, at: now };
  return JSON.stringify(stored);
}
