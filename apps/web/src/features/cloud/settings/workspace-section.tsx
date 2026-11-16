/**
 * Workspace: rename, whether AI assistants may make changes, a time-limited read-only support grant,
 * a one-time export of the whole workspace database, and deleting the workspace (typing its name).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, LifeBuoy, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { Select } from "../../../components/ui/select";
import { SwitchField } from "../../../components/ui/switch";
import { Textarea } from "../../../components/ui/textarea";
import { toast } from "../../../components/ui/toaster";
import { ReauthCancelled, withReauth } from "../../../lib/reauth";
import { SectionIntro, SettingRow, SettingsGroup } from "../../settings/settings-ui";
import { cloudApi, exportDownloadPath } from "../client";
import { fmtDateTime } from "../format";
import { nav } from "../next";
import { failToast, Loading, LoadError, TypedConfirmDialog } from "../settings-kit";
import { describeError, Notice, TextField, useErrorFocus } from "../ui";

export function WorkspaceSection() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["cloud", "workspace"],
    queryFn: cloudApi.workspaceSettings,
    retry: false,
  });
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | undefined>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  useEffect(() => {
    if (q.data) setName(q.data.name);
  }, [q.data]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["cloud", "workspace"] });
    void qc.invalidateQueries({ queryKey: ["session"] });
  };
  const save = useMutation({
    mutationFn: (b: { name?: string; mcpWrites?: boolean }) => cloudApi.updateWorkspace(b),
    onSuccess: (_r, b) => {
      refresh();
      toast({
        title: b.name !== undefined ? "Workspace renamed" : "Setting saved",
        tone: "positive",
      });
    },
    onError: (e) => {
      refresh();
      failToast("Not saved", e);
    },
  });

  if (q.isLoading) return <Loading what="the workspace" />;
  if (q.isError || !q.data)
    return <LoadError error={q.error} what="The workspace" onRetry={() => void q.refetch()} />;
  const w = q.data;
  const owner = w.role === "owner";

  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setNameError("Give the workspace a name.");
    setNameError(undefined);
    save.mutate({ name: name.trim() });
  };

  return (
    <>
      <SectionIntro title="Workspace">
        {owner
          ? "Settings for the whole workspace and everyone in it."
          : "Settings for the whole workspace. Only the owner can change them."}
      </SectionIntro>

      <SettingsGroup title="Name">
        <form onSubmit={rename} className="flex flex-col gap-3 px-5 py-4" noValidate>
          <TextField
            large={false}
            label="Workspace name"
            value={name}
            onChange={setName}
            maxLength={200}
            disabled={!owner}
            error={nameError}
          />
          {owner ? (
            <div>
              <Button type="submit" size="sm" disabled={save.isPending || name.trim() === w.name}>
                {save.isPending && save.variables?.name !== undefined ? (
                  <Loader2 className="animate-spin" />
                ) : null}
                Save name
              </Button>
            </div>
          ) : null}
        </form>
      </SettingsGroup>

      <SettingsGroup title="AI assistants">
        <div className="px-5 py-4">
          <SwitchField
            label="Allow AI assistants to make changes"
            hint="When off, assistants connected through MCP can read your plans and run simulations but cannot change anything. Turn it on only for assistants you trust with edits."
            checked={w.mcpWrites === true}
            disabled={!owner || save.isPending}
            onCheckedChange={(v) => save.mutate({ mcpWrites: v })}
          />
        </div>
      </SettingsGroup>

      {owner ? <SupportAccess /> : null}
      {owner ? <ExportGroup /> : null}

      {owner ? (
        <SettingsGroup title="Delete workspace">
          <SettingRow
            label="Delete this workspace"
            hint="Permanently deletes its plans, finances and history for everyone in it, and cancels the subscription at once without a further charge."
          >
            <Button size="sm" variant="danger" onClick={() => setDeleteOpen(true)}>
              <Trash2 /> Delete workspace…
            </Button>
          </SettingRow>
        </SettingsGroup>
      ) : null}

      <TypedConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this workspace?"
        description="This cannot be undone."
        expected={w.name}
        fieldLabel="Type the workspace name to confirm"
        confirmLabel="Delete workspace"
        body={
          <div className="flex flex-col gap-2 text-[12.5px] text-ink-2">
            <p>
              When you delete your workspace we delete its live database at once and destroy the key
              that encrypts its backups, so every backup copy becomes unreadable immediately. The
              encrypted backup files are removed from storage within 30 days. Our hosting
              provider&rsquo;s whole-disk snapshots, kept for disaster recovery, expire within 7
              days. Invoices are kept by our payment provider as the law requires.
            </p>
            <p>
              Export the workspace first if you want a copy. Members will be told it was deleted.
            </p>
          </div>
        }
        onConfirm={async () => {
          await withReauth(() => cloudApi.deleteWorkspace(w.name));
          toast({ title: `“${w.name}” was deleted`, tone: "positive" });
          qc.clear();
          nav.go("/");
        }}
      />
    </>
  );
}

// ------------------------------------------------------------------------------------ support access
function SupportAccess() {
  const qc = useQueryClient();
  const grants = useQuery({
    queryKey: ["cloud", "support"],
    queryFn: cloudApi.supportGrants,
    retry: false,
  });
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("3");
  const [error, setError] = useState<string | undefined>();
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { ref, failed } = useErrorFocus();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["cloud", "support"] });
  const revoke = useMutation({
    mutationFn: (id: string) => cloudApi.revokeSupportGrant(id),
    onSuccess: () => {
      refresh();
      toast({ title: "Support access ended", tone: "positive" });
    },
    onError: (e) => failToast("Could not end it", e),
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setCreated(null);
    if (!reason.trim()) {
      setError("Tell us what you want help with, so the person who looks knows why.");
      return failed();
    }
    setError(undefined);
    setBusy(true);
    try {
      const r = await cloudApi.createSupportGrant(reason.trim(), Number(days));
      setCreated(r.expiresAt);
      setReason("");
      refresh();
    } catch (err) {
      setError(describeError(err));
      failed();
    }
    setBusy(false);
  };

  const now = Date.now();
  const items = grants.data?.items ?? [];
  const active = items.filter((g) => !g.revokedAt && Date.parse(g.expiresAt) > now);

  return (
    <SettingsGroup
      title="Support access"
      description="Glideworth support can see your workspace only while a grant is active. It is read-only, limited to 7 days, and every view is logged and shown to you."
    >
      <form ref={ref} onSubmit={submit} className="flex flex-col gap-3 px-5 py-4" noValidate>
        <div className="flex flex-col gap-1">
          <label htmlFor="support-reason" className="text-[12px] font-medium text-ink-2">
            What do you need help with?
          </label>
          <Textarea
            id="support-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            rows={2}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "support-reason-error" : undefined}
          />
          {error ? (
            <p id="support-reason-error" className="text-[11.5px] text-negative">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span aria-hidden className="text-[12px] font-medium text-ink-2">
              Allow access for
            </span>
            <Select
              aria-label="Allow support access for"
              className="w-[140px]"
              value={days}
              onValueChange={setDays}
              options={[
                { value: "1", label: "1 day" },
                { value: "3", label: "3 days" },
                { value: "7", label: "7 days" },
              ]}
            />
          </div>
          <Button type="submit" size="sm" variant="primary" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <LifeBuoy />} Grant access
          </Button>
        </div>
        <div role="status" aria-live="polite">
          {created ? (
            <Notice>
              Support can see your workspace until {fmtDateTime(created, navigator.language)}.
            </Notice>
          ) : null}
        </div>
      </form>
      {grants.isLoading ? (
        <Loading what="support grants" />
      ) : grants.isError ? (
        <LoadError
          error={grants.error}
          what="Support grants"
          onRetry={() => void grants.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState icon={LifeBuoy} title="No support access given" compact />
      ) : (
        <ul>
          {items.map((g) => {
            const live = active.includes(g);
            return (
              <li
                key={g.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
                    {g.reason || "No reason given"}
                    {live ? (
                      <Badge tone="accent">Active</Badge>
                    ) : (
                      <Badge>{g.revokedAt ? "Ended" : "Expired"}</Badge>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-ink-3">
                    {live ? "Until" : "Was until"}{" "}
                    {fmtDateTime(g.revokedAt ?? g.expiresAt, navigator.language)}
                  </div>
                </div>
                {live ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-negative"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(g.id)}
                  >
                    End now
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </SettingsGroup>
  );
}

// ------------------------------------------------------------------------------------------- export
function ExportGroup() {
  const [ready, setReady] = useState<{ id: string; expiresAt: string } | null>(null);
  const exportDb = useMutation({
    mutationFn: () => withReauth(() => cloudApi.exportWorkspace()),
    onSuccess: (r) => setReady({ id: r.exportId, expiresAt: r.expiresAt }),
    onError: (e) => {
      if (!(e instanceof ReauthCancelled)) failToast("Could not prepare the export", e);
    },
  });
  return (
    <SettingsGroup title="Export">
      <SettingRow
        label="Export the whole workspace"
        hint="A copy of the workspace database that you can run yourself with self-hosted Glideworth. The download link works once and for 24 hours."
      >
        <Button size="sm" disabled={exportDb.isPending} onClick={() => exportDb.mutate()}>
          {exportDb.isPending ? <Loader2 className="animate-spin" /> : <Download />} Prepare export
        </Button>
      </SettingRow>
      <div role="status" aria-live="polite" className="empty:hidden">
        {ready ? (
          <div className="flex flex-wrap items-center gap-3 px-5 py-3.5">
            <p className="min-w-0 flex-1 text-[13px] text-ink-2">
              Your export is ready. It can be downloaded once, until{" "}
              {fmtDateTime(ready.expiresAt, navigator.language)}. We have also emailed you.
            </p>
            <Button size="sm" variant="primary" asChild>
              <a href={exportDownloadPath(ready.id)} download>
                <Download /> Download
              </a>
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsGroup>
  );
}
