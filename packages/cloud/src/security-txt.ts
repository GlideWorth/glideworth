/**
 * RFC 9116 security.txt for the hosted service, served at /.well-known/security.txt by both the marketing
 * site (apps/site) and the app host in cloud mode (apps/api). One source, so the two never disagree; only
 * Canonical differs, because it must be the URL the file was fetched from.
 *
 * Not served by a self-hosted instance: the contact below is the Glideworth team, not that instance's
 * operator, and reports about someone else's server should not come to us.
 *
 * RENEW BEFORE `expires`: a security.txt past its Expires date must be treated as stale (RFC 9116 2.5.5).
 * packages/cloud/test/security-txt.test.ts fails once fewer than 30 days remain, and the site's check:dist
 * does the same, so the date cannot lapse silently. Move it on by about a year (RFC 9116 recommends less
 * than a year ahead).
 */
export const SECURITY_TXT = {
  /** In order of preference for RFC 9116 readers: email first, then GitHub private vulnerability reporting. */
  contacts: [
    "mailto:security@glideworth.com",
    "https://github.com/GlideWorth/glideworth/security/advisories/new",
  ],
  /** RFC 3339, UTC. */
  expires: "2027-11-01T00:00:00.000Z",
  preferredLanguages: "en",
  /** The disclosure policy (scope, safe harbour, response targets); SECURITY.md says the same. */
  policy: "https://glideworth.com/security/",
} as const;

/** The file body for a host. `canonical` is the full URL it is served at on that host. */
export function securityTxt(canonical: string): string {
  return [
    "# Glideworth: how to report a security vulnerability. Read the Policy before testing.",
    ...SECURITY_TXT.contacts.map((contact) => `Contact: ${contact}`),
    `Expires: ${SECURITY_TXT.expires}`,
    `Preferred-Languages: ${SECURITY_TXT.preferredLanguages}`,
    `Canonical: ${canonical}`,
    `Policy: ${SECURITY_TXT.policy}`,
    "",
  ].join("\n");
}
