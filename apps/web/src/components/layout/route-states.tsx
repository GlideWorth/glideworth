/**
 * Route-level states: a page that crashed, a page that does not exist, and a page still loading.
 * The error view keeps the shell usable (navigation still works) and offers recovery.
 */
import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, Compass, Copy, RotateCcw } from "lucide-react";
import { useState } from "react";
import { notImplementedInfo } from "../charts/states";
import { Button } from "../ui/button";
import { toast } from "../ui/toaster";

export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const [showDetails, setShowDetails] = useState(false);
  const ni = notImplementedInfo(error);
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof Error && error.stack ? error.stack : message;
  return (
    <div
      className="mx-auto flex w-full max-w-xl flex-col items-start gap-4 px-4 py-14 sm:px-6"
      role="alert"
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-negative-soft text-negative">
        <AlertTriangle className="size-5" />
      </div>
      <div>
        <h1 className="display text-[26px] leading-tight font-semibold" tabIndex={-1}>
          {ni ? "This part of Glideworth is not built yet" : "This page hit a problem"}
        </h1>
        <p className="mt-2 text-ink-2">
          {ni ? (
            <>
              It needs <code className="rounded bg-surface-2 px-1 text-[12px]">{ni.feature}</code>,
              which is still on the roadmap. Your data is untouched.
            </>
          ) : (
            <>
              Your data is safe: nothing was changed. You can try again, or go somewhere else from
              the menu.
            </>
          )}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={() => {
            reset();
            void router.invalidate();
          }}
        >
          <RotateCcw /> Try again
        </Button>
        <Button asChild>
          <Link to="/">
            <ArrowLeft /> Dashboard
          </Link>
        </Button>
        <Button
          variant="ghost"
          onClick={() => setShowDetails((v) => !v)}
          aria-expanded={showDetails}
        >
          {showDetails ? "Hide details" : "Show details"}
        </Button>
      </div>
      {showDetails ? (
        <div className="w-full">
          <pre className="max-h-64 w-full overflow-auto rounded-lg border border-border bg-surface-2 p-3 text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
            {details}
          </pre>
          <Button
            size="sm"
            variant="ghost"
            className="mt-1"
            onClick={() => {
              void navigator.clipboard?.writeText(details);
              toast({ title: "Error details copied", duration: 1500 });
            }}
          >
            <Copy /> Copy details
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-start gap-4 px-4 py-16 sm:px-6">
      <div className="flex size-10 items-center justify-center rounded-full border border-dashed border-border-strong text-ink-3">
        <Compass className="size-5" />
      </div>
      <div>
        <p className="eyebrow">404 · Off the trail</p>
        <h1 className="display mt-1 text-[28px] leading-tight font-semibold" tabIndex={-1}>
          There is no page here
        </h1>
        <p className="mt-2 text-ink-2">
          The link may be old, or the plan it pointed to was deleted. Try the dashboard, or press{" "}
          <kbd className="rounded border border-border bg-surface-2 px-1 text-[11px]">⌘K</kbd> /{" "}
          <kbd className="rounded border border-border bg-surface-2 px-1 text-[11px]">Ctrl K</kbd>{" "}
          to search.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" asChild>
          <Link to="/">Go to the dashboard</Link>
        </Button>
        <Button asChild>
          <Link to="/plans">All plans</Link>
        </Button>
      </div>
    </div>
  );
}

/** Skeleton shown while a lazily loaded page arrives. Mirrors the Page header rhythm. */
export function PagePending() {
  return (
    <div
      className="mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-4 py-6 sm:px-6"
      role="status"
      aria-busy="true"
      aria-label="Loading page"
    >
      <div className="flex flex-col gap-2">
        <div className="shimmer h-7 w-56 rounded-md" />
        <div className="shimmer h-4 w-80 max-w-full rounded" />
      </div>
      <div className="grid gap-5 md:grid-cols-3">
        <div className="shimmer h-28 rounded-[var(--radius-card)]" />
        <div className="shimmer h-28 rounded-[var(--radius-card)]" />
        <div className="shimmer h-28 rounded-[var(--radius-card)]" />
      </div>
      <div className="shimmer h-72 rounded-[var(--radius-card)]" />
    </div>
  );
}
