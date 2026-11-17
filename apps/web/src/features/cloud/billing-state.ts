/**
 * What the billing screen and the banners say for each subscription state, in plain words. Pure: the
 * API's answer (`GET /api/v1/billing`, access level + reason from packages/billing access.ts) goes in, a
 * description comes out, so every state is covered by tests.
 */
import type { BillingInfo } from "./client";
import { daysLeft, daysText, fmtDate, fmtPrice } from "./format";

type BillingState =
  | "not-started"
  | "trialing"
  | "active"
  | "cancelling"
  | "past-due"
  | "comped"
  | "read-only"
  | "suspended";

export interface BillingView {
  state: BillingState;
  /** Short label for a badge. */
  label: string;
  headline: string;
  /** Paragraphs, in order. */
  body: string[];
  /** What the owner can do next; members never get a button. */
  action: "subscribe" | "portal" | "none";
  /** The free trial a Checkout starts now (days), or null when it charges at once. */
  trialDays?: number | null;
  /** Whole days of trial left (trialing only). */
  trialDaysLeft?: number;
}

const DELETION =
  "If a workspace stays without a subscription, it is deleted 12 months after the trial ended or the last paid period ended. We email the owner 30 days and 7 days before. Subscribing restores access and starts the clock again; signing in does not.";

const READ_ONLY_WHY: Record<string, string> = {
  canceled: "The subscription has ended.",
  past_due: "The last payment did not go through and the grace period is over.",
  unpaid: "Payment failed and could not be collected.",
  paused: "The subscription is paused.",
  incomplete: "The first payment was not completed.",
};

