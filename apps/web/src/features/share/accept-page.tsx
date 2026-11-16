/** `/accept?token=…`: accept an invite or a passphrase reset (public; see AcceptInviteScreen). */
import { useSearch } from "@tanstack/react-router";
import { AcceptInviteScreen } from "../../components/layout/auth-gate";

export function AcceptPage() {
  const { token } = useSearch({ strict: false }) as { token?: string };
  return <AcceptInviteScreen token={token ?? ""} />;
}
