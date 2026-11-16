/** Where the hosted service's legal pages and support live (apps/site: /legal/<slug>, config support). */
export const LEGAL_URL = {
  terms: "https://glideworth.com/legal/terms",
  privacy: "https://glideworth.com/legal/privacy",
  refunds: "https://glideworth.com/legal/terms",
} as const;

export const SUPPORT_EMAIL = "support@glideworth.com";

/**
 * Used when the status answer carries no `terms.version` (see the report). The sign-up request needs a
 * version string (1-32 characters of [A-Za-z0-9._-]) that the server records with the acceptance.
 */
export const FALLBACK_TERMS_VERSION = "2026-11-16";
