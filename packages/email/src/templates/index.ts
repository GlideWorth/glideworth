import type { RenderContext, Rendered, TemplateData, TemplateId } from "../types.js";
import { accountDeleted } from "./account-deleted.js";
import { checkinSummary } from "./checkin-summary.js";
import { deletionWarning } from "./deletion-warning.js";
import { emailChangeConfirm } from "./email-change-confirm.js";
import { exportReady } from "./export-ready.js";
import { invitation } from "./invitation.js";
import { passwordReset } from "./password-reset.js";
import { paymentProblem } from "./payment-problem.js";
import { paymentReceipt } from "./payment-receipt.js";
import { securityChange } from "./security-change.js";
import { renewalReminder } from "./renewal-reminder.js";
import { signinAlert } from "./signin-alert.js";
import { signupExistingAccount } from "./signup-existing-account.js";
import { subscriptionCanceled } from "./subscription-canceled.js";
import { trialEnding } from "./trial-ending.js";
import { trialExpired } from "./trial-expired.js";
import { verifyEmail } from "./verify-email.js";

export type TemplateFn<T extends TemplateId> = (
  data: TemplateData[T],
  ctx: RenderContext,
) => Rendered;

export const TEMPLATES: { readonly [K in TemplateId]: TemplateFn<K> } = {
  "verify-email": verifyEmail,
  "signup-existing-account": signupExistingAccount,
  "password-reset": passwordReset,
  "email-change-confirm": emailChangeConfirm,
  "signin-alert": signinAlert,
  "security-change": securityChange,
  invitation,
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
};
