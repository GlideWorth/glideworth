/**
 * Income and expense events: lists with type-aware "Add" menus, and the full editing sheet for
 * every event type (amount, frequency, timing, change over time, recurrence, tax, routing, and the
 * type-specific parts: part-time and DB pensions, RSU vesting, Social Security estimates,
 * healthcare and charity details).
 */

import {
  type AcaHouseholdSize,
  type Change,
  type ExpenseEvent,
  ExpenseEvent as ExpenseSchema,
  type ExpenseType,
  FREQUENCY_PER_YEAR,
  type IncomeEvent,
  IncomeEvent as IncomeSchema,
  type IncomeType,
  type InflationCategory,
  isDependentInPeriod,
  JOINT,
  type Plan,
} from "@glideworth/core";
import { Copy, HandCoins, MoreHorizontal, Plus, Receipt, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  ActionMenu,
  ActionMenuContent,
  ActionMenuItem,
  ActionMenuLabel,
  ActionMenuSeparator,
  ActionMenuTrigger,
  ActionSubMenu,
} from "../../../components/ui/action-menu";
import { AppearanceDot, AppearancePicker } from "../../../components/ui/appearance-picker";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardHeader } from "../../../components/ui/card";
import { confirmAction } from "../../../components/ui/confirm-dialog";
import { EmptyState } from "../../../components/ui/empty-state";
import { Input } from "../../../components/ui/input";
import {
  AmountInput,
  CurrencyInput,
  NumberInput,
  PercentInput,
} from "../../../components/ui/number-input";
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
import { Textarea } from "../../../components/ui/textarea";
import { toast } from "../../../components/ui/toaster";
import { cn } from "../../../lib/cn";
import { useFormat } from "../../../lib/workspace";
import { IncomeCrossBorder } from "../../crossborder/income-fields";
import { CurrencySelect } from "../../currency/fx";
import {
  AccountRoutingEditor,
  ChangeEditor,
  DateRefField,
  EnumField,
  FormField,
  FrequencySelect,
  OwnerSelect,
  SchedulePointsEditor,
  useScope,
} from "../components/form";
import { replaceById, usePlan, useUpdatePlan } from "../components/plan-context";
import { newExpense, newId, newIncome } from "../state/defaults";
import { useEditorStore } from "../state/doc-store";
import { amountUnit, EXPENSE_TYPES, HELP, INCOME_TYPES, type TypeMeta } from "../state/labels";
import { describeMonth, formatMonthIndex, resolveRef } from "../state/resolve";
import { type Issues, useIssues } from "../state/validation";
import { InflationCategorySelect } from "./assumption-extras";

type Kind = "income" | "expense";
type AnyEvent = IncomeEvent | ExpenseEvent;

/** Healthcare and long-term care compound an extra rate on top of the inflation index. */
function isCareExpense(kind: Kind, type: string): boolean {
  return kind === "expense" && (type === "healthcare" || type === "long-term-care");
}

/** A category whose index is not general inflation (its own rate, or a non-zero premium). */
function categoryHasOwnPath(category: InflationCategory): boolean {
  if (category.rate.kind !== "fixed") return true;
  if (category.mode === "rate") return true;
  return category.rate.rate !== 0;
}

/**
 * Copy for healthcare and long-term care. "Rises with: General inflation" on its own hides the
 * extra rate the engine compounds (`change.plus`, the plan healthcare premium on a new cost).
 */
function careRiseHint(change: Change, category: InflationCategory | undefined): string {
  if (change.kind === "none")
    return "This stays at the amount entered and does not rise with inflation. The projection uses that. Choose “With inflation” under Change over time to set a rate above inflation.";
  if (change.kind === "rate")
    return "This grows at a fixed rate whether or not prices rise (see Change over time). The projection uses that rate.";
  if (change.kind === "schedule")
    return "This follows the custom schedule under Change over time. The projection uses that schedule.";
  if (category && categoryHasOwnPath(category))
    return "The category has its own inflation path, and the rate above is applied on top. The projection uses both.";
  if (change.plus === 0)
    return "In today’s money this stays at the amount you enter. The projection uses that.";
  return "In today’s money this rises by the rate above every year. The projection uses that rate.";
}

// ------------------------------------------------------------------------------- helpers

function useCtx() {
  const household = useEditorStore((s) => s.draft?.household);
  const finances = useEditorStore((s) => s.draft?.finances);
  return household && finances ? { household, finances } : null;
}

export function useAddEvent() {
  const ctx = useCtx();
  const update = useUpdatePlan();
  const plan = usePlan();
  return (kind: Kind, type: string): string | null => {
    if (!ctx || !plan) return null;
    if (kind === "income") {
      const e = newIncome(type as IncomeType, ctx, plan);
      update((p) => ({ ...p, income: [...p.income, e] }), `Add ${e.name}`);
      return e.id;
    }
    const e = newExpense(type as ExpenseType, ctx, plan.assumptions.healthcareInflationPremium);
    update((p) => ({ ...p, expenses: [...p.expenses, e] }), `Add ${e.name}`);
    return e.id;
  };
}

function relevant<T extends string>(types: TypeMeta<T>[], country: string) {
  const home = types.filter((t) => !t.countries || t.countries.includes(country));
  const other = types.filter((t) => t.countries && !t.countries.includes(country));
  return { home, other };
}

export function AddEventMenu({
  kind,
  onAdded,
  trigger,
}: {
  kind: Kind;
  onAdded: (id: string) => void;
  trigger?: ReactNode;
}) {
  const add = useAddEvent();
  const country = useEditorStore((s) => s.draft?.household.location.country ?? "GB");
  const { home, other } = relevant<string>(
    (kind === "income" ? INCOME_TYPES : EXPENSE_TYPES) as TypeMeta<string>[],
    country,
  );
  return (
    <ActionMenu>
      <ActionMenuTrigger asChild>
        {trigger ?? (
          <Button size="sm">
            <Plus /> Add {kind}
          </Button>
        )}
      </ActionMenuTrigger>
      <ActionMenuContent className="w-[280px]">
        <ActionMenuLabel>{kind === "income" ? "Income" : "Expense"} type</ActionMenuLabel>
        {home.map((t) => (
          <ActionMenuItem
            key={t.value}
            hint={t.hint || undefined}
            onSelect={() => {
              const id = add(kind, t.value);
              if (id) onAdded(id);
            }}
          >
            {t.label}
          </ActionMenuItem>
        ))}
        {other.length ? (
          <>
            <ActionMenuSeparator />
            <ActionSubMenu label="Other countries">
              {other.map((t) => (
                <ActionMenuItem
                  key={t.value}
                  hint={t.hint}
                  onSelect={() => {
                    const id = add(kind, t.value);
                    if (id) onAdded(id);
                  }}
                >
                  {t.label}
                </ActionMenuItem>
              ))}
            </ActionSubMenu>
          </>
        ) : null}
      </ActionMenuContent>
    </ActionMenu>
  );
}

export function typeLabel(kind: Kind, type: string) {
  return (
    ((kind === "income" ? INCOME_TYPES : EXPENSE_TYPES) as TypeMeta<string>[]).find(
      (t) => t.value === type,
    )?.label ?? type
  );
}

type PercentBonus = Extract<IncomeEvent, { type: "bonus" }> & {
  percentOfSalary: NonNullable<Extract<IncomeEvent, { type: "bonus" }>["percentOfSalary"]>;
};

/** A bonus set as a share of a salary (its own amount is then ignored). */
function percentBonus(e: AnyEvent): PercentBonus | null {
  return e.type === "bonus" && "percentOfSalary" in e && e.percentOfSalary
    ? (e as PercentBonus)
    : null;
}

/**
 * A year's worth of an event, as the engine counts it (an hourly wage is paid weekly; a bonus set
 * as a share of a salary is that share of the salary's year, given the plan's income).
 */
export function annual(e: AnyEvent, income: readonly IncomeEvent[] = []): number | null {
  const pb = percentBonus(e);
  if (pb) {
    const sal = income.find((x) => x.id === pb.percentOfSalary.salaryIncomeId);
    const base = sal ? annual(sal) : null;
    return base === null ? null : base * pb.percentOfSalary.rate;
  }
  if (e.type === "hourly" && "hoursPerWeek" in e)
    return e.amount.value * e.hoursPerWeek * FREQUENCY_PER_YEAR.weekly;
  if (e.frequency === "once") return null;
  return e.amount.value * FREQUENCY_PER_YEAR[e.frequency];
}

// ------------------------------------------------------------------------------- list

