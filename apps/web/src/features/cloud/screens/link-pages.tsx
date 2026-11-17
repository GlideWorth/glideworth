/**
 * Pages opened from a link in an email: verify the address, confirm a changed address, accept an
 * invitation (which names the workspace and the role offered). Each link carries a one-time token in the URL fragment (`#token=…`), which is read once and
 * cleared from the address bar (fragment.ts); it is never sent in a query string.
 *
 * A verification link signs in on its own only in the browser that signed up. Anywhere else the server
 * answers `PASSWORD_REQUIRED` and the page asks for the password chosen at sign-up, so a sign-up somebody
 * else made with the person's address cannot hand them an account with that somebody's password.
 */
import { usePostHog } from "@posthog/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Loader2, LockKeyhole, MailCheck, UsersRound } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { PassField } from "../../../components/layout/auth-gate";
import { Button } from "../../../components/ui/button";
import type { ApiRequestError } from "../../../lib/api-error";
import { useCloudSession, useSession } from "../../../lib/auth";
import { cloudApi } from "../client";
import { useFragmentToken } from "../fragment";
import { heldInvitation, holdInvitation, ROLE_TEXT } from "../held-invitation";
import { refreshSession, useFinishSignIn, useGoTo } from "../session-flow";
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

type Phase =
  | { kind: "working" }
  | { kind: "done" }
  /** Verification only: this browser did not sign up, so the password is asked for. */
  | { kind: "password" }
  | { kind: "bad-link" }
  | { kind: "error"; message: string };

/** Run `action` once when the page opens with a token (React may mount twice in development). */
function useOnce(token: string | null, action: (token: string) => Promise<Phase>): Phase {
  const [phase, setPhase] = useState<Phase>(token ? { kind: "working" } : { kind: "bad-link" });
  const started = useRef(false);
  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    action(token).then(setPhase, (e) => setPhase({ kind: "error", message: describeError(e) }));
  }, [token, action]);
  return phase;
}

// -------------------------------------------------------------------------------------- verify email
export function VerifyEmailPage() {
  const token = useFragmentToken();
  const finish = useFinishSignIn();
  const posthog = usePostHog();
  const [email, setEmail] = useState("");
  const [resent, setResent] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  // What the password step ended in (signed in, or the link died meanwhile).
  const [after, setAfter] = useState<Phase | null>(null);
  const first = useOnce(token, async (t) => {
    try {
      const r = await cloudApi.verifyEmail(t);
      posthog?.capture("email_verified");
      await finish(r.redirectTo, "/");
      return { kind: "done" };
    } catch (e) {
      return isCode(e, "PASSWORD_REQUIRED")
        ? { kind: "password" }
        : isCode(e, "INVALID_TOKEN")
          ? { kind: "bad-link" }
          : { kind: "error", message: describeError(e) };
    }
  });
  const phase = after ?? first;

  const resend = async (ev: FormEvent) => {
    ev.preventDefault();
    setResendError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setResendError("Enter the email address you signed up with.");
      return;
    }
    try {
      await cloudApi.resendVerification(email.trim());
      setResent(true);
    } catch (e) {
      setResendError(describeError(e));
    }
  };

  if (phase.kind === "working" || phase.kind === "done")
    return (
      <AuthLayout
        title={phase.kind === "done" ? "Email confirmed" : "Confirming your email"}
        subtitle={
          phase.kind === "done"
            ? "Taking you to your workspace."
            : "One moment while we check the link."
        }
      >
        <div role="status" aria-live="polite" className="flex justify-center py-4 text-accent">
          {phase.kind === "done" ? (
            <CheckCircle2 className="size-8" aria-label="Done" />
          ) : (
            <Loader2 className="size-8 animate-spin" aria-label="Working" />
          )}
        </div>
      </AuthLayout>
    );

  if (phase.kind === "password" && token)
    return (
      <VerifyWithPassword
        token={token}
        onSignedIn={async (redirectTo) => {
          posthog?.capture("email_verified");
          setAfter({ kind: "done" });
          await finish(redirectTo, "/");
        }}
        onBadLink={() => setAfter({ kind: "bad-link" })}
      />
    );

  return (
    <AuthLayout
      title={phase.kind === "error" ? "We could not confirm your email" : "This link will not work"}
      subtitle={
        phase.kind === "error"
          ? phase.message
          : "The link has expired, was already used, or is incomplete. Ask for a new one below."
      }
      footer={
        <Link to="/signin" className="text-accent underline underline-offset-2">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={resend} className={authCard} noValidate>
        <TextField
          label="Send a new link to"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="username"
          inputMode="email"
          error={resendError ?? undefined}
        />
        {resent ? (
          <Notice>If that address is waiting for confirmation, we have sent the link again.</Notice>
        ) : null}
        <Button type="submit" variant="primary" size="lg">
          <MailCheck /> Send a new link
        </Button>
      </form>
    </AuthLayout>
  );
}

