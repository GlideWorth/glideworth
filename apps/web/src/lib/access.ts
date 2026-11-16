/**
 * Who is using Glideworth and what they may do. Roles are instance-wide (API.md "Household
 * collaboration"): owner (everything), editor (read and write, not people/webhooks/audit), viewer
 * (read and simulate only). The server enforces them; the UI hides or disables write actions so a
 * viewer never meets a "403" after typing something.
 */
import { useQuery } from "@tanstack/react-query";
import type { Role } from "./api";
import { loadApi } from "./api-lazy";
import { useSession } from "./auth";
import { useWorkspace } from "./workspace";

export interface Access {
  role: Role;
  canWrite: boolean;
  isOwner: boolean;
  /** The signed-in person's name (multi-user instances), when known. */
  name?: string;
  userId?: string;
  /** True when the instance has more than one sign-in. */
  multiUser: boolean;
  /** Cloud: the workspace's plan is read-only (trial over, payment lapsed, suspended). Nobody can write. */
  planReadOnly: boolean;
  /** Still working out the role (treat as allowed so the UI does not flash disabled). */
  loading: boolean;
}

export function useMe() {
  const { data: ws } = useWorkspace();
  return useQuery({
    queryKey: ["me"],
    enabled: ws?.source === "api",
    queryFn: async () => (await loadApi()).me(),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useAccess(): Access {
  const session = useSession();
  const me = useMe();
  const { data: ws } = useWorkspace();
  const s = session.data;
  const fromSession = s?.kind === "authenticated" ? s.user : undefined;
  const role: Role =
    fromSession?.role ??
    me.data?.role ??
    (me.data && !me.data.scopes.includes("write") ? "viewer" : "owner");
  // Offline sample data is the user's own scratchpad: every edit stays in this browser.
  const offline = ws?.source === "sample";
  const level = s?.kind === "authenticated" ? s.cloud?.workspace?.access?.level : undefined;
  const planReadOnly = !offline && level !== undefined && level !== "full";
  const name = fromSession?.name ?? me.data?.userName ?? undefined;
  const userId = fromSession?.id ?? me.data?.userId ?? undefined;
  return {
    role: offline ? "owner" : role,
    canWrite: (offline || role !== "viewer") && !planReadOnly,
    isOwner: offline || role === "owner",
    ...(name ? { name } : {}),
    ...(userId ? { userId } : {}),
    planReadOnly,
    multiUser: s?.kind === "authenticated" ? !!s.multiUser : false,
    loading: session.isLoading || (ws?.source === "api" && me.isLoading && !fromSession),
  };
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
};
export const ROLE_HINT: Record<Role, string> = {
  owner: "Everything, including people, webhooks and the audit log.",
  editor: "Can change plans and finances, import data and share links. A partner, usually.",
  viewer: "Can look and run simulations, never change anything. An adviser, usually.",
};
