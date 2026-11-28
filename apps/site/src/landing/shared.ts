/**
 * Copy that every country version of the home page can reuse as it is. An entry that needs other wording
 * writes its own.
 */
import type { FeatureItem } from "../components/FeatureGrid.astro";

/** "What it answers": the six questions of the home page. */
export const sharedQuestions: FeatureItem[] = [
  {
    glyph: "solver",
    title: "How much can I spend?",
    body: "Glideworth finds the most you can spend each year and still have your plan work, at the level of confidence you choose.",
    href: "/features/solvers/",
  },
  {
    glyph: "solver",
    title: "When can I retire?",
    body: "The earliest date your plan holds up, the savings it takes to get there, and a withdrawal rate that lasts.",
    href: "/features/solvers/",
  },
  {
    glyph: "ledger",
    title: "Why does my plan fall short?",
    body: "A year-by-year table of income, tax, spending and withdrawals, and a plain explanation of what goes wrong and when.",
    href: "/features/explanations-and-audit/",
  },
  {
    glyph: "branch",
    title: "What if we do it differently?",
    body: "Copy your plan into a what-if, such as retiring three years earlier or selling the house, and compare the two side by side.",
    href: "/features/branches-and-change-sets/",
  },
  {
    glyph: "fan",
    title: "What do I cut if markets fall?",
    body: "Spending guardrails show what to spend this year, and how far your savings would have to fall before you cut back.",
    href: "/features/withdrawal-strategies/",
  },
  {
    glyph: "people",
    title: "What about the two of us?",
    body: "Plan as a couple: each of you signs in to the same household, and you can see what happens to the other if one of you dies.",
    href: "/features/sharing-and-roles/",
  },
];
