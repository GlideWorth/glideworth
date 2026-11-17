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
  trialDays: 7,
  /** A card is taken when the trial starts and charged the day after it ends, unless the trial is cancelled. */
  trialNeedsCard: true,
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
        "Every projection, tax estimate, Monte Carlo method, solver and explanation in the open-source app.",
      status: "available",
    },
    {
      label: `Tax estimates for ${facts.taxCountryCount} countries`,
      detail:
        "UK, US (federal, every state and some cities), Canada, Australia, Germany, the Netherlands, France, Spain, Israel, Ireland, New Zealand and the UAE.",
      status: "available",
    },
    {
      label: "Unlimited plans and branches",
      detail: "Branches, diffs, version history and survivor scenarios.",
      status: "available",
    },
    {
      label: "REST API and MCP server",
      detail:
        "Scoped keys, and OAuth for clients that connect by URL once the server has a public HTTPS address (the hosted service has one already).",
      status: "available",
    },
    {
      label: "Owner, editor and viewer sign-ins",
      detail: "Share a household, or send a read-only link.",
      status: "available",
    },
    {
      label: "Imports and exports",
      detail:
        "ProjectionLab JSON, bank and budgeting CSV, OFX, QFX and QIF in; JSON, CSV and a printable report out.",
      status: "available",
    },
    {
      label: "Hosted REST API and MCP endpoint",
      detail: "A stable HTTPS address with OAuth, so AI assistants connect without tunnels.",
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

/** The day the card is first charged: the day after the trial ends ("day 8" for a 7-day trial). */
export const firstChargeDay = (): number => pricing.trialDays + 1;

/** "7-day free trial with a card, charged on day 8 unless you cancel" (no final full stop). */
export function trialTerms(): string {
  return pricing.trialNeedsCard
    ? `${pricing.trialDays}-day free trial with a card, charged on day ${firstChargeDay()} unless you cancel`
    : `${pricing.trialDays}-day free trial, no card needed`;
}

/** One sentence for hero lines and calls to action. */
export function priceSentence(): string {
  return `${pricing.trialDays}-day free trial, then ${formatPrice(pricing.monthly)} a month or ${formatPrice(pricing.yearly)} a year. Your card is charged on day ${firstChargeDay()} unless you cancel.`;
}