export function EventsSection({ kind, onOpen }: { kind: Kind; onOpen: (id: string) => void }) {
  const plan = usePlan();
  const update = useUpdatePlan();
  const f = useFormat();
  const { people, tctx } = useScope();
  if (!plan) return null;
  const items: AnyEvent[] = kind === "income" ? plan.income : plan.expenses;
  const field = kind === "income" ? "income" : "expenses";
  const setItems = (fn: (xs: AnyEvent[]) => AnyEvent[], label: string) =>
    update((p) => ({ ...p, [field]: fn(p[field] as AnyEvent[]) }) as Plan, label);
  const when = (e: AnyEvent) => {
    if (!tctx) return "";
    const s = resolveRef(e.range.start, tctx);
    const en = resolveRef(e.range.end, tctx);
    const fmt = (m: number | null) => (m === null ? "—" : String(Math.floor(m / 12)));
    return e.frequency === "once"
      ? s === null
        ? "Never"
        : formatMonthIndex(s, f.locale)
      : `${fmt(s)}–${en === null ? "end" : fmt(en)}`;
  };
  const totalNow = items
    .filter((e) => e.enabled)
    .reduce((s, e) => {
      if (!tctx) return s;
      const st = resolveRef(e.range.start, tctx);
      const en = resolveRef(e.range.end, tctx);
      const active = st !== null && st <= tctx.start && (en === null || en > tctx.start);
      return s + (active ? (annual(e, plan.income) ?? 0) : 0);
    }, 0);
  return (
    <Card>
      <CardHeader
        eyebrow={kind === "income" ? "Money coming in" : "Money going out"}
        title={
          <span className="flex items-baseline gap-2">
            {kind === "income" ? "Income" : "Expenses"}
            {items.length ? (
              <span className="num text-[12px] font-normal text-ink-3">
                {f.money(totalNow)} a year today
              </span>
            ) : null}
          </span>
        }
        actions={<AddEventMenu kind={kind} onAdded={onOpen} />}
      />
      {items.length === 0 ? (
        <EmptyState
          icon={kind === "income" ? HandCoins : Receipt}
          title={kind === "income" ? "Add what you earn, now and later" : "Add what you spend"}
          action={
            <AddEventMenu
              kind={kind}
              onAdded={onOpen}
              trigger={
                <Button variant="primary" size="sm">
                  <Plus /> Add {kind}
                </Button>
              }
            />
          }
        >
          {kind === "income"
            ? "Salaries end at retirement by default. Add your State Pension from pension age, any final-salary pension, and one-offs like an inheritance. Investment growth and rent are modelled elsewhere."
            : "Start with one “Living expenses” line for everything routine, then add big or time-limited costs separately: childcare, school fees, a replacement car every ten years. Mortgage payments come from your property, so leave them out."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((e, i) => {
            const yr = annual(e, plan.income);
            const pb = percentBonus(e);
            return (
              <li
                key={e.id}
                className={cn(
                  "group flex items-center gap-3 px-3 py-2 sm:px-4",
                  !e.enabled && "opacity-55",
                )}
              >
                <AppearanceDot
                  appearance={e.appearance}
                  fallbackIndex={i + (kind === "income" ? 0 : 3)}
                  size={24}
                  fallbackIcon={kind === "income" ? HandCoins : Receipt}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left pointer-coarse:min-h-11"
                  onClick={() => onOpen(e.id)}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium group-hover:text-accent">
                      {e.name || "Untitled"}
                    </span>
                    {kind === "expense" && "spendingType" in e && e.spendingType !== "essential" ? (
                      <Badge tone={e.spendingType === "not-spending" ? "neutral" : "ochre"}>
                        {e.spendingType === "hybrid"
                          ? "Partly flexible"
                          : e.spendingType === "discretionary"
                            ? "Flexible"
                            : "Not spending"}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="truncate text-[11.5px] text-ink-3">
                    {typeLabel(kind, e.type)} ·{" "}
                    {e.owner === JOINT
                      ? "Joint"
                      : (people.find((p) => p.id === e.owner)?.name ?? "—")}{" "}
                    · <span className="num">{when(e)}</span>
                  </div>
                </button>
                <div className="text-right">
                  <div className="num text-[13px]">
                    {pb ? (
                      <>
                        {fmtRate(pb.percentOfSalary.rate)}
                        <span className="text-ink-3">
                          {" "}
                          of{" "}
                          {plan.income.find((x) => x.id === pb.percentOfSalary.salaryIncomeId)
                            ?.name ?? "a missing salary"}
                        </span>
                      </>
                    ) : (
                      <>
                        {f.moneyIn(e.amount.value, e.currency ?? f.currency)}
                        <span className="text-ink-3"> {amountUnit(e) || "once"}</span>
                      </>
                    )}
                  </div>
                  <div className="num text-[11px] text-ink-3">
                    {yr !== null && (pb || e.frequency !== "yearly" || e.type === "hourly")
                      ? `${pb ? "≈ " : ""}${f.money(yr, true)}/yr`
                      : e.amount.basis === "nominal"
                        ? "future money"
                        : "today's money"}
                  </div>
                </div>
                <span className="hidden sm:inline-flex">
                  <Switch
                    size="sm"
                    aria-label={`${e.name} enabled`}
                    checked={e.enabled}
                    onCheckedChange={(enabled) =>
                      setItems(
                        (xs) => replaceById(xs, e.id, (x) => ({ ...x, enabled })),
                        enabled ? `Enable ${e.name}` : `Disable ${e.name}`,
                      )
                    }
                  />
                </span>
                <ActionMenu>
                  <ActionMenuTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={`Actions for ${e.name}`}
                    >
                      <MoreHorizontal />
                    </Button>
                  </ActionMenuTrigger>
                  <ActionMenuContent>
                    <ActionMenuItem onSelect={() => onOpen(e.id)}>Edit</ActionMenuItem>
                    <ActionMenuItem
                      onSelect={() =>
                        setItems(
                          (xs) => replaceById(xs, e.id, (x) => ({ ...x, enabled: !x.enabled })),
                          e.enabled ? `Disable ${e.name}` : `Enable ${e.name}`,
                        )
                      }
                    >
                      {e.enabled ? "Leave out of plan" : "Include in plan"}
                    </ActionMenuItem>
                    <ActionMenuItem
                      onSelect={() =>
                        setItems(
                          (xs) => [
                            ...xs,
                            {
                              ...structuredClone(e),
                              id: newId(kind === "income" ? "inc" : "exp"),
                              name: `${e.name} (copy)`,
                            },
                          ],
                          `Duplicate ${e.name}`,
                        )
                      }
                    >
                      <Copy /> Duplicate
                    </ActionMenuItem>
                    <ActionMenuSeparator />
                    <ActionMenuItem
                      tone="negative"
                      onSelect={() => {
                        setItems((xs) => xs.filter((x) => x.id !== e.id), `Delete ${e.name}`);
                        toast({ title: `Deleted ${e.name}`, description: "Undo with ⌘/Ctrl+Z." });
                      }}
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

// ------------------------------------------------------------------------------- sheet

export function EventSheet({
  kind,
  id,
  onClose,
}: {
  kind: Kind;
  id: string | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      {id ? <EventSheetBody kind={kind} id={id} onClose={onClose} /> : null}
    </Sheet>
  );
}

const INCOME_COMMON = [
  "id",
  "name",
  "owner",
  "amount",
  "frequency",
  "range",
  "change",
  "changeLimit",
  "growFromToday",
  "recurrence",
  "enabled",
  "notes",
  "appearance",
  "tax",
  "sendTo",
  "partTime",
  "currency",
  "inflationCategory",
] as const;
const EXPENSE_COMMON = [
  "id",
  "name",
  "owner",
  "amount",
  "frequency",
  "range",
  "change",
  "changeLimit",
  "growFromToday",
  "recurrence",
  "enabled",
  "notes",
  "appearance",
  "spendingType",
  "discretionaryShare",
  "payFrom",
  "tax",
  "dependentId",
  "currency",
  "inflationCategory",
] as const;

function EventSheetBody({ kind, id, onClose }: { kind: Kind; id: string; onClose: () => void }) {
  const plan = usePlan();
  const update = useUpdatePlan();
  const ctx = useCtx();
  const f = useFormat();
  const { tctx } = useScope();
  const draftCurrency = useEditorStore((s) => s.draft?.household.currency) ?? f.currency;
  const event = (kind === "income" ? plan?.income : plan?.expenses)?.find((e) => e.id === id) as
    | AnyEvent
    | undefined;
  const issues = useIssues(kind === "income" ? IncomeSchema : ExpenseSchema, event);
  const field = kind === "income" ? "income" : "expenses";
  if (!plan || !event || !ctx) return null;
  const set = (fn: (e: AnyEvent) => AnyEvent, label: string, key?: string) =>
    update(
      (p) => ({ ...p, [field]: replaceById(p[field] as AnyEvent[], id, fn) }) as Plan,
      label,
      key ? `${id}:${key}` : undefined,
    );
  const patch = (v: Partial<AnyEvent>, label: string, key?: string) =>
    set((e) => ({ ...e, ...v }) as AnyEvent, label, key);

  const changeType = (type: string) => {
    const fresh =
      kind === "income"
        ? newIncome(type as IncomeType, ctx, plan)
        : newExpense(type as ExpenseType, ctx, plan.assumptions.healthcareInflationPremium);
    const keep = Object.fromEntries(
      (kind === "income" ? INCOME_COMMON : EXPENSE_COMMON)
        .filter((k) => k in event)
        .map((k) => [k, (event as Record<string, unknown>)[k]]),
    );
    const schema = kind === "income" ? IncomeSchema : ExpenseSchema;
    const next = schema.safeParse({ ...fresh, ...keep, type });
    set(
      () => (next.success ? next.data : { ...fresh, id, name: event.name }) as AnyEvent,
      "Change type",
    );
  };

  const remove = async () => {
    const ok = await confirmAction({
      title: `Delete ${event.name || "this event"}?`,
      description: "You can undo this with ⌘/Ctrl+Z.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    onClose();
    update(
      (p) => ({ ...p, [field]: (p[field] as AnyEvent[]).filter((e) => e.id !== id) }) as Plan,
      `Delete ${event.name}`,
    );
  };

  const yr = annual(event, plan.income);
  const pb = percentBonus(event);
  const once = event.frequency === "once";
  const start = tctx ? resolveRef(event.range.start, tctx) : null;
  const end = tctx ? resolveRef(event.range.end, tctx) : null;
  const types = kind === "income" ? INCOME_TYPES : EXPENSE_TYPES;
  const careRise = isCareExpense(kind, event.type);
  const riseCategory = plan.assumptions.inflationCategories?.find(
    (c) => c.id === event.inflationCategory,
  );

  return (
    <SheetContent
      eyebrow={`${kind === "income" ? "Income" : "Expense"} · ${typeLabel(kind, event.type)}`}
      title={event.name || "Untitled"}
      description={
        start !== null && tctx
          ? once
            ? `Once, ${describeMonth(start, tctx, f.locale)}`
            : `${formatMonthIndex(start, f.locale)} → ${end === null ? "never ends" : formatMonthIndex(end, f.locale)}${yr ? ` · ${f.money(yr)} a year` : ""}`
          : "Timing resolves when simulated"
      }
      width={640}
      footer={
        <>
          <Button variant="ghost" size="sm" className="text-negative" onClick={remove}>
            <Trash2 /> Delete
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              update(
                (p) =>
                  ({
                    ...p,
                    [field]: [
                      ...(p[field] as AnyEvent[]),
                      {
                        ...structuredClone(event),
                        id: newId(kind === "income" ? "inc" : "exp"),
                        name: `${event.name} (copy)`,
                      },
                    ],
                  }) as Plan,
                `Duplicate ${event.name}`,
              );
              toast({ title: "Duplicated" });
            }}
          >
            <Copy /> Duplicate
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
                value={event.name}
                maxLength={120}
                onChange={(e) => patch({ name: e.target.value }, "Rename", "name")}
              />
            )}
          </FormField>
          <EnumField
            label="Type"
            value={event.type}
            onChange={changeType}
            options={types.map((t) => ({
              value: t.value,
              label: t.label,
              hint: t.countries?.join(", "),
            }))}
          />
          <FormField
            label="Owner"
            help="Who earns or pays it. Affects tax and what happens if one of you dies."
            error={issues.get("owner")}
          >
            {(fid) => (
              <OwnerSelect
                id={fid}
                value={event.owner}
                onChange={(owner) => patch({ owner }, "Change owner")}
              />
            )}
          </FormField>
          {kind === "expense" && ctx.household.dependents.length ? (
            <FormField
              label="For dependant"
              hint="Optional link for childcare and education timing."
            >
              {(fid) => (
                <Select
                  id={fid}
                  value={(event as ExpenseEvent).dependentId ?? "none"}
                  onValueChange={(v) =>
                    patch(
                      { dependentId: v === "none" ? undefined : v } as Partial<ExpenseEvent>,
                      "Link dependant",
                    )
                  }
                  options={[
                    { value: "none", label: "Nobody in particular" },
                    ...ctx.household.dependents.map((d) => ({ value: d.id, label: d.name })),
                  ]}
                />
              )}
            </FormField>
          ) : null}
        </FieldGrid>
        <SwitchField
          label="Included in the plan"
          hint="Switch off to see the plan without it, without deleting it."
          checked={event.enabled}
          onCheckedChange={(enabled) => patch({ enabled }, enabled ? "Enable" : "Disable")}
        />
      </FormSection>

      <FormSection title="Amount">
        {event.type === "bonus" ? (
          <BonusBasis
            event={event as Extract<IncomeEvent, { type: "bonus" }>}
            salaries={plan.income.filter((x) => x.type === "salary")}
            annualAmount={yr}
            set={set}
            error={issues.under("percentOfSalary")}
          />
        ) : null}
        <FieldGrid>
          {pb ? null : (
            <FormField
              label={event.type === "hourly" ? "Hourly rate" : "Amount"}
              help={HELP.basis}
              error={
                issues.under("amount") ??
                (event.amount.value < 0
                  ? kind === "income"
                    ? "Enter a positive amount. For money going out, add an expense instead."
                    : "Enter a positive amount. For money coming in, add an income instead."
                  : undefined)
              }
              hint={
                yr !== null && (event.frequency !== "yearly" || event.type === "hourly")
                  ? `≈ ${f.money(yr)} a year`
                  : undefined
              }
            >
              {(fid) => (
                <AmountInput
                  id={fid}
                  currency={event.currency}
                  value={event.amount}
                  onChange={(amount) => patch({ amount }, "Edit amount", "amount")}
                />
              )}
            </FormField>
          )}
          {event.type === "hourly" ? null : (
            <FormField label="How often" help={HELP.frequency}>
              {(fid) => (
                <FrequencySelect
                  id={fid}
                  value={event.frequency}
                  onChange={(frequency) =>
                    set(
                      (e) =>
                        ({
                          ...e,
                          frequency,
                          range:
                            frequency === "once"
                              ? { ...e.range, end: { kind: "never" } }
                              : e.range.end.kind === "never"
                                ? { ...e.range, end: { kind: "planEnd", offsetMonths: 0 } }
                                : e.range,
                        }) as AnyEvent,
                      "Change frequency",
                    )
                  }
                />
              )}
            </FormField>
          )}
          {event.type === "hourly" ? (
            <FormField label="Hours per week" error={issues.get("hoursPerWeek")}>
              {(fid) => (
                <NumberInput
                  id={fid}
                  decimals={1}
                  suffix="h"
                  value={(event as Extract<IncomeEvent, { type: "hourly" }>).hoursPerWeek}
                  onValueChange={(v) =>
                    set((e) => ({ ...e, hoursPerWeek: v ?? 0 }) as AnyEvent, "Edit hours", "hours")
                  }
                />
              )}
            </FormField>
          ) : null}
        </FieldGrid>
        {pb ? null : (
          <FieldGrid>
            <FormField
              label="Currency"
              hint={
                event.currency
                  ? `Paid in ${event.currency}; converted to ${draftCurrency} at the rate for the month it is valued.`
                  : undefined
              }
            >
              {(fid) => (
                <CurrencySelect
                  id={fid}
                  value={event.currency}
                  base={draftCurrency}
                  onChange={(currency) => patch({ currency }, "Change currency")}
                />
              )}
            </FormField>
            {!once ? (
              <FormField
                label="Rises with"
                hint={
                  careRise
                    ? careRiseHint(event.change, riseCategory)
                    : (plan.assumptions.inflationCategories?.length ?? 0) === 0
                      ? "Add healthcare, education or housing inflation in Assumptions to choose one here."
                      : "Used when it changes with inflation, and for its today’s-money value."
                }
              >
                {(fid) => (
                  <div className="flex flex-col gap-2">
                    <InflationCategorySelect
                      id={fid}
                      value={event.inflationCategory}
                      onChange={(inflationCategory) =>
                        patch({ inflationCategory }, "Change inflation category")
                      }
                    />
                    {careRise && event.change.kind === "inflation" ? (
                      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
                        <span>Above that</span>
                        <PercentInput
                          aria-label="Rises above inflation"
                          className="w-[110px]"
                          value={event.change.plus}
                          onValueChange={(v) =>
                            patch(
                              { change: { kind: "inflation", plus: v ?? 0 } },
                              "Edit rise above inflation",
                              "change",
                            )
                          }
                          prefix={event.change.plus >= 0 ? "+" : undefined}
                        />
                        <span>a year</span>
                      </div>
                    ) : null}
                  </div>
                )}
              </FormField>
            ) : null}
          </FieldGrid>
        )}
        {event.amount.basis === "real" ? (
          <SwitchField
            label="Grow from today"
            hint={HELP.growFromToday}
            checked={event.growFromToday}
            onCheckedChange={(growFromToday) => patch({ growFromToday }, "Toggle grow from today")}
          />
        ) : null}
      </FormSection>

      <FormSection title={once ? "When" : "When it runs"}>
        <DateRefField
          label={once ? "Happens" : "Starts"}
          value={event.range.start}
          allowNever={false}
          error={issues.under("range.start")}
          onChange={(s) =>
            set((e) => ({ ...e, range: { ...e.range, start: s } }) as AnyEvent, "Edit start")
          }
        />
        {!once ? (
          <>
            <DateRefField
              label="Ends"
              help={HELP.endExclusive}
              value={event.range.end}
              error={issues.under("range.end")}
              onChange={(en) =>
                set((e) => ({ ...e, range: { ...e.range, end: en } }) as AnyEvent, "Edit end")
              }
            />
            <SwitchField
              label="Include the end month"
              checked={event.range.endInclusive}
              onCheckedChange={(endInclusive) =>
                set(
                  (e) => ({ ...e, range: { ...e.range, endInclusive } }) as AnyEvent,
                  "Toggle end month",
                )
              }
            />
          </>
        ) : null}
        {start !== null && end !== null && end <= start && !once ? (
          <p className="text-[12px] text-warning">Ends before it starts, so it never runs.</p>
        ) : null}
      </FormSection>

      {kind === "expense" ? (
        <SpendingSection event={event as ExpenseEvent} patch={patch} issues={issues} />
      ) : null}

      {!once ? (
        <FormSection title="Change over time">
          <ChangeEditor
            help={HELP.change}
            value={event.change}
            inflationPlusElsewhere={careRise}
            onChange={(change) => patch({ change }, "Edit change over time", "change")}
          />
          <LimitEditor event={event} patch={patch} />
        </FormSection>
      ) : null}

      {kind === "income" ? (
        <>
          <IncomeSpecific event={event as IncomeEvent} set={set} issues={issues} />
          <IncomeCrossBorder
            event={event as IncomeEvent}
            patch={(v, l, k) => patch(v as Partial<AnyEvent>, l, k)}
          />
        </>
      ) : (
        <ExpenseSpecific event={event as ExpenseEvent} set={set} />
      )}

      <FormSection title="Repeat">
        <SwitchField
          label="Repeat this event"
          hint="E.g. a new car every 8 years, getting a little more expensive each time."
          checked={!!event.recurrence}
          onCheckedChange={(on) =>
            patch(
              {
                recurrence: on
                  ? {
                      yearsBetween: 8,
                      scalingRate: 0,
                      until: { kind: "planEnd", offsetMonths: 0 },
                      keepLast: false,
                    }
                  : undefined,
              },
              on ? "Add repeat" : "Remove repeat",
            )
          }
        />
        {event.recurrence ? (
          <>
            <FieldGrid>
              <FormField label="Years between" error={issues.get("recurrence.yearsBetween")}>
                {(fid) => (
                  <NumberInput
                    id={fid}
                    decimals={1}
                    suffix="yrs"
                    value={event.recurrence!.yearsBetween}
                    onValueChange={(v) =>
                      patch(
                        { recurrence: { ...event.recurrence!, yearsBetween: v ?? 0 } },
                        "Edit repeat",
                        "rep",
                      )
                    }
                  />
                )}
              </FormField>
              <FormField
                label="Extra growth each time"
                help="On top of the event’s own change over time."
              >
                {(fid) => (
                  <PercentInput
                    id={fid}
                    value={event.recurrence!.scalingRate}
                    onValueChange={(v) =>
                      patch(
                        { recurrence: { ...event.recurrence!, scalingRate: v ?? 0 } },
                        "Edit repeat",
                        "rep",
                      )
                    }
                  />
                )}
              </FormField>
            </FieldGrid>
            <DateRefField
              label="Repeat until"
              value={event.recurrence.until}
              onChange={(until) =>
                patch({ recurrence: { ...event.recurrence!, until } }, "Edit repeat")
              }
            />
          </>
        ) : null}
      </FormSection>

      {kind === "income" ? (
        <IncomeTax event={event as IncomeEvent} set={set} />
      ) : (
        <ExpenseTax event={event as ExpenseEvent} set={set} />
      )}

      <FormSection title="Notes & appearance">
        <Textarea
          aria-label="Notes"
          value={event.notes ?? ""}
          onChange={(e) => patch({ notes: e.target.value || undefined }, "Edit notes", "notes")}
          placeholder="Why this number? Where did it come from?"
        />
        <AppearancePicker
          value={event.appearance}
          onChange={(appearance) => patch({ appearance }, "Change appearance")}
        />
      </FormSection>
    </SheetContent>
  );
}

function LimitEditor({
  event,
  patch,
}: {
  event: AnyEvent;
  patch: (v: Partial<AnyEvent>, l: string, k?: string) => void;
}) {
  const lim = event.changeLimit;
  return (
    <>
      <SwitchField
        label="Cap or floor the amount"
        hint="Stop it growing past a maximum, or falling below a minimum."
        checked={!!lim}
        onCheckedChange={(on) =>
          patch(
            { changeLimit: on ? { basis: "real" } : undefined },
            on ? "Add limit" : "Remove limit",
          )
        }
      />
      {lim ? (
        <FieldGrid cols={3}>
          <FormField label="Maximum">
            {(fid) => (
              <CurrencyInput
                id={fid}
                value={lim.max ?? null}
                onValueChange={(v) =>
                  patch({ changeLimit: { ...lim, max: v ?? undefined } }, "Edit limit", "lim")
                }
              />
            )}
          </FormField>
          <FormField label="Minimum">
            {(fid) => (
              <CurrencyInput
                id={fid}
                value={lim.min ?? null}
                onValueChange={(v) =>
                  patch({ changeLimit: { ...lim, min: v ?? undefined } }, "Edit limit", "lim")
                }
              />
            )}
          </FormField>
          <EnumField<"real" | "nominal">
            label="In"
            value={lim.basis}
            onChange={(basis) => patch({ changeLimit: { ...lim, basis } }, "Edit limit")}
            options={[
              { value: "real", label: "Today's money" },
              { value: "nominal", label: "Future money" },
            ]}
          />
        </FieldGrid>
      ) : null}
    </>
  );
}

function SpendingSection({
  event,
  patch,
  issues,
}: {
  event: ExpenseEvent;
  patch: (v: Partial<AnyEvent>, l: string, k?: string) => void;
  issues: Issues;
}) {
  return (
    <FormSection title="Flexibility">
      <FormField label="Kind of spending" help={HELP.spendingType}>
        {() => (
          <Segmented<ExpenseEvent["spendingType"]>
            aria-label="Kind of spending"
            size="sm"
            value={event.spendingType}
            onChange={(spendingType) =>
              patch(
                {
                  spendingType,
                  discretionaryShare:
                    spendingType === "hybrid" ? (event.discretionaryShare ?? 0.5) : undefined,
                } as Partial<ExpenseEvent>,
                "Change flexibility",
              )
            }
            options={[
              { value: "essential", label: "Essential" },
              { value: "hybrid", label: "Partly flexible" },
              { value: "discretionary", label: "Flexible" },
              { value: "not-spending", label: "Not spending" },
            ]}
          />
        )}
      </FormField>
      {event.spendingType === "hybrid" ? (
        <FormField
          label="Flexible share"
          hint="The part that can be cut in a lean year."
          error={issues.get("discretionaryShare")}
        >
          {(fid) => (
            <PercentInput
              id={fid}
              className="w-[120px]"
              value={event.discretionaryShare ?? 0.5}
              onValueChange={(v) =>
                patch(
                  { discretionaryShare: v ?? 0 } as Partial<ExpenseEvent>,
                  "Edit flexible share",
                  "disc",
                )
              }
            />
          )}
        </FormField>
      ) : null}
      <AccountRoutingEditor
        label="Paid from"
        help={HELP.payFrom}
        autoLabel="Automatic"
        value={event.payFrom}
        error={issues.under("payFrom")}
        onChange={(payFrom) => patch({ payFrom } as Partial<ExpenseEvent>, "Edit paid from")}
      />
    </FormSection>
  );
}

const fmtRate = (r: number) => `${Number((r * 100).toFixed(2))}%`;

/**
 * A bonus's amount: a fixed amount, or a share of one of the plan's salaries. The engine takes the
 * share of that salary's pay each year (after its growth; nothing in a year without the salary).
 */
function BonusBasis({
  event,
  salaries,
  annualAmount,
  set,
  error,
}: {
  event: Extract<IncomeEvent, { type: "bonus" }>;
  salaries: IncomeEvent[];
  annualAmount: number | null;
  set: (fn: (e: AnyEvent) => AnyEvent, l: string, k?: string) => void;
  error?: string;
}) {
  const f = useFormat();
  const link = event.percentOfSalary;
  const mode = link ? "percent" : "fixed";
  const setLink = (next: typeof link, label: string, key?: string) =>
    set((e) => ({ ...e, percentOfSalary: next }) as AnyEvent, label, key);
  return (
    <>
      <EnumField<"fixed" | "percent">
        label="Amount"
        value={mode}
        onChange={(m) => {
          if (m === "fixed") setLink(undefined, "Fixed bonus");
          else if (salaries[0])
            setLink(
              { salaryIncomeId: salaries[0].id, rate: link?.rate ?? 0.1 },
              "Bonus as % of salary",
            );
        }}
        options={[
          { value: "fixed", label: "Fixed amount" },
          { value: "percent", label: "% of salary" },
        ]}
        hint={
          mode === "percent" && salaries.length === 0
            ? "Add a salary first: the bonus is a share of one."
            : undefined
        }
      />
      {link ? (
        <FieldGrid>
          <FormField
            label="Salary"
            error={error}
            hint="Each year the bonus is this share of the salary paid that year, after its growth. No salary that year, no bonus."
          >
            {(fid) => (
              <Select
                id={fid}
                value={link.salaryIncomeId}
                placeholder="Choose a salary"
                onValueChange={(salaryIncomeId) =>
                  setLink({ ...link, salaryIncomeId }, "Link bonus to salary")
                }
                options={salaries.map((x) => ({ value: x.id, label: x.name || "Untitled" }))}
              />
            )}
          </FormField>
          <FormField
            label="Share of salary"
            hint={annualAmount !== null ? `≈ ${f.money(annualAmount)} a year today` : undefined}
          >
            {(fid) => (
              <PercentInput
                id={fid}
                className="w-[120px]"
                value={link.rate}
                onValueChange={(v) =>
                  setLink({ ...link, rate: Math.max(0, v ?? 0) }, "Edit bonus share", "bonus-rate")
                }
              />
            )}
          </FormField>
        </FieldGrid>
      ) : null}
    </>
  );
}

function IncomeSpecific({
  event,
  set,
  issues,
}: {
  event: IncomeEvent;
  set: (fn: (e: AnyEvent) => AnyEvent, l: string, k?: string) => void;
  issues: Issues;
}) {
  const { people, accounts } = useScope();
  const plan = usePlan();
  const s = (v: Record<string, unknown>, label: string, key?: string) =>
    set((e) => ({ ...e, ...v }) as AnyEvent, label, key);
  const parts: ReactNode[] = [];
  if (
    event.type === "salary" ||
    event.type === "hourly" ||
    event.type === "self-employment" ||
    event.type === "other"
  ) {
    parts.push(
      <FormSection key="pt" title="Part-time">
        <SwitchField
          label="Go part-time for a while"
          hint={HELP.partTime}
          checked={!!event.partTime}
          onCheckedChange={(on) =>
            s(
              {
                partTime: on
                  ? {
                      range: {
                        start: {
                          kind: "age",
                          personId: event.owner === JOINT ? people[0]!.id : event.owner,
                          age: 55,
                          offsetMonths: 0,
                        },
                        end: event.range.end,
                        endInclusive: false,
                      },
                      share: 0.6,
                    }
                  : undefined,
              },
              on ? "Add part-time" : "Remove part-time",
            )
          }
        />
        {event.partTime ? (
          <>
            <FormField label="Share of full pay" error={issues.get("partTime.share")}>
              {(fid) => (
                <PercentInput
                  id={fid}
                  className="w-[120px]"
                  value={event.partTime!.share}
                  onValueChange={(v) =>
                    s({ partTime: { ...event.partTime!, share: v ?? 0 } }, "Edit part-time", "pt")
                  }
                />
              )}
            </FormField>
            <DateRefField
              label="Part-time from"
              value={event.partTime.range.start}
              allowNever={false}
              onChange={(start) =>
                s(
                  { partTime: { ...event.partTime!, range: { ...event.partTime!.range, start } } },
                  "Edit part-time",
                )
              }
            />
            <DateRefField
              label="Part-time until"
              value={event.partTime.range.end}
              onChange={(end) =>
                s(
                  { partTime: { ...event.partTime!, range: { ...event.partTime!.range, end } } },
                  "Edit part-time",
                )
              }
            />
          </>
        ) : null}
      </FormSection>,
    );
  }
  if (event.type === "salary" || event.type === "hourly") {
    const pen = event.pension;
    parts.push(
      <FormSection
        key="db"
        title="Defined-benefit pension"
        description="A final-salary or career-average scheme you build up while working."
      >
        <SwitchField
          label="This job has a DB pension"
          checked={!!pen}
          onCheckedChange={(on) =>
            s(
              {
                pension: on
                  ? {
                      employeeContribution: { kind: "percentOfPay", rate: 0.06 },
                      contributionsReduceTaxableIncome: true,
                      payouts: {
                        start: {
                          kind: "age",
                          personId: event.owner === JOINT ? people[0]!.id : event.owner,
                          age: 67,
                          offsetMonths: 0,
                        },
                        end: { kind: "planEnd", offsetMonths: 0 },
                        endInclusive: false,
                      },
                      payout: { kind: "percentOfCareerAverage", rate: 0.016 },
                      payoutsTaxFree: false,
                      payoutChange: { kind: "inflation", plus: 0 },
                    }
                  : undefined,
              },
              on ? "Add DB pension" : "Remove DB pension",
            )
          }
        />
        {pen ? (
          <div className="grid gap-3 rounded-lg border border-border p-3">
            <FieldGrid>
              <EnumField<"percentOfPay" | "amount">
                label="You contribute"
                value={pen.employeeContribution.kind}
                onChange={(k) =>
                  s(
                    {
                      pension: {
                        ...pen,
                        employeeContribution:
                          k === "amount"
                            ? { kind: "amount", amount: { value: 2000, basis: "real" } }
                            : { kind: "percentOfPay", rate: 0.06 },
                      },
                    },
                    "Edit DB pension",
                  )
                }
                options={[
                  { value: "percentOfPay", label: "% of pay" },
                  { value: "amount", label: "Fixed amount / yr" },
                ]}
              />
              {pen.employeeContribution.kind === "percentOfPay" ? (
                <FormField label="Contribution rate">
                  {(fid) => (
                    <PercentInput
                      id={fid}
                      value={
                        pen.employeeContribution.kind === "percentOfPay"
                          ? pen.employeeContribution.rate
                          : 0
                      }
                      onValueChange={(v) =>
                        s(
                          {
                            pension: {
                              ...pen,
                              employeeContribution: { kind: "percentOfPay", rate: v ?? 0 },
                            },
                          },
                          "Edit DB pension",
                          "dbc",
                        )
                      }
                    />
                  )}
                </FormField>
              ) : (
                <FormField label="Contribution">
                  {(fid) => (
                    <AmountInput
                      id={fid}
                      value={
                        (
                          pen.employeeContribution as {
                            amount: { value: number; basis: "real" | "nominal" };
                          }
                        ).amount
                      }
                      onChange={(amount) =>
                        s(
                          { pension: { ...pen, employeeContribution: { kind: "amount", amount } } },
                          "Edit DB pension",
                          "dbc",
                        )
                      }
                    />
                  )}
                </FormField>
              )}
              <EnumField<"percentOfFinalPay" | "percentOfCareerAverage" | "amount">
                label="Pension paid"
                help="Accrual rate per year of service: 1/60th ≈ 1.67%, 1/80th = 1.25%."
                value={pen.payout.kind}
                onChange={(k) =>
                  s(
                    {
                      pension: {
                        ...pen,
                        payout:
                          k === "amount"
                            ? { kind: "amount", amount: { value: 10_000, basis: "real" } }
                            : { kind: k, rate: 0.016 },
                      },
                    },
                    "Edit DB pension",
                  )
                }
                options={[
                  { value: "percentOfCareerAverage", label: "% of career-average pay" },
                  { value: "percentOfFinalPay", label: "% of final pay" },
                  { value: "amount", label: "Fixed amount / yr" },
                ]}
              />
              {pen.payout.kind === "amount" ? (
                <FormField label="Pension per year">
                  {(fid) => (
                    <AmountInput
                      id={fid}
                      value={
                        pen.payout.kind === "amount"
                          ? pen.payout.amount
                          : { value: 0, basis: "real" }
                      }
                      onChange={(amount) =>
                        s(
                          { pension: { ...pen, payout: { kind: "amount", amount } } },
                          "Edit DB pension",
                          "dbp",
                        )
                      }
                    />
                  )}
                </FormField>
              ) : (
                <FormField label="Rate">
                  {(fid) => (
                    <PercentInput
                      id={fid}
                      decimals={3}
                      value={pen.payout.kind !== "amount" ? pen.payout.rate : 0}
                      onValueChange={(v) =>
                        s(
                          {
                            pension: {
                              ...pen,
                              payout: {
                                kind: (pen.payout as { kind: "percentOfFinalPay" }).kind,
                                rate: v ?? 0,
                              },
                            },
                          },
                          "Edit DB pension",
                          "dbp",
                        )
                      }
                    />
                  )}
                </FormField>
              )}
            </FieldGrid>
            <DateRefField
              label="Pension starts"
              value={pen.payouts.start}
              allowNever={false}
              onChange={(start) =>
                s({ pension: { ...pen, payouts: { ...pen.payouts, start } } }, "Edit DB pension")
              }
            />
            <DateRefField
              label="Pension ends"
              value={pen.payouts.end}
              onChange={(end) =>
                s({ pension: { ...pen, payouts: { ...pen.payouts, end } } }, "Edit DB pension")
              }
            />
            <ChangeEditor
              label="Pension increases"
              value={pen.payoutChange}
              onChange={(payoutChange) =>
                s({ pension: { ...pen, payoutChange } }, "Edit DB pension", "dbchg")
              }
            />
            <SwitchField
              label="Contributions reduce taxable pay"
              checked={pen.contributionsReduceTaxableIncome}
              onCheckedChange={(v) =>
                s({ pension: { ...pen, contributionsReduceTaxableIncome: v } }, "Edit DB pension")
              }
            />
            <SwitchField
              label="Pension is tax-free"
              checked={pen.payoutsTaxFree}
              onCheckedChange={(v) =>
                s({ pension: { ...pen, payoutsTaxFree: v } }, "Edit DB pension")
              }
            />
          </div>
        ) : null}
      </FormSection>,
    );
  }
  if (event.type === "rsu") {
    parts.push(
      <FormSection
        key="rsu"
        title="Vesting"
        description="Amounts vesting at each point (in the amount’s basis). Overrides the amount and frequency above."
      >
        <SchedulePointsEditor
          points={event.vesting}
          onChange={(vesting) => s({ vesting }, "Edit vesting", "vest")}
          getValue={(p) => p.value}
          setValue={(p, v) => ({ ...p, value: v })}
          kind="money"
          label="Vest"
          make={() => ({
            at: { kind: "planStart", offsetMonths: 12 * (event.vesting.length + 1) },
            value: 10_000,
          })}
        />
        <FormField label="Shares go to" hint="Optional: an account that receives vested shares.">
          {(fid) => (
            <Select
              id={fid}
              value={event.destinationAccountId ?? "none"}
              onValueChange={(v) =>
                s({ destinationAccountId: v === "none" ? undefined : v }, "Edit RSU destination")
              }
              options={[
                { value: "none", label: "Cash flow" },
                ...accounts.map((a) => ({ value: a.id, label: a.name })),
              ]}
            />
          )}
        </FormField>
      </FormSection>,
    );
  }
  if (event.type === "social-security") {
    const est = event.estimate;
    parts.push(
      <FormSection key="ss" title="Social Security">
        <Segmented<"amount" | "estimate">
          aria-label="Benefit"
          size="sm"
          value={event.mode}
          onChange={(mode) =>
            s(
              {
                mode,
                estimate:
                  mode === "estimate"
                    ? (est ?? {
                        pia: 2000,
                        claimAge: 67,
                        includePlannedEarnings: true,
                        expectedShare: 1,
                        priorCoveredEarnings: [],
                        spousal: true,
                        survivor: true,
                      })
                    : est,
              },
              "Change benefit mode",
            )
          }
          options={[
            { value: "amount", label: "Enter amount" },
            { value: "estimate", label: "Estimate from PIA" },
          ]}
        />
        {event.mode === "estimate" && est ? (
          <FieldGrid>
            <FormField
              label="PIA (monthly at FRA)"
              help="Primary insurance amount from your SSA statement, in today's money."
            >
              {(fid) => (
                <CurrencyInput
                  id={fid}
                  value={est.pia}
                  onValueChange={(v) =>
                    s({ estimate: { ...est, pia: Math.max(0, v ?? 0) } }, "Edit PIA", "pia")
                  }
                />
              )}
            </FormField>
            <FormField label="Claim at age" error={issues.get("estimate.claimAge")}>
              {(fid) => (
                <NumberInput
                  id={fid}
                  decimals={1}
                  suffix="yrs"
                  value={est.claimAge}
                  onValueChange={(v) =>
                    s({ estimate: { ...est, claimAge: v ?? 67 } }, "Edit claim age", "claim")
                  }
                />
              )}
            </FormField>
            <FormField label="Expected share" help="Haircut for possible future benefit cuts.">
              {(fid) => (
                <PercentInput
                  id={fid}
                  value={est.expectedShare}
                  onValueChange={(v) =>
                    s({ estimate: { ...est, expectedShare: v ?? 1 } }, "Edit share", "share")
                  }
                />
              )}
            </FormField>
            <FormField label="Full retirement age" hint="Blank = from birth year.">
              {(fid) => (
                <NumberInput
                  id={fid}
                  decimals={1}
                  value={est.fullRetirementAge ?? null}
                  onValueChange={(v) =>
                    s(
                      { estimate: { ...est, fullRetirementAge: v ?? undefined } },
                      "Edit FRA",
                      "fra",
                    )
                  }
                />
              )}
            </FormField>
            <SwitchField
              label="Include planned earnings"
              checked={est.includePlannedEarnings}
              onCheckedChange={(v) =>
                s({ estimate: { ...est, includePlannedEarnings: v } }, "Edit estimate")
              }
            />
            <SwitchField
              label="Spousal benefits"
              checked={est.spousal}
              onCheckedChange={(v) => s({ estimate: { ...est, spousal: v } }, "Edit estimate")}
            />
            <SwitchField
              label="Survivor benefits"
              checked={est.survivor}
              onCheckedChange={(v) => s({ estimate: { ...est, survivor: v } }, "Edit estimate")}
            />
          </FieldGrid>
        ) : null}
      </FormSection>,
    );
  }
  if (event.type === "state-pension") {
    parts.push(
      <FormSection
        key="sp"
        title="State Pension"
        description="The UK full new State Pension is £230.25 a week in 2025/26 (£11,973 a year). Check your own forecast on GOV.UK."
      >
        <SwitchField
          label="Triple lock"
          hint="Rises each year by the highest of inflation, earnings growth or a floor. Overrides “Change over time”."
          checked={!!event.tripleLock}
          onCheckedChange={(on) =>
            s(
              { tripleLock: on ? { earningsPremium: 0.01, floor: 0.025 } : undefined },
              on ? "Use triple lock" : "Remove triple lock",
            )
          }
        />
        <FieldGrid>
          <EnumField<"auto" | "none" | "rate">
            label="If it starts after State Pension age"
            help="Deferring the new State Pension raises it by 1% for every 9 weeks (about 5.8% a year), if deferred at least 9 weeks. Enter the full amount you would get at State Pension age."
            value={event.deferral?.kind ?? "auto"}
            onChange={(k) =>
              s(
                {
                  deferral:
                    k === "auto"
                      ? undefined
                      : k === "none"
                        ? { kind: "none" }
                        : {
                            kind: "rate",
                            ratePerYear:
                              event.deferral?.kind === "rate" ? event.deferral.ratePerYear : 0.058,
                          },
                },
                "Edit State Pension deferral",
              )
            }
            options={[
              { value: "auto", label: "UK deferral uplift (automatic)" },
              { value: "none", label: "No uplift" },
              { value: "rate", label: "My own uplift per year" },
            ]}
          />
          {event.deferral?.kind === "rate" ? (
            <FormField label="Uplift per year deferred">
              {(fid) => (
                <PercentInput
                  id={fid}
                  value={event.deferral?.kind === "rate" ? event.deferral.ratePerYear : 0}
                  onValueChange={(v) =>
                    s(
                      { deferral: { kind: "rate", ratePerYear: Math.max(0, v ?? 0) } },
                      "Edit deferral uplift",
                      "defr",
                    )
                  }
                />
              )}
            </FormField>
          ) : null}
        </FieldGrid>
        {event.tripleLock ? (
          <FieldGrid>
            <FormField label="Earnings growth above inflation">
              {(fid) => (
                <PercentInput
                  id={fid}
                  value={event.tripleLock!.earningsPremium}
                  onValueChange={(v) =>
                    s(
                      { tripleLock: { ...event.tripleLock!, earningsPremium: v ?? 0 } },
                      "Edit triple lock",
                      "tl",
                    )
                  }
                />
              )}
            </FormField>
            <FormField label="Minimum rise">
              {(fid) => (
                <PercentInput
                  id={fid}
                  value={event.tripleLock!.floor}
                  onValueChange={(v) =>
                    s(
                      { tripleLock: { ...event.tripleLock!, floor: v ?? 0 } },
                      "Edit triple lock",
                      "tlf",
                    )
                  }
                />
              )}
            </FormField>
          </FieldGrid>
        ) : null}
      </FormSection>,
    );
  }
  if (event.type === "annuity") {
    parts.push(
      <FormSection key="ann" title="Annuity">
        <FormField label="Bought with" hint="Optional: the one-off expense that pays for it.">
          {(fid) => (
            <Select
              id={fid}
              value={event.purchaseExpenseId ?? "none"}
              onValueChange={(v) =>
                s({ purchaseExpenseId: v === "none" ? undefined : v }, "Link annuity purchase")
              }
              options={[
                { value: "none", label: "Not linked" },
                ...(plan?.expenses ?? []).map((e) => ({ value: e.id, label: e.name })),
              ]}
            />
          )}
        </FormField>
      </FormSection>,
    );
  }
  if (
    people.length > 1 &&
    ["pension", "annuity", "state-pension", "social-security", "ca-cpp", "other"].includes(
      event.type,
    )
  ) {
    parts.push(
      <FormSection key="surv" title="If the owner dies first">
        <FormField
          label="Share that continues to the partner"
          help="E.g. 50% for a typical DB spouse’s pension or joint-life annuity. Blank = stops."
        >
          {(fid) => (
            <PercentInput
              id={fid}
              className="w-[120px]"
              value={event.survivorShare ?? null}
              onValueChange={(v) =>
                s({ survivorShare: v ?? undefined }, "Edit survivor share", "surv")
              }
            />
          )}
        </FormField>
      </FormSection>,
    );
  }
  if (event.type === "ca-cpp") {
    parts.push(
      <FormSection key="cpp" title="CPP">
        <SwitchField
          label="Survivor benefit"
          checked={event.survivor}
          onCheckedChange={(v) => s({ survivor: v }, "Edit CPP")}
        />
      </FormSection>,
    );
  }
  return <>{parts}</>;
}

/**
 * ACA household size: "Automatic" follows the tax household each year (the adults on the return
 * plus the dependants still dependent that year; the engine's rule, shown in each year's detail),
 * "Set manually" fixes a number for every year.
 */
function AcaHouseholdSizeField({
  value,
  onChange,
}: {
  value: AcaHouseholdSize;
  onChange: (v: AcaHouseholdSize) => void;
}) {
  const { people, dependents = [], tctx } = useScope();
  const start = tctx?.start;
  const depsNow =
    start === undefined ? [] : dependents.filter((d) => isDependentInPeriod(d, start, start + 12));
  const estimate = people.length + depsNow.length;
  const auto = value === "auto";
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    <FormField
      label="Household size"
      help="For the federal poverty line. Automatic counts the living adults on your tax return plus each dependant from birth until their “independent at” age (set in About you), year by year. Each year's detail shows the size used."
      hint={
        auto
          ? `About ${estimate} now: ${plural(people.length, "adult", "adults")}, ${plural(depsNow.length, "dependant", "dependants")}. Changes as dependants are born or become independent.`
          : "Used for every year of the plan."
      }
      className="sm:col-span-2"
    >
      {(fid) => (
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<"auto" | "manual">
            aria-label="Household size"
            size="sm"
            value={auto ? "auto" : "manual"}
            onChange={(mode) => onChange(mode === "auto" ? "auto" : Math.max(1, estimate))}
            options={[
              { value: "auto", label: "Automatic" },
              { value: "manual", label: "Set manually" },
            ]}
          />
          {auto ? null : (
            <NumberInput
              id={fid}
              aria-label="Household size (people)"
              decimals={0}
              value={value}
              onValueChange={(v) => onChange(Math.min(20, Math.max(1, Math.round(v ?? 1))))}
              className="w-[96px]"
              suffix="people"
            />
          )}
        </div>
      )}
    </FormField>
  );
}

function ExpenseSpecific({
  event,
  set,
}: {
  event: ExpenseEvent;
  set: (fn: (e: AnyEvent) => AnyEvent, l: string, k?: string) => void;
}) {
  const { people, accounts } = useScope();
  const s = (v: Record<string, unknown>, label: string, key?: string) =>
    set((e) => ({ ...e, ...v }) as AnyEvent, label, key);
  if (event.type === "healthcare") {
    const h = event.healthcare;
    return (
      <FormSection title="Healthcare cover">
        <Segmented<"standard" | "aca" | "medicare">
          aria-label="Healthcare cover"
          size="sm"
          value={h.kind}
          onChange={(k) =>
            s(
              {
                healthcare:
                  k === "standard"
                    ? { kind: "standard" }
                    : k === "aca"
                      ? {
                          kind: "aca",
                          benchmarkPremium: { value: 600, basis: "real" },
                          householdSize: "auto",
                          advanceCreditShare: 1,
                        }
                      : {
                          kind: "medicare",
                          personId: people[0]!.id,
                          supplemental: { kind: "none" },
                        },
              },
              "Change cover",
            )
          }
          options={[
            { value: "standard", label: "Standard / private" },
            { value: "aca", label: "ACA (US)" },
            { value: "medicare", label: "Medicare (US)" },
          ]}
        />
        {h.kind === "aca" ? (
          <FieldGrid>
            <FormField label="Benchmark premium (monthly)">
              {(fid) => (
                <AmountInput
                  id={fid}
                  value={h.benchmarkPremium}
                  onChange={(benchmarkPremium) =>
                    s({ healthcare: { ...h, benchmarkPremium } }, "Edit ACA", "aca")
                  }
                />
              )}
            </FormField>
            <AcaHouseholdSizeField
              value={h.householdSize}
              onChange={(householdSize) =>
                s({ healthcare: { ...h, householdSize } }, "Edit ACA household size", "acas")
              }
            />
            <FormField label="Advance credit taken">
              {(fid) => (
                <PercentInput
                  id={fid}
                  value={h.advanceCreditShare}
                  onValueChange={(v) =>
                    s({ healthcare: { ...h, advanceCreditShare: v ?? 1 } }, "Edit ACA", "acac")
                  }
                />
              )}
            </FormField>
          </FieldGrid>
        ) : h.kind === "medicare" ? (
          <FieldGrid>
            <EnumField
              label="For"
              value={h.personId}
              onChange={(personId) => s({ healthcare: { ...h, personId } }, "Edit Medicare")}
              options={people.map((p) => ({ value: p.id, label: p.name }))}
            />
            <FormField label="Part B (monthly)" hint="Blank = standard premium.">
              {(fid) => (
                <CurrencyInput
                  id={fid}
                  value={h.partB?.value ?? null}
                  onValueChange={(v) =>
                    s(
                      {
                        healthcare: {
                          ...h,
                          partB: v === null ? undefined : { value: v, basis: "real" },
                        },
                      },
                      "Edit Medicare",
                      "b",
                    )
                  }
                />
              )}
            </FormField>
            <FormField label="Part D (monthly)">
              {(fid) => (
                <CurrencyInput
                  id={fid}
                  value={h.partD?.value ?? null}
                  onValueChange={(v) =>
                    s(
                      {
                        healthcare: {
                          ...h,
                          partD: v === null ? undefined : { value: v, basis: "real" },
                        },
                      },
                      "Edit Medicare",
                      "d",
                    )
                  }
                />
              )}
            </FormField>
            <EnumField<"none" | "medigap" | "advantage">
              label="Supplemental"
              value={h.supplemental.kind}
              onChange={(k) =>
                s(
                  {
                    healthcare: {
                      ...h,
                      supplemental:
                        k === "none"
                          ? { kind: "none" }
                          : { kind: k, premium: { value: 150, basis: "real" } },
                    },
                  },
                  "Edit Medicare",
                )
              }
              options={[
                { value: "none", label: "None" },
                { value: "medigap", label: "Medigap" },
                { value: "advantage", label: "Medicare Advantage" },
              ]}
            />
          </FieldGrid>
        ) : (
          <p className="text-[12px] text-ink-3">
            The rate next to Rises with is what the projection grows this cost by, above the
            inflation selected there. A new cost starts at the plan’s healthcare premium.
          </p>
        )}
      </FormSection>
    );
  }
  if (event.type === "charity") {
    const c = event.charity ?? { vehicle: "cash" as const, carryforward: true };
    return (
      <FormSection title="Giving">
        <EnumField<"cash" | "qcd" | "daf">
          label="How you give"
          value={c.vehicle}
          onChange={(vehicle) => s({ charity: { ...c, vehicle } }, "Edit giving")}
          options={[
            { value: "cash", label: "Cash (Gift Aid in the UK)" },
            { value: "qcd", label: "QCD from an IRA (US)" },
            { value: "daf", label: "Donor-advised fund" },
          ]}
        />
        {c.vehicle === "qcd" ? (
          <EnumField
            label="QCD from"
            value={c.qcdFromAccountId ?? ""}
            onChange={(qcdFromAccountId) =>
              s({ charity: { ...c, qcdFromAccountId } }, "Edit giving")
            }
            options={accounts.map((a) => ({ value: a.id, label: a.name }))}
          />
        ) : null}
        <SwitchField
          label="Carry forward unused deductions"
          checked={c.carryforward}
          onCheckedChange={(carryforward) => s({ charity: { ...c, carryforward } }, "Edit giving")}
        />
      </FormSection>
    );
  }
  if (event.type === "tax-deduction") {
    return (
      <FormSection title="Deduction or credit">
        <Segmented<"deduction" | "credit">
          aria-label="Deduction or credit"
          size="sm"
          value={event.creditOrDeduction}
          onChange={(creditOrDeduction) => s({ creditOrDeduction }, "Edit deduction")}
          options={[
            { value: "deduction", label: "Reduces taxable income" },
            { value: "credit", label: "Reduces tax due" },
          ]}
        />
      </FormSection>
    );
  }
  return null;
}

function IncomeTax({
  event,
  set,
}: {
  event: IncomeEvent;
  set: (fn: (e: AnyEvent) => AnyEvent, l: string, k?: string) => void;
}) {
  const t = event.tax;
  const s = (v: Partial<IncomeEvent>, label: string, key?: string) =>
    set((e) => ({ ...e, ...v }) as AnyEvent, label, key);
  return (
    <FormSection title="Tax & where it goes">
      <FieldGrid>
        <EnumField
          label="Taxed as"
          help={HELP.taxCharacter}
          value={t.character}
          onChange={(character) => s({ tax: { ...t, character } }, "Edit tax character")}
          options={[
            { value: "auto", label: "Auto (from type)" },
            { value: "wage", label: "Employment income" },
            { value: "self-employment", label: "Self-employment" },
            { value: "pension", label: "Pension income" },
            { value: "ordinary", label: "Other ordinary income" },
            { value: "social-security", label: "Social Security (US)" },
            { value: "qualified-dividend", label: "Dividends (qualified)" },
            { value: "ordinary-dividend", label: "Dividends (ordinary)" },
            { value: "interest", label: "Interest" },
            { value: "capital-gains-long", label: "Capital gains (long-term)" },
            { value: "capital-gains-short", label: "Capital gains (short-term)" },
            { value: "rental", label: "Rental income" },
            { value: "tax-free", label: "Tax-free" },
          ]}
        />
        <FormField label="Tax deducted at source" help={HELP.withholding}>
          {(fid) => (
            <div className="flex items-center gap-1.5">
              <Select<"auto" | "fixed" | "none">
                id={fid}
                value={t.withholding.mode}
                onValueChange={(mode) =>
                  s(
                    {
                      tax: { ...t, withholding: mode === "fixed" ? { mode, rate: 0.2 } : { mode } },
                    },
                    "Edit withholding",
                  )
                }
                options={[
                  { value: "auto", label: "Auto (PAYE)" },
                  { value: "fixed", label: "Fixed rate" },
                  { value: "none", label: "None" },
                ]}
                className="flex-1"
              />
              {t.withholding.mode === "fixed" ? (
                <PercentInput
                  aria-label="Withholding rate"
                  className="w-[100px]"
                  value={t.withholding.rate}
                  onValueChange={(rate) =>
                    s(
                      { tax: { ...t, withholding: { mode: "fixed", rate: rate ?? 0 } } },
                      "Edit withholding",
                      "wh",
                    )
                  }
                />
              ) : null}
            </div>
          )}
        </FormField>
      </FieldGrid>
      <FormField
        label="Exempt in"
        hint="Jurisdiction ids, comma separated (e.g. us-state). Leave blank normally."
      >
        {(fid) => (
          <Input
            id={fid}
            value={t.exemptIn.join(", ")}
            onChange={(e) =>
              s(
                {
                  tax: {
                    ...t,
                    exemptIn: e.target.value
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean),
                  },
                },
                "Edit exemptions",
                "ex",
              )
            }
          />
        )}
      </FormField>
      <AccountRoutingEditor
        label="Paid into"
        help={HELP.sendTo}
        autoLabel="Cash flow & Flows"
        value={event.sendTo}
        onChange={(sendTo) => s({ sendTo }, "Edit paid into")}
      />
    </FormSection>
  );
}

function ExpenseTax({
  event,
  set,
}: {
  event: ExpenseEvent;
  set: (fn: (e: AnyEvent) => AnyEvent, l: string, k?: string) => void;
}) {
  const t = event.tax;
  const plan = usePlan();
  const s = (v: Partial<ExpenseEvent["tax"]>, label: string) =>
    set((e) => ({ ...e, tax: { ...(e as ExpenseEvent).tax, ...v } }) as AnyEvent, label);
  const levels = ["federal", "state", "local"] as const;
  return (
    <FormSection title="Tax">
      <FieldGrid>
        <EnumField<"auto" | "taxable" | "tax-exempt">
          label="Paid with"
          help="Tax-exempt: e.g. school fees paid from a 529, or medical costs from an HSA."
          value={t.treatment}
          onChange={(treatment) => s({ treatment }, "Edit tax treatment")}
          options={[
            { value: "auto", label: "Auto" },
            { value: "taxable", label: "Taxed money" },
            { value: "tax-exempt", label: "Tax-exempt money" },
          ]}
        />
        <FormField
          label="Payroll deduction from"
          hint="Paid before tax from a salary (salary sacrifice)."
        >
          {(fid) => (
            <Select
              id={fid}
              value={t.payrollDeductionFromIncomeId ?? "none"}
              onValueChange={(v) =>
                s(
                  { payrollDeductionFromIncomeId: v === "none" ? undefined : v },
                  "Edit payroll deduction",
                )
              }
              options={[
                { value: "none", label: "Not a payroll deduction" },
                ...(plan?.income ?? []).map((i) => ({ value: i.id, label: i.name })),
              ]}
            />
          )}
        </FormField>
      </FieldGrid>
      <SwitchField
        label="Tax-deductible"
        checked={t.deductible}
        onCheckedChange={(deductible) => s({ deductible }, "Toggle deductible")}
      />
      {t.deductible ? (
        <div className="flex flex-wrap items-center gap-4 pl-1 text-[12.5px]">
          <SwitchField
            label="Itemised (US)"
            checked={t.itemized}
            onCheckedChange={(itemized) => s({ itemized }, "Toggle itemised")}
          />
          {levels.map((l) => (
            <label key={l} className="inline-flex items-center gap-1.5 capitalize">
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                checked={t.deductibleIn.includes(l)}
                onChange={(e) =>
                  s(
                    {
                      deductibleIn: e.target.checked
                        ? [...t.deductibleIn, l]
                        : t.deductibleIn.filter((x) => x !== l),
                    },
                    "Edit deductible levels",
                  )
                }
              />
              {l}
            </label>
          ))}
        </div>
      ) : null}
    </FormSection>
  );
}
