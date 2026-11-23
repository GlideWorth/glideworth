/**
 * Plan health and check-ins: the check-in schedule, the health history chart, "what changed since my
 * last check-in" for the dashboard, and the notification centre in the top bar. All data comes from
 * the API's in-process scheduler (`/schedule`, `/plans/{id}/health`, `/plans/{id}/changes-since-checkin`,
 * `/notifications`); offline, these quietly say so.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  CircleCheck,
  History,
  Info,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { ReactNode } from "react";
import { SeriesChart } from "../../components/charts/series-chart";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { toast } from "../../components/ui/toaster";
import { useAccess } from "../../lib/access";
import { isDemo } from "../../lib/demo";
import {
  ApiRequestError,
  api,
  type CheckInChange,
  type PlanActor,
  type PlanHealth,
} from "../../lib/api";
import { cn } from "../../lib/cn";
import { formatMoney, relativeTime } from "../../lib/format";
import { useFormat, useWorkspace } from "../../lib/workspace";
import { PrivateText } from "../../components/ui/private-text";

const online = (ws: ReturnType<typeof useWorkspace>["data"]) => ws?.source === "api";
const missingRoute = (e: unknown) =>
  e instanceof ApiRequestError &&
  (e.status === 404 || e.status === 405 || e.status === 501) &&
  e.code !== "NOT_FOUND";

export function actorName(a: PlanActor | null | undefined): string {
  if (!a) return "Someone";
  if (a.userName && a.kind === "user") return a.userName;
  if (a.kind === "api-key")
    return `API key “${a.label ?? a.id ?? ""}”${a.userName ? ` (${a.userName})` : ""}`;
  if (a.kind === "mcp") return `AI assistant${a.userName ? ` (${a.userName})` : ""}`;
  return a.userName ?? a.label ?? a.kind;
}

export function SeverityIcon({ severity, className }: { severity: string; className?: string }) {
  return severity === "critical" ? (
    <AlertTriangle className={cn("size-3.5 text-negative", className)} />
  ) : severity === "warning" ? (
    <AlertTriangle className={cn("size-3.5 text-ochre", className)} />
  ) : (
    <Info className={cn("size-3.5 text-ink-3", className)} />
  );
}

/** Run a check-in on a plan now (waits for Monte Carlo on the server). */
export function useCheckInNow(planId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.runCheckin(planId!),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["health", planId] });
      void qc.invalidateQueries({ queryKey: ["changes-since", planId] });
      void qc.invalidateQueries({ queryKey: ["notifications"] });
      toast({
        title: r.changes.length
          ? `Check-in found ${r.changes.length} ${r.changes.length === 1 ? "change" : "changes"}`
          : "Checked in: nothing material changed",
        description:
          r.health.successRate !== null
            ? `Chance of success ${Math.round(r.health.successRate * 100)}%.`
            : undefined,
        tone: "positive",
      });
    },
    onError: (e) =>
      toast({
        title: "Check-in failed",
        description:
          e instanceof ApiRequestError && e.code === "CHECKIN_RUNNING"
            ? "A check-in is already running; try again in a moment."
            : e instanceof Error
              ? e.message
              : String(e),
        tone: "negative",
      }),
  });
}

// ------------------------------------------------------------------------- what changed card

/** "What changed since the last check-in" for a plan (shared by the dashboard card and headline). */
export function useChangesSinceCheckin(planId: string | undefined) {
  const { data: ws } = useWorkspace();
  return useQuery({
    queryKey: ["changes-since", planId],
    enabled: online(ws) && !!planId,
    queryFn: () => api.changesSinceCheckin(planId!),
    retry: false,
    staleTime: 60_000,
  });
}

