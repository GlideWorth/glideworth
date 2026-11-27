/**
 * Command palette (Cmd/Ctrl+K): jump to any plan or editor section, add any event or account,
 * open pages, undo/redo. A combobox over a filtered listbox, fully keyboard driven.
 */
import {
  ACCOUNT_TYPE_INFO,
  type AccountType,
  DEBT_TYPES,
  REAL_ASSET_TYPES,
} from "@glideworth/core";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowRight,
  CornerDownLeft,
  FilePlus2,
  Landmark,
  ListTree,
  type LucideIcon,
  Milestone as MilestoneIcon,
  Plus,
  Search,
  SlidersHorizontal,
  Undo2,
  Wallet,
} from "lucide-react";
import { Dialog as D } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useGlobalCommands } from "../../../components/command/global-commands";
import { Kbd, modKey } from "../../../components/ui/kbd";
import { cn } from "../../../lib/cn";
import { useRestoreFocus } from "../../../lib/restore-focus";
import { useWorkspace } from "../../../lib/workspace";
import { useUi } from "../../../stores/ui";
import { redo, undo, useEditorStore } from "../state/doc-store";
import { type Intent, SECTIONS, setIntent } from "../state/intent";
import {
  accountTypeGroups,
  DEBT_TYPES_LABEL,
  EXPENSE_TYPES,
  INCOME_TYPES,
  REAL_ASSET_TYPES_LABEL,
} from "../state/labels";
import { usePalette } from "./palette-store";
import { PrivateText } from "../../../components/ui/private-text";

export { openPalette, usePalette } from "./palette-store";

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon: LucideIcon;
  run: () => void;
}

/** The named things in a plan (income, expenses, milestones, flows) that the palette can open. */
export function planItems(plan: {
  income: { id: string; name: string }[];
  expenses: { id: string; name: string }[];
  milestones: { id: string; name: string }[];
  flows: { id: string; name: string }[];
}): {
  item: "income" | "expense" | "milestone" | "flow";
  id: string;
  name: string;
  hint: string;
}[] {
  return [
    ...plan.income.map((x) => ({
      item: "income" as const,
      hint: "Income",
      id: x.id,
      name: x.name,
    })),
    ...plan.expenses.map((x) => ({
      item: "expense" as const,
      hint: "Expense",
      id: x.id,
      name: x.name,
    })),
    ...plan.milestones.map((x) => ({
      item: "milestone" as const,
      hint: "Milestone",
      id: x.id,
      name: x.name,
    })),
    ...plan.flows.map((x) => ({ item: "flow" as const, hint: "Flow", id: x.id, name: x.name })),
  ].filter((x) => x.name.trim());
}

export function scoreCommand(
  c: Pick<Command, "label" | "group" | "keywords" | "hint">,
  q: string,
): number {
  if (!q) return 1;
  const hay = `${c.label} ${c.group} ${c.keywords ?? ""} ${c.hint ?? ""}`.toLowerCase();
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.every((t) => hay.includes(t))) return 0;
  const label = c.label.toLowerCase();
  return (label.startsWith(tokens[0]!) ? 3 : 0) + (label.includes(q.toLowerCase()) ? 2 : 0) + 1;
}

