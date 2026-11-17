/**
 * Billing: the plan and its state in plain words, the free-trial countdown, prices read from the API,
 * Stripe Checkout for a monthly or yearly plan, the Stripe customer portal, and the cancellation and
 * refund terms (legal-decisions.md section 3). Only the workspace owner gets buttons.
 */
import { usePostHog } from "@posthog/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CreditCard, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/cn";
import { SectionIntro, SettingsGroup } from "../../settings/settings-ui";
import { type BillingInfo, cloudApi, type OfferedPrice } from "../client";
import { type BillingView, billingView } from "../billing-state";
import { fmtDateTime, fmtPrice } from "../format";
import { LEGAL_URL, SUPPORT_EMAIL } from "../legal";
import { nav } from "../next";
import { Loading, LoadError } from "../settings-kit";
import { describeError, FormAlert, isCode, Notice } from "../ui";
import { useLocale } from "../../../lib/workspace";

/** Only ever send the browser to Stripe's https pages (the server decides the URL; we check it anyway). */
export function goToStripe(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    nav.go(u.toString());
    return true;
  } catch {
    return false;
  }
}

const STATE_TONE: Record<BillingView["state"], "neutral" | "accent" | "ochre" | "negative"> = {
  "not-started": "neutral",
  trialing: "accent",
  active: "accent",
  cancelling: "ochre",
  "past-due": "ochre",
  comped: "accent",
  "read-only": "negative",
  suspended: "negative",
};

export function BillingSection() {
  // Stripe sends people back to /settings/billing?checkout=success.
  const [returned] = useState(
    () => new URLSearchParams(window.location.search).get("checkout") === "success",
  );
  const [started] = useState(() => Date.now());
  useEffect(() => {
    if (returned) window.history.replaceState(window.history.state, "", window.location.pathname);
  }, [returned]);

  const billing = useQuery({
    queryKey: ["cloud", "billing"],
    queryFn: cloudApi.billing,
    retry: false,
    // After paying, the subscription arrives by webhook a moment later: look again for up to a minute.
    refetchInterval: (q) =>
      returned &&
      q.state.data &&
      q.state.data.access.level !== "full" &&
      Date.now() - started < 60_000
        ? 2000
        : false,
  });

  // Once Stripe's confirmation arrives, the shell (banner, start-trial page) follows the new access level.
  const qc = useQueryClient();
  const level = billing.data?.access.level;
  const trialing = billing.data?.status === "trialing";
  const posthog = usePostHog();
  useEffect(() => {
    if (returned && level === "full") {
      posthog?.capture("billing_checkout_completed");
      if (trialing) posthog?.capture("trial_started");
      void qc.invalidateQueries({ queryKey: ["session"] });
    }
  }, [returned, level, trialing, qc, posthog]);

  if (billing.isLoading) return <Loading what="billing" />;
  if (billing.isError || !billing.data)
    return (
      <LoadError error={billing.error} what="Billing" onRetry={() => void billing.refetch()} />
    );
  return <BillingBody b={billing.data} returned={returned} />;
}

