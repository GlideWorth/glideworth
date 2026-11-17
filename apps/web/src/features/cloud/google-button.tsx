/**
 * "Continue with Google": a plain link to our own server (`/api/v1/auth/google/start`), which redirects to
 * Google. No Google JavaScript, font or image is loaded: the "G" is drawn from the SVG below, bundled with the
 * app, so the Content Security Policy needs no Google origin. A top-level navigation is not restricted by
 * `form-action` (that directive covers form submissions), and the app sets no navigation directive.
 *
 * Branding (developers.google.com/identity/branding-guidelines, read 2026-11-16): the standard-colour "G" on
 * a white (light), #131314 (dark) background, never recoloured; light fill #FFFFFF with a 1px #747775 stroke
 * and #1F1F1F text, dark fill #131314 with a 1px #8E918F stroke and #E3E3E3 text; 12px left of the logo, 10px
 * between logo and text, 12px right of the text; text "Continue with Google"; at least as prominent as any
 * other third-party option (it is the only one). Google asks for Google Sans Medium 14/20; that font is not
 * bundled, so the stack falls back to Roboto / the system sans at weight 500.
 */
import { useState } from "react";
import { googleStartPath } from "./client";
import { heldInvitation } from "./held-invitation";

/** Google's standard-colour "G" (four paths, Google's colours). Decorative: the link text names it. */
export function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false" className={className}>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

const buttonClass = [
  "flex h-10 w-full items-center justify-center gap-[10px] rounded-full border pr-3 pl-3",
  "font-['Google_Sans',Roboto,system-ui,sans-serif] text-[14px] leading-5 font-medium no-underline",
  // Light (default) and dark, per the guidelines; the app's theme is `data-theme` on <html>.
  "border-[#747775] bg-[#FFFFFF] text-[#1F1F1F] hover:bg-[#F8F8F8]",
  "[[data-theme=dark]_&]:border-[#8E918F] [[data-theme=dark]_&]:bg-[#131314] [[data-theme=dark]_&]:text-[#E3E3E3] [[data-theme=dark]_&]:hover:bg-[#1E1E20]",
  "outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--accent)]",
].join(" ");

/**
 * The link to start. An invitation held in this tab (the person came from an invitation page) goes with it,
 * so a sign-in or a new account through Google ends on that invitation (the trip to Google reloads the
 * page, which empties that memory).
 */
export function ContinueWithGoogle({ next }: { next: string }) {
  const [invitation] = useState(() => heldInvitation()?.token ?? null);
  return (
    <a href={googleStartPath(next, invitation)} className={buttonClass}>
      <GoogleLogo className="size-[18px] shrink-0" />
      <span>Continue with Google</span>
    </a>
  );
}

/** The "or" between the form and the Google button. */
export function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-[12px] text-ink-3" role="separator">
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span>or</span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}

/** The server's `?google=<code>` after the callback (packages/cloud federation/service.ts), as a sentence. */
export function googleProblem(code: string | null): string | null {
  switch (code) {
    case null:
    case "":
    case "linked":
      return null;
    case "cancelled":
      return "Google sign-in was cancelled. You can try again, or use your email and password.";
    case "expired":
      return "That Google sign-in took too long or was opened in another browser. Start again from this page.";
    case "unverified":
      return "Google has not confirmed the email address of that Google account, so we cannot use it.";
    case "disposable":
      return "Addresses from disposable email services are not accepted.";
    case "taken":
      return "That Google account is already linked to another Glideworth account.";
    case "already-linked":
      return "A Google account is already linked. Unlink it first to link a different one.";
    case "session":
      return "Your session changed while you were at Google. Sign in again and link Google from this page.";
    case "rate-limited":
      return "Too many attempts. Wait a few minutes and try again.";
    default:
      return "Google sign-in did not work this time. Try again in a moment.";
  }
}
