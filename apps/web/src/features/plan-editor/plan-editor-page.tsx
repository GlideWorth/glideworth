/**
 * The plan editor: a timeline across the top, the plan's sections beside it, and a live
 * projection that re-simulates (in a Web Worker) on every edit. Edits autosave with optimistic
 * concurrency, undo/redo with Cmd/Ctrl+Z, and Cmd/Ctrl+K jumps anywhere.
 */
import { Plan, type Plan as PlanT } from "@glideworth/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { AlertTriangle, ChartArea, Command, History, ListTree, RotateCcw } from "lucide-react";
import { Tabs as T } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import { Page } from "../../components/layout/app-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { EmptyState } from "../../components/ui/empty-state";
import { Kbd, modKey } from "../../components/ui/kbd";
import { toast } from "../../components/ui/toaster";
import { Tooltip } from "../../components/ui/tooltip";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { isDemo } from "../../lib/demo";
import { formatMonth } from "../../lib/format";
import { useMediaQuery } from "../../lib/use-media";
import { useFormat } from "../../lib/workspace";
import { useUi } from "../../stores/ui";
import { PlanDetailsFields } from "../plans/plans-page";
import { ConflictBanner, EditorFrame, SaveIndicator, UndoRedo } from "./components/editor-chrome";
import { type EditorScope, ScopeProvider } from "./components/form";
import { openPalette } from "./components/palette-store";
import { PlanIdContext } from "./components/plan-context";
import { Timeline, type TimelineTarget } from "./components/timeline";
import { PreviewChart, PreviewMetrics, PreviewPanel } from "./preview/preview-panel";
import { useLiveProjection, usePreview } from "./preview/use-live-projection";
import { AccountsSection } from "./sections/accounts";
import { AssetsSection } from "./sections/assets";
import { EventSheet, EventsSection, useAddEvent } from "./sections/events";
import { FlowSheet, FlowsSection, useAddFlow } from "./sections/flows";
import { MilestoneSheet, MilestonesSection, useAddMilestone } from "./sections/milestones";
import {
  AssumptionsSection,
  MonteCarloSection,
  PlanStartingPoint,
  TaxesSection,
} from "./sections/settings";
import { WithdrawalsSection } from "./sections/withdrawals";
import { addPlanToWorkspace, planKey, useEditorStore } from "./state/doc-store";
import {
  type Intent,
  SECTION_OF_ITEM,
  SECTIONS,
  type SectionId,
  useConsumeIntent,
} from "./state/intent";
import { timeContext } from "./state/resolve";
import { collectIssues } from "./state/validation";
import { WhatIfPanel } from "./whatif/what-if-panel";

const NAV = SECTIONS.filter((s) => s.id !== "timeline");

export function PlanEditorPage() {
  return (
    <EditorFrame>
      <PlanEditor />
    </EditorFrame>
  );
}

function usePlanIdParam(): string | undefined {
  const params = useParams({ strict: false }) as { planId?: string };
  const plans = useEditorStore((s) => s.draft?.plans);
  const activeId = useUi((s) => s.activePlanId);
  if (params.planId && params.planId !== "active") return params.planId;
  const live = plans?.filter((p) => p.status !== "archived");
  return (live?.find((p) => p.id === activeId) ?? live?.find((p) => p.isMain) ?? live?.[0])?.id;
}

function PlanEditor() {
  const planId = usePlanIdParam();
  const ready = useEditorStore((s) => s.ready);
  const plan = useEditorStore((s) => s.draft?.plans.find((p) => p.id === planId));
  const setActive = useUi((s) => s.setActivePlan);
  const currentId = plan?.id;
  useEffect(() => {
    if (currentId) setActive(currentId);
  }, [currentId, setActive]);
  if (!ready)
    return (
      <Page title="Plan editor">
        <div className="h-64 animate-pulse rounded-xl bg-surface-2" />
      </Page>
    );
  if (!plan)
    return (
      <Page title="Plan editor">
        <Card>
          <EmptyState
            icon={ListTree}
            title={planId ? "This plan no longer exists" : "No plan to edit yet"}
            action={
              <Button variant="primary" asChild>
                <Link to="/plans">Go to plans</Link>
              </Button>
            }
          >
            {planId
              ? "It may have been deleted. Choose another plan, or create one."
              : "Create a plan from a template and it opens here, with a live projection beside it."}
          </EmptyState>
        </Card>
      </Page>
    );
  return (
    <PlanIdContext.Provider value={plan.id}>
      <PlanEditorBody plan={plan} />
    </PlanIdContext.Provider>
  );
}

