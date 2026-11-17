/**
 * Re-authentication for sensitive actions (cloud). The API answers `403 REAUTH_REQUIRED` when the last
 * password check is older than 10 minutes. `withReauth(action)` runs the action; on that answer it asks
 * the person to confirm (the dialog is features/cloud/reauth-dialog.tsx, mounted by the shell in cloud
 * mode only) and runs the same action once more. Cancelling throws `ReauthCancelled`, which callers
 * treat as "the person changed their mind", not as an error.
 *
 * An account with no password confirms through an emailed link that sets one, which opens in another tab.
 * When that tab finishes (and the server says the session now counts as re-authenticated), it announces it
 * on a same-origin BroadcastChannel; the waiting prompt then settles and the refused action runs again.
 * The message carries nothing secret: the server's session state is what decides.
 */
import { create } from "zustand";
import { ApiRequestError } from "./api-error";

const useReauthState = create<{ open: boolean }>(() => ({ open: false }));
export const useReauthOpen = () => useReauthState((s) => s.open);

let pending: Promise<boolean> | null = null;
let settle: ((ok: boolean) => void) | null = null;

/** Ask for re-authentication; concurrent callers share one prompt. Resolves true once confirmed. */
function requestReauth(): Promise<boolean> {
  pending ??= new Promise<boolean>((resolve) => {
    settle = (ok) => {
      pending = null;
      settle = null;
      useReauthState.setState({ open: false });
      resolve(ok);
    };
    useReauthState.setState({ open: true });
  });
  return pending;
}

/** Called by the dialog. */
export function settleReauth(ok: boolean): void {
  settle?.(ok);
}

export class ReauthCancelled extends Error {
  constructor() {
    super("Re-authentication was cancelled");
    this.name = "ReauthCancelled";
  }
}

export async function withReauth<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (e) {
    if (!(e instanceof ApiRequestError && e.code === "REAUTH_REQUIRED")) throw e;
    if (!(await requestReauth())) throw new ReauthCancelled();
    return action();
  }
}

const CHANNEL = "glideworth-reauth";
const MESSAGE = "reauthenticated";

/** Tell this browser's other tabs that the session was just re-authenticated (set-password page). */
export function announceReauth(): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const c = new BroadcastChannel(CHANNEL);
    c.postMessage(MESSAGE);
    c.close();
  } catch {
    // Not available (an old browser, a sandboxed frame): the other tab can still retry by hand.
  }
}

/** Listen for `announceReauth` from another tab. Returns the unsubscribe function. */
export function onReauthAnnounced(cb: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  let c: BroadcastChannel;
  try {
    c = new BroadcastChannel(CHANNEL);
  } catch {
    return () => undefined;
  }
  c.onmessage = (e: MessageEvent) => {
    if (e.data === MESSAGE) cb();
  };
  return () => c.close();
}
