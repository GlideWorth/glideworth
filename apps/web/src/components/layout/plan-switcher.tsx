/**
 * Global active-plan switcher. Every analysis page follows the active plan; switching here is the
 * same as choosing a plan in the command palette. On the plan editor it also opens that plan.
 */
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Check, ChevronsUpDown, ListTree, SlidersHorizontal, Star } from "lucide-react";
import { DropdownMenu as M } from "radix-ui";
import { cn } from "../../lib/cn";
import { useActivePlan } from "../../lib/workspace";
import { useUi } from "../../stores/ui";
import { appearanceColor } from "../ui/appearance-picker";

export function PlanSwitcher({ className }: { className?: string }) {
  const { plan, plans } = useActivePlan();
  const setActive = useUi((s) => s.setActivePlan);
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const visible = plans.filter((p) => p.status !== "archived" || p.id === plan?.id);
  const archived = plans.length - visible.length;
  const choose = (id: string) => {
    setActive(id);
    if (/^\/plans\/.+/.test(path)) void navigate({ to: "/plans/$planId", params: { planId: id } });
  };
  return (
    <M.Root>
      <M.Trigger
        data-tour="plan-switcher"
        aria-label={plan ? `Active plan: ${plan.name}. Change plan` : "Choose a plan"}
        className={cn(
          "group flex h-8 min-w-0 items-center gap-2 rounded-md border border-border bg-surface pr-2 pl-2.5 text-left text-[13px] shadow-card transition-colors hover:border-border-strong data-[state=open]:border-focus",
          className,
        )}
      >
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ background: appearanceColor(plan?.appearance?.color, 0) }}
        />
        <span className="min-w-0 flex-1 truncate font-medium">{plan?.name ?? "No plans yet"}</span>
        {plan?.isMain ? (
          <Star className="size-3 shrink-0 fill-ochre text-ochre" aria-label="Main plan" />
        ) : null}
        <ChevronsUpDown className="size-3.5 shrink-0 text-ink-3 group-hover:text-ink-2" />
      </M.Trigger>
      <M.Portal>
        <M.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] w-[min(92vw,300px)] overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-pop"
        >
          <M.Label className="eyebrow px-2 pt-2 pb-1">Active plan</M.Label>
          {visible.length === 0 ? (
            <div className="px-2 py-2 text-[12.5px] text-ink-3">
              Create a plan to see projections.
            </div>
          ) : null}
          <M.RadioGroup value={plan?.id ?? ""} onValueChange={choose}>
            {visible.map((p, i) => (
              <M.RadioItem
                key={p.id}
                value={p.id}
                className="relative flex cursor-default items-center gap-2 rounded-md py-1.5 pr-2 pl-7 text-[13px] outline-none select-none data-[highlighted]:bg-surface-2"
              >
                <M.ItemIndicator className="absolute left-2">
                  <Check className="size-3.5 text-accent" />
                </M.ItemIndicator>
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: appearanceColor(p.appearance?.color, i) }}
                />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.isMain ? <span className="text-[11px] text-ink-3">Main</span> : null}
                {p.lineage ? <span className="text-[11px] text-ink-3">Branch</span> : null}
              </M.RadioItem>
            ))}
          </M.RadioGroup>
          {archived > 0 ? (
            <div className="px-2 pt-1 pb-1.5 text-[11.5px] text-ink-3">
              {archived} archived {archived === 1 ? "plan" : "plans"} hidden
            </div>
          ) : null}
          <M.Separator className="my-1 h-px bg-border" />
          <M.Item asChild>
            <Link
              to="/plans"
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-surface-2"
            >
              <ListTree className="size-3.5 text-ink-3" /> Manage plans
            </Link>
          </M.Item>
          {plan ? (
            <M.Item asChild>
              <Link
                to="/plans/$planId"
                params={{ planId: plan.id }}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-surface-2"
              >
                <SlidersHorizontal className="size-3.5 text-ink-3" /> Edit {plan.name}
              </Link>
            </M.Item>
          ) : null}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}