type Open = { kind: "income" | "expense" | "milestone" | "flow"; id: string } | null;

function PlanEditorBody({ plan }: { plan: PlanT }) {
  const f = useFormat();
  const doc = useEditorStore((s) => s.draft)!;
  const result = usePreview((s) => s.result);
  useLiveProjection(plan.id);
  const xl = useMediaQuery("(min-width: 1280px)");
  const [section, setSection] = useState<SectionId>("income");
  const [open, setOpen] = useState<Open>(null);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  const addEvent = useAddEvent();
  const addMilestone = useAddMilestone();
  const addFlow = useAddFlow();
  const tctx = useMemo(() => timeContext(doc, plan, result), [doc, plan, result]);
  const scope = useMemo<EditorScope>(
    () => ({
      people: doc.household.people,
      milestones: plan.milestones,
      accounts: [
        ...doc.finances.accounts
          .filter((a) => !a.archived && !plan.excludedIds.includes(a.id))
          .map((a) => ({ id: a.id, name: a.name, type: a.type })),
        ...plan.plannedAccounts.map((a) => ({
          id: a.id,
          name: `${a.name} (planned)`,
          type: a.type,
        })),
      ],
      tctx,
    }),
    [doc, plan, tctx],
  );

  const go = (s: SectionId) => {
    if (s === "timeline") {
      setTimelineCollapsed(false);
      document
        .getElementById("plan-timeline")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else setSection(s);
  };

  useConsumeIntent((i: Intent) => {
    if (i.kind === "section") go(i.section);
    else if (i.kind === "add-income" || i.kind === "add-expense") {
      const kind = i.kind === "add-income" ? "income" : "expense";
      const id = addEvent(kind, i.type);
      if (id) {
        setSection(kind === "income" ? "income" : "expenses");
        setOpen({ kind, id });
      }
    } else if (i.kind === "open-item") {
      setSection(SECTION_OF_ITEM[i.item]);
      setOpen({ kind: i.item, id: i.id });
    } else if (i.kind === "add-milestone") {
      const id = addMilestone();
      if (id) {
        setSection("milestones");
        setOpen({ kind: "milestone", id });
      }
    } else if (i.kind === "add-flow") {
      const id = addFlow(i.flowKind);
      if (id) {
        setSection("flows");
        setOpen({ kind: "flow", id });
      }
    } else return false;
    return true;
  });

  const onTimeline = (t: TimelineTarget) => setOpen(t);

  return (
    <ScopeProvider value={scope}>
      <Page
        title={plan.name}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            {plan.isMain ? <Badge tone="accent">Main plan</Badge> : null}
            {plan.startingConditions.kind === "snapshot" ? (
              <Badge>
                Fixed date {formatMonth(plan.startingConditions.finances.asOf, f.locale)}
              </Badge>
            ) : (
              <Badge>Follows current finances</Badge>
            )}
            {plan.lineage ? <Badge>Branch</Badge> : null}
            <span className="text-ink-3">{plan.description}</span>
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <SaveIndicator keys={[planKey(plan.id), "household"]} />
            <UndoRedo />
            <Tooltip
              content={
                <span>
                  Jump anywhere <Kbd className="ml-1">{modKey}K</Kbd>
                </span>
              }
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={openPalette}
                aria-label="Open command palette"
              >
                <Command /> <span className="hidden sm:inline">Jump to…</span>
              </Button>
            </Tooltip>
            <Button variant="secondary" size="sm" asChild>
              <Link to="/results">
                <ChartArea /> Results
              </Link>
            </Button>
          </div>
        }
      >
        <ConflictBanner entity={planKey(plan.id)} what="This plan" />
        <ValidationSummary plan={plan} onOpen={setOpen} onSection={setSection} />
        <div id="plan-timeline" className="scroll-mt-4">
          <Timeline
            plan={plan}
            tctx={tctx}
            onOpen={onTimeline}
            collapsed={timelineCollapsed}
            onToggle={() => setTimelineCollapsed((v) => !v)}
          />
        </div>
        <CompactPreview plan={plan} />
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <T.Root
            value={section}
            onValueChange={(v) => setSection(v as SectionId)}
            orientation="vertical"
            className="grid min-w-0 items-start gap-4 lg:grid-cols-[168px_minmax(0,1fr)]"
          >
            <T.List
              aria-label="Plan sections"
              className="-mx-1 flex gap-0.5 overflow-x-auto px-1 pb-1 lg:sticky lg:top-4 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
            >
              {NAV.map((s) => (
                <T.Trigger
                  key={s.id}
                  value={s.id}
                  className="shrink-0 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium whitespace-nowrap pointer-coarse:min-h-11 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-card"
                >
                  <span className="flex items-center justify-between gap-2">
                    {s.label}
                    <SectionCount plan={plan} id={s.id} />
                  </span>
                </T.Trigger>
              ))}
            </T.List>
            <div className="flex min-w-0 flex-col gap-5">
              <T.Content value="milestones" className="flex flex-col gap-5 outline-none">
                <MilestonesSection onOpen={(id) => setOpen({ kind: "milestone", id })} />
              </T.Content>
              <T.Content value="income" className="flex flex-col gap-5 outline-none">
                <EventsSection kind="income" onOpen={(id) => setOpen({ kind: "income", id })} />
              </T.Content>
              <T.Content value="expenses" className="flex flex-col gap-5 outline-none">
                <EventsSection kind="expense" onOpen={(id) => setOpen({ kind: "expense", id })} />
              </T.Content>
              <T.Content value="flows" className="flex flex-col gap-5 outline-none">
                <FlowsSection onOpen={(id) => setOpen({ kind: "flow", id })} />
              </T.Content>
              <T.Content value="accounts" className="flex flex-col gap-5 outline-none">
                <AccountsSection />
              </T.Content>
              <T.Content value="assets" className="flex flex-col gap-5 outline-none">
                <AssetsSection />
              </T.Content>
              <T.Content value="withdrawals" className="flex flex-col gap-5 outline-none">
                <WithdrawalsSection />
              </T.Content>
              <T.Content value="assumptions" className="flex flex-col gap-5 outline-none">
                <AssumptionsSection />
              </T.Content>
              <T.Content value="taxes" className="flex flex-col gap-5 outline-none">
                <TaxesSection />
              </T.Content>
              <T.Content value="montecarlo" className="flex flex-col gap-5 outline-none">
                <MonteCarloSection />
              </T.Content>
              <T.Content value="whatif" className="flex flex-col gap-5 outline-none">
                <WhatIfPanel plan={plan} />
              </T.Content>
              <T.Content value="details" className="flex flex-col gap-5 outline-none">
                <DetailsSection plan={plan} />
              </T.Content>
            </div>
          </T.Root>
          {/* Mounted only where it is visible: a hidden chart has no size to draw into. */}
          {xl ? (
            <aside aria-label="Plan preview" className="sticky top-4 hidden xl:block">
              <Card className="p-4">
                <PreviewPanel plan={plan} />
              </Card>
            </aside>
          ) : null}
        </div>
      </Page>
      <EventSheet
        kind="income"
        id={open?.kind === "income" ? open.id : null}
        onClose={() => setOpen(null)}
      />
      <EventSheet
        kind="expense"
        id={open?.kind === "expense" ? open.id : null}
        onClose={() => setOpen(null)}
      />
      <MilestoneSheet
        id={open?.kind === "milestone" ? open.id : null}
        onClose={() => setOpen(null)}
      />
      <FlowSheet id={open?.kind === "flow" ? open.id : null} onClose={() => setOpen(null)} />
    </ScopeProvider>
  );
}