/** The date the first charge would fall on if a trial of `days` started now. */
export function firstChargeDate(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

/** "$9 a month or $90 a year, charged in USD" from the offered prices (monthly first). */
export function priceLine(offered: BillingInfo["offered"], locale?: string): string {
  const list = [...(offered ?? [])].sort(
    (x, y) => (x.interval === "month" ? -1 : 1) - (y.interval === "month" ? -1 : 1),
  );
  if (list.length === 0) return "";
  const parts = list.map(
    (o) =>
      `${fmtPrice(o.unitAmount, o.currency, locale)} a ${o.interval === "year" ? "year" : "month"}`,
  );
  const currencies = [...new Set(list.map((o) => o.currency.toUpperCase()))];
  return `${parts.join(" or ")}${currencies.length === 1 ? `, charged in ${currencies[0]}` : ""}`;
}

export function billingView(b: BillingInfo, now: Date = new Date(), locale?: string): BillingView {
  const { level, reason, changesAt } = b.access;
  const periodEnd = fmtDate(b.currentPeriodEnd, locale);
  const plan = b.plan
    ? `${b.plan}${b.interval ? `, billed ${b.interval === "year" ? "yearly" : "monthly"}` : ""}`
    : "your plan";

  if (level === "suspended")
    return {
      state: "suspended",
      label: "Suspended",
      headline: "This workspace is suspended",
      body: [
        "Glideworth has suspended this workspace. You cannot open its plans, but the owner can still export or delete it from the Workspace settings.",
        "Write to support@glideworth.com to find out why and what to do next.",
      ],
      action: "none",
    };

  if (level === "read_only" && reason === "no_subscription") {
    const trialDays = b.trialDays ?? null;
    const prices = priceLine(b.offered, locale);
    const owner = b.role === "owner";
    if (!owner)
      return {
        state: "not-started",
        label: "Not started",
        headline: "This workspace has not started yet",
        body: [
          "The workspace owner has not started the subscription yet, so its plans cannot be opened. Ask them to start it in Billing.",
        ],
        action: "subscribe",
        trialDays,
      };
    return trialDays
      ? {
          state: "not-started",
          label: "Not started",
          headline: `Start your ${trialDays}-day free trial`,
          body: [
            `Glideworth Cloud is ${prices || "a monthly or yearly subscription"}. Add a card on Stripe's secure page to start the trial.`,
            `You will not be charged until ${fmtDate(firstChargeDate(trialDays, now).toISOString(), locale)}. Cancel any time before then in Billing.`,
          ],
          action: "subscribe",
          trialDays,
        }
      : {
          state: "not-started",
          label: "Not started",
          headline: "Choose a plan",
          body: [
            `Glideworth Cloud is ${prices || "a monthly or yearly subscription"}. You have already had a free trial, so your card is charged when you subscribe.`,
          ],
          action: "subscribe",
          trialDays,
        };
  }

  if (level === "full") {
    if (reason === "trial") {
      const left = daysLeft(b.trialEndsAt, now);
      const ends = fmtDate(b.trialEndsAt, locale) || "the end of the trial";
      const offer = b.offered?.find((o) => o.lookupKey === b.lookupKey);
      const charge = offer
        ? `${fmtPrice(offer.unitAmount, offer.currency, locale)}${offer.taxBehavior === "exclusive" ? " plus any tax" : ""}`
        : "the plan price";
      if (b.cancelAtPeriodEnd)
        return {
          state: "cancelling",
          label: "Ending",
          trialDaysLeft: left,
          headline: `Your free trial ends on ${ends}`,
          body: [
            "You cancelled during the free trial, so you will not be charged. You keep full access until then.",
            "After that the workspace becomes read-only (you can still look, simulate and export). You can resume in the billing portal before the trial ends, or subscribe again later.",
          ],
          action: "portal",
        };
      return {
        state: "trialing",
        label: "Free trial",
        trialDaysLeft: left,
        headline: `Free trial: ${daysText(left)} left`,
        body: [
          `You have full access. Your card will be charged ${charge} on ${ends}, and then ${b.interval === "year" ? "every year" : "every month"}, unless you cancel before then.`,
          "To cancel, open Manage billing and cancel the subscription. You will not be charged, and you keep access until the trial ends.",
        ],
        action: "portal",
      };
    }
    if (reason === "past_due_grace")
      return {
        state: "past-due",
        label: "Payment failed",
        headline: "Your last payment did not go through",
        body: [
          `You still have full access${changesAt ? ` until ${fmtDate(changesAt, locale)}` : " for a short grace period"}. Update your payment method in the billing portal; we will try the payment again.`,
          "If it still fails, the workspace becomes read-only until a payment succeeds. Nothing is deleted.",
        ],
        action: "portal",
      };
    if (reason === "comped")
      return {
        state: "comped",
        label: "Complimentary",
        headline: "Complimentary access",
        body: [
          `Glideworth has given this workspace full access${changesAt ? ` until ${fmtDate(changesAt, locale)}` : ""}. No payment is needed.`,
        ],
        action: "none",
      };
    if (b.cancelAtPeriodEnd)
      return {
        state: "cancelling",
        label: "Ending",
        headline: `Your subscription ends on ${periodEnd || "the end of this period"}`,
        body: [
          `You cancelled ${plan}. You keep full access until then, and nothing is charged again.`,
          "After that the workspace becomes read-only (you can still look, simulate and export). You can resume in the billing portal any time before it ends, or subscribe again later.",
        ],
        action: "portal",
      };
    return {
      state: "active",
      label: "Active",
      headline: `Active: ${plan}`,
      body: [
        `Your subscription renews on ${periodEnd || "its next billing date"}. Cancel any time in the billing portal; it takes effect at the end of the paid period.`,
      ],
      action: "portal",
    };
  }

  const why = READ_ONLY_WHY[reason] ?? "This workspace is not on an active plan.";
  const portalFirst = reason === "past_due" || reason === "unpaid" || reason === "paused";
  return {
    state: "read-only",
    label: "Read-only",
    headline: "This workspace is read-only",
    body: [
      `${why} You can still look at everything, run simulations and export your data, but nobody can make changes.`,
      portalFirst
        ? `${b.role === "owner" ? "Fix" : "The owner can fix"} the payment in the billing portal; editing returns as soon as a payment succeeds.`
        : b.role === "owner"
          ? "Subscribe below to edit again; editing returns as soon as the payment goes through."
          : "The owner can subscribe to edit again; editing returns as soon as the payment goes through.",
      DELETION,
    ],
    action: portalFirst ? "portal" : "subscribe",
  };
}

/** A line for the shell banner; null when no banner is needed. */
export function bannerFor(
  access: { level: string; reason: string; changesAt: string | null } | null | undefined,
  trialEndsAt: string | null | undefined,
  owner: boolean,
  now: Date = new Date(),
): { tone: "info" | "warning" | "danger"; text: string; cta: string | null } | null {
  if (!access || access.level === "suspended") return null;
  if (access.level === "full") {
    if (access.reason === "trial") {
      const left = daysLeft(trialEndsAt ?? access.changesAt, now);
      const days = daysText(left);
      const on = fmtDate(trialEndsAt ?? access.changesAt);
      // Cancelled during the trial (changesAt set): access ends with the trial and nothing is charged.
      const ending = access.changesAt !== null;
      return {
        tone: left <= 2 ? "warning" : "info",
        text: ending
          ? `Free trial: ${days} left. It was cancelled, so nothing will be charged.`
          : owner
            ? `Free trial: ${days} left. Your card is charged${on ? ` on ${on}` : " when it ends"} unless you cancel in Billing.`
            : `Free trial: ${days} left.`,
        cta: owner ? "Billing" : null,
      };
    }
    if (access.reason === "past_due_grace")
      return {
        tone: "warning",
        text: owner
          ? "Your last payment did not go through. Update your payment method to keep editing."
          : "The workspace's last payment did not go through. Ask the owner to update the payment method.",
        cta: owner ? "Update payment" : null,
      };
    return null;
  }
  const payment = ["past_due", "unpaid", "paused"].includes(access.reason);
  // Not started yet: the start-trial page takes the whole screen, no banner.
  if (access.reason === "no_subscription") return null;
  const text =
    access.reason === "canceled"
      ? "The subscription has ended, so this workspace is read-only."
      : payment
        ? "Payment failed, so this workspace is read-only."
        : "This workspace is read-only.";
  return owner
    ? {
        tone: "danger",
        text: `${text} You can look, simulate and export; subscribe to edit again.`,
        cta: payment ? "Fix payment" : "Subscribe",
      }
    : {
        tone: "danger",
        text: `${text} You can look, simulate and export; ask the workspace owner to subscribe to edit again.`,
        cta: null,
      };
}
