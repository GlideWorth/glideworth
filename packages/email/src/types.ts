export type EmailCategory = "essential" | "checkin";
export interface Address {
  email: string;
  name?: string;
}
export type TemplateId =
  | "verify-email"
  | "signup-existing-account"
  | "password-reset"
  | "email-change-confirm"
  | "signin-alert"
  | "security-change"
  | "invitation"
  | "trial-ending"
  | "trial-expired"
  | "renewal-reminder"
  | "payment-receipt"
  | "payment-problem"
  | "subscription-canceled"
  | "checkin-summary"
  | "export-ready"
  | "deletion-warning"
  | "account-deleted";
export type SecurityChange =
  | "password-changed"
  | "password-reset"
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
  "email-change-confirm": { name: string; url: string; newEmail: string; expiresInHours: number };
  "signin-alert": { name: string; at: string; device: string; ip: string; sessionsUrl: string };
  "security-change": { name: string; change: SecurityChange; at: string; securityUrl: string };
  invitation: {
    inviterName: string;
    workspaceName: string;
    role: "editor" | "viewer";
    url: string;
    expiresInDays: number;
  };
  "trial-ending": { name: string; trialEndsOn: string; billingUrl: string };
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
}
export const TEMPLATE_CATEGORY: Readonly<Record<TemplateId, EmailCategory>> = Object.freeze({
  "verify-email": "essential",
  "signup-existing-account": "essential",
  "password-reset": "essential",
  "email-change-confirm": "essential",
  "signin-alert": "essential",
  "security-change": "essential",
  invitation: "essential",
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
