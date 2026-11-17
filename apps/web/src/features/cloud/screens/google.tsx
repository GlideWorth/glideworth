/**
 * The two pages "Continue with Google" can land on besides the app itself:
 *
 * - `/signup/google`: a new person. No account exists yet; the server holds what Google said (in a short-lived
 *   cookie-bound record) until they confirm their name, that they are 18 or over, and the terms. Only then is
 *   the account created (packages/cloud federation/service.ts, `POST /api/v1/auth/google/complete`).
 * - `/signin/google-exists`: Google's address belongs to an account that is not linked to that Google account.
 *   Nothing was signed in or linked. The page says so without naming the address, and offers the safe way:
 *   sign in with the password, then link Google in security settings.
 * - `/google-link`: linking from security settings. Google's redirect cannot finish the link, because browsers
 *   do not send the session cookie (SameSite=Strict) on a navigation that starts on Google's page. The server
 *   parks the Google account for this browser, and this page finishes the link with an ordinary same-origin
 *   POST (session and CSRF token), then returns to security settings with the answer.
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, Loader2, UserPlus } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { useSession } from "../../../lib/auth";
import { cloudApi } from "../client";
import { GoogleLogo } from "../google-button";
import { FALLBACK_TERMS_VERSION, LEGAL_URL } from "../legal";
import { nav } from "../next";
import { useFinishSignIn } from "../session-flow";
import {
  AuthLayout,
  authCard,
  describeError,
  FormAlert,
  isCode,
  Notice,
  TextField,
  useErrorFocus,
} from "../ui";

type Errors = Partial<Record<"name" | "adult", string>>;

export function GoogleSignUpPage() {
  const session = useSession().data;
  const navigate = useNavigate();
  const finish = useFinishSignIn();
  const termsVersion =
    (session?.kind === "cloud-signed-out" && session.termsVersion) || FALLBACK_TERMS_VERSION;
  const pending = useQuery({
    queryKey: ["cloud", "google-pending"],
    queryFn: cloudApi.googlePending,
    retry: false,
    staleTime: Infinity,
  });
  const [name, setName] = useState<string | null>(null);
  const [adult, setAdult] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const { ref, failed } = useErrorFocus();

  useEffect(() => {
    if (session?.kind === "authenticated") void navigate({ to: "/", replace: true });
  }, [session, navigate]);

  if (pending.isLoading)
    return (
      <AuthLayout title="One more step" subtitle="Getting your Google details…">
        <div className="flex justify-center py-6" role="status" aria-live="polite">
          <Loader2 className="size-5 animate-spin text-ink-3" aria-hidden />
          <span className="sr-only">Loading</span>
        </div>
      </AuthLayout>
    );

  if (expired || pending.isError || !pending.data)
    return (
      <AuthLayout
        title="Start again"
        subtitle="This sign-up took too long or was opened in another browser, so nothing was created. Continue with Google again from the sign-up page."
      >
        <Button variant="primary" size="lg" className="w-full" asChild>
          <Link to="/signup">Back to sign-up</Link>
        </Button>
      </AuthLayout>
    );

  const shownName = name ?? pending.data.name;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    const e: Errors = {};
    if (!shownName.trim()) e.name = "Enter your name.";
    if (!adult) e.adult = "Confirm that you are 18 or over to create an account.";
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length) return failed();
    setBusy(true);
    try {
      const r = await cloudApi.googleComplete({
        name: shownName.trim(),
        termsVersion,
        adultConfirmed: true,
      });
      await finish(r.redirectTo, "/");
    } catch (err) {
      setBusy(false);
      if (isCode(err, "INVALID_TOKEN")) return setExpired(true);
      if (isCode(err, "CONFLICT")) {
        await navigate({ to: "/signin/google-exists" });
        return;
      }
      setFormError(describeError(err));
      failed();
    }
  };

  return (
    <AuthLayout
      title="One more step"
      subtitle={
        pending.data.invitedTo
          ? `Confirm a few details to create your Glideworth account. Then we take you back to the invitation to join ${pending.data.invitedTo}.`
          : "Confirm a few details to create your Glideworth account. Then you can start a 7-day free trial."
      }
      footer={
        <Link to="/signin" className="text-accent underline underline-offset-2">
          Cancel
        </Link>
      }
    >
      <form ref={ref} onSubmit={submit} className={authCard} noValidate>
        <div className="flex items-start gap-3 text-[13px] text-ink-2">
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-white">
            <GoogleLogo className="size-4" />
          </span>
          <p>
            Signing up with the Google account for{" "}
            <span className="font-medium break-all text-ink">{pending.data.email}</span>. We use
            this address for your account; you can sign in with Google from now on.
          </p>
        </div>
        <TextField
          label="Your name"
          value={shownName}
          onChange={setName}
          autoComplete="name"
          name="name"
          maxLength={100}
          focusOnMount
          error={errors.name}
        />
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

export function GoogleExistsPage() {
  return (
    <AuthLayout
      title="You already have an account"
      subtitle="An account with the email address of that Google account already exists, and it is not linked to Google."
      footer={
        <Link to="/forgot-password" className="text-accent underline underline-offset-2">
          Forgot your password?
        </Link>
      }
    >
      <div className={authCard}>
        <Notice tone="neutral">
          To keep that account safe, we did not sign you in with Google. Sign in with your password
          (and your two-step code, if you use one), then link Google under Settings → Security.
          After that you can use either.
        </Notice>
        <Button variant="primary" size="lg" className="w-full" asChild>
          <Link to="/signin" search={{ next: "/settings/security" }}>
            <KeyRound /> Sign in with your password
          </Link>
        </Button>
      </div>
    </AuthLayout>
  );
}

/** `/google-link`: finishes a link from security settings (see the top of this file), once. */
export function GoogleLinkPage() {
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    cloudApi.finishGoogleLink().then(
      (r) => nav.replace(`/settings/security?google=${encodeURIComponent(r.google)}`),
      (e: unknown) => setError(describeError(e)),
    );
  }, []);
  return (
    <AuthLayout
      title={error ? "Google was not linked" : "Linking your Google account"}
      subtitle={error ?? "One moment while we finish."}
    >
      <div role="status" aria-live="polite" className="flex justify-center">
        {error ? null : (
          <Loader2 className="size-8 animate-spin text-accent" aria-label="Working" />
        )}
      </div>
      {error ? (
        <Button variant="primary" size="lg" className="w-full" asChild>
          <Link to="/settings/$section" params={{ section: "security" }}>
            Back to Security settings
          </Link>
        </Button>
      ) : null}
    </AuthLayout>
  );
}
