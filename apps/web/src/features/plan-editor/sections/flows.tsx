/**
 * Flows: the savings waterfall. Each year's surplus runs top to bottom through this list; drag to
 * change priority. Contributions (with limits and employer match), debt overpayments and
 * transfers, plus what happens to anything left over.
 */
import { ACCOUNT_TYPE_INFO, type Flow, Flow as FlowSchema } from "@glideworth/core";
import {
  ArrowDownToLine,
  ArrowRightLeft,
  Copy,
  Lock,
  MoreHorizontal,
  PiggyBank,
  Plus,
  Target,
  Trash2,
  Waves,
} from "lucide-react";
import {
  ActionMenu,
  ActionMenuContent,
  ActionMenuItem,
  ActionMenuSeparator,
  ActionMenuTrigger,
} from "../../../components/ui/action-menu";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardHeader } from "../../../components/ui/card";
import { EmptyState } from "../../../components/ui/empty-state";
import { HelpTip } from "../../../components/ui/help-tip";
import { Input } from "../../../components/ui/input";
import { AmountInput, PercentInput } from "../../../components/ui/number-input";
import { Segmented } from "../../../components/ui/segmented";
import { Select } from "../../../components/ui/select";
import {
  FieldGrid,
  FormSection,
  Sheet,
  SheetClose,
  SheetContent,
} from "../../../components/ui/sheet";
import { moveItem, SortableList } from "../../../components/ui/sortable-list";
import { Switch, SwitchField } from "../../../components/ui/switch";
import { Textarea } from "../../../components/ui/textarea";
import { cn } from "../../../lib/cn";
import { useFormat } from "../../../lib/workspace";
import {
  AccountListEditor,
  DateRefField,
  EnumField,
  FormField,
  FrequencySelect,
  OwnerSelect,
  useScope,
} from "../components/form";
import { replaceById, usePlan, useUpdatePlan } from "../components/plan-context";
import { newFlow, newId } from "../state/defaults";
import { useEditorStore } from "../state/doc-store";
import { FREQUENCY_SHORT, HELP } from "../state/labels";
import { useIssues } from "../state/validation";

export function useAddFlow() {
  const update = useUpdatePlan();
  const plan = usePlan();
  const household = useEditorStore((s) => s.draft?.household);
  const finances = useEditorStore((s) => s.draft?.finances);
  return (kind: Flow["kind"]) => {
    if (!household || !finances || !plan) return null;
    const f = newFlow(kind, { household, finances }, plan);
    update((p) => ({ ...p, flows: [...p.flows, f] }), `Add ${f.name}`);
    return f.id;
  };
}

export function AddFlowMenu({
  onAdded,
  primary = false,
}: {
  onAdded: (id: string) => void;
  primary?: boolean;
}) {
  const add = useAddFlow();
  return (
    <ActionMenu>
      <ActionMenuTrigger asChild>
        <Button size="sm" variant={primary ? "primary" : "secondary"}>
          <Plus /> Add flow
        </Button>
      </ActionMenuTrigger>
      <ActionMenuContent>
        <ActionMenuItem
          hint="ISA, pension, savings, emergency fund"
          onSelect={() => {
            const id = add("contribution");
            if (id) onAdded(id);
          }}
        >
          <PiggyBank /> Save into an account
        </ActionMenuItem>
        <ActionMenuItem
          hint="Mortgage or loan overpayments"
          onSelect={() => {
            const id = add("debtPaydown");
            if (id) onAdded(id);
          }}
        >
          <ArrowDownToLine /> Overpay a debt
        </ActionMenuItem>
        <ActionMenuItem
          hint="Move money between accounts, or out (gifts)"
          onSelect={() => {
            const id = add("transfer");
            if (id) onAdded(id);
          }}
        >
          <ArrowRightLeft /> Transfer
        </ActionMenuItem>
      </ActionMenuContent>
    </ActionMenu>
  );
}

function useNames() {
  const finances = useEditorStore((s) => s.draft?.finances);
  const plan = usePlan();
  const account = (id: string) =>
    finances?.accounts.find((a) => a.id === id)?.name ??
    plan?.plannedAccounts.find((a) => a.id === id)?.name;
  const target = (id: string) =>
    finances?.debts.find((d) => d.id === id)?.name ??
    (finances?.realAssets.find((r) => r.id === id)
      ? `${finances.realAssets.find((r) => r.id === id)!.name} loan`
      : undefined);
  return { account, target };
}

