/**
 * The public demo's framing: the banner every demo page shows, the sign-up link (with its analytics
 * event), and the page that stands in for an account-only feature. See lib/demo.ts for how the demo works.
 */
import { usePostHog } from "@posthog/react";
import { Link, type RouteComponent, useRouterState } from "@tanstack/react-router";
import { ArrowRight, FlaskConical, Lock, RotateCcw } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { buttonVariants } from "../../components/ui/button";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { cn } from "../../lib/cn";
import { claimDemoStart, hasDemoEdits, isDemo, resetDemo, SIGNUP_PATH } from "../../lib/demo";

/** Where a sign-up link sits, sent with `demo_signup_clicked`. */
type Placement = "banner" | "account_only" | "share";

/**
 * A link to the hosted sign-up page. A full page load, not a router link: sign-up is outside the demo's
 * base path, and leaving the demo page also drops its network guard and demo state.
 */
export function DemoSignUpLink({
  placement,
  className,
  children,
}: {
  placement: Placement;
  className?: string;
  children: ReactNode;
}) {
  const posthog = usePostHog();
  return (
    <a
      href={SIGNUP_PATH}
      className={className}
      onClick={() => posthog?.capture("demo_signup_clicked", { placement })}
    >
      {children}
    </a>
  );
}

/** Sends `demo_started` once per browser tab, when the demo first renders. */
function useDemoStarted() {
  const posthog = usePostHog();
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    if (!claimDemoStart()) return;
    posthog?.capture("demo_started", { entry_path: path, has_saved_edits: hasDemoEdits() });
    // Only the page the visitor arrived on counts.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [posthog]);
}

async function confirmReset() {
  const ok = await confirmAction({
    title: "Reset the demo?",
    description:
      "Your changes to the sample household and its plans are removed from this browser, and the demo starts again.",
    confirmLabel: "Reset demo",
  });
  if (ok) resetDemo();
}

/**
 * The persistent strip above the top bar on every demo page: what this is, the way to a real account, and
 * "Reset demo". Edits in the demo stay in this browser.
 */
export function DemoBanner() {
  useDemoStarted();
  return (
    <div
      data-app-chrome
      data-demo-banner
      role="region"
      aria-label="Demo"
      className="flex shrink-0 items-center gap-x-3 gap-y-1 border-b border-accent/30 bg-accent-soft px-3 py-1.5 text-[12.5px] text-ink sm:px-5"
    >
      <FlaskConical className="size-4 shrink-0 text-accent" aria-hidden />
      <p className="min-w-0 flex-1 leading-snug text-pretty">
        <span className="hidden sm:inline">This is a demo with a sample household. </span>
        <span className="sm:hidden">A demo with a sample household. </span>
        <DemoSignUpLink
          placement="banner"
          className="font-semibold text-accent underline underline-offset-2 hover:text-accent-hover"
        >
          Start your free 14-day trial (no card)
        </DemoSignUpLink>
        <span className="hidden sm:inline"> to plan with your own numbers.</span>
      </p>
      <button
        type="button"
        onClick={() => void confirmReset()}
        className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-medium text-ink-2 hover:bg-black/5 hover:text-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center"
        aria-label="Reset demo"
      >
        <RotateCcw className="size-3.5" aria-hidden />
        <span className="hidden sm:inline">Reset demo</span>
      </button>
    </div>
  );
}

/** Stands in for a page the demo cannot offer: it needs an account (importing data, onboarding, links). */
export function DemoAccountOnly({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col items-center gap-3 px-4 py-12 text-center sm:py-16">
      <div className="flex size-10 items-center justify-center rounded-full border border-dashed border-border-strong text-ink-3">
        <Lock className="size-4" aria-hidden />
      </div>
      <h1 className="display text-[22px] leading-tight font-semibold text-balance outline-none">
        {title}
      </h1>
      <p className="text-[13.5px] leading-relaxed text-pretty text-ink-2">
        {children ??
          "The demo runs on a sample household and saves nothing to a server. Start a free trial to use it with your own numbers."}
      </p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <DemoSignUpLink
          placement="account_only"
          className={cn(buttonVariants({ variant: "primary", size: "lg" }))}
        >
          Start your free 14-day trial <ArrowRight aria-hidden />
        </DemoSignUpLink>
        <Link to="/" className={cn(buttonVariants({ variant: "secondary", size: "lg" }))}>
          Back to the demo
        </Link>
      </div>
      <p className="text-[12px] text-ink-3">No card needed.</p>
    </div>
  );
}

/**
 * A route component that shows `DemoAccountOnly` on a demo page and the real page everywhere else. It
 * keeps a lazy page's `preload`, so the router still loads that chunk before rendering (never in the demo).
 */
export function notInDemo(Page: RouteComponent, title: string, why?: string): RouteComponent {
  function DemoRouteGate() {
    return isDemo() ? <DemoAccountOnly title={title}>{why}</DemoAccountOnly> : <Page />;
  }
  DemoRouteGate.preload = async () => {
    if (!isDemo()) await Page.preload?.();
  };
  return DemoRouteGate;
}
