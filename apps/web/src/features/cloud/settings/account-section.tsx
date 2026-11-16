/** Account: name, email address, emails we send, your data, sign out and deleting the account. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, LogOut, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent } from "../../../components/ui/dialog";
import { toast } from "../../../components/ui/toaster";
import { SwitchField } from "../../../components/ui/switch";
import { ReauthCancelled, withReauth } from "../../../lib/reauth";
import { SectionIntro, SettingRow, SettingsGroup } from "../../settings/settings-ui";
import { cloudApi } from "../client";
import { nav } from "../next";
import { Loading, LoadError, failToast, TypedConfirmDialog } from "../settings-kit";
import { describeError, Notice, TextField, useErrorFocus } from "../ui";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Save JSON the server sent as a file (no network call beyond the one that fetched it). */
function saveJson(filename: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AccountSection() {
  const qc = useQueryClient();
  const profile = useQuery({
    queryKey: ["cloud", "profile"],
    queryFn: cloudApi.profile,
    retry: false,
  });
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | undefined>();
  useEffect(() => {
    if (profile.data) setName(profile.data.name);
  }, [profile.data]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["cloud", "profile"] });
    void qc.invalidateQueries({ queryKey: ["session"] });
  };

  const save = useMutation({
    mutationFn: (b: { name?: string; signinAlerts?: boolean; checkinEmails?: boolean }) =>
      cloudApi.updateProfile(b),
    onSuccess: (_r, b) => {
      refresh();
      if (b.name !== undefined) toast({ title: "Name saved", tone: "positive" });
    },
    onError: (e) => {
      refresh();
      failToast("Not saved", e);
    },
  });

  const saveName = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setNameError("Enter your name.");
    setNameError(undefined);
    save.mutate({ name: name.trim() });
  };

  const [emailOpen, setEmailOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  if (profile.isLoading) return <Loading what="your account" />;
  if (profile.isError || !profile.data)
    return (
      <LoadError error={profile.error} what="Your account" onRetry={() => void profile.refetch()} />
    );
  const p = profile.data;

  return (
    <>
      <SectionIntro title="Account">
        Who you are on Glideworth. These settings follow you across every workspace you belong to.
      </SectionIntro>
      <SettingsGroup title="Profile">
        <form onSubmit={saveName} className="flex flex-col gap-3 px-5 py-4" noValidate>
          <TextField
            large={false}
            label="Name"
            value={name}
            onChange={setName}
            autoComplete="name"
            maxLength={200}
            error={nameError}
          />
          <div>
            <Button type="submit" size="sm" disabled={save.isPending || name.trim() === p.name}>
              {save.isPending && save.variables?.name !== undefined ? (
                <Loader2 className="animate-spin" />
              ) : null}
              Save name
            </Button>
          </div>
        </form>
        <SettingRow
          label="Email address"
          hint="You sign in with it, and we send account messages to it. Changing it needs your password and a click on a link sent to the new address."
          htmlFor="account-email"
        >
          <div className="flex flex-wrap items-center gap-3">
            <span id="account-email" className="text-[13px] break-all text-ink">
              {p.email}
            </span>
            <Button size="sm" onClick={() => setEmailOpen(true)}>
              Change email
            </Button>
          </div>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Emails" description="Security messages are always sent.">
        <div className="px-5 py-4">
          <SwitchField
            label="Email me when someone signs in from a new device"
            hint="Recommended. We never include your password or any codes."
            checked={p.signinAlerts !== false}
            disabled={save.isPending}
            onCheckedChange={(v) => save.mutate({ signinAlerts: v })}
          />
        </div>
        <div className="px-5 py-4">
          <SwitchField
            label="Email me plan check-in summaries"
            hint="A short note when a scheduled check-in finds something to look at."
            checked={p.checkinEmails !== false}
            disabled={save.isPending}
            onCheckedChange={(v) => save.mutate({ checkinEmails: v })}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup title="Your data">
        <SettingRow
          label="Download my data"
          hint="Your profile, workspace memberships, signed-in browsers and security events, as a JSON file. Your plans and finances are exported from Workspace settings."
        >
          <Button
            size="sm"
            disabled={downloading}
            onClick={async () => {
              setDownloading(true);
              try {
                saveJson("glideworth-personal-data.json", await cloudApi.personalData());
                toast({ title: "Download started", tone: "positive" });
              } catch (e) {
                failToast("Could not download your data", e);
              }
              setDownloading(false);
            }}
          >
            {downloading ? <Loader2 className="animate-spin" /> : <Download />} Download
          </Button>
        </SettingRow>
        <SettingRow
          label="Sign out"
          hint="Ends this browser's session. Your data stays in your workspace."
        >
          <Button
            size="sm"
            onClick={async () => {
              await cloudApi.signOut().catch(() => undefined);
              qc.clear();
              nav.go("/signin");
            }}
          >
            <LogOut /> Sign out
          </Button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Delete account">
        <SettingRow
          label="Delete my account"
          hint="Deletes you and your sign-in. If you are the only member of your workspace, the workspace and all its plans are deleted with you. You cannot delete your account while you own a workspace that has other members: transfer ownership or delete the workspace first."
        >
          <Button size="sm" variant="danger" onClick={() => setDeleteOpen(true)}>
            <Trash2 /> Delete account…
          </Button>
        </SettingRow>
      </SettingsGroup>

      <ChangeEmailDialog open={emailOpen} onOpenChange={setEmailOpen} current={p.email} />
      <TypedConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete your account?"
        description="This cannot be undone."
        expected={p.email}
        fieldLabel="Type your email address to confirm"
        confirmLabel="Delete account"
        caseSensitive={false}
        body={
          <div className="flex flex-col gap-2 text-[12.5px] text-ink-2">
            <p>
              When you delete a workspace we delete its live database at once and destroy the key
              that encrypts its backups, so every backup copy becomes unreadable immediately. The
              encrypted backup files are removed from storage within 30 days. Our hosting
              provider&rsquo;s whole-disk snapshots, kept for disaster recovery, expire within 7
              days. Invoices are kept by our payment provider as the law requires.
            </p>
            <p>Download your data or export your workspace first if you want a copy.</p>
          </div>
        }
        onConfirm={async () => {
          await withReauth(() => cloudApi.deleteAccount());
          qc.clear();
          nav.go("/signin?deleted=1");
        }}
      />
    </>
  );
}

