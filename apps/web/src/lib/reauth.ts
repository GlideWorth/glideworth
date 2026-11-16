/**
 * Re-authentication for sensitive actions (cloud). The API answers `403 REAUTH_REQUIRED` when the last
 * password check is older than 10 minutes. `withReauth(action)` runs the action; on that answer it asks
 * the person to confirm (the dialog is features/cloud/reauth-dialog.tsx, mounted by the shell in cloud
 * mode only) and runs the same action once more. Cancelling throws `ReauthCancelled`, which callers
 * treat as "the person changed their mind", not as an error.
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
