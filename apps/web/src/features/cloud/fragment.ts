/**
 * Tokens that arrive in the URL fragment (`/verify-email#token=…`, `/reset-password#token=…`,
 * `/confirm-email#token=…`, `/invite#token=…`; see packages/cloud accounts/service.ts `link()`). A
 * fragment is never sent to a server, which keeps the token out of logs and `Referer` headers. The app
 * reads it once, then removes it from the address bar and the history entry. It is never put in a query
 * string and never stored.
 */
import { useEffect, useState } from "react";

/** Read `name` from the fragment (pure: no side effect, so React may call it twice). */
export function readFragmentParam(
  name = "token",
  hash: string = window.location.hash,
): string | null {
  const v = new URLSearchParams(hash.replace(/^#/, "")).get(name);
  return v && v.length <= 256 ? v : null;
}

/** Drop the fragment from the address bar without adding a history entry or reloading. */
function clearFragment(): void {
  const { pathname, search, hash } = window.location;
  if (hash) window.history.replaceState(window.history.state, "", `${pathname}${search}`);
}

/** The fragment token, captured on first render and cleared from the URL right after mount. */
export function useFragmentToken(name = "token"): string | null {
  const [token] = useState(() => readFragmentParam(name));
  useEffect(() => clearFragment(), []);
  return token;
}