/**
 * The link was opened somewhere other than the browser that signed up: one password field. A wrong
 * password leaves the link usable; someone who does not know the password signs up again, which sets a
 * new one and sends a new link.
 */
function VerifyWithPassword({
  token,
  onSignedIn,
  onBadLink,
}: {
  token: string;
  onSignedIn: (redirectTo: string | undefined) => Promise<void>;
  onBadLink: () => void;
}) {
  const session = useSession().data;
  const siteKeyFromStatus =
    session?.kind === "cloud-signed-out" ? session.captchaSiteKey : undefined;
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState<{ siteKey: string | null } | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const { ref, failed } = useErrorFocus();

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    setFieldError(null);
    setError(null);
    if (!password) {
      setFieldError("Enter your password.");
      return failed();
    }
    if (captcha?.siteKey && !captchaToken) {
      setError("Complete the security check.");
      return failed();
    }
    setBusy(true);
    try {
      const r = await cloudApi.verifyEmail(token, {
        password,
        ...(captchaToken ? { captchaToken } : {}),
      });
      await onSignedIn(r.redirectTo);
    } catch (err) {
      if (isCode(err, "INVALID_TOKEN")) return onBadLink();
      if (isCode(err, "CAPTCHA_REQUIRED")) {
        const fromError = (err as ApiRequestError).details as { siteKey?: string } | undefined;
        setCaptcha({ siteKey: fromError?.siteKey ?? siteKeyFromStatus ?? null });
        setError(
          fromError?.siteKey || siteKeyFromStatus
            ? "Too many attempts. Complete the security check to continue."
            : "Too many attempts. Try again in a few minutes.",
        );
      } else if (isCode(err, "UNAUTHORIZED") || isCode(err, "PASSWORD_REQUIRED")) {
        setFieldError(
          "That is not the password this sign-up was made with. Try again, or sign up again to choose a new one.",
        );
      } else setError(describeError(err));
      setCaptchaToken(null);
      setResetKey((k) => k + 1);
      setBusy(false);
      failed();
    }
  };

  return (
    <AuthLayout
      title="Enter your password to finish"
      subtitle="This is not the browser you signed up in, so we need one more check. Enter the password you chose when you signed up."
      footer={
        <>
          Do not know it, or did not sign up yourself?{" "}
          <Link to="/signup" className="text-accent underline underline-offset-2">
            Sign up again
          </Link>{" "}
          to choose a new password. We will send a new link.
        </>
      }
    >
      <form ref={ref} onSubmit={submit} className={authCard} noValidate>
        <PassField
          label="Password"
          noun="password"
          name="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          error={fieldError ?? undefined}
        />
        {captcha?.siteKey ? (
          <Turnstile siteKey={captcha.siteKey} onToken={setCaptchaToken} resetKey={resetKey} />
        ) : null}
        {error ? <FormAlert>{error}</FormAlert> : null}
        <Button type="submit" variant="primary" size="lg" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <LockKeyhole />}
          Confirm email and sign in
        </Button>
      </form>
    </AuthLayout>
  );
}

// ------------------------------------------------------------------------------- confirm email change
export function ConfirmEmailPage() {
  const token = useFragmentToken();
  const qc = useQueryClient();
  const signedIn = useSession().data?.kind === "authenticated";
  const phase = useOnce(token, async (t) => {
    try {
      await cloudApi.confirmEmail(t);
      void qc.invalidateQueries({ queryKey: ["session"] });
      return { kind: "done" };
    } catch (e) {
      return isCode(e, "INVALID_TOKEN")
        ? { kind: "bad-link" }
        : { kind: "error", message: describeError(e) };
    }
  });
  return (
    <AuthLayout
      title={
        phase.kind === "done"
          ? "Email address changed"
          : phase.kind === "working"
            ? "Confirming your new email"
            : "This link will not work"
      }
      subtitle={
        phase.kind === "done"
          ? "Use your new address the next time you sign in."
          : phase.kind === "working"
            ? "One moment while we check the link."
            : phase.kind === "error"
              ? phase.message
              : "The link has expired, was already used, or is incomplete. Start the change again from Account settings."
      }
    >
      <div role="status" aria-live="polite" className="flex justify-center">
        {phase.kind === "working" ? (
          <Loader2 className="size-8 animate-spin text-accent" aria-label="Working" />
        ) : null}
      </div>
      {phase.kind !== "working" ? (
        <Button variant="primary" size="lg" className="w-full" asChild>
          <Link
            to={signedIn ? "/settings/$section" : "/signin"}
            params={signedIn ? { section: "account" } : undefined}
          >
            {signedIn ? "Go to Account settings" : "Sign in"}
          </Link>
        </Button>
      ) : null}
    </AuthLayout>
  );
}

// ------------------------------------------------------------------------------------- invitation
/**
 * The page an invitation link opens. It names the workspace and the role (the server answers only for an
 * invitation that can still be accepted, and says nothing more than "will not work" for any other token), then
 * offers sign-in or sign-up, or "Join" to someone signed in. The token is held in memory (held-invitation.ts)
 * while the person signs in or creates an account, and sign-up carries it through email confirmation.
 */
