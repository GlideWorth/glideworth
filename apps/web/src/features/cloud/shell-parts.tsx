/**
 * The hosted-mode parts of the app shell, in one lazy chunk (fetched only after the server announces
 * `cloud`): the trial and read-only banners, the workspace switcher, the subscribe page, the
 * suspended-workspace page and the re-authentication prompt.
 */
import { usePostHog } from "@posthog/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleAlert, Clock, CreditCard, Loader2, Lock, LogOut } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/select";
import { toast } from "../../components/ui/toaster";
import { isExplainedProblem } from "../../lib/api-problems";
import { useCloudSession } from "../../lib/auth";
import { cn } from "../../lib/cn";
import { useState } from "react";
import { bannerFor, billingView } from "./billing-state";
import { cloudApi } from "./client";
import { SUPPORT_EMAIL } from "./legal";
import { ReauthHost } from "./reauth-dialog";
import { describeError, FormAlert, isCode } from "./ui";
import { fmtPrice } from "./format";
import { goToStripe } from "./settings/billing-section";
import { Loading, LoadError } from "./settings-kit";
import { nav } from "./next";

const TONE = {
  info: "border-accent/30 bg-accent-soft text-accent",
  warning: "border-ochre/30 bg-ochre-soft text-ochre",
  danger: "border-negative/30 bg-negative-soft text-negative",
} as const;