function SectionCount({ plan, id }: { plan: PlanT; id: SectionId }) {
  const n =
    id === "milestones"
      ? plan.milestones.length
      : id === "income"
        ? plan.income.length
        : id === "expenses"
          ? plan.expenses.length
          : id === "flows"
            ? plan.flows.length
            : null;
  return n ? <span className="num text-[11px] font-normal text-ink-3">{n}</span> : null;
}

/** Below xl the preview sits above the sections, compact, with the chart on demand. */
function CompactPreview({ plan }: { plan: PlanT }) {
  const [chart, setChart] = useState(false);
  const { running, error, invalid } = usePreview();
  return (
    <Card className="p-3 xl:hidden">
      <div className="mb-2 flex items-center justify-between">
        <span className="eyebrow">
          Live projection {running ? "· simulating…" : invalid ? "· paused" : ""}
        </span>
        <Button size="sm" variant="ghost" aria-expanded={chart} onClick={() => setChart((v) => !v)}>
          {chart ? "Hide chart" : "Show chart"}
        </Button>
      </div>
      {error ? <p className="mb-2 text-[12px] text-negative">{error}</p> : null}
      {chart ? (
        <div className="mb-2">
          <PreviewChart plan={plan} height={180} />
        </div>
      ) : null}
      <PreviewMetrics plan={plan} compact />
    </Card>
  );
}

