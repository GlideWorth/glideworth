/**
 * Plans: every scenario built on top of current finances. Create (blank, template, copy), branch,
 * rename and style, archive/delete, make main, and set the active plan used across the app.
 */

import type { Plan } from "@glideworth/core";
import { usePostHog } from "@posthog/react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  CalendarClock,
  Command,
  Copy,
  GitBranch,
  GitMerge,
  ListTree,
  MoreHorizontal,
  Pencil,
  Plus,
  Share2,
  Star,
  Trash2,
} from "lucide-react";
import { useCallback, useState } from "react";
import { Page } from "../../components/layout/app-shell";
import {
  ActionMenu,
  ActionMenuContent,
  ActionMenuItem,
  ActionMenuSeparator,
  ActionMenuTrigger,
} from "../../components/ui/action-menu";
import { AppearanceDot, AppearancePicker } from "../../components/ui/appearance-picker";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Kbd, modKey } from "../../components/ui/kbd";
import { Segmented } from "../../components/ui/segmented";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { formatMonth } from "../../lib/format";
import { useFormat } from "../../lib/workspace";
import { useUi } from "../../stores/ui";
import { EditorFrame, SaveIndicator, UndoRedo } from "../plan-editor/components/editor-chrome";
import { FormField } from "../plan-editor/components/form";
import { openPalette } from "../plan-editor/components/palette-store";
import { newId } from "../plan-editor/state/defaults";
import { editPlan, planKey, useEditorStore } from "../plan-editor/state/doc-store";
import { type Intent, useConsumeIntent } from "../plan-editor/state/intent";
import { ShareLinksPanel } from "../share/share-links";
import {
  branchPlan,
  createPlan,
  deletePlan,
  duplicatePlan,
  mergeBranch,
  setPlanStatus,
} from "./plan-actions";
import { buildPlanFromTemplate, PLAN_TEMPLATES } from "./templates";

export function PlansPage() {
  return (
    <EditorFrame>
      <PlansContent />
    </EditorFrame>
  );
}

function useRun() {
  return useCallback(async <T,>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      toast({
        title: `Couldn’t ${what}`,
        description: e instanceof Error ? e.message : String(e),
        tone: "negative",
      });
      return undefined;
    }
  }, []);
}

