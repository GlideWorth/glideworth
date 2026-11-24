/**
 * The calculators, for the /tools/ index and the "related" links on each page. Country-specific tools
 * still to build (UK take-home pay, UAE gratuity): add them here
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
  group: "fire" | "retirement" | "tax" | "country";
  /** The article behind the calculator; optional for tools with no article yet. */
  article?: { href: string; title: string };
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
      "A safe withdrawal rate and the 4% rule, then four withdrawal rules on the same simulated markets.",
    question: "What rate lasts, and which rule suits me?",
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
  {
    id: "rmd",
    path: "/tools/rmd-calculator/",
    name: "RMD calculator",
    summary:
      "Your required minimum distribution for a year, the age RMDs start for your birth year, and the RMDs that follow.",
    question: "How much must I take out this year?",
    group: "tax",
    article: { href: "/planning/us/", title: "Retirement planning in the United States" },
  },
  {
    id: "sepp-72t",
    path: "/tools/72t-calculator/",
    name: "72(t) calculator",
    summary:
      "The yearly payment under the fixed annuitisation method, from the IRS mortality rates, and what it does to the balance.",
    question: "How much can 72(t) payments give me?",
    group: "tax",
  },
  {
    id: "irmaa",
    path: "/tools/irmaa-calculator/",
    name: "IRMAA calculator",
    summary:
      "Your Medicare IRMAA tier and the Part B and Part D surcharges from your income two years earlier, and how far the next tier is.",
    question: "Will my income raise my Medicare premiums?",
    group: "tax",
    article: { href: "/planning/us/", title: "Retirement planning in the United States" },
  },
  {
    id: "uk-fire",
    path: "/tools/uk-fire-calculator/",
    name: "UK FIRE calculator",
    summary:
      "Your FIRE age, and whether your ISA can bridge the years until your pension can be taken, with a UK income tax estimate.",
    question: "Can my ISA bridge the gap to my pension?",
    group: "country",
    article: { href: "/planning/uk/", title: "Retirement planning in the United Kingdom" },
  },
  {
    id: "uk-pension-age",
    path: "/tools/uk-pension-age-calculator/",
    name: "UK pension age calculator",
    summary:
      "Your State Pension age and the earliest age you can take a private or workplace pension, with the dates.",
    question: "When can I take my pensions?",
    group: "country",
    article: { href: "/planning/uk/", title: "Retirement planning in the United Kingdom" },
  },
  {
    id: "uae-gratuity",
    path: "/tools/uae-gratuity-calculator/",
    name: "UAE gratuity calculator",
    summary:
      "End-of-service gratuity from your years of service and basic wage, tier by tier with the cap, against the savings scheme.",
    question: "What is my end-of-service gratuity?",
    group: "country",
    article: { href: "/planning/ae/", title: "Retirement planning in the United Arab Emirates" },
  },
  {
    id: "retirement-tax",
    path: "/tools/retirement-tax-calculator/",
    name: "Retirement tax calculator",
    summary:
      "US federal tax on a year of Social Security, IRA withdrawals, pensions and investment income, with your effective and marginal rate.",
    question: "How much federal tax will I pay in retirement?",
    group: "tax",
    article: {
      href: "/blog/what-a-tax-estimate-leaves-out/",
      title: "What a tax estimate leaves out",
    },
  },
  {
    id: "roth-conversion",
    path: "/tools/roth-conversion-calculator/",
    name: "Roth conversion calculator",
    summary:
      "How much to convert to fill a federal bracket this year, the tax on it, and a multi-year ladder against no conversions.",
    question: "How much should I convert to Roth this year?",
    group: "tax",
    article: {
      href: "/blog/what-a-tax-estimate-leaves-out/",
      title: "What a tax estimate leaves out",
    },
  },
  {
    id: "aca-subsidy",
    path: "/tools/aca-subsidy-calculator/",
    name: "ACA subsidy calculator",
    summary:
      "The ACA premium tax credit for your income and household, and how much more income you can have before it ends.",
    question: "What will health insurance cost before Medicare?",
    group: "tax",
    article: {
      href: "/blog/what-a-tax-estimate-leaves-out/",
      title: "What a tax estimate leaves out",
    },
  },
  {
    id: "guardrails",
    path: "/tools/guardrails-retirement-calculator/",
    name: "Guardrails retirement calculator",
    summary:
      "Guyton-Klinger and risk-based guardrails in money: what to spend now, the portfolio values that trigger a cut or a raise, and both rules through a bad and a typical stretch of history.",
    question: "When should I cut or raise my spending?",
    group: "retirement",
    article: {
      href: "/blog/withdrawal-strategies-compared/",
      title: "Withdrawal strategies: four rules compared",
    },
  },
  {
    id: "retirement-spending",
    path: "/tools/retirement-spending-calculator/",
    name: "Retirement spending calculator",
    summary:
      "The most you can spend every year at the chance of success you choose, with other income from an age, and how the portfolio spends down.",
    question: "How much can I spend in retirement?",
    group: "retirement",
    article: {
      href: "/blog/monte-carlo-retirement-simulations/",
      title: "Monte Carlo retirement simulations",
    },
  },
  {
    id: "historical-backtest",
    path: "/tools/historical-retirement-calculator/",
    name: "Historical retirement calculator",
    summary:
      "Your plan replayed through every start year of US history since 1928, each year’s path drawn, with the worst start years and the balances left.",
    question: "Would my plan have survived history?",
    group: "retirement",
    article: {
      href: "/blog/how-long-will-my-money-last/",
      title: "How long will my money last?",
    },
  },
  {
    id: "uk-drawdown",
    path: "/tools/uk-pension-drawdown-calculator/",
    name: "UK pension drawdown calculator",
    summary:
      "How long your pension pot pays the income you want after tax, with tax-free cash and the State Pension.",
    question: "How long will my pension last, and what tax do I pay?",
    group: "country",
    article: { href: "/planning/uk/", title: "Retirement planning in the United Kingdom" },
  },
  {
    id: "isa-vs-pension",
    path: "/tools/isa-vs-pension-calculator/",
    name: "ISA vs pension calculator",
    summary:
      "The same take-home pay saved into a pension or an ISA, and the income after tax each pays in retirement.",
    question: "Should I save into an ISA or a pension?",
    group: "country",
    article: { href: "/planning/uk/", title: "Retirement planning in the United Kingdom" },
  },
];

export function toolMeta(id: ToolId): ToolMeta {
  const t = TOOLS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown tool ${id}`);
  return t;
}
