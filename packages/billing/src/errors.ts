/**
 * `FORBIDDEN` is an addition to the code list in the design (section 8.2): it is thrown only when a caller passes
 * the optional `actor` to `createCheckout` and that actor is not a verified owner, or when the owner email passed
 * in does not match the account's owner contact.
 */
export type BillingErrorCode =
  | "CONFIG_INVALID"
  | "UNKNOWN_PRICE"
  | "NOT_OFFERED"
  | "ALREADY_SUBSCRIBED"
  | "NO_CUSTOMER"
  | "NO_SUBSCRIPTION"
  | "SIGNATURE_INVALID"
  | "CHECKOUT_RATE_LIMITED"
  | "CHECKOUT_PAUSED"
  | "STRIPE_UNAVAILABLE"
  | "FORBIDDEN";

export class BillingError extends Error {
  override readonly name = "BillingError";

  constructor(
    readonly code: BillingErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function isBillingError(err: unknown): err is BillingError {
  return err instanceof BillingError;
}

/**
 * A log-safe code for any thrown value: the BillingError code, the Stripe error type/code, or the error name.
 * Never the message, which may contain request data.
 */
export function errorCodeOf(err: unknown): string {
  if (err instanceof BillingError) return err.code;
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; type?: unknown; name?: unknown };
    if (typeof e.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(e.code)) return e.code;
    if (typeof e.type === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(e.type)) return e.type;
    if (typeof e.name === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(e.name)) return e.name;
  }
  return "UNKNOWN";
}
