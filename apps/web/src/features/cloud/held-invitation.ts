/**
 * The invitation a person opened in this tab, held in memory while they sign in or create an account. It is
 * not in the address bar and not in storage; if the page is reloaded the email link is opened again.
 *
 * Signing in keeps the person in this tab, so the invitation page finds it here afterwards. A new account is
 * confirmed from an email link, usually in another tab, so sign-up also sends the token to the server, which
 * keeps it (sealed) with the verification link and sends the person back to `/invite#token=…` once the
 * address is confirmed.
 */
import type { InviteRole } from "./client";

export interface HeldInvitation {
  token: string;
  /** What the invitation offers, once the server has said (`previewInvitation`). */
  offer?: { workspaceName: string; role: InviteRole };
}

let held: HeldInvitation | null = null;

export const holdInvitation = (h: HeldInvitation | null): void => {
  held = h;
};

export const heldInvitation = (): HeldInvitation | null => held;

/** "a viewer" / "an editor", and what that role can do, for invitation copy. */
export const ROLE_TEXT: Record<InviteRole, { name: string; can: string }> = {
  editor: { name: "an editor", can: "Editors can see and change the plans." },
  viewer: { name: "a viewer", can: "Viewers can see the plans but not change them." },
};
