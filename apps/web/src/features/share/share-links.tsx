/**
 * Share links: create, list, refresh and revoke read-only links to a plan's results. The token is
 * shown once, at creation; the server stores only its hash.
 */
import { usePostHog } from "@posthog/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Loader2, Plus, RefreshCw, Share2, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button, buttonVariants } from "../../components/ui/button";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { EmptyState } from "../../components/ui/empty-state";
import { Field, Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { SwitchField } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";
import { useAccess } from "../../lib/access";
import { ApiRequestError, api, type ShareLink } from "../../lib/api";
import { cn } from "../../lib/cn";
import { isDemo } from "../../lib/demo";
import { relativeTime } from "../../lib/format";
import { useFormat, useWorkspace } from "../../lib/workspace";
import { DemoSignUpLink } from "../demo/demo-ui";
import { CopyButton } from "../settings/keys-section";

const PRIVACY: { value: ShareLink["privacy"]; label: string; hint: string }[] = [
  { value: "full", label: "Show amounts", hint: "Figures in your currency." },
  {
    value: "percent",
    label: "Percentages only",
    hint: "Every amount as a % of your starting net worth; no currency.",
  },
  {
    value: "hidden",
    label: "Hide amounts",
    hint: "Only the chance of success, years and milestones.",
  },
];
const PRIVACY_LABEL = Object.fromEntries(PRIVACY.map((p) => [p.value, p.label])) as Record<
  ShareLink["privacy"],
  string
>;

const errText = (e: unknown) =>
  e instanceof ApiRequestError
    ? e.status === 403
      ? "Sharing needs editor access."
      : e.message
    : e instanceof Error
      ? e.message
      : String(e);

export function shareUrl(path: string): string {
  return `${window.location.origin}${path}`;
}

export function revokePrompt(link: { label: string | null }): {
  title: string;
  description: string;
} {
  const name = link.label?.trim() || "Untitled link";
  return {
    title: `Revoke “${name}”?`,
    description: `Anyone who has “${name}” loses access immediately.`,
  };
}

export function replaceShareLink<T extends { id: string }>(items: T[], next: T): T[] {
  return items.map((item) => (item.id === next.id ? next : item));
}

/** Links for one plan (or every plan with `planId` undefined), with create / refresh / revoke. */
export function ShareLinksPanel({ planId, planName }: { planId?: string; planName?: string }) {
  const { data: ws } = useWorkspace();
  const access = useAccess();
  const f = useFormat();
  const qc = useQueryClient();
  const online = ws?.source === "api";
  const q = useQuery({
    queryKey: ["share-links", planId ?? "all"],
    queryFn: () => api.listShareLinks(planId),
    enabled: online && access.canWrite,
    retry: false,
  });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{
    url: string;
    name: string;
    monteCarlo?: { status: string; jobId?: string };
  } | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["share-links"] });
  const act = useMutation({
    mutationFn: (a: { kind: "revoke" | "refresh"; id: string }) =>
      a.kind === "revoke" ? api.revokeShareLink(a.id) : api.refreshShareLink(a.id),
    onSuccess: (link, a) => {
      for (const [key, data] of qc.getQueriesData<{ items: ShareLink[] }>({
        queryKey: ["share-links"],
      })) {
        if (!data?.items.some((item) => item.id === link.id)) continue;
        qc.setQueryData(key, { ...data, items: replaceShareLink(data.items, link) });
      }
      void invalidate().then(() => {
        // A refetch that left before the revoke can still say Active. The response we just got is revoked.
        if (link.status !== "revoked") return;
        for (const [key, data] of qc.getQueriesData<{ items: ShareLink[] }>({
          queryKey: ["share-links"],
        })) {
          if (!data?.items.some((item) => item.id === link.id)) continue;
          qc.setQueryData(key, { ...data, items: replaceShareLink(data.items, link) });
        }
      });
      toast({
        title: a.kind === "revoke" ? "Link revoked" : "Snapshot refreshed",
        description:
          a.kind === "revoke"
            ? "It stopped working immediately."
            : "The link now shows the plan as it is today; the address is unchanged.",
      });
    },
    onError: (e) => toast({ title: "Not changed", description: errText(e), tone: "negative" }),
  });
  const planNames = new Map((ws?.doc.plans ?? []).map((p) => [p.id, p.name]));

  if (isDemo())
    return (
      <EmptyState
        icon={Share2}
        title="Share links are part of your account"
        compact
        action={
          <DemoSignUpLink
            placement="share"
            className={cn(buttonVariants({ variant: "primary", size: "sm" }))}
          >
            Start your free 14-day trial
          </DemoSignUpLink>
        }
      >
        Send a partner or adviser a read-only link to a plan&rsquo;s results. No card needed for the
        trial.
      </EmptyState>
    );
  if (!online)
    return (
      <EmptyState icon={Share2} title="Sharing needs the server" compact>
        Share links are served by your Glideworth server; this browser is offline.
      </EmptyState>
    );
  if (!access.canWrite)
    return (
      <EmptyState icon={Share2} title="View-only access" compact>
        Viewers cannot create share links. Ask the owner or an editor.
      </EmptyState>
    );
  const items = q.data?.items ?? [];
  const active = items.filter((l) => l.status === "active");
  const inactive = items.filter((l) => l.status !== "active");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-xl text-[12.5px] text-ink-2">
          Anyone with a link sees a read-only snapshot of {planName ? `“${planName}”` : "a plan"}:
          the chance of success, milestones and a year-by-year table. Never your accounts, people or
          other plans.
        </p>
        {planId ? (
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            <Plus /> New link
          </Button>
        ) : null}
      </div>
      {q.isLoading ? (
        <div className="flex items-center gap-2 py-4 text-[12.5px] text-ink-3">
          <Loader2 className="size-4 animate-spin" /> Loading links…
        </div>
      ) : q.isError ? (
        <EmptyState icon={TriangleAlert} title="Links unavailable" compact>
          {errText(q.error)}
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState icon={Link2} title="No share links yet" compact>
          {planId
            ? "Create one for an adviser, a partner or a friend."
            : "Create one from a plan’s menu on the Plans page."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {[...active, ...inactive].map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold">{l.label ?? "Untitled link"}</span>
                  {!planId ? (
                    <span className="text-[12px] text-ink-3">
                      {planNames.get(l.planId) ?? l.planId}
                    </span>
                  ) : null}
                  <Badge
                    tone={
                      l.status === "active"
                        ? "accent"
                        : l.status === "revoked"
                          ? "negative"
                          : "neutral"
                    }
                  >
                    {l.status === "active"
                      ? "Active"
                      : l.status === "revoked"
                        ? "Revoked"
                        : "Expired"}
                  </Badge>
                  <Badge>{PRIVACY_LABEL[l.privacy]}</Badge>
                </div>
                <div className="mt-0.5 text-[11.5px] text-ink-3">
                  Snapshot {relativeTime(l.snapshotAt, f.locale)} · expires{" "}
                  {new Intl.DateTimeFormat(f.locale, { dateStyle: "medium" }).format(
                    Date.parse(l.expiresAt),
                  )}{" "}
                  · viewed {l.viewCount} {l.viewCount === 1 ? "time" : "times"}
                  {l.lastViewedAt
                    ? `, last ${relativeTime(l.lastViewedAt, f.locale).toLowerCase()}`
                    : ""}
                </div>
              </div>
              {l.status === "active" ? (
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => act.mutate({ kind: "refresh", id: l.id })}
                  >
                    <RefreshCw /> Refresh
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-negative"
                    onClick={async () => {
                      if (
                        await confirmAction({
                          ...revokePrompt(l),
                          confirmLabel: "Revoke",
                        })
                      )
                        act.mutate({ kind: "revoke", id: l.id });
                    }}
                  >
                    Revoke
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {planId ? (
        <CreateShareDialog
          planId={planId}
          planName={planName ?? "this plan"}
          open={creating}
          onOpenChange={setCreating}
          onCreated={(url, monteCarlo) => {
            void invalidate();
            setCreated({ url, name: planName ?? "the plan", monteCarlo });
          }}
        />
      ) : null}
      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent
          title="Link created"
          description="Copy it now: for privacy, Glideworth keeps only a fingerprint and cannot show it again."
        >
          <div className="flex flex-col gap-3">
            <code className="block rounded-lg border border-border bg-surface-2 px-3 py-2.5 font-mono text-[12px] break-all select-all">
              {created?.url}
            </code>
            {created?.monteCarlo?.status === "included" ? (
              <p className="text-[12.5px] text-ink-2">Chance of success is on the link.</p>
            ) : null}
            {created?.monteCarlo?.status === "unavailable" ? (
              <p role="alert" className="text-[12.5px] text-ink-2">
                The link is ready. The chance of success could not be added. Use Refresh on the link
                to try again.
              </p>
            ) : null}
            {created?.monteCarlo?.status === "pending" && created.monteCarlo.jobId ? (
              <DeferredChance jobId={created.monteCarlo.jobId} />
            ) : null}
            <div className="flex items-center justify-end gap-2">
              {created ? <CopyButton text={created.url} label="Copy link" /> : null}
              <Button variant="primary" onClick={() => setCreated(null)}>
                Done
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreateShareDialog({
  planId,
  planName,
  open,
  onOpenChange,
  onCreated,
}: {
  planId: string;
  planName: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (
    url: string,
    monteCarlo?: { status: "skipped" | "included" | "pending" | "unavailable"; jobId?: string },
  ) => void;
}) {
  const [label, setLabel] = useState("");
  const [privacy, setPrivacy] = useState<ShareLink["privacy"]>("full");
  const [basis, setBasis] = useState<"real" | "nominal">("real");
  const [days, setDays] = useState("30");
  const [success, setSuccess] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const posthog = usePostHog();
  const create = useMutation({
    mutationFn: () =>
      api.createShareLink(planId, {
        ...(label.trim() ? { label: label.trim() } : {}),
        privacy,
        basis,
        expiresInDays: Number(days),
        includeSuccessRate: success,
        // The run continues after the link is returned. Waiting here used to take half a minute.
        deferMonteCarlo: success,
      }),
    onSuccess: (r) => {
      posthog?.capture("share_link_created", {
        amounts_visibility: privacy,
        money_basis: basis,
        expires_in_days: Number(days),
        includes_success_rate: success,
      });
      onOpenChange(false);
      setLabel("");
      onCreated(shareUrl(r.path), r.monteCarlo);
    },
    onError: (e) =>
      setError(
        e instanceof ApiRequestError && e.status === 422
          ? "Percentages need a positive starting net worth. Choose “Hide amounts” instead."
          : errText(e),
      ),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    create.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Share “${planName}”`}
        description="A read-only snapshot of this plan’s results."
      >
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label="Label" hint="Shown on the shared page, e.g. “For Pat (adviser)”.">
            {(id) => (
              <Input
                id={id}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={120}
              />
            )}
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[12px] font-medium text-ink-2">Amounts</legend>
            {PRIVACY.map((p) => (
              <label
                key={p.value}
                className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border px-3 py-2 has-[:checked]:border-accent/60 has-[:checked]:bg-accent-soft/40"
              >
                <input
                  type="radio"
                  name="share-privacy"
                  className="mt-0.5 accent-[var(--accent)]"
                  checked={privacy === p.value}
                  onChange={() => setPrivacy(p.value)}
                />
                <span>
                  <span className="block text-[13px] font-medium">{p.label}</span>
                  <span className="block text-[12px] text-ink-3">{p.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Money shown as">
              {(id) => (
                <Select
                  id={id}
                  value={basis}
                  onValueChange={setBasis}
                  options={[
                    { value: "real", label: "Today's money" },
                    { value: "nominal", label: "Future money" },
                  ]}
                />
              )}
            </Field>
            <Field label="Expires after">
              {(id) => (
                <Select
                  id={id}
                  value={days}
                  onValueChange={setDays}
                  options={["7", "14", "30", "90", "365"].map((d) => ({
                    value: d,
                    label: `${d} days`,
                  }))}
                />
              )}
            </Field>
          </div>
          <SwitchField
            label="Include the chance of success"
            hint="The link is created straight away. The chance of success is added when the run finishes (often about half a minute the first time; a repeat is immediate)."
            checked={success}
            onCheckedChange={setSuccess}
          />
          {error ? (
            <p role="alert" className="text-[12.5px] text-negative">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={create.isPending}>
              {create.isPending ? <Loader2 className="animate-spin" /> : <Link2 />} Create link
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type DeferredChanceState = "running" | "added" | "failed" | "unknown";

/**
 * What to say about a run the link was returned ahead of. `unknown` is a job that cannot be read (the
 * server restarted, or the request failed): the dialog must not keep saying "Running… 0%" for ever.
 */
export function deferredChanceState(q: {
  status?: string | undefined;
  isError: boolean;
}): DeferredChanceState {
  if (q.status === "succeeded") return "added";
  if (q.status === "failed" || q.status === "cancelled") return "failed";
  return q.isError ? "unknown" : "running";
}

/** The chance of success for a link that was returned before its Monte Carlo run finished. */
function DeferredChance({ jobId }: { jobId: string }) {
  const q = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.getJob(jobId),
    retry: 2,
    refetchInterval: (query) =>
      deferredChanceState({
        status: query.state.data?.status,
        isError: query.state.status === "error",
      }) === "running"
        ? 500
        : false,
  });
  const state = deferredChanceState({ status: q.data?.status, isError: q.isError });
  const pct = Math.round((q.data?.progress ?? 0) * 100);
  if (state === "added")
    return <p className="text-[12.5px] text-ink-2">Chance of success is on the link.</p>;
  if (state === "failed")
    return (
      <p role="alert" className="text-[12.5px] text-ink-2">
        The link is ready. The chance of success could not be added. Use Refresh on the link to try
        again.
      </p>
    );
  if (state === "unknown")
    return (
      <p role="alert" className="text-[12.5px] text-ink-2">
        The link is ready. The progress of the chance of success run could not be read. If the
        figure is missing from the link, use Refresh on the link to run it again.
      </p>
    );
  return (
    <div className="flex flex-col gap-1.5" role="status">
      <p className="text-[12.5px] text-ink-2">
        Running the chance of success… {pct}%. A first run often takes about half a minute. The
        figure appears on the link when it finishes.
      </p>
      <progress value={q.data?.progress ?? 0} max={1} className="h-1.5 w-full" />
    </div>
  );
}
