/**
 * Clusters of pages about the same subject. Every page in a cluster shows the others under "Related",
 * in the order listed here (see src/components/RelatedLinks.astro). A page in several clusters gets the
 * union, capped at six. Paths must be real: the build fails on one that does not resolve to a page.
 * Add a page to a cluster instead of writing links into the pages themselves.
 *
 * Order is part of the contract. The cap keeps the first six, so a page's earliest cluster decides
 * which links survive: country guides come before wider topics, and each calculator sits in a small
 * cluster with its article before any larger FIRE or Monte Carlo cluster.
 */
export const RELATED_LIMIT = 6;

export const clusters: { subject: string; paths: string[] }[] = [
  {
    subject: "Planning in the British Isles",
    paths: ["/planning/", "/planning/uk/", "/planning/ie/", "/planning/fr/", "/planning/nl/"],
  },
  {
    subject: "Planning in North America",
    paths: ["/planning/", "/planning/us/", "/planning/ca/", "/planning/uk/", "/planning/ie/"],
  },
  {
    subject: "Planning in continental Europe",
    paths: ["/planning/", "/planning/de/", "/planning/nl/", "/planning/fr/", "/planning/es/"],
  },
  {
    subject: "Planning in Oceania",
    paths: ["/planning/", "/planning/au/", "/planning/nz/", "/planning/uk/", "/planning/ie/"],
  },
  {
    subject: "Planning in the Middle East",
    paths: ["/planning/", "/planning/il/", "/planning/ae/", "/planning/es/", "/planning/fr/"],
  },
  // These pages still have free related slots after their own clusters. Listing the country
  // first makes the slot point at a guide that would otherwise have few inbound links.
  {
    subject: "Tax documentation and further countries",
    paths: ["/planning/nz/", "/planning/ca/", "/docs/planning/tax-and-currency/"],
  },
  {
    subject: "Tax estimates and further countries",
    paths: ["/planning/ca/", "/planning/au/", "/features/tax-estimates/"],
  },
  {
    subject: "What tax estimates leave out, further countries",
    paths: [
      "/planning/il/",
      "/planning/ae/",
      "/planning/au/",
      "/blog/what-a-tax-estimate-leaves-out/",
    ],
  },
  {
    subject: "Several currencies and further countries",
    paths: ["/planning/nz/", "/planning/de/", "/features/multi-currency/"],
  },
  {
    subject: "Tax estimates",
    paths: [
      "/features/tax-estimates/",
      "/planning/",
      "/blog/what-a-tax-estimate-leaves-out/",
      "/docs/planning/tax-and-currency/",
      "/docs/methodology/known-limitations/",
    ],
  },
  {
    subject: "What a tax estimate leaves out",
    paths: ["/planning/au/", "/planning/es/", "/blog/what-a-tax-estimate-leaves-out/"],
  },
  {
    subject: "Coast FIRE",
    paths: [
      "/blog/coast-fire-explained/",
      "/tools/coast-fire-calculator/",
      "/blog/what-is-your-fire-number/",
      "/tools/fire-calculator/",
      "/features/solvers/",
    ],
  },
  {
    subject: "Barista FIRE",
    paths: [
      "/blog/barista-fire-part-time-income/",
      "/tools/barista-fire-calculator/",
      "/blog/what-is-your-fire-number/",
      "/tools/fire-calculator/",
      "/features/withdrawal-strategies/",
    ],
  },
  {
    subject: "Fat FIRE",
    paths: [
      "/blog/what-is-your-fire-number/",
      "/tools/fat-fire-calculator/",
      "/tools/fire-calculator/",
    ],
  },
  {
    subject: "FIRE number",
    paths: [
      "/blog/what-is-your-fire-number/",
      "/tools/fire-calculator/",
      "/blog/coast-fire-explained/",
      "/tools/coast-fire-calculator/",
      "/blog/barista-fire-part-time-income/",
      "/tools/barista-fire-calculator/",
    ],
  },
  {
    subject: "Guardrails",
    paths: [
      "/tools/guardrails-retirement-calculator/",
      "/blog/withdrawal-strategies-compared/",
      "/tools/retirement-withdrawal-calculator/",
      "/features/withdrawal-strategies/",
      "/docs/planning/solvers-and-guardrails/",
    ],
  },
  {
    subject: "How much you can spend",
    paths: [
      "/tools/retirement-spending-calculator/",
      "/features/solvers/",
      "/tools/monte-carlo-retirement-calculator/",
      "/blog/monte-carlo-retirement-simulations/",
      "/tools/guardrails-retirement-calculator/",
    ],
  },
  {
    subject: "Historical backtests",
    paths: [
      "/tools/historical-retirement-calculator/",
      "/blog/how-long-will-my-money-last/",
      "/docs/methodology/historical-data/",
      "/tools/how-long-will-my-money-last/",
      "/features/monte-carlo/",
    ],
  },
  {
    subject: "Withdrawals",
    paths: [
      "/blog/withdrawal-strategies-compared/",
      "/tools/retirement-withdrawal-calculator/",
      "/features/withdrawal-strategies/",
      "/blog/how-long-will-my-money-last/",
      "/tools/how-long-will-my-money-last/",
      "/features/solvers/",
      "/docs/planning/solvers-and-guardrails/",
    ],
  },
  {
    subject: "US required distributions and Medicare premiums",
    paths: ["/tools/rmd-calculator/", "/tools/irmaa-calculator/", "/planning/us/"],
  },
  {
    subject: "72(t) payments",
    paths: ["/tools/72t-calculator/", "/tools/rmd-calculator/"],
  },
  {
    subject: "UK pensions and early retirement",
    paths: [
      "/tools/uk-fire-calculator/",
      "/tools/uk-pension-age-calculator/",
      "/planning/uk/",
      "/tools/fire-calculator/",
      "/tools/coast-fire-calculator/",
    ],
  },
  {
    subject: "UAE end-of-service gratuity",
    paths: ["/tools/uae-gratuity-calculator/", "/planning/ae/", "/features/tax-estimates/"],
  },
  {
    subject: "UK pensions and ISAs",
    paths: [
      "/tools/uk-pension-drawdown-calculator/",
      "/tools/isa-vs-pension-calculator/",
      "/planning/uk/",
      "/tools/how-long-will-my-money-last/",
      "/features/tax-estimates/",
    ],
  },
  {
    subject: "Comparisons",
    paths: [
      "/compare/boldin/",
      "/compare/projectionlab/",
      "/compare/boldin-vs-projectionlab/",
      "/compare/spreadsheets/",
      "/pricing/",
      "/open-source/",
    ],
  },
  {
    subject: "How long money lasts",
    paths: [
      "/blog/how-long-will-my-money-last/",
      "/tools/how-long-will-my-money-last/",
      "/tools/monte-carlo-retirement-calculator/",
      "/blog/monte-carlo-retirement-simulations/",
      "/docs/methodology/historical-data/",
      "/compare/spreadsheets/",
    ],
  },
  {
    subject: "Monte Carlo",
    paths: [
      "/tools/monte-carlo-retirement-calculator/",
      "/blog/monte-carlo-retirement-simulations/",
      "/compare/boldin/",
      "/compare/spreadsheets/",
      "/features/monte-carlo/",
      "/docs/methodology/monte-carlo/",
      "/docs/methodology/historical-data/",
    ],
  },
  {
    subject: "US retirement tax calculators",
    paths: [
      "/tools/retirement-tax-calculator/",
      "/tools/roth-conversion-calculator/",
      "/tools/aca-subsidy-calculator/",
      "/planning/us/",
      "/features/tax-estimates/",
      "/blog/what-a-tax-estimate-leaves-out/",
    ],
  },
  {
    subject: "API and MCP",
    paths: [
      "/api/",
      "/features/rest-api/",
      "/features/mcp-server/",
      "/docs/api-and-mcp/api-overview/",
      "/docs/api-and-mcp/api-reference/",
      "/docs/api-and-mcp/mcp-setup/",
      "/docs/api-and-mcp/mcp-overview/",
      "/docs/api-and-mcp/mcp-tools/",
      "/blog/ai-assistant-access-to-your-financial-plan/",
    ],
  },
  {
    subject: "Importing and exporting",
    paths: [
      "/features/import-and-export/",
      "/docs/importing/projectionlab/",
      "/docs/importing/csv/",
      "/docs/importing/glideworth-json/",
      "/compare/projectionlab/",
    ],
  },
  {
    subject: "Sharing and check-ins",
    paths: [
      "/features/sharing-and-roles/",
      "/docs/planning/sharing-and-roles/",
      "/features/progress-and-check-ins/",
      "/docs/planning/progress-and-check-ins/",
      "/docs/api-and-mcp/api-sharing-check-ins-and-webhooks/",
    ],
  },
  {
    subject: "Branches and what-ifs",
    paths: [
      "/features/branches-and-change-sets/",
      "/docs/planning/branches-and-what-ifs/",
      "/docs/api-and-mcp/api-change-sets/",
      "/features/solvers/",
      "/docs/planning/solvers-and-guardrails/",
    ],
  },
  {
    subject: "Reading results",
    paths: [
      "/features/projections-and-ledger/",
      "/features/explanations-and-audit/",
      "/docs/planning/read-your-results/",
      "/docs/methodology/how-projections-work/",
    ],
  },
  {
    subject: "Building a plan",
    paths: [
      "/features/plan-modelling/",
      "/docs/getting-started/first-plan/",
      "/docs/planning/build-a-plan/",
      "/docs/getting-started/concepts/",
    ],
  },
  {
    subject: "Running it yourself",
    paths: [
      "/self-hosting/",
      "/docs/self-hosting/docker/",
      "/docs/self-hosting/configuration/",
      "/docs/self-hosting/backups-and-restore/",
      "/docs/hosted/hosted-service/",
      "/pricing/",
    ],
  },
];

/** The related hrefs for a page, in cluster order, capped at {@link RELATED_LIMIT}. */
export function selectRelatedPaths(path: string, limit = RELATED_LIMIT): string[] {
  const out: string[] = [];
  for (const cluster of clusters) {
    if (!cluster.paths.includes(path)) continue;
    for (const candidate of cluster.paths) {
      if (candidate !== path && !out.includes(candidate)) out.push(candidate);
    }
  }
  return out.slice(0, limit);
}
