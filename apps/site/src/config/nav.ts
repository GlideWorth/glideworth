import { site } from "./site";

export interface NavLink {
  label: string;
  href: string;
  /** Opens another origin (the app or the repository). */
  external?: boolean;
}

/** Primary navigation in the header. Keep it short: six items at most. */
export const primaryNav: NavLink[] = [
  { label: "Features", href: "/features/" },
  { label: "Pricing", href: "/pricing/" },
  { label: "API & MCP", href: "/api/" },
  { label: "Countries", href: "/planning/" },
  { label: "Docs", href: "/docs/" },
  { label: "Blog", href: "/blog/" },
];

/** The footer site map. Every public route should be reachable from here. */
export const footerNav: { heading: string; links: NavLink[] }[] = [
  {
    heading: "Product",
    links: [
      { label: "Features", href: "/features/" },
      { label: "Pricing", href: "/pricing/" },
      { label: "API & MCP for AI agents", href: "/api/" },
      { label: "Changelog", href: "/changelog/" },
      { label: "Roadmap", href: "/roadmap/" },
    ],
  },
  {
    heading: "Calculators",
    links: [
      { label: "All free calculators", href: "/tools/" },
      { label: "FIRE calculator", href: "/tools/fire-calculator/" },
      { label: "Coast FIRE calculator", href: "/tools/coast-fire-calculator/" },
      { label: "Barista FIRE calculator", href: "/tools/barista-fire-calculator/" },
      {
        label: "Retirement withdrawal calculator",
        href: "/tools/retirement-withdrawal-calculator/",
      },
      { label: "How long will my money last?", href: "/tools/how-long-will-my-money-last/" },
      {
        label: "Monte Carlo retirement calculator",
        href: "/tools/monte-carlo-retirement-calculator/",
      },
    ],
  },
  {
    heading: "Planning",
    links: [
      { label: "Planning by country", href: "/planning/" },
      { label: "Moving country", href: "/planning/moving-country/" },
      { label: "Glideworth and Boldin", href: "/compare/boldin/" },
      { label: "Glideworth and spreadsheets", href: "/compare/spreadsheets/" },
      { label: "Glideworth and ProjectionLab", href: "/compare/projectionlab/" },
      { label: "Blog", href: "/blog/" },
    ],
  },
  {
    heading: "Countries",
    links: [
      { label: "United Kingdom", href: "/planning/uk/" },
      { label: "Ireland", href: "/planning/ie/" },
      { label: "France", href: "/planning/fr/" },
      { label: "Germany", href: "/planning/de/" },
      { label: "Netherlands", href: "/planning/nl/" },
      { label: "Spain", href: "/planning/es/" },
      { label: "United States", href: "/planning/us/" },
      { label: "Canada", href: "/planning/ca/" },
      { label: "Australia", href: "/planning/au/" },
      { label: "New Zealand", href: "/planning/nz/" },
      { label: "Israel", href: "/planning/il/" },
      { label: "United Arab Emirates", href: "/planning/ae/" },
    ],
  },
  {
    heading: "Open source",
    links: [
      { label: "Open source", href: "/open-source/" },
      { label: "Self-hosting", href: "/self-hosting/" },
      { label: "Documentation", href: "/docs/" },
      { label: "API reference", href: "/docs/api-and-mcp/api-reference/" },
      { label: "Source code", href: site.repoUrl, external: true },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", href: "/about/" },
      { label: "Security and privacy", href: "/security/" },
      { label: "Contact", href: "/contact/" },
      { label: "Legal", href: "/legal/" },
    ],
  },
];