export function InvitePage() {
  const fromLink = useFragmentToken();
  const [token] = useState(() => fromLink ?? heldInvitation()?.token ?? null);
  useEffect(() => {
    if (fromLink && heldInvitation()?.token !== fromLink) holdInvitation({ token: fromLink });
  }, [fromLink]);
  const session = useSession().data;
  const cloud = useCloudSession();
  const qc = useQueryClient();
  const go = useGoTo();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  const preview = useQuery({
    queryKey: ["cloud", "invitation-preview", token],
    queryFn: () => cloudApi.previewInvitation(token as string),
    enabled: !!token && !joined,
    retry: false,
    staleTime: Infinity,
  });
  const offer = preview.data;
  const dead = isCode(preview.error, "INVALID_TOKEN");
  useEffect(() => {
    if (token && offer && heldInvitation()?.token === token) holdInvitation({ token, offer });
    if (dead && heldInvitation()?.token === token) holdInvitation(null);
  }, [token, offer, dead]);

  if (!token)
    return (
      <AuthLayout
        title="This invitation link is incomplete"
        subtitle="Open the full link from the invitation email. If it has expired, ask the workspace owner to send a new invitation."
      >
        <Button variant="primary" size="lg" className="w-full" asChild>
          <Link to="/">Go to Glideworth</Link>
        </Button>
      </AuthLayout>
    );

  const workspace = offer?.workspaceName ? offer.workspaceName : null;

  if (joined)
    return (
      <AuthLayout
        title={workspace ? `You have joined ${workspace}` : "You have joined the workspace"}
        subtitle="Everything shared with you is ready."
      >
        <Button variant="primary" size="lg" className="w-full" onClick={() => void go("/")}>
          Open the workspace
        </Button>
      </AuthLayout>
    );

  if (dead)
    return (
      <AuthLayout
        title="This invitation will not work"
        subtitle="It has expired, was already used, or was withdrawn. Ask the person who invited you to send a new one."
      >
        <Button variant="primary" size="lg" className="w-full" asChild>
          <Link to="/">Go to Glideworth</Link>
        </Button>
      </AuthLayout>
    );

  const role = offer
    ? `You would join as ${ROLE_TEXT[offer.role].name}. ${ROLE_TEXT[offer.role].can}`
    : null;

  if (session?.kind === "cloud-signed-out")
    return (
      <AuthLayout
        title={
          workspace
            ? `You have been invited to ${workspace}`
            : "You have been invited to a workspace"
        }
        subtitle={`${role ? `${role} ` : ""}Sign in with the email address the invitation was sent to, or create an account with it.`}
      >
        <div className={authCard}>
          <Button variant="primary" size="lg" asChild>
            <Link to="/signin" search={{ next: "/invite" }}>
              Sign in
            </Link>
          </Button>
          <Button size="lg" asChild>
            <Link to="/signup">Create an account</Link>
          </Button>
          <p className="text-[11.5px] text-ink-3">
            A new account must confirm its email address first. The link in that email brings you
            back to this invitation.
          </p>
        </div>
      </AuthLayout>
    );

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await cloudApi.acceptInvitation(token);
      holdInvitation(null);
      setJoined(true);
      await refreshSession(qc);
    } catch (e) {
      setError(
        isCode(e, "INVALID_TOKEN") || isCode(e, "NOT_FOUND")
          ? "This invitation has expired, was already used, or was withdrawn. Ask the owner to send a new one."
          : isCode(e, "FORBIDDEN")
            ? "This invitation was sent to a different email address. Sign out and sign in with the address it was sent to."
            : isCode(e, "SEAT_LIMIT")
              ? "The workspace has no free seat for this role right now. Ask the owner to make room."
              : describeError(e),
      );
    }
    setBusy(false);
  };

  return (
    <AuthLayout
      title={workspace ? `Join ${workspace}` : "Accept your invitation"}
      subtitle={
        cloud
          ? `${role ? `${role} ` : ""}You are signed in as ${cloud.user.email}. The invitation must have been sent to this address.`
          : "Checking who you are."
      }
    >
      <div className={authCard}>
        <div role="status" aria-live="polite">
          {error ? <FormAlert>{error}</FormAlert> : null}
        </div>
        <Button variant="primary" size="lg" onClick={() => void accept()} disabled={busy || !cloud}>
          {busy ? <Loader2 className="animate-spin" /> : <UsersRound />}
          Join the workspace
        </Button>
        <button
          type="button"
          className="text-[12.5px] text-accent underline underline-offset-2"
          onClick={async () => {
            await cloudApi.signOut().catch(() => undefined);
            // Back to the sign-in choices on this same page; the invitation stays in memory.
            await refreshSession(qc);
          }}
        >
          Use a different account
        </button>
      </div>
    </AuthLayout>
  );
}
