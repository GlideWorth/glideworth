/**
 * Server-side product events for the hosted service: the billing moments no browser sees, because they happen
 * in Stripe (a trial ending in a first payment, a renewal, a cancellation that takes effect), and the free
 * calculators' "Email me this result" form (the calculator pages load no analytics of their own). Sent to the same
 * PostHog project as the web app and the server error reports (`config.errorReports`), so a self-host copy,
 * which has no token, sends nothing.
 *
 * What is sent is fixed by `ServerProductEvent`: an event name and a few allowlisted string or boolean
 * properties (subscription statuses and the kind of change). Never an amount, a price, a plan figure, a name or
 * an email address. The distinct id is the workspace owner's user id, the id the web app identifies them by,
 * so the events join the owner's person and funnels. PostHog's GeoIP lookup is off (the request comes from our
 * server, not the customer's browser).
 *
 * Plain `fetch` to the capture endpoint (`<host>/i/v0/e/`), like the error reporter: one small request per
 * event needs no client library. Never blocks or throws into the caller: `capture` queues one request with a
 * short timeout, at most `maxInFlight` are open (the rest are dropped and counted), and `flush` waits (bounded)
 * for the open ones; the server calls it on shutdown.
 */
import type { Logger } from "./index.js";

/** The kind of subscription change a `subscription_status_changed` event reports (`subscriptionChange`). */
export type SubscriptionChange =
  | "started"
  | "converted"
  | "canceled"
  | "cancel_scheduled"
  | "cancel_reverted"
  | "past_due"
  | "recovered"
  | "other";

/** Every server-side product event and its properties. Adding one means updating the privacy policy too. */
export type ServerProductEvent =
  | {
      event: "subscription_status_changed";
      properties: {
        change: SubscriptionChange;
        /**
         * Subscription statuses (`trialing_local` for a new workspace before Checkout, then Stripe's `trialing`,
         * `active`, `past_due`, `canceled` …); null when there was no record.
         */
        from_status: string | null;
        to_status: string;
        cancel_at_period_end: boolean;
      };
    }
  | { event: "subscription_payment_succeeded"; properties?: undefined }
  /**
   * "Email me this result" on a free calculator (marketing/service.ts). Anonymous: the distinct id is the consent
   * record's id when the reminder box was ticked (so a later confirmation joins it), otherwise a random id, and no
   * person profile is made. Never the address.
   */
  | {
      event: "calculator_email_requested";
      properties: { tool: string; updates_opt_in: boolean; $process_person_profile: false };
    }
  | {
      event: "calculator_email_confirmed";
      properties: { tool: string; $process_person_profile: false };
    }
  | { event: "calculator_email_unsubscribed"; properties: { $process_person_profile: false } };

export interface ProductEvents {
  capture(distinctId: string, e: ServerProductEvent): void;
  flush(timeoutMs?: number): Promise<void>;
}

export interface PostHogProductEventsOptions {
  /** The PostHog project token (public by design; the web app uses the same one). */
  token: string;
  /** The PostHog ingestion host, e.g. `https://us.i.posthog.com`. */
  host: string;
  /** Warnings about the sender itself. */
  log?: Logger;
  fetch?: typeof fetch;
  now?: () => number;
  /** Open requests at once (default 8). */
  maxInFlight?: number;
  /** Per request (default 5 seconds). */
  timeoutMs?: number;
}

const ENDED = new Set(["canceled", "incomplete_expired"]);
const LIVE = new Set(["trialing", "active"]);
/** No live Stripe subscription before: a new workspace (`trialing_local`), an unfinished checkout, or none. */
const NOT_YET = new Set(["trialing_local", "incomplete"]);
const UNPAID = new Set(["past_due", "unpaid"]);

/**
 * What a subscription status change means, for funnels: a new trial or paid subscription (`started`), a trial
 * that became paid (`converted`), the end of a subscription (`canceled`), cancellation at period end set or
 * undone, a failed renewal (`past_due`) and its recovery.
 */
export function subscriptionChange(
  from: string | null,
  to: string,
  cancelAtPeriodEnd: boolean,
): SubscriptionChange {
  if (ENDED.has(to)) return "canceled";
  if (from === to) return cancelAtPeriodEnd ? "cancel_scheduled" : "cancel_reverted";
  if (LIVE.has(to) && (from === null || NOT_YET.has(from) || ENDED.has(from))) return "started";
  if (from === "trialing" && to === "active") return "converted";
  if (UNPAID.has(to)) return "past_due";
  if (from !== null && UNPAID.has(from) && to === "active") return "recovered";
  return "other";
}

export function createPostHogProductEvents(o: PostHogProductEventsOptions): ProductEvents {
  const send = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const maxInFlight = o.maxInFlight ?? 8;
  const timeoutMs = o.timeoutMs ?? 5_000;
  const url = `${o.host.replace(/\/+$/, "")}/i/v0/e/`;
  const inFlight = new Set<Promise<void>>();
  let dropped = 0;
  let warnedAt = Number.NEGATIVE_INFINITY;

  const warn = (reason: string, statusCode?: number) => {
    const t = now();
    if (t - warnedAt < 60_000) return;
    warnedAt = t;
    o.log?.warn("product_event.not_sent", {
      reason,
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(dropped ? { count: dropped } : {}),
    });
  };

  const capture = (distinctId: string, e: ServerProductEvent) => {
    if (inFlight.size >= maxInFlight) {
      dropped++;
      warn("too_many_in_flight");
      return;
    }
    const body = JSON.stringify({
      api_key: o.token,
      event: e.event,
      distinct_id: distinctId,
      timestamp: new Date(now()).toISOString(),
      properties: { ...e.properties, $geoip_disable: true, $lib: "glideworth-server" },
    });
    const p: Promise<void> = Promise.resolve()
      .then(() =>
        send(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        }),
      )
      .then(
        (res) => {
          if (!res.ok) warn("http_error", res.status);
        },
        () => warn("network_error"),
      )
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  };

  return {
    capture(distinctId, e) {
      try {
        capture(distinctId, e);
      } catch {
        // Analytics never breaks billing.
      }
    },
    async flush(waitMs = 5_000) {
      if (!inFlight.size) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise<void>((r) => {
          timer = setTimeout(r, waitMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    },
  };
}
