import type { RenderContext, Rendered, TemplateData, TemplateId } from "../types.js";
import { accountDeleted } from "./account-deleted.js";
import { checkinSummary } from "./checkin-summary.js";
import { deletionWarning } from "./deletion-warning.js";
import { emailChangeConfirm } from "./email-change-confirm.js";
import { emailChangeRequested } from "./email-change-requested.js";
import { exportReady } from "./export-ready.js";
import { invitation } from "./invitation.js";
import { memberRemoved } from "./member-removed.js";
import { passwordReset } from "./password-reset.js";
import { passwordSetup } from "./password-setup.js";
import { paymentProblem } from "./payment-problem.js";
import { paymentReceipt } from "./payment-receipt.js";
import { secondFactorFailures } from "./second-factor-failures.js";
import { securityChange } from "./security-change.js";
import { renewalReminder } from "./renewal-reminder.js";
import { signinAlert } from "./signin-alert.js";
import { signupExistingAccount } from "./signup-existing-account.js";
import { subscriptionCanceled } from "./subscription-canceled.js";
import { trialEnding } from "./trial-ending.js";
import { trialExpired } from "./trial-expired.js";
import { userAccountDeleted } from "./user-account-deleted.js";
import { verifyEmail } from "./verify-email.js";

export type TemplateFn<T extends TemplateId> = (
  data: TemplateData[T],
  ctx: RenderContext,
) => Rendered;

export const TEMPLATES: { readonly [K in TemplateId]: TemplateFn<K> } = {
  "verify-email": verifyEmail,
  "signup-existing-account": signupExistingAccount,
  "password-reset": passwordReset,
  "password-setup": passwordSetup,
  "email-change-confirm": emailChangeConfirm,
  "email-change-requested": emailChangeRequested,
  "signin-alert": signinAlert,
  "security-change": securityChange,
  "second-factor-failures": secondFactorFailures,
  invitation,
  "member-removed": memberRemoved,
  "trial-ending": trialEnding,
  "trial-expired": trialExpired,
  "renewal-reminder": renewalReminder,
  "payment-receipt": paymentReceipt,
  "payment-problem": paymentProblem,
  "subscription-canceled": subscriptionCanceled,
  "checkin-summary": checkinSummary,
  "export-ready": exportReady,
  "deletion-warning": deletionWarning,
  "account-deleted": accountDeleted,
  "user-account-deleted": userAccountDeleted,
};
