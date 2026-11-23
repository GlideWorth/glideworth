/**
 * Under each dependant in About you: the costs linked to them (across plans) and "Add a cost",
 * which creates an age-timed expense in this plan or every plan through the editor store (one undo
 * step, saved like any other plan edit).
 */
import {
  type Dependent,
  type GlideworthDocument,
  monthAtAge,
  parseMonth,
  type Plan,
} from "@glideworth/core";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { Dialog, DialogClose, DialogContent } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { CurrencyInput, NumberInput } from "../../components/ui/number-input";
import { Segmented } from "../../components/ui/segmented";
import { toast } from "../../components/ui/toaster";
import { useFormat } from "../../lib/workspace";
import { FormField } from "../plan-editor/components/form";
import { type EntityKey, editMany, planKey } from "../plan-editor/state/doc-store";
import { setIntent } from "../plan-editor/state/intent";
import { formatMonthIndex } from "../plan-editor/state/resolve";
import {
  ageSpan,
  alreadyPast,
  buildDependentCost,
  DEPENDENT_COST_PRESETS,
  type DependentCostDraft,
  type DependentCostPreset,
  defaultDraft,
  draftIssues,
  type LinkedCost,
  linkedCosts,
  PRESET_ORDER,
  targetPlans,
} from "./dependent-costs";

const PER = { monthly: "month", yearly: "year" } as const;

export function DependentCosts({
  dependent,
  doc,
  refPlan,
}: {
  dependent: Dependent;
  doc: GlideworthDocument;
  refPlan: Plan | undefined;
}) {
  const [open, setOpen] = useState(false);
  const rows = linkedCosts(doc.plans, dependent.id, refPlan?.id);
  const headingId = useId();
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={headingId} className="text-[12px] font-semibold text-ink-2">
          Costs for {dependent.name || "this dependant"}
        </h4>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setOpen(true)}
          disabled={!refPlan}
          title={refPlan ? undefined : "Create a plan first"}
        >
          <Plus /> Add a cost
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-[12px] text-ink-3">
          None yet. Add childcare, school, college or support, timed by {dependent.name || "their"}
          {dependent.name ? "’s" : ""} age.
        </p>
      ) : (
        <ul aria-labelledby={headingId} className="flex flex-col gap-1">
          {rows.map((row) => (
            <CostRow
              key={row.expense.id}
              row={row}
              dependent={dependent}
              allPlans={doc.plans.length}
            />
          ))}
        </ul>
      )}
      {refPlan ? (
        <Dialog open={open} onOpenChange={setOpen}>
          {open ? (
            <AddCostDialog
              dependent={dependent}
              doc={doc}
              refPlan={refPlan}
              onDone={() => setOpen(false)}
            />
          ) : null}
        </Dialog>
      ) : null}
    </div>
  );
}

