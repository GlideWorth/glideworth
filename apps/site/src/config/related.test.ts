import { describe, expect, it } from "vitest";
import { footerNav } from "./nav";
import { clusters, selectRelatedPaths } from "./related";

const COUNTRIES = ["uk", "ie", "us", "ca", "au", "nz", "de", "nl", "fr", "es", "il", "ae"].map(
  (code) => `/planning/${code}/`,
);

const CALCULATOR_ARTICLES: [string, string][] = [
  ["/blog/coast-fire-explained/", "/tools/coast-fire-calculator/"],
  ["/blog/what-is-your-fire-number/", "/tools/fire-calculator/"],
  ["/blog/barista-fire-part-time-income/", "/tools/barista-fire-calculator/"],
  ["/blog/withdrawal-strategies-compared/", "/tools/retirement-withdrawal-calculator/"],
  ["/blog/how-long-will-my-money-last/", "/tools/how-long-will-my-money-last/"],
  ["/blog/monte-carlo-retirement-simulations/", "/tools/monte-carlo-retirement-calculator/"],
];

const TOOLS = [
  "/tools/",
  "/tools/fire-calculator/",
  "/tools/fat-fire-calculator/",
  "/tools/coast-fire-calculator/",
  "/tools/barista-fire-calculator/",
  "/tools/retirement-withdrawal-calculator/",
  "/tools/how-long-will-my-money-last/",
  "/tools/monte-carlo-retirement-calculator/",
];

/** Pages whose HTML includes the cluster "Related" list. Tool pages link from their own markup. */
function rendersRelated(path: string): boolean {
  return (
    path.startsWith("/blog/") ||
    path.startsWith("/features/") ||
    path.startsWith("/docs/") ||
    path.startsWith("/compare/") ||
    (path.startsWith("/planning/") && path !== "/planning/")
  );
}

const footerHrefs = new Set(footerNav.flatMap((group) => group.links.map((link) => link.href)));

function inbound(path: string, pages: string[]): string[] {
  return pages.filter(
    (other) => other !== path && rendersRelated(other) && selectRelatedPaths(other).includes(path),
  );
}

describe("related clusters", () => {
  const pages = [...new Set(clusters.flatMap((cluster) => cluster.paths))];

  it("links each FIRE, withdrawal and Monte Carlo article to its calculator", () => {
    for (const [article, calculator] of CALCULATOR_ARTICLES) {
      expect(selectRelatedPaths(article), article).toContain(calculator);
    }
  });

  it("links every country guide to the hub and two neighbours", () => {
    for (const country of COUNTRIES) {
      const related = selectRelatedPaths(country);
      expect(related, country).toContain("/planning/");
      const neighbours = related.filter((path) => /^\/planning\/[a-z]{2}\/$/.test(path));
      expect(neighbours.length, country).toBeGreaterThanOrEqual(2);
    }
  });

  it("gives every country guide at least three inbound related links", () => {
    for (const country of COUNTRIES) {
      expect(inbound(country, pages).length, country).toBeGreaterThanOrEqual(3);
    }
  });

  it("links the tax article to country guides", () => {
    const tax = selectRelatedPaths("/blog/what-a-tax-estimate-leaves-out/").filter((path) =>
      COUNTRIES.includes(path),
    );
    expect(tax.length).toBeGreaterThanOrEqual(2);
  });

  it("gives Boldin and spreadsheets at least three inbound related links", () => {
    for (const path of ["/compare/boldin/", "/compare/spreadsheets/"]) {
      expect(inbound(path, pages).length, path).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("footer site map", () => {
  it("links every calculator and every country page", () => {
    for (const path of [...TOOLS, ...COUNTRIES, "/compare/boldin/", "/compare/spreadsheets/"]) {
      expect(footerHrefs.has(path), path).toBe(true);
    }
  });

  it("uses distinct hrefs", () => {
    const hrefs = footerNav.flatMap((group) => group.links.map((link) => link.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
