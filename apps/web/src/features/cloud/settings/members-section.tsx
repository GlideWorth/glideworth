/**
 * Members: who is in the workspace and with which role, invitations (send, resend, withdraw), seat limits,
 * handing ownership to an editor, and leaving. Only the owner changes people; everyone sees the list.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Crown, LogOut, Loader2, Mail, UserMinus, UserPlus, Users } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { confirmAction } from "../../../components/ui/confirm-dialog";
import { EmptyState } from "../../../components/ui/empty-state";
import { Select } from "../../../components/ui/select";
import { toast } from "../../../components/ui/toaster";
import { ApiRequestError } from "../../../lib/api-error";
import { useCloudSession } from "../../../lib/auth";
import { ROLE_HINT, ROLE_LABEL } from "../../../lib/access";
import { withReauth } from "../../../lib/reauth";
import { SectionIntro, SettingsGroup } from "../../settings/settings-ui";
import { cloudApi, type InviteRole, type Invitation, type Member } from "../client";
import { fmtDate, plural } from "../format";
import { failToast, Loading, LoadError } from "../settings-kit";
import { describeError, FormAlert, isCode, Notice, TextField, useErrorFocus } from "../ui";
import { nav } from "../next";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function MembersSection() {
  const qc = useQueryClient();
  const me = useCloudSession()?.user.id;
  const settings = useQuery({
    queryKey: ["cloud", "workspace"],
    queryFn: cloudApi.workspaceSettings,
    retry: false,
  });
  const members = useQuery({
    queryKey: ["cloud", "members"],
    queryFn: cloudApi.members,
    retry: false,
  });
  const owner = settings.data?.role === "owner";
  const invitations = useQuery({
    queryKey: ["cloud", "invitations"],
    queryFn: cloudApi.invitations,
    retry: false,
    enabled: owner,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["cloud", "members"] });
    void qc.invalidateQueries({ queryKey: ["cloud", "invitations"] });
  };

  const changeRole = useMutation({
    mutationFn: (v: { m: Member; role: InviteRole }) => cloudApi.changeRole(v.m.userId, v.role),
    onSuccess: (_r, v) => {
      refresh();
      toast({ title: `${v.m.name} is now ${ROLE_LABEL[v.role].toLowerCase()}`, tone: "positive" });
    },
    onError: (e) => failToast("Role not changed", e),
  });
  const remove = useMutation({
    mutationFn: (m: Member) => cloudApi.removeMember(m.userId),
    onSuccess: (_r, m) => {
      refresh();
      toast({
        title: `${m.name} was removed`,
        description: "Their API keys and connected apps stopped working.",
        tone: "positive",
      });
    },
    onError: (e) => failToast("Could not remove them", e),
  });
  const transfer = useMutation({
    mutationFn: (m: Member) => withReauth(() => cloudApi.transferOwnership(m.userId)),
    onSuccess: (_r, m) => {
      toast({ title: `${m.name} is now the owner`, tone: "positive" });
      nav.go("/");
    },
    onError: (e) => failToast("Ownership not transferred", e),
  });
  const leave = useMutation({
    mutationFn: () => cloudApi.leaveWorkspace(),
    onSuccess: () => nav.go("/"),
    onError: (e) => failToast("Could not leave", e),
  });
  const revokeInvite = useMutation({
    mutationFn: (i: Invitation) => cloudApi.revokeInvitation(i.id),
    onSuccess: (_r, i) => {
      refresh();
      toast({ title: `Invitation to ${i.email} withdrawn`, tone: "positive" });
    },
    onError: (e) => failToast("Could not withdraw the invitation", e),
  });
  const resend = useMutation({
    // A new link, valid for 7 days; the old link stops working.
    mutationFn: (i: Invitation) => cloudApi.resendInvitation(i.id),
    onSuccess: (_r, i) => {
      refresh();
      toast({ title: `Invitation sent again to ${i.email}`, tone: "positive" });
    },
    onError: (e) => {
      refresh();
      failToast("Could not send it again", e);
    },
  });

  if (settings.isLoading || members.isLoading) return <Loading what="members" />;
  if (settings.isError || members.isError || !settings.data || !members.data)
    return (
      <LoadError
        error={settings.error ?? members.error}
        what="Members"
        onRetry={() => {
          void settings.refetch();
          void members.refetch();
        }}
      />
    );

  const people = members.data.items;
  const pending = invitations.data?.items ?? [];
  const limits = settings.data.limits;
  // Seats: the owner counts as an editor; a pending invitation holds its seat.
  const used = (role: InviteRole) =>
    people.filter((p) =>
      role === "editor" ? p.role === "owner" || p.role === "editor" : p.role === "viewer",
    ).length + pending.filter((i) => i.role === role).length;
  const seats = {
    editor: { used: used("editor"), limit: limits?.editors },
    viewer: { used: used("viewer"), limit: limits?.viewers },
  };
  const full = (role: InviteRole) =>
    seats[role].limit !== undefined && seats[role].used >= seats[role].limit!;

  return (
    <>
      <SectionIntro title="Members">
        Everyone here sees the same workspace. Editors can change plans; viewers can look and run
        simulations. Only the owner manages people and billing.
      </SectionIntro>

      <SettingsGroup
        title="Seats"
        description="What your plan allows. The owner counts as an editor, and a pending invitation holds a seat."
      >
        <div className="flex flex-wrap gap-x-8 gap-y-2 px-5 py-4 text-[13px] text-ink-2">
          {(["editor", "viewer"] as const).map((r) => (
            <div key={r}>
              <span className="font-medium text-ink">
                {r === "editor" ? "Editors" : "Viewers"}:{" "}
              </span>
              {seats[r].limit !== undefined
                ? `${seats[r].used} of ${seats[r].limit} used`
                : `${seats[r].used} used`}
              {full(r) ? (
                <Badge tone="ochre" className="ml-2">
                  Full
                </Badge>
              ) : null}
            </div>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="People">
        {people.length <= 1 ? (
          <EmptyState icon={Users} title="Just you so far" compact>
            {owner
              ? "Invite a partner to plan with you, or an adviser to look without changing anything."
              : "You are the only member shown."}
          </EmptyState>
        ) : null}
        <ul>
          {people.map((m) => {
            const mine = m.userId === me;
            return (
              <li
                key={m.userId}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-ink">
                    {m.name}
                    {mine ? <Badge tone="accent">You</Badge> : null}
                    <Badge tone={m.role === "owner" ? "ochre" : "neutral"}>
                      {ROLE_LABEL[m.role]}
                    </Badge>
                  </div>
                  {m.email ? (
                    <div className="mt-0.5 text-[12px] break-all text-ink-2">{m.email}</div>
                  ) : null}
                  <div className="mt-0.5 text-[11.5px] text-ink-3">{ROLE_HINT[m.role]}</div>
                </div>
                {owner && m.role !== "owner" ? (
                  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    <Select<InviteRole>
                      aria-label={`Role of ${m.name}`}
                      className="w-[110px]"
                      value={m.role as InviteRole}
                      onValueChange={(role) => role !== m.role && changeRole.mutate({ m, role })}
                      options={[
                        { value: "editor", label: "Editor" },
                        { value: "viewer", label: "Viewer" },
                      ]}
                    />
                    {m.role === "editor" ? (
                      <Button
                        size="sm"
                        aria-label={`Make ${m.name} the owner`}
                        onClick={async () => {
                          if (
                            await confirmAction({
                              title: `Make ${m.name} the owner?`,
                              description:
                                "They take over billing and all owner controls, and you become an editor. API keys and connected apps of both of you stop working and must be set up again. You will be asked for your password.",
                              confirmLabel: "Transfer ownership",
                              tone: "primary",
                            })
                          )
                            transfer.mutate(m);
                        }}
                      >
                        <Crown /> Make owner
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-negative"
                      aria-label={`Remove ${m.name}`}
                      onClick={async () => {
                        if (
                          await confirmAction({
                            title: `Remove ${m.name}?`,
                            description:
                              "They lose access to this workspace at once, and their API keys and connected apps stop working. They can be invited again.",
                            confirmLabel: "Remove",
                          })
                        )
                          remove.mutate(m);
                      }}
                    >
                      <UserMinus /> Remove
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </SettingsGroup>

      {owner ? (
        <>
          <InviteForm full={full} seats={seats} onInvited={refresh} />
          <SettingsGroup title="Pending invitations" description="Each link works for 7 days.">
            {invitations.isLoading ? (
              <Loading what="invitations" />
            ) : invitations.isError ? (
              <LoadError
                error={invitations.error}
                what="Invitations"
                onRetry={() => void invitations.refetch()}
              />
            ) : pending.length === 0 ? (
              <EmptyState icon={Mail} title="No pending invitations" compact />
            ) : (
              <ul>
                {pending.map((i) => (
                  <li
                    key={i.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-3 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium break-all text-ink">
                        {i.email}
                        <Badge>{ROLE_LABEL[i.role]}</Badge>
                      </div>
                      <div className="mt-0.5 text-[11.5px] text-ink-3">
                        {i.expiresAt ? `Expires ${fmtDate(i.expiresAt)}` : "Waiting for a reply"}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        aria-label={`Send the invitation to ${i.email} again`}
                        disabled={resend.isPending}
                        onClick={() => resend.mutate(i)}
                      >
                        {resend.isPending && resend.variables?.id === i.id ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Mail />
                        )}
                        Resend
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-negative"
                        aria-label={`Withdraw the invitation to ${i.email}`}
                        disabled={revokeInvite.isPending}
                        onClick={() => revokeInvite.mutate(i)}
                      >
                        Withdraw
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SettingsGroup>
        </>
      ) : (
        <SettingsGroup title="Leave this workspace">
          <div className="flex flex-wrap items-center gap-4 px-5 py-4">
            <p className="min-w-0 flex-1 text-[13px] text-ink-2">
              You will lose access to its plans and any API keys you made for it. The owner can
              invite you again.
            </p>
            <Button
              variant="danger"
              size="sm"
              disabled={leave.isPending}
              onClick={async () => {
                if (
                  await confirmAction({
                    title: "Leave this workspace?",
                    description: "You lose access at once. The owner can invite you again.",
                    confirmLabel: "Leave",
                  })
                )
                  leave.mutate();
              }}
            >
              {leave.isPending ? <Loader2 className="animate-spin" /> : <LogOut />} Leave workspace
            </Button>
          </div>
        </SettingsGroup>
      )}
    </>
  );
}

function InviteForm({
  full,
  seats,
  onInvited,
}: {
  full: (role: InviteRole) => boolean;
  seats: Record<InviteRole, { used: number; limit: number | undefined }>;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("editor");
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { ref, failed } = useErrorFocus();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setSentTo(null);
    setFormError(null);
    if (!EMAIL.test(email.trim())) {
      setError("Enter a valid email address.");
      return failed();
    }
    if (full(role)) {
      setFormError(
        `All ${plural(seats[role].limit ?? 0, role)} on your plan are used. Remove someone, withdraw an invitation or change plan to add another.`,
      );
      return failed();
    }
    setError(undefined);
    setBusy(true);
    try {
      await cloudApi.invite(email.trim(), role);
      setSentTo(email.trim());
      setEmail("");
      onInvited();
    } catch (err) {
      if (isCode(err, "SEAT_LIMIT")) {
        const d = (err as ApiRequestError).details as { limit?: number; role?: string } | undefined;
        setFormError(
          `Your plan allows ${d?.limit ?? "a fixed number of"} ${d?.role === "viewer" ? "viewers" : "editors"}, and all are in use.`,
        );
      } else if (isCode(err, "DISPOSABLE_EMAIL") || isCode(err, "VALIDATION"))
        setError(describeError(err));
      else setFormError(describeError(err));
      failed();
    }
    setBusy(false);
  };

  return (
    <SettingsGroup
      title="Invite someone"
      description="They get an email with a link that works for 7 days. They need an account with that address."
    >
      <form ref={ref} onSubmit={submit} className="flex flex-col gap-3 px-5 py-4" noValidate>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
          <TextField
            large={false}
            label="Email address"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="off"
            inputMode="email"
            error={error}
          />
          <div className="flex flex-col gap-1">
            <span aria-hidden className="text-[12px] font-medium text-ink-2">
              Role
            </span>
            <Select<InviteRole>
              aria-label="Role for the invitation"
              value={role}
              onValueChange={setRole}
              options={[
                { value: "editor", label: "Editor", hint: "Can change plans" },
                { value: "viewer", label: "Viewer", hint: "Can only look" },
              ]}
            />
          </div>
        </div>
        {formError ? <FormAlert>{formError}</FormAlert> : null}
        <div role="status" aria-live="polite">
          {sentTo ? <Notice>Invitation sent to {sentTo}.</Notice> : null}
        </div>
        <div>
          <Button type="submit" size="sm" variant="primary" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <UserPlus />} Send invitation
          </Button>
        </div>
      </form>
    </SettingsGroup>
  );
}
