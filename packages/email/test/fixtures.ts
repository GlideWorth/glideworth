import type { RenderContext, TemplateData, TemplateId } from "../src/index.js";

// All data in this file is synthetic.
export const CTX: RenderContext = {
  productName: "Glideworth",
  appUrl: "https://app.example.test",
  supportEmail: "support@example.test",
};

export const CHECKIN_CTX: RenderContext = {
  ...CTX,
  unsubscribeUrl: "https://app.example.test/email/unsubscribe?t=sample-token",
};

const U = (path: string) => `https://app.example.test/${path}?t=sample-token`;

export const FIXTURES: { [K in TemplateId]: TemplateData[K] } = {
  "verify-email": { name: "Sam Example", url: U("verify"), expiresInHours: 24 },
  "signup-existing-account": { signInUrl: U("signin"), resetUrl: U("forgot") },
  "password-reset": { name: "Sam Example", url: U("reset"), expiresInMinutes: 30 },
  "email-change-confirm": {
    name: "Sam Example",
    url: U("confirm-email"),
    newEmail: "sam.new@example.test",
    expiresInHours: 24,
  },
  "signin-alert": {
    name: "Sam Example",
    at: "16 November 2026, 09:14 UTC",
    device: "Firefox on Linux",
    ip: "203.0.113.7",
    sessionsUrl: U("settings/sessions"),
  },
  "security-change": {
    name: "Sam Example",
    change: "password-changed",
    at: "16 November 2026, 09:14 UTC",
    securityUrl: U("settings/security"),
  },
  invitation: {
    inviterName: "Robin Sample",
    workspaceName: "Sample household",
    role: "editor",
    url: U("invitations/accept"),
    expiresInDays: 7,
  },
  "trial-ending": {
    name: "Sam Example",
    trialEndsOn: "23 November 2026",
    billingUrl: U("billing"),
  },
  "trial-expired": { name: "Sam Example", billingUrl: U("billing") },
  "renewal-reminder": {
    name: "Sam Example",
    renewsOn: "30 November 2026",
    billingUrl: U("billing"),
  },
  "payment-receipt": {
    name: "Sam Example",
    amountText: "£8.00",
    invoiceUrl: U("invoices/in_sample"),
  },
  "payment-problem": {
    name: "Sam Example",
    portalUrl: U("billing/portal"),
    readOnlyFrom: "30 November 2026",
  },
  "subscription-canceled": {
    name: "Sam Example",
    accessUntil: "31 December 2026",
    billingUrl: U("billing"),
  },
  "checkin-summary": {
    name: "Sam Example",
    plansChecked: 3,
    changeKinds: ["success-rate-change", "milestone-slipped", "audit-finding", "behind-plan"],
    url: U("checkins/latest"),
  },
  "export-ready": {
    name: "Sam Example",
    url: U("exports/sample"),
    expiresAt: "17 November 2026, 09:14 UTC",
  },
  "deletion-warning": {
    name: "Sam Example",
    workspaceName: "Sample household",
    deletesOn: "16 November 2027",
    daysLeft: 30,
    billingUrl: U("billing"),
    exportUrl: U("settings/workspace"),
  },
  "account-deleted": {
    name: "Sam Example",
    workspaceName: "Sample household",
    deletedAt: "16 November 2026",
    backupsPurgedBy: "16 December 2026",
  },
};

/** Same shape, every free-text and numeric field changed to something loaded with figures. */
export const FIXTURES_ALT: { [K in TemplateId]: TemplateData[K] } = {
  "verify-email": { name: "Alex £48,000 (7.5%)", url: U("verify"), expiresInHours: 72 },
  "signup-existing-account": { signInUrl: U("signin"), resetUrl: U("forgot") },
  "password-reset": { name: "Alex £48,000 (7.5%)", url: U("reset"), expiresInMinutes: 5 },
  "email-change-confirm": {
    name: "Alex £48,000 (7.5%)",
    url: U("confirm-email"),
    newEmail: "alex48000@example.test",
    expiresInHours: 2,
  },
  "signin-alert": {
    name: "Alex £48,000 (7.5%)",
    at: "£1,234,567 at 99%",
    device: "Retire at 55 with £2m",
    ip: "198.51.100.99",
    sessionsUrl: U("settings/sessions"),
  },
  "security-change": {
    name: "Alex £48,000 (7.5%)",
    change: "totp-enabled",
    at: "£1,234,567 at 99%",
    securityUrl: U("settings/security"),
  },
  invitation: {
    inviterName: "Pat £500k",
    workspaceName: "Retire at 55 with £2m (92% chance)",
    role: "viewer",
    url: U("invitations/accept"),
    expiresInDays: 1,
  },
  "trial-ending": {
    name: "Alex £48,000 (7.5%)",
    trialEndsOn: "£99 on 1 January",
    billingUrl: U("billing"),
  },
  "trial-expired": { name: "Alex £48,000 (7.5%)", billingUrl: U("billing") },
  "renewal-reminder": {
    name: "Alex £48,000 (7.5%)",
    renewsOn: "£99 on 1 January",
    billingUrl: U("billing"),
  },
  "payment-receipt": {
    name: "Alex £48,000 (7.5%)",
    amountText: "$1,000.00",
    invoiceUrl: U("invoices/in_other"),
  },
  "payment-problem": {
    name: "Alex £48,000 (7.5%)",
    portalUrl: U("billing/portal"),
    readOnlyFrom: "£5 by Friday",
  },
  "subscription-canceled": {
    name: "Alex £48,000 (7.5%)",
    accessUntil: "£7 until Monday",
    billingUrl: U("billing"),
  },
  "checkin-summary": {
    name: "Alex £48,000 (7.5%)",
    plansChecked: 12,
    changeKinds: ["behind-plan"],
    url: U("checkins/latest"),
  },
  "export-ready": {
    name: "Alex £48,000 (7.5%)",
    url: U("exports/other"),
    expiresAt: "£3 tomorrow",
  },
  "deletion-warning": {
    name: "Alex £48,000 (7.5%)",
    workspaceName: "Retire at 55 with £2m (92% chance)",
    deletesOn: "£1 yesterday",
    daysLeft: 7,
    billingUrl: U("billing"),
    exportUrl: U("settings/workspace"),
  },
  "account-deleted": {
    name: "Alex £48,000 (7.5%)",
    workspaceName: "Retire at 55 with £2m (92% chance)",
    deletedAt: "£1 yesterday",
    backupsPurgedBy: "£2 next week",
  },
};
