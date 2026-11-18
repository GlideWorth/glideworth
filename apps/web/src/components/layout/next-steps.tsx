/**
 * Contextual "next step" hints and the post-import review checklist, shown above the dashboard.
 * Hints are derived from the data (no tracking): the first few that apply, each dismissible.
 */
import type { GlideworthDocument, Plan } from "@glideworth/core";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, ClipboardCheck, Lightbulb, X } from "lucide-react";
import { useMcStore } from "../../features/chance/mc-store";
import { formatMonth } from "../../lib/format";
import { useActivePlan } from "../../lib/workspace";
import { type ImportChecklist, usePrefs } from "../../stores/prefs";
import { useUi } from "../../stores/ui";
import { recordSnapshot, runChance } from "../command/actions";
import { Button } from "../ui/button";

export interface NextStep {
  id: string;
  title: string;
  body: string;
  action: { label: string; to?: string; run?: "chance" | "snapshot" };
}

/** Pure: which hints apply to this document, most important first. */
export function computeNextSteps(
  doc: GlideworthDocument | undefined,
  plan: Plan | undefined,
  opts: { chanceRun: boolean; source: "api" | "sample" | undefined },
  now: Date = new Date(),
): NextStep[] {
  if (!doc || opts.source !== "api") return [];
  const out: NextStep[] = [];
  const fin = doc.finances;
  // Plans that follow current finances start at their "as of" month: an old date silently moves
  // every projection (and every age) into the past.
  const [ay, am] = fin.asOf.split("-").map(Number);
  const monthsOld = now.getUTCFullYear() * 12 + now.getUTCMonth() - (ay! * 12 + am! - 1);
  if (monthsOld > 6)
    out.push({
      id: `stale-asof:${fin.asOf}`,
      title: `Your balances are dated ${formatMonth(fin.asOf, doc.household.locale ?? "en-GB")}`,
      body: "Plans that follow current finances start from that month. Update your balances, or move the “as of” date in Current finances.",
      action: { label: "Current finances", to: "/finances" },
    });
  if (fin.accounts.length + fin.realAssets.length + fin.debts.length === 0)
    out.push({
      id: "add-accounts",
      title: "Add what you own and owe",
      body: "Balances in your accounts are the starting point for every projection.",
      action: { label: "Current finances", to: "/finances" },
    });
  if (!plan)
    out.push({
      id: "first-plan",
      title: "Create your first plan",
      body: "A plan is a story about the future: income, spending, goals. Start from a template.",
      action: { label: "Plans", to: "/plans" },
    });
  else {
    if (plan.income.length === 0 && plan.expenses.length === 0)
      out.push({
        id: `cashflow:${plan.id}`,
        title: `Add income and spending to “${plan.name}”`,
        body: "Without them the projection only grows today’s balances.",
        action: { label: "Open the plan", to: `/plans/${plan.id}` },
      });
    if (!plan.milestones.some((m) => m.kind === "retirement"))
      out.push({
        id: `retire:${plan.id}`,
        title: "Set a retirement goal",
        body: "Most results are framed around when you stop working.",
        action: { label: "Add a milestone", to: `/plans/${plan.id}` },
      });
    if (!opts.chanceRun && (plan.income.length > 0 || plan.expenses.length > 0))
      out.push({
        id: `chance:${plan.id}`,
        title: "See how robust the plan is",
        body: "Chance of success replays the plan through a thousand different markets.",
        action: { label: "Run it now", run: "chance" },
      });
  }
  if (doc.progress.length === 0 && fin.accounts.length > 0)
    out.push({
      id: "first-snapshot",
      title: "Record your first progress snapshot",
      body: "Snapshots build your real net-worth history to compare against the plan.",
      action: { label: "Record now", run: "snapshot" },
    });
  return out;
}

