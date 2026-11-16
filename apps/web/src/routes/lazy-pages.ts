/**
 * Route-level code splitting: every page below is its own chunk, fetched on first visit (and
 * preloaded on link hover via `defaultPreload: 'intent'`). Keeps the initial bundle to the shell.
 */
import { lazyRouteComponent } from "@tanstack/react-router";

export const FinancesPage = lazyRouteComponent(
  () => import("../features/finances/finances-page"),
  "FinancesPage",
);
export const PlansPage = lazyRouteComponent(
  () => import("../features/plans/plans-page"),
  "PlansPage",
);
export const PlanEditorPage = lazyRouteComponent(
  () => import("../features/plan-editor/plan-editor-page"),
  "PlanEditorPage",
);
export const SettingsPage = lazyRouteComponent(
  () => import("../features/settings/settings-page"),
  "SettingsPage",
);
export const WelcomePage = lazyRouteComponent(
  () => import("../features/onboarding/welcome-page"),
  "WelcomePage",
);
export const SetupPage = lazyRouteComponent(
  () => import("../features/onboarding/setup-page"),
  "SetupPage",
);
export const ImportPage = lazyRouteComponent(
  () => import("../features/import/import-page"),
  "ImportPage",
);
export const SharedPlanPage = lazyRouteComponent(
  () => import("../features/share/shared-plan-page"),
  "SharedPlanPage",
);
export const AcceptPage = lazyRouteComponent(
  () => import("../features/share/accept-page"),
  "AcceptPage",
);

// Hosted ("cloud") mode: sign-up through invitations. Each is gated by `cloudOnly` in router.tsx, so a
// self-host server never fetches (or renders) any of them.
export const SignUpPage = lazyRouteComponent(
  () => import("../features/cloud/screens/signup"),
  "SignUpPage",
);
export const CheckEmailPage = lazyRouteComponent(
  () => import("../features/cloud/screens/signup"),
  "CheckEmailPage",
);
export const SignInPage = lazyRouteComponent(
  () => import("../features/cloud/screens/signin"),
  "SignInPage",
);
export const TwoFactorPage = lazyRouteComponent(
  () => import("../features/cloud/screens/signin"),
  "TwoFactorPage",
);
export const GoogleSignUpPage = lazyRouteComponent(
  () => import("../features/cloud/screens/google"),
  "GoogleSignUpPage",
);
export const GoogleExistsPage = lazyRouteComponent(
  () => import("../features/cloud/screens/google"),
  "GoogleExistsPage",
);
export const ForgotPasswordPage = lazyRouteComponent(
  () => import("../features/cloud/screens/password-reset"),
  "ForgotPasswordPage",
);
export const ResetPasswordPage = lazyRouteComponent(
  () => import("../features/cloud/screens/password-reset"),
  "ResetPasswordPage",
);
export const VerifyEmailPage = lazyRouteComponent(
  () => import("../features/cloud/screens/link-pages"),
  "VerifyEmailPage",
);
export const ConfirmEmailPage = lazyRouteComponent(
  () => import("../features/cloud/screens/link-pages"),
  "ConfirmEmailPage",
);
export const InvitePage = lazyRouteComponent(
  () => import("../features/cloud/screens/link-pages"),
  "InvitePage",
);
