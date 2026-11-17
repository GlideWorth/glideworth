/**
 * Forgot password (always answers neutrally) and reset password (the token arrives in the URL fragment).
 * A reset signs the person in, except that an account with two-step sign-in still asks for the code.
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { KeyRound, Loader2, Send } from "lucide-react";
import { type FormEvent, useState } from "react";
import { PassField } from "../../../components/layout/auth-gate";
import { Button } from "../../../components/ui/button";
import { useSession } from "../../../lib/auth";
import { cloudApi } from "../client";
import { useFragmentToken } from "../fragment";
import { PASSWORD_RULES, passwordProblem } from "../password-rules";
import { setChallenge, useFinishSignIn } from "../session-flow";
import {
  AuthLayout,
  authCard,
  describeError,
  FormAlert,
  isCode,
  Notice,
  StrengthMeter,
  TextField,
  Turnstile,
  useErrorFocus,
} from "../ui";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ForgotPasswordPage() {
  const session = useSession().data;
  const siteKey = session?.kind === "cloud-signed-out" ? session.captchaSiteKey : undefined;
  const [email, setEmail] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { ref, failed } = useErrorFocus();

  // Signed in: the server gives no security-check key to a session, so this form could never be sent.
  const signedInAs =
    session?.kind === "authenticated" && session.cloud ? session.cloud.user.email : null;
  if (signedInAs)
    return (
      <AuthLayout
        title="Reset your password"
        subtitle={`You are signed in as ${signedInAs}.`}
        footer={
          <Link to="/" className="text-accent underline underline-offset-2">
            Back to Glideworth
          </Link>
        }
      >
        <div className={authCard}>
          <Notice tone="neutral">
            To choose a new password, use Security settings; you will need your current one. If you
            have forgotten it, sign out first, then ask for a reset link on this page.
          </Notice>
          <Button variant="primary" size="lg" className="w-full" asChild>
            <Link to="/settings/$section" params={{ section: "security" }}>
              <KeyRound /> Go to Security settings
            </Link>
          </Button>
        </div>
      </AuthLayout>
    );

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    if (!EMAIL.test(email.trim())) {
      setError("Enter the email address of your account.");
      return failed();
    }
    if (siteKey && !token) {
      setError("Complete the security check.");
      return failed();
    }
    setBusy(true);
    setError(null);
    try {
      await cloudApi.forgotPassword(email.trim(), token ?? undefined);
      setSentTo(email.trim());
    } catch (err) {
      setError(
        isCode(err, "CAPTCHA_REQUIRED")
          ? "The security check did not pass. Try again."
          : describeError(err),
      );
      failed();
    }
    setToken(null);
    setResetKey((k) => k + 1);
    setBusy(false);
  };

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your email address and we will send a link to choose a new password."
      footer={
        <Link to="/signin" className="text-accent underline underline-offset-2">
          Back to sign in
        </Link>
      }
    >
      <form ref={ref} onSubmit={submit} className={authCard} noValidate>
        {sentTo ? (
          <Notice>
            If an account exists for {sentTo}, we have sent a link to reset its password. The link
            works for 30 minutes. Check your spam folder if it does not arrive.
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
          error={error && !siteKey ? error : undefined}
        />
        {siteKey ? <Turnstile siteKey={siteKey} onToken={setToken} resetKey={resetKey} /> : null}
        {error && siteKey ? <FormAlert>{error}</FormAlert> : null}
        <Button type="submit" variant="primary" size="lg" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Send />}
          {sentTo ? "Send again" : "Send reset link"}
        </Button>
      </form>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const token = useFragmentToken();
  const navigate = useNavigate();
  const finish = useFinishSignIn();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [dead, setDead] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Set once the server accepted the new password: what the success screen's button does next. */
  const [done, setDone] = useState<{ redirectTo?: string; twoStep: boolean } | null>(null);
  const { ref, failed } = useErrorFocus();

  if (done)
    return (
      <AuthLayout
        title="Your password was reset"
        subtitle={
          done.twoStep
            ? "Next, enter the code from your authenticator app to sign in."
            : "You are signed in. Other browsers were signed out."
        }
      >
        <div className={authCard}>
          {/* The same words as the security email the reset sends (packages/email security-change). */}
          <Notice tone="neutral">
            Apps connected to your account were disconnected; your API keys still work. Connect an
            app again if you still use it.
          </Notice>
          <Button
            variant="primary"
            size="lg"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the only action on a single-purpose screen
            autoFocus
            onClick={() =>
              void (done.twoStep ? navigate({ to: "/signin/2fa" }) : finish(done.redirectTo, "/"))
            }
          >
            Continue
          </Button>
        </div>
      </AuthLayout>
    );

  if (!token || dead)
    return (
      <AuthLayout
        title="This link will not work"
        subtitle={
          token
            ? "The reset link has expired or was already used."
            : "This page needs the full link from your email. Open the link again, or ask for a new one."
        }
      >
        <Button variant="primary" size="lg" className="w-full" asChild>
          <Link to="/forgot-password">Send a new reset link</Link>
        </Button>
      </AuthLayout>
    );

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    const e: typeof errors = {};
    const problem = passwordProblem(password, "");
    if (problem) e.password = problem;
    if (confirm !== password) e.confirm = "The passwords do not match.";
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length) return failed();
    setBusy(true);
    try {
      const r = await cloudApi.resetPassword(token, password);
      if (r.status === "totp-required" && r.challenge) {
        setChallenge({ token: r.challenge, next: "/" });
        setDone({ twoStep: true });
        return;
      }
      setDone({ twoStep: false, ...(r.redirectTo ? { redirectTo: r.redirectTo } : {}) });
    } catch (err) {
      if (isCode(err, "INVALID_TOKEN")) return setDead(true);
      if (isCode(err, "WEAK_PASSWORD")) setErrors({ password: describeError(err) });
      else setFormError(describeError(err));
      setBusy(false);
      failed();
    }
  };

  return (
    <AuthLayout
      title="Choose a new password"
      subtitle="You will be signed out everywhere else, and apps you connected by signing in (such as AI assistants) are disconnected; API keys keep working. If two-step sign-in is on, you will still need your code."
    >
      <form ref={ref} onSubmit={submit} className={authCard} noValidate>
        <PassField
          label="New password"
          noun="password"
          name="new-password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- first field of a single-purpose screen
          autoFocus
          error={errors.password}
          hint={PASSWORD_RULES}
        />
        <StrengthMeter password={password} />
        <PassField
          label="Confirm new password"
          noun="password"
          name="confirm-password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          error={errors.confirm}
        />
        {formError ? <FormAlert>{formError}</FormAlert> : null}
        <Button type="submit" variant="primary" size="lg" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
          Set password and sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
