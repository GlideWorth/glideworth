import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { AppShell } from "./components/layout/app-shell";
import { NotFound, PagePending, RouteError } from "./components/layout/route-states";
import { DashboardPage } from "./features/dashboard/dashboard-page";
import { InsightsPage } from "./features/insights/insights-page";
import {
  BuilderPage,
  CashFlowPage,
  ChancePage,
  ComparePage,
  EstatePage,
  ProgressPage,
  TaxesPage,
} from "./features/placeholders";
import { ReportsPage } from "./features/reports/reports-page";
import { ResultsPage } from "./features/results/results-page";
// (i) route-level code splitting: these pages load on demand (see routes/lazy-pages.ts).
import {
  AcceptPage,
  CheckEmailPage,
  ConfirmEmailPage,
  FinancesPage,
  ForgotPasswordPage,
  GoogleExistsPage,
  GoogleLinkPage,
  GoogleSignUpPage,
  ImportPage,
  InvitePage,
  PlanEditorPage,
  PlansPage,
  ResetPasswordPage,
  SettingsPage,
  SetupPage,
  SharedPlanPage,
  SignInPage,
  SignUpPage,
  TwoFactorPage,
  VerifyEmailPage,
  WelcomePage,
} from "./routes/lazy-pages";
import { cloudOnly, selfHostOnly } from "./routes/mode-gate";

/**
 * Code-based route tree. Each feature workstream owns its page module under src/features/<area>;
 * only this file maps paths to pages (append-only edits to avoid conflicts).
 */
const root = createRootRoute({ component: AppShell });
const route0 = createRoute({ getParentRoute: () => root, path: "/", component: DashboardPage });
const route1 = createRoute({
  getParentRoute: () => root,
  path: "/finances",
  component: FinancesPage,
});
const route2 = createRoute({ getParentRoute: () => root, path: "/plans", component: PlansPage });
const route3 = createRoute({
  getParentRoute: () => root,
  path: "/plans/$planId",
  component: PlanEditorPage,
});
const route4 = createRoute({
  getParentRoute: () => root,
  path: "/results",
  component: ResultsPage,
});
const route5 = createRoute({ getParentRoute: () => root, path: "/chance", component: ChancePage });
const route6 = createRoute({
  getParentRoute: () => root,
  path: "/cashflow",
  component: CashFlowPage,
});
const route7 = createRoute({ getParentRoute: () => root, path: "/taxes", component: TaxesPage });
const route8 = createRoute({
  getParentRoute: () => root,
  path: "/compare",
  component: ComparePage,
});
const route9 = createRoute({
  getParentRoute: () => root,
  path: "/progress",
  component: ProgressPage,
});
const route10 = createRoute({
  getParentRoute: () => root,
  path: "/settings",
  component: SettingsPage,
});
const routeInsights = createRoute({
  getParentRoute: () => root,
  path: "/insights",
  component: InsightsPage,
});
const routeEstate = createRoute({
  getParentRoute: () => root,
  path: "/estate",
  component: EstatePage,
});
const routeBuilder = createRoute({
  getParentRoute: () => root,
  path: "/builder",
  component: BuilderPage,
});
const routeReports = createRoute({
  getParentRoute: () => root,
  path: "/reports",
  component: ReportsPage,
});
// (i) settings sections, onboarding, import & export centre.
const routeSettingsSection = createRoute({
  getParentRoute: () => root,
  path: "/settings/$section",
  component: SettingsPage,
});
const routeWelcome = createRoute({
  getParentRoute: () => root,
  path: "/welcome",
  component: WelcomePage,
});
const routeSetup = createRoute({
  getParentRoute: () => root,
  path: "/welcome/setup",
  component: SetupPage,
});
const routeImport = createRoute({
  getParentRoute: () => root,
  path: "/import",
  component: ImportPage,
  validateSearch: (s: Record<string, unknown>): { tab?: string } =>
    typeof s.tab === "string" ? { tab: s.tab } : {},
});