export function ChangesSinceCheckInCard({ planId }: { planId: string | undefined }) {
  const { data: ws } = useWorkspace();
  const f = useFormat();
  const access = useAccess();
  const q = useChangesSinceCheckin(planId);
  const run = useCheckInNow(planId);
  if (!online(ws) || !planId) return null;
  if (q.isError && missingRoute(q.error)) return null;
  const d = q.data;
  const last = d?.lastCheckIn;
  const money = (v: number | null | undefined) =>
    v === null || v === undefined
      ? "—"
      : formatMoney(v, { locale: f.locale, currency: last?.currency ?? f.currency, compact: true });
  const nw = d?.netWorth;
  return (
    <Card>
      <CardHeader
        eyebrow="Check-in"
        title={last ? "What changed since your last check-in" : "Check in on your plan"}
        actions={
          <>
            <Button size="sm" variant="ghost" asChild>
              <Link to="/settings/$section" params={{ section: "checkins" }}>
                <History /> History
              </Link>
            </Button>
            {access.canWrite ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => run.mutate()}
                disabled={run.isPending}
              >
                {run.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check in now
              </Button>
            ) : null}
          </>
        }
      />
      <CardBody className="flex flex-col gap-3">
        {q.isLoading ? (
          <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
            <Loader2 className="size-4 animate-spin" /> Comparing with your last check-in…
          </div>
        ) : q.isError ? (
          <div className="text-[12.5px] text-ink-3">Could not load the last check-in.</div>
        ) : !last ? (
          <p className="text-[13px] text-ink-2">
            A check-in re-runs this plan&rsquo;s projection, chance of success and assumption audit
            and keeps the result, so next time you can see what moved. Glideworth checks in on its
            own on the schedule in Settings; run the first one now.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Mini label="Last check-in" value={relativeTime(last.takenAt, f.locale)} />
              <Mini
                label="Chance of success"
                value={last.successRate !== null ? f.percent(last.successRate, 0) : "—"}
                sub="at the check-in"
              />
              <Mini
                label="Net worth since"
                value={
                  nw?.change !== null && nw?.change !== undefined
                    ? `${nw.change >= 0 ? "+" : "−"}${money(Math.abs(nw.change))}`
                    : "—"
                }
                tone={
                  nw?.change !== null && nw?.change !== undefined
                    ? nw.change >= 0
                      ? "positive"
                      : "negative"
                    : undefined
                }
                sub={nw?.now !== null && nw?.now !== undefined ? `now ${money(nw.now)}` : undefined}
              />
              <Mini
                label="Plan edits"
                value={String(d?.edits?.length ?? 0)}
                sub={d?.householdChanged ? "and finances updated" : undefined}
              />
            </div>
            {(d?.changes?.length ?? 0) > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {d!.changes!.map((c) => (
                  <ChangeRow key={`${c.kind}-${c.title}`} c={c} />
                ))}
              </ul>
            ) : (
              <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
                <CircleCheck className="size-4 text-positive" /> Nothing material has changed.
              </div>
            )}
            {(d?.edits?.length ?? 0) > 0 ? (
              <details className="text-[12.5px]">
                <summary className="cursor-pointer text-ink-2">Edits since then</summary>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {d!.edits!.slice(0, 8).map((e) => (
                    <li key={e.version} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate">
                        {e.message ?? `Version ${e.version}`}{" "}
                        <span className="text-ink-3">· {actorName(e.actor)}</span>
                      </span>
                      <span className="shrink-0 text-ink-3">
                        {relativeTime(e.createdAt, f.locale)}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <p className="text-[11.5px] text-ink-3">
              The chance of success shown is the one measured at the check-in; check in again to
              re-run it.
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function Mini({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "positive" | "negative" | undefined;
}) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div
        className={cn(
          "num mt-0.5 text-[16px] font-semibold",
          tone === "positive" && "text-positive",
          tone === "negative" && "text-negative",
        )}
      >
        {value}
      </div>
      {sub ? <div className="text-[11.5px] text-ink-3">{sub}</div> : null}
    </div>
  );
}

function ChangeRow({ c }: { c: CheckInChange }) {
  return (
    <li className="flex gap-2 text-[13px]">
      <SeverityIcon severity={c.severity} className="mt-0.5 shrink-0" />
      <span>
        <PrivateText>{c.title}</PrivateText>
      </span>
    </li>
  );
}

// --------------------------------------------------------------------------- health history

export function HealthHistory({
  planId,
  height = 240,
}: {
  planId: string | undefined;
  height?: number;
}) {
  const { data: ws } = useWorkspace();
  const f = useFormat();
  const q = useQuery({
    queryKey: ["health", planId],
    enabled: online(ws) && !!planId,
    queryFn: () => api.planHealth(planId!, 200),
    retry: false,
  });
  if (!online(ws))
    return (
      <EmptyState icon={Activity} title="Plan health needs the server" compact>
        {isDemo()
          ? "Scheduled check-ins run for your account; the demo has none."
          : "Check-ins run on your Glideworth server; this browser is offline."}
      </EmptyState>
    );
  if (q.isLoading)
    return (
      <div className="flex items-center gap-2 py-6 text-[12.5px] text-ink-3">
        <Loader2 className="size-4 animate-spin" /> Loading the health history…
      </div>
    );
  if (q.isError)
    return (
      <EmptyState icon={Activity} title="Plan health unavailable" compact>
        {missingRoute(q.error)
          ? "This server does not run check-ins yet."
          : "Could not load the history."}
      </EmptyState>
    );
  const items = [...(q.data?.items ?? [])].reverse();
  if (items.length === 0)
    return (
      <EmptyState icon={Activity} title="No check-ins yet" compact>
        The first check-in is a baseline; each one after it adds a point here.
      </EmptyState>
    );
  const labels = items.map((h) =>
    new Intl.DateTimeFormat(f.locale, { day: "numeric", month: "short", year: "2-digit" }).format(
      Date.parse(h.takenAt),
    ),
  );
  return (
    <div className="flex flex-col gap-3">
      <SeriesChart
        labels={labels}
        format="percent"
        locale={f.locale}
        height={height}
        yMin={0}
        yMax={1}
        ariaLabel="Chance of success at each check-in"
        series={[
          {
            name: "Chance of success",
            color: (t) => t.accent,
            type: "line",
            symbol: true,
            values: items.map((h) => h.successRate),
          },
        ]}
        tooltipExtra={(i) => healthTooltip(items[i]!, f.locale)}
      />
      <HealthTable items={[...items].reverse().slice(0, 8)} />
    </div>
  );
}

function healthTooltip(h: PlanHealth, locale: string): string {
  const m = (v: number | null) =>
    v === null ? "—" : formatMoney(v, { locale, currency: h.currency, compact: true });
  const rows = [
    `FI / retirement year: ${h.fiYear ?? "—"}`,
    `Net worth: ${m(h.actualNetWorth)}${h.netWorthVsPlan ? ` (${h.netWorthVsPlan.delta >= 0 ? "+" : "−"}${m(Math.abs(h.netWorthVsPlan.delta))} vs plan)` : ""}`,
    `Plan version ${h.planVersion} · ${h.trigger}`,
  ];
  return rows.map((r) => `<div style="font-size:11px;opacity:.8">${r}</div>`).join("");
}

function HealthTable({ items }: { items: PlanHealth[] }) {
  const f = useFormat();
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {items.map((h) => (
        <li
          key={h.id}
          className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-[12.5px]"
        >
          <span className="w-[120px] text-ink-2">{relativeTime(h.takenAt, f.locale)}</span>
          <span className="num font-medium">
            {h.successRate !== null ? f.percent(h.successRate, 0) : "—"}
          </span>
          <span className="text-ink-3">FI {h.fiYear ?? "—"}</span>
          {h.findings.length ? (
            <Badge tone="ochre">
              {h.findings.length} {h.findings.length === 1 ? "finding" : "findings"}
            </Badge>
          ) : null}
          <span className="ml-auto text-ink-3">
            {h.trigger === "scheduled" ? "Scheduled" : "Manual"}
          </span>
        </li>
      ))}
    </ul>
  );
}