/** Trial countdown, payment problem, or read-only notice at the top of the page. Also hosts the re-auth prompt. */
export function CloudBanners() {
  const cloud = useCloudSession();
  const ws = cloud?.workspace;
  const banner = ws ? bannerFor(ws.access, ws.trialEndsAt, ws.role === "owner") : null;
  return (
    <>
      <ReauthHost />
      {cloud && !ws ? <NoWorkspaceBanner /> : null}
      {banner ? (
        <div
          data-app-chrome
          role={banner.tone === "danger" ? "alert" : "status"}
          className={cn(
            "flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-4 py-2 text-[12.5px] sm:px-6",
            TONE[banner.tone],
          )}
        >
          {banner.tone === "info" ? (
            <Clock className="size-4 shrink-0" aria-hidden />
          ) : banner.tone === "warning" ? (
            <CircleAlert className="size-4 shrink-0" aria-hidden />
          ) : (
            <Lock className="size-4 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 flex-1 font-medium">{banner.text}</span>
          {banner.cta ? (
            <Link
              to="/settings/$section"
              params={{ section: "billing" }}
              className="shrink-0 rounded-md px-2 py-1 font-semibold underline underline-offset-2 hover:bg-black/5"
            >
              {banner.cta}
            </Link>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * Signed in but in no workspace: an invitee who has not accepted yet, a removed member, or someone who deleted
 * their workspace. Nothing the planner shows is saved anywhere, so say so and offer the way in.
 */
function NoWorkspaceBanner() {
  const cloud = useCloudSession();
  const qc = useQueryClient();
  const other = cloud?.workspaces[0];
  const go = useMutation({
    mutationFn: () =>
      other ? cloudApi.activateWorkspace(other.id) : cloudApi.createWorkspace(MY_WORKSPACE),
    onSuccess: () => {
      qc.clear();
      nav.go("/");
    },
    onError: (e) =>
      isExplainedProblem(e) ||
      toast({
        title: other ? "Could not open the workspace" : "Could not create the workspace",
        description: describeError(e),
        tone: "negative",
      }),
  });
  return (
    <div
      data-app-chrome
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-4 py-2 text-[12.5px] sm:px-6",
        TONE.warning,
      )}
    >
      <CircleAlert className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 font-medium">
        {other
          ? "No workspace is open, so nothing here is saved."
          : "You are not in a workspace yet, so nothing here is saved. If someone invited you, open the link in their invitation email to join them."}
      </span>
      <button
        type="button"
        disabled={go.isPending}
        onClick={() => go.mutate()}
        className="shrink-0 rounded-md px-2 py-1 font-semibold underline underline-offset-2 hover:bg-black/5 disabled:opacity-60"
      >
        {other ? `Open “${other.name || "Workspace"}”` : "Create my own workspace"}
      </button>
    </div>
  );
}

const MY_WORKSPACE = "My workspace";

/** Only shown to people who belong to more than one workspace. */
export function WorkspaceSwitcher({ className }: { className?: string }) {
  const cloud = useCloudSession();
  const qc = useQueryClient();
  const activate = useMutation({
    mutationFn: (id: string) => cloudApi.activateWorkspace(id),
    onSuccess: () => {
      qc.clear();
      nav.go("/");
    },
    onError: (e) =>
      isExplainedProblem(e) ||
      toast({
        title: "Could not switch workspace",
        description: describeError(e),
        tone: "negative",
      }),
  });
  if (!cloud || cloud.workspaces.length < 2 || !cloud.workspace) return null;
  // The caller's classes (width, and display per breakpoint such as `hidden md:block`) go on a wrapper: on the
  // trigger itself a `block` would replace its `flex` and push the chevron onto a second line.
  return (
    <div className={className}>
      <Select
        className="w-full"
        aria-label="Workspace"
        value={cloud.workspace.id}
        onValueChange={(id) => id !== cloud.workspace?.id && activate.mutate(id)}
        options={cloud.workspaces.map((w) => ({
          value: w.id,
          label: w.name || "Workspace",
          hint: w.role === "owner" ? "You own it" : w.role === "editor" ? "Editor" : "Viewer",
        }))}
      />
    </div>
  );
}

/** A suspended workspace: nothing to show but how to get help; the owner can still export or delete. */
export function SuspendedPage() {
  const ws = useCloudSession()?.workspace;
  const owner = ws?.role === "owner";
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-20 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-negative-soft text-negative">
        <Lock className="size-5" aria-hidden />
      </div>
      <h1 className="display text-[26px] font-semibold" tabIndex={-1}>
        This workspace is suspended
      </h1>
      <p className="text-[13.5px] leading-relaxed text-ink-2">
        {ws?.name ? `“${ws.name}” has` : "This workspace has"} been suspended, so its plans cannot
        be opened for now. Nothing has been deleted. Write to{" "}
        <a className="text-accent underline underline-offset-2" href={`mailto:${SUPPORT_EMAIL}`}>
          {SUPPORT_EMAIL}
        </a>{" "}
        to find out why and what to do next.
      </p>
      <div className="flex flex-wrap justify-center gap-2 text-[13px]">
        {owner ? (
          <Link
            to="/settings/$section"
            params={{ section: "workspace" }}
            className="rounded-md border border-border bg-surface px-3 py-1.5 font-medium shadow-card hover:bg-surface-2"
          >
            Export or delete the workspace
          </Link>
        ) : null}
        <Link
          to="/settings/$section"
          params={{ section: "account" }}
          className="rounded-md border border-border bg-surface px-3 py-1.5 font-medium shadow-card hover:bg-surface-2"
        >
          Account settings
        </Link>
      </div>
    </div>
  );
}

/**
 * A workspace with no subscription record at all (`no_subscription`; a new workspace starts the no-card trial, and
 * one whose owner already had a trial is read-only `trial_expired`, so this is rare): the whole screen until the
 * owner subscribes in Stripe Checkout. Settings stay reachable through the navigation (account, sign out, deletion),
 * and invitations through their links.
 */
export function SubscribePage() {
  const ws = useCloudSession()?.workspace;
  const qc = useQueryClient();
  const billing = useQuery({
    queryKey: ["cloud", "billing"],
    queryFn: cloudApi.billing,
    retry: false,
  });
  const [error, setError] = useState<string | null>(null);
  const posthog = usePostHog();
  const checkout = useMutation({
    mutationFn: (lookupKey: string) => cloudApi.checkout(lookupKey),
    onMutate: () => setError(null),
    onSuccess: (r, lookupKey) => {
      if (goToStripe(r.url)) {
        const interval = billing.data?.offered?.find((o) => o.lookupKey === lookupKey)?.interval;
        posthog?.capture("billing_checkout_started", {
          ...(interval ? { billing_interval: interval } : {}),
        });
      } else setError("Checkout sent an address we did not recognise.");
    },
    onError: (e) => {
      if (isCode(e, "ALREADY_SUBSCRIBED") || isCode(e, "CHECKOUT_IN_PROGRESS")) {
        setError(
          "A subscription for this workspace is being set up. Refresh the page in a minute.",
        );
        void qc.invalidateQueries({ queryKey: ["session"] });
      } else setError(describeError(e));
    },
  });
  const signOut = useMutation({
    mutationFn: () => cloudApi.signOut().catch(() => undefined),
    onSettled: () => {
      qc.clear();
      window.location.replace("/");
    },
  });

  if (billing.isLoading) return <Loading what="billing" />;
  if (billing.isError || !billing.data)
    return (
      <LoadError error={billing.error} what="Billing" onRetry={() => void billing.refetch()} />
    );
  const b = billing.data;
  const view = billingView(b, new Date(), navigator.language);
  const owner = b.role === "owner";
  const offered = [...(b.offered ?? [])].sort(
    (x, y) => (x.interval === "month" ? -1 : 1) - (y.interval === "month" ? -1 : 1),
  );
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-16 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent">
        <CreditCard className="size-5" aria-hidden />
      </div>
      <h1 className="display text-[26px] font-semibold" tabIndex={-1}>
        {view.headline}
      </h1>
      {ws?.name && !owner ? <p className="text-[13px] text-ink-3">{ws.name}</p> : null}
      {view.body.map((p) => (
        <p key={p} className="text-[13.5px] leading-relaxed text-ink-2">
          {p}
        </p>
      ))}
      {error ? <FormAlert>{error}</FormAlert> : null}
      {owner ? (
        <div className="flex flex-wrap justify-center gap-2">
          {offered.map((o) => {
            const yearly = o.interval === "year";
            const price = `${fmtPrice(o.unitAmount, o.currency, navigator.language)} a ${yearly ? "year" : "month"}`;
            return (
              <Button
                key={o.lookupKey}
                variant={yearly ? "secondary" : "primary"}
                disabled={checkout.isPending}
                onClick={() => checkout.mutate(o.lookupKey)}
              >
                {checkout.isPending && checkout.variables === o.lookupKey ? (
                  <Loader2 className="animate-spin" />
                ) : null}
                {`Subscribe, ${price}`}
              </Button>
            );
          })}
        </div>
      ) : null}
      {owner ? (
        <p className="text-[11.5px] text-ink-3">
          You enter your card on Stripe&rsquo;s secure page; Glideworth never sees it. Any tax that
          applies is shown there before you confirm.
        </p>
      ) : null}
      <div className="flex flex-wrap justify-center gap-2 text-[13px]">
        <Link
          to="/settings/$section"
          params={{ section: "account" }}
          className="rounded-md border border-border bg-surface px-3 py-1.5 font-medium shadow-card hover:bg-surface-2"
        >
          Account settings
        </Link>
        <button
          type="button"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 font-medium shadow-card hover:bg-surface-2 disabled:opacity-60"
        >
          <LogOut className="size-4" aria-hidden /> Sign out
        </button>
      </div>
    </div>
  );
}
