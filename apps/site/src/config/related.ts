/**
 * Clusters of pages about the same subject. Every page in a cluster shows the others under "Related",
 * in the order listed here (see src/components/RelatedLinks.astro). A page in several clusters gets the
 * union, capped at six. Paths must be real: the build fails on one that does not resolve to a page.
 * Add a page to a cluster instead of writing links into the pages themselves.
 */
export const clusters: { subject: string; paths: string[] }[] = [
  {
    subject: "Moving country",
    paths: [
      "/features/cross-border/",
      "/planning/moving-country/",
      "/docs/planning/moving-country/",
      "/blog/planning-a-move-abroad-taxes-pensions/",
      "/planning/uk/",
      "/planning/ae/",
      "/features/multi-currency/",
    ],
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
    subject: "Monte Carlo",
    paths: [
      "/features/monte-carlo/",
      "/docs/methodology/monte-carlo/",
      "/blog/monte-carlo-retirement-simulations/",
      "/blog/how-long-will-my-money-last/",
      "/docs/methodology/historical-data/",
    ],
  },
  {
    subject: "Withdrawals and FIRE",
    paths: [
      "/features/withdrawal-strategies/",
      "/blog/withdrawal-strategies-compared/",
      "/blog/what-is-your-fire-number/",
      "/blog/coast-fire-explained/",
      "/blog/barista-fire-part-time-income/",
      "/features/solvers/",
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
      "/docs/importing/bank-files/",
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
  {
    subject: "Comparisons",
    paths: [
      "/compare/boldin/",
      "/compare/projectionlab/",
      "/compare/spreadsheets/",
      "/pricing/",
      "/open-source/",
    ],
  },
];
