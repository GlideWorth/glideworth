/**
 * PostHog on the marketing site, official hosted build only.
 *
 * The project token and ingestion host are the build-time variables `PUBLIC_POSTHOG_PROJECT_TOKEN` and
 * `PUBLIC_POSTHOG_HOST` (the same project as the app). Both are unset in this repository and in every
 * self-hosted build, so those copies never contact PostHog. Anything other than a project token and a PostHog
 * cloud ingestion host is ignored, so a bad value cannot reach the page.
 *
 * The site runs PostHog in cookieless mode (`posthog-client.ts`): nothing is stored in the browser, so it
 * needs no consent banner. Events go to `/relay` on this origin, which Caddy forwards to PostHog
 * (infra/compose/Caddyfile), so the page loads nothing from another origin.
 *
 * It runs on every page, the calculators under `/tools/` included. What a visitor types into a calculator, and the
 * results it shows, never go with an event: `posthog-scrub.ts` removes query strings (where the calculators keep
 * their inputs) and, on calculator pages, element text before anything is sent.
 */
const TOKEN = /^phc_[A-Za-z0-9]{20,64}$/;
const HOST = /^https:\/\/(us|eu)\.i\.posthog\.com$/;

export interface SitePostHog {
  token: string;
  /** The PostHog app, for links from the toolbar: `https://us.posthog.com`. */
  uiHost: string;
}

export function sitePostHog(
  rawToken: string | undefined,
  rawHost: string | undefined,
): SitePostHog | undefined {
  const token = (rawToken ?? "").trim();
  const host = (rawHost ?? "").trim().replace(/\/+$/, "");
  const m = HOST.exec(host);
  if (!TOKEN.test(token) || !m) return undefined;
  return { token, uiHost: `https://${m[1]}.posthog.com` };
}
