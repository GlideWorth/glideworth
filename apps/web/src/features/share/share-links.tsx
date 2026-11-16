/**
 * Share links: create, list, refresh and revoke read-only links to a plan's results. The token is
 * shown once, at creation; the server stores only its hash.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Loader2, Plus, RefreshCw, Share2, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { EmptyState } from "../../components/ui/empty-state";
import { Field, Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { SwitchField } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";
import { useAccess } from "../../lib/access";
import { ApiRequestError, api, type ShareLink } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { useFormat, useWorkspace } from "../../lib/workspace";
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
  const [created, setCreated] = useState<{ url: string; name: string } | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["share-links"] });
  const act = useMutation({
    mutationFn: (a: { kind: "revoke" | "refresh"; id: string }) =>
      a.kind === "revoke" ? api.revokeShareLink(a.id) : api.refreshShareLink(a.id),
    onSuccess: (_l, a) => {
      void invalidate();
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
                          title: "Revoke this link?",
                          description: "Anyone who has it loses access immediately.",
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
          onCreated={(url) => {
            void invalidate();
            setCreated({ url, name: planName ?? "the plan" });
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
  onCreated: (url: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [privacy, setPrivacy] = useState<ShareLink["privacy"]>("full");
  const [basis, setBasis] = useState<"real" | "nominal">("real");
  const [days, setDays] = useState("30");
  const [success, setSuccess] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.createShareLink(planId, {
        ...(label.trim() ? { label: label.trim() } : {}),
        privacy,
        basis,
        expiresInDays: Number(days),
        includeSuccessRate: success,
      }),
    onSuccess: (r) => {
      onOpenChange(false);
      setLabel("");
      onCreated(shareUrl(r.path));
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
            hint="Runs a Monte Carlo simulation now (a few seconds)."
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
