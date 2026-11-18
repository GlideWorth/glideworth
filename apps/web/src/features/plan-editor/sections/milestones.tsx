/**
 * Milestones: the stones on the trail. A list showing when each resolves in the live projection,
 * and a sheet with an AND/OR criteria builder (ages, dates, other milestones, metric thresholds)
 * and effects (filing status, relocation, withholding, death of a household member).
 */
import {
  type Comparator,
  MILESTONE_KINDS,
  type Milestone,
  type MilestoneCriterion,
  type MilestoneEffect,
  type MilestoneMetric,
  Milestone as MilestoneSchema,
} from "@glideworth/core";
import { Flag, Lock, MoreHorizontal, Plus, Trash2, X } from "lucide-react";
import {
  ActionMenu,
  ActionMenuContent,
  ActionMenuItem,
  ActionMenuLabel,
  ActionMenuSeparator,
  ActionMenuTrigger,
} from "../../../components/ui/action-menu";
import { AppearanceDot, AppearancePicker } from "../../../components/ui/appearance-picker";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardHeader } from "../../../components/ui/card";
import { confirmAction } from "../../../components/ui/confirm-dialog";
import { EmptyState } from "../../../components/ui/empty-state";
import { HelpTip } from "../../../components/ui/help-tip";
import { Input } from "../../../components/ui/input";
import { AmountInput, NumberInput, PercentInput } from "../../../components/ui/number-input";
import { Segmented } from "../../../components/ui/segmented";
import { Select } from "../../../components/ui/select";
import {
  FieldGrid,
  FormSection,
  Sheet,
  SheetClose,
  SheetContent,
} from "../../../components/ui/sheet";
import { Switch, SwitchField } from "../../../components/ui/switch";
import { cn } from "../../../lib/cn";
import { COUNTRY_LIST } from "../../../lib/countries";
import { useFormat } from "../../../lib/workspace";
import { LocationFields } from "../../crossborder/fields";
import { suggestedDestination } from "../../crossborder/model";
import { WhoField } from "../../crossborder/residency-section";
import { EnumField, FormField, useScope } from "../components/form";
import { replaceById, usePlan, useUpdatePlan } from "../components/plan-context";
import { usePreview } from "../preview/use-live-projection";
import { newMilestone } from "../state/defaults";
import { useEditorStore } from "../state/doc-store";
import { HELP, METRIC_LABEL, MILESTONE_KIND_LABEL } from "../state/labels";
import { describeMonth } from "../state/resolve";
import { useIssues } from "../state/validation";

const ADDABLE = [
  "financial-independence",
  "coast-fi",
  "lean-fi",
  "fat-fi",
  "debt-free",
  "retirement",
  "move",
  "custom",
] as const;

export function useAddMilestone() {
  const update = useUpdatePlan();
  const household = useEditorStore((s) => s.draft?.household);
  const finances = useEditorStore((s) => s.draft?.finances);
  return (kind: Milestone["kind"] = "custom") => {
    if (!household || !finances) return null;
    const m = newMilestone({ household, finances }, kind);
    update((p) => ({ ...p, milestones: [...p.milestones, m] }), `Add ${m.name}`);
    return m.id;
  };
}

export function AddMilestoneMenu({
  onAdded,
  primary = false,
}: {
  onAdded: (id: string) => void;
  primary?: boolean;
}) {
  const add = useAddMilestone();
  return (
    <ActionMenu>
      <ActionMenuTrigger asChild>
        <Button size="sm" variant={primary ? "primary" : "secondary"}>
          <Plus /> Add milestone
        </Button>
      </ActionMenuTrigger>
      <ActionMenuContent>
        <ActionMenuLabel>Start from</ActionMenuLabel>
        {ADDABLE.map((k) => (
          <ActionMenuItem
            key={k}
            onSelect={() => {
              const id = add(k);
              if (id) onAdded(id);
            }}
          >
            {MILESTONE_KIND_LABEL[k]}
          </ActionMenuItem>
        ))}
      </ActionMenuContent>
    </ActionMenu>
  );
}

