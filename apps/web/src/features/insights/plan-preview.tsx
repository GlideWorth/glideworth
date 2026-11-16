/**
 * Previewable plan change: runs the changed plan in the worker, shows before/after outcomes,
 * an overlay of net worth, the human-readable diff, and lets the user save it as a branch,
 * apply it, or send it to Compare.
 */
import type { PlanChange, ProjectionResult, SimulationInput } from "@glideworth/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, GitBranch, GitCompareArrows, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { SeriesChart } from "../../components/charts/series-chart";
import { ErrorState } from "../../components/charts/states";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { cn } from "../../lib/cn";
import { formatSigned } from "../../lib/format";
import { periodShortLabel } from "../../lib/period";
import { useActivePlan, useFormat } from "../../lib/workspace";
import { useScenarioStore } from "../compare/scenario-store";
import { attempt, bridge, diffFormat } from "../results/core-bridge";
import { outcomeOf, runVariant } from "./insights-model";
import type { Variant } from "./plan-edits";
import { applyToPlan, saveAsBranch } from "./save-plan";

export function Delta({
  label,
  before,
  after,
  fmt,
  higherIsBetter = true,
}: {
  label: string;
  before: number | null;
  after: number | null;
  fmt: (v: number) => string;
  higherIsBetter?: boolean;
}) {
  const d = before !== null && after !== null ? after - before : null;
  const good = d === null || Math.abs(d) < 1e-9 ? null : higherIsBetter ? d > 0 : d < 0;
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div className="num text-[15px] font-semibold">{after === null ? "—" : fmt(after)}</div>
      <div
        className={cn(
          "num text-[11.5px]",
          good === null ? "text-ink-3" : good ? "text-positive" : "text-negative",
        )}
      >
        {d === null
          ? `was ${before === null ? "—" : fmt(before)}`
          : formatSigned(d, fmt, "no change")}
        {d !== null && Math.abs(d) >= 0.5 ? " vs now" : ""}
      </div>
    </div>
  );
}

export function PlanChangePreview({
  input,
  base,
  variant,
  title,
  onDone,
}: {
  input: SimulationInput;
  base: ProjectionResult;
  variant: Variant;
  title: string;
  onDone?: () => void;
}) {
  const f = useFormat();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { plan, workspace } = useActivePlan();
  const addScenario = useScenarioStore((s) => s.add);
  const setCompare = useScenarioStore((s) => s.setCompare);
  const [name, setName] = useState(`${plan?.name ?? "Plan"} · ${title}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const q = useQuery({
    queryKey: [
      "variant",
      input.plan.id,
      input.plan.version,
      title,
      JSON.stringify(variant.changes),
      !!variant.market,
    ],
    queryFn: () => runVariant(input, variant),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const diff = useMemo((): PlanChange[] | null => {
    const r = attempt(() =>
      bridge.diffPlans(
        input.plan,
        variant.persist ?? variant.plan,
        diffFormat(input, f.locale, f.currency),
      ),
    );
    return r.value ? r.value.changes : null;
  }, [input, variant, f.locale, f.currency]);
  const b = outcomeOf(base);
  const a = q.data ? outcomeOf(q.data) : null;
  const persistable = variant.persist ?? (variant.market ? null : variant.plan);
  const money = (v: number) => f.money(v, true);

  const act = async (kind: "branch" | "apply" | "compare") => {
    if (!plan || !workspace) return;
    setErr(null);
    setBusy(kind);
    try {
      if (kind === "compare") {
        const id = `whatif-${Date.now().toString(36)}`;
        addScenario({
          id,
          name,
          basePlanId: plan.id,
          plan: variant.plan,
          ...(variant.market ? { market: variant.market } : {}),
          changes: variant.changes,
        });
        setCompare([plan.id, id]);
        await nav({ to: "/compare" });
      } else if (kind === "branch" && persistable) {
        await saveAsBranch(qc, workspace, plan, persistable, name, variant.changes.join("; "));
        setSaved("Saved as a branch");
      } else if (kind === "apply" && persistable) {
        await applyToPlan(qc, workspace, plan, persistable);
        setSaved("Applied to the plan");
        onDone?.();
      }
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2/50 p-3">
      <ul className="flex flex-col gap-0.5 text-[12.5px]">
        {(diff?.length ? diff.map((c) => c.description) : variant.changes).map((c) => (
          <li key={c} className="flex gap-1.5">
            <span className="text-accent">•</span> {c}
          </li>
        ))}
      </ul>
      {q.isLoading ? (
        <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
          <Loader2 className="size-3.5 animate-spin" /> Simulating the change…
        </div>
      ) : null}
      {q.error ? <ErrorState error={q.error} title="This change could not be simulated" /> : null}
      {a && q.data ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Delta
              label="End net worth"
              before={b.endNetWorthReal}
              after={a.endNetWorthReal}
              fmt={money}
            />
            <Delta
              label="Unfunded spending"
              before={b.totalShortfallReal}
              after={a.totalShortfallReal}
              fmt={money}
              higherIsBetter={false}
            />
            <Delta
              label="Lifetime tax"
              before={b.lifetimeTaxesReal}
              after={a.lifetimeTaxesReal}
              fmt={money}
              higherIsBetter={false}
            />
            <div>
              <div className="eyebrow">Outcome</div>
              <div
                className={cn(
                  "text-[15px] font-semibold",
                  a.success ? "text-positive" : "text-negative",
                )}
              >
                {a.success ? "Fully funded" : `Short from ${a.firstShortfallYear}`}
              </div>
              <div className="text-[11.5px] text-ink-3">
                was {b.success ? "fully funded" : `short from ${b.firstShortfallYear}`}
              </div>
            </div>
          </div>
          <SeriesChart
            labels={base.periods.map((p) => periodShortLabel(p))}
            format="money"
            locale={f.locale}
            currency={f.currency}
            height={180}
            ariaLabel="Net worth now versus with the change, in today's money"
            series={[
              {
                name: "Current plan",
                color: (t) => t.ink3,
                values: b.netWorthReal,
                dashed: true,
                width: 1.5,
              },
              { name: "With change", color: (t) => t.accent, values: a.netWorthReal, width: 2.25 },
            ]}
          />
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Name for the new branch"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-7 max-w-[280px] text-[12.5px]"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!!busy || !persistable}
          onClick={() => act("branch")}
          title={
            persistable
              ? undefined
              : "Market scenarios with non-fixed return assumptions can be compared but not saved as a plan"
          }
        >
          <GitBranch /> Save as branch
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!!busy || !persistable}
          onClick={() => act("apply")}
        >
          <Check /> Apply to plan
        </Button>
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("compare")}>
          <GitCompareArrows /> Compare
        </Button>
        {busy ? <Loader2 className="size-3.5 animate-spin text-ink-3" /> : null}
        {saved ? (
          <span className="text-[12px] text-positive">
            {saved}
            {workspace?.source === "sample" ? " (this session only)" : ""}
          </span>
        ) : null}
      </div>
      {err ? <ErrorState error={err} title="Could not save" /> : null}
    </div>
  );
}
