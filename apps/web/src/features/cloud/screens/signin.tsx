/**
 * Sign in (email + password, a CAPTCHA only after the server asks for one, or "Continue with Google" when
 * the server offers it) and the second step (authenticator code, or a recovery code). A wrong email and a
 * wrong password get the same sentence. A Google sign-in that needs the second step arrives at
 * `/signin/2fa#challenge=…&next=…` (fragment: never sent to a server).
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { PassField } from "../../../components/layout/auth-gate";
import { Button } from "../../../components/ui/button";
import { ApiRequestError } from "../../../lib/api-error";
import { useSession } from "../../../lib/auth";
import { cloudApi } from "../client";
import { useFragmentToken } from "../fragment";
import { ContinueWithGoogle, googleProblem, OrDivider } from "../google-button";
import { nextFromLocation, safeNext } from "../next";
import { getChallenge, setChallenge, useFinishSignIn, useGoTo } from "../session-flow";
import {
  AuthLayout,
  authCard,
  describeError,
  FormAlert,
  isCode,
  Notice,
  TextField,
  Turnstile,
  useErrorFocus,
} from "../ui";

export function SignInPage() {
  const session = useSession().data;
  const navigate = useNavigate();
  const go = useGoTo();
  const finish = useFinishSignIn();
  const next = nextFromLocation();
  const siteKeyFromStatus =
    session?.kind === "cloud-signed-out" ? session.captchaSiteKey : undefined;
  const google = session?.kind === "cloud-signed-out" && session.googleSignIn === true;
  const [googleError] = useState(() =>
    googleProblem(new URLSearchParams(window.location.search).get("google")),
  );
  // Set by Account settings after "Delete account", so the person sees that it happened.
  const [accountDeleted] = useState(
    () => new URLSearchParams(window.location.search).get("deleted") === "1",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [unverified, setUnverified] = useState(false);
  const [resent, setResent] = useState(false);
  const [captcha, setCaptcha] = useState<{ siteKey: string | null } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const { ref, failed } = useErrorFocus();

  // Signed in already (another tab, or the session was still valid): carry on to where they were going.
  useEffect(() => {
    if (session?.kind === "authenticated") void go(next);
  }, [session, go, next]);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    setUnverified(false);
    setResent(false);
    setFieldErrors({});
    if (!email.trim() || !password) {
      setError(null);
      setFieldErrors({
        ...(email.trim() ? {} : { email: "Enter your email address." }),
        ...(password ? {} : { password: "Enter your password." }),
      });
      return failed();
    }
    if (captcha?.siteKey && !token) {
      setError("Complete the security check.");
      return failed();
    }
    setBusy(true);
    setError(null);
    try {
      const r = await cloudApi.signIn({
        email: email.trim(),
        password,
        ...(token ? { captchaToken: token } : {}),
        ...(next !== "/" ? { next } : {}),
      });
      if (r.status === "totp-required" && r.challenge) {
        setChallenge({ token: r.challenge, next });
        await navigate({ to: "/signin/2fa" });
        return;
      }
      await finish(r.redirectTo, next);
    } catch (err) {
      if (isCode(err, "EMAIL_NOT_VERIFIED")) {
        setUnverified(true);
        setError(null);
      } else if (isCode(err, "CAPTCHA_REQUIRED")) {
        const fromError = (err as ApiRequestError).details as { siteKey?: string } | undefined;
        setCaptcha({ siteKey: fromError?.siteKey ?? siteKeyFromStatus ?? null });
        setError(
          fromError?.siteKey || siteKeyFromStatus
            ? "Too many attempts. Complete the security check to continue."
            : "Too many attempts. Try again in a few minutes.",
        );
      } else if (isCode(err, "UNAUTHORIZED")) {
        setError("The email or password is wrong.");
      } else setError(describeError(err));
      setToken(null);
      setResetKey((k) => k + 1);
      setBusy(false);
      failed();
    }
  };

  const resend = async () => {
    try {
      await cloudApi.resendVerification(email.trim());
      setResent(true);
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to your Glideworth workspace."
      footer={
        <>
          New here?{" "}
          <Link to="/signup" className="text-accent underline underline-offset-2">
            Create an account
          </Link>
        </>
      }
    >
      <form ref={ref} onSubmit={submit} className={authCard} noValidate>
        {googleError ? <FormAlert>{googleError}</FormAlert> : null}
        {accountDeleted ? (
          <Notice>
            Your account has been deleted and you are signed out. You can create a new account with
            the same email address at any time.
          </Notice>
        ) : null}
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="username"
          name="email"
          inputMode="email"
          focusOnMount
          error={fieldErrors.email}
        />
        <PassField
          label="Password"
          noun="password"
          name="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          error={fieldErrors.password}
          invalid={!!error && !captcha}
        />
        <div className="-mt-2 text-right text-[12px]">
          <Link to="/forgot-password" className="text-accent underline underline-offset-2">
            Forgot your password?
          </Link>
        </div>
        {captcha?.siteKey ? (
          <Turnstile siteKey={captcha.siteKey} onToken={setToken} resetKey={resetKey} />
        ) : null}
        {unverified ? (
          <div className="flex flex-col gap-2">
            <FormAlert>
              Your email address is not confirmed yet. Open the link in the message we sent you.
            </FormAlert>
            {resent ? (
              <Notice>
                If that address is waiting for confirmation, we have sent the link again.
              </Notice>
            ) : (
              <Button type="button" size="sm" onClick={() => void resend()}>
                Send the confirmation link again
              </Button>
            )}
          </div>
        ) : null}
        {error ? <FormAlert>{error}</FormAlert> : null}
        <Button type="submit" variant="primary" size="lg" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <LockKeyhole />}
          Sign in
        </Button>
        {google ? (
          <>
            <OrDivider />
            <ContinueWithGoogle next={next} />
          </>
        ) : null}
      </form>
    </AuthLayout>
  );
}

export function TwoFactorPage() {
  const navigate = useNavigate();
  const finish = useFinishSignIn();
  // From the password step (memory), or from a Google sign-in's redirect (the URL fragment, then cleared).
  const fragmentChallenge = useFragmentToken("challenge");
  const fragmentNext = useFragmentToken("next");
  const [pending] = useState(
    () =>
      getChallenge() ??
      (fragmentChallenge ? { token: fragmentChallenge, next: safeNext(fragmentNext) } : null),
  );
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const { ref, failed } = useErrorFocus();

  if (!pending || expired)
    return (
      <AuthLayout
        title="Start sign-in again"
        subtitle="The sign-in took too long, or this page was reloaded. Nothing you typed is stored; sign in again to get a new code prompt."
      >
        <Button variant="primary" size="lg" className="w-full" asChild>
          <Link to="/signin">Back to sign in</Link>
        </Button>
      </AuthLayout>
    );

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    const value = recovery ? code.trim() : code.replace(/\s/g, "");
    if (!value) {
      setError(recovery ? "Enter a recovery code." : "Enter the 6-digit code.");
      return failed();
    }
    setBusy(true);
    setError(null);
    try {
      const r = await cloudApi.signInTotp({
        challenge: pending.token,
        ...(recovery ? { recoveryCode: value } : { code: value }),
        ...(pending.next !== "/" ? { next: pending.next } : {}),
      });
      await finish(r.redirectTo, pending.next);
    } catch (err) {
      if (isCode(err, "INVALID_TOKEN") || (err instanceof ApiRequestError && err.status === 410)) {
        setChallenge(null);
        setExpired(true);
        return;
      }
      setError(
        isCode(err, "UNAUTHORIZED")
          ? recovery
            ? "That recovery code is not valid. Each one works once."
            : "That code is not right. Check the time on your phone and try the newest code."
          : describeError(err),
      );
      setBusy(false);
      failed();
    }
  };

  return (
    <AuthLayout
      title="Two-step sign-in"
      subtitle={
        recovery
          ? "Enter one of the recovery codes you saved when you turned on two-step sign-in."
          : "Open your authenticator app and enter the 6-digit code for Glideworth."
      }
      footer={
        <button
          type="button"
          className="text-accent underline underline-offset-2"
          onClick={() => void navigate({ to: "/signin" })}
        >
          Cancel and start again
        </button>
      }
    >
      <form ref={ref} onSubmit={submit} className={authCard} noValidate>
        <TextField
          key={recovery ? "recovery" : "code"}
          label={recovery ? "Recovery code" : "Authenticator code"}
          value={code}
          onChange={setCode}
          autoComplete={recovery ? "off" : "one-time-code"}
          inputMode={recovery ? "text" : "numeric"}
          name={recovery ? "recovery-code" : "code"}
          maxLength={recovery ? 24 : 9}
          focusOnMount
          mono
          error={error ?? undefined}
        />
        <Button type="submit" variant="primary" size="lg" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          Verify and sign in
        </Button>
        <button
          type="button"
          className="self-start text-[12.5px] text-accent underline underline-offset-2"
          onClick={() => {
            setRecovery((r) => !r);
            setCode("");
            setError(null);
          }}
        >
          {recovery ? "Use an authenticator code instead" : "Use a recovery code instead"}
        </button>
      </form>
    </AuthLayout>
  );
}
