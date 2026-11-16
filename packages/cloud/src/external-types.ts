/**
 * Types this package uses from `@glideworth/email` and `@glideworth/billing` (spec 8.1, 8.2), re-exported in one
 * place. They were structural copies while the three packages were written in parallel; the copies matched the
 * real declarations exactly and are now replaced by them.
 */
import type { BillingService as BillingServiceClass } from "@glideworth/billing";

export type {
  Access,
  AccessReason,
  BillingNotice,
  BillingStore,
  PlanLimits,
  SubscriptionRecord,
  SubscriptionStatus,
} from "@glideworth/billing";
export type {
  Address,
  CheckinChangeKind,
  EmailCategory,
  EmailLogStore,
  Mailer,
  SecurityChange,
  SendOptions,
  SendOutcome,
  SuppressionReason,
  SuppressionStore,
  TemplateData,
  TemplateId,
  UnsubscribeSigner,
} from "@glideworth/email";

/**
 * The part of the `BillingService` class (8.2) `WorkspacesService` calls; tests pass a stub with only `status`.
 * `cancelNow` (workspace deletion) is optional so such stubs stay valid.
 */
export type BillingService = Pick<BillingServiceClass, "status"> &
  Partial<Pick<BillingServiceClass, "cancelNow">>;
