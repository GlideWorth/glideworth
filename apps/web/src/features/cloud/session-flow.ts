/**
 * What happens when a sign-in succeeds (password, second factor, reset, verification): the session is
 * fetched again, every other cached answer is dropped (they belonged to nobody), and the person is sent
 * to the validated `next` page. All in the app, no page reload, so an invitation token held in memory
 * survives a sign-in detour.
 */
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { safeNext } from "./next";

/** Handed from the password step to the two-factor step. Memory only: the challenge is a credential. */
type Challenge = {
  token: string;
  next: string;
  /** From the set-password page: tell a waiting tab once the code is accepted (lib/reauth.ts). */
  announceReauth?: boolean;
};
let challenge: Challenge | null = null;
export const setChallenge = (c: Challenge | null) => {
  challenge = c;
};
export const getChallenge = () => challenge;

export async function refreshSession(qc: QueryClient): Promise<void> {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
  await qc.refetchQueries({ queryKey: ["session"] });
}

/** `to` is a same-origin path with optional query and fragment (already checked by `safeNext`). */
export function useGoTo() {
  const navigate = useNavigate();
  return useCallback(
    (path: string) => {
      const u = new URL(safeNext(path), window.location.origin);
      return navigate({
        to: u.pathname,
        search: Object.fromEntries(u.searchParams) as never,
        ...(u.hash ? { hash: u.hash.slice(1) } : {}),
      } as never);
    },
    [navigate],
  );
}

export function useFinishSignIn() {
  const qc = useQueryClient();
  const go = useGoTo();
  return useCallback(
    async (redirectTo: string | undefined, next: string) => {
      setChallenge(null);
      await refreshSession(qc);
      await go(redirectTo ? safeNext(redirectTo) : next);
    },
    [qc, go],
  );
}