export function FlowsSection({ onOpen }: { onOpen: (id: string) => void }) {
  const plan = usePlan();
  const update = useUpdatePlan();
  const f = useFormat();
  const names = useNames();
  const finances = useEditorStore((s) => s.draft?.finances);
  if (!plan) return null;
  const method = (fl: Flow): string => {
    if (fl.kind === "transfer")
      return fl.amount.kind === "amount"
        ? `${f.money(fl.amount.amount.value)} ${FREQUENCY_SHORT[fl.amount.frequency]}`
        : fl.amount.kind === "all"
          ? "Everything"
          : `${f.percent(fl.amount.share, 0)} of balance`;
    const m = fl.method;
    if (m.kind === "max")
      return fl.kind === "contribution" && fl.limit.kind === "none"
        ? "All remaining"
        : "Up to the limit";
    if (m.kind === "percentOfRemaining") return `${f.percent(m.share, 0)} of what’s left`;
    if (m.kind === "amount") return `${f.money(m.amount.value)} ${FREQUENCY_SHORT[m.frequency]}`;
    if (m.kind === "percentOfIncome")
      return `${f.percent(m.share, 1)} of ${plan.income.find((i) => i.id === m.incomeId)?.name ?? "income"}`;
    return `${f.percent(m.share, 0)} of balance`;
  };
  const dest = (fl: Flow) =>
    fl.kind === "contribution"
      ? (names.account(fl.accountId) ?? "Missing account")
      : fl.kind === "debtPaydown"
        ? (names.target(fl.targetId) ?? "Missing debt")
        : `${names.account(fl.fromAccountId) ?? "?"} → ${fl.to.kind === "account" ? (names.account(fl.to.accountId) ?? "?") : fl.to.label || "outside"}`;
  const icon = (fl: Flow) =>
    fl.kind === "contribution"
      ? PiggyBank
      : fl.kind === "debtPaydown"
        ? ArrowDownToLine
        : ArrowRightLeft;
  const cash =
    finances?.accounts.filter((a) => ACCOUNT_TYPE_INFO[a.type].category === "cash") ?? [];
  const leftover = plan.leftover;
  return (
    <Card>
      <CardHeader
        eyebrow="Where surplus goes, in order"
        title={
          <span className="flex items-center gap-1">
            Flows{" "}
            <HelpTip>
              Each year, income minus spending, debt payments and tax is the surplus. It fills these
              from the top. Drag to change priority.
            </HelpTip>
          </span>
        }
        actions={<AddFlowMenu onAdded={onOpen} />}
      />
      <div className="p-3 sm:p-4">
        <div className="mb-2 flex items-center gap-2 pl-1 text-[12px] text-ink-3">
          <Waves className="size-3.5" /> Surplus each year
        </div>
        {plan.flows.length === 0 ? (
          <EmptyState
            compact
            icon={PiggyBank}
            title="Decide where your savings go"
            action={<AddFlowMenu onAdded={onOpen} primary />}
          >
            A typical UK order: pension contributions (often matched), an emergency fund to a
            target, your ISA allowance, then a general account for the rest.
          </EmptyState>
        ) : (
          <div className="relative">
            <div aria-hidden className="absolute top-2 bottom-2 left-[19px] w-px bg-border" />
            <SortableList
              aria-label="Flow priority"
              items={plan.flows}
              getId={(x) => x.id}
              getLabel={(x) => x.name}
              onReorder={(from, to) =>
                update((p) => ({ ...p, flows: moveItem(p.flows, from, to) }), "Reorder flows")
              }
              renderItem={(fl, { handle, index, dragging }) => {
                const Icon = icon(fl);
                return (
                  <div
                    className={cn(
                      "relative flex items-center gap-2 rounded-lg border bg-surface py-1.5 pr-1.5 pl-1 transition-colors",
                      dragging ? "border-accent" : "border-border hover:border-border-strong",
                      !fl.enabled && "opacity-55",
                    )}
                  >
                    {handle}
                    <span className="num flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
                      {index + 1}
                    </span>
                    <button
                      type="button"
                      className="group min-w-0 flex-1 text-left"
                      onClick={() => onOpen(fl.id)}
                    >
                      <div className="flex items-center gap-1.5">
                        <Icon className="size-3.5 shrink-0 text-ink-3" />
                        <span className="truncate text-[13px] font-medium group-hover:text-accent">
                          {fl.name}
                        </span>
                        {fl.mandatory ? (
                          <Badge tone="accent">
                            <Lock className="size-3" /> Always
                          </Badge>
                        ) : null}
                        {fl.kind === "contribution" && fl.strategy.kind === "target" ? (
                          <Badge>
                            <Target className="size-3" /> to{" "}
                            {f.money(fl.strategy.target.value, true)}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="truncate text-[11.5px] text-ink-3">
                        {dest(fl)} · {method(fl)}
                      </div>
                    </button>
                    <Switch
                      size="sm"
                      aria-label={`${fl.name} enabled`}
                      checked={fl.enabled}
                      onCheckedChange={(enabled) =>
                        update(
                          (p) => ({
                            ...p,
                            flows: replaceById(p.flows, fl.id, (x) => ({ ...x, enabled })),
                          }),
                          "Toggle flow",
                        )
                      }
                    />
                    <ActionMenu>
                      <ActionMenuTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          aria-label={`Actions for ${fl.name}`}
                        >
                          <MoreHorizontal />
                        </Button>
                      </ActionMenuTrigger>
                      <ActionMenuContent>
                        <ActionMenuItem onSelect={() => onOpen(fl.id)}>Edit</ActionMenuItem>
                        <ActionMenuItem
                          onSelect={() =>
                            update(
                              (p) => ({ ...p, flows: moveItem(p.flows, index, 0) }),
                              "Move flow to top",
                            )
                          }
                          disabled={index === 0}
                        >
                          Move to top
                        </ActionMenuItem>
                        <ActionMenuItem
                          onSelect={() =>
                            update(
                              (p) => ({
                                ...p,
                                flows: [
                                  ...p.flows.slice(0, index + 1),
                                  {
                                    ...structuredClone(fl),
                                    id: newId("fl"),
                                    name: `${fl.name} (copy)`,
                                  },
                                  ...p.flows.slice(index + 1),
                                ],
                              }),
                              "Duplicate flow",
                            )
                          }
                        >
                          <Copy /> Duplicate
                        </ActionMenuItem>
                        <ActionMenuSeparator />
                        <ActionMenuItem
                          tone="negative"
                          onSelect={() =>
                            update(
                              (p) => ({ ...p, flows: p.flows.filter((x) => x.id !== fl.id) }),
                              `Delete ${fl.name}`,
                            )
                          }
                        >
                          <Trash2 /> Delete
                        </ActionMenuItem>
                      </ActionMenuContent>
                    </ActionMenu>
                  </div>
                );
              }}
            />
          </div>
        )}
        <div className="mt-3 flex flex-col gap-2 rounded-lg border border-dashed border-border-strong p-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-1 text-[12.5px] font-medium">
            Anything left over <HelpTip>{HELP.leftover}</HelpTip>
          </div>
          <div className="flex flex-1 flex-wrap items-center gap-2 sm:justify-end">
            <Segmented<"save" | "spend">
              aria-label="Leftover"
              size="sm"
              value={leftover.kind}
              onChange={(k) =>
                update(
                  (p) => ({
                    ...p,
                    leftover:
                      k === "save" ? { kind: "save", accountId: cash[0]?.id } : { kind: "spend" },
                  }),
                  "Change leftover",
                )
              }
              options={[
                { value: "save", label: "Save it" },
                { value: "spend", label: "Spend it" },
              ]}
            />
            {leftover.kind === "save" ? (
              <Select
                aria-label="Save leftover into"
                value={leftover.accountId ?? "auto"}
                onValueChange={(v) =>
                  update(
                    (p) => ({
                      ...p,
                      leftover: { kind: "save", accountId: v === "auto" ? undefined : v },
                    }),
                    "Change leftover account",
                  )
                }
                options={[
                  { value: "auto", label: "First cash account" },
                  ...(finances?.accounts ?? []).map((a) => ({ value: a.id, label: a.name })),
                ]}
                className="w-[200px]"
              />
            ) : (
              <span className="text-[12px] text-ink-3">
                Becomes discretionary spending that year.
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function FlowSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      {id ? <FlowSheetBody id={id} onClose={onClose} /> : null}
    </Sheet>
  );
}

function FlowSheetBody({ id, onClose }: { id: string; onClose: () => void }) {
  const plan = usePlan();
  const update = useUpdatePlan();
  const finances = useEditorStore((s) => s.draft?.finances);
  const country = useEditorStore((s) => s.draft?.household.location.country);
  const { accounts } = useScope();
  const fl = plan?.flows.find((x) => x.id === id);
  const issues = useIssues(FlowSchema, fl);
  if (!plan || !fl || !finances) return null;
  const set = (fn: (x: Flow) => Flow, label: string, key?: string) =>
    update(
      (p) => ({ ...p, flows: replaceById(p.flows, id, fn) }),
      label,
      key ? `${id}:${key}` : undefined,
    );
  const patch = (v: Partial<Flow>, label: string, key?: string) =>
    set((x) => ({ ...x, ...v }) as Flow, label, key);
  const index = plan.flows.indexOf(fl);
  const accountOpts = accounts.map((a) => ({ value: a.id, label: a.name }));
  const targets = [
    ...finances.debts.map((d) => ({ value: d.id, label: d.name })),
    ...finances.realAssets
      .filter((r) => r.loan)
      .map((r) => ({ value: r.id, label: `${r.name} (loan)` })),
  ];

  return (
    <SheetContent
      eyebrow={`Flow · priority ${index + 1} of ${plan.flows.length}`}
      title={fl.name || "Untitled flow"}
      description={
        fl.kind === "contribution"
          ? "Saving into an account"
          : fl.kind === "debtPaydown"
            ? "Paying down a debt faster"
            : "Moving money between accounts"
      }
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
                (p) => ({ ...p, flows: p.flows.filter((x) => x.id !== id) }),
                `Delete ${fl.name}`,
              );
            }}
          >
            <Trash2 /> Delete
          </Button>
          {issues.count ? (
            <span className="text-[12px] text-negative">{issues.count} to fix</span>
          ) : null}
          <SheetClose asChild>
            <Button variant="primary" className="ml-auto">
              Done
            </Button>
          </SheetClose>
        </>
      }
    >
      <FormSection title="Basics">
        <FieldGrid>
          <FormField label="Name" error={issues.get("name")}>
            {(fid) => (
              <Input
                id={fid}
                value={fl.name}
                onChange={(e) => patch({ name: e.target.value }, "Rename flow", "name")}
              />
            )}
          </FormField>
          <FormField label="Owner">
            {(fid) => (
              <OwnerSelect
                id={fid}
                value={fl.owner}
                onChange={(owner) => patch({ owner }, "Change owner")}
              />
            )}
          </FormField>
        </FieldGrid>
        <SwitchField
          label="Always fund"
          hint={HELP.mandatoryFlow}
          checked={fl.mandatory}
          onCheckedChange={(mandatory) => patch({ mandatory }, "Toggle always fund")}
        />
        <SwitchField
          label="Enabled"
          checked={fl.enabled}
          onCheckedChange={(enabled) => patch({ enabled }, "Toggle flow")}
        />
      </FormSection>

      {fl.kind === "contribution" ? (
        <>
          <FormSection title="Into">
            <EnumField
              label="Account"
              value={fl.accountId}
              error={issues.get("accountId")}
              onChange={(accountId) => patch({ accountId } as Partial<Flow>, "Change account")}
              options={accountOpts}
            />
            <FormField label="Goal">
              {() => (
                <Segmented<"indefinite" | "target">
                  aria-label="Goal"
                  size="sm"
                  value={fl.strategy.kind}
                  onChange={(k) =>
                    patch(
                      {
                        strategy:
                          k === "target"
                            ? { kind: "target", target: { value: 10_000, basis: "real" } }
                            : { kind: "indefinite" },
                      } as Partial<Flow>,
                      "Change goal",
                    )
                  }
                  options={[
                    { value: "indefinite", label: "Keep contributing" },
                    { value: "target", label: "Build up to a balance" },
                  ]}
                />
              )}
            </FormField>
            {fl.strategy.kind === "target" ? (
              <FormField
                label="Target balance"
                hint="Stops once reached; tops back up if it falls."
              >
                {(fid) => (
                  <AmountInput
                    id={fid}
                    value={
                      fl.strategy.kind === "target"
                        ? fl.strategy.target
                        : { value: 0, basis: "real" }
                    }
                    onChange={(target) =>
                      patch(
                        { strategy: { kind: "target", target } } as Partial<Flow>,
                        "Edit target",
                        "target",
                      )
                    }
                  />
                )}
              </FormField>
            ) : null}
          </FormSection>
          <FormSection title="How much">
            <ContributionMethodEditor
              flow={fl}
              patch={patch}
              incomes={plan.income.map((i) => ({ value: i.id, label: i.name }))}
            />
            <EnumField
              label="Limit"
              help="Jurisdiction limits come from the tax rules (ISA £20,000 allowance, pension annual allowance, IRS limits…)."
              value={fl.limit.kind}
              onChange={(k) =>
                patch(
                  {
                    limit:
                      k === "custom"
                        ? { kind: "custom", amount: { value: 20_000, basis: "real" } }
                        : { kind: k },
                  } as Partial<Flow>,
                  "Change limit",
                )
              }
              options={[
                { value: "jurisdiction", label: "Legal allowance for this account type" },
                { value: "custom", label: "My own limit" },
                { value: "none", label: "No limit" },
              ]}
            />
            {fl.limit.kind === "custom" ? (
              <FormField label="Limit per year">
                {(fid) => (
                  <AmountInput
                    id={fid}
                    value={
                      fl.limit.kind === "custom" ? fl.limit.amount : { value: 0, basis: "real" }
                    }
                    onChange={(amount) =>
                      patch(
                        { limit: { kind: "custom", amount } } as Partial<Flow>,
                        "Edit limit",
                        "limit",
                      )
                    }
                  />
                )}
              </FormField>
            ) : null}
          </FormSection>
          <FormSection
            title="Employer contribution"
            description="Workplace pensions and 401(k)s: your employer adds money on top."
          >
            <SwitchField
              label="Employer contributes"
              checked={!!fl.employer}
              onCheckedChange={(on) =>
                patch(
                  {
                    employer: on
                      ? {
                          incomeId: plan.income[0]?.id ?? "",
                          matchShare: 0.05,
                          upToShareOfPay: 1,
                          designation: "traditional",
                          reduceIfUnderfunded: false,
                        }
                      : undefined,
                  } as Partial<Flow>,
                  on ? "Add employer contribution" : "Remove employer contribution",
                )
              }
            />
            {fl.employer ? (
              <div className="grid gap-3 rounded-lg border border-border p-3">
                <FieldGrid>
                  <EnumField
                    label="Based on salary"
                    value={fl.employer.incomeId}
                    error={issues.get("employer.incomeId")}
                    onChange={(incomeId) =>
                      patch(
                        { employer: { ...fl.employer!, incomeId } } as Partial<Flow>,
                        "Edit employer",
                      )
                    }
                    options={plan.income.map((i) => ({ value: i.id, label: i.name }))}
                  />
                  <FormField
                    label="Employer adds"
                    hint="Share of pay (or of your contribution for a match)."
                  >
                    {(fid) => (
                      <PercentInput
                        id={fid}
                        value={fl.employer!.matchShare}
                        onValueChange={(v) =>
                          patch(
                            { employer: { ...fl.employer!, matchShare: v ?? 0 } } as Partial<Flow>,
                            "Edit employer",
                            "match",
                          )
                        }
                      />
                    )}
                  </FormField>
                  <FormField label="Up to share of pay">
                    {(fid) => (
                      <PercentInput
                        id={fid}
                        value={fl.employer!.upToShareOfPay}
                        onValueChange={(v) =>
                          patch(
                            {
                              employer: { ...fl.employer!, upToShareOfPay: v ?? 1 },
                            } as Partial<Flow>,
                            "Edit employer",
                            "upto",
                          )
                        }
                      />
                    )}
                  </FormField>
                  {country === "US" ? (
                    <EnumField<"traditional" | "roth">
                      label="Employer money goes in as"
                      value={fl.employer.designation}
                      onChange={(designation) =>
                        patch(
                          { employer: { ...fl.employer!, designation } } as Partial<Flow>,
                          "Edit employer",
                        )
                      }
                      options={[
                        { value: "traditional", label: "Traditional (pre-tax)" },
                        { value: "roth", label: "Roth" },
                      ]}
                    />
                  ) : null}
                </FieldGrid>
                <SwitchField
                  label="Reduce employer money if I can’t fund mine"
                  checked={fl.employer.reduceIfUnderfunded}
                  onCheckedChange={(reduceIfUnderfunded) =>
                    patch(
                      { employer: { ...fl.employer!, reduceIfUnderfunded } } as Partial<Flow>,
                      "Edit employer",
                    )
                  }
                />
              </div>
            ) : null}
          </FormSection>
          <FormSection title="Advanced">
            {country === "US" ? (
              <EnumField
                label="Route"
                value={fl.route}
                onChange={(route) => patch({ route } as Partial<Flow>, "Change route")}
                options={[
                  { value: "standard", label: "Standard" },
                  { value: "backdoor-roth", label: "Backdoor Roth IRA" },
                  { value: "mega-backdoor-roth", label: "Mega backdoor Roth" },
                ]}
              />
            ) : null}
            <EnumField<"default" | "yes" | "no">
              label="Tax relief on contributions"
              help="Default follows the account type (e.g. pension contributions get relief, ISA ones don’t)."
              value={fl.taxDeductible === undefined ? "default" : fl.taxDeductible ? "yes" : "no"}
              onChange={(v) =>
                patch(
                  { taxDeductible: v === "default" ? undefined : v === "yes" } as Partial<Flow>,
                  "Edit tax relief",
                )
              }
              options={[
                { value: "default", label: "Account default" },
                { value: "yes", label: "Deductible" },
                { value: "no", label: "Not deductible" },
              ]}
            />
            <FormField
              label="Fund from accounts"
              help="Draw from these accounts instead of this year’s surplus (e.g. Bed & ISA from a GIA)."
            >
              {() => (
                <AccountListEditor
                  ids={fl.fundFromAccountIds}
                  onChange={(fundFromAccountIds) =>
                    patch({ fundFromAccountIds } as Partial<Flow>, "Edit fund from")
                  }
                />
              )}
            </FormField>
          </FormSection>
        </>
      ) : fl.kind === "debtPaydown" ? (
        <FormSection title="Overpayment">
          <EnumField<"single" | "avalanche" | "snowball">
            label="Pay off"
            help="Avalanche pays the highest interest rate first (least interest overall); snowball pays the smallest balance first (quickest wins)."
            value={fl.allocation?.strategy ?? "single"}
            onChange={(k) =>
              patch(
                {
                  allocation:
                    k === "single"
                      ? undefined
                      : {
                          strategy: k,
                          rollover: fl.allocation?.rollover ?? true,
                          ...(fl.allocation?.targetIds
                            ? { targetIds: fl.allocation.targetIds }
                            : {}),
                        },
                } as Partial<Flow>,
                "Change payoff strategy",
              )
            }
            options={[
              { value: "single", label: "One debt" },
              { value: "avalanche", label: "Avalanche: highest rate first" },
              { value: "snowball", label: "Snowball: smallest balance first" },
            ]}
          />
          <EnumField
            label={fl.allocation ? "Include (always)" : "Debt"}
            value={fl.targetId}
            error={issues.get("targetId")}
            onChange={(targetId) => patch({ targetId } as Partial<Flow>, "Change debt")}
            options={targets}
          />
          {fl.allocation ? (
            <>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 text-[12px] font-medium text-ink-2">Debts in scope</legend>
                {targets.map((t) => {
                  const scope = fl.allocation!.targetIds;
                  const on = !scope || scope.includes(t.value) || t.value === fl.targetId;
                  return (
                    <label key={t.value} className="flex items-center gap-2 text-[12.5px]">
                      <input
                        type="checkbox"
                        className="accent-[var(--accent)]"
                        checked={on}
                        disabled={t.value === fl.targetId}
                        onChange={(e) => {
                          const all = targets.map((x) => x.value);
                          const cur = scope ?? all;
                          const next = e.target.checked
                            ? [...new Set([...cur, t.value])]
                            : cur.filter((x) => x !== t.value);
                          patch(
                            {
                              allocation: {
                                ...fl.allocation!,
                                targetIds: next.length === all.length ? undefined : next,
                              },
                            } as Partial<Flow>,
                            "Change debts in scope",
                          );
                        }}
                      />
                      {t.label}
                    </label>
                  );
                })}
              </fieldset>
              <SwitchField
                label="Roll paid-off payments into the next debt"
                hint="When a debt is cleared, its regular payment joins this budget."
                checked={fl.allocation.rollover}
                onCheckedChange={(rollover) =>
                  patch(
                    { allocation: { ...fl.allocation!, rollover } } as Partial<Flow>,
                    "Toggle rollover",
                  )
                }
              />
            </>
          ) : null}
          <FormField label="How much">
            {() => (
              <div className="flex flex-col gap-2">
                <Segmented<"amount" | "percentOfRemaining" | "percentOfBalance" | "max">
                  aria-label="How much"
                  size="sm"
                  value={fl.method.kind}
                  onChange={(k) =>
                    patch(
                      {
                        method:
                          k === "amount"
                            ? {
                                kind: "amount",
                                amount: { value: 200, basis: "real" },
                                frequency: "monthly",
                              }
                            : k === "max"
                              ? { kind: "max" }
                              : { kind: k, share: 0.5 },
                      } as Partial<Flow>,
                      "Change method",
                    )
                  }
                  options={[
                    { value: "amount", label: "Fixed" },
                    { value: "percentOfRemaining", label: "% of surplus" },
                    { value: "percentOfBalance", label: "% of balance" },
                    { value: "max", label: "Everything" },
                  ]}
                />
                {fl.method.kind === "amount" ? (
                  <div className="flex flex-wrap gap-2">
                    <div className="min-w-[220px] flex-1">
                      <AmountInput
                        value={fl.method.amount}
                        onChange={(amount) =>
                          patch(
                            {
                              method: {
                                ...(fl.method as { kind: "amount"; frequency: "monthly" }),
                                amount,
                              },
                            } as Partial<Flow>,
                            "Edit amount",
                            "amt",
                          )
                        }
                      />
                    </div>
                    <div className="w-[150px]">
                      <FrequencySelect
                        allowOnce={false}
                        value={fl.method.frequency}
                        onChange={(frequency) =>
                          patch(
                            {
                              method: {
                                ...(fl.method as {
                                  kind: "amount";
                                  amount: { value: number; basis: "real" };
                                }),
                                frequency,
                              },
                            } as Partial<Flow>,
                            "Edit frequency",
                          )
                        }
                      />
                    </div>
                  </div>
                ) : fl.method.kind === "percentOfRemaining" ||
                  fl.method.kind === "percentOfBalance" ? (
                  <PercentInput
                    aria-label="Share"
                    className="w-[120px]"
                    value={fl.method.share}
                    onValueChange={(v) =>
                      patch(
                        {
                          method: {
                            kind: (fl.method as { kind: "percentOfBalance" }).kind,
                            share: v ?? 0,
                          },
                        } as Partial<Flow>,
                        "Edit share",
                        "share",
                      )
                    }
                  />
                ) : null}
              </div>
            )}
          </FormField>
        </FormSection>
      ) : (
        <FormSection title="Transfer">
          <FieldGrid>
            <EnumField
              label="From"
              value={fl.fromAccountId}
              error={issues.get("fromAccountId")}
              onChange={(fromAccountId) => patch({ fromAccountId } as Partial<Flow>, "Change from")}
              options={accountOpts}
            />
            <EnumField<"account" | "external">
              label="To"
              value={fl.to.kind}
              onChange={(k) =>
                patch(
                  {
                    to:
                      k === "account"
                        ? { kind: "account", accountId: accounts[0]?.id ?? "" }
                        : { kind: "external", label: "Gift" },
                  } as Partial<Flow>,
                  "Change destination",
                )
              }
              options={[
                { value: "account", label: "Another account" },
                { value: "external", label: "Outside the household" },
              ]}
            />
          </FieldGrid>
          {fl.to.kind === "account" ? (
            <EnumField
              label="Destination account"
              value={fl.to.accountId}
              error={issues.get("to.accountId")}
              onChange={(accountId) =>
                patch({ to: { kind: "account", accountId } } as Partial<Flow>, "Change destination")
              }
              options={accountOpts}
            />
          ) : (
            <FormField label="Description">
              {(fid) => (
                <Input
                  id={fid}
                  value={fl.to.kind === "external" ? fl.to.label : ""}
                  onChange={(e) =>
                    patch(
                      { to: { kind: "external", label: e.target.value } } as Partial<Flow>,
                      "Edit destination",
                      "ext",
                    )
                  }
                />
              )}
            </FormField>
          )}
          <FormField label="Amount">
            {() => (
              <div className="flex flex-col gap-2">
                <Segmented<"amount" | "percentOfBalance" | "all">
                  aria-label="Amount"
                  size="sm"
                  value={fl.amount.kind}
                  onChange={(k) =>
                    patch(
                      {
                        amount:
                          k === "amount"
                            ? {
                                kind: "amount",
                                amount: { value: 1000, basis: "real" },
                                frequency: "yearly",
                              }
                            : k === "all"
                              ? { kind: "all" }
                              : { kind: "percentOfBalance", share: 0.1 },
                      } as Partial<Flow>,
                      "Change amount",
                    )
                  }
                  options={[
                    { value: "amount", label: "Fixed" },
                    { value: "percentOfBalance", label: "% of balance" },
                    { value: "all", label: "Everything" },
                  ]}
                />
                {fl.amount.kind === "amount" ? (
                  <div className="flex flex-wrap gap-2">
                    <div className="min-w-[220px] flex-1">
                      <AmountInput
                        value={fl.amount.amount}
                        onChange={(amount) =>
                          patch(
                            {
                              amount: {
                                ...(fl.amount as { kind: "amount"; frequency: "yearly" }),
                                amount,
                              },
                            } as Partial<Flow>,
                            "Edit amount",
                            "amt",
                          )
                        }
                      />
                    </div>
                    <div className="w-[150px]">
                      <FrequencySelect
                        value={fl.amount.frequency}
                        onChange={(frequency) =>
                          patch(
                            {
                              amount: {
                                ...(fl.amount as {
                                  kind: "amount";
                                  amount: { value: number; basis: "real" };
                                }),
                                frequency,
                              },
                            } as Partial<Flow>,
                            "Edit frequency",
                          )
                        }
                      />
                    </div>
                  </div>
                ) : fl.amount.kind === "percentOfBalance" ? (
                  <PercentInput
                    aria-label="Share of balance"
                    className="w-[120px]"
                    value={fl.amount.share}
                    onValueChange={(v) =>
                      patch(
                        { amount: { kind: "percentOfBalance", share: v ?? 0 } } as Partial<Flow>,
                        "Edit share",
                        "share",
                      )
                    }
                  />
                ) : null}
              </div>
            )}
          </FormField>
          <EnumField
            label="Tax"
            help="Auto detects pension-to-ISA style moves and Roth conversions."
            value={fl.taxHandling}
            onChange={(taxHandling) => patch({ taxHandling } as Partial<Flow>, "Edit tax handling")}
            options={[
              { value: "auto", label: "Auto" },
              { value: "taxable", label: "Taxable" },
              { value: "tax-exempt", label: "Tax-exempt" },
            ]}
          />
        </FormSection>
      )}

      <FormSection title="When">
        <DateRefField
          label="Starts"
          value={fl.range.start}
          allowNever={false}
          onChange={(start) => patch({ range: { ...fl.range, start } }, "Edit start")}
        />
        <DateRefField
          label="Ends"
          value={fl.range.end}
          onChange={(end) => patch({ range: { ...fl.range, end } }, "Edit end")}
        />
      </FormSection>

      <FormSection title="Notes">
        <Textarea
          aria-label="Notes"
          value={fl.notes ?? ""}
          onChange={(e) => patch({ notes: e.target.value || undefined }, "Edit notes", "notes")}
        />
      </FormSection>
    </SheetContent>
  );
}

