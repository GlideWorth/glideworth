/**
 * Loading / empty / not-available / error states shared by every analysis view, plus helpers
 * to recognise NotImplementedError across the worker boundary.
 */
import { AlertTriangle, Construction, FlaskConical, Inbox, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { SimulationError } from "../../workers/sim-client";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/** Feature + workstream when `e` is a NotImplementedError (direct or serialised by a worker). */
export function notImplementedInfo(e: unknown): { feature: string; workstream: string } | null {
  if (e instanceof SimulationError && e.isNotImplemented)
    return { feature: e.payload.feature ?? "unknown", workstream: e.payload.workstream ?? "?" };
  // By name, not `instanceof`: this module is part of the app shell and must not load @glideworth/core.
  if (e instanceof Error && e.name === "NotImplementedError") {
    const x = e as { feature?: string; workstream?: string };
    return { feature: x.feature ?? "unknown", workstream: x.workstream ?? "?" };
  }
  if (e && typeof e === "object" && (e as { code?: string }).code === "NOT_IMPLEMENTED") {
    const x = e as { feature?: string; workstream?: string };
    return { feature: x.feature ?? "unknown", workstream: x.workstream ?? "?" };
  }
  return null;
}

export function ChartLoading({ label = "Simulating in a background worker…", height = 280 }) {
  return (
    <div
      className="flex items-center justify-center gap-2 text-ink-3"
      style={{ height }}
      aria-live="polite"
    >
      <Loader2 className="size-4 animate-spin" /> {label}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
  icon,
  className,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center",
        className,
      )}
    >
      <div className="mb-1 text-ink-3">{icon ?? <Inbox className="size-5" />}</div>
      <div className="font-semibold text-ink">{title}</div>
      {children ? <div className="max-w-md text-[12.5px] text-ink-2">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Shown when a core capability still throws NotImplementedError. */
export function NotAvailable({
  what,
  error,
  onPreview,
  className,
}: {
  what: string;
  error?: unknown;
  onPreview?: () => void;
  className?: string;
}) {
  const info = notImplementedInfo(error);
  return (
    <EmptyState
      className={className}
      icon={<Construction className="size-5" />}
      title={`${what} is not available yet`}
      action={
        onPreview ? (
          <Button size="sm" variant="secondary" onClick={onPreview}>
            <FlaskConical /> Preview with example data
          </Button>
        ) : undefined
      }
    >
      {info ? (
        <>
          This view needs a part of the engine (
          <code className="text-[11.5px]">{info.feature}</code>) that this version of Glideworth
          does not include yet.
        </>
      ) : (
        "This part of the engine is still being built."
      )}
    </EmptyState>
  );
}

export function ErrorState({
  error,
  title = "Something went wrong",
}: {
  error: unknown;
  title?: string;
}) {
  if (notImplementedInfo(error)) return <NotAvailable what="This analysis" error={error} />;
  return (
    <EmptyState icon={<AlertTriangle className="size-5 text-negative" />} title={title}>
      {error instanceof Error ? error.message : String(error)}
    </EmptyState>
  );
}

export function ExampleBadge({ onExit }: { onExit?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone="ochre">
        <FlaskConical className="size-3" /> Example data
      </Badge>
      {onExit ? (
        <button
          type="button"
          className="text-[11.5px] text-ink-3 underline hover:text-ink"
          onClick={onExit}
        >
          hide
        </button>
      ) : null}
    </span>
  );
}