function ChangeEmailDialog({
  open,
  onOpenChange,
  current,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  current: string;
}) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { ref, failed } = useErrorFocus();
  useEffect(() => {
    if (!open) {
      setEmail("");
      setError(undefined);
      setSentTo(null);
      setBusy(false);
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const next = email.trim();
    if (!EMAIL.test(next)) {
      setError("Enter a valid email address.");
      return failed();
    }
    if (next.toLowerCase() === current.toLowerCase()) {
      setError("That is already your address.");
      return failed();
    }
    setBusy(true);
    setError(undefined);
    try {
      await withReauth(() => cloudApi.changeEmail(next));
      setSentTo(next);
    } catch (err) {
      if (!(err instanceof ReauthCancelled)) {
        setError(describeError(err));
        failed();
      }
    }
    setBusy(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Change your email address"
        description="We send a link to the new address. Your address changes only when you open it."
      >
        <form ref={ref} onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <TextField
            large={false}
            label="New email address"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
            inputMode="email"
            error={error}
            focusOnMount
          />
          <div role="status" aria-live="polite">
            {sentTo ? (
              <Notice>
                If {sentTo} can be used, we have sent a confirmation link to it. We have also told
                your current address about the request.
              </Notice>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {sentTo ? "Close" : "Cancel"}
            </Button>
            {sentTo ? null : (
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : null} Send confirmation link
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
