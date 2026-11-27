/**
 * `essential`: needed to run an account, no unsubscribe. `checkin`: scheduled check-in summaries. `requested`: a
 * one-off message a person asked for on a public form (a calculator result); nothing to unsubscribe from, and it is
 * still blocked by a bounce or complaint. `marketing`: list mail to people who opted in and confirmed (double
 * opt-in); always carries a one-click unsubscribe.
 */
export type EmailCategory = "essential" | "checkin" | "requested" | "marketing";
/** The categories a person can unsubscribe from (signed one-click links, `List-Unsubscribe`). */
export const UNSUBSCRIBABLE_CATEGORIES: ReadonlySet<EmailCategory> = new Set<EmailCategory>([
  "checkin",
  "marketing",
]);
export interface Address {
  email: string;
  name?: string;
}
export type TemplateId =
  | "verify-email"
  | "signup-existing-account"
  | "password-reset"
  | "password-setup"
  | "email-change-confirm"
  | "email-change-requested"
  | "signin-alert"
  | "security-change"
  | "second-factor-failures"
  | "invitation"
  | "member-removed"
  | "trial-ending"
  | "trial-expired"
  | "renewal-reminder"
  | "payment-receipt"
  | "payment-problem"
  | "subscription-canceled"
  | "checkin-summary"
  | "export-ready"
  | "deletion-warning"
  | "account-deleted"
  | "user-account-deleted"
  | "calculator-result";
export type SecurityChange =
  | "password-changed"
  | "password-reset"
  /** A first password set from the emailed link (an account that signed up with Google). */
  | "password-set"
  /** Sent to the old address once the change (to `newEmail`) is confirmed. */
  | "email-changed"
  | "totp-enabled"
  | "totp-disabled"
  | "recovery-codes-regenerated"
  | "recovery-code-used"
  | "api-key-created"
  | "mcp-app-connected"
  | "ownership-transferred"
  | "support-access-used";
export type CheckinChangeKind =
  | "success-rate-change"
  | "milestone-slipped"
  | "audit-finding"
  | "behind-plan";
export interface TemplateData {
  "verify-email": { name: string; url: string; expiresInHours: number };
  "signup-existing-account": { signInUrl: string; resetUrl: string };
  "password-reset": { name: string; url: string; expiresInMinutes: number };
  /** A signed-in person with no password yet (signed up with Google) asked for a link to set one. */
  "password-setup": { name: string; url: string; expiresInMinutes: number };
  "email-change-confirm": { name: string; url: string; newEmail: string; expiresInHours: number };
  /** Sent to the current address when a change to `newEmail` is requested; nothing has changed yet. */
  "email-change-requested": {
    name: string;
    newEmail: string;
    at: string;
    expiresInHours: number;
    securityUrl: string;
  };
  "signin-alert": { name: string; at: string; device: string; ip: string; sessionsUrl: string };
  "security-change": {
    name: string;
    change: SecurityChange;
    at: string;
    securityUrl: string;
    /** For `email-changed`: the new address, named in the notice. */
    newEmail?: string;
  };
  /** Review finding 8: 10 wrong two-step codes in a row. Sent at most once a day per account. */
  "second-factor-failures": { name: string; at: string; resetUrl: string; securityUrl: string };
  invitation: {
    inviterName: string;
    workspaceName: string;
    role: "editor" | "viewer";
    url: string;
    expiresInDays: number;
  };
  /** To a person the owner removed from a workspace. Names the workspace only; nothing from inside it. */
  "member-removed": { name: string; workspaceName: string };
  /**
   * A few days before the free trial ends. `amountText` null: the no-card trial, which ends in read-only.
   * Otherwise the owner subscribed during the trial and the card is charged that amount when it ends.
   */
  "trial-ending": {
    name: string;
    trialEndsOn: string;
    amountText: string | null;
    billingUrl: string;
  };
  /** The day after a no-card trial ended without a subscription: the workspace is read-only, nothing deleted. */
  "trial-expired": { name: string; billingUrl: string };
  /** Annual renewals only. No amount: the date and a link to the billing page. */
  "renewal-reminder": { name: string; renewsOn: string; billingUrl: string };
  "payment-receipt": { name: string; amountText: string; invoiceUrl: string };
  "payment-problem": { name: string; portalUrl: string; readOnlyFrom: string };
  "subscription-canceled": { name: string; accessUntil: string; billingUrl: string };
  "checkin-summary": {
    name: string;
    plansChecked: number;
    changeKinds: CheckinChangeKind[];
    url: string;
  };
  "export-ready": { name: string; url: string; expiresAt: string };
  /** Sent 30 and 7 days before a lapsed workspace is deleted. */
  "deletion-warning": {
    name: string;
    workspaceName: string;
    deletesOn: string;
    daysLeft: number;
    billingUrl: string;
    exportUrl: string;
  };
  "account-deleted": {
    name: string;
    workspaceName: string;
    deletedAt: string;
    backupsPurgedBy: string;
  };
  /** The person deleted their own account (sign-in, sessions, security settings). Sent to its address. */
  "user-account-deleted": { name: string; deletedAt: string };
  /**
   * A free calculator's result, sent because the visitor asked for it on the marketing site. Every string comes
   * from the server's own calculator catalog or is a number the server formatted or checked against the shapes
   * the calculator can produce (packages/cloud/src/marketing): nothing typed by the visitor is echoed.
   */
  "calculator-result": {
    toolName: string;
    /** Label and formatted value of each input the result used. */
    inputs: [string, string][];
    /** Label and value of each headline figure (may be empty). */
    figures: [string, string][];
    /** Reopens the calculator with the same inputs. */
    reopenUrl: string;
    demoUrl: string | null;
    trialUrl: string | null;
    /** Present when the visitor ticked the reminder box and has not confirmed yet: the double opt-in link. */
    confirmUrl: string | null;
    confirmExpiresInDays: number;
    /** The visitor ticked the box but this address already confirmed: say so instead of a link. */
    alreadySubscribed: boolean;
  };
}
export const TEMPLATE_CATEGORY: Readonly<Record<TemplateId, EmailCategory>> = Object.freeze({
  "verify-email": "essential",
  "signup-existing-account": "essential",
  "password-reset": "essential",
  "password-setup": "essential",
  "email-change-confirm": "essential",
  "email-change-requested": "essential",
  "signin-alert": "essential",
  "security-change": "essential",
  "second-factor-failures": "essential",
  invitation: "essential",
  "member-removed": "essential",
  "trial-ending": "essential",
  "trial-expired": "essential",
  "renewal-reminder": "essential",
  "payment-receipt": "essential",
  "payment-problem": "essential",
  "subscription-canceled": "essential",
  "checkin-summary": "checkin",
  "export-ready": "essential",
  "deletion-warning": "essential",
  "account-deleted": "essential",
  "user-account-deleted": "essential",
  "calculator-result": "requested",
});
export const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATE_CATEGORY) as TemplateId[]);

