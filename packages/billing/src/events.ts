/** Stripe event types the webhook handles (design 4.3). Everything else is logged as `ignored`. */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "charge.refunded",
  "charge.dispute.created",
  "radar.early_fraud_warning.created",
  "customer.deleted",
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export function isHandledEventType(type: string): type is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Events that count toward the card-testing circuit breaker (design 4.6). Declines inside Checkout do not produce
 * Checkout Session events, so the breaker counts failed invoices and failed asynchronous Checkout payments.
 */
export const DECLINE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "invoice.payment_failed",
  "checkout.session.async_payment_failed",
]);

/** Subscribed on the webhook endpoint: the handled types plus the decline signals above. */
export const WEBHOOK_ENABLED_EVENTS: readonly string[] = [
  ...HANDLED_EVENT_TYPES,
  "checkout.session.async_payment_failed",
];
