import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Loader2, Plus, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { EmptyState } from "../../components/ui/empty-state";
import { Field, Input } from "../../components/ui/input";
import { toast } from "../../components/ui/toaster";
import { useAccess } from "../../lib/access";
import { type ApiKeyInfo, ApiRequestError, type ApiScope, api } from "../../lib/api";
import { useMode } from "../../lib/auth";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { ReauthCancelled, withReauth } from "../../lib/reauth";
import { useFormat } from "../../lib/workspace";
import { LoadErrorText, SectionIntro, SettingsGroup } from "./settings-ui";

export const SCOPE_INFO: Record<ApiScope, { label: string; description: string }> = {
  read: {
    label: "Read",
    description: "Read plans, finances and history, and run simulations on them.",
  },
  simulate: {
    label: "Simulate",
    description: "Run simulations and solvers only; cannot read raw data. A “calculator” key.",
  },
  write: {
    label: "Write",
    description: "Change anything: plans, finances, keys, webhooks. Includes read and simulate.",
  },
};

export { relativeTime };

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          toast({
            title: "Copy failed",
            description: "Select the text and copy it manually.",
            tone: "negative",
          });
        }
      }}
      aria-label={done ? "Copied" : label}
    >
      {done ? <Check /> : <Copy />} {done ? "Copied" : label}
    </Button>
  );
}

