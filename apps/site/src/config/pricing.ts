/**
 * The one source of truth for price. The pricing page, the home page, structured data and every other
 * mention of price read from here. Change a number here and the whole site follows.
 */
import { facts } from "../lib/facts";

export type FeatureStatus = "available" | "planned";

export interface PlanFeature {
  label: string;
  /** One short line of detail, shown under the label on the pricing page. */
  detail?: string;
  /**
   * 'available': built and in use. 'planned': not built yet; the site shows a "Planned" marker. Never mark
   * something available that is not in the code. Nothing is planned at the moment.
   */
  status: FeatureStatus;
  /** True when only the hosted service has it; false or missing means the software has it, so you can self-host it too. */
  hostedOnly?: boolean;
}

export const pricing = {
  currency: "USD",
  currencySymbol: "$",
  monthly: 9,
  yearly: 90,
  trialDays: 14,
  /**
   * False: the trial starts with the workspace and needs no card. When it ends the workspace becomes read-only
   * (look, simulate, export) until the owner subscribes; nothing is charged by itself.
   */
  trialNeedsCard: false,
  planName: "Glideworth Cloud",
  selfHostName: "Self-hosted",
  /**
   * What the hosted plan includes. Items without `hostedOnly` are in the software itself, so you can
   * self-host them; `hostedOnly` items belong to the hosted service. List the software's own items first.
   */
  features: [
    {
      label: "The complete planner",
      detail:
        "Every projection, tax estimate, simulation, solver and explanation in the open-source app.",
      status: "available",
    },
    {
      label: "How much you can spend, and when you can retire",
      detail:
        "Solvers for the most you can spend, the earliest retirement date, the savings you need and a safe withdrawal rate.",
      status: "available",
    },
    {
      label: `Tax estimates for ${facts.taxCountryCount} countries`,
      detail:
        "US (federal, every state and some cities), UK, Canada, Australia, Germany, the Netherlands, France, Spain, Israel, Ireland, New Zealand and the UAE.",
      status: "available",
    },
    {
      label: "Unlimited plans and scenarios",
      detail: "What-if branches side by side, version history and survivor scenarios for couples.",
      status: "available",
    },
    {
      label: "Plan as a couple",
      detail:
        "Each partner signs in to the same household. Add a viewer, or send a read-only link.",
      status: "available",
    },
    {
      label: "Talk to ChatGPT or Claude about your plan",
      detail:
        "Your assistant reads the plan, runs the numbers and proposes changes you approve. A REST API for developers too.",
      status: "available",
    },
    {
      label: "Imports and exports",
      detail:
        "ProjectionLab JSON, bank and budgeting CSV, and Glideworth JSON in; JSON, CSV and a printable report out.",
      status: "available",
    },
    {
      label: "A ready address for your AI assistant",
      detail:
        "Add the hosted address to ChatGPT or Claude as a connector, then sign in. No server of your own.",
      status: "available",
      hostedOnly: true,
    },
    {
      label: "Tax-table and engine updates applied for you",
      detail: "The same releases self-hosters get, with nothing to redeploy.",
      status: "available",
      hostedOnly: true,
    },
    { label: "Sign-up, trial and billing", status: "available", hostedOnly: true },
    { label: "Automatic backups", status: "available", hostedOnly: true },
    { label: "Two-factor sign-in", status: "available", hostedOnly: true },
    {
      label: "Email check-in summaries",
      detail: "Self-hosted check-ins work through webhooks.",
      status: "available",
      hostedOnly: true,
    },
  ] as PlanFeature[],
} as const;

/**
 * Yearly prices of the paid plans people most often compare with, as their own pricing pages stated them on
 * `checkedOn`. The compare pages (src/content/compare) carry the full, sourced detail; keep the two in step.
 */
export const competitorPrices = {
  checkedOn: "19 November 2026",
  plans: [
    {
      name: "ProjectionLab Premium",
      yearly: 129,
      source: "https://projectionlab.com/pricing",
      compare: "/compare/projectionlab/",
    },
    {
      name: "Boldin PlannerPlus",
      yearly: 168,
      source: "https://boldin.com/pricing/",
      compare: "/compare/boldin/",
    },
  ],
} as const;

/** "$9", "$90". Whole numbers print without decimals. */
export function formatPrice(amount: number): string {
  const digits = Number.isInteger(amount) ? 0 : 2;
  return `${pricing.currencySymbol}${amount.toFixed(digits)}`;
}

/** What a year costs on the monthly plan, and what the yearly plan saves against it. */
export function yearlySaving(): { amount: number; percent: number; monthsFree: number } {
  const monthlyYear = pricing.monthly * 12;
  const amount = monthlyYear - pricing.yearly;
  return {
    amount,
    percent: Math.round((amount / monthlyYear) * 100),
    monthsFree: Math.round(amount / pricing.monthly),
  };
}

/** The day the card would first be charged with a card trial: the day after the trial ends. */
const firstChargeDay = (): number => pricing.trialDays + 1;

/** "14-day free trial, no card needed" (no final full stop). */
export function trialTerms(): string {
  return pricing.trialNeedsCard
    ? `${pricing.trialDays}-day free trial with a card, charged on day ${firstChargeDay()} unless you cancel`
    : `${pricing.trialDays}-day free trial, no card needed`;
}

/** One sentence for hero lines and calls to action. */
export function priceSentence(): string {
  const then = `then ${formatPrice(pricing.monthly)} a month or ${formatPrice(pricing.yearly)} a year`;
  return pricing.trialNeedsCard
    ? `${pricing.trialDays}-day free trial, ${then}. Your card is charged on day ${firstChargeDay()} unless you cancel.`
    : `${pricing.trialDays}-day free trial with no card, ${then}. Nothing is charged unless you subscribe.`;
}