// Public, signed-out pages: a shared plan (`/share/<token>`) and accepting an invite or reset.
// The app shell renders these bare: no navigation, no sign-in, no workspace.
const routeShared = createRoute({
  getParentRoute: () => root,
  path: "/share/$token",
  component: SharedPlanPage,
});
const routeAccept = createRoute({
  getParentRoute: () => root,
  path: "/accept",
  component: selfHostOnly(AcceptPage),
  validateSearch: (s: Record<string, unknown>): { token?: string } =>
    typeof s.token === "string" ? { token: s.token } : {},
});

// Hosted ("cloud") mode only: each page is gated by the mode the server announces (routes/mode-gate.tsx)
// and loaded on demand. Settings screens (account, security, billing, members, workspace) are sections of
// /settings/$section.
const routeSignUp = createRoute({
  getParentRoute: () => root,
  path: "/signup",
  component: cloudOnly(SignUpPage),
});
const routeCheckEmail = createRoute({
  getParentRoute: () => root,
  path: "/check-email",
  component: cloudOnly(CheckEmailPage),
});
const routeVerifyEmail = createRoute({
  getParentRoute: () => root,
  path: "/verify-email",
  component: cloudOnly(VerifyEmailPage),
});
const routeSignIn = createRoute({
  getParentRoute: () => root,
  path: "/signin",
  component: cloudOnly(SignInPage),
  validateSearch: (s: Record<string, unknown>): { next?: string; google?: string } => ({
    ...(typeof s.next === "string" ? { next: s.next } : {}),
    ...(typeof s.google === "string" ? { google: s.google } : {}),
  }),
});
const routeTwoFactor = createRoute({
  getParentRoute: () => root,
  path: "/signin/2fa",
  component: cloudOnly(TwoFactorPage),
});
const routeForgot = createRoute({
  getParentRoute: () => root,
  path: "/forgot-password",
  component: cloudOnly(ForgotPasswordPage),
});
const routeReset = createRoute({
  getParentRoute: () => root,
  path: "/reset-password",
  component: cloudOnly(ResetPasswordPage),
});
const routeInvite = createRoute({
  getParentRoute: () => root,
  path: "/invite",
  component: cloudOnly(InvitePage),
});
const routeConfirmEmail = createRoute({
  getParentRoute: () => root,
  path: "/confirm-email",
  component: cloudOnly(ConfirmEmailPage),
});

// "Sign in with Google" (only reached when the server offers it): a new person's sign-up step, and the
// neutral page for an address that already has an account.
const routeGoogleSignUp = createRoute({
  getParentRoute: () => root,
  path: "/signup/google",
  component: cloudOnly(GoogleSignUpPage),
});
const routeGoogleExists = createRoute({
  getParentRoute: () => root,
  path: "/signin/google-exists",
  component: cloudOnly(GoogleExistsPage),
});
// Linking Google from security settings ends here (signed in): the page finishes the link with a POST.
const routeGoogleLink = createRoute({
  getParentRoute: () => root,
  path: "/google-link",
  component: cloudOnly(GoogleLinkPage),
});

const routeTree = root.addChildren([
  route0,
  route1,
  route2,
  route3,
  route4,
  route5,
  route6,
  route7,
  route8,
  route9,
  route10,
  routeInsights,
  routeReports,
  routeEstate,
  routeBuilder,
  routeSettingsSection,
  routeWelcome,
  routeSetup,
  routeImport,
  routeShared,
  routeAccept,
  routeSignUp,
  routeCheckEmail,
  routeVerifyEmail,
  routeSignIn,
  routeTwoFactor,
  routeForgot,
  routeReset,
  routeInvite,
  routeConfirmEmail,
  routeGoogleSignUp,
  routeGoogleExists,
  routeGoogleLink,
]);

/** The app's router. `history` is only given by tests (a memory history); the app uses the browser's. */
export const createAppRouter = (history?: RouterHistory) =>
  createRouter({
    routeTree,
    ...(history ? { history } : {}),
    defaultPreload: "intent",
    // (i) route-level error boundary, 404 and loading skeleton, rendered inside the app shell.
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFound,
    defaultPendingComponent: PagePending,
    defaultPendingMs: 150,
    defaultPendingMinMs: 250,
  });

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
