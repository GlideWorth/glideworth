/**
 * What-If mode: stage changes to key assumptions as a temporary branch of the plan, see the live
 * projection against the baseline with metric deltas, then discard, save as a new branch, or apply
 * to the plan (one undo step). Nothing is saved until you choose.
 */

import {
  type GlideworthDocument,
  type Plan,
  type ProjectionResult,
  type SimulationInput,
  SimulationOptions,
} from "@glideworth/core";
import { useQueryClient } from "@tanstack/react-query";
import { Check, GitBranch, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { SeriesChart } from "../../../components/charts/series-chart";
import { Button } from "../../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { toast } from "../../../components/ui/toaster";
import { cn } from "../../../lib/cn";
import { total } from "../../../lib/money";
import { useFormat } from "../../../lib/workspace";
import { useUi } from "../../../stores/ui";
import { runSimulation } from "../../../workers/sim-client";
import { branchPlan } from "../../plans/plan-actions";
import { keyMetrics } from "../preview/use-live-projection";
import { editPlan, undo, useEditorStore } from "../state/doc-store";
import { capabilities, isNeutral, NEUTRAL, stage, type WhatIfSettings } from "./whatif-model";

function inputOf(doc: GlideworthDocument, plan: Plan): SimulationInput {
  const { lineage: _l, ...rest } = plan;
  return {
    household: doc.household,
    finances: doc.finances,
    plan: rest as Plan,
    options: SimulationOptions.parse({ strict: false, trace: "off" }),
  };
}

function Slider({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
  disabled,
  reason,
  neutral,
  hint,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  reason?: string | undefined;
  neutral: number;
  hint?: string;
}) {
  const changed = value !== neutral;
  return (
    <div className={cn("flex flex-col gap-1", disabled && "opacity-55")}>
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-[12.5px] font-medium" htmlFor={`wi-${label}`}>
          {label}
        </label>
        <span className="flex items-center gap-1.5">
          <span className={cn("num text-[13px] font-semibold", changed && "text-accent")}>
            {display}
          </span>
          <button
            type="button"
            aria-label={`Reset ${label}`}
            disabled={!changed || disabled}
            onClick={() => onChange(neutral)}
            className="text-ink-3 hover:text-ink disabled:invisible"
          >
            <RotateCcw className="size-3" />
          </button>
        </span>
      </div>
      <input
        id={`wi-${label}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={display}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--accent)]"
      />
      <div className="text-[11px] text-ink-3">{disabled ? reason : hint}</div>
    </div>
  );
}

function useSim(input: SimulationInput | null, key: string) {
  const [state, setState] = useState<{
    result: ProjectionResult | null;
    error: string | null;
    running: boolean;
  }>({
    result: null,
    error: null,
    running: false,
  });
  useEffect(() => {
    if (!input) return;
    let live = true;
    setState((s) => ({ ...s, running: true }));
    const t = setTimeout(() => {
      runSimulation(input)
        .then(({ result }) => live && setState({ result, error: null, running: false }))
        .catch(
          (e) =>
            live &&
            setState({
              result: null,
              error: e instanceof Error ? e.message : String(e),
              running: false,
            }),
        );
    }, 220);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the content of `input`
  }, [key]);
  return state;
}

function Metric({
  label,
  now,
  was,
  fmt,
  higherIsBetter = true,
  text,
}: {
  label: string;
  now: number | null;
  was: number | null;
  fmt: (v: number) => string;
  higherIsBetter?: boolean;
  text?: string;
}) {
  const d = now !== null && was !== null ? now - was : null;
  const good = d === null || Math.abs(d) < 0.5 ? null : higherIsBetter ? d > 0 : d < 0;
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface-2/40 px-3 py-2">
      <div className="eyebrow truncate">{label}</div>
      <div className="display num mt-0.5 truncate text-[19px] leading-tight font-semibold">
        {text ?? (now === null ? "—" : fmt(now))}
      </div>
      <div
        className={cn(
          "num mt-0.5 truncate text-[11.5px]",
          good === null ? "text-ink-3" : good ? "text-positive" : "text-negative",
        )}
      >
        {d === null
          ? was === null
            ? ""
            : `was ${fmt(was)}`
          : Math.abs(d) < 0.5
            ? "no change"
            : `${d > 0 ? "+" : "−"}${fmt(Math.abs(d))} vs baseline`}
      </div>
    </div>
  );
}

export function WhatIfPanel({ plan }: { plan: Plan }) {
  const doc = useEditorStore((s) => s.draft)!;
  const f = useFormat();
  const qc = useQueryClient();
  const basis = useUi((s) => s.basis);
  const [s, setS] = useState<WhatIfSettings>(NEUTRAL);
  const [name, setName] = useState(`${plan.name} · what if`);
  const [busy, setBusy] = useState(false);
  const input = useMemo(() => inputOf(doc, plan), [doc, plan]);
  const caps = useMemo(() => capabilities(input), [input]);
  const staged = useMemo(() => {
    try {
      return { value: stage(input, s, f) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [input, s, f]);
  const stagedPlan = "value" in staged ? staged.value : null;
  const baseKey = `${plan.id}:${plan.version}:${plan.updatedAt}:${JSON.stringify(plan).length}`;
  const base = useSim(input, baseKey);
  const whatIfInput = useMemo(
    () =>
      stagedPlan ? { ...input, plan: { ...stagedPlan.plan, lineage: undefined } as Plan } : null,
    [input, stagedPlan],
  );
  const alt = useSim(whatIfInput, `${baseKey}:${JSON.stringify(s)}`);
  const compare = stagedPlan ? alt.result : base.result;
  const a = keyMetrics(compare, stagedPlan?.plan ?? plan, basis);
  const b = keyMetrics(base.result, plan, basis);
  const money = (v: number) => f.money(v, true);
  const periods = base.result?.periods ?? [];
  const altByYear = new Map(compare?.periods.map((p) => [p.year, total(p, "netWorth", basis)]));
  const years = [
    ...new Set([...periods.map((p) => p.year), ...(compare?.periods.map((p) => p.year) ?? [])]),
  ].sort();
  const baseByYear = new Map(periods.map((p) => [p.year, total(p, "netWorth", basis)]));
  const taxReal = (r: ProjectionResult | null) => (r ? r.summary.lifetimeTaxesReal : null);

  const discard = () => setS(NEUTRAL);
  const apply = () => {
    if (!stagedPlan) return;
    const { ops } = stagedPlan;
    editPlan(
      plan.id,
      (p) => {
        const out = stage({ ...input, plan: p }, s, f);
        return out ? { ...out.plan, lineage: p.lineage } : p;
      },
      "Apply what-if",
    );
    setS(NEUTRAL);
    toast({
      title: "What-if applied to the plan",
      description: `${ops.length} change${ops.length === 1 ? "" : "s"}. Undo with ⌘/Ctrl+Z.`,
      action: {
        label: "Undo",
        onClick: () => {
          undo();
        },
      },
    });
  };
  const saveBranch = async () => {
    if (!stagedPlan) return;
    setBusy(true);
    try {
      const created = await branchPlan(qc, plan, name || `${plan.name} · what if`);
      editPlan(
        created.id,
        (p) => {
          const out = stage({ ...input, plan: p }, s, f);
          return out ? { ...out.plan, id: p.id, name: p.name, lineage: p.lineage } : p;
        },
        "Apply what-if to branch",
      );
      setS(NEUTRAL);
      toast({
        title: "Saved as a new branch",
        description: `“${created.name}” is in your plans, ready to compare.`,
      });
    } catch (e) {
      toast({
        title: "Couldn’t save the branch",
        description: e instanceof Error ? e.message : String(e),
        tone: "negative",
      });
    } finally {
      setBusy(false);
    }
  };

  const pct = (v: number, signed = true) =>
    `${signed && v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(1)} pts`;
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          eyebrow="What-If mode"
          title="Try changes without touching the plan"
          actions={
            !isNeutral(s) ? (
              <span className="flex items-center gap-2 text-[12px] text-accent">
                <span className="size-1.5 rounded-full bg-accent" /> Staged, not saved
              </span>
            ) : null
          }
        />
        <CardBody className="flex flex-col gap-6">
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <Slider
              label="Stock growth"
              value={s.growth}
              min={-0.05}
              max={0.05}
              step={0.001}
              neutral={0}
              disabled={!caps.growth.ok}
              reason={caps.growth.reason}
              display={
                caps.growth.ok
                  ? `${((caps.growth.base! + s.growth) * 100).toFixed(1)}% a year`
                  : "Not a fixed rate"
              }
              hint={
                s.growth ? pct(s.growth) : `Plan: ${((caps.growth.base ?? 0) * 100).toFixed(1)}%`
              }
              onChange={(v) => setS({ ...s, growth: v })}
            />
            <Slider
              label="Inflation"
              value={s.inflation}
              min={-0.02}
              max={0.05}
              step={0.001}
              neutral={0}
              disabled={!caps.inflation.ok}
              reason={caps.inflation.reason}
              display={
                caps.inflation.ok
                  ? `${((caps.inflation.base! + s.inflation) * 100).toFixed(1)}% a year`
                  : "Not a fixed rate"
              }
              hint={
                s.inflation
                  ? pct(s.inflation)
                  : `Plan: ${((caps.inflation.base ?? 0) * 100).toFixed(1)}%`
              }
              onChange={(v) => setS({ ...s, inflation: v })}
            />
            <Slider
              label="Retirement age"
              value={s.retireShift}
              min={-10}
              max={10}
              step={0.5}
              neutral={0}
              disabled={!caps.retirement.ok}
              reason={caps.retirement.reason}
              display={
                caps.retirement.ok
                  ? `${(caps.retirement.baseAge ?? 0) + s.retireShift}${caps.retirement.personName ? ` (${caps.retirement.personName})` : ""}`
                  : "Not an age"
              }
              hint={
                s.retireShift
                  ? `${Math.abs(s.retireShift)} years ${s.retireShift < 0 ? "earlier" : "later"}`
                  : "As planned"
              }
              onChange={(v) => setS({ ...s, retireShift: v })}
            />
            <Slider
              label="Spending"
              value={s.spending}
              min={0.5}
              max={1.5}
              step={0.01}
              neutral={1}
              disabled={!caps.spending.ok}
              reason={caps.spending.reason}
              display={`${Math.round(s.spending * 100)}% of plan`}
              hint={
                s.spending === 1
                  ? "All recurring expenses"
                  : `${s.spending > 1 ? "+" : "−"}${Math.round(Math.abs(s.spending - 1) * 100)}% on every expense`
              }
              onChange={(v) => setS({ ...s, spending: v })}
            />
            <Slider
              label="Savings"
              value={s.saving}
              min={0}
              max={2}
              step={0.05}
              neutral={1}
              disabled={!caps.saving.ok}
              reason={caps.saving.reason}
              display={`${Math.round(s.saving * 100)}% of plan`}
              hint={
                s.saving === 1
                  ? "All contribution flows"
                  : `${s.saving > 1 ? "+" : "−"}${Math.round(Math.abs(s.saving - 1) * 100)}% into every contribution`
              }
              onChange={(v) => setS({ ...s, saving: v })}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <div className="eyebrow">
                  Net worth, {basis === "real" ? "today's money" : "future money"}
                </div>
                {alt.running || base.running ? (
                  <span className="flex items-center gap-1 text-[11.5px] text-ink-3">
                    <Loader2 className="size-3 animate-spin" /> Simulating
                  </span>
                ) : null}
              </div>
              {base.result ? (
                <SeriesChart
                  labels={years.map(String)}
                  format="money"
                  locale={f.locale}
                  currency={f.currency}
                  height={260}
                  ariaLabel="Net worth for the baseline plan and for the what-if"
                  series={[
                    {
                      name: "Baseline",
                      color: (t) => t.ink3,
                      values: years.map((y) => baseByYear.get(y) ?? null),
                      dashed: true,
                      width: 1.75,
                    },
                    ...(stagedPlan
                      ? [
                          {
                            name: "What-if",
                            color: (t: { accent: string }) => t.accent,
                            values: years.map((y) => altByYear.get(y) ?? null),
                            width: 2.5,
                            type: "line" as const,
                          },
                        ]
                      : []),
                  ]}
                />
              ) : base.error ? (
                <p className="text-[12.5px] text-negative">{base.error}</p>
              ) : (
                <div className="h-[260px] animate-pulse rounded-lg bg-surface-2/60" />
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Metric
                label="At retirement"
                now={a?.atRetirement?.value ?? null}
                was={b?.atRetirement?.value ?? null}
                fmt={money}
              />
              <Metric
                label="Final net worth"
                now={a?.final?.value ?? null}
                was={b?.final?.value ?? null}
                fmt={money}
              />
              <Metric
                label="First shortfall"
                now={a?.firstShortfallYear ?? null}
                was={b?.firstShortfallYear ?? null}
                fmt={(v) => String(Math.round(v))}
                higherIsBetter
                text={a ? (a.firstShortfallYear ? String(a.firstShortfallYear) : "None") : "—"}
              />
              <Metric
                label="Lifetime tax"
                now={taxReal(compare)}
                was={taxReal(base.result)}
                fmt={money}
                higherIsBetter={false}
              />
            </div>
            {alt.error && stagedPlan ? (
              <p className="text-[12.5px] text-negative">{alt.error}</p>
            ) : null}
            {"error" in staged ? (
              <p className="text-[12.5px] text-negative">{staged.error}</p>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Staged changes"
          title={
            stagedPlan
              ? `${stagedPlan.changes.length || stagedPlan.ops.length} change${(stagedPlan.changes.length || stagedPlan.ops.length) === 1 ? "" : "s"}`
              : "Nothing staged yet"
          }
        />
        <CardBody className="flex flex-col gap-3">
          {stagedPlan ? (
            <ul className="flex flex-col gap-0.5 text-[12.5px]">
              {(stagedPlan.changes.length
                ? stagedPlan.changes.map((c) => c.description)
                : stagedPlan.ops.map((o) => `${o.op} ${o.path}`)
              ).map((d) => (
                <li key={d} className="flex gap-1.5">
                  <span className="text-accent">•</span> {d}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-ink-3">
              Move a slider to stage a change. The chart shows it against the baseline straight
              away.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Name for the new branch"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8 max-w-[280px] text-[12.5px]"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!stagedPlan || busy}
              onClick={saveBranch}
            >
              {busy ? <Loader2 className="animate-spin" /> : <GitBranch />} Save as new branch
            </Button>
            <Button size="sm" variant="primary" disabled={!stagedPlan || busy} onClick={apply}>
              <Check /> Apply to plan
            </Button>
            <Button size="sm" variant="ghost" disabled={!stagedPlan} onClick={discard}>
              <Trash2 /> Discard
            </Button>
          </div>
          <p className="text-[11.5px] text-ink-3">
            Applying is one undo step. A branch keeps the original plan untouched and follows later
            changes to it.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
