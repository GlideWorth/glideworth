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
      { label: "Free tools", href: "/tools/" },
      { label: "Changelog", href: "/changelog/" },
      { label: "Roadmap", href: "/roadmap/" },
    ],
  },
  {
    heading: "Planning",
    links: [
      { label: "Planning by country", href: "/planning/" },
      { label: "Moving country", href: "/planning/moving-country/" },
      { label: "Comparisons", href: "/compare/" },
      { label: "FIRE calculator", href: "/tools/fire-calculator/" },
      { label: "Monte Carlo calculator", href: "/tools/monte-carlo-retirement-calculator/" },
      { label: "Blog", href: "/blog/" },
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