export function CommandPalette() {
  const restoreFocus = useRestoreFocus();
  const open = usePalette((s) => s.open);
  const setOpen = (o: boolean) => usePalette.setState({ open: o });
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { planId?: string };
  const draftPlans = useEditorStore((s) => s.draft?.plans);
  const draftCountry = useEditorStore((s) => s.draft?.household.location.country);
  // Mounted globally by the app shell: outside the editors, fall back to the loaded workspace.
  const ws = useWorkspace().data;
  const plans = draftPlans ?? ws?.doc.plans;
  const country = draftCountry ?? ws?.doc.household.location.country ?? "US";
  const globalCommands = useGlobalCommands();
  const activeId = useUi((s) => s.activePlanId);
  const setActive = useUi((s) => s.setActivePlan);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const currentPlanId =
    (params.planId && params.planId !== "active" ? params.planId : undefined) ??
    plans?.find((p) => p.id === activeId)?.id ??
    plans?.find((p) => p.isMain)?.id ??
    plans?.[0]?.id;

  const commands = useMemo<Command[]>(() => {
    const toPlan = (intent?: Intent) => {
      if (!currentPlanId) return navigate({ to: "/plans" });
      if (intent) setIntent(intent);
      void navigate({ to: "/plans/$planId", params: { planId: currentPlanId } });
    };
    const toFinances = (intent: Intent) => {
      setIntent(intent);
      void navigate({ to: "/finances" });
    };
    const out: Command[] = [];
    for (const p of plans ?? [])
      out.push({
        id: `plan:${p.id}`,
        group: "Plans",
        label: p.name,
        hint: p.isMain ? "Main plan" : p.status === "archived" ? "Archived" : undefined,
        icon: ListTree,
        keywords: "open plan switch",
        run: () => {
          setActive(p.id);
          void navigate({ to: "/plans/$planId", params: { planId: p.id } });
        },
      });
    out.push(...globalCommands);
    const current = plans?.find((p) => p.id === currentPlanId);
    if (current)
      for (const it of planItems(current))
        out.push({
          id: `item:${it.item}:${it.id}`,
          group: "In this plan",
          label: it.name,
          hint: it.hint,
          icon: ArrowRight,
          keywords: "open edit find",
          run: () => toPlan({ kind: "open-item", item: it.item, id: it.id }),
        });
    for (const s of SECTIONS)
      out.push({
        id: `sec:${s.id}`,
        group: "Plan sections",
        label: s.label,
        icon: SlidersHorizontal,
        keywords: "go section edit",
        run: () => toPlan({ kind: "section", section: s.id }),
      });
    const relevant = <T extends { countries?: string[] }>(x: T) =>
      !x.countries || x.countries.includes(country);
    for (const t of INCOME_TYPES.filter(relevant))
      out.push({
        id: `inc:${t.value}`,
        group: "Add to plan",
        label: `Add income: ${t.label}`,
        hint: t.hint,
        icon: Plus,
        keywords: "new income",
        run: () => toPlan({ kind: "add-income", type: t.value }),
      });
    for (const t of EXPENSE_TYPES)
      out.push({
        id: `exp:${t.value}`,
        group: "Add to plan",
        label: `Add expense: ${t.label}`,
        hint: t.hint,
        icon: Plus,
        keywords: "new expense spending",
        run: () => toPlan({ kind: "add-expense", type: t.value }),
      });
    out.push({
      id: "ms",
      group: "Add to plan",
      label: "Add milestone",
      icon: MilestoneIcon,
      keywords: "new goal fi retire",
      run: () => toPlan({ kind: "add-milestone" }),
    });
    out.push({
      id: "fl-c",
      group: "Add to plan",
      label: "Add flow: save into an account",
      icon: Plus,
      keywords: "contribution savings isa pension",
      run: () => toPlan({ kind: "add-flow", flowKind: "contribution" }),
    });
    out.push({
      id: "fl-d",
      group: "Add to plan",
      label: "Add flow: overpay a debt",
      icon: Plus,
      keywords: "mortgage overpayment",
      run: () => toPlan({ kind: "add-flow", flowKind: "debtPaydown" }),
    });
    out.push({
      id: "fl-t",
      group: "Add to plan",
      label: "Add flow: transfer between accounts",
      icon: Plus,
      keywords: "move conversion",
      run: () => toPlan({ kind: "add-flow", flowKind: "transfer" }),
    });
    for (const g of accountTypeGroups(country))
      for (const t of g.types)
        out.push({
          id: `acc:${t}`,
          group: "Add to finances",
          label: `Add account: ${ACCOUNT_TYPE_INFO[t as AccountType].label}`,
          hint: g.label,
          icon: Wallet,
          keywords: "new account",
          run: () => toFinances({ kind: "add-account", type: t }),
        });
    for (const t of REAL_ASSET_TYPES)
      out.push({
        id: `ra:${t}`,
        group: "Add to finances",
        label: `Add asset: ${REAL_ASSET_TYPES_LABEL[t]}`,
        icon: Landmark,
        keywords: "property house car",
        run: () => toFinances({ kind: "add-asset", type: t }),
      });
    out.push({
      id: "mortgage",
      group: "Add to finances",
      label: "Add mortgage (home with a loan)",
      icon: Landmark,
      keywords: "debt house loan",
      run: () => toFinances({ kind: "add-asset", type: "house", financed: true }),
    });
    for (const t of DEBT_TYPES)
      out.push({
        id: `debt:${t}`,
        group: "Add to finances",
        label: `Add debt: ${DEBT_TYPES_LABEL[t]}`,
        icon: Plus,
        keywords: "loan credit",
        run: () => toFinances({ kind: "add-debt", type: t }),
      });
    out.push({
      id: "hh",
      group: "Go to",
      label: "Edit household & people",
      icon: Wallet,
      keywords: "about you partner birth location currency",
      run: () => toFinances({ kind: "edit-household" }),
    });
    out.push({
      id: "go-fin",
      group: "Go to",
      label: "Current finances",
      icon: Wallet,
      run: () => void navigate({ to: "/finances" }),
    });
    out.push({
      id: "go-plans",
      group: "Go to",
      label: "All plans",
      icon: ListTree,
      run: () => void navigate({ to: "/plans" }),
    });
    out.push({
      id: "go-new",
      group: "Go to",
      label: "New plan…",
      icon: FilePlus2,
      keywords: "create template",
      run: () => {
        setIntent({ kind: "new-plan" });
        void navigate({ to: "/plans" });
      },
    });
    out.push({
      id: "go-results",
      group: "Go to",
      label: "Results",
      icon: ArrowRight,
      run: () => void navigate({ to: "/results" }),
    });
    out.push({
      id: "go-dash",
      group: "Go to",
      label: "Dashboard",
      icon: ArrowRight,
      run: () => void navigate({ to: "/" }),
    });
    out.push({
      id: "undo",
      group: "Edit",
      label: "Undo",
      hint: `${modKey}Z`,
      icon: Undo2,
      run: () => void undo(),
    });
    out.push({
      id: "redo",
      group: "Edit",
      label: "Redo",
      hint: `${modKey}⇧Z`,
      icon: Undo2,
      run: () => void redo(),
    });
    return out;
  }, [plans, country, currentPlanId, navigate, setActive, globalCommands]);

  const results = useMemo(() => {
    const scored = commands
      .map((c) => ({ c, s: scoreCommand(c, q.trim()) }))
      .filter((x) => x.s > 0);
    if (q.trim()) scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.c).slice(0, q.trim() ? 40 : 60);
  }, [commands, q]);

  useEffect(() => setSel(0), [q, open]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    setOpen(false);
    setQ("");
    c.run();
  };

  let lastGroup = "";
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[55] bg-black/25" />
        <D.Content
          {...restoreFocus}
          aria-describedby={undefined}
          className="fixed left-1/2 top-[max(0.75rem,env(safe-area-inset-top))] z-[56] flex max-h-[min(70dvh,calc(100dvh-1.5rem))] w-[min(94vw,600px)] sm:top-[12dvh] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop"
        >
          <D.Title className="sr-only">Command palette</D.Title>
          <div className="flex items-center gap-2 border-b border-border px-3.5">
            <Search className="size-4 text-ink-3" />
            <input
              data-native-undo
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- the palette exists to be typed into
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls="glideworth-palette-list"
              aria-activedescendant={results[sel] ? `cmd-${results[sel]!.id}` : undefined}
              placeholder="Search pages, plans and actions, or add an event or account…"
              className="h-12 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel((s) => Math.min(results.length - 1, s + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((s) => Math.max(0, s - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  run(results[sel]);
                }
              }}
            />
            <Kbd>Esc</Kbd>
          </div>
          <div
            ref={listRef}
            id="glideworth-palette-list"
            role="listbox"
            aria-label="Commands"
            className="min-h-0 flex-1 overflow-y-auto p-1.5"
          >
            {results.length === 0 ? (
              <div className="px-3 py-8 text-center text-[13px] text-ink-3">
                No matches for “{q}”.
              </div>
            ) : null}
            {results.map((c, i) => {
              const header = c.group !== lastGroup ? c.group : null;
              lastGroup = c.group;
              return (
                <div key={c.id}>
                  {header ? <div className="eyebrow px-2.5 pt-2.5 pb-1">{header}</div> : null}
                  <div
                    id={`cmd-${c.id}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === sel}
                    data-index={i}
                    onMouseMove={() => setSel(i)}
                    onClick={() => run(c)}
                    onKeyDown={() => undefined}
                    className={cn(
                      "flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px]",
                      i === sel ? "bg-accent-soft text-ink" : "text-ink-2",
                    )}
                  >
                    <c.icon
                      className={cn("size-3.5 shrink-0", i === sel ? "text-accent" : "text-ink-3")}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      <PrivateText>{c.label}</PrivateText>
                    </span>
                    {c.hint ? (
                      <span
                        className={cn(
                          "hidden max-w-[45%] truncate text-[11.5px] sm:inline",
                          i === sel ? "text-ink-2" : "text-ink-3",
                        )}
                      >
                        <PrivateText>{c.hint}</PrivateText>
                      </span>
                    ) : null}
                    {i === sel ? <CornerDownLeft className="size-3.5 text-ink-3" /> : null}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3 border-t border-border px-3.5 py-2 text-[11px] text-ink-3">
            <span className="inline-flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>↵</Kbd> run
            </span>
            <span className="ml-auto inline-flex items-center gap-1">
              <Kbd>{modKey}K</Kbd> toggle
            </span>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