function PlansContent() {
  const plans = useEditorStore((s) => s.draft?.plans);
  const ready = useEditorStore((s) => s.ready);
  const [creating, setCreating] = useState(false);
  const [details, setDetails] = useState<string | null>(null);
  const [sharing, setSharing] = useState<Plan | null>(null);
  const readOnly = useUi((s) => s.readOnly);
  const [showArchived, setShowArchived] = useState(false);
  useConsumeIntent((i: Intent) => {
    if (i.kind !== "new-plan") return false;
    setCreating(true);
    return true;
  }, ready);
  const active = (plans ?? []).filter((p) => p.status !== "archived");
  const archived = (plans ?? []).filter((p) => p.status === "archived");
  const keys = (plans ?? []).map((p) => planKey(p.id));
  return (
    <Page
      title="Plans"
      description="Scenarios built on top of your current finances. Compare them, branch them, keep the one you live by as the main plan."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <SaveIndicator keys={keys} />
          <UndoRedo />
          <Button
            variant="secondary"
            size="sm"
            onClick={openPalette}
            aria-label="Open command palette"
          >
            <Command /> <Kbd className="border-none bg-transparent">{modKey}K</Kbd>
          </Button>
          {readOnly ? null : (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus /> New plan
            </Button>
          )}
        </div>
      }
    >
      {plans && active.length === 0 ? (
        <Card>
          <EmptyState
            icon={ListTree}
            title="Create your first plan"
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus /> New plan
              </Button>
            }
          >
            A plan is a story about your future: when you stop working, what you spend, where your
            savings go. It starts from your current finances, so you only describe what changes.
            Templates give you a working plan in one click.
          </EmptyState>
        </Card>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {active.map((p, i) => (
          <PlanCard
            key={p.id}
            plan={p}
            index={i}
            onDetails={() => setDetails(p.id)}
            onShare={() => setSharing(p)}
          />
        ))}
      </div>
      {archived.length ? (
        <section className="flex flex-col gap-3">
          <button
            type="button"
            className="eyebrow self-start hover:text-ink"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? "▾" : "▸"} Archived ({archived.length})
          </button>
          {showArchived ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {archived.map((p, i) => (
                <PlanCard
                  key={p.id}
                  plan={p}
                  index={i + active.length}
                  onDetails={() => setDetails(p.id)}
                  onShare={() => setSharing(p)}
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      <NewPlanDialog open={creating} onOpenChange={setCreating} />
      <PlanDetailsDialog planId={details} onClose={() => setDetails(null)} />
      <Dialog open={!!sharing} onOpenChange={(o) => !o && setSharing(null)}>
        <DialogContent
          title={`Share “${sharing?.name ?? ""}”`}
          description="Read-only links to this plan's results."
          className="w-[min(94vw,640px)]"
        >
          {sharing ? <ShareLinksPanel planId={sharing.id} planName={sharing.name} /> : null}
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function PlanCard({
  plan: p,
  index,
  onDetails,
  onShare,
}: {
  plan: Plan;
  index: number;
  onDetails: () => void;
  onShare: () => void;
}) {
  const readOnly = useUi((s) => s.readOnly);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const f = useFormat();
  const activeId = useUi((s) => s.activePlanId);
  const setActive = useUi((s) => s.setActivePlan);
  const plans = useEditorStore((s) => s.draft?.plans);
  const isActive = activeId ? activeId === p.id : p.isMain;
  const parent = p.lineage ? plans?.find((x) => x.id === p.lineage!.parentPlanId) : undefined;
  const run = useRun();
  const open = () => {
    setActive(p.id);
    void navigate({ to: "/plans/$planId", params: { planId: p.id } });
  };
  return (
    <Card
      className={cn(
        "group flex flex-col transition-[border-color,box-shadow] hover:border-border-strong",
        isActive && "ring-1 ring-accent/40",
        p.status === "archived" && "opacity-70",
      )}
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <AppearanceDot
          appearance={p.appearance}
          fallbackIndex={index}
          fallbackIcon={ListTree}
          size={34}
        />
        <div className="min-w-0 flex-1">
          <Link
            to="/plans/$planId"
            params={{ planId: p.id }}
            onClick={() => setActive(p.id)}
            className="display block truncate text-[17px] leading-tight font-semibold hover:text-accent"
          >
            {p.name}
          </Link>
          <div className="mt-1 flex flex-wrap gap-1">
            {p.isMain ? (
              <Badge tone="accent">
                <Star className="size-3" /> Main
              </Badge>
            ) : null}
            {isActive ? <Badge tone="ochre">Active</Badge> : null}
            {p.lineage ? (
              <Badge>
                <GitBranch className="size-3" /> Branch of {parent?.name ?? "a plan"}
              </Badge>
            ) : null}
            {p.startingConditions.kind === "snapshot" ? (
              <Badge>
                <CalendarClock className="size-3" /> Fixed date{" "}
                {formatMonth(p.startingConditions.finances.asOf, f.locale)}
              </Badge>
            ) : null}
            {p.status === "archived" ? <Badge>Archived</Badge> : null}
          </div>
        </div>
        <ActionMenu>
          <ActionMenuTrigger asChild>
            <Button size="icon" variant="ghost" aria-label={`Actions for ${p.name}`}>
              <MoreHorizontal />
            </Button>
          </ActionMenuTrigger>
          <ActionMenuContent>
            <ActionMenuItem onSelect={open}>Open editor</ActionMenuItem>
            <ActionMenuItem
              onSelect={() => setActive(p.id)}
              disabled={isActive}
              hint="Used by Results and other pages"
            >
              Set as active plan
            </ActionMenuItem>
            <ActionMenuItem
              onSelect={() =>
                void run("make this the main plan", () => setPlanStatus(qc, p, "set-main"))
              }
              disabled={p.isMain || readOnly}
              hint="Your reference plan"
            >
              <Star /> Make main plan
            </ActionMenuItem>
            {readOnly ? null : (
              <>
                <ActionMenuSeparator />
                <ActionMenuItem onSelect={onDetails}>
                  <Pencil /> Rename, notes & colour
                </ActionMenuItem>
                <ActionMenuItem onSelect={onShare} hint="A read-only link to its results">
                  <Share2 /> Share…
                </ActionMenuItem>
                <ActionMenuItem
                  onSelect={() =>
                    void run("duplicate the plan", async () => {
                      const c = await duplicatePlan(qc, p);
                      toast({ title: `Created “${c.name}”` });
                    })
                  }
                >
                  <Copy /> Duplicate
                </ActionMenuItem>
                <ActionMenuItem
                  onSelect={() =>
                    void run("create a branch", async () => {
                      const b = await branchPlan(qc, p);
                      setActive(b.id);
                      void navigate({ to: "/plans/$planId", params: { planId: b.id } });
                    })
                  }
                  hint="A what-if that follows this plan"
                >
                  <GitBranch /> Create branch
                </ActionMenuItem>
                {p.lineage ? (
                  <>
                    <ActionMenuItem
                      hint={`Apply its changes to “${parent?.name ?? "the parent"}”`}
                      onSelect={async () => {
                        const ok = await confirmAction({
                          title: `Merge “${p.name}” into “${parent?.name ?? "its parent"}”?`,
                          description:
                            "Its changes are applied to the parent plan as a new version (you can restore the previous version from the parent’s history). The branch is then removed.",
                          confirmLabel: "Merge into parent",
                        });
                        if (ok)
                          void run("merge the branch", async () => {
                            const merged = await mergeBranch(qc, p, "into-parent");
                            setActive(merged.id);
                            toast({
                              title: `Merged into “${merged.name}”`,
                              description: `Now version ${merged.version}.`,
                            });
                          });
                      }}
                    >
                      <GitMerge /> Merge into parent
                    </ActionMenuItem>
                    <ActionMenuItem
                      hint="Stop following the parent"
                      onSelect={() =>
                        void run("make the branch independent", async () => {
                          const promoted = await mergeBranch(qc, p, "promote");
                          toast({ title: `“${promoted.name}” is now an independent plan` });
                        })
                      }
                    >
                      <GitBranch /> Make independent
                    </ActionMenuItem>
                  </>
                ) : null}
                <ActionMenuItem
                  onSelect={() =>
                    void run(
                      p.status === "archived" ? "restore the plan" : "archive the plan",
                      () => setPlanStatus(qc, p, p.status === "archived" ? "unarchive" : "archive"),
                    )
                  }
                >
                  <Archive /> {p.status === "archived" ? "Restore" : "Archive"}
                </ActionMenuItem>
                <ActionMenuSeparator />
                <ActionMenuItem
                  tone="negative"
                  disabled={p.isMain}
                  hint={p.isMain ? "Make another plan main first" : undefined}
                  onSelect={async () => {
                    const ok = await confirmAction({
                      title: `Delete “${p.name}”?`,
                      description:
                        "The plan and its history are removed for good. Branches of it become independent plans.",
                      confirmLabel: "Delete plan",
                    });
                    if (ok) void run("delete the plan", () => deletePlan(qc, p));
                  }}
                >
                  <Trash2 /> Delete
                </ActionMenuItem>
              </>
            )}
          </ActionMenuContent>
        </ActionMenu>
      </div>
      <p className="line-clamp-3 flex-1 px-4 text-[12.5px] text-ink-2">
        {p.description || <span className="text-ink-3">No description.</span>}
      </p>
      <dl className="mt-3 grid grid-cols-4 border-t border-border text-center">
        {(
          [
            ["Income", p.income.length],
            ["Expenses", p.expenses.length],
            ["Flows", p.flows.length],
            ["Milestones", p.milestones.length],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="border-r border-border py-2 last:border-r-0">
            <dd className="num text-[15px] font-semibold">{v}</dd>
            <dt className="text-[10.5px] tracking-wide text-ink-3 uppercase">{k}</dt>
          </div>
        ))}
      </dl>
      <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[11.5px] text-ink-3">
        <span className="num">
          v{p.version}
          {p.updatedAt
            ? ` · updated ${new Intl.DateTimeFormat(f.locale, { day: "numeric", month: "short" }).format(new Date(p.updatedAt))}`
            : ""}
        </span>
        <Button size="sm" variant="ghost" onClick={open}>
          Open
        </Button>
      </div>
    </Card>
  );
}

function NewPlanDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const doc = useEditorStore((s) => s.draft);
  const f = useFormat();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const setActive = useUi((s) => s.setActivePlan);
  const posthog = usePostHog();
  const [source, setSource] = useState<"template" | "copy">("template");
  const [template, setTemplate] = useState("work-save-retire");
  const [copyFrom, setCopyFrom] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [fixed, setFixed] = useState(false);
  const [appearance, setAppearance] = useState<{ color?: string; icon?: string }>({});
  const [busy, setBusy] = useState(false);
  const run = useRun();
  if (!doc) return null;
  const tpl = PLAN_TEMPLATES.find((t) => t.id === template)!;
  const src = doc.plans.find(
    (p) => p.id === (copyFrom ?? doc.plans.find((x) => x.isMain)?.id ?? doc.plans[0]?.id),
  );
  const finalName =
    name.trim() ||
    (source === "copy" && src ? `${src.name} (copy)` : tpl.id === "blank" ? "New plan" : tpl.name);
  const submit = async () => {
    setBusy(true);
    const created = await run("create the plan", async () => {
      if (source === "copy" && src) {
        const c = await duplicatePlan(qc, src);
        if (c.name !== finalName || appearance.color || appearance.icon)
          editPlan(
            c.id,
            (p) => ({ ...p, name: finalName, appearance: { ...p.appearance, ...appearance } }),
            "Name plan",
          );
        return c;
      }
      const plan = buildPlanFromTemplate(
        template,
        { household: doc.household, finances: doc.finances },
        { id: newId("plan"), name: finalName, fixedDate: fixed, appearance },
      );
      return createPlan(qc, plan);
    });
    setBusy(false);
    if (created) {
      posthog?.capture("plan_created", {
        creation_source: source,
        ...(source === "template" ? { template_id: template } : {}),
        starting_conditions: fixed ? "fixed" : "live",
      });
      onOpenChange(false);
      setName("");
      setActive(created.id);
      toast({
        title: `Created “${created.name}”`,
        description: "It simulates as you edit; the preview is on the right.",
      });
      void navigate({ to: "/plans/$planId", params: { planId: created.id } });
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New plan"
        description="Start from a template that already works, or copy an existing plan."
        className="w-[min(94vw,640px)]"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Segmented<"template" | "copy">
            aria-label="Start from"
            value={source}
            onChange={setSource}
            options={[
              { value: "template", label: "Template" },
              {
                value: "copy",
                label: "Copy a plan",
                title: doc.plans.length ? undefined : "No plans yet",
              },
            ]}
          />
          {source === "template" ? (
            <div
              role="radiogroup"
              aria-label="Template"
              className="grid max-h-[300px] gap-1.5 overflow-y-auto sm:grid-cols-2"
            >
              {PLAN_TEMPLATES.filter(
                (t) => t.id !== "staggered" || doc.household.people.length > 1,
              ).map((t) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={template === t.id}
                  key={t.id}
                  onClick={() => setTemplate(t.id)}
                  className={cn(
                    "rounded-lg border px-3 py-2.5 text-left transition-colors",
                    template === t.id
                      ? "border-accent bg-accent-soft/50"
                      : "border-border hover:border-border-strong",
                  )}
                >
                  <div className="text-[13px] font-semibold">{t.name}</div>
                  <div className="mt-0.5 text-[11.5px] leading-snug text-ink-2">
                    {t.description}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div
              role="radiogroup"
              aria-label="Plan to copy"
              className="flex max-h-[260px] flex-col gap-1 overflow-y-auto"
            >
              {doc.plans.map((p, i) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={src?.id === p.id}
                  key={p.id}
                  onClick={() => setCopyFrom(p.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-left",
                    src?.id === p.id
                      ? "border-accent bg-accent-soft/50"
                      : "border-border hover:border-border-strong",
                  )}
                >
                  <AppearanceDot appearance={p.appearance} fallbackIndex={i} size={20} />
                  <span className="text-[13px] font-medium">{p.name}</span>
                  {p.isMain ? <Badge tone="accent">Main</Badge> : null}
                </button>
              ))}
            </div>
          )}
          <FormField label="Name">
            {(id) => (
              <Input
                id={id}
                value={name}
                placeholder={finalName}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
              />
            )}
          </FormField>
          {source === "template" ? (
            <FormField
              label="Starting point"
              help="A fixed-date plan freezes today's balances. It ignores later updates to Current Finances, which is useful for tracking progress against an original plan."
            >
              {() => (
                <Segmented<"live" | "fixed">
                  aria-label="Starting point"
                  value={fixed ? "fixed" : "live"}
                  onChange={(v) => setFixed(v === "fixed")}
                  options={[
                    { value: "live", label: "Follow current finances" },
                    {
                      value: "fixed",
                      label: `Freeze as of ${formatMonth(doc.finances.asOf, f.locale)}`,
                    },
                  ]}
                />
              )}
            </FormField>
          ) : null}
          <FormField label="Colour & icon">
            {() => (
              <AppearancePicker
                value={appearance}
                onChange={setAppearance}
                fallbackIndex={doc.plans.length}
              />
            )}
          </FormField>
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || (source === "copy" && !src)}>
              {busy ? "Creating…" : "Create plan"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PlanDetailsDialog({
  planId,
  onClose,
}: {
  planId: string | null;
  onClose: () => void;
}) {
  const plan = useEditorStore((s) => s.draft?.plans.find((p) => p.id === planId));
  const index = useEditorStore((s) => s.draft?.plans.findIndex((p) => p.id === planId) ?? 0);
  return (
    <Dialog open={!!planId && !!plan} onOpenChange={(o) => !o && onClose()}>
      {plan ? (
        <DialogContent
          title="Plan details"
          description="Changes save automatically."
          className="w-[min(94vw,560px)]"
        >
          <PlanDetailsFields plan={plan} index={index} />
          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** Name, description, notes and appearance; reused in the editor's "Plan details" section. */
export function PlanDetailsFields({ plan, index }: { plan: Plan; index: number }) {
  const set = (patch: Partial<Plan>, label: string, key?: string) =>
    editPlan(plan.id, (p) => ({ ...p, ...patch }), label, key);
  return (
    <div className="flex flex-col gap-3">
      <FormField label="Name" error={plan.name.trim() ? undefined : "Required"}>
        {(id) => (
          <Input
            id={id}
            value={plan.name}
            maxLength={120}
            onChange={(e) => set({ name: e.target.value }, "Rename plan", "name")}
          />
        )}
      </FormField>
      <FormField label="Description" hint="One line shown on the plan card.">
        {(id) => (
          <Input
            id={id}
            value={plan.description ?? ""}
            maxLength={2000}
            onChange={(e) =>
              set({ description: e.target.value || undefined }, "Edit description", "desc")
            }
          />
        )}
      </FormField>
      <FormField label="Notes" hint="Assumptions, reasoning, things to revisit.">
        {(id) => (
          <Textarea
            id={id}
            rows={4}
            value={plan.notes ?? ""}
            onChange={(e) => set({ notes: e.target.value || undefined }, "Edit notes", "notes")}
          />
        )}
      </FormField>
      <FormField label="Colour & icon">
        {() => (
          <AppearancePicker
            value={plan.appearance}
            fallbackIndex={index}
            onChange={(appearance) => set({ appearance }, "Change appearance")}
          />
        )}
      </FormField>
    </div>
  );
}
