/**
 * One country version of the home page. `/` is the United States entry; every other entry is served at
 * `/<slug>/` by src/pages/[country].astro, through the same template (components/landing/LandingPage.astro).
 * See "Country landing pages" in apps/site/README.md for how to add one.
 *
 * Figures rule: no tax rate, threshold, allowance or pension amount is typed into an entry. Read it from
 * @glideworth/core at build time (the tax tables cite their sources) or leave it out.
 */
import type { FeatureItem } from "../components/FeatureGrid.astro";
import type { ToolId } from "../tools/types";

/** How money is written on the page. */
export interface Money {
  /** ISO 4217 code of the example's currency ("GBP"). */
  currency: string;
  /** Symbol written before amounts ("£"). */
  symbol: string;
  /** Number formatting locale ("en-GB"). */
  locale: string;
}

/** One plan year's tax, as the product lays it out (components/visuals/TaxYear.astro). */
export interface TaxYearExample {
  /** "Tax in 2034". */
  title: string;
  /** "United States, married filing jointly in Colorado". */
  subtitle: string;
  /** Heading of the second column ("Level"). */
  levelHeading: string;
  lines: { label: string; level: string; amount: number }[];
  /** A few real entries from TAX_SIMPLIFICATIONS, in short. */
  leavesOut: string[];
  /** How many simplifications the tax models of this example list in all. */
  listed: number;
  /** The figure's caption. */
  caption: string;
}

export interface LandingLink {
  label: string;
  href: string;
  /** One line under the link. */
  note?: string;
}

export interface LandingEntry {
  /** ISO 3166-1 alpha-2 code ("GB"). */
  code: string;
  /** URL segment ("uk" -> /uk/). Empty for the root entry. Match the /planning/<slug>/ page. */
  slug: string;
  /** hreflang value ("en-GB"). */
  hreflang: string;
  /** "United Kingdom". */
  countryName: string;
  /** The short name used in the banner and the switcher ("UK" in "Looking for the UK version?"). */
  label: string;
  /** `<html lang>` of the page; the site default ("en") when left out. */
  lang?: string;
  /** Open Graph locale ("en_GB"). */
  ogLocale: string;

  seo: {
    /** Under 60 characters once " · Glideworth" is appended (unless fullTitle). */
    title: string;
    /** 120 to 160 characters, unique on the site. */
    description: string;
    fullTitle?: boolean;
    ogTitle: string;
    ogEyebrow: string;
    /** The target keyword from docs/seo-keyword-map.md (checked by landing.test.ts). */
    primaryKeyword: string;
  };

  money: Money;

  hero: {
    eyebrow: string;
    /** The H1 in three parts: the middle part is set in italics. */
    title: [before: string, emphasis: string, after: string];
    lede: string;
    /** Added after the price sentence under the buttons. */
    priceNote?: string;
    figureCaption: string;
  };

  /** The four figures under the hero. */
  proof: { value: string; label: string }[];

  /** "What it answers". */
  questions: FeatureItem[];

  /** "See where the money goes, every year." */
  working: {
    ticks: string[];
    /** Leave it out when no sample in @glideworth/core/samples can produce one: never type amounts. */
    taxYear?: TaxYearExample;
  };

  /** "Tax estimates for your country." */
  taxSection: {
    eyebrow: string;
    title: string;
    intro: string;
    /** Text before the link to how each country is modelled. */
    foot: string;
    footLink: LandingLink;
  };

  /** Optional country sections, shown between the tax section and "Your data". */
  local?: {
    /** Accounts by their own names, with what the planner does with each. */
    accounts: { eyebrow: string; title: string; intro: string; items: LandingLink[] };
    /** Calculators: country ones first, then country-neutral ones. */
    tools: { title: string; intro: string; ids: ToolId[] };
    /** What the product itself says about plans for this country, limits included. */
    notes: { title: string; intro: string; items: { title: string; body: string }[] };
    /** Further reading: the /planning/ page and articles. */
    reading: { title: string; links: LandingLink[] };
  };

  /** Added under the price comparison (currency of the prices, for example). */
  priceNote?: string;
}
