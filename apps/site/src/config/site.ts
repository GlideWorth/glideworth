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
  tagline: "A retirement planner that shows when you can retire, how much you can spend, and why.",
  description:
    "Glideworth is a retirement and FIRE planner. It finds how much you can spend and when you can retire, shows year by year why a plan falls short, compares scenarios side by side and plans for couples, with tax estimates for your country. No bank login needed, and you can talk to ChatGPT or Claude about your plan.",
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
  /**
   * The public demo (a sample household, no sign-up) at `demoUrl`. True since 2026-11-19, when #75 put it live;
   * while false, the "Try the demo" calls to action are hidden. Flip it once app.glideworth.com/demo works.
   */
  demoLive: true,
  demoUrl: "https://app.glideworth.com/demo",
} as const;

/** The "try the demo" call to action, or undefined while the demo is not live. */
export const demoCta = site.demoLive
  ? { label: "Try the demo, no sign-up", href: site.demoUrl }
  : undefined;

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
