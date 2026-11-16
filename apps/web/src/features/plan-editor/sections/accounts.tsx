/**
 * Plan-level account behaviour: include/exclude accounts from Current Finances, override how each
 * behaves in THIS plan (growth, fees, access, distributions), and plan accounts that open later.
 */
import {
  ACCOUNT_TYPE_INFO,
  AccountBehaviour,
  type AccountBehaviourPatch,
  type AccountType,
  PlannedAccount,
} from "@glideworth/core";
import { CalendarPlus, Landmark, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  ActionMenu,
  ActionMenuContent,
  ActionMenuItem,
  ActionMenuLabel,
  ActionMenuSeparator,
  ActionMenuTrigger,
  ActionSubMenu,
} from "../../../components/ui/action-menu";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardHeader } from "../../../components/ui/card";
import { EmptyState } from "../../../components/ui/empty-state";
import { Input } from "../../../components/ui/input";
import {
  FieldGrid,
  FormSection,
  Sheet,
  SheetClose,
  SheetContent,
} from "../../../components/ui/sheet";
import { Switch } from "../../../components/ui/switch";
import { useFormat } from "../../../lib/workspace";
import { AccountBehaviourEditor } from "../../finances/account-behaviour";
import { DateRefField, EnumField, FormField, OwnerSelect } from "../components/form";
import { usePlan, useUpdatePlan } from "../components/plan-context";
import { newAccount } from "../state/defaults";
import { useEditorStore } from "../state/doc-store";
import { accountTypeGroups } from "../state/labels";
import { deepEqual } from "../state/merge";
import { useIssues } from "../state/validation";

type Key = keyof AccountBehaviour;

function useInherit(assetClass: "cash" | "portfolio" | "crypto") {
  const plan = usePlan();
  const f = useFormat();
  const r = (s: { kind: string; rate?: number } | undefined) =>
    s?.kind === "fixed" ? f.percent(s.rate ?? 0, 1) : (s?.kind ?? "—");
  const a = plan?.assumptions;
  return {
    growth:
      assetClass === "cash"
        ? `cash ${r(a?.cashReturn)}`
        : assetClass === "crypto"
          ? `crypto ${r(a?.cryptoReturn)}`
          : `stocks ${r(a?.stockReturn)} · bonds ${r(a?.bondReturn)}`,
    dividend: `${r(a?.dividendYield)} yield`,
  };
}

