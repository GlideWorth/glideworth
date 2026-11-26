import {
  ACCOUNT_TYPE_INFO,
  ACCOUNT_TYPES,
  Account,
  AccountBehaviour,
  type AccountType,
} from "@glideworth/core";
import { Link } from "@tanstack/react-router";
import { Archive, Copy, Plus, Trash2 } from "lucide-react";
import { AppearancePicker } from "../../components/ui/appearance-picker";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { Input } from "../../components/ui/input";
import { CurrencyInput } from "../../components/ui/number-input";
import { Select } from "../../components/ui/select";
import { FieldGrid, FormSection, Sheet, SheetClose, SheetContent } from "../../components/ui/sheet";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { formatMonth } from "../../lib/format";
import { fxRateToBase } from "../../lib/fx-math";
import { useFormat } from "../../lib/workspace";
import { CurrencyPrompt, ItemCountryField } from "../crossborder/fields";
import { CurrencySelect } from "../currency/fx";
import { FormField, OwnerSelect } from "../plan-editor/components/form";
import { newAccount, newFlow, newId } from "../plan-editor/state/defaults";
import { editPlan } from "../plan-editor/state/doc-store";
import { setIntent } from "../plan-editor/state/intent";
import { ACCOUNT_TYPE_HINT, accountTypeGroups, HELP } from "../plan-editor/state/labels";
import { useIssues } from "../plan-editor/state/validation";
import { AccountBehaviourEditor } from "./account-behaviour";
import {
  updateFinances,
  useDraftDoc,
  useInheritLabels,
  useNowFxRates,
  useReferencePlan,
} from "./use-finances";

export function AccountSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      {id ? <AccountSheetBody id={id} onClose={onClose} /> : null}
    </Sheet>
  );
}

