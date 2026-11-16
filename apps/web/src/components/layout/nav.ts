import {
  ArrowDownUp,
  ArrowLeftRight,
  BadgePercent,
  ChartArea,
  ChartSpline,
  Dices,
  FileText,
  GitCompareArrows,
  Landmark,
  LayoutDashboard,
  Lightbulb,
  ListTree,
  type LucideIcon,
  Settings,
  SlidersHorizontal,
  TrendingUp,
  Wallet,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Workstream that owns the page (docs/WORKPLAN.md). */
  owner: string;
}

export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Overview",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, owner: "h" },
      { to: "/finances", label: "Current finances", icon: Wallet, owner: "g" },
      { to: "/progress", label: "Progress", icon: TrendingUp, owner: "h" },
    ],
  },
  {
    group: "Planning",
    items: [
      { to: "/plans", label: "Plans", icon: ListTree, owner: "g" },
      { to: "/plans/active", label: "Plan editor", icon: SlidersHorizontal, owner: "g" },
    ],
  },
  {
    group: "Analysis",
    items: [
      { to: "/results", label: "Results", icon: ChartArea, owner: "h" },
      { to: "/chance", label: "Chance of success", icon: Dices, owner: "h" },
      { to: "/cashflow", label: "Cash flow", icon: ArrowLeftRight, owner: "h" },
      { to: "/taxes", label: "Taxes", icon: BadgePercent, owner: "h" },
      { to: "/compare", label: "Compare", icon: GitCompareArrows, owner: "h" },
      { to: "/insights", label: "Insights", icon: Lightbulb, owner: "h" },
      { to: "/reports", label: "Report", icon: FileText, owner: "h" },
      { to: "/estate", label: "Estate and legacy", icon: Landmark, owner: "h" },
      { to: "/builder", label: "Custom charts", icon: ChartSpline, owner: "h" },
    ],
  },
];

export const SETTINGS_NAV: NavItem = {
  to: "/settings",
  label: "Settings",
  icon: Settings,
  owner: "i",
};

/** (i) Import & export centre, listed next to Settings in the sidebar footer and mobile drawer. */
export const DATA_NAV: NavItem = {
  to: "/import",
  label: "Import & export",
  icon: ArrowDownUp,
  owner: "i",
};
