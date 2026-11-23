/**
 * The notification centre in the top bar (`GET /notifications`, `POST /notifications/read`). Kept
 * free of chart code: it is part of the initial bundle.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Bell, BellRing, CheckCheck, Info } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Tooltip } from "../../components/ui/tooltip";
import { useAccess } from "../../lib/access";
import type { Notification } from "../../lib/api";
import { ApiRequestError, loadApi } from "../../lib/api-lazy";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { useFormat, useWorkspace } from "../../lib/workspace";
import { PrivateText } from "../../components/ui/private-text";

function SeverityIcon({ severity, className }: { severity: string; className?: string }) {
  return severity === "critical" ? (
    <AlertTriangle className={cn("size-3.5 text-negative", className)} />
  ) : severity === "warning" ? (
    <AlertTriangle className={cn("size-3.5 text-ochre", className)} />
  ) : (
    <Info className={cn("size-3.5 text-ink-3", className)} />
  );
}

const missingRoute = (e: unknown) =>
  e instanceof ApiRequestError &&
  (e.status === 404 || e.status === 405 || e.status === 501) &&
  e.code !== "NOT_FOUND";

/**
 * Always in the top bar while connected, on phones too (a 32 px icon), so notifications can be read
 * back after they are marked read. Hidden only offline or when the server has no notification routes.
 */
export function NotificationCentre() {
  const { data: ws } = useWorkspace();
  const f = useFormat();
  const qc = useQueryClient();
  const access = useAccess();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["notifications"],
    enabled: ws?.source === "api",
    queryFn: async () => (await loadApi()).listNotifications({ limit: 30 }),
    retry: false,
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
  const mark = useMutation({
    mutationFn: async (body: { ids: string[] } | { all: true }) =>
      (await loadApi()).markNotificationsRead(body),
    onMutate: (body) => {
      qc.setQueryData<{ items: Notification[]; unread: number }>(["notifications"], (d) => {
        if (!d) return d;
        const ids = "all" in body ? null : new Set(body.ids);
        const items = d.items.map((n) => (!ids || ids.has(n.id) ? { ...n, read: true } : n));
        return { items, unread: items.filter((n) => !n.read).length };
      });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  if (ws?.source !== "api" || (q.isError && missingRoute(q.error))) return null;
  const unread = q.data?.unread ?? 0;
  const items = q.data?.items ?? [];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip content={unread ? `${unread} unread notifications` : "Notifications"}>
        <Popover.Trigger
          className="relative flex size-8 pointer-coarse:size-11 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink"
          aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        >
          {unread ? <BellRing className="size-4" /> : <Bell className="size-4" />}
          {unread ? (
            <span className="num absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-ochre px-1 text-[10px] font-semibold text-accent-ink">
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 flex max-h-[min(70vh,520px)] w-[min(92vw,380px)] flex-col rounded-lg border border-border bg-surface shadow-pop"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
            <div className="text-[13px] font-semibold">Notifications</div>
            {unread && access.canWrite ? (
              <Button size="sm" variant="ghost" onClick={() => mark.mutate({ all: true })}>
                <CheckCheck /> Mark all read
              </Button>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12.5px] text-ink-3">
                Nothing yet. Check-ins tell you here when your chance of success moves, a milestone
                slips, the audit finds something new or net worth falls behind plan.
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full gap-2.5 px-3.5 py-2.5 text-left hover:bg-surface-2",
                        !n.read && "bg-accent-soft/30",
                      )}
                      onClick={() => {
                        if (!n.read && access.canWrite) mark.mutate({ ids: [n.id] });
                      }}
                    >
                      <SeverityIcon severity={n.severity} className="mt-0.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className={cn("block text-[13px]", !n.read && "font-semibold")}>
                          <PrivateText>{n.title}</PrivateText>
                          {!n.read ? <span className="sr-only"> (unread)</span> : null}
                        </span>
                        {typeof n.body === "string" && n.body ? (
                          <span className="block text-[12px] text-ink-2">
                            <PrivateText>{n.body}</PrivateText>
                          </span>
                        ) : null}
                        <span className="block text-[11px] text-ink-3">
                          {relativeTime(n.createdAt, f.locale)}
                        </span>
                      </span>
                      {!n.read ? (
                        <span
                          className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ochre"
                          aria-hidden
                        />
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="border-t border-border px-3.5 py-2 text-right">
            <Link
              to="/settings/$section"
              params={{ section: "checkins" }}
              onClick={() => setOpen(false)}
              className="text-[12px] text-accent hover:underline"
            >
              Check-in settings
            </Link>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
