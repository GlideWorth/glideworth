import type { TemplateId } from "./types.js";

/**
 * Subjects are constant strings. Nothing is interpolated: names, workspace names and plan names are free
 * text and may contain amounts (spec 5.3). Templates never see or set the subject; `compose` reads it here.
 */
export const SUBJECTS: Readonly<Record<TemplateId, string>> = Object.freeze({
  "verify-email": "Confirm your email address for Glideworth",
  "signup-existing-account": "You already have a Glideworth account",
  "password-reset": "Reset your Glideworth password",
  "email-change-confirm": "Confirm your new email address",
  "signin-alert": "New sign-in to your Glideworth account",
  "security-change": "A security setting changed on your Glideworth account",
  invitation: "You have been invited to a Glideworth workspace",
  "trial-ending": "Your Glideworth trial ends soon",
  "trial-expired": "Your Glideworth trial has ended",
  "renewal-reminder": "Your Glideworth subscription renews soon",
  "payment-receipt": "Your Glideworth receipt",
  "payment-problem": "Action needed: your Glideworth payment did not go through",
  "subscription-canceled": "Your Glideworth subscription is cancelled",
  "checkin-summary": "Your scheduled Glideworth check-in is ready",
  "export-ready": "Your Glideworth export is ready",
  "deletion-warning": "Your Glideworth workspace will be deleted",
  "account-deleted": "Your Glideworth workspace has been deleted",
  "user-account-deleted": "Your Glideworth account has been deleted",
});