function BillingBody({ b, returned }: { b: BillingInfo; returned: boolean }) {
  const locale = useLocale();
  const view = billingView(b, new Date(), locale);
  const owner = b.role === "owner";
  const [error, setError] = useState<string | null>(null);
  const posthog = usePostHog();

  const portal = useMutation({
    mutationFn: cloudApi.portal,
    onMutate: () => setError(null),
    onSuccess: (r) => {
      if (!goToStripe(r.url)) setError("The billing portal sent an address we did not recognise.");
    },
    onError: (e) => setError(describeError(e)),
  });
  const checkout = useMutation({
    mutationFn: (lookupKey: string) => cloudApi.checkout(lookupKey),
    onMutate: () => setError(null),
    onSuccess: (r, lookupKey) => {
      if (goToStripe(r.url)) {
        const interval = b.offered?.find((offer) => offer.lookupKey === lookupKey)?.interval;
        posthog?.capture("billing_checkout_started", {
          ...(interval ? { billing_interval: interval } : {}),
        });
      } else setError("Checkout sent an address we did not recognise.");
    },
    onError: (e) => {
      if (isCode(e, "ALREADY_SUBSCRIBED"))
        setError(
          "A subscription already exists for this workspace. Use Manage billing to change it.",
        );
      else if (isCode(e, "CHECKOUT_IN_PROGRESS"))
        setError(
          "A checkout for this workspace was just completed. Your subscription will show here shortly; refresh the page in a minute.",
        );
      else setError(describeError(e));
    },
  });

  const offered = [...(b.offered ?? [])].sort(
    (x, y) => (x.interval === "month" ? -1 : 1) - (y.interval === "month" ? -1 : 1),
  );
  const showPlans = owner && view.action === "subscribe";

  return (
    <>
      <SectionIntro title="Billing">
        Your workspace&rsquo;s plan. Glideworth Cloud starts with a 7-day free trial: you add a card
        at the start and are charged on day 8 unless you cancel before then. After that it is a
        monthly or yearly subscription. If it lapses, your workspace becomes read-only; it is never
        locked or deleted without warning.
      </SectionIntro>

      {returned ? (
        <div role="status" aria-live="polite">
          <Notice tone={b.access.level === "full" ? "positive" : "neutral"}>
            {b.access.reason === "trial"
              ? "Thank you. Your free trial has started."
              : b.access.level === "full"
                ? "Thank you. Your subscription is active."
                : "Thank you. We are waiting for Stripe to confirm; this page updates by itself."}
          </Notice>
        </div>
      ) : null}

      <SettingsGroup
        title="Your plan"
        actions={<Badge tone={STATE_TONE[view.state]}>{view.label}</Badge>}
      >
        <div className="flex flex-col gap-3 px-5 py-4">
          <h3 className="text-[15px] font-semibold text-ink">{view.headline}</h3>
          {view.body.map((p) => (
            <p key={p} className="max-w-2xl text-[13px] leading-relaxed text-ink-2">
              {p}
            </p>
          ))}
          {view.state === "trialing" && b.trialEndsAt ? (
            <p className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
              <CalendarClock className="size-4" aria-hidden />
              Trial ends {fmtDateTime(b.trialEndsAt, locale)}
            </p>
          ) : null}
          {!owner ? (
            <p className="rounded-md bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2">
              Only the workspace owner can change the plan or payment method. Ask them if anything
              here needs attention.
            </p>
          ) : null}
          {error ? <FormAlert>{error}</FormAlert> : null}
          {owner && view.action === "portal" ? (
            <div>
              <Button variant="primary" disabled={portal.isPending} onClick={() => portal.mutate()}>
                {portal.isPending ? <Loader2 className="animate-spin" /> : <CreditCard />}
                {view.state === "past-due" ? "Update payment method" : "Manage billing"}
              </Button>
            </div>
          ) : null}
        </div>
      </SettingsGroup>

      {showPlans ? (
        <SettingsGroup
          title={view.trialDays ? `Start your ${view.trialDays}-day free trial` : "Choose a plan"}
          description={
            view.trialDays
              ? "Full access to every feature. Pick how you want to pay after the trial; you are not charged until it ends."
              : "Full access to every feature. Cancel any time; it ends at the end of the period you paid for."
          }
        >
          <div className="grid gap-3 px-5 py-4 sm:grid-cols-2">
            {offered.length === 0 ? (
              <p className="text-[13px] text-ink-2 sm:col-span-2">
                No plan is on offer right now. Please try again later or write to {SUPPORT_EMAIL}.
              </p>
            ) : (
              offered.map((o) => (
                <PlanCard
                  key={o.lookupKey}
                  offer={o}
                  all={offered}
                  locale={locale}
                  busy={checkout.isPending && checkout.variables === o.lookupKey}
                  disabled={checkout.isPending}
                  trial={Boolean(view.trialDays)}
                  onChoose={() => checkout.mutate(o.lookupKey)}
                />
              ))
            )}
          </div>
          <p className="px-5 pb-4 text-[11.5px] text-ink-3">
            You pay on Stripe&rsquo;s secure page; Glideworth never sees your card. Each price says
            whether tax is included; any tax that applies is added at checkout, where you see the
            total before you pay.
          </p>
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="Cancelling and refunds">
        <div className="flex max-w-2xl flex-col gap-2 px-5 py-4 text-[13px] leading-relaxed text-ink-2">
          <p>
            <span className="font-medium text-ink">Cancel any time</span> in the billing portal. It
            takes effect at the end of the period you have paid for, and you keep full access until
            then. Cancel during the free trial and you are never charged.
          </p>
          <p>
            <span className="font-medium text-ink">14-day refund.</span> Ask within 14 days of any
            payment, the first one or a renewal, monthly or yearly, and we refund it in full,
            including tax. You do not need a reason, and using the service does not affect it. After
            a refund the workspace becomes read-only. To ask, write to{" "}
            <a
              className="text-accent underline underline-offset-2"
              href={`mailto:${SUPPORT_EMAIL}?subject=Refund%20request`}
            >
              {SUPPORT_EMAIL}
            </a>{" "}
            from your account address, or reply to your payment receipt.{" "}
            <a
              className="inline-flex items-center gap-0.5 text-accent underline underline-offset-2"
              href={LEGAL_URL.refunds}
              target="_blank"
              rel="noreferrer"
            >
              Terms of Service <ExternalLink className="size-3" aria-hidden />
            </a>
          </p>
        </div>
      </SettingsGroup>
    </>
  );
}

function PlanCard({
  offer,
  all,
  locale,
  busy,
  disabled,
  trial,
  onChoose,
}: {
  offer: OfferedPrice;
  all: OfferedPrice[];
  locale: string;
  busy: boolean;
  disabled: boolean;
  /** The Checkout starts a free trial: the button says so. */
  trial: boolean;
  onChoose: () => void;
}) {
  const yearly = offer.interval === "year";
  const price = fmtPrice(offer.unitAmount, offer.currency, locale);
  // "Save 17%": the yearly price against twelve monthly ones, when both are in one currency.
  const month = all.find((o) => o.interval === "month");
  const save =
    yearly && month && month.currency === offer.currency
      ? Math.round((1 - offer.unitAmount / (month.unitAmount * 12)) * 100)
      : 0;
  const name = yearly ? "Yearly" : "Monthly";
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border p-4",
        yearly && "border-accent/50",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-ink">{name}</h3>
        {save > 0 ? <Badge tone="accent">Save {save}%</Badge> : null}
      </div>
      <p className="text-ink">
        <span className="num text-[26px] font-semibold">{price}</span>{" "}
        <span className="text-[13px] text-ink-2">/ {yearly ? "year" : "month"}</span>
        <span className="block text-[11.5px] text-ink-3">
          {offer.taxBehavior === "exclusive" ? "plus tax where it applies" : "tax included"}
        </span>
      </p>
      <Button
        variant="primary"
        disabled={disabled}
        onClick={onChoose}
        aria-label={
          trial ? `Start free trial, ${name.toLowerCase()}` : `Subscribe ${name.toLowerCase()}`
        }
      >
        {busy ? <Loader2 className="animate-spin" /> : null}{" "}
        {trial ? `Start trial, ${name.toLowerCase()}` : `Subscribe ${name.toLowerCase()}`}
      </Button>
    </div>
  );
}
