/**
 * Site-wide settings. Every absolute URL on the site is built from these values, so changing a domain
 * or address here changes it everywhere (canonical URLs, sitemap, RSS, structured data, social images).
 */
export const site = {
  name: "Glideworth",
  /** The marketing site. No trailing slash. */
  url: "https://glideworth.com",
  /** The hosted app. */
  appUrl: "https://app.glideworth.com",
  /** Where the "start trial" calls to action go. */
  signupUrl: "https://app.glideworth.com/signup",
  /** The public source repository. */
  repoUrl: "https://github.com/GlideWorth/glideworth",
  /** Short line used as the default description and in the footer. */
  tagline: "An open-source financial and retirement planner with an API and MCP server.",
  description:
    "Glideworth projects your household finances decades ahead, with tax estimates for each country it supports, Monte Carlo on historical returns, solvers and explanations, and an API and MCP server for AI assistants. Open source: use the hosted service or run it yourself.",
  locale: "en",
  /**
   * The legal entity behind Glideworth, used in the legal pages. No registration, VAT or data protection
   * numbers are held or shown; do not add any that are not real.
   */
  entity: {
    name: "Web Ninja FZCO",
    description: "a free zone company in Dubai, United Arab Emirates",
    address:
      "Unit 001-46348, Building A1, Dubai Digital Park, Dubai Silicon Oasis, Dubai, United Arab Emirates",
  },
  /** Addresses on the domain. The mailboxes are set up at MXroute (inboxes, with forwarders for the other addresses). */
  contact: {
    hello: "hello@glideworth.com",
    support: "support@glideworth.com",
    security: "security@glideworth.com",
    privacy: "privacy@glideworth.com",
  },
  /** Licence of the application code (see LICENSING.md in the repository). */
  license: "AGPL-3.0-only",
  /**
   * True since 2026-11-16: the hosted service is open for sign-ups. While false, the pricing page and the trial
   * calls to action say that the hosted service is about to open.
   */
  cloudLaunched: true,
} as const;

/**
 * The primary "try it" call to action. Until the hosted service is open there is no sign-up to send people
 * to, so it points at self-hosting, which works today.
 */
export const trialCta = site.cloudLaunched
  ? { label: "Start your free trial", href: site.signupUrl }
  : { label: "Self-host it free", href: "/self-hosting/" };

/** Absolute URL for a site path. Paths get a trailing slash unless they name a file. */
export function absoluteUrl(path: string): string {
  return new URL(withSlash(path), site.url).toString();
}

/** Adds the trailing slash the site uses for pages (`/pricing` -> `/pricing/`), leaving files alone. */
export function withSlash(path: string): string {
  const [pathname = "/", hash = ""] = path.split("#");
  if (pathname.endsWith("/") || /\.[a-z0-9]+$/i.test(pathname)) return path;
  return `${pathname}/${hash ? `#${hash}` : ""}`;
}
