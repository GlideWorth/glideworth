/**
 * `/accept#token=…`: accept an invite or a passphrase reset (public; see AcceptInviteScreen). The token is in
 * the fragment, which is never sent to a server, so a reverse proxy cannot log it. Links made before that
 * carry it in the query string (`/accept?token=…`) and still work. Either way the page reads the token once
 * and removes it from the address bar and the history entry.
 */
import { useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AcceptInviteScreen } from "../../components/layout/auth-gate";
import { useFragmentToken } from "../cloud/fragment";

/** The link the owner hands over. */
export const acceptLink = (origin: string, token: string): string =>
  `${origin}/accept#token=${encodeURIComponent(token)}`;

export function AcceptPage() {
  const { token: fromQuery } = useSearch({ strict: false }) as { token?: string };
  const fromFragment = useFragmentToken();
  const [token] = useState(() => fromFragment ?? fromQuery ?? "");
  useEffect(() => {
    const { pathname, search, hash } = window.location;
    const q = new URLSearchParams(search);
    if (!q.has("token")) return;
    q.delete("token");
    const rest = q.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${pathname}${rest ? `?${rest}` : ""}${hash}`,
    );
  }, []);
  return <AcceptInviteScreen token={token} />;
}
