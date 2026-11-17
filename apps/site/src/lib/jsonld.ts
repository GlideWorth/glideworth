/**
 * Schema.org structured data. Each helper returns a plain object; <JsonLd data={…} /> serialises it.
 * Keep every value true: no ratings, reviews, user counts or awards.
 */
import { pricing } from "../config/pricing";
import { absoluteUrl, site } from "../config/site";

export type JsonLdObject = Record<string, unknown>;

const ORG_ID = `${site.url}/#organization`;
const WEBSITE_ID = `${site.url}/#website`;

export function organization(): JsonLdObject {
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: site.name,
    url: `${site.url}/`,
    logo: absoluteUrl("/icon-512.png"),
    email: site.contact.hello,
    sameAs: [site.repoUrl],
  };
}

export function website(): JsonLdObject {
  return {
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    url: `${site.url}/`,
    name: site.name,
    description: site.tagline,
    inLanguage: site.locale,
    publisher: { "@id": ORG_ID },
  };
}

/** The product, with the hosted plan's prices as offers (from src/config/pricing.ts). */
export function softwareApplication(): JsonLdObject {
  // The hosted plan's offers follow site.cloudLaunched (PreSale until it opens); the self-hosted build is always available.
  const hostedAvailability = site.cloudLaunched
    ? "https://schema.org/InStock"
    : "https://schema.org/PreSale";
  return {
    "@type": "SoftwareApplication",
    "@id": `${site.url}/#software`,
    name: site.name,
    url: `${site.url}/`,
    description: site.description,
    applicationCategory: "FinanceApplication",
    operatingSystem: "Web browser; self-hosted on any system that runs Docker or Node.js 24",
    license: `https://spdx.org/licenses/${site.license}.html`,
    isAccessibleForFree: true,
    codeRepository: site.repoUrl,
    publisher: { "@id": ORG_ID },
    offers: [
      {
        "@type": "Offer",
        name: `${pricing.planName}, monthly`,
        price: pricing.monthly.toFixed(2),
        priceCurrency: pricing.currency,
        url: absoluteUrl("/pricing/"),
        category: "subscription",
        availability: hostedAvailability,
      },
      {
        "@type": "Offer",
        name: `${pricing.planName}, yearly`,
        price: pricing.yearly.toFixed(2),
        priceCurrency: pricing.currency,
        url: absoluteUrl("/pricing/"),
        category: "subscription",
        availability: hostedAvailability,
      },
      {
        "@type": "Offer",
        name: pricing.selfHostName,
        price: "0",
        priceCurrency: pricing.currency,
        url: absoluteUrl("/self-hosting/"),
        availability: "https://schema.org/InStock",
      },
    ],
  };
}

export interface Crumb {
  label: string;
  href: string;
}

export function breadcrumbList(crumbs: Crumb[]): JsonLdObject {
  return {
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.label,
      item: absoluteUrl(c.href),
    })),
  };
}

export interface FaqItem {
  q: string;
  /** Answer as simple HTML (p, a, strong, em, ul, li). */
  a: string;
}

export function faqPage(items: FaqItem[]): JsonLdObject {
  return {
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

export interface ArticleInput {
  title: string;
  description: string;
  path: string;
  published: Date;
  modified?: Date | undefined;
  authors: { name: string; url?: string; kind?: "person" | "organization" }[];
  image: string;
  tags?: string[];
}

export function article(a: ArticleInput): JsonLdObject {
  return {
    "@type": "Article",
    headline: a.title,
    description: a.description,
    mainEntityOfPage: absoluteUrl(a.path),
    datePublished: a.published.toISOString(),
    dateModified: (a.modified ?? a.published).toISOString(),
    author: a.authors.map((p) => ({
      "@type": p.kind === "organization" ? "Organization" : "Person",
      name: p.name,
      ...(p.url ? { url: p.url } : {}),
    })),
    publisher: { "@id": ORG_ID },
    image: a.image,
    ...(a.tags?.length ? { keywords: a.tags.join(", ") } : {}),
  };
}

/** Wraps one or more nodes in a @graph with the shared context. */
export function graph(nodes: JsonLdObject[]): JsonLdObject {
  return { "@context": "https://schema.org", "@graph": nodes };
}

/** JSON for a <script type="application/ld+json">, safe against `</script>` in values. */
export function serialize(data: JsonLdObject): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
