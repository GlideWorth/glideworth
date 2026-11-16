/**
 * "Confirm it is you": the prompt behind `withReauth` (lib/reauth.ts). Sensitive actions need a password
 * (or authenticator code) check made within the last 10 minutes; once it passes, the action that was
 * refused runs again.
 *
 * A Google sign-in is not such a check (packages/cloud: Google cannot be asked to confirm a recent
 * sign-in). An account without a password confirms with an authenticator code when it has one; otherwise
 * it is offered the emailed link that sets a first password, which is itself a fresh check of the inbox.
 */
import { Loader2, Mail } from "lucide-react";
import { type FormEvent, useState } from "react";
import { PassField } from "../../components/layout/auth-gate";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { useCloudSession } from "../../lib/auth";
import { settleReauth, useReauthOpen } from "../../lib/reauth";
import { cloudApi } from "./client";
import { describeError, Notice, TextField, useErrorFocus } from "./ui";

export function ReauthHost() {
  const open = useReauthOpen();
  const user = useCloudSession()?.user;
  const password = user?.password !== false;
  const totp = user?.totp === true;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && settleReauth(false)}>
      {open ? (
        <DialogContent
          title="Confirm it is you"
          description={
            password
              ? "This change needs a recent check. Enter your password to continue."
              : totp
                ? "This change needs a recent check. Enter the code from your authenticator app."
                : "This change needs a recent check, and your account has no password yet."
          }
        >
          {password || totp ? <ReauthForm /> : <SetPasswordFirst email={user?.email ?? ""} />}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** No password and no authenticator: the emailed link that sets a password is the way to confirm. */
function SetPasswordFirst({ email }: { email: string }) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await cloudApi.passwordSetup();
      setSent(true);
    } catch (err) {
      setError(describeError(err));
    }
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-ink-2">
        Signing in with Google does not count as this check. Set a password first: we email a link
        to {email || "your address"}. After you choose the password, sign in again and repeat this
        change.
      </p>
      {sent ? <Notice>Check your email for the link.</Notice> : null}
      {error ? (
        <p role="alert" className="text-[12.5px] text-negative">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => settleReauth(false)}>
          {sent ? "Done" : "Cancel"}
        </Button>
        {sent ? null : (
          <Button type="button" variant="primary" disabled={busy} onClick={() => void send()}>
            {busy ? <Loader2 className="animate-spin" /> : <Mail />} Email me the link
          </Button>
        )}
      </div>
    </div>
  );
}

function ReauthForm() {
  const user = useCloudSession()?.user;
  const totp = user?.totp === true;
  const password = user?.password !== false;
  const [useCode, setUseCode] = useState(!password);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { ref, failed } = useErrorFocus();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!secret.trim()) {
      setError(useCode ? "Enter the 6-digit code." : "Enter your password.");
      failed();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await cloudApi.reauth(
        useCode ? { totpCode: secret.replace(/\s/g, "") } : { password: secret },
      );
      settleReauth(true);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
      failed();
    }
  };

  return (
    <form ref={ref} onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {useCode ? (
        <TextField
          label="Authenticator code"
          value={secret}
          onChange={setSecret}
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={8}
          focusOnMount
          mono
          error={error ?? undefined}
        />
      ) : (
        <PassField
          label="Password"
          noun="password"
          value={secret}
          onChange={setSecret}
          autoComplete="current-password"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- first field of a single-purpose screen
          autoFocus
          error={error ?? undefined}
        />
      )}
      {totp && password ? (
        <button
          type="button"
          className="self-start text-[12.5px] text-accent underline underline-offset-2"
          onClick={() => {
            setUseCode((v) => !v);
            setSecret("");
            setError(null);
          }}
        >
          {useCode ? "Use my password instead" : "Use an authenticator code instead"}
        </button>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => settleReauth(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : null} Continue
        </Button>
      </div>
    </form>
  );
}
