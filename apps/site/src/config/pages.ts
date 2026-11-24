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
    title: "Retirement and FIRE planner",
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
      "Free calculators for FIRE, withdrawals, Monte Carlo, guardrails, RMDs, Roth conversions, ACA credits and UK pension drawdown, in your browser with no sign-up.",
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
    title: "Retirement withdrawal calculator: SWR, 4% rule",
    description:
      "Free retirement withdrawal calculator: a safe withdrawal rate and the 4% rule, with Guyton-Klinger guardrails, a fixed percentage and VPW.",
    ogTitle: "Retirement withdrawal calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/monte-carlo-retirement-calculator/": {
    title: "Monte Carlo retirement calculator",
    description:
      "Free Monte Carlo retirement calculator: your chance that every year of spending is paid, from seeded simulations on US market history or random returns.",
    ogEyebrow: "Free calculator",
  },
  "/tools/rmd-calculator/": {
    title: "RMD calculator: required minimum distributions",
    description:
      "Free RMD calculator: your required minimum distribution for a year, the age RMDs start for your birth year and later RMDs, from the IRS Uniform Lifetime table.",
    ogTitle: "RMD calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/72t-calculator/": {
    title: "72(t) calculator for SEPP payments",
    description:
      "Free 72(t) calculator: the yearly SEPP payment under the fixed annuitisation method, from the IRS mortality rates, with the balance over the years you take it.",
    ogTitle: "72(t) calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/irmaa-calculator/": {
    title: "IRMAA calculator: Medicare IRMAA brackets",
    description:
      "Free IRMAA calculator: your Medicare IRMAA bracket and the Part B and Part D surcharges from your MAGI two years earlier, and how near the next tier is.",
    ogTitle: "IRMAA calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/uk-fire-calculator/": {
    title: "UK FIRE calculator: the ISA-to-pension bridge",
    description:
      "Free UK FIRE calculator: your early retirement age, whether your ISA can bridge the years to pension age, and the pots you need, with a UK income tax estimate.",
    ogTitle: "UK FIRE calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/uk-pension-age-calculator/": {
    title: "UK pension age calculator: when can I retire?",
    description:
      "Free UK pension age calculator: your State Pension age and the earliest age you can take a private or workplace pension, by month of birth, with the dates.",
    ogTitle: "UK pension age calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/uae-gratuity-calculator/": {
    title: "UAE gratuity calculator for end of service",
    description:
      "Free UAE gratuity calculator: your end-of-service gratuity from years of service and basic wage, tier by tier with the cap, compared with the savings scheme.",
    ogTitle: "UAE gratuity calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/retirement-tax-calculator/": {
    title: "Retirement tax calculator: US federal estimate",
    description:
      "Free retirement tax calculator: US federal income tax on Social Security, IRA and 401(k) withdrawals, pensions and dividends, with effective and marginal rate.",
    ogTitle: "Retirement tax calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/roth-conversion-calculator/": {
    title: "Roth conversion calculator: fill a tax bracket",
    description:
      "Free Roth conversion calculator: how much to convert to fill a federal bracket, the tax on it, and a multi-year conversion ladder against not converting.",
    ogTitle: "Roth conversion calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/aca-subsidy-calculator/": {
    title: "ACA subsidy calculator for early retirees",
    description:
      "Free ACA subsidy calculator: your premium tax credit from household income and benchmark silver premium, and how much more income you can have before it stops.",
    ogTitle: "ACA subsidy calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/guardrails-retirement-calculator/": {
    title: "Guyton-Klinger retirement guardrails calculator",
    description:
      "Free retirement guardrails calculator: Guyton-Klinger and risk-based guardrails in money, the portfolio values that trigger a cut or raise, tested on history.",
    ogTitle: "Guardrails retirement calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/retirement-spending-calculator/": {
    title: "Retirement spending and spend-down calculator",
    description:
      "Free retirement spending calculator: the most you can spend each year at the chance of success you choose, with a pension from any age and the spend-down path.",
    ogTitle: "Retirement spending calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/historical-retirement-calculator/": {
    title: "Historical retirement calculator since 1928",
    description:
      "Free historical retirement calculator: your withdrawal plan replayed through every start year of US market history since 1928, each path and the worst years.",
    ogTitle: "Historical retirement calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/uk-pension-drawdown-calculator/": {
    title: "Pension drawdown calculator UK: tax and income",
    description:
      "Free UK pension drawdown calculator: how long your pot lasts, the income tax on each withdrawal, tax-free cash and the State Pension, from the planning engine.",
    ogTitle: "UK pension drawdown calculator",
    ogEyebrow: "Free calculator",
  },
  "/tools/isa-vs-pension-calculator/": {
    title: "ISA vs pension calculator: which pays more?",
    description:
      "ISA or pension? Save the same take-home pay into each, with pension tax relief, and compare the income after tax each pays in retirement. Free UK calculator.",
    ogTitle: "ISA vs pension calculator",
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