export function NextSteps() {
  const { plan, workspace } = useActivePlan();
  const dismissed = useUi((s) => s.dismissedHints);
  const dismiss = useUi((s) => s.dismissHint);
  const checklist = usePrefs((s) => s.importChecklist);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const chanceRun = useMcStore((s) => !!(plan && s.byPlan[plan.id]));
  const steps = computeNextSteps(workspace?.doc, plan, {
    chanceRun,
    source: workspace?.source,
  }).filter((s) => !dismissed[s.id]);
  if (!steps.length && !checklist) return null;
  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-3 px-4 pt-6 sm:px-6 no-print">
      {checklist ? <ImportChecklistCard checklist={checklist} /> : null}
      {steps.length ? (
        <section
          aria-label="Suggested next steps"
          className="grid gap-px overflow-hidden rounded-[var(--radius-card)] border border-border bg-border shadow-card md:grid-cols-[repeat(auto-fit,minmax(260px,1fr))]"
        >
          {steps.slice(0, 3).map((s) => (
            <div key={s.id} className="relative flex flex-col gap-1.5 bg-surface px-4 py-3.5 pr-9">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                <Lightbulb className="size-3.5 shrink-0 text-ochre" aria-hidden />
                {s.title}
              </div>
              <p className="text-[12.5px] leading-relaxed text-ink-2">{s.body}</p>
              <div>
                {s.action.to ? (
                  <Button size="sm" variant="subtle" asChild>
                    <Link to={s.action.to}>
                      {s.action.label} <ArrowRight />
                    </Link>
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="subtle"
                    onClick={() => {
                      if (s.action.run === "snapshot") void recordSnapshot(qc);
                      else if (workspace && plan)
                        void runChance(workspace.doc, plan, () => void navigate({ to: "/chance" }));
                    }}
                  >
                    {s.action.label} <ArrowRight />
                  </Button>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(s.id)}
                aria-label={`Dismiss: ${s.title}`}
                className="absolute top-2.5 right-2.5 flex items-center justify-center rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink pointer-coarse:top-0 pointer-coarse:right-0 pointer-coarse:size-11"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function ImportChecklistCard({ checklist }: { checklist: ImportChecklist }) {
  const set = usePrefs((s) => s.set);
  const setActive = useUi((s) => s.setActivePlan);
  const navigate = useNavigate();
  const done = checklist.items.filter((i) => i.done).length;
  const total = checklist.items.length;
  const toggle = (id: string, value?: boolean) =>
    set({
      importChecklist: {
        ...checklist,
        items: checklist.items.map((i) => (i.id === id ? { ...i, done: value ?? !i.done } : i)),
      },
    });
  return (
    <section
      aria-labelledby="import-checklist-title"
      className="rounded-[var(--radius-card)] border border-accent/30 bg-surface shadow-card"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-accent">
          <ClipboardCheck className="size-4" />
        </div>
        <div className="min-w-[200px] flex-1">
          <h2 id="import-checklist-title" className="text-[13.5px] font-semibold">
            Review your imported plans
          </h2>
          <p className="text-[12px] text-ink-3">
            Imported from {checklist.source}. Check each item, then dismiss this list.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2" aria-hidden>
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${(done / Math.max(1, total)) * 100}%` }}
              />
            </div>
          </div>
          <span className="num text-[12px] text-ink-2">
            {done} of {total}
          </span>
          <Button size="sm" variant="ghost" onClick={() => set({ importChecklist: null })}>
            {done === total ? "Done" : "Dismiss"}
          </Button>
        </div>
      </header>
      <ol className="grid sm:grid-cols-2">
        {checklist.items.map((item) => (
          <li
            key={item.id}
            className="flex items-start gap-3 border-b border-border px-4 py-2.5 sm:odd:border-r"
          >
            <input
              type="checkbox"
              checked={item.done}
              aria-label={`Mark “${item.label}” as reviewed`}
              onChange={() => toggle(item.id)}
              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--accent)]"
            />
            <div className="min-w-0 flex-1">
              <button
                type="button"
                className={`text-left text-[13px] font-medium hover:underline ${item.done ? "text-ink-3 line-through" : "text-ink"}`}
                onClick={() => {
                  if (item.planId) setActive(item.planId);
                  toggle(item.id, true);
                  void navigate({
                    to: item.to,
                    ...(item.search ? { search: item.search } : {}),
                  } as never);
                }}
              >
                {item.label}
              </button>
              {item.detail ? <p className="text-[12px] text-ink-3">{item.detail}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