const PATH_SECTION: Record<string, SectionId> = {
  milestones: "milestones",
  income: "income",
  expenses: "expenses",
  flows: "flows",
  accountSettings: "accounts",
  plannedAccounts: "accounts",
  realAssetSettings: "assets",
  plannedRealAssets: "assets",
  debtSettings: "assets",
  drawdown: "withdrawals",
  withdrawalStrategy: "withdrawals",
  flexSpending: "withdrawals",
  riskGuardrails: "withdrawals",
  assumptions: "assumptions",
  tax: "taxes",
  taxStrategy: "taxes",
  monteCarlo: "montecarlo",
  name: "details",
};

function ValidationSummary({
  plan,
  onOpen,
  onSection,
}: {
  plan: PlanT;
  onOpen: (o: Open) => void;
  onSection: (s: SectionId) => void;
}) {
  const issues = useMemo(() => collectIssues(Plan.safeParse(plan) as never), [plan]);
  if (!issues.count) return null;
  const items = issues.all.slice(0, 5).map((i) => {
    const [root, idx] = i.path.split(".");
    const list =
      root === "income" || root === "expenses" || root === "milestones" || root === "flows"
        ? (plan[root] as { id: string; name: string }[])
        : null;
    const entity = list && idx !== undefined ? list[Number(idx)] : undefined;
    const kind =
      root === "income"
        ? "income"
        : root === "expenses"
          ? "expense"
          : root === "milestones"
            ? "milestone"
            : root === "flows"
              ? "flow"
              : null;
    const where = entity
      ? `${entity.name || "Untitled"}`
      : (SECTIONS.find((s) => s.id === PATH_SECTION[root ?? ""])?.label ?? root);
    return {
      key: i.path,
      where,
      message: i.message,
      go: () =>
        entity && kind
          ? onOpen({ kind, id: entity.id })
          : onSection(PATH_SECTION[root ?? ""] ?? "details"),
    };
  });
  return (
    <div
      role="alert"
      className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-warning/40 bg-ochre-soft/50 px-4 py-2.5 text-[12.5px]"
    >
      <div className="flex items-center gap-2 font-semibold text-ink">
        <AlertTriangle className="size-4 text-warning" />
        {issues.count} {issues.count === 1 ? "thing needs" : "things need"} fixing before this plan
        can save and simulate
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 pl-6">
        {items.map((i) => (
          <li key={i.key}>
            <button
              type="button"
              className="text-left underline decoration-dotted underline-offset-2 hover:text-accent"
              onClick={i.go}
            >
              {i.where}: {i.message}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DetailsSection({ plan }: { plan: PlanT }) {
  const index = useEditorStore((s) => s.draft?.plans.findIndex((p) => p.id === plan.id) ?? 0);
  return (
    <>
      <Card>
        <CardHeader eyebrow="About this plan" title="Plan details" />
        <div className="p-4">
          <PlanDetailsFields plan={plan} index={index} />
          <div className="mt-4">
            <PlanStartingPoint />
          </div>
        </div>
      </Card>
      <HistoryCard plan={plan} />
    </>
  );
}

function HistoryCard({ plan }: { plan: PlanT }) {
  const source = useEditorStore((s) => s.source);
  const qc = useQueryClient();
  const f = useFormat();
  const q = useQuery({
    queryKey: ["plan-versions", plan.id, plan.version],
    queryFn: () => api.listPlanVersions(plan.id),
    enabled: source === "api",
    retry: false,
  });
  const restore = async (version: number) => {
    const ok = await confirmAction({
      title: `Restore version ${version}?`,
      description: "This saves a new version with the old content; nothing is lost.",
      confirmLabel: "Restore",
      tone: "primary",
    });
    if (!ok) return;
    try {
      const p = await api.restorePlanVersion(plan.id, version);
      addPlanToWorkspace(p);
      void qc.invalidateQueries({ queryKey: ["plan-versions", plan.id] });
      toast({
        title: `Restored version ${version}`,
        description: `Saved as version ${p.version}.`,
      });
    } catch (e) {
      toast({
        title: "Couldn’t restore",
        description: e instanceof Error ? e.message : String(e),
        tone: "negative",
      });
    }
  };
  return (
    <Card>
      <CardHeader
        eyebrow="Every save is kept"
        title={
          <span className="flex items-center gap-1.5">
            <History className="size-4 text-ink-3" /> History
          </span>
        }
      />
      {source !== "api" ? (
        <p className="p-4 text-[12.5px] text-ink-3">
          {isDemo()
            ? "Version history is kept with your account. In the demo, undo (⌘/Ctrl+Z) works for this session."
            : "Version history needs the API. Offline, undo (⌘/Ctrl+Z) still works for this session."}
        </p>
      ) : q.isLoading ? (
        <div className="m-4 h-20 animate-pulse rounded-lg bg-surface-2" />
      ) : q.isError ? (
        <p className="p-4 text-[12.5px] text-ink-3">History isn’t available from this server.</p>
      ) : (
        <ol className="max-h-[320px] divide-y divide-border overflow-y-auto">
          {[...(q.data?.items ?? [])]
            .sort((a, b) => b.version - a.version)
            .map((v) => (
              <li key={v.version} className="flex items-center gap-3 px-4 py-2 text-[12.5px]">
                <span className="num w-10 font-semibold">v{v.version}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2">
                  {v.message ? v.message.charAt(0).toUpperCase() + v.message.slice(1) : "Saved"}
                  {describeActor(v.actor) ? (
                    <span className="text-ink-3"> · {describeActor(v.actor)}</span>
                  ) : null}
                </span>
                <span className="num text-ink-3">
                  {new Intl.DateTimeFormat(f.locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(v.createdAt))}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={v.version === plan.version}
                  onClick={() => void restore(v.version)}
                  className={cn(v.version === plan.version && "invisible")}
                >
                  <RotateCcw /> Restore
                </Button>
              </li>
            ))}
        </ol>
      )}
    </Card>
  );
}

/** Who made a version: the person's name for browser edits, the key or assistant (and its person) otherwise. */
function describeActor(a: unknown): string {
  if (a && typeof a === "object" && "kind" in a) {
    const x = a as { kind: string; label?: string | null; userName?: string | null };
    const who = x.userName ?? undefined;
    if (x.kind === "api-key")
      return x.label ? `API key “${x.label}”` : who ? `API key (${who})` : "via API";
    if (x.kind === "mcp")
      return who ? `AI assistant for ${who}` : x.label ? `assistant (${x.label})` : "via assistant";
    if (x.kind === "importer") return who ? `import by ${who}` : "import";
    if (x.kind === "user") return who ?? (x.label && x.label !== "web app" ? x.label : "you");
    return who ?? x.label ?? "";
  }
  return "";
}