export function AccountsSection() {
  const plan = usePlan();
  const update = useUpdatePlan();
  const finances = useEditorStore((s) => s.draft?.finances);
  const household = useEditorStore((s) => s.draft?.household);
  const f = useFormat();
  const [open, setOpen] = useState<{ kind: "override" | "planned"; id: string } | null>(null);
  if (!plan || !finances || !household) return null;
  const addPlanned = (type: AccountType) => {
    const base = newAccount(type, { household, finances });
    const pa = PlannedAccount.parse({
      ...base,
      balance: 0,
      opensAt: { kind: "planStart", offsetMonths: 12 },
    });
    update((p) => ({ ...p, plannedAccounts: [...p.plannedAccounts, pa] }), `Plan ${pa.name}`);
    setOpen({ kind: "planned", id: pa.id });
  };
  const groups = accountTypeGroups(household.location.country);
  return (
    <>
      <Card>
        <CardHeader eyebrow="From current finances" title="Accounts in this plan" />
        {finances.accounts.length === 0 ? (
          <EmptyState compact icon={Landmark} title="No accounts yet">
            Add accounts in Current Finances. Here you can then change how each behaves in this plan
            only.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {finances.accounts
              .filter((a) => !a.archived)
              .map((a) => {
                const patch = plan.accountSettings[a.id];
                const n = patch ? Object.keys(patch).length : 0;
                const included = !plan.excludedIds.includes(a.id);
                return (
                  <li key={a.id} className="flex items-center gap-3 px-3 py-2 sm:px-4">
                    <Switch
                      size="sm"
                      aria-label={`Include ${a.name} in this plan`}
                      checked={included}
                      onCheckedChange={(on) =>
                        update(
                          (p) => ({
                            ...p,
                            excludedIds: on
                              ? p.excludedIds.filter((x) => x !== a.id)
                              : [...p.excludedIds, a.id],
                          }),
                          on ? `Include ${a.name}` : `Exclude ${a.name}`,
                        )
                      }
                    />
                    <button
                      type="button"
                      className="group min-w-0 flex-1 text-left disabled:opacity-50"
                      disabled={!included}
                      onClick={() => setOpen({ kind: "override", id: a.id })}
                    >
                      <div className="truncate text-[13px] font-medium group-hover:text-accent">
                        {a.name}
                      </div>
                      <div className="truncate text-[11.5px] text-ink-3">
                        {ACCOUNT_TYPE_INFO[a.type].label} · {f.money(a.balance)}
                      </div>
                    </button>
                    {!included ? (
                      <Badge>Excluded</Badge>
                    ) : n ? (
                      <Badge tone="ochre">
                        {n} override{n > 1 ? "s" : ""}
                      </Badge>
                    ) : (
                      <span className="text-[11.5px] text-ink-3">Account defaults</span>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={`Behaviour of ${a.name} in this plan`}
                      disabled={!included}
                      onClick={() => setOpen({ kind: "override", id: a.id })}
                    >
                      <SlidersHorizontal />
                    </Button>
                  </li>
                );
              })}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader
          eyebrow="Opened in the future"
          title="Planned accounts"
          actions={
            <ActionMenu>
              <ActionMenuTrigger asChild>
                <Button size="sm">
                  <Plus /> Plan an account
                </Button>
              </ActionMenuTrigger>
              <ActionMenuContent>
                <ActionMenuLabel>{groups[0]!.label}</ActionMenuLabel>
                {groups[0]!.types.map((t) => (
                  <ActionMenuItem key={t} onSelect={() => addPlanned(t)}>
                    {ACCOUNT_TYPE_INFO[t].label}
                  </ActionMenuItem>
                ))}
                <ActionMenuSeparator />
                {groups.slice(1).map((g) => (
                  <ActionSubMenu key={g.label} label={g.label}>
                    {g.types.map((t) => (
                      <ActionMenuItem key={t} onSelect={() => addPlanned(t)}>
                        {ACCOUNT_TYPE_INFO[t].label}
                      </ActionMenuItem>
                    ))}
                  </ActionSubMenu>
                ))}
              </ActionMenuContent>
            </ActionMenu>
          }
        />
        {plan.plannedAccounts.length === 0 ? (
          <EmptyState compact icon={CalendarPlus} title="Accounts you’ll open later">
            A Lifetime ISA for a child, a SIPP at a new job, a Junior ISA. Planned accounts start
            empty on their opening date and can receive Flows.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {plan.plannedAccounts.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-3 py-2 sm:px-4">
                <button
                  type="button"
                  className="group min-w-0 flex-1 text-left"
                  onClick={() => setOpen({ kind: "planned", id: a.id })}
                >
                  <div className="truncate text-[13px] font-medium group-hover:text-accent">
                    {a.name}
                  </div>
                  <div className="truncate text-[11.5px] text-ink-3">
                    {ACCOUNT_TYPE_INFO[a.type].label}
                  </div>
                </button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label={`Remove ${a.name}`}
                  onClick={() =>
                    update(
                      (p) => ({
                        ...p,
                        plannedAccounts: p.plannedAccounts.filter((x) => x.id !== a.id),
                      }),
                      `Remove ${a.name}`,
                    )
                  }
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <OverrideSheet
        id={open?.kind === "override" ? open.id : null}
        onClose={() => setOpen(null)}
      />
      <PlannedAccountSheet
        id={open?.kind === "planned" ? open.id : null}
        onClose={() => setOpen(null)}
      />
    </>
  );
}

function OverrideSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const plan = usePlan();
  const update = useUpdatePlan();
  const account = useEditorStore((s) => s.draft?.finances.accounts.find((a) => a.id === id));
  const inherit = useInherit(account ? ACCOUNT_TYPE_INFO[account.type].assetClass : "portfolio");
  const finances = useEditorStore((s) => s.draft?.finances);
  const content = (() => {
    if (!plan || !account) return null;
    const patch: AccountBehaviourPatch = plan.accountSettings[account.id] ?? {};
    const effective = AccountBehaviour.parse({ ...account.behaviour, ...patch });
    const write = (next: AccountBehaviourPatch, label: string) =>
      update(
        (p) => {
          const settings = { ...p.accountSettings };
          if (Object.keys(next).length) settings[account.id] = next;
          else delete settings[account.id];
          return { ...p, accountSettings: settings };
        },
        label,
        `${account.id}:override`,
      );
    return (
      <SheetContent
        eyebrow={`In “${plan.name}”`}
        title={account.name}
        description="Changes here apply to this plan only. The account’s own settings live in Current Finances."
        width={620}
        footer={
          <SheetClose asChild>
            <Button variant="primary" className="ml-auto">
              Done
            </Button>
          </SheetClose>
        }
      >
        <AccountBehaviourEditor
          type={account.type}
          value={effective}
          patch={patch}
          inheritGrowth={inherit.growth}
          inheritDividend={inherit.dividend}
          loans={(finances?.realAssets ?? [])
            .filter((r) => r.loan)
            .map((r) => ({ id: r.loan!.id, name: `${r.name} loan` }))}
          onChange={(next, changed) => {
            const np: Record<string, unknown> = { ...patch };
            for (const k of changed) {
              if (deepEqual(next[k], account.behaviour[k])) delete np[k];
              else np[k] = next[k];
            }
            write(np as AccountBehaviourPatch, "Override account behaviour");
          }}
          onResetKeys={(keys: Key[]) => {
            const np: Record<string, unknown> = { ...patch };
            for (const k of keys) delete np[k];
            write(np as AccountBehaviourPatch, "Reset to account default");
          }}
        />
      </SheetContent>
    );
  })();
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      {content}
    </Sheet>
  );
}

function PlannedAccountSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const plan = usePlan();
  const update = useUpdatePlan();
  const pa = plan?.plannedAccounts.find((a) => a.id === id);
  const issues = useIssues(PlannedAccount, pa);
  const inherit = useInherit(pa ? ACCOUNT_TYPE_INFO[pa.type].assetClass : "portfolio");
  const content =
    plan && pa ? (
      <SheetContent
        eyebrow="Planned account"
        title={pa.name}
        width={620}
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              className="text-negative"
              onClick={() => {
                onClose();
                update(
                  (p) => ({
                    ...p,
                    plannedAccounts: p.plannedAccounts.filter((x) => x.id !== pa.id),
                  }),
                  `Remove ${pa.name}`,
                );
              }}
            >
              <Trash2 /> Remove
            </Button>
            <SheetClose asChild>
              <Button variant="primary" className="ml-auto">
                Done
              </Button>
            </SheetClose>
          </>
        }
      >
        <FormSection title="Details">
          <FieldGrid>
            <FormField label="Name" error={issues.get("name")}>
              {(fid) => (
                <Input
                  id={fid}
                  value={pa.name}
                  onChange={(e) =>
                    update(
                      (p) => ({
                        ...p,
                        plannedAccounts: p.plannedAccounts.map((x) =>
                          x.id === pa.id ? { ...x, name: e.target.value } : x,
                        ),
                      }),
                      "Rename planned account",
                      `${pa.id}:name`,
                    )
                  }
                />
              )}
            </FormField>
            <FormField label="Owner">
              {(fid) => (
                <OwnerSelect
                  id={fid}
                  value={pa.owner}
                  onChange={(owner) =>
                    update(
                      (p) => ({
                        ...p,
                        plannedAccounts: p.plannedAccounts.map((x) =>
                          x.id === pa.id ? { ...x, owner } : x,
                        ),
                      }),
                      "Change owner",
                    )
                  }
                />
              )}
            </FormField>
            <EnumField
              label="Type"
              value={pa.type}
              onChange={(type) =>
                update(
                  (p) => ({
                    ...p,
                    plannedAccounts: p.plannedAccounts.map((x) =>
                      x.id === pa.id ? { ...x, type } : x,
                    ),
                  }),
                  "Change type",
                )
              }
              options={Object.entries(ACCOUNT_TYPE_INFO).map(([value, i]) => ({
                value: value as AccountType,
                label: i.label,
              }))}
            />
          </FieldGrid>
          <DateRefField
            label="Opens"
            value={pa.opensAt}
            allowNever={false}
            onChange={(opensAt) =>
              update(
                (p) => ({
                  ...p,
                  plannedAccounts: p.plannedAccounts.map((x) =>
                    x.id === pa.id ? { ...x, opensAt } : x,
                  ),
                }),
                "Edit opening date",
              )
            }
          />
        </FormSection>
        <AccountBehaviourEditor
          type={pa.type}
          value={pa.behaviour}
          inheritGrowth={inherit.growth}
          inheritDividend={inherit.dividend}
          onChange={(behaviour) =>
            update(
              (p) => ({
                ...p,
                plannedAccounts: p.plannedAccounts.map((x) =>
                  x.id === pa.id ? { ...x, behaviour } : x,
                ),
              }),
              "Edit planned account",
              `${pa.id}:beh`,
            )
          }
        />
      </SheetContent>
    ) : null;
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      {content}
    </Sheet>
  );
}