export function KeysSection() {
  const f = useFormat();
  const qc = useQueryClient();
  const access = useAccess();
  const cloud = useMode() === "cloud";
  // The owner sees (and can revoke) every key; everyone else manages their own (`/me/keys`).
  const all = access.isOwner;
  const keys = useQuery({
    queryKey: ["api-keys", all],
    queryFn: all ? api.listKeys : api.listMyKeys,
    retry: false,
  });
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const name = keys.data?.items.find((k) => k.id === id)?.name ?? "the key";
      await (all ? api.revokeKey(id) : api.revokeMyKey(id));
      return { name };
    },
    onSuccess: (k) => {
      void qc.invalidateQueries({ queryKey: ["api-keys"] });
      toast({
        title: `Revoked “${k.name}”`,
        description: "Anything using it stops working immediately.",
      });
    },
    onError: (e) =>
      toast({
        title: "Could not revoke the key",
        description:
          e instanceof ApiRequestError && e.code === "LAST_WRITE_KEY"
            ? "It is the last key that can make changes; create another write key first so you are not locked out."
            : e instanceof Error
              ? e.message
              : String(e),
        tone: "negative",
      }),
  });
  const items = keys.data?.items ?? [];
  const active = items.filter((k) => !k.revokedAt);
  const revoked = items.filter((k) => k.revokedAt);

  return (
    <>
      <SectionIntro title={all ? "API keys" : "My keys"}>
        Keys let scripts, spreadsheets and AI assistants use Glideworth’s REST API and MCP server.
        Give each integration its own key with the least access it needs. Secrets are shown once and
        stored only as a hash.
        {access.role === "viewer"
          ? " As a viewer, your keys can read and run simulations but never change anything."
          : ""}
        {cloud
          ? " On Glideworth Cloud a key belongs to this workspace and starts with gwk_. Creating a key that can make changes asks you to confirm your password first."
          : ""}
      </SectionIntro>
      <SettingsGroup
        title={all ? "Active keys (everyone)" : "Your active keys"}
        actions={
          <Button size="sm" variant="primary" onClick={() => setOpen(true)} disabled={keys.isError}>
            <Plus /> New key
          </Button>
        }
      >
        {keys.isLoading ? (
          <div className="flex items-center gap-2 px-5 py-6 text-[12.5px] text-ink-3">
            <Loader2 className="size-4 animate-spin" /> Loading keys…
          </div>
        ) : keys.isError ? (
          <EmptyState icon={TriangleAlert} title="Keys are unavailable" compact>
            <LoadErrorText
              error={keys.error}
              use="use API keys"
              forbidden="Managing keys needs a key or session with write access."
            />
          </EmptyState>
        ) : active.length === 0 ? (
          <EmptyState icon={KeyRound} title="No active keys" compact>
            Create one for each script or assistant you connect.
          </EmptyState>
        ) : (
          <ul>
            {active.map((k) => (
              <KeyRow
                key={k.id}
                k={k}
                locale={f.locale}
                onRevoke={async () => {
                  if (
                    await confirmAction({
                      title: `Revoke “${k.name}”?`,
                      description:
                        "Anything using this key stops working at once. This cannot be undone.",
                      confirmLabel: "Revoke key",
                    })
                  )
                    revoke.mutate(k.id);
                }}
              />
            ))}
          </ul>
        )}
      </SettingsGroup>
      {revoked.length ? (
        <details className="rounded-[var(--radius-card)] border border-border bg-surface">
          <summary className="cursor-pointer px-5 py-3 text-[13px] font-medium text-ink-2">
            {revoked.length} revoked {revoked.length === 1 ? "key" : "keys"}
          </summary>
          <ul className="border-t border-border">
            {revoked.map((k) => (
              <KeyRow key={k.id} k={k} locale={f.locale} />
            ))}
          </ul>
        </details>
      ) : null}
      <CreateKeyDialog
        mine={!all}
        allowWrite={access.canWrite}
        open={open}
        onOpenChange={setOpen}
        onCreated={(c) => {
          setCreated(c);
          void qc.invalidateQueries({ queryKey: ["api-keys"] });
        }}
      />
      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent
          title={`Key “${created?.name ?? ""}” created`}
          description="Copy it now. For your security it will not be shown again."
        >
          <div className="flex flex-col gap-3">
            <code className="block rounded-lg border border-border bg-surface-2 px-3 py-2.5 font-mono text-[12px] break-all select-all">
              {created?.key}
            </code>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[12px] text-ink-3">
                Store it in a password manager or your client’s secret settings.
              </p>
              {created ? <CopyButton text={created.key} label="Copy key" /> : null}
            </div>
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => setCreated(null)}>
                I have saved it
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function KeyRow({ k, locale, onRevoke }: { k: ApiKeyInfo; locale: string; onRevoke?: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-3 last:border-b-0">
      <KeyRound
        className={cn("size-4 shrink-0", k.revokedAt ? "text-ink-3" : "text-accent")}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn("text-[13px] font-semibold", k.revokedAt && "text-ink-3 line-through")}
          >
            {k.name}
          </span>
          {k.userName ? <span className="text-[11.5px] text-ink-3">{k.userName}</span> : null}
          <code className="font-mono text-[11.5px] text-ink-3">…_{k.prefix}_…</code>
          {k.scopes.map((s) => (
            <Badge key={s} tone={s === "write" ? "ochre" : "neutral"}>
              {SCOPE_INFO[s]?.label ?? s}
            </Badge>
          ))}
        </div>
        <div className="mt-0.5 text-[11.5px] text-ink-3">
          Created {relativeTime(k.createdAt, locale)} · last used{" "}
          {relativeTime(k.lastUsedAt, locale).toLowerCase()}
          {k.revokedAt ? ` · revoked ${relativeTime(k.revokedAt, locale)}` : ""}
        </div>
      </div>
      {onRevoke ? (
        <Button size="sm" variant="ghost" className="text-negative" onClick={onRevoke}>
          Revoke
        </Button>
      ) : null}
    </li>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
  mine = false,
  allowWrite = true,
}: {
  mine?: boolean;
  allowWrite?: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (c: { name: string; key: string }) => void;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>(["read"]);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    // Cloud: a key that can write needs a recent password check; withReauth asks, then repeats this call.
    mutationFn: () =>
      withReauth(() =>
        mine
          ? api.createMyKey({ name: name.trim(), scopes })
          : api.createKey({ name: name.trim(), scopes }),
      ),
    onSuccess: (k) => {
      onOpenChange(false);
      setName("");
      setScopes(["read"]);
      onCreated({ name: k.name, key: k.key });
    },
    onError: (e) => {
      if (e instanceof ReauthCancelled) return;
      setError(e instanceof Error ? e.message : String(e));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Give the key a name, e.g. “Claude (read-only)”.");
    if (!scopes.length) return setError("Choose at least one scope.");
    create.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New API key"
        description="Name it after what will use it, so you know what to revoke later."
      >
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Claude Desktop"
                maxLength={80}
              />
            )}
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[12px] font-medium text-ink-2">Scopes</legend>
            {(Object.keys(SCOPE_INFO) as ApiScope[])
              .filter((s) => allowWrite || s !== "write")
              .map((s) => (
                <label
                  key={s}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border px-3 py-2 has-[:checked]:border-accent/60 has-[:checked]:bg-accent-soft/40"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-[var(--accent)]"
                    checked={scopes.includes(s)}
                    onChange={(e) =>
                      setScopes((cur) =>
                        e.target.checked ? [...cur, s] : cur.filter((x) => x !== s),
                      )
                    }
                  />
                  <span>
                    <span className="block text-[13px] font-medium">{SCOPE_INFO[s].label}</span>
                    <span className="block text-[12px] text-ink-3">
                      {SCOPE_INFO[s].description}
                    </span>
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
              {create.isPending ? <Loader2 className="animate-spin" /> : null} Create key
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
