/** Sign out and change the passphrase (only shown when signed in with a browser session). */
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, LogOut } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { Input } from "../../components/ui/input";
import { toast } from "../../components/ui/toaster";
import {
  AuthError,
  changePassphrase,
  MIN_PASSPHRASE,
  signOut,
  signOutEverywhere,
  useSession,
} from "../../lib/auth";
import { SettingRow, SettingsGroup } from "./settings-ui";

export function SecurityGroup() {
  const session = useSession();
  const qc = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  if (session.data?.kind !== "authenticated" || session.data.via !== "session") return null;

  const change = async (e: FormEvent) => {
    e.preventDefault();
    if (next.length < MIN_PASSPHRASE) {
      toast({ title: `Use at least ${MIN_PASSPHRASE} characters`, tone: "negative" });
      return;
    }
    setBusy(true);
    try {
      await changePassphrase(current, next);
      setCurrent("");
      setNext("");
      toast({
        title: "Passphrase changed",
        description: "Every other signed-in browser was signed out.",
        tone: "positive",
      });
    } catch (err) {
      toast({
        title: "Passphrase not changed",
        description: err instanceof AuthError ? err.message : String(err),
        tone: "negative",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup
      title="Security"
      description={
        session.data.user
          ? `Signed in as ${session.data.user.name} (${session.data.user.role}).`
          : "This browser is signed in with your passphrase."
      }
    >
      <SettingRow
        label="Sign out"
        hint="Ends this browser’s session. Your data stays on the server."
      >
        <Button
          size="sm"
          onClick={async () => {
            await signOut().catch(() => undefined);
            // Drop every cached figure and start the app afresh at the sign-in screen. Clearing the
            // query cache alone left mounted pages showing the old data with a dead session.
            qc.clear();
            window.location.replace("/");
          }}
        >
          <LogOut /> Sign out
        </Button>
      </SettingRow>
      <SettingRow
        label="Sign out everywhere"
        hint="Ends every session of yours: other browsers, phones and this one. Use it if a device was lost."
      >
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            if (
              !(await confirmAction({
                title: "Sign out everywhere?",
                description:
                  "Every browser signed in as you, including this one, will need your passphrase again.",
                confirmLabel: "Sign out everywhere",
              }))
            )
              return;
            await signOutEverywhere().catch(() => undefined);
            qc.clear();
            window.location.replace("/");
          }}
        >
          <LogOut /> Sign out everywhere
        </Button>
      </SettingRow>
      <form onSubmit={change} className="flex flex-col gap-3 px-5 py-4">
        <div className="text-[13px] font-medium text-ink">Change passphrase</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            type="password"
            aria-label="Current passphrase"
            placeholder="Current passphrase"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <Input
            type="password"
            aria-label="New passphrase"
            placeholder={`New passphrase (${MIN_PASSPHRASE}+ characters)`}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </div>
        <div>
          <Button type="submit" size="sm" disabled={busy || !current || !next}>
            {busy ? <Loader2 className="animate-spin" /> : null} Change passphrase
          </Button>
        </div>
      </form>
    </SettingsGroup>
  );
}
