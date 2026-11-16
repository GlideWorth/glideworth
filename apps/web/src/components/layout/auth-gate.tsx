/**
 * Sign-in for production deployments (cookie session). Dev and bearer-key deployments have no
 * session routes, so the gate is transparent there.
 */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Eye, EyeOff, Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import {
  AuthError,
  acceptInvite,
  MIN_PASSPHRASE,
  passphraseStrength,
  type SessionState,
  setUpPassphrase,
  signIn,
  useRefreshSession,
  useSession,
} from "../../lib/auth";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { inputBase } from "../ui/input";
import { GlideworthMark } from "./logo";

export function AuthGate({ children }: { children: ReactNode }) {
  const session = useSession();
  if (session.isLoading) return <Splash />;
  const state: SessionState = session.data ?? { kind: "disabled" };
  if (state.kind === "cloud-signed-out") return <CloudSignedOut />;
  if (state.kind === "login" || state.kind === "setup")
    return <AuthScreen mode={state.kind} multiUser={state.kind === "login" && !!state.multiUser} />;
  return <>{children}</>;
}

/** Hosted mode, no session: go to the cloud sign-in page, remembering where the person was going. */
function CloudSignedOut() {
  const navigate = useNavigate();
  const here = useRouterState({ select: (s) => s.location.href });
  useEffect(() => {
    void navigate({ to: "/signin", search: here === "/" ? {} : { next: here }, replace: true });
  }, [navigate, here]);
  return <Splash />;
}

export function Splash() {
  return (
    <div
      className="flex h-dvh items-center justify-center bg-bg"
      role="status"
      aria-busy="true"
      aria-label="Loading Glideworth"
    >
      <GlideworthMark className="size-9 animate-pulse" />
    </div>
  );
}

export function PassField({
  label,
  value,
  onChange,
  autoComplete,
  autoFocus,
  invalid,
  noun = "passphrase",
  name,
  error,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  autoFocus?: boolean;
  invalid?: boolean;
  /** What the value is called in the show/hide button ("passphrase" here, "password" in the cloud screens). */
  noun?: string;
  name?: string;
  /** A message tied to the input (aria-describedby) and shown under it. */
  error?: string | undefined;
  hint?: ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const [show, setShow] = useState(false);
  const bad = invalid || !!error;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[12px] font-medium text-ink-2">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={name}
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the only field on a sign-in screen
          autoFocus={autoFocus}
          aria-invalid={bad || undefined}
          aria-describedby={error || hint ? noteId : undefined}
          spellCheck={false}
          autoCapitalize="none"
          className={cn(inputBase, "h-10 pr-10 text-[14px]")}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? `Hide ${noun}` : `Show ${noun}`}
          aria-pressed={show}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink"
        >
          {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {error ? (
        <p id={noteId} className="text-[11.5px] text-negative">
          {error}
        </p>
      ) : hint ? (
        <div id={noteId} className="text-[11.5px] text-ink-3">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export const STRENGTH = ["Too short", "Fair", "Good", "Strong"] as const;

export function AuthScreen({
  mode,
  multiUser = false,
}: {
  mode: "login" | "setup";
  multiUser?: boolean;
}) {
  const refresh = useRefreshSession();
  const [login, setLogin] = useState("");
  const loginId = useId();
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsToken, setNeedsToken] = useState(false);
  const [token, setToken] = useState("");
  const strength = passphraseStrength(pass);
  const setup = mode === "setup";
  const mismatch = setup && confirm.length > 0 && confirm !== pass;
  const canSubmit = setup ? strength >= 1 && confirm === pass : pass.length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (setup) await setUpPassphrase(pass, token.trim() || undefined);
      else await signIn(pass, multiUser ? login : undefined);
      await refresh();
    } catch (err) {
      if (
        err instanceof AuthError &&
        setup &&
        err.status === 403 &&
        !/csrf|origin/i.test(err.message)
      )
        setNeedsToken(true);
      setError(
        err instanceof AuthError
          ? err.message
          : "Glideworth could not be reached. Is the server running?",
      );
      setBusy(false);
    }
  };

  return (
    <main id="main" className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <GlideworthMark className="size-11" />
          <h1 className="display text-[26px] leading-tight font-semibold">
            {setup ? "Secure your Glideworth" : "Welcome back"}
          </h1>
          <p className="text-[13px] text-ink-2">
            {setup
              ? "Choose a passphrase. It protects this install; there is no account and no recovery email, so keep it somewhere safe."
              : multiUser
                ? "Sign in with your name and passphrase."
                : "Enter your passphrase to unlock your plans."}
          </p>
        </div>
        <form
          onSubmit={submit}
          className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-card"
          noValidate
        >
          {!setup && multiUser ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={loginId} className="text-[12px] font-medium text-ink-2">
                Sign-in name
              </label>
              <input
                id={loginId}
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                autoComplete="username"
                spellCheck={false}
                autoCapitalize="none"
                className={cn(inputBase, "h-10 text-[14px]")}
              />
              <p className="text-[11.5px] text-ink-3">The owner can leave this empty.</p>
            </div>
          ) : null}
          <PassField
            label={setup ? "New passphrase" : "Passphrase"}
            value={pass}
            onChange={setPass}
            autoComplete={setup ? "new-password" : "current-password"}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the only field on a sign-in screen
            autoFocus={setup || !multiUser}
            invalid={!!error}
          />
          {setup ? (
            <>
              <div className="-mt-2 flex items-center gap-2" aria-live="polite">
                <div className="flex flex-1 gap-1" aria-hidden>
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className={cn(
                        "h-1 flex-1 rounded-full transition-colors",
                        strength > i
                          ? strength === 1
                            ? "bg-warning"
                            : "bg-positive"
                          : "bg-surface-3",
                      )}
                    />
                  ))}
                </div>
                <span className="w-16 text-right text-[11.5px] text-ink-3">
                  {pass ? STRENGTH[strength] : ""}
                </span>
              </div>
              <p className="-mt-2 text-[11.5px] text-ink-3">
                At least {MIN_PASSPHRASE} characters. A few unrelated words is easy to remember and
                hard to guess.
              </p>
              <PassField
                label="Confirm passphrase"
                value={confirm}
                onChange={setConfirm}
                autoComplete="new-password"
                invalid={mismatch}
              />
              {mismatch ? (
                <p className="-mt-2 text-[11.5px] text-negative">The passphrases do not match.</p>
              ) : null}
              {needsToken ? (
                <div className="flex flex-col gap-1">
                  <label htmlFor="setup-token" className="text-[12px] font-medium text-ink-2">
                    Setup token
                  </label>
                  <input
                    id="setup-token"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    autoComplete="one-time-code"
                    spellCheck={false}
                    className={cn(inputBase, "h-10 font-mono text-[12.5px]")}
                  />
                  <p className="text-[11.5px] text-ink-3">
                    This server asks for its setup token (GLIDEWORTH_SETUP_TOKEN) before the first
                    passphrase is set.
                  </p>
                </div>
              ) : null}
            </>
          ) : null}
          {error ? (
            <p
              role="alert"
              className="rounded-md bg-negative-soft px-3 py-2 text-[12.5px] text-negative"
            >
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="lg" disabled={!canSubmit || busy}>
            {busy ? (
              <Loader2 className="animate-spin" />
            ) : setup ? (
              <ShieldCheck />
            ) : (
              <LockKeyhole />
            )}
            {setup ? "Set passphrase and continue" : "Unlock"}
          </Button>
        </form>
        <p className="mt-4 text-center text-[11.5px] text-ink-3">
          Glideworth runs on your own server. Your financial data never leaves it.
        </p>
      </div>
    </main>
  );
}

