/**
 * The calculators, for the /tools/ index and the "related" links on each page. Country-specific tools
 * (UK pension drawdown, UK take-home pay, UAE gratuity) are not built yet: add them here
 * with `group: 'country'`, a spec in specs/, a compute module in engine/ and a page in pages/tools/.
 */
import type { ToolId } from "./types";

export interface ToolMeta {
  id: ToolId;
  path: string;
  name: string;
  /** One sentence for cards and links. */
  summary: string;
  /** The question it answers, for the index. */
  question: string;
  group: "fire" | "retirement" | "country";
  article: { href: string; title: string };
}

export const TOOLS: readonly ToolMeta[] = [
  {
    id: "coast-fire",
    path: "/tools/coast-fire-calculator/",
    name: "Coast FIRE calculator",
    summary:
      "How much you need invested today for growth alone to reach your target, and when you get there.",
    question: "Can I stop saving for retirement yet?",
    group: "fire",
    article: {
      href: "/blog/coast-fire-explained/",
      title: "Coast FIRE number, formula and gaps",
    },
  },
  {
    id: "fire",
    path: "/tools/fire-calculator/",
    name: "FIRE calculator",
    summary:
      "Your FIRE number from spending and a withdrawal rate, and how many years of saving it takes.",
    question: "How much do I need, and when will I have it?",
    group: "fire",
    article: {
      href: "/blog/what-is-your-fire-number/",
      title: "FIRE number: the 25x rule and its limits",
    },
  },
  {
    id: "fat-fire",
    path: "/tools/fat-fire-calculator/",
    name: "Fat FIRE calculator",
    summary:
      "The portfolio a high yearly spend needs at a withdrawal rate below 4%, the years to reach it, and the gap versus lean and regular spending.",
    question: "What does a high-spending retirement take?",
    group: "fire",
    article: {
      href: "/blog/what-is-your-fire-number/",
      title: "FIRE number: the 25x rule and its limits",
    },
  },
  {
    id: "barista-fire",
    path: "/tools/barista-fire-calculator/",
    name: "Barista FIRE calculator",
    summary:
      "The portfolio you need when part-time pay covers some of your spending for a number of years.",
    question: "How much less do I need with part-time income?",
    group: "fire",
    article: {
      href: "/blog/barista-fire-part-time-income/",
      title: "Barista FIRE and part-time income",
    },
  },
  {
    id: "how-long",
    path: "/tools/how-long-will-my-money-last/",
    name: "How long will my money last?",
    summary:
      "Years of withdrawals a balance covers at a steady return, then tested against US market history.",
    question: "When does the money run out?",
    group: "retirement",
    article: {
      href: "/blog/how-long-will-my-money-last/",
      title: "How long will my money last?",
    },
  },
  {
    id: "withdrawal",
    path: "/tools/retirement-withdrawal-calculator/",
    name: "Retirement withdrawal calculator",
    summary:
      "Four withdrawal rules side by side on the same simulated markets: income, cuts and running out.",
    question: "Which withdrawal rule suits me?",
    group: "retirement",
    article: {
      href: "/blog/withdrawal-strategies-compared/",
      title: "Withdrawal strategies: four rules compared",
    },
  },
  {
    id: "monte-carlo",
    path: "/tools/monte-carlo-retirement-calculator/",
    name: "Monte Carlo retirement calculator",
    summary:
      "Your chance that every year’s spending is paid, across thousands of seeded market sequences.",
    question: "How often does my plan work?",
    group: "retirement",
    article: {
      href: "/blog/monte-carlo-retirement-simulations/",
      title: "Monte Carlo retirement simulations",
    },
  },
];

export function toolMeta(id: ToolId): ToolMeta {
  const t = TOOLS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown tool ${id}`);
  return t;
}