function ContributionMethodEditor({
  flow,
  patch,
  incomes,
}: {
  flow: Extract<Flow, { kind: "contribution" }>;
  patch: (v: Partial<Flow>, l: string, k?: string) => void;
  incomes: { value: string; label: string }[];
}) {
  const m = flow.method;
  return (
    <div className="flex flex-col gap-2">
      <Segmented<typeof m.kind>
        aria-label="Contribution method"
        size="sm"
        value={m.kind}
        onChange={(k) =>
          patch(
            {
              method:
                k === "amount"
                  ? { kind: "amount", amount: { value: 400, basis: "real" }, frequency: "monthly" }
                  : k === "max"
                    ? { kind: "max" }
                    : k === "percentOfIncome"
                      ? { kind: "percentOfIncome", incomeId: incomes[0]?.value ?? "", share: 0.05 }
                      : { kind: "percentOfRemaining", share: 1 },
            } as Partial<Flow>,
            "Change method",
          )
        }
        options={[
          { value: "amount", label: "Fixed amount" },
          { value: "percentOfIncome", label: "% of salary" },
          { value: "percentOfRemaining", label: "% of surplus" },
          { value: "max", label: "Max out" },
        ]}
      />
      {m.kind === "amount" ? (
        <div className="flex flex-wrap gap-2">
          <div className="min-w-[220px] flex-1">
            <AmountInput
              value={m.amount}
              onChange={(amount) =>
                patch({ method: { ...m, amount } } as Partial<Flow>, "Edit contribution", "amt")
              }
            />
          </div>
          <div className="w-[150px]">
            <FrequencySelect
              allowOnce={false}
              value={m.frequency}
              onChange={(frequency) =>
                patch({ method: { ...m, frequency } } as Partial<Flow>, "Edit frequency")
              }
            />
          </div>
        </div>
      ) : m.kind === "percentOfIncome" ? (
        <div className="flex flex-wrap items-center gap-2">
          <PercentInput
            aria-label="Share of salary"
            className="w-[110px]"
            value={m.share}
            onValueChange={(v) =>
              patch(
                { method: { ...m, share: v ?? 0 } } as Partial<Flow>,
                "Edit contribution",
                "share",
              )
            }
          />
          <span className="text-[12.5px] text-ink-3">of</span>
          <Select
            aria-label="Salary"
            value={m.incomeId || undefined}
            placeholder="Choose income"
            onValueChange={(incomeId) =>
              patch({ method: { ...m, incomeId } } as Partial<Flow>, "Edit contribution")
            }
            options={incomes}
            className="w-[200px]"
          />
        </div>
      ) : m.kind === "percentOfRemaining" ? (
        <PercentInput
          aria-label="Share of what's left"
          className="w-[120px]"
          value={m.share}
          onValueChange={(v) =>
            patch(
              { method: { ...m, share: v ?? 0 } } as Partial<Flow>,
              "Edit contribution",
              "share",
            )
          }
        />
      ) : (
        <p className="text-[12px] text-ink-3">
          Fills up to the limit below each year (or takes everything left if there’s no limit).
        </p>
      )}
    </div>
  );
}