/**
 * Accept an invite or a passphrase reset (`/accept?token=…`): the person chooses their own
 * passphrase, so the owner never learns it, and is signed in.
 */
export function AcceptInviteScreen({ token }: { token: string }) {
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const strength = passphraseStrength(pass);
  const mismatch = confirm.length > 0 && confirm !== pass;
  const canSubmit = !!token && strength >= 1 && confirm === pass;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      await acceptInvite(token, pass);
      window.location.replace("/");
    } catch (err) {
      setError(
        err instanceof AuthError
          ? err.message
          : "Glideworth could not be reached. Is the server running?",
      );
      setBusy(false);
    }
  };
  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <GlideworthMark className="size-11" />
          <h1 className="display text-[26px] leading-tight font-semibold">
            Choose your passphrase
          </h1>
          <p className="text-[13px] text-ink-2">
            You have been invited to a Glideworth household, or asked to reset your passphrase. Pick
            one only you know; nobody else, including the owner, ever sees it.
          </p>
        </div>
        <form
          onSubmit={submit}
          className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-card"
          noValidate
        >
          {!token ? (
            <p
              role="alert"
              className="rounded-md bg-negative-soft px-3 py-2 text-[12.5px] text-negative"
            >
              This link is missing its token. Open the full link you were sent.
            </p>
          ) : null}
          <PassField
            label="New passphrase"
            value={pass}
            onChange={setPass}
            autoComplete="new-password"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the only field on a sign-in screen
            autoFocus
            invalid={!!error}
          />
          <p className="-mt-2 text-[11.5px] text-ink-3">
            At least {MIN_PASSPHRASE} characters{pass ? ` · ${STRENGTH[strength]}` : ""}.
          </p>
          <PassField
            label="Confirm passphrase"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            invalid={mismatch}
          />
          {mismatch ? (
            <p className="-mt-2 text-[11.5px] text-negative">The passphrases do not match.</p>
          ) : null}
          {error ? (
            <p
              role="alert"
              className="rounded-md bg-negative-soft px-3 py-2 text-[12.5px] text-negative"
            >
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="lg" disabled={!canSubmit || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            Set passphrase and sign in
          </Button>
        </form>
      </div>
    </main>
  );
}
