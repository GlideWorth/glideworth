/**
 * Security: sign-in methods (password set or not, Google linked or not), password, two-step sign-in (QR code
 * drawn here, no network call; manual key; recovery codes shown once), and the browsers that are signed in.
 * Actions that need a recent password check go through `withReauth`, which asks and then repeats the action.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Download,
  KeyRound,
  Loader2,
  LogOut,
  Link2,
  Mail,
  ShieldCheck,
  ShieldOff,
  Unlink,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { PassField } from "../../../components/layout/auth-gate";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { confirmAction } from "../../../components/ui/confirm-dialog";
import { Dialog, DialogContent } from "../../../components/ui/dialog";
import { toast } from "../../../components/ui/toaster";
import { relativeTime } from "../../../lib/format";
import { ReauthCancelled, withReauth } from "../../../lib/reauth";
import { SectionIntro, SettingRow, SettingsGroup } from "../../settings/settings-ui";
import { cloudApi, type SessionRow } from "../client";
import { GoogleLogo, googleProblem } from "../google-button";
import { nav } from "../next";
import { PASSWORD_RULES, passwordProblem } from "../password-rules";
import { encodeQr } from "../qr";
import { failToast, Loading, LoadError } from "../settings-kit";
import { describeError, Notice, StrengthMeter, TextField, useErrorFocus } from "../ui";
import { useLocale } from "../../../lib/workspace";

// ------------------------------------------------------------------------------------------- the QR
/** An inline SVG: black on a white card with the quiet zone the standard asks for, in both themes. */
function QrCode({ text, label }: { text: string; label: string }) {
  const rows = useMemo(() => {
    try {
      return encodeQr(text);
    } catch {
      return null;
    }
  }, [text]);
  if (!rows) return null;
  const quiet = 4;
  const n = rows.length + quiet * 2;
  let d = "";
  rows.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }),
  );
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${n} ${n}`}
      shapeRendering="crispEdges"
      className="size-44 shrink-0 rounded-lg border border-border bg-white"
    >
      <path d={d} fill="#000" />
    </svg>
  );
}

const groupKey = (secret: string) =>
  secret
    .replace(/\s/g, "")
    .replace(/(.{4})/g, "$1 ")
    .trim();

function CopyText({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          toast({
            title: "Copy failed",
            description: "Select the text and copy it by hand.",
            tone: "negative",
          });
        }
      }}
    >
      {done ? <Check /> : <Copy />} {done ? "Copied" : label}
    </Button>
  );
}

// ---------------------------------------------------------------------------------------- the page
export function SecuritySection() {
  return (
    <>
      <SectionIntro title="Security">
        Keep your account yours: a strong password, a second step at sign-in, and a look at where
        you are signed in.
      </SectionIntro>
      <SignInMethodsGroup />
      <PasswordGroup />
      <TwoFactorGroup />
      <SessionsGroup />
    </>
  );
}

// ------------------------------------------------------------------------------------ sign-in methods
const useProfile = () =>
  useQuery({ queryKey: ["cloud", "profile"], queryFn: cloudApi.profile, retry: false });

/** The answer of a Google link round trip (`?google=` on this page), read once. */
function useGoogleResult(): { tone: "positive" | "warning"; text: string } | null {
  const [r] = useState(() => {
    const code = new URLSearchParams(window.location.search).get("google");
    if (code === "linked") return { tone: "positive" as const, text: "Google account linked." };
    const problem = googleProblem(code);
    return problem ? { tone: "warning" as const, text: problem } : null;
  });
  return r;
}

function SignInMethodsGroup() {
  const qc = useQueryClient();
  const profile = useProfile();
  const result = useGoogleResult();
  const [sent, setSent] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["cloud", "profile"] });
    void qc.invalidateQueries({ queryKey: ["session"] });
  };
  const setup = useMutation({
    mutationFn: () => cloudApi.passwordSetup(),
    onSuccess: () => setSent(true),
    onError: (e) => failToast("Could not send the link", e),
  });
  const link = useMutation({
    mutationFn: () => withReauth(() => cloudApi.linkGoogle()),
    // A full-page navigation to Google; it comes back to this page with `?google=…`.
    onSuccess: (r) => nav.go(r.url),
    onError: (e) => {
      if (!(e instanceof ReauthCancelled)) failToast("Could not start linking Google", e);
    },
  });
  const unlink = useMutation({
    mutationFn: () => withReauth(() => cloudApi.unlinkGoogle()),
    onSuccess: () => {
      refresh();
      toast({ title: "Google account unlinked", tone: "positive" });
    },
    onError: (e) => {
      if (!(e instanceof ReauthCancelled)) failToast("Could not unlink Google", e);
    },
  });

  if (profile.isLoading)
    return (
      <SettingsGroup title="Sign-in methods">
        <Loading what="sign-in methods" />
      </SettingsGroup>
    );
  if (profile.isError || !profile.data)
    return (
      <SettingsGroup title="Sign-in methods">
        <LoadError
          error={profile.error}
          what="Sign-in methods"
          onRetry={() => void profile.refetch()}
        />
      </SettingsGroup>
    );
  const p = profile.data;
  const passwordSet = p.passwordSet !== false;
  const google = p.identities?.find((i) => i.provider === "google");
  const offerGoogle = p.googleSignIn === true || !!google;

  return (
    <SettingsGroup title="Sign-in methods" description="The ways you can sign in to this account.">
      {result ? (
        <div className="px-5 py-3">
          <Notice tone={result.tone}>{result.text}</Notice>
        </div>
      ) : null}
      <SettingRow
        label="Password"
        hint={
          passwordSet
            ? "Set. You can change it below."
            : "Not set: you sign in with Google. A password lets you sign in without Google, and lets you confirm sensitive changes."
        }
      >
        {passwordSet ? (
          <Badge tone="accent">Set</Badge>
        ) : sent ? (
          <span role="status" className="text-[12.5px] text-ink-2">
            Check your email for the link.
          </span>
        ) : (
          <Button size="sm" disabled={setup.isPending} onClick={() => setup.mutate()}>
            {setup.isPending ? <Loader2 className="animate-spin" /> : <Mail />} Set a password
          </Button>
        )}
      </SettingRow>
      {sent ? (
        <div className="px-5 pb-3">
          <Notice>
            We sent a link to {p.email}. Open it to choose your password. Every browser is then
            signed out, and you sign in again.
          </Notice>
        </div>
      ) : null}
      {offerGoogle ? (
        <SettingRow
          label={
            <span className="inline-flex items-center gap-2">
              <GoogleLogo className="size-4" /> Google
            </span>
          }
          hint={
            google
              ? `Linked${google.email ? ` to ${google.email}` : ""}${google.linkedAt ? ` since ${new Date(google.linkedAt).toLocaleDateString()}` : ""}.${passwordSet ? "" : " Set a password before you unlink it, or you could not sign in."}`
              : "Not linked. Link a Google account to sign in with it."
          }
        >
          {google ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-negative"
              disabled={!passwordSet || unlink.isPending}
              onClick={async () => {
                if (
                  await confirmAction({
                    title: "Unlink Google?",
                    description:
                      "You will no longer be able to sign in with that Google account. Your password still works.",
                    confirmLabel: "Unlink",
                    tone: "danger",
                  })
                )
                  unlink.mutate();
              }}
            >
              {unlink.isPending ? <Loader2 className="animate-spin" /> : <Unlink />} Unlink
            </Button>
          ) : (
            <Button size="sm" disabled={link.isPending} onClick={() => link.mutate()}>
              {link.isPending ? <Loader2 className="animate-spin" /> : <Link2 />} Link Google
              account
            </Button>
          )}
        </SettingRow>
      ) : null}
    </SettingsGroup>
  );
}

function PasswordGroup() {
  const profile = useProfile();
  if (profile.data?.passwordSet === false)
    return (
      <SettingsGroup title="Password">
        <p className="px-5 py-4 text-[12.5px] text-ink-2">
          You have no password yet. Use &ldquo;Set a password&rdquo; under Sign-in methods.
        </p>
      </SettingsGroup>
    );
  return <ChangePasswordGroup />;
}

function ChangePasswordGroup() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string }>({});
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const { ref, failed } = useErrorFocus();
  const qc = useQueryClient();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setDone(false);
    const errs: typeof errors = {};
    if (!current) errs.current = "Enter your current password.";
    const problem = passwordProblem(next, "");
    if (problem) errs.next = problem;
    if (confirm !== next) errs.confirm = "The passwords do not match.";
    setErrors(errs);
    if (Object.keys(errs).length) return failed();
    setBusy(true);
    try {
      await withReauth(() => cloudApi.changePassword(current, next));
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
      void qc.invalidateQueries({ queryKey: ["cloud", "sessions"] });
    } catch (err) {
      if (!(err instanceof ReauthCancelled)) {
        const msg = describeError(err);
        setErrors(
          err instanceof Error && /current password/i.test(err.message)
            ? { current: msg }
            : { next: msg },
        );
        failed();
      }
    }
    setBusy(false);
  };

  return (
    <SettingsGroup title="Password">
      <form ref={ref} onSubmit={submit} className="flex flex-col gap-3 px-5 py-4" noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <PassField
            label="Current password"
            noun="current password"
            name="current-password"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
            error={errors.current}
          />
          <div />
          <PassField
            label="New password"
            noun="new password"
            name="new-password"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            error={errors.next}
            hint={PASSWORD_RULES}
          />
          <PassField
            label="Confirm new password"
            noun="new password confirmation"
            name="confirm-password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            error={errors.confirm}
          />
        </div>
        <StrengthMeter password={next} />
        <div role="status" aria-live="polite">
          {done ? (
            <Notice>Password changed. Every other signed-in browser was signed out.</Notice>
          ) : null}
        </div>
        <div>
          <Button type="submit" size="sm" variant="primary" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <KeyRound />} Change password
          </Button>
        </div>
      </form>
    </SettingsGroup>
  );
}

// ------------------------------------------------------------------------------------- two-factor
interface Enrolment {
  secret: string;
  otpauthUri: string;
}

function TwoFactorGroup() {
  const qc = useQueryClient();
  const profile = useProfile();
  const [enrol, setEnrol] = useState<Enrolment | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["cloud", "profile"] });
    void qc.invalidateQueries({ queryKey: ["session"] });
  };

  const begin = useMutation({
    mutationFn: () => withReauth(() => cloudApi.totpBegin()),
    onSuccess: setEnrol,
    onError: (e) => failToast("Could not start two-step sign-in", e),
  });
  const regenerate = useMutation({
    mutationFn: () => withReauth(() => cloudApi.regenerateRecoveryCodes()),
    onSuccess: (r) => setCodes(r.recoveryCodes),
    onError: (e) => failToast("Could not make new recovery codes", e),
  });

  if (profile.isLoading)
    return (
      <SettingsGroup title="Two-step sign-in">
        <Loading what="two-step sign-in" />
      </SettingsGroup>
    );
  if (profile.isError || !profile.data)
    return (
      <SettingsGroup title="Two-step sign-in">
        <LoadError
          error={profile.error}
          what="Two-step sign-in"
          onRetry={() => void profile.refetch()}
        />
      </SettingsGroup>
    );
  const on = profile.data.twoFactorEnabled === true;

  return (
    <>
      <SettingsGroup
        title="Two-step sign-in"
        description="After your password, sign-in asks for a 6-digit code from an authenticator app."
        actions={
          on ? (
            <Badge tone="accent">
              <ShieldCheck className="size-3" aria-hidden /> On
            </Badge>
          ) : (
            <Badge>Off</Badge>
          )
        }
      >
        {on ? (
          <>
            <SettingRow
              label="Recovery codes"
              hint="Ten single-use codes for when you do not have your phone. Making new ones stops the old ones working."
            >
              <Button
                size="sm"
                disabled={regenerate.isPending}
                onClick={async () => {
                  if (
                    await confirmAction({
                      title: "Make new recovery codes?",
                      description:
                        "The codes you have now will stop working. You will see the new ones once.",
                      confirmLabel: "Make new codes",
                      tone: "primary",
                    })
                  )
                    regenerate.mutate();
                }}
              >
                {regenerate.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />} New
                recovery codes
              </Button>
            </SettingRow>
            <SettingRow
              label="Turn off two-step sign-in"
              hint="Sign-in goes back to the password alone. You need a current code or a recovery code."
            >
              <Button size="sm" variant="danger" onClick={() => setDisableOpen(true)}>
                <ShieldOff /> Turn off…
              </Button>
            </SettingRow>
          </>
        ) : (
          <SettingRow
            label="Use an authenticator app"
            hint="Recommended, especially for the workspace owner. Works with any app that supports 6-digit codes."
          >
            <Button
              size="sm"
              variant="primary"
              disabled={begin.isPending}
              onClick={() => begin.mutate()}
            >
              {begin.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Turn on
            </Button>
          </SettingRow>
        )}
      </SettingsGroup>

      <EnrolDialog
        enrolment={enrol}
        onClose={() => setEnrol(null)}
        onEnabled={(c) => {
          setEnrol(null);
          setCodes(c);
          refresh();
        }}
      />
      <RecoveryCodesDialog codes={codes} onClose={() => setCodes(null)} />
      <DisableDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        onDisabled={() => {
          setDisableOpen(false);
          refresh();
          toast({ title: "Two-step sign-in is off", tone: "positive" });
        }}
      />
    </>
  );
}

function EnrolDialog({
  enrolment,
  onClose,
  onEnabled,
}: {
  enrolment: Enrolment | null;
  onClose: () => void;
  onEnabled: (codes: string[]) => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const { ref, failed } = useErrorFocus();
  useEffect(() => {
    if (!enrolment) {
      setCode("");
      setError(undefined);
      setBusy(false);
    }
  }, [enrolment]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const value = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(value)) {
      setError("Enter the 6-digit code from your app.");
      return failed();
    }
    setBusy(true);
    setError(undefined);
    try {
      const r = await cloudApi.totpConfirm(value);
      onEnabled(r.recoveryCodes);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
      failed();
    }
  };

  return (
    <Dialog open={!!enrolment} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Turn on two-step sign-in"
        description="Scan the code with your authenticator app, then enter the 6-digit code it shows."
        className="max-h-[92dvh] w-[min(94vw,560px)] overflow-y-auto"
      >
        {enrolment ? (
          <form ref={ref} onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
              <QrCode text={enrolment.otpauthUri} label="QR code for your authenticator app" />
              <div className="flex min-w-0 flex-col gap-2 text-[12.5px] text-ink-2">
                <p>
                  Cannot scan it? Choose &ldquo;enter a setup key&rdquo; in your app and type this
                  key (spaces do not matter):
                </p>
                <code className="rounded-md border border-border bg-surface-2 px-2.5 py-2 font-mono text-[13px] break-all text-ink select-all">
                  {groupKey(enrolment.secret)}
                </code>
                <div>
                  <CopyText text={enrolment.secret} label="Copy key" />
                </div>
                <p className="text-ink-3">
                  The code is drawn in this page; it is not sent to any other service. Keep this key
                  private.
                </p>
              </div>
            </div>
            <TextField
              large={false}
              label="6-digit code"
              value={code}
              onChange={setCode}
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={9}
              mono
              focusOnMount
              error={error}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : null} Turn on
              </Button>
            </div>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Recovery codes are shown once. Closing needs the person to say they have kept them. */
function RecoveryCodesDialog({ codes, onClose }: { codes: string[] | null; onClose: () => void }) {
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [codes]);
  const text = codes?.join("\n") ?? "";
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([`Glideworth recovery codes\nEach code works once.\n\n${text}\n`], {
        type: "text/plain",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "glideworth-recovery-codes.txt";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Dialog open={!!codes} onOpenChange={(o) => !o && saved && onClose()}>
      <DialogContent
        title="Save your recovery codes"
        description="If you lose your phone, each of these signs you in once. They are shown only now."
      >
        <div className="flex flex-col gap-4">
          <ul
            className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-border bg-surface-2 px-4 py-3 font-mono text-[13px] text-ink select-all"
            aria-label="Recovery codes"
          >
            {codes?.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <CopyText text={text} label="Copy all" />
            <Button type="button" size="sm" onClick={download}>
              <Download /> Download
            </Button>
          </div>
          <label className="flex items-start gap-2.5 text-[13px] text-ink">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--accent)]"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
            />
            <span>I have saved these codes somewhere safe.</span>
          </label>
          <div className="flex justify-end">
            <Button variant="primary" disabled={!saved} onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DisableDialog({
  open,
  onOpenChange,
  onDisabled,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDisabled: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const { ref, failed } = useErrorFocus();
  useEffect(() => {
    if (!open) {
      setCode("");
      setError(undefined);
      setBusy(false);
    }
  }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const value = code.trim();
    if (!value) {
      setError("Enter a code from your app or a recovery code.");
      return failed();
    }
    setBusy(true);
    setError(undefined);
    try {
      await withReauth(() => cloudApi.totpDisable(value));
      onDisabled();
    } catch (err) {
      if (!(err instanceof ReauthCancelled)) {
        setError(describeError(err));
        failed();
      }
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Turn off two-step sign-in?"
        description="Anyone with your password will be able to sign in. Enter a current code, or one of your recovery codes."
      >
        <form ref={ref} onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <TextField
            large={false}
            label="Authenticator or recovery code"
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
            maxLength={24}
            mono
            focusOnMount
            error={error}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : null} Turn off
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------ sessions
function SessionsGroup() {
  const qc = useQueryClient();
  const locale = useLocale();
  const sessions = useQuery({
    queryKey: ["cloud", "sessions"],
    queryFn: cloudApi.sessions,
    retry: false,
  });
  const [message, setMessage] = useState("");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["cloud", "sessions"] });
  const revoke = useMutation({
    mutationFn: (s: SessionRow) => cloudApi.revokeSession(s.id),
    onSuccess: () => {
      setMessage("That browser was signed out.");
      refresh();
    },
    onError: (e) => failToast("Could not sign that browser out", e),
  });
  const revokeOthers = useMutation({
    mutationFn: () => cloudApi.revokeOtherSessions(),
    onSuccess: (r) => {
      setMessage(
        r.revoked === 1
          ? "1 other browser was signed out."
          : `${r.revoked} other browsers were signed out.`,
      );
      refresh();
    },
    onError: (e) => failToast("Could not sign the other browsers out", e),
  });
  const items = sessions.data?.items ?? [];
  const others = items.filter((s) => !s.current).length;

  return (
    <SettingsGroup
      title="Where you are signed in"
      description="Each browser or device with a session. Sign out any you do not recognise."
      actions={
        others > 0 ? (
          <Button size="sm" disabled={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
            {revokeOthers.isPending ? <Loader2 className="animate-spin" /> : <LogOut />} Sign out
            all others
          </Button>
        ) : null
      }
    >
      {sessions.isLoading ? (
        <Loading what="sessions" />
      ) : sessions.isError ? (
        <LoadError error={sessions.error} what="Sessions" onRetry={() => void sessions.refetch()} />
      ) : (
        <ul>
          {items.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-3 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink">
                  {s.device || "Unknown device"}
                  {s.current ? <Badge tone="accent">This browser</Badge> : null}
                </div>
                <div className="mt-0.5 text-[11.5px] text-ink-3">
                  Last active {relativeTime(s.lastSeenAt ?? null, locale).toLowerCase()}
                  {s.ip ? ` · ${s.ip}` : ""}
                </div>
              </div>
              {s.current ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-negative"
                  aria-label={`Sign out ${s.device || "unknown device"}`}
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(s)}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div
        role="status"
        aria-live="polite"
        className="px-5 py-2 text-[12px] text-ink-2 empty:hidden"
      >
        {message}
      </div>
    </SettingsGroup>
  );
}
