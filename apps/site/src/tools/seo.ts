/** Structured data for the calculator pages (WebApplication), next to the site's own helpers in lib/jsonld. */
import { absoluteUrl, site } from "../config/site";
import type { JsonLdObject } from "../lib/jsonld";

export function webApplication(t: {
  name: string;
  path: string;
  description: string;
}): JsonLdObject {
  return {
    "@type": "WebApplication",
    "@id": `${absoluteUrl(t.path)}#calculator`,
    name: t.name,
    url: absoluteUrl(t.path),
    description: t.description,
    applicationCategory: "FinanceApplication",
    operatingSystem: "Any; runs in a web browser",
    browserRequirements: site.calculatorEmail
      ? "Requires JavaScript. Calculations run in your browser; nothing you enter is sent anywhere unless you ask for the result by email."
      : "Requires JavaScript. Calculations run in your browser; nothing you enter is sent anywhere.",
    isAccessibleForFree: true,
    inLanguage: site.locale,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@type": "Organization", name: site.name, url: `${site.url}/` },
  };
}
