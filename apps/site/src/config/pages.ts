/**
 * Titles and descriptions of the hand-written pages in src/pages (collection entries carry theirs in
 * frontmatter). The page reads its entry with `page('/pricing/')`, and the social-image endpoint
 * (src/pages/og/[...slug].png.ts) draws one image per entry, so both always agree.
 *
 * Rules: every title is unique and under about 60 characters (the layout appends " · Glideworth"
 * unless `fullTitle` is set); every description is unique, 120 to 160 characters, and true of the code.
 */
import { facts } from "../lib/facts";
import { formatPrice, pricing } from "./pricing";
import { site } from "./site";

const n = facts.taxCountryCount;

export interface PageMeta {
  title: string;
  description: string;
  /** Use the title as the whole <title>, without the site name appended. */
  fullTitle?: boolean;
  /** Shorter heading for the social image, if the title is long. */
  ogTitle?: string;
  /** Kicker above the title on the social image. */
  ogEyebrow?: string;
  /** Placeholder awaiting the content wave: shown with a notice and kept out of search (noindex). */
  placeholder?: boolean;
  /** Keep out of search engines and the sitemap. */
  noindex?: boolean;
}

export const pages = {
  "/": {
    title: "Glideworth: retirement and FIRE planner",
    fullTitle: true,
    description:
      "Find out how much you can spend and when you can retire, see why a plan falls short year by year, and compare scenarios. No bank login needed.",
    ogTitle: "Know when you can retire, and how much you can spend",
    ogEyebrow: "Retirement and FIRE planner",
  },
  "/pricing/": {
    title: "Pricing",
    // Follows site.cloudLaunched, like the pricing page body, so the snippet never contradicts the page.
    description: site.cloudLaunched
      ? `${pricing.planName} is ${formatPrice(pricing.monthly)} a month or ${formatPrice(pricing.yearly)} a year after a ${pricing.trialDays}-day free trial${pricing.trialNeedsCard ? " with a card" : " with no card"}. One plan with every feature; self-hosting is free.`
      : `Self-hosting is free with every feature. The hosted plan, ${pricing.planName}, opens later at ${formatPrice(pricing.monthly)} a month or ${formatPrice(pricing.yearly)} a year after a ${pricing.trialDays}-day free trial${pricing.trialNeedsCard ? " with a card" : " with no card"}.`,
    ogTitle: "One plan, every feature",
    ogEyebrow: "Pricing",
  },
  "/features/": {
    title: "Features",
    description:
      "What Glideworth does: finds what you can spend and when you can retire, explains each year, compares scenarios, estimates tax and works with ChatGPT or Claude.",
    ogEyebrow: "Features",
  },
  "/api/": {
    title: "API and MCP for AI agents",
    description: `A REST API with ${facts.apiOperations} operations (OpenAPI 3.1) and an MCP server with ${facts.mcpTools} tools. AI assistants read plans, run simulations and propose edits you approve.`,
    ogTitle: "Your plan, open to your AI assistant",
    ogEyebrow: "API and MCP",
  },
  "/open-source/": {
    title: "Open source",
    description:
      "Glideworth is AGPL-3.0 open source. The self-hosted build is the whole product: no licence key, no feature switched off, no telemetry. Read how the project works.",
    ogEyebrow: "Open source",
  },
  "/self-hosting/": {
    title: "Self-hosting",
    description:
      "Run Glideworth on your own machine or server: one Docker container or one Node process, data in one SQLite file, backups with one command. Free, with every feature.",
    ogEyebrow: "Self-hosting",
  },
  "/security/": {
    title: "Security and privacy",
    description:
      "How Glideworth handles your financial data: no bank connections, hashed passphrases and API keys, scoped keys for AI assistants, and self-hosting.",
    ogEyebrow: "Security and privacy",
  },
  "/about/": {
    title: "About",
    description:
      "Why Glideworth exists: a retirement planner for people working towards financial independence who want to see how their plan works and keep their own data.",
    ogEyebrow: "About",
  },
  "/contact/": {
    title: "Contact",
    description:
      "How to reach the Glideworth team: general questions, support for the hosted service, security reports and privacy requests, each with its own address.",
    ogEyebrow: "Contact",
  },
  "/roadmap/": {
    title: "Roadmap",
    description:
      "What Glideworth is building next: fixes to the hosted service, deeper tax rules, more market history, balance sync and randomised lifespan in Monte Carlo.",
    ogEyebrow: "Roadmap",
  },
  "/tools/": {
    title: "Free retirement and FIRE calculators",
    description:
      "Free FIRE, fat FIRE, Coast FIRE, Barista FIRE, withdrawal, longevity and Monte Carlo calculators that run the planning engine in your browser, with no sign-up.",
    ogEyebrow: "Free tools",
  },
  // Calculators (src/pages/tools/, src/tools/README.md).
  "/tools/coast-fire-calculator/": {
    title: "Coast FIRE calculator: find your coast number",
    description:
      "Free Coast FIRE calculator: how much you need invested today for growth alone to reach your FIRE number, and the age you get there. Runs in your browser.",
    ogTitle: "Coast FIRE calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/fire-calculator/": {
    title: "FIRE calculator: your FIRE number and date",
    description:
      "Free FIRE calculator: your FIRE number from spending and a withdrawal rate, the years of saving it takes, and how that number fared in US market history.",
    ogTitle: "FIRE calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/fat-fire-calculator/": {
    title: "Fat FIRE calculator: number, years, gap",
    description:
      "Free fat FIRE calculator: your number from high yearly spending and a rate below 4%, the years to reach it, and the gap versus lean and regular targets.",
    ogTitle: "Fat FIRE calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/barista-fire-calculator/": {
    title: "Barista FIRE calculator with part-time income",
    description:
      "Free Barista FIRE calculator: the portfolio you need when part-time pay covers some spending for a set number of years, against full retirement.",
    ogTitle: "Barista FIRE calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/how-long-will-my-money-last/": {
    title: "How long will my money last? Calculator",
    description:
      "Free calculator: how many years your savings pay a yearly withdrawal at a steady return, then the same plan replayed through US market history since 1928.",
    ogTitle: "How long will my money last?",
    ogEyebrow: "Free calculator",
  },
  "/tools/retirement-withdrawal-calculator/": {
    title: "Retirement withdrawal calculator: compare rules",
    description:
      "Free retirement withdrawal calculator: constant real, fixed percentage, Guyton-Klinger guardrails and VPW on the same simulated markets, side by side.",
    ogTitle: "Retirement withdrawal calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/monte-carlo-retirement-calculator/": {
    title: "Monte Carlo retirement calculator",
    description:
      "Free Monte Carlo retirement calculator: your chance that every year of spending is paid, from seeded simulations on US market history or random returns.",
    ogEyebrow: "Free calculator",
  },
  "/tools/engine-check/": {
    title: "Engine check",
    description: "Internal test page: proves the Glideworth engine runs in the browser bundle.",
    noindex: true,
  },
  "/blog/": {
    title: "Blog",
    description:
      "Articles from the Glideworth team on retirement and FIRE planning, withdrawal rates, tax estimates, Monte Carlo methods, and building an open-source planner.",
    ogEyebrow: "Blog",
  },
  "/docs/": {
    title: "Documentation",
    description:
      "Guides for Glideworth: self-hosting, connecting an AI assistant over MCP, the REST API, importing from ProjectionLab, and how the results are calculated.",
    ogEyebrow: "Docs",
  },
  "/changelog/": {
    title: "Changelog",
    description:
      "Every notable change to Glideworth: new tax jurisdictions, engine changes, API and MCP additions, fixes and table updates, newest first.",
    ogEyebrow: "Changelog",
  },
  "/planning/": {
    title: "Planning by country",
    description: `Tax estimates for your country: how Glideworth estimates tax in each of the ${n} countries it supports, which tax years each model covers, and what it leaves out.`,
    ogEyebrow: "Planning by country",
  },
  "/compare/": {
    title: "Comparisons",
    description:
      "Factual, dated comparisons between Glideworth and other ways to plan for retirement, with sources for every claim about another product.",
    ogEyebrow: "Comparisons",
  },
  "/legal/": {
    title: "Legal",
    description:
      "Glideworth legal documents: privacy, terms of service, cookies, acceptable use, data processing and sub-processors.",
    ogEyebrow: "Legal",
  },
  "/404/": {
    title: "Page not found",
    description:
      "The page you asked for does not exist. Try the home page, the docs or the site map below.",
    noindex: true,
  },
} as const satisfies Record<string, PageMeta>;

export type PagePath = keyof typeof pages;

export function page(path: PagePath): PageMeta & { path: PagePath } {
  return { ...(pages[path] as PageMeta), path };
}
