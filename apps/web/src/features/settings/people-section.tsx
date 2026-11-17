/**
 * People & access (owner): who can sign in, with which role, invites and passphrase resets; plus
 * connected apps (OAuth grants and clients) and the audit log. Everyone sees their own connected
 * apps; people, clients and the audit log are the owner's.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  History,
  Link2,
  Loader2,
  Plug,
  ShieldAlert,
  TriangleAlert,
  UserPlus,
  Users,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { EmptyState } from "../../components/ui/empty-state";
import { Field, Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import { ROLE_HINT, ROLE_LABEL, useAccess } from "../../lib/access";
import { ApiRequestError, api, type Role, type UserInfo } from "../../lib/api";
import { useMode } from "../../lib/auth";
import { useFormat } from "../../lib/workspace";
import { acceptLink } from "../share/accept-page";
import { CopyButton, relativeTime } from "./keys-section";
import { LoadErrorText, SectionIntro, SettingsGroup } from "./settings-ui";

const errText = (e: unknown) =>
  e instanceof ApiRequestError
    ? e.code === "OWNER_PROTECTED"
      ? "The owner cannot be demoted, disabled or removed."
      : e.code === "LOGIN_TAKEN"
        ? "That sign-in name is already in use."
        : e.code === "SETUP_REQUIRED"
          ? "Choose the owner’s passphrase first (the first-run sign-in screen), then invite people."
          : e.message
    : e instanceof Error
      ? e.message
      : String(e);

function Unavailable({ error, what }: { error: unknown; what: string }) {
  const forbidden = error instanceof ApiRequestError && error.status === 403;
  return (
    <EmptyState
      icon={forbidden ? ShieldAlert : TriangleAlert}
      title={`${what} unavailable`}
      compact
    >
      <LoadErrorText
        error={error}
        use="see this"
        forbidden="Only the owner of this Glideworth can see this."
        missing="This server does not offer it yet. Update Glideworth to use it."
      />
    </EmptyState>
  );
}

/** A one-time link to hand over (invite or reset), shown once. */
function TokenDialog({
  token,
  onClose,
}: {
  token: { name: string; kind: "invite" | "reset"; token: string; expiresAt: string } | null;
  onClose: () => void;
}) {
  const f = useFormat();
  const link = token ? acceptLink(window.location.origin, token.token) : "";
  return (
    <Dialog open={!!token} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={
          token?.kind === "reset"
            ? `Reset link for ${token?.name}`
            : `Invite link for ${token?.name ?? ""}`
        }
        description="Send this link to them privately. It works once, and they choose their own passphrase, so you never learn it."
      >
        <div className="flex flex-col gap-3">
          <code className="block rounded-lg border border-border bg-surface-2 px-3 py-2.5 font-mono text-[12px] break-all select-all">
            {link}
          </code>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[12px] text-ink-3">
              Expires{" "}
              {token
                ? new Intl.DateTimeFormat(f.locale, { dateStyle: "medium" }).format(
                    Date.parse(token.expiresAt),
                  )
                : ""}
              . It is not shown again.
            </p>
            {token ? <CopyButton text={link} label="Copy link" /> : null}
          </div>
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PeopleSection() {
  const access = useAccess();
  const f = useFormat();
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ["users"],
    queryFn: api.listUsers,
    retry: false,
    enabled: access.isOwner,
  });
  const [inviting, setInviting] = useState(false);
  const [token, setToken] = useState<{
    name: string;
    kind: "invite" | "reset";
    token: string;
    expiresAt: string;
  } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });
  const act = useMutation({
    mutationFn: async (a: {
      kind: "role" | "disable" | "enable" | "remove" | "reset" | "reinvite";
      u: UserInfo;
      role?: Role;
    }) => {
      switch (a.kind) {
        case "role":
          return api.updateUser(a.u.id, { role: a.role as "editor" | "viewer" });
        case "disable":
          return api.updateUser(a.u.id, { disabled: true });
        case "enable":
          return api.updateUser(a.u.id, { disabled: false });
        case "remove":
          return api.deleteUser(a.u.id);
        case "reset": {
          const r = await api.resetUserPassphrase(a.u.id);
          setToken({
            name: a.u.name,
            kind: "reset",
            token: r.reset.token,
            expiresAt: r.reset.expiresAt,
          });
          return r;
        }
        case "reinvite": {
          const r = await api.reinviteUser(a.u.id);
          setToken({
            name: a.u.name,
            kind: "invite",
            token: r.invite.token,
            expiresAt: r.invite.expiresAt,
          });
          return r;
        }
      }
    },
    onSuccess: () => void refresh(),
    onError: (e) => toast({ title: "Not changed", description: errText(e), tone: "negative" }),
  });

  if (!access.isOwner)
    return (
      <>
        <SectionIntro title="People & access">
          You are signed in as {access.name ?? "a member of this household"} with the{" "}
          {ROLE_LABEL[access.role].toLowerCase()} role. {ROLE_HINT[access.role]}
        </SectionIntro>
        <SettingsGroup title="Your role">
          <div className="px-5 py-4 text-[13px] text-ink-2">
            Only the owner can invite people or change roles. Ask them if you need more access.
          </div>
        </SettingsGroup>
      </>
    );

  const items = users.data?.items ?? [];
  return (
    <>
      <SectionIntro title="People & access">
        Invite a partner to plan with you, or an adviser to look without changing anything. Roles
        apply to everything on this Glideworth: their sign-in, their API keys and the apps they
        connect.
      </SectionIntro>
      <SettingsGroup
        title="People"
        description="Owner: everything. Editor: changes plans and finances. Viewer: looks and runs simulations."
        actions={
          <Button
            size="sm"
            variant="primary"
            onClick={() => setInviting(true)}
            disabled={users.isError}
          >
            <UserPlus /> Invite someone
          </Button>
        }
      >
        {users.isLoading ? (
          <div className="flex items-center gap-2 px-5 py-6 text-[12.5px] text-ink-3">
            <Loader2 className="size-4 animate-spin" /> Loading people…
          </div>
        ) : users.isError ? (
          <Unavailable error={users.error} what="People" />
        ) : items.length <= 1 ? (
          <EmptyState icon={Users} title="Just you so far" compact>
            Invite someone and they choose their own passphrase. Until then, sign-in needs only your
            passphrase.
          </EmptyState>
        ) : null}
        {items.length ? (
          <ul>
            {items.map((u) => (
              <li
                key={u.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold">{u.name}</span>
                    <code className="font-mono text-[11.5px] text-ink-3">{u.login}</code>
                    {u.status !== "active" ? (
                      <Badge tone={u.status === "disabled" ? "negative" : "ochre"}>
                        {u.status === "invited" ? "Invited" : "Disabled"}
                      </Badge>
                    ) : null}
                    {u.id === access.userId ? <Badge>You</Badge> : null}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-ink-3">
                    Added {relativeTime(u.createdAt, f.locale)} · last signed in{" "}
                    {relativeTime(u.lastLoginAt, f.locale).toLowerCase()}
                  </div>
                </div>
                {u.role === "owner" ? (
                  <Badge tone="accent">Owner</Badge>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Select
                      aria-label={`Role of ${u.name}`}
                      className="h-7 w-[110px]"
                      value={u.role}
                      onValueChange={(role) => act.mutate({ kind: "role", u, role })}
                      options={[
                        { value: "editor", label: "Editor" },
                        { value: "viewer", label: "Viewer" },
                      ]}
                    />
                    {u.status === "invited" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => act.mutate({ kind: "reinvite", u })}
                      >
                        <Link2 /> New invite link
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => act.mutate({ kind: "reset", u })}
                      >
                        Reset passphrase
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        act.mutate({ kind: u.status === "disabled" ? "enable" : "disable", u })
                      }
                    >
                      {u.status === "disabled" ? "Enable" : "Disable"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-negative"
                      onClick={async () => {
                        if (
                          await confirmAction({
                            title: `Remove ${u.name}?`,
                            description:
                              "Their sessions, API keys and connected apps stop working at once. Plan history keeps their name.",
                            confirmLabel: "Remove",
                          })
                        )
                          act.mutate({ kind: "remove", u });
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsGroup>
      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        onInvited={(u, t) => {
          void refresh();
          setToken({ name: u.name, kind: "invite", token: t.token, expiresAt: t.expiresAt });
        }}
      />
      <TokenDialog token={token} onClose={() => setToken(null)} />
    </>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onInvited: (u: UserInfo, t: { token: string; expiresAt: string }) => void;
}) {
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [error, setError] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () =>
      api.inviteUser({ name: name.trim(), role, ...(login.trim() ? { login: login.trim() } : {}) }),
    onSuccess: (r) => {
      onOpenChange(false);
      setName("");
      setLogin("");
      onInvited(r.user, r.invite);
    },
    onError: (e) => setError(errText(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Add their name.");
    invite.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Invite someone" description="You get a one-time link to send them.">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Alex"
                maxLength={80}
              />
            )}
          </Field>
          <Field label="Sign-in name" hint="Optional; made from their name if empty.">
            {(id) => (
              <Input
                id={id}
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                autoCapitalize="none"
                spellCheck={false}
                maxLength={40}
              />
            )}
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[12px] font-medium text-ink-2">Role</legend>
            {(["editor", "viewer"] as const).map((r) => (
              <label
                key={r}
                className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border px-3 py-2 has-[:checked]:border-accent/60 has-[:checked]:bg-accent-soft/40"
              >
                <input
                  type="radio"
                  name="invite-role"
                  className="mt-0.5 accent-[var(--accent)]"
                  checked={role === r}
                  onChange={() => setRole(r)}
                />
                <span>
                  <span className="block text-[13px] font-medium">{ROLE_LABEL[r]}</span>
                  <span className="block text-[12px] text-ink-3">{ROLE_HINT[r]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {error ? (
            <p role="alert" className="text-[12.5px] text-negative">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={invite.isPending}>
              {invite.isPending ? <Loader2 className="animate-spin" /> : <UserPlus />} Create invite
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------- connected apps

export function ConnectedAppsSection() {
  const access = useAccess();
  // Hosted: apps register with the service as a whole, before anyone signs in. A workspace holds only the
  // apps someone in it allowed (copied at consent), so that is what this list shows and what Delete removes.
  const cloud = useMode() === "cloud";
  const f = useFormat();
  const qc = useQueryClient();
  const grants = useQuery({
    queryKey: ["oauth-grants"],
    queryFn: api.listOAuthGrants,
    retry: false,
  });
  const clients = useQuery({
    queryKey: ["oauth-clients"],
    queryFn: api.listOAuthClients,
    retry: false,
    enabled: access.isOwner,
  });
  const revoke = useMutation({
    mutationFn: (a: { kind: "grant" | "client"; id: string }) =>
      a.kind === "grant" ? api.revokeOAuthGrant(a.id) : api.deleteOAuthClient(a.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["oauth-grants"] });
      void qc.invalidateQueries({ queryKey: ["oauth-clients"] });
      toast({
        title: "Access removed",
        description: "The app must ask again before it can connect.",
      });
    },
    onError: (e) => toast({ title: "Not removed", description: errText(e), tone: "negative" }),
  });
  return (
    <>
      <SectionIntro title="Connected apps">
        AI assistants and other apps that connected to Glideworth&rsquo;s MCP server by signing in
        (OAuth) rather than with a pasted key. Each can do only what you allowed on the consent
        screen, and never more than your role.
      </SectionIntro>
      <SettingsGroup title="Apps you allowed">
        {grants.isLoading ? (
          <div className="flex items-center gap-2 px-5 py-6 text-[12.5px] text-ink-3">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : grants.isError ? (
          <Unavailable error={grants.error} what="Connected apps" />
        ) : (grants.data?.items.length ?? 0) === 0 ? (
          <EmptyState icon={Plug} title="No connected apps" compact>
            When an assistant connects to <code className="font-mono">/mcp</code> and you approve
            it, it appears here.
          </EmptyState>
        ) : (
          <ul>
            {grants.data!.items.map((g) => (
              <li
                key={g.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold">{g.clientName}</span>
                    {g.scopes.map((s) => (
                      <Badge key={s} tone={s === "write" ? "ochre" : "neutral"}>
                        {s}
                      </Badge>
                    ))}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-ink-3">
                    Allowed {relativeTime(g.createdAt, f.locale)} · last used{" "}
                    {relativeTime(g.lastUsedAt, f.locale).toLowerCase()}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-negative"
                  onClick={() => revoke.mutate({ kind: "grant", id: g.id })}
                >
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>
      {access.isOwner ? (
        <SettingsGroup
          title={cloud ? "Apps in this workspace (everyone)" : "Registered apps (everyone)"}
          description={
            cloud
              ? "Apps that someone in this workspace allowed. Deleting one disconnects it for every member."
              : "Apps that registered with this server. Deleting one revokes it for every person."
          }
        >
          {clients.isError ? (
            <Unavailable
              error={clients.error}
              what={cloud ? "Apps in this workspace" : "Registered apps"}
            />
          ) : (clients.data?.items.length ?? 0) === 0 ? (
            <div className="px-5 py-4 text-[12.5px] text-ink-3">
              {cloud
                ? "No app has been allowed in this workspace yet. An app appears here once someone approves it on the consent screen."
                : "No apps have registered."}
            </div>
          ) : (
            <ul>
              {clients.data?.items.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold">{c.name}</div>
                    <div className="mt-0.5 truncate text-[11.5px] text-ink-3">
                      {c.redirectUris
                        .map((u) => {
                          try {
                            return new URL(u).host;
                          } catch {
                            return u;
                          }
                        })
                        .join(", ")}{" "}
                      · {c.activeTokens} active · registered {relativeTime(c.createdAt, f.locale)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-negative"
                    onClick={async () => {
                      if (
                        await confirmAction({
                          title: `Delete “${c.name}”?`,
                          description:
                            "Every token it holds stops working. It can register again later.",
                          confirmLabel: "Delete app",
                        })
                      )
                        revoke.mutate({ kind: "client", id: c.id });
                    }}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SettingsGroup>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------------------------ audit log

const VIA_LABEL: Record<string, string> = {
  session: "Browser",
  key: "API key",
  oauth: "Connected app",
  mcp: "MCP",
  system: "Glideworth",
};

/** "PATCH /api/v1/plans/:id/expenses/:itemId" → "Changed a plan expense". */
export function describeAction(action: string): string {
  if (action.startsWith("mcp:")) return `MCP tool ${action.slice(4).replace(/_/g, " ")}`;
  const m = /^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\/(.+)$/.exec(action);
  if (!m) return action.replace(/[._-]/g, " ");
  const verb = {
    GET: "Read",
    POST: "Created",
    PUT: "Replaced",
    PATCH: "Changed",
    DELETE: "Deleted",
  }[m[1]!];
  const parts = m[2]!.split("/").filter((x) => !x.startsWith(":") && !x.startsWith("{"));
  return `${verb} ${parts.join(" › ").replace(/-/g, " ")}`;
}

export function AuditSection() {
  const access = useAccess();
  const f = useFormat();
  const [user, setUser] = useState<string>("all");
  const users = useQuery({
    queryKey: ["users"],
    queryFn: api.listUsers,
    retry: false,
    enabled: access.isOwner,
  });
  const log = useInfiniteQuery({
    queryKey: ["audit-log", user],
    enabled: access.isOwner,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      api.auditLog({
        limit: 50,
        ...(user !== "all" ? { userId: user } : {}),
        ...(pageParam ? { before: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    retry: false,
  });
  const rows = log.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <SectionIntro title="Audit log">
        Who changed what, through which door: every write by a person, an API key, a connected app
        or an MCP tool, refused attempts, sign-ins and consents.
      </SectionIntro>
      <SettingsGroup
        title="Activity"
        actions={
          access.isOwner ? (
            <Select
              aria-label="Filter by person"
              className="h-7 w-[170px]"
              value={user}
              onValueChange={setUser}
              options={[
                { value: "all", label: "Everyone" },
                ...(users.data?.items ?? []).map((u) => ({ value: u.id, label: u.name })),
              ]}
            />
          ) : null
        }
      >
        {!access.isOwner ? (
          <Unavailable
            error={new ApiRequestError(403, "FORBIDDEN", "owner only")}
            what="The audit log"
          />
        ) : log.isLoading ? (
          <div className="flex items-center gap-2 px-5 py-6 text-[12.5px] text-ink-3">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : log.isError ? (
          <Unavailable error={log.error} what="The audit log" />
        ) : rows.length === 0 ? (
          <EmptyState icon={History} title="Nothing recorded yet" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Who</TH>
                  <TH>What</TH>
                  <TH className="max-sm:hidden">Via</TH>
                  <TH numeric>Result</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.id}>
                    <TD className="py-1.5 whitespace-nowrap text-ink-2" title={r.at}>
                      {relativeTime(r.at, f.locale)}
                    </TD>
                    <TD className="py-1.5">{r.userName ?? "—"}</TD>
                    <TD className="py-1.5">
                      {describeAction(r.action)}
                      {r.resourceId ? (
                        <span className="ml-1.5 text-[11.5px] text-ink-3">{r.resourceId}</span>
                      ) : null}
                    </TD>
                    <TD className="py-1.5 text-ink-2 max-sm:hidden">{VIA_LABEL[r.via] ?? r.via}</TD>
                    <TD numeric className="py-1.5">
                      {r.status === null ? (
                        "—"
                      ) : r.status >= 400 ? (
                        <Badge tone="negative">Refused {r.status}</Badge>
                      ) : (
                        <span className="text-ink-3">OK</span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
        {log.hasNextPage ? (
          <div className="flex justify-center px-5 py-3">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void log.fetchNextPage()}
              disabled={log.isFetchingNextPage}
            >
              {log.isFetchingNextPage ? <Loader2 className="animate-spin" /> : null} Older entries
            </Button>
          </div>
        ) : null}
      </SettingsGroup>
    </>
  );
}
