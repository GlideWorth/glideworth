/**
 * Sign-up and "check your email". Sign-up always answers "check your email" whether or not the address
 * already has an account (packages/cloud: 202 `check-email`), so what the person sees is worded the same
 * way for both.
 *
 * Coming from an invitation (held-invitation.ts), the sign-up sends its token along: the server keeps it with
 * the verification link, and confirming the address opens the invitation. Such a person joins a workspace
 * and does not start a trial, so the copy says so.
 */
import { usePostHog } from "@posthog/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2, MailCheck, UserPlus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { PassField } from "../../../components/layout/auth-gate";
import { Button } from "../../../components/ui/button";
import { useSession } from "../../../lib/auth";
import { cloudApi } from "../client";
import { ContinueWithGoogle, OrDivider } from "../google-button";
import { FALLBACK_TERMS_VERSION, LEGAL_URL } from "../legal";
import { HANDOFF_TOOLS, parseHandoff, stashHandoff } from "../handoff";
import { heldInvitation } from "../held-invitation";
import { PASSWORD_RULES, passwordProblem } from "../password-rules";
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

/** The address to show on the next screen. Kept in memory only (never in the URL or storage). */
let pendingEmail = "";

type Errors = Partial<Record<"name" | "email" | "password" | "adult" | "captcha", string>>;

export function SignUpPage() {
  const session = useSession().data;
  const navigate = useNavigate();
  const posthog = usePostHog();
  const siteKey = session?.kind === "cloud-signed-out" ? session.captchaSiteKey : undefined;
  const termsVersion =
    (session?.kind === "cloud-signed-out" && session.termsVersion) || FALLBACK_TERMS_VERSION;
  const google = session?.kind === "cloud-signed-out" && session.googleSignIn === true;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [adult, setAdult] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { ref, failed } = useErrorFocus();
  const [invitation] = useState(heldInvitation);
  const invitedTo = invitation?.offer?.workspaceName || null;
  // A calculator on glideworth.com links here with its inputs: keep them for the first plan.
  const [handoff] = useState(() => parseHandoff(window.location.search));
  useEffect(() => {
    if (handoff) stashHandoff(handoff);
  }, [handoff]);
  // Already signed in: nothing to do here.
  useEffect(() => {
    if (session?.kind === "authenticated") void navigate({ to: "/", replace: true });
  }, [session, navigate]);

  const validate = (): Errors => {
    const e: Errors = {};
    if (!name.trim()) e.name = "Enter your name.";
    if (!EMAIL.test(email.trim())) e.email = "Enter a valid email address.";
    const pw = passwordProblem(password, email.trim());
    if (pw) e.password = pw;
    if (!adult) e.adult = "Confirm that you are 18 or over to create an account.";
    if (siteKey && !token) e.captcha = "Complete the security check.";
    return e;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    const e = validate();
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length) return failed();
    setBusy(true);
    const source = handoff?.tool ?? "direct";
    posthog?.capture("signup_started", { method: "email", source });
    try {
      await cloudApi.signUp({
        email: email.trim(),
        password,
        name: name.trim(),
        termsVersion,
        adultConfirmed: true,
        ...(token ? { captchaToken: token } : {}),
        ...(invitation ? { invitation: invitation.token } : {}),
      });
      posthog?.capture("account_created", { method: "email", source });
      pendingEmail = email.trim();
      await navigate({ to: "/check-email" });
    } catch (err) {
      const next: Errors = {};
      if (isCode(err, "DISPOSABLE_EMAIL")) next.email = describeError(err);
      else if (isCode(err, "WEAK_PASSWORD")) next.password = describeError(err);
      else if (isCode(err, "CAPTCHA_REQUIRED"))
        next.captcha = siteKey
          ? "The security check did not pass. Try again."
          : "A security check is required but is not available right now. Try again later.";
      else setFormError(describeError(err));
      setErrors(next);
      setToken(null);
      setResetKey((k) => k + 1);
      setBusy(false);
      failed();
    }
  };

  return (
    <AuthLayout
      title="Create your account"
      subtitle={
        invitation
          ? `Use the email address the invitation was sent to. After you confirm it, we take you back to the invitation to join ${invitedTo ?? "the workspace"}.`
          : "Create your account and your 14-day free trial starts when you confirm your email. No card needed: when the trial ends your workspace becomes read-only until you subscribe."
      }
      footer={
        <>
          Already have an account?{" "}
          <Link to="/signin" className="text-accent underline underline-offset-2">
            Sign in
          </Link>
        </>
      }
    >
      <form ref={ref} onSubmit={submit} className={authCard} noValidate>
        {handoff ? (
          <Notice tone="neutral">
            You came from the {HANDOFF_TOOLS[handoff.tool]}. After you confirm your email we will
            offer to start your first plan from those inputs.
          </Notice>
        ) : null}
        {google ? (
          // First, so the quickest way in is in view without scrolling. The next step (name, 18 or
          // over, terms) is asked on /signup/google, before any account exists.
          <>
            <ContinueWithGoogle next="/" />
            <OrDivider />
          </>
        ) : null}
        <TextField
          label="Your name"
          value={name}
          onChange={setName}
          autoComplete="name"
          name="name"
          maxLength={200}
          focusOnMount
          error={errors.name}
        />
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="username"
          name="email"
          inputMode="email"
          error={errors.email}
        />
        <PassField
          label="Password"
          noun="password"
          name="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          error={errors.password}
          hint={PASSWORD_RULES}
        />
        <StrengthMeter password={password} />
        <div className="flex flex-col gap-1">
          <label className="flex items-start gap-2.5 text-[13px] text-ink">
            <input
              type="checkbox"
              name="adult"
              className="mt-0.5 size-4 accent-[var(--accent)]"
              checked={adult}
              onChange={(e) => setAdult(e.target.checked)}
              aria-invalid={errors.adult ? true : undefined}
              aria-describedby={errors.adult ? "adult-error" : undefined}
            />
            <span>I am 18 or over.</span>
          </label>
          {errors.adult ? (
            <p id="adult-error" className="text-[11.5px] text-negative">
              {errors.adult}
            </p>
          ) : null}
        </div>
        {siteKey ? (
          <div className="flex flex-col gap-1">
            <Turnstile siteKey={siteKey} onToken={setToken} resetKey={resetKey} />
            {errors.captcha ? (
              <p role="alert" className="text-[11.5px] text-negative">
                {errors.captcha}
              </p>
            ) : null}
          </div>
        ) : errors.captcha ? (
          <FormAlert>{errors.captcha}</FormAlert>
        ) : null}
        {formError ? <FormAlert>{formError}</FormAlert> : null}
        <p className="text-[11.5px] leading-relaxed text-ink-3">
          By creating an account you agree to the{" "}
          <a
            href={LEGAL_URL.terms}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline underline-offset-2"
          >
            Terms of Service
          </a>{" "}
          and have read the{" "}
          <a
            href={LEGAL_URL.privacy}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline underline-offset-2"
          >
            Privacy Policy
          </a>
          . Both open in a new tab.
        </p>
        <Button type="submit" variant="primary" size="lg" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <UserPlus />}
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}