export interface RenderContext {
  productName: string;
  appUrl: string;
  supportEmail: string;
  unsubscribeUrl?: string;
}
export interface Rendered {
  subject: string;
  text: string;
  html: string;
  category: EmailCategory;
}

export interface OutgoingEmail {
  to: Address;
  from: Address;
  replyTo?: Address;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  category: EmailCategory;
  template: TemplateId;
  idempotencyKey?: string;
}
export interface TransportResult {
  providerMessageId: string | null;
}
export interface EmailTransport {
  readonly name: string;
  send(msg: OutgoingEmail): Promise<TransportResult>;
}
export class EmailTransportError extends Error {
  constructor(
    readonly transport: string,
    readonly code: string,
    readonly retryable: boolean,
    message: string,
    /** The provider asked us to wait this long before trying again (rate limits). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EmailTransportError";
  }
}
export interface StoredEmail {
  id: string;
  at: string;
  message: OutgoingEmail;
  links: string[];
}

export type SuppressionReason = "unsubscribe" | "bounce" | "complaint";
export interface SuppressionStore {
  isSuppressed(emailNormalized: string, category: EmailCategory): boolean;
  suppress(
    emailNormalized: string,
    category: EmailCategory | "all",
    reason: SuppressionReason,
  ): void;
}
/** Optional extension: lets the mailer report the real reason in `SendOutcome`. */
export interface SuppressionReasonLookup {
  reasonFor(emailNormalized: string, category: EmailCategory): SuppressionReason | null;
}
export interface EmailLogStore {
  record(e: {
    userId: string | null;
    template: TemplateId;
    category: EmailCategory;
    status: "sent" | "suppressed" | "failed";
    providerMessageId: string | null;
  }): void;
}
export interface UnsubscribeSigner {
  url(emailNormalized: string, category: EmailCategory): string;
  verify(token: string): { email: string; category: EmailCategory } | null;
}
export type SendOutcome =
  | { status: "sent"; providerMessageId: string | null }
  | { status: "suppressed"; reason: SuppressionReason }
  | { status: "failed"; code: string };
export interface SendOptions {
  userId?: string;
  idempotencyKey?: string;
}
export interface Mailer {
  send<T extends TemplateId>(
    to: Address,
    id: T,
    data: TemplateData[T],
    opts?: SendOptions,
  ): Promise<SendOutcome>;
}