function AccountSheetBody({ id, onClose }: { id: string; onClose: () => void }) {
  const doc = useDraftDoc();
  const rates = useNowFxRates();
  const f = useFormat();
  const plan = useReferencePlan();
  const account = doc?.finances.accounts.find((a) => a.id === id);
  const issues = useIssues(Account, account);
  const inherit = useInheritLabels(
    account ? ACCOUNT_TYPE_INFO[account.type].assetClass : "portfolio",
  );
  if (!doc || !account) return null;
  const info = ACCOUNT_TYPE_INFO[account.type];
  const update = (fn: (a: Account) => Account, label: string, coalesce?: string) =>
    updateFinances(
      (fin) => ({ ...fin, accounts: fin.accounts.map((a) => (a.id === id ? fn(a) : a)) }),
      label,
      coalesce ? `${id}:${coalesce}` : undefined,
    );
  const country = doc.household.location.country;
  const typeOptions = accountTypeGroups(country).flatMap((g) =>
    g.types.map((t) => ({ value: t, label: ACCOUNT_TYPE_INFO[t].label, group: g.label })),
  );

  const changeType = (type: AccountType) => {
    const fresh = newAccount(type, { household: doc.household, finances: doc.finances });
    const oldDefaults = newAccount(account.type, {
      household: doc.household,
      finances: doc.finances,
    }).behaviour;
    const untouched = JSON.stringify(oldDefaults) === JSON.stringify(account.behaviour);
    const ti = ACCOUNT_TYPE_INFO[type];
    update(
      (a) => ({
        ...a,
        type,
        behaviour: untouched ? fresh.behaviour : a.behaviour,
        costBasis: ti.tracksCostBasis ? (a.costBasis ?? a.balance) : undefined,
        contributionBasis: ti.tracksContributionBasis ? (a.contributionBasis ?? 0) : undefined,
      }),
      "Change account type",
    );
    if (!untouched)
      toast({
        title: `Now a ${ti.label}`,
        description:
          "Your custom behaviour settings were kept. Review access and distributions below.",
      });
  };

  const flows = plan?.flows.filter(
    (fl) =>
      (fl.kind === "contribution" && fl.accountId === id) ||
      (fl.kind === "transfer" &&
        (fl.fromAccountId === id || (fl.to.kind === "account" && fl.to.accountId === id))),
  );

  const remove = async () => {
    const ok = await confirmAction({
      title: `Delete ${account.name}?`,
      description:
        "Plans that contribute to or draw from it will show a missing-account warning. You can undo this.",
      confirmLabel: "Delete account",
    });
    if (!ok) return;
    onClose();
    updateFinances(
      (fin) => ({ ...fin, accounts: fin.accounts.filter((a) => a.id !== id) }),
      `Delete ${account.name}`,
    );
  };

  return (
    <SheetContent
      eyebrow="Account"
      title={account.name || "Untitled account"}
      description={
        ACCOUNT_TYPE_HINT[account.type] ?? `${info.label} · ${info.taxTreatment.replace("-", " ")}`
      }
      width={620}
      footer={
        <>
          <Button variant="ghost" size="sm" className="text-negative" onClick={remove}>
            <Trash2 /> Delete
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const copy = {
                ...structuredClone(account),
                id: newId("acc"),
                name: `${account.name} (copy)`,
              };
              updateFinances(
                (fin) => ({ ...fin, accounts: [...fin.accounts, copy] }),
                `Duplicate ${account.name}`,
              );
              toast({ title: "Account duplicated" });
            }}
          >
            <Copy /> Duplicate
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              update(
                (a) => ({ ...a, archived: !a.archived }),
                account.archived ? "Restore account" : "Archive account",
              )
            }
          >
            <Archive /> {account.archived ? "Restore" : "Archive"}
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
                value={account.name}
                aria-invalid={!!issues.get("name")}
                onChange={(e) =>
                  update((a) => ({ ...a, name: e.target.value }), "Rename account", "name")
                }
              />
            )}
          </FormField>
          <FormField
            label="Type"
            help="Changing the type keeps balances; default rules for the new type apply unless you customised them."
          >
            {(fid) => (
              <Select<AccountType>
                id={fid}
                value={account.type}
                onValueChange={changeType}
                options={typeOptions.filter((o) =>
                  (ACCOUNT_TYPES as readonly string[]).includes(o.value),
                )}
              />
            )}
          </FormField>
          <FormField label="Owner" error={issues.get("owner")}>
            {(fid) => (
              <OwnerSelect
                id={fid}
                value={account.owner}
                onChange={(owner) => update((a) => ({ ...a, owner }), "Change owner")}
              />
            )}
          </FormField>
          <ItemCountryField
            value={account.jurisdiction}
            inherited={ACCOUNT_TYPE_INFO[account.type].country ?? doc.household.location.country}
            inheritedWhy={
              ACCOUNT_TYPE_INFO[account.type].country ? "the account type" : "household"
            }
            onChange={(jurisdiction) =>
              update((a) => ({ ...a, jurisdiction }), "Change account country")
            }
            help="The country whose rules the account follows (contribution limits, access ages, wrapper). It keeps that country when you move; the country you live in may not recognise a foreign tax-free wrapper."
          />
          <FormField
            label="Currency"
            hint={
              account.currency
                ? `Balances are in ${account.currency}; Glideworth converts them to ${doc.household.currency} with your exchange rates.`
                : undefined
            }
          >
            {(fid) => (
              <CurrencySelect
                id={fid}
                value={account.currency}
                base={doc.household.currency}
                onChange={(currency) =>
                  update((a) => ({ ...a, currency }), "Change account currency")
                }
              />
            )}
          </FormField>
          <div className="sm:col-span-2">
            <CurrencyPrompt
              what="This account"
              country={
                account.jurisdiction ??
                ACCOUNT_TYPE_INFO[account.type].country ??
                doc.household.location.country
              }
              currency={account.currency}
              onUseCurrency={(currency) =>
                update((a) => ({ ...a, currency }), "Change account currency")
              }
            />
          </div>
          {account.type === "uk-isa" ? (
            <FormField
              label="ISA type"
              hint="Cash ISAs count toward the £20,000 allowance, and toward a cash ISA limit if your plan sets one."
            >
              {(fid) => (
                <Select<"stocks-and-shares" | "cash" | "innovative-finance">
                  id={fid}
                  value={account.ukIsaType ?? "stocks-and-shares"}
                  onValueChange={(t) =>
                    update(
                      (a) => ({ ...a, ukIsaType: t === "stocks-and-shares" ? undefined : t }),
                      "Change ISA type",
                    )
                  }
                  options={[
                    { value: "stocks-and-shares", label: "Stocks & shares ISA" },
                    { value: "cash", label: "Cash ISA" },
                    { value: "innovative-finance", label: "Innovative Finance ISA" },
                  ]}
                />
              )}
            </FormField>
          ) : null}
          <FormField label="Provider" hint="Optional, e.g. the platform or bank.">
            {(fid) => (
              <Input
                id={fid}
                value={account.institution ?? ""}
                onChange={(e) =>
                  update(
                    (a) => ({ ...a, institution: e.target.value || undefined }),
                    "Edit provider",
                    "inst",
                  )
                }
              />
            )}
          </FormField>
        </FieldGrid>
      </FormSection>

      <FormSection
        title="Balance"
        description={`As of ${formatMonth(doc.finances.asOf, f.locale)}${
          account.currency
            ? (() => {
                const r = fxRateToBase(account.currency, doc.household.currency, rates);
                return r === null
                  ? ` · no exchange rate to ${doc.household.currency} yet: add one under Exchange rates`
                  : ` · ${f.money(account.balance * r)} in ${doc.household.currency}`;
              })()
            : ""
        }`}
      >
        <FieldGrid>
          <FormField label="Balance" error={issues.get("balance")}>
            {(fid) => (
              <CurrencyInput
                id={fid}
                currency={account.currency}
                value={account.balance}
                onValueChange={(v) =>
                  update((a) => ({ ...a, balance: v ?? 0 }), "Update balance", "balance")
                }
              />
            )}
          </FormField>
          {info.tracksCostBasis ? (
            <FormField
              label="Cost basis"
              help={HELP.costBasis}
              error={issues.get("costBasis")}
              hint={
                account.balance > 0 && account.costBasis !== undefined
                  ? `${f.percent(account.costBasis / account.balance, 0)} of balance · gain ${f.moneyIn(account.balance - account.costBasis, account.currency ?? f.currency)}`
                  : undefined
              }
            >
              {(fid) => (
                <CurrencyInput
                  id={fid}
                  currency={account.currency}
                  value={account.costBasis ?? null}
                  onValueChange={(v) =>
                    update(
                      (a) => ({ ...a, costBasis: v ?? undefined }),
                      "Update cost basis",
                      "cost",
                    )
                  }
                />
              )}
            </FormField>
          ) : null}
          {info.tracksContributionBasis ? (
            <FormField
              label="Contributions to date"
              help={HELP.contributionBasis}
              error={issues.get("contributionBasis")}
            >
              {(fid) => (
                <CurrencyInput
                  id={fid}
                  currency={account.currency}
                  value={account.contributionBasis ?? null}
                  onValueChange={(v) =>
                    update(
                      (a) => ({ ...a, contributionBasis: v ?? undefined }),
                      "Update contributions",
                      "contrib",
                    )
                  }
                />
              )}
            </FormField>
          ) : null}
        </FieldGrid>
      </FormSection>

      <FormSection
        title="Contributions"
        description={
          plan
            ? `Saving into this account is planned per plan, as Flows. Showing “${plan.name}”.`
            : "Create a plan to add contributions."
        }
      >
        {flows?.length ? (
          <ul className="flex flex-col gap-1">
            {flows.map((fl) => (
              <li
                key={fl.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-[12.5px]"
              >
                <span className="truncate">{fl.name}</span>
                <Badge tone={fl.kind === "contribution" ? "accent" : "neutral"}>
                  {fl.kind === "contribution" ? "Contribution" : "Transfer"}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        {plan ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                const fl = newFlow(
                  "contribution",
                  { household: doc.household, finances: doc.finances },
                  plan,
                );
                const flow =
                  fl.kind === "contribution"
                    ? {
                        ...fl,
                        accountId: id,
                        owner: account.owner,
                        name: `Save into ${account.name}`,
                        limit: info.hasContributionLimit
                          ? ({ kind: "jurisdiction" } as const)
                          : ({ kind: "none" } as const),
                      }
                    : fl;
                editPlan(
                  plan.id,
                  (p) => ({ ...p, flows: [...p.flows, flow] }),
                  `Add contribution to ${account.name}`,
                );
                toast({
                  title: `Contribution added to “${plan.name}”`,
                  description: "Fine-tune the amount in the plan’s Flows.",
                });
              }}
            >
              <Plus /> Add a contribution
            </Button>
            <Button size="sm" variant="ghost" asChild>
              <Link
                to="/plans/$planId"
                params={{ planId: plan.id }}
                onClick={() => setIntent({ kind: "section", section: "flows" })}
              >
                Open Flows
              </Link>
            </Button>
          </div>
        ) : null}
      </FormSection>

      <AccountBehaviourEditor
        type={account.type}
        value={account.behaviour}
        issues={issues}
        inheritGrowth={inherit.growth}
        inheritDividend={inherit.dividend}
        loans={[
          ...doc.finances.realAssets
            .filter((r) => r.loan)
            .map((r) => ({ id: r.loan!.id, name: `${r.name} loan` })),
          ...doc.finances.debts.map((d) => ({ id: d.id, name: d.name })),
        ]}
        onChange={(behaviour) =>
          update(
            (a) => ({ ...a, behaviour: AccountBehaviour.parse(behaviour) }),
            "Edit account behaviour",
            "behaviour",
          )
        }
      />

      <FormSection title="Notes & appearance">
        <Textarea
          aria-label="Notes"
          placeholder="Anything worth remembering: fund choices, login hints (no passwords), transfer plans…"
          value={account.notes ?? ""}
          onChange={(e) =>
            update((a) => ({ ...a, notes: e.target.value || undefined }), "Edit notes", "notes")
          }
        />
        <AppearancePicker
          value={account.appearance}
          onChange={(appearance) => update((a) => ({ ...a, appearance }), "Change appearance")}
        />
      </FormSection>
    </SheetContent>
  );
}
