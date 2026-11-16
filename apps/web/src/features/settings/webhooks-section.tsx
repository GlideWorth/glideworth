import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Loader2, Plus, Send, Trash2, TriangleAlert, Webhook } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { EmptyState } from "../../components/ui/empty-state";
import { Field, Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";
import { api, type WebhookInfo } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useFormat } from "../../lib/workspace";
import { CopyButton, relativeTime } from "./keys-section";
import { CodeBlock, SectionIntro, SettingsGroup } from "./settings-ui";

export const WEBHOOK_EVENTS = [
  {
    id: "plan.updated",
    label: "Plan updated",
    description: "A plan is created, changed or deleted.",
  },
  {
    id: "simulation.completed",
    label: "Simulation completed",
    description: "An async job (Monte Carlo, solver) finishes.",
  },
  {
    id: "snapshot.created",
    label: "Snapshot recorded",
    description: "A progress snapshot is added.",
  },
];

const VERIFY = `// Node: verify X-Glideworth-Signature (t=<unix>,v1=<hex>)
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secret, rawBody, header, tolerance = 300) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > tolerance) return false;
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  return expected.length === v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}`;

export function WebhooksSection() {
  const f = useFormat();
  const qc = useQueryClient();
  const hooks = useQuery({ queryKey: ["webhooks"], queryFn: api.listWebhooks, retry: false });
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["webhooks"] });
  const items = hooks.data?.items ?? [];
  return (
    <>
      <SectionIntro title="Webhooks">
        Glideworth can tell your own services when something changes: a dashboard that refreshes
        when a plan is saved, or a notification when a long simulation finishes. Every delivery is
        signed so you can trust it.
      </SectionIntro>
      <SettingsGroup
        title="Endpoints"
        actions={
          <Button
            size="sm"
            variant="primary"
            onClick={() => setOpen(true)}
            disabled={hooks.isError}
          >
            <Plus /> Add endpoint
          </Button>
        }
      >
        {hooks.isLoading ? (
          <div className="flex items-center gap-2 px-5 py-6 text-[12.5px] text-ink-3">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : hooks.isError ? (
          <EmptyState icon={TriangleAlert} title="Webhooks are unavailable" compact>
            The Glideworth server is not reachable, or this session lacks write access.
          </EmptyState>
        ) : items.length === 0 ? (
          <EmptyState icon={Webhook} title="No endpoints yet" compact>
            Add a URL and choose which events it should receive.
          </EmptyState>
        ) : (
          <ul>
            {items.map((h) => (
              <HookRow key={h.id} hook={h} locale={f.locale} onChange={refresh} />
            ))}
          </ul>
        )}
      </SettingsGroup>
      <SettingsGroup
        title="Verifying deliveries"
        description="Each POST carries X-Glideworth-Event, X-Glideworth-Delivery and X-Glideworth-Signature."
      >
        <div className="px-5 py-4">
          <CodeBlock label="Signature verification example">{VERIFY}</CodeBlock>
          <p className="mt-2 text-[12px] text-ink-3">
            Failed deliveries are retried after 1 s, 5 s and 30 s. Redirects are not followed. This
            is a self-hosted app, so private addresses are allowed: only add URLs you trust.
          </p>
        </div>
      </SettingsGroup>
      <CreateHookDialog
        open={open}
        onOpenChange={setOpen}
        onCreated={(s) => {
          setSecret(s);
          void refresh();
        }}
      />
      <Dialog open={!!secret} onOpenChange={(o) => !o && setSecret(null)}>
        <DialogContent
          title="Endpoint added"
          description="This signing secret is shown once. Store it with the receiving service."
        >
          <div className="flex flex-col gap-3">
            <p className="truncate text-[12px] text-ink-3">{secret?.url}</p>
            <code className="block rounded-lg border border-border bg-surface-2 px-3 py-2.5 font-mono text-[12px] break-all select-all">
              {secret?.secret}
            </code>
            <div className="flex justify-end gap-2">
              {secret ? <CopyButton text={secret.secret} label="Copy secret" /> : null}
              <Button variant="primary" onClick={() => setSecret(null)}>
                Done
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function HookRow({
  hook,
  locale,
  onChange,
}: {
  hook: WebhookInfo;
  locale: string;
  onChange: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const deliveries = useQuery({
    queryKey: ["webhook-deliveries", hook.id],
    queryFn: () => api.listWebhookDeliveries(hook.id),
    enabled: expanded,
    refetchInterval: expanded ? 4000 : false,
  });
  const toggle = useMutation({
    mutationFn: (active: boolean) => api.updateWebhook(hook.id, { active }),
    onSuccess: onChange,
  });
  const ping = useMutation({
    mutationFn: () => api.pingWebhook(hook.id),
    onSuccess: () => {
      setExpanded(true);
      toast({ title: "Test delivery queued", description: "Watch its status below." });
    },
  });
  const remove = async () => {
    if (
      !(await confirmAction({
        title: "Delete this endpoint?",
        description: hook.url,
        confirmLabel: "Delete",
      }))
    )
      return;
    await api.deleteWebhook(hook.id);
    onChange();
  };
  return (
    <li className="border-b border-border last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? "Hide deliveries" : "Show deliveries"}
          className="rounded p-0.5 text-ink-3 hover:bg-surface-2"
        >
          <ChevronRight className={cn("size-4 transition-transform", expanded && "rotate-90")} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12.5px] text-ink">{hook.url}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
            {hook.events.map((e) => (
              <Badge key={e}>{e}</Badge>
            ))}
            {hook.description ? <span>· {hook.description}</span> : null}
            <span>· added {relativeTime(hook.createdAt, locale)}</span>
          </div>
        </div>
        <Switch
          aria-label={hook.active ? "Pause deliveries" : "Resume deliveries"}
          checked={hook.active}
          onCheckedChange={(v) => toggle.mutate(v)}
        />
        <Button size="sm" variant="ghost" onClick={() => ping.mutate()} disabled={ping.isPending}>
          <Send /> Test
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Delete endpoint"
          onClick={() => void remove()}
        >
          <Trash2 />
        </Button>
      </div>
      {expanded ? (
        <div className="border-t border-border bg-surface-2/40 px-5 py-3">
          {deliveries.isLoading ? (
            <p className="text-[12px] text-ink-3">Loading deliveries…</p>
          ) : (deliveries.data?.items ?? []).length === 0 ? (
            <p className="text-[12px] text-ink-3">
              No deliveries yet. Send a test to see one here.
            </p>
          ) : (
            <table className="w-full text-[12px]">
              <caption className="sr-only">Recent deliveries</caption>
              <thead>
                <tr className="text-left text-[11px] tracking-wider text-ink-3 uppercase">
                  <th scope="col" className="py-1 font-semibold">
                    Event
                  </th>
                  <th scope="col" className="py-1 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="py-1 font-semibold">
                    Attempts
                  </th>
                  <th scope="col" className="py-1 font-semibold">
                    When
                  </th>
                </tr>
              </thead>
              <tbody>
                {deliveries.data!.items.slice(0, 10).map((d) => (
                  <tr key={d.id} className="border-t border-border/70">
                    <td className="py-1 font-mono">{d.event}</td>
                    <td className="py-1">
                      <Badge
                        tone={
                          d.status === "succeeded"
                            ? "accent"
                            : d.status === "failed"
                              ? "negative"
                              : "neutral"
                        }
                      >
                        {d.status}
                        {d.lastStatusCode ? ` · ${d.lastStatusCode}` : ""}
                      </Badge>
                      {d.lastError ? (
                        <span className="ml-2 text-negative">{d.lastError}</span>
                      ) : null}
                    </td>
                    <td className="num py-1">{d.attempts}</td>
                    <td className="py-1 text-ink-3">{relativeTime(d.createdAt, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </li>
  );
}

function CreateHookDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (s: { url: string; secret: string }) => void;
}) {
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<string[]>(["plan.updated"]);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.createWebhook({
        url: url.trim(),
        events,
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    onSuccess: (h) => {
      onOpenChange(false);
      setUrl("");
      setDescription("");
      onCreated({ url: h.url, secret: h.secret });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const u = new URL(url.trim());
      if (!/^https?:$/.test(u.protocol)) throw new Error();
    } catch {
      return setError("Enter a full http:// or https:// URL.");
    }
    if (!events.length) return setError("Choose at least one event.");
    create.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add a webhook endpoint">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label="URL">
            {(id) => (
              <Input
                id={id}
                type="url"
                inputMode="url"
                placeholder="https://example.com/glideworth-hook"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            )}
          </Field>
          <Field label="Description (optional)">
            {(id) => (
              <Input
                id={id}
                value={description}
                maxLength={200}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[12px] font-medium text-ink-2">Events</legend>
            {WEBHOOK_EVENTS.map((ev) => (
              <label key={ev.id} className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--accent)]"
                  checked={events.includes(ev.id)}
                  onChange={(e) =>
                    setEvents((cur) =>
                      e.target.checked ? [...cur, ev.id] : cur.filter((x) => x !== ev.id),
                    )
                  }
                />
                <span>
                  <span className="block text-[13px] font-medium">{ev.label}</span>
                  <span className="block text-[12px] text-ink-3">{ev.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
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
              {create.isPending ? <Loader2 className="animate-spin" /> : null} Add endpoint
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