export function describeCriterion(
  c: MilestoneCriterion,
  ctx: {
    people: { id: string; name: string }[];
    milestones: Milestone[];
    money: (v: number) => string;
  },
): string {
  const when = "when" in c && c.when === "before" ? "before " : "";
  switch (c.kind) {
    case "age":
      return `${ctx.people.find((p) => p.id === c.personId)?.name ?? "?"} ${when ? "is under" : "reaches"} ${c.age}`;
    case "date":
      return `${when || "on "}${c.date}`;
    case "milestone": {
      const off = c.offsetMonths
        ? ` ${c.offsetMonths > 0 ? "+" : "−"}${Math.abs(c.offsetMonths)} mo`
        : "";
      return `${when || "at "}${ctx.milestones.find((m) => m.id === c.milestoneId)?.name ?? "?"}${off}`;
    }
    case "metric": {
      const t =
        c.threshold.kind === "amount"
          ? ctx.money(c.threshold.amount.value)
          : `${c.threshold.multiple}× ${c.threshold.of === "essentialSpending" ? "essential spending" : c.threshold.of}`;
      return `${METRIC_LABEL[c.metric.kind]} ${c.comparator} ${t}`;
    }
  }
}

export function MilestonesSection({ onOpen }: { onOpen: (id: string) => void }) {
  const plan = usePlan();
  const update = useUpdatePlan();
  const f = useFormat();
  const { people, tctx } = useScope();
  const result = usePreview((s) => s.result);
  if (!plan) return null;
  const res = new Map(result?.milestones.map((m) => [m.milestoneId, m]));
  return (
    <Card>
      <CardHeader
        eyebrow="Points on the trail"
        title="Milestones"
        actions={<AddMilestoneMenu onAdded={onOpen} />}
      />
      {plan.milestones.length === 0 ? (
        <EmptyState
          icon={Flag}
          title="Milestones mark the moments that matter"
          action={<AddMilestoneMenu onAdded={onOpen} primary />}
        >
          Retirement, financial independence, being debt-free. Income and expenses can start or stop
          at a milestone, so moving one moves everything tied to it.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {plan.milestones.map((m, i) => {
            const r = res.get(m.id);
            const month = r?.month
              ? Number(r.month.slice(0, 4)) * 12 + Number(r.month.slice(5, 7)) - 1
              : (tctx?.milestoneMonth[m.id] ?? null);
            return (
              <li
                key={m.id}
                className={cn(
                  "group flex items-center gap-3 px-3 py-2.5 sm:px-4",
                  !m.enabled && "opacity-55",
                )}
              >
                <AppearanceDot
                  appearance={m.appearance}
                  fallbackIndex={i + 2}
                  size={24}
                  fallbackIcon={Flag}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left pointer-coarse:min-h-11"
                  onClick={() => onOpen(m.id)}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium group-hover:text-accent">
                      {m.name}
                    </span>
                    {m.builtIn ? (
                      <Lock className="size-3 text-ink-3" aria-label="Built in" />
                    ) : null}
                    {m.effects.length ? (
                      <Badge tone="ochre">
                        {m.effects.length} effect{m.effects.length > 1 ? "s" : ""}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="truncate text-[11.5px] text-ink-3">
                    {m.criteria
                      .map((c) =>
                        describeCriterion(c, {
                          people,
                          milestones: plan.milestones,
                          money: (v) => f.money(v, true),
                        }),
                      )
                      .join(m.combinator === "all" ? " and " : " or ")}
                  </div>
                </button>
                <div className="text-right text-[12px]">
                  {month !== null && tctx ? (
                    <span className="num text-ink">{describeMonth(month, tctx, f.locale)}</span>
                  ) : r?.status === "never" ? (
                    <span className="text-warning">Never reached</span>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </div>
                <Switch
                  size="sm"
                  aria-label={`${m.name} enabled`}
                  checked={m.enabled}
                  onCheckedChange={(enabled) =>
                    update(
                      (p) => ({
                        ...p,
                        milestones: replaceById(p.milestones, m.id, (x) => ({ ...x, enabled })),
                      }),
                      enabled ? "Enable milestone" : "Disable milestone",
                    )
                  }
                />
                <ActionMenu>
                  <ActionMenuTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={`Actions for ${m.name}`}
                    >
                      <MoreHorizontal />
                    </Button>
                  </ActionMenuTrigger>
                  <ActionMenuContent>
                    <ActionMenuItem onSelect={() => onOpen(m.id)}>Edit</ActionMenuItem>
                    <ActionMenuItem
                      onSelect={() =>
                        update(
                          (p) => ({
                            ...p,
                            milestones: replaceById(p.milestones, m.id, (x) => ({
                              ...x,
                              showOnChart: !x.showOnChart,
                            })),
                          }),
                          "Toggle chart marker",
                        )
                      }
                    >
                      {m.showOnChart ? "Hide on charts" : "Show on charts"}
                    </ActionMenuItem>
                    <ActionMenuSeparator />
                    <ActionMenuItem
                      tone="negative"
                      disabled={m.builtIn}
                      hint={
                        m.builtIn ? "Built-in milestones can be edited, not deleted" : undefined
                      }
                      onSelect={() =>
                        update(
                          (p) => ({ ...p, milestones: p.milestones.filter((x) => x.id !== m.id) }),
                          `Delete ${m.name}`,
                        )
                      }
                    >
                      <Trash2 /> Delete
                    </ActionMenuItem>
                  </ActionMenuContent>
                </ActionMenu>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function MilestoneSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      {id ? <MilestoneSheetBody id={id} onClose={onClose} /> : null}
    </Sheet>
  );
}

function usesMilestone(plan: NonNullable<ReturnType<typeof usePlan>>, id: string): number {
  return (
    JSON.stringify([
      plan.income,
      plan.expenses,
      plan.flows,
      plan.milestones.filter((m) => m.id !== id),
    ]).split(`"milestoneId":"${id}"`).length - 1
  );
}

function MilestoneSheetBody({ id, onClose }: { id: string; onClose: () => void }) {
  const plan = usePlan();
  const update = useUpdatePlan();
  const f = useFormat();
  const { people, tctx } = useScope();
  const result = usePreview((s) => s.result);
  const m = plan?.milestones.find((x) => x.id === id);
  const issues = useIssues(MilestoneSchema, m);
  if (!plan || !m) return null;
  const set = (fn: (x: Milestone) => Milestone, label: string, key?: string) =>
    update(
      (p) => ({ ...p, milestones: replaceById(p.milestones, id, fn) }),
      label,
      key ? `${id}:${key}` : undefined,
    );
  const setCriterion = (i: number, c: MilestoneCriterion, key?: string) =>
    set(
      (x) => ({ ...x, criteria: x.criteria.map((y, j) => (j === i ? c : y)) }),
      "Edit condition",
      key ? `c${i}:${key}` : undefined,
    );
  const r = result?.milestones.find((x) => x.milestoneId === id);
  const month = r?.month
    ? Number(r.month.slice(0, 4)) * 12 + Number(r.month.slice(5, 7)) - 1
    : (tctx?.milestoneMonth[id] ?? null);
  const used = usesMilestone(plan, id);
  const remove = async () => {
    if (
      used &&
      !(await confirmAction({
        title: `Delete ${m.name}?`,
        description: `${used} ${used === 1 ? "thing starts or stops" : "things start or stop"} at this milestone. They will show a missing-milestone error until you change them. You can undo this.`,
        confirmLabel: "Delete anyway",
      }))
    )
      return;
    onClose();
    update(
      (p) => ({ ...p, milestones: p.milestones.filter((x) => x.id !== id) }),
      `Delete ${m.name}`,
    );
  };
  const me = people[0]!;
  const newCriterion = (kind: MilestoneCriterion["kind"]): MilestoneCriterion =>
    kind === "age"
      ? { kind: "age", personId: me.id, age: 60, when: "at" }
      : kind === "date"
        ? { kind: "date", date: `${new Date().getFullYear() + 5}-01`, when: "at" }
        : kind === "milestone"
          ? {
              kind: "milestone",
              milestoneId: plan.milestones.find((x) => x.id !== id)?.id ?? "",
              offsetMonths: 0,
              when: "at",
            }
          : {
              kind: "metric",
              metric: { kind: "liquidNetWorth" },
              comparator: ">=",
              threshold: { kind: "amount", amount: { value: 500_000, basis: "real" } },
            };

  return (
    <SheetContent
      eyebrow={`Milestone · ${MILESTONE_KIND_LABEL[m.kind]}`}
      title={m.name || "Untitled"}
      description={
        month !== null && tctx
          ? `Reached ${describeMonth(month, tctx, f.locale)}${r?.via === "metric" ? " (from the projection)" : ""}`
          : r?.status === "never"
            ? "Never reached in the current projection"
            : "Resolves when simulated"
      }
      width={640}
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            className="text-negative"
            onClick={remove}
            disabled={m.builtIn}
          >
            <Trash2 /> Delete
          </Button>
          {used ? (
            <span className="text-[12px] text-ink-3">
              {used} linked {used === 1 ? "date" : "dates"}
            </span>
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
                value={m.name}
                onChange={(e) =>
                  set((x) => ({ ...x, name: e.target.value }), "Rename milestone", "name")
                }
              />
            )}
          </FormField>
          <EnumField
            label="Kind"
            value={m.kind}
            onChange={(kind) => set((x) => ({ ...x, kind }), "Change kind")}
            options={MILESTONE_KINDS.map((k) => ({
              value: k,
              label: MILESTONE_KIND_LABEL[k] ?? k,
            }))}
          />
          {m.kind === "retirement" || m.kind === "life-expectancy" ? (
            <EnumField
              label="Person"
              value={m.personId ?? me.id}
              onChange={(personId) => set((x) => ({ ...x, personId }), "Change person")}
              options={people.map((p) => ({ value: p.id, label: p.name }))}
            />
          ) : null}
        </FieldGrid>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <SwitchField
            label="Enabled"
            checked={m.enabled}
            onCheckedChange={(enabled) => set((x) => ({ ...x, enabled }), "Toggle milestone")}
          />
          <SwitchField
            label="Show on charts"
            checked={m.showOnChart}
            onCheckedChange={(showOnChart) =>
              set((x) => ({ ...x, showOnChart }), "Toggle chart marker")
            }
          />
        </div>
      </FormSection>

      <FormSection
        title="Reached when"
        description="Combine conditions. Time conditions resolve exactly; metric conditions are checked at the end of each simulated year."
        aside={
          m.criteria.length > 1 ? (
            <div className="flex items-center gap-1">
              <Segmented<"all" | "any">
                aria-label="Combine conditions"
                size="sm"
                value={m.combinator}
                onChange={(combinator) => set((x) => ({ ...x, combinator }), "Change AND/OR")}
                options={[
                  { value: "all", label: "All (AND)" },
                  { value: "any", label: "Any (OR)" },
                ]}
              />
              <HelpTip>{HELP.milestoneCombinator}</HelpTip>
            </div>
          ) : undefined
        }
      >
        <ol className="flex flex-col gap-2">
          {m.criteria.map((c, i) => (
            // oxlint-disable-next-line react/no-array-index-key -- criteria have no ids
            <li key={i} className="relative">
              {i > 0 ? (
                <div className="eyebrow -mt-1 mb-1 pl-1 text-accent">
                  {m.combinator === "all" ? "and" : "or"}
                </div>
              ) : null}
              <CriterionEditor
                value={c}
                selfId={id}
                onChange={(next, key) => setCriterion(i, next, key)}
                onKind={(kind) => setCriterion(i, newCriterion(kind))}
                onRemove={
                  m.criteria.length > 1
                    ? () =>
                        set(
                          (x) => ({ ...x, criteria: x.criteria.filter((_, j) => j !== i) }),
                          "Remove condition",
                        )
                    : undefined
                }
                error={issues.under(`criteria.${i}`)}
              />
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-1.5">
          {(["age", "date", "milestone", "metric"] as const).map((k) => (
            <Button
              key={k}
              size="sm"
              variant="ghost"
              onClick={() =>
                set((x) => ({ ...x, criteria: [...x.criteria, newCriterion(k)] }), "Add condition")
              }
            >
              <Plus />{" "}
              {k === "age"
                ? "Age"
                : k === "date"
                  ? "Date"
                  : k === "milestone"
                    ? "Another milestone"
                    : "A money target"}
            </Button>
          ))}
        </div>
        {m.criteria.length === 1 && "when" in m.criteria[0]! && m.criteria[0]!.when === "before" ? (
          <p className="text-[12px] text-warning">{HELP.before}</p>
        ) : null}
      </FormSection>

      <FormSection title="Effects" description="What changes from this point on.">
        {m.effects.map((e, i) => (
          <EffectEditor
            // oxlint-disable-next-line react/no-array-index-key -- effects have no ids
            key={i}
            value={e}
            onChange={(v) =>
              set(
                (x) => ({ ...x, effects: x.effects.map((y, j) => (j === i ? v : y)) }),
                "Edit effect",
                `e${i}`,
              )
            }
            onRemove={() =>
              set((x) => ({ ...x, effects: x.effects.filter((_, j) => j !== i) }), "Remove effect")
            }
          />
        ))}
        <ActionMenu>
          <ActionMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="self-start">
              <Plus /> Add effect
            </Button>
          </ActionMenuTrigger>
          <ActionMenuContent align="start">
            <ActionMenuItem
              hint="e.g. marriage, or a partner’s death"
              onSelect={() =>
                set(
                  (x) => ({
                    ...x,
                    effects: [
                      ...x.effects,
                      { kind: "setFilingStatus", filingStatus: "married-joint" },
                    ],
                  }),
                  "Add effect",
                )
              }
            >
              Change filing status
            </ActionMenuItem>
            <ActionMenuItem
              hint="Move country or state: taxes follow"
              onSelect={() =>
                set(
                  (x) => ({
                    ...x,
                    effects: [
                      ...x.effects,
                      {
                        kind: "relocate",
                        location: {
                          country: suggestedDestination(
                            useEditorStore.getState().draft?.household.location.country ?? "",
                            COUNTRY_LIST,
                          ),
                        },
                      },
                    ],
                  }),
                  "Add effect",
                )
              }
            >
              Relocate
            </ActionMenuItem>
            <ActionMenuItem
              hint="Tax withheld on withdrawals"
              onSelect={() =>
                set(
                  (x) => ({
                    ...x,
                    effects: [...x.effects, { kind: "setWithholding", taxDeferred: 0.2 }],
                  }),
                  "Add effect",
                )
              }
            >
              Change withholding
            </ActionMenuItem>
            <ActionMenuItem
              hint="Survivor inherits; filing status changes"
              onSelect={() =>
                set(
                  (x) => ({
                    ...x,
                    effects: [...x.effects, { kind: "death", personId: m.personId ?? me.id }],
                  }),
                  "Add effect",
                )
              }
            >
              Death of a household member
            </ActionMenuItem>
          </ActionMenuContent>
        </ActionMenu>
      </FormSection>

      <FormSection title="Appearance">
        <AppearancePicker
          value={m.appearance}
          onChange={(appearance) => set((x) => ({ ...x, appearance }), "Change appearance")}
        />
      </FormSection>
    </SheetContent>
  );
}

const COMPARATORS: { value: Comparator; label: string }[] = [
  { value: ">=", label: "at least" },
  { value: ">", label: "more than" },
  { value: "<=", label: "at most" },
  { value: "<", label: "less than" },
  { value: "=", label: "exactly" },
];

function CriterionEditor({
  value: c,
  onChange,
  onKind,
  onRemove,
  selfId,
  error,
}: {
  value: MilestoneCriterion;
  onChange: (c: MilestoneCriterion, key?: string) => void;
  onKind: (k: MilestoneCriterion["kind"]) => void;
  onRemove?: () => void;
  selfId: string;
  error?: string;
}) {
  const { people, milestones, accounts } = useScope();
  const finances = useEditorStore((s) => s.draft?.finances);
  const whenSel =
    c.kind !== "metric" ? (
      <Select<"at" | "before">
        aria-label="At or before"
        value={c.when}
        onValueChange={(when) => onChange({ ...c, when })}
        options={[
          { value: "at", label: "at" },
          { value: "before", label: "before" },
        ]}
        className="w-[88px]"
      />
    ) : null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 rounded-lg border bg-surface-2/40 p-2",
        error ? "border-negative/50" : "border-border",
      )}
    >
      <Select<MilestoneCriterion["kind"]>
        aria-label="Condition type"
        value={c.kind}
        onValueChange={onKind}
        options={[
          { value: "age", label: "Age" },
          { value: "date", label: "Date" },
          { value: "milestone", label: "Milestone" },
          { value: "metric", label: "Money target" },
        ]}
        className="w-[130px]"
      />
      {c.kind === "age" ? (
        <>
          <Select
            aria-label="Person"
            value={c.personId}
            onValueChange={(personId) => onChange({ ...c, personId })}
            options={people.map((p) => ({ value: p.id, label: p.name }))}
            className="w-[120px]"
          />
          {whenSel}
          <span className="text-[12.5px] text-ink-3">age</span>
          <NumberInput
            aria-label="Age"
            decimals={1}
            className="w-[80px]"
            value={c.age}
            onValueChange={(age) => onChange({ ...c, age: age ?? 0 }, "age")}
          />
        </>
      ) : c.kind === "date" ? (
        <>
          {whenSel}
          <Input
            type="month"
            aria-label="Month"
            className="w-[150px] pointer-coarse:w-[184px]"
            value={c.date}
            onChange={(e) => onChange({ ...c, date: e.target.value }, "date")}
          />
        </>
      ) : c.kind === "milestone" ? (
        <>
          {whenSel}
          <Select
            aria-label="Milestone"
            value={c.milestoneId || undefined}
            placeholder="Choose…"
            onValueChange={(milestoneId) => onChange({ ...c, milestoneId })}
            options={milestones
              .filter((m) => m.id !== selfId)
              .map((m) => ({ value: m.id, label: m.name }))}
            className="w-[170px]"
          />
          <NumberInput
            aria-label="Offset in months"
            decimals={0}
            prefix="±"
            suffix="mo"
            className="w-[96px]"
            value={c.offsetMonths}
            onValueChange={(v) => onChange({ ...c, offsetMonths: Math.round(v ?? 0) }, "off")}
          />
        </>
      ) : (
        <MetricEditor
          c={c}
          onChange={onChange}
          accounts={accounts}
          debts={finances?.debts ?? []}
          assets={(finances?.realAssets ?? []).filter((r) => r.loan)}
        />
      )}
      {onRemove ? (
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto size-7"
          aria-label="Remove condition"
          onClick={onRemove}
        >
          <X />
        </Button>
      ) : null}
      {error ? <p className="w-full text-[11.5px] text-negative">{error}</p> : null}
    </div>
  );
}

function MetricEditor({
  c,
  onChange,
  accounts,
  debts,
  assets,
}: {
  c: Extract<MilestoneCriterion, { kind: "metric" }>;
  onChange: (c: MilestoneCriterion, key?: string) => void;
  accounts: { id: string; name: string }[];
  debts: { id: string; name: string }[];
  assets: { id: string; name: string }[];
}) {
  const metric = (kind: MilestoneMetric["kind"]): MilestoneMetric =>
    kind === "accountBalance"
      ? { kind, accountId: accounts[0]?.id ?? "" }
      : kind === "debtBalance"
        ? { kind, debtId: debts[0]?.id ?? "" }
        : kind === "loanBalance"
          ? { kind, assetId: assets[0]?.id ?? "" }
          : ({ kind } as MilestoneMetric);
  const t = c.threshold;
  return (
    <>
      <Select<MilestoneMetric["kind"]>
        aria-label="Metric"
        value={c.metric.kind}
        onValueChange={(k) => onChange({ ...c, metric: metric(k) })}
        options={(Object.keys(METRIC_LABEL) as MilestoneMetric["kind"][]).map((k) => ({
          value: k,
          label: METRIC_LABEL[k],
        }))}
        className="w-[150px]"
      />
      {c.metric.kind === "accountBalance" ? (
        <Select
          aria-label="Account"
          value={c.metric.accountId || undefined}
          placeholder="Account"
          onValueChange={(accountId) =>
            onChange({ ...c, metric: { kind: "accountBalance", accountId } })
          }
          options={accounts.map((a) => ({ value: a.id, label: a.name }))}
          className="w-[150px]"
        />
      ) : null}
      {c.metric.kind === "debtBalance" ? (
        <Select
          aria-label="Debt"
          value={c.metric.debtId || undefined}
          placeholder="Debt"
          onValueChange={(debtId) => onChange({ ...c, metric: { kind: "debtBalance", debtId } })}
          options={debts.map((a) => ({ value: a.id, label: a.name }))}
          className="w-[150px]"
        />
      ) : null}
      {c.metric.kind === "loanBalance" ? (
        <Select
          aria-label="Asset loan"
          value={c.metric.assetId || undefined}
          placeholder="Asset"
          onValueChange={(assetId) => onChange({ ...c, metric: { kind: "loanBalance", assetId } })}
          options={assets.map((a) => ({ value: a.id, label: a.name }))}
          className="w-[150px]"
        />
      ) : null}
      <Select<Comparator>
        aria-label="Comparison"
        value={c.comparator}
        onValueChange={(comparator) => onChange({ ...c, comparator })}
        options={COMPARATORS}
        className="w-[110px]"
      />
      <Segmented<"amount" | "multipleOf">
        aria-label="Threshold type"
        size="sm"
        value={t.kind}
        onChange={(k) =>
          onChange({
            ...c,
            threshold:
              k === "amount"
                ? { kind: "amount", amount: { value: 500_000, basis: "real" } }
                : { kind: "multipleOf", multiple: 25, of: "spending", measurement: "current" },
          })
        }
        options={[
          { value: "amount", label: "Amount" },
          { value: "multipleOf", label: "× spending" },
        ]}
      />
      {t.kind === "amount" ? (
        <div className="w-full sm:w-[260px]">
          <AmountInput
            value={t.amount}
            onChange={(amount) => onChange({ ...c, threshold: { kind: "amount", amount } }, "thr")}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <NumberInput
            aria-label="Multiple"
            decimals={1}
            suffix="×"
            className="w-[84px]"
            value={t.multiple}
            onValueChange={(multiple) =>
              onChange({ ...c, threshold: { ...t, multiple: Math.max(0, multiple ?? 0) } }, "mult")
            }
          />
          <Select<"spending" | "expenses" | "essentialSpending">
            aria-label="Of"
            value={t.of}
            onValueChange={(of) => onChange({ ...c, threshold: { ...t, of } })}
            options={[
              { value: "spending", label: "annual spending" },
              { value: "expenses", label: "annual expenses" },
              { value: "essentialSpending", label: "essential spending" },
            ]}
            className="w-[160px]"
          />
          <Select<"current" | "average">
            aria-label="Measured"
            value={t.measurement}
            onValueChange={(measurement) => onChange({ ...c, threshold: { ...t, measurement } })}
            options={[
              { value: "current", label: "that year" },
              { value: "average", label: "average from then on" },
            ]}
            className="w-[170px]"
          />
          <HelpTip>{HELP.metricMultiple}</HelpTip>
        </div>
      )}
    </>
  );
}

function EffectEditor({
  value: e,
  onChange,
  onRemove,
}: {
  value: MilestoneEffect;
  onChange: (e: MilestoneEffect) => void;
  onRemove: () => void;
}) {
  const { people } = useScope();
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-medium">
          {e.kind === "setFilingStatus"
            ? "Change filing status"
            : e.kind === "relocate"
              ? "Relocate"
              : e.kind === "setWithholding"
                ? "Change withholding"
                : "Death of a household member"}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Remove effect"
          onClick={onRemove}
        >
          <X />
        </Button>
      </div>
      {e.kind === "setFilingStatus" ? (
        <EnumField
          label="New filing status"
          value={e.filingStatus}
          onChange={(filingStatus) => onChange({ ...e, filingStatus })}
          options={[
            { value: "single", label: "Single / separate" },
            { value: "married-joint", label: "Married, joint" },
            { value: "married-separate", label: "Married, separate" },
            { value: "head-of-household", label: "Head of household" },
            { value: "qualifying-surviving-spouse", label: "Surviving spouse" },
          ]}
        />
      ) : e.kind === "relocate" ? (
        <FieldGrid>
          <LocationFields
            label="Moves to"
            value={e.location}
            onChange={(location) => onChange({ ...e, location })}
          />
          <WhoField
            value={e.personId}
            people={people}
            onChange={(personId) => {
              const { personId: _p, ...rest } = e;
              onChange(personId ? { ...rest, personId } : rest);
            }}
          />
          <p className="text-[11.5px] text-ink-3 sm:col-span-2">
            Tax residence changes from the first year starting after the milestone. Dated moves and
            everyone's residence are under “Where you live”.
          </p>
        </FieldGrid>
      ) : e.kind === "setWithholding" ? (
        <FieldGrid cols={3}>
          <FormField label="Pension withdrawals">
            {(id) => (
              <PercentInput
                id={id}
                value={e.taxDeferred ?? null}
                onValueChange={(v) => onChange({ ...e, taxDeferred: v ?? undefined })}
              />
            )}
          </FormField>
          <FormField label="Taxable sales">
            {(id) => (
              <PercentInput
                id={id}
                value={e.taxable ?? null}
                onValueChange={(v) => onChange({ ...e, taxable: v ?? undefined })}
              />
            )}
          </FormField>
          <FormField label="Conversions">
            {(id) => (
              <PercentInput
                id={id}
                value={e.conversions ?? null}
                onValueChange={(v) => onChange({ ...e, conversions: v ?? undefined })}
              />
            )}
          </FormField>
        </FieldGrid>
      ) : (
        <EnumField
          label="Who"
          value={e.personId}
          onChange={(personId) => onChange({ ...e, personId })}
          options={people.map((p) => ({ value: p.id, label: p.name }))}
          hint="Their accounts pass to the survivor, filing status changes and cost basis steps up."
        />
      )}
    </div>
  );
}
