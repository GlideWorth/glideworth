import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import { AppShell } from "./components/layout/app-shell";
import { Analytics, reportError } from "./lib/analytics";
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
  SetPasswordPage,
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
import { notInDemo } from "./features/demo/demo-ui";
import { DEMO_BASE, isDemo } from "./lib/demo";

/**
 * Code-based route tree. Each feature workstream owns its page module under src/features/<area>;
 * only this file maps paths to pages (append-only edits to avoid conflicts).
 */
function RootComponent() {
  return (
    <Analytics fallback={RouteError}>
      <AppShell />
    </Analytics>
  );
}

const root = createRootRoute({ component: RootComponent });
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
// The public demo (lib/demo.ts) has no account: these pages create or share real data, so it offers sign-up.
const SETUP_IN_DEMO = "Setting up your own household is part of your account";
const routeWelcome = createRoute({
  getParentRoute: () => root,
  path: "/welcome",
  component: notInDemo(WelcomePage, SETUP_IN_DEMO),
});
const routeSetup = createRoute({
  getParentRoute: () => root,
  path: "/welcome/setup",
  component: notInDemo(SetupPage, SETUP_IN_DEMO),
});
const routeImport = createRoute({
  getParentRoute: () => root,
  path: "/import",
  component: notInDemo(
    ImportPage,
    "Import and export are part of your account",
    "Bring in a ProjectionLab export, a spreadsheet or a Glideworth backup, and export your plans, once you have an account. The demo runs on a sample household and saves nothing to a server.",
  ),
  validateSearch: (s: Record<string, unknown>): { tab?: string } =>
    typeof s.tab === "string" ? { tab: s.tab } : {},
});

// Public, signed-out pages: a shared plan (`/share/<token>`) and accepting an invite or reset.
// The app shell renders these bare: no navigation, no sign-in, no workspace.
const routeShared = createRoute({
  getParentRoute: () => root,
  path: "/share/$token",
  component: notInDemo(SharedPlanPage, "Shared plans open outside the demo"),
});
const routeAccept = createRoute({
  getParentRoute: () => root,
  path: "/accept",
  component: notInDemo(selfHostOnly(AcceptPage), "Invitations open outside the demo"),
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
// A first password for an account that signed up with Google (the emailed link from "Confirm it is you").
const routeSetPassword = createRoute({
  getParentRoute: () => root,
  path: "/set-password",
  component: cloudOnly(SetPasswordPage),
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

// Spellings people type or link to for the two auth pages. Each sends the browser on to the real page,
// keeping the query (an invitation's `next`, `?deleted=1`) and hash, and replacing the alias in history.
// Without these, a signed-out visitor on an unknown path is sent to sign-in, so `/sign-up` showed sign-in.
const alias = (path: string, to: "/signup" | "/signin") =>
  createRoute({
    getParentRoute: () => root,
    path,
    beforeLoad: ({ location }) => {
      throw redirect({
        to,
        search: location.search as Record<string, unknown>,
        hash: location.hash,
        replace: true,
      });
    },
  });
const authAliases = [
  alias("/sign-up", "/signup"),
  alias("/register", "/signup"),
  alias("/sign-in", "/signin"),
  alias("/login", "/signin"),
];

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
  routeSetPassword,
  routeInvite,
  routeConfirmEmail,
  routeGoogleSignUp,
  routeGoogleExists,
  routeGoogleLink,
  ...authAliases,
]);

/**
 * The app's router. `history` is only given by tests (a memory history); the app uses the browser's.
 * The public demo runs the same pages under `/demo` (lib/demo.ts): links and paths inside the app stay
 * `/results`, `/plans/...`, and the URL bar shows `/demo/results`.
 */
export const createAppRouter = (history?: RouterHistory) =>
  createRouter({
    routeTree,
    ...(history ? { history } : {}),
    ...(isDemo() ? { basepath: DEMO_BASE } : {}),
    defaultPreload: "intent",
    // (i) route-level error boundary, 404 and loading skeleton, rendered inside the app shell.
    defaultErrorComponent: RouteError,
    // That boundary catches a page's errors before PostHog's (lib/analytics), so report them from here.
    defaultOnCatch: reportError,
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
