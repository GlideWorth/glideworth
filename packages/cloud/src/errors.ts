/**
 * The one error type the cloud package throws for expected failures. `apps/api` maps it (duck-typed) onto
 * its JSON error envelope. Messages are fixed strings: they never contain an email address, token, name or
 * any other value supplied by a user, so they are safe to show to the caller (and still never logged).
 */
export type CloudErrorCode =
  | "VALIDATION"
  | "UNAUTHORIZED"
  | "EMAIL_NOT_VERIFIED"
  /** Not in spec 8.3: a verification link opened in a browser that did not sign up needs the password too. */
  | "PASSWORD_REQUIRED"
  | "TOTP_REQUIRED"
  | "INVALID_TOKEN"
  | "RATE_LIMITED"
  | "CAPTCHA_REQUIRED"
  | "REAUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "SEAT_LIMIT"
  | "DISPOSABLE_EMAIL"
  | "WEAK_PASSWORD"
  | "ACCOUNT_READ_ONLY"
  | "ACCOUNT_SUSPENDED"
  | "QUOTA_EXCEEDED"
  | "STORAGE_QUOTA_EXCEEDED"
  | "TENANT_UNAVAILABLE"
  | "ALREADY_SUBSCRIBED"
  /** Not in spec 8.3: a cookie-authenticated write without a valid CSRF token or from another origin. */
  | "CSRF"
  /** Not in spec 8.3: request body over the route's size limit. */
  | "PAYLOAD_TOO_LARGE"
  /** Not in spec 8.3: a Checkout Session for another price is still open (review finding 2). */
  | "CHECKOUT_IN_PROGRESS"
  /** Not in spec 8.3: an unexpected failure (never carries the underlying message). */
  | "INTERNAL";

export type CloudErrorStatus =
  | 400
  | 401
  | 402
  | 403
  | 404
  | 409
  | 413
  | 422
  | 429
  | 500
  | 503
  | 507;

export class CloudError extends Error {
  constructor(
    readonly status: CloudErrorStatus,
    readonly code: CloudErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CloudError";
  }
}

/** Thrown by the parts of the package that a later work package fills in. */
export class NotImplementedError extends Error {
  constructor(readonly what: string) {
    super(`not implemented: ${what}`);
    this.name = "NotImplementedError";
  }
}

export const notImplemented = (what: string): never => {
  throw new NotImplementedError(what);
};

/**
 * Spec 6.1 storage limit: a tenant handle opened with `max_page_count` (tenantPragmas) fails a write that would
 * grow past the plan's storage with `SQLITE_FULL`; the transaction rolls back and the file stays intact. Hosts
 * map it to 507 with this (also done by `cloudErrorResponse`).
 */
export function storageQuotaError(err: unknown): CloudError | null {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "SQLITE_FULL"
    ? new CloudError(
        507,
        "STORAGE_QUOTA_EXCEEDED",
        "the workspace has reached the storage limit of its plan",
      )
    : null;
}
