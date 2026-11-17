/**
 * Where a re-authentication detour ends (the emailed link that sets a first password): back on the settings
 * section the person started from. Allow-listed, not just same-origin: only `/settings/<section>` (a short
 * lowercase slug, no query, no fragment) is kept; anything else, including every absolute, scheme-relative
 * or encoded URL, becomes Security settings. So the value can never point off-site or at another page.
 */
const SETTINGS_SECTION = /^\/settings\/[a-z][a-z0-9-]{0,39}$/;
export const DEFAULT_REAUTH_RETURN = "/settings/security";

export function reauthReturnPath(value: unknown): string {
  return typeof value === "string" && SETTINGS_SECTION.test(value) ? value : DEFAULT_REAUTH_RETURN;
}