function CostRow({
  row,
  dependent,
  allPlans,
}: {
  row: LinkedCost;
  dependent: Dependent;
  allPlans: number;
}) {
  const f = useFormat();
  const e = row.expense;
  const span = ageSpan(e, dependent.id);
  const per = e.frequency in PER ? ` / ${PER[e.frequency as keyof typeof PER]}` : "";
  const where =
    allPlans > 1 && row.plans.length === allPlans
      ? "All plans"
      : row.plans.map((p) => p.name).join(", ");
  const first = row.plans[0]!;
  const remove = async () => {
    const ok = await confirmAction({
      title: `Remove “${e.name}”?`,
      description:
        row.plans.length > 1
          ? `It is removed from ${row.plans.length} plans. You can undo this.`
          : `It is removed from “${first.name}”. You can undo this.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    editMany(
      row.plans.map((p) => ({
        key: planKey(p.id) as EntityKey,
        update: (v: unknown) => {
          const plan = v as Plan;
          return { ...plan, expenses: plan.expenses.filter((x) => x.id !== e.id) };
        },
      })),
      `Remove ${e.name}`,
    );
  };
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-surface-2/60 px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-ink">{e.name}</div>
        <div className="text-[11.5px] text-ink-3">
          <span className="num">
            {f.money(e.amount.value)}
            {per}
          </span>
          {span ? ` · ages ${f.number(span.from, 1)}–${f.number(span.to, 1)}` : ""}
          {e.enabled ? "" : " · off"} · {where}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button size="icon" variant="ghost" asChild>
          <Link
            to="/plans/$planId"
            params={{ planId: first.id }}
            onClick={() => setIntent({ kind: "open-item", item: "expense", id: e.id })}
            aria-label={`Edit ${e.name} in ${first.name}`}
            title={`Edit in ${first.name}`}
          >
            <Pencil />
          </Link>
        </Button>
        <Button size="icon" variant="ghost" aria-label={`Remove ${e.name}`} onClick={remove}>
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

function AddCostDialog({
  dependent,
  doc,
  refPlan,
  onDone,
}: {
  dependent: Dependent;
  doc: GlideworthDocument;
  refPlan: Plan;
  onDone: () => void;
}) {
  const f = useFormat();
  const [draft, setDraft] = useState<DependentCostDraft>(() =>
    defaultDraft(dependent, "childcare"),
  );
  const [showIssues, setShowIssues] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const issues = draftIssues(draft);
  const shown = showIssues ? issues : [];
  const set = (patch: Partial<DependentCostDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const who = dependent.name || "your dependant";
  const pickPreset = (preset: DependentCostPreset) => {
    const next = defaultDraft(dependent, preset);
    setDraft((d) => ({
      ...next,
      name: nameTouched ? d.name : next.name,
      amount: d.amount,
      scope: d.scope,
    }));
  };
  const birth = parseMonth(dependent.birthMonth);
  // A birth month being edited can be blank or partial: show no date rather than throw.
  const when = (age: number) => {
    const m = monthAtAge(birth, age);
    return Number.isFinite(m) ? `, ${formatMonthIndex(m, f.locale)}` : "";
  };
  const past = alreadyPast(dependent, draft.endAge, doc.finances.asOf);
  const plans = targetPlans(doc.plans, refPlan, draft.scope);

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (issues.length) {
      setShowIssues(true);
      return;
    }
    const expense = buildDependentCost(dependent, draft, doc);
    editMany(
      plans.map((p) => ({
        key: planKey(p.id) as EntityKey,
        update: (v: unknown) => {
          const plan = v as Plan;
          return { ...plan, expenses: [...plan.expenses, expense] };
        },
      })),
      `Add ${expense.name}`,
    );
    toast({
      title: plans.length > 1 ? `Added to ${plans.length} plans` : `Added to “${plans[0]!.name}”`,
      description: `It follows ${who}’s age, so it moves if you change the birth month.`,
    });
    onDone();
  };

  const preset = DEPENDENT_COST_PRESETS[draft.preset];
  return (
    <DialogContent
      title={`Add a cost for ${who}`}
      description="Timed by their age. Enter your own amount; nothing is filled in for you."
      className="w-[min(92vw,560px)]"
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <FormField label="What for" hint={preset.hint}>
          {() => (
            <Segmented<DependentCostPreset>
              aria-label="What for"
              size="sm"
              value={draft.preset}
              onChange={pickPreset}
              options={PRESET_ORDER.map((p) => ({
                value: p,
                label: DEPENDENT_COST_PRESETS[p].label,
              }))}
            />
          )}
        </FormField>
        <FormField
          label="Name"
          error={shown.includes("name") ? "Give this cost a name." : undefined}
        >
          {(id) => (
            <Input
              id={id}
              value={draft.name}
              maxLength={120}
              onChange={(e) => {
                setNameTouched(true);
                set({ name: e.target.value });
              }}
            />
          )}
        </FormField>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <FormField
            label="Amount"
            hint="In today’s money; inflation is applied for you."
            error={shown.includes("amount") ? "Enter how much this costs." : undefined}
          >
            {(id) => (
              <CurrencyInput
                id={id}
                value={draft.amount}
                onValueChange={(amount) => set({ amount })}
                aria-required="true"
                aria-invalid={shown.includes("amount") || undefined}
              />
            )}
          </FormField>
          <FormField label="Every">
            {() => (
              <Segmented<"monthly" | "yearly">
                aria-label="Every"
                value={draft.frequency}
                onChange={(frequency) => set({ frequency })}
                options={[
                  { value: "monthly", label: "Month" },
                  { value: "yearly", label: "Year" },
                ]}
              />
            )}
          </FormField>
        </div>
        <fieldset className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-2">
          <legend className="sr-only">Ages</legend>
          <FormField label="From age" hint={`On ${who}’s birthday${when(draft.startAge)}`}>
            {(id) => (
              <NumberInput
                id={id}
                decimals={0}
                suffix="yrs"
                value={draft.startAge}
                onValueChange={(v) => set({ startAge: Math.max(0, Math.round(v ?? 0)) })}
              />
            )}
          </FormField>
          <FormField
            label="Until age"
            hint={`Stops on that birthday${when(draft.endAge)}`}
            error={shown.includes("ages") ? "End after the start age." : undefined}
          >
            {(id) => (
              <NumberInput
                id={id}
                decimals={0}
                suffix="yrs"
                value={draft.endAge}
                onValueChange={(v) => set({ endAge: Math.round(v ?? 0) })}
              />
            )}
          </FormField>
        </fieldset>
        {past && !issues.includes("ages") ? (
          <p
            role="status"
            className="flex items-start gap-1.5 rounded-md bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink-2"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            {who} is already past this age range, so this cost would not apply in the plan.
          </p>
        ) : null}
        {doc.plans.length > 1 ? (
          <FormField
            label="Add to"
            hint={
              draft.scope === "all"
                ? "One copy in each plan; edit or remove it in each plan."
                : `Only “${refPlan.name}” changes.`
            }
          >
            {() => (
              <Segmented<"plan" | "all">
                aria-label="Add to"
                value={draft.scope}
                onChange={(scope) => set({ scope })}
                options={[
                  { value: "plan", label: "This plan" },
                  { value: "all", label: `All ${doc.plans.length} plans` },
                ]}
              />
            )}
          </FormField>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" variant="primary">
            Add cost
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