/** Seconds before "send it again" is offered again. */
const RESEND_WAIT = 30;

export function CheckEmailPage() {
  const [invited] = useState(() => !!heldInvitation());
  const [email, setEmail] = useState(pendingEmail);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [first] = useState(() => pendingEmail);
  const { ref, failed } = useErrorFocus();

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const resend = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy || wait > 0) return;
    if (!EMAIL.test(email.trim())) {
      setError("Enter the email address you signed up with.");
      return failed();
    }
    setBusy(true);
    setError(null);
    try {
      await cloudApi.resendVerification(email.trim());
      setSentTo(email.trim());
      setWait(RESEND_WAIT);
    } catch (err) {
      setError(describeError(err));
      failed();
    }
    setBusy(false);
  };

  return (
    <AuthLayout
      title="Check your email"
      subtitle={
        invited
          ? `We have sent a message to ${first || "your address"}. Open the link in it to confirm your address, and it will take you to your invitation.`
          : first
            ? `We have sent a message to ${first}. Open the link in it to confirm your address.`
            : "Open the link in the message we sent to confirm your address."
      }
      footer={
        <Link to="/signin" className="text-accent underline underline-offset-2">
          Back to sign in
        </Link>
      }
    >
      <form ref={ref} onSubmit={resend} className={authCard} noValidate>
        <div className="flex items-start gap-3 text-[13px] text-ink-2">
          <MailCheck className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
          <p>
            If you already have an account with that address, the message says so and links to
            sign-in instead. It can take a few minutes; look in your spam folder too.
          </p>
        </div>
        <TextField
          label="Not there? Send it again to"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="username"
          inputMode="email"
          error={error ?? undefined}
        />
        {sentTo ? (
          <Notice>If {sentTo} is waiting for confirmation, we have sent the link again.</Notice>
        ) : null}
        <Button type="submit" disabled={busy || wait > 0}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          {wait > 0 ? `Send again in ${wait}s` : "Send the link again"}
        </Button>
      </form>
    </AuthLayout>
  );
}
