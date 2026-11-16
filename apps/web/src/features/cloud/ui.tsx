/**
 * Shared pieces of the hosted-mode screens: the centred sign-in layout, text fields whose errors are
 * tied to the input, a form-level alert, focus-the-first-error, the password strength hint, the optional
 * Turnstile widget and one place that turns API errors into sentences.
 */
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { GlideworthMark } from "../../components/layout/logo";
import { STRENGTH } from "../../components/layout/auth-gate";
import { Field, Input } from "../../components/ui/input";
import { ApiRequestError } from "../../lib/api-error";
import { passphraseStrength } from "../../lib/auth";
import { cn } from "../../lib/cn";
import { ReauthCancelled } from "../../lib/reauth";

// ------------------------------------------------------------------------------------------- layout
export const authCard =
  "flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-card";

/**
 * A ref callback that focuses the element when it mounts. It must keep one identity: React calls a ref callback
 * again whenever its identity changes, so one created during render would take focus back on every keystroke
 * in any other field.
 */
const focusOnAttach = (el: HTMLElement | null): void => el?.focus({ preventScroll: true });

/** Public pages (no app chrome): logo, one heading that takes focus, a card, a footer line. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const h1 = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} · Glideworth`;
    h1.current?.focus({ preventScroll: true });
  }, [title]);
  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <GlideworthMark className="size-11" />
          <h1
            ref={h1}
            tabIndex={-1}
            className="display text-[26px] leading-tight font-semibold text-balance outline-none"
          >
            {title}
          </h1>
          {subtitle ? <p className="text-[13px] text-ink-2 text-pretty">{subtitle}</p> : null}
        </div>
        {children}
        {footer ? <div className="mt-4 text-center text-[12.5px] text-ink-2">{footer}</div> : null}
      </div>
    </main>
  );
}

// --------------------------------------------------------------------------------------------- fields
export function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  type = "text",
  autoComplete,
  name,
  inputMode,
  focusOnMount,
  maxLength,
  placeholder,
  disabled,
  mono,
  large = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  hint?: ReactNode;
  type?: "text" | "email";
  autoComplete?: string;
  name?: string;
  inputMode?: "numeric" | "text" | "email";
  /** Focus this field when the screen opens (first field of a single-purpose screen or dialog). */
  focusOnMount?: boolean;
  maxLength?: number;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  /** Taller input for the centred sign-in pages; settings forms use the compact size. */
  large?: boolean;
}) {
  return (
    <Field label={label} error={error} hint={hint}>
      {(id, a11y) => (
        <Input
          id={id}
          name={name}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          inputMode={inputMode}
          ref={focusOnMount ? focusOnAttach : undefined}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          autoCapitalize="none"
          className={cn(large && "h-10 text-[14px]", mono && "font-mono tracking-wider")}
          {...a11y}
        />
      )}
    </Field>
  );
}

/** A form-level problem. `tabIndex=-1` lets `useErrorFocus` move focus here when no field is at fault. */
export function FormAlert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      tabIndex={-1}
      className="rounded-md bg-negative-soft px-3 py-2 text-[12.5px] text-negative outline-none"
    >
      {children}
    </p>
  );
}

/** A result worth announcing (sent, saved, done). */
export function Notice({
  children,
  tone = "positive",
}: {
  children: ReactNode;
  tone?: "positive" | "neutral" | "warning";
}) {
  return (
    <p
      role="status"
      className={cn(
        "rounded-md px-3 py-2 text-[12.5px]",
        tone === "positive" && "bg-accent-soft text-accent",
        tone === "neutral" && "bg-surface-2 text-ink-2",
        tone === "warning" && "bg-ochre-soft text-ochre",
      )}
    >
      {children}
    </p>
  );
}

/**
 * After a failed submit, call `failed()`: focus moves to the first field marked `aria-invalid`, or to the
 * form alert when no field is at fault.
 */
export function useErrorFocus() {
  const ref = useRef<HTMLFormElement>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!n) return;
    ref.current?.querySelector<HTMLElement>('[aria-invalid="true"], [role="alert"]')?.focus();
  }, [n]);
  return { ref, failed: () => setN((x) => x + 1) };
}

/** Strength bars and the word for them; announced politely as the person types. */
export function StrengthMeter({ password }: { password: string }) {
  const strength = passphraseStrength(password);
  return (
    <div className="flex items-center gap-2" aria-live="polite">
      <div className="flex flex-1 gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              strength > i ? (strength === 1 ? "bg-warning" : "bg-positive") : "bg-surface-3",
            )}
          />
        ))}
      </div>
      <span className="w-20 text-right text-[11.5px] text-ink-3">
        {password ? `Strength: ${STRENGTH[strength].toLowerCase()}` : ""}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------------------------------- errors
/** One sentence for an API or network error. The server's messages are fixed strings and safe to show. */
export function describeError(e: unknown): string {
  if (e instanceof ReauthCancelled) return "";
  if (!(e instanceof ApiRequestError)) return "Something went wrong. Please try again.";
  switch (e.code) {
    case "NETWORK":
      return e.message;
    case "RATE_LIMITED": {
      const s = (e.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      return s && s > 90
        ? `Too many attempts. Try again in about ${Math.ceil(s / 60)} minutes.`
        : "Too many attempts. Wait a minute and try again.";
    }
    case "CSRF":
      return "Your session was out of date. Reload the page and try again.";
    case "TENANT_UNAVAILABLE":
      return "This is temporarily unavailable. Try again in a moment.";
    case "INTERNAL":
      return "Something went wrong on our side. Try again in a moment.";
    default:
      return asSentence(e.message);
  }
}

/** The server writes its messages as lowercase fragments ("the code is wrong"); show them as sentences. */
export function asSentence(message: string): string {
  const m = message.trim();
  if (!m) return "Something went wrong. Please try again.";
  const capped = m.charAt(0).toUpperCase() + m.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

export const isCode = (e: unknown, code: string): boolean =>
  e instanceof ApiRequestError && e.code === code;

// ------------------------------------------------------------------------------------------ Turnstile
interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      theme?: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptLoad: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  scriptLoad ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptLoad = null;
      reject(new Error("The security check could not be loaded."));
    };
    document.head.append(s);
  });
  return scriptLoad;
}

/**
 * Cloudflare Turnstile. Rendered only when the server supplied a site key and wants a CAPTCHA; the
 * third-party script is fetched when this component first mounts and never otherwise. `resetKey` asks for
 * a fresh challenge (a token works once).
 */
export function Turnstile({
  siteKey,
  onToken,
  resetKey = 0,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
  resetKey?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  const [failed, setFailed] = useState(false);
  const labelId = useId();
  useEffect(() => {
    let gone = false;
    loadTurnstile().then(
      () => {
        if (gone || !box.current || !window.turnstile) return;
        widget.current = window.turnstile.render(box.current, {
          sitekey: siteKey,
          theme: "auto",
          callback: (t) => cb.current(t),
          "expired-callback": () => cb.current(null),
          "error-callback": () => cb.current(null),
        });
      },
      () => !gone && setFailed(true),
    );
    return () => {
      gone = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey]);
  useEffect(() => {
    if (resetKey && widget.current) {
      cb.current(null);
      window.turnstile?.reset(widget.current);
    }
  }, [resetKey]);
  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-[12px] font-medium text-ink-2">
        Security check
      </span>
      <div ref={box} role="group" aria-labelledby={labelId} className="min-h-[65px]" />
      {failed ? (
        <FormAlert>
          The security check could not load. If a content blocker is on, allow
          challenges.cloudflare.com for this page and reload.
        </FormAlert>
      ) : null}
    </div>
  );
}
