import {
  type Explanation,
  type Finding,
  FREQUENCY_PER_YEAR,
  type GoalSeekResult,
  type MonteCarloSettings,
  type Plan,
  type ProjectionResult,
  RiskGuardrails,
  type SimulationInput,
  scalableFlowIds,
} from "@glideworth/core";
import {
  AlertTriangle,
  CircleAlert,
  Gauge,
  Info,
  Loader2,
  Play,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  Wrench,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Chart } from "../../components/charts/echarts";
import { slotColor } from "../../components/charts/palette";
import { SeriesChart } from "../../components/charts/series-chart";
import {
  ChartLoading,
  EmptyState,
  ErrorState,
  ExampleBadge,
  NotAvailable,
  notImplementedInfo,
} from "../../components/charts/states";
import {
  axisStyle,
  baseOption,
  type ChartTokens,
  tooltipHeader,
  tooltipRow,
} from "../../components/charts/tokens";
import { Page } from "../../components/layout/app-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Field, Input } from "../../components/ui/input";
import { Segmented } from "../../components/ui/segmented";
import { Select } from "../../components/ui/select";
import { cn } from "../../lib/cn";
import { formatMoney, formatMonth, formatSigned } from "../../lib/format";
import { total } from "../../lib/money";
import { useFormat } from "../../lib/workspace";
import { runChanceOfSuccess } from "../chance/mc-pool";
import { CrossBorderFix } from "../crossborder/audit-fix";
import { RelocationPanel } from "../crossborder/relocation-panel";
import { attempt, bridge } from "../results/core-bridge";
import { exampleExplanation, exampleFindings, exampleGoalSeek } from "../results/fixtures";
import type { EntityIndex } from "../results/model";
import { yearNarrative } from "../results/narrative";
import { useAnalysis } from "../results/use-analysis";
import { DebtPayoffPanel, SeppPanel, StrategyMatrixPanel } from "./analysis-panels";
import {
  DRIVERS,
  outcomeOf,
  runSensitivity,
  runVariant,
  SCENARIOS,
  type SensitivityMetric,
  type TornadoRow,
} from "./insights-model";
import { scaleExpenses, scaleFlows, type Variant } from "./plan-edits";
import { PlanChangePreview, SOLVER_PROJECTION_NOTE } from "./plan-preview";
import { SurvivorPanel, TemplateGallery } from "./scenario-panels";
import { TaxStrategyPanel } from "./tax-strategy-panel";

// ---------------------------------------------------------------------------------------------
// Why did this fail?
// ---------------------------------------------------------------------------------------------

function WhyCard({
  input,
  result,
  index,
}: {
  input: SimulationInput;
  result: ProjectionResult;
  index: EntityIndex;
}) {
  const f = useFormat();
  const [example, setExample] = useState(false);
  const ex = useMemo(
    () => attempt(() => bridge.explainProjection(input, result, "why did this plan fail?")),
    [input, result],
  );
  const explanation: Explanation | undefined = example ? exampleExplanation(result) : ex.value;
  const failIdx = result.periods.findIndex((p) => p.status === "shortfall");
  const local =
    failIdx >= 0 ? yearNarrative(result, failIdx, "real", index, f.money, (v) => f.percent(v)) : [];
  return (
    <Card>
      <CardHeader
        eyebrow="Explain"
        title={result.summary.success ? "Why this plan works" : "Why did this plan fail?"}
        actions={example ? <ExampleBadge onExit={() => setExample(false)} /> : null}
      />
      <CardBody className="flex flex-col gap-3">
        {explanation ? (
          <>
            <p className="text-[14px] font-medium leading-snug">{explanation.headline}</p>
            <ul className="flex flex-col gap-2">
              {explanation.findings.map((x) => (
                <li key={x.code + x.title} className="flex gap-2 text-[13px]">
                  <SeverityIcon s={x.severity} />
                  <div>
                    <div className="font-medium">{x.title}</div>
                    {x.message ? <div className="text-ink-2">{x.message}</div> : null}
                    {x.periodIndex !== null && result.periods[x.periodIndex] ? (
                      <div className="text-[11.5px] text-ink-3">
                        In {result.periods[x.periodIndex]!.year}
                      </div>
                    ) : null}
                    {x.evidence.length ? (
                      <div className="text-[11px] text-ink-3">
                        {x.evidence.length} piece{x.evidence.length > 1 ? "s" : ""} of evidence from
                        the engine trace and ledger
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            {result.summary.success ? (
              <p className="text-[13.5px]">
                Every year is funded under the plan's assumptions; it ends with{" "}
                <span className="num font-semibold">
                  {f.money(result.summary.endNetWorthReal, true)}
                </span>{" "}
                in today's money. Run Chance of success to see how often that holds when markets
                vary.
              </p>
            ) : (
              <>
                <p className="text-[14px] font-medium">
                  Money first runs short in {result.summary.firstShortfallYear};{" "}
                  {f.money(
                    result.periods.reduce((s, p) => s + total(p, "shortfall", "real"), 0),
                    true,
                  )}{" "}
                  of spending goes unfunded over the plan (today's money).
                </p>
                <ul className="flex flex-col gap-1.5">
                  {local.map((l) => (
                    <li key={l.text} className="flex gap-2 text-[13px]">
                      {l.tone === "negative" ? (
                        <TrendingDown className="mt-0.5 size-3.5 shrink-0 text-negative" />
                      ) : (
                        <Info className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                      )}
                      {l.text}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {ex.error && notImplementedInfo(ex.error) ? (
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                Full explanations (drivers and evidence) are not available in this version.
                <Button size="sm" variant="ghost" onClick={() => setExample(true)}>
                  Preview example
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function SeverityIcon({ s }: { s: Finding["severity"] }) {
  return s === "critical" ? (
    <CircleAlert className="mt-0.5 size-4 shrink-0 text-negative" aria-label="Critical" />
  ) : s === "warning" ? (
    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Warning" />
  ) : (
    <Info className="mt-0.5 size-4 shrink-0 text-ink-3" aria-label="Info" />
  );
}

// ---------------------------------------------------------------------------------------------
// Goal seek
// ---------------------------------------------------------------------------------------------

type SeekKind = "spending" | "retirement" | "savings";

function monthFromOffset(asOf: string, offset: number): string {
  const [y, m] = asOf.split("-").map(Number);
  const t = y! * 12 + (m! - 1) + Math.round(offset);
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

function variantFromSeek(
  kind: SeekKind,
  r: GoalSeekResult,
  plan: Plan,
  asOf: string,
  target: { milestoneId?: string; flowId?: string },
): Variant | null {
  if (r.value === null) return null;
  const patch = (r as { patch?: Parameters<typeof bridge.applyPlanPatch>[1] }).patch;
  if (patch?.length) {
    const applied = attempt(() => bridge.applyPlanPatch(plan, patch));
    if (applied.value) return { plan: applied.value, changes: [r.explanation] };
  }
  if (kind === "spending") return scaleExpenses(plan, r.value);
  if (kind === "savings" && target.flowId) return scaleFlows(plan, r.value, [target.flowId]);
  if (kind === "retirement" && target.milestoneId) {
    const p = structuredClone(plan);
    const date = monthFromOffset(asOf, r.value);
    p.milestones = p.milestones.map((m) =>
      m.id === target.milestoneId ? { ...m, criteria: [{ kind: "date", date, when: "at" }] } : m,
    );
    return { plan: p, changes: [`Retirement set to ${date}`] };
  }
  return null;
}

function GoalSeekPanel({
  input,
  result,
  plan,
  asOf,
}: {
  input: SimulationInput;
  result: ProjectionResult;
  plan: Plan;
  asOf: string;
}) {
  const f = useFormat();
  const [kind, setKind] = useState<SeekKind>("spending");
  const [target, setTarget] = useState(0.9);
  const [trials, setTrials] = useState(300);
  const retireMs = plan.milestones.filter((m) => m.kind === "retirement");
  // Only flows with an amount or share can be solved for; `max` flows fill a limit (core decides).
  const scalable = new Set(scalableFlowIds(plan));
  const flows = plan.flows.filter((x) => scalable.has(x.id));
  const unsolvable = plan.flows.filter((x) => x.kind === "contribution" && !scalable.has(x.id));
  const [milestoneId, setMilestoneId] = useState(retireMs[0]?.id ?? "");
  const [flowId, setFlowId] = useState(flows[0]?.id ?? "");
  const [state, setState] = useState<{
    status: "idle" | "running" | "done" | "error";
    result?: GoalSeekResult;
    error?: unknown;
    example?: boolean;
    evals: number;
  }>({ status: "idle", evals: 0 });
  const abort = useRef<AbortController | null>(null);

  const run = async () => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setState({ status: "running", evals: 0 });
    const mc: MonteCarloSettings = {
      ...plan.monteCarlo,
      trials,
      seed: plan.monteCarlo.seed ?? 20260101,
    };
    const deps = {
      signal: ac.signal,
      evaluate: (inp: SimulationInput) =>
        runChanceOfSuccess(inp, inp.plan.monteCarlo ?? mc, { signal: ac.signal }),
      onProgress: (n: unknown) =>
        setState((s) => ({ ...s, evals: typeof n === "number" ? n : s.evals + 1 })),
    };
    try {
      const r =
        kind === "spending"
          ? await bridge.solveMaxSpending(
              input,
              { targetSuccessRate: target, monteCarlo: mc },
              deps,
            )
          : kind === "retirement"
            ? await bridge.solveEarliestRetirement(
                input,
                { milestoneId, targetSuccessRate: target, monteCarlo: mc },
                deps,
              )
            : await bridge.solveRequiredSavings(
                input,
                { flowId, targetSuccessRate: target, monteCarlo: mc },
                deps,
              );
      setState({ status: "done", result: r, evals: r.evaluations.length });
    } catch (e) {
      if (ac.signal.aborted) setState({ status: "idle", evals: 0 });
      else setState({ status: "error", error: e, evals: 0 });
    }
  };
  const r = state.result;
  const variant = r ? variantFromSeek(kind, r, plan, asOf, { milestoneId, flowId }) : null;
  // Sorted by the variable, not by the order the search tried them. A category axis would draw
  // each evaluation at equal width and repeat labels where the search clusters on the answer.
  const curve =
    r && r.evaluations.length > 1 ? [...r.evaluations].sort((a, b) => a.value - b.value) : null;
  const formatCurveX = (v: number) =>
    kind === "retirement" ? monthFromOffset(asOf, v) : f.percent(v, 0);
  const answer = (v: number | null) => {
    if (v === null) return "No answer in range";
    if (kind === "spending") return `${v >= 1 ? "+" : ""}${f.percent(v - 1, 0)} spending`;
    if (kind === "savings") return `${f.percent(v, 0)} of current contributions`;
    return formatMonth(monthFromOffset(asOf, v), f.locale);
  };
  // What the solver scales: recurring spending lines as entered (today's money), the same base it
  // reports its answer against. Projected spending also includes housing and debt costs, which the
  // solver leaves alone, so it would not match the answer's "planned" figure.
  const baselineSpending = plan.expenses
    .filter(
      (e) =>
        e.enabled &&
        e.frequency !== "once" &&
        e.spendingType !== "not-spending" &&
        e.type !== "tax-payment" &&
        e.type !== "tax-deduction",
    )
    .reduce((s, e) => s + e.amount.value * FREQUENCY_PER_YEAR[e.frequency], 0);

  return (
    <Card>
      <CardHeader
        eyebrow="Goal seek"
        title="Solve for the number you need"
        actions={state.example ? <ExampleBadge /> : null}
      />
      <CardBody className="flex flex-col gap-4">
        <Segmented
          aria-label="What to solve for"
          value={kind}
          onChange={(k) => {
            setKind(k);
            setState({ status: "idle", evals: 0 });
          }}
          options={[
            { value: "spending", label: "Max spending" },
            { value: "retirement", label: "Earliest retirement" },
            { value: "savings", label: "Required savings" },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={`Target chance of success: ${f.percent(target, 0)}`}>
            {(id) => (
              <input
                id={id}
                type="range"
                min={0.5}
                max={0.99}
                step={0.01}
                value={target}
                onChange={(e) => setTarget(Number(e.target.value))}
                className="accent-[var(--accent)]"
              />
            )}
          </Field>
          {kind === "retirement" ? (
            <Field label="Milestone">
              {(id) => (
                <Select
                  id={id}
                  value={milestoneId}
                  onValueChange={setMilestoneId}
                  options={retireMs.map((m) => ({ value: m.id, label: m.name }))}
                  placeholder="No retirement milestone"
                />
              )}
            </Field>
          ) : kind === "savings" ? (
            <Field label="Contribution">
              {(id) => (
                <Select
                  id={id}
                  value={flowId}
                  onValueChange={setFlowId}
                  options={flows.map((x) => ({ value: x.id, label: x.name }))}
                  placeholder="No flow with an amount to solve for"
                />
              )}
            </Field>
          ) : (
            <div className="text-[12px] text-ink-3 sm:pt-5">
              Scales every spending line together. Planned today: {f.money(baselineSpending, true)}{" "}
              a year.
            </div>
          )}
          <Field
            label="Trials per evaluation"
            hint="Fixed seed: every candidate sees the same markets"
          >
            {(id) => (
              <Input
                id={id}
                type="number"
                min={100}
                max={2000}
                step={100}
                value={trials}
                onChange={(e) =>
                  setTrials(Math.max(100, Math.min(2000, Number(e.target.value) || 100)))
                }
              />
            )}
          </Field>
        </div>
        {kind === "savings" && unsolvable.length ? (
          <p className="text-[12px] text-ink-3">
            {unsolvable.map((x) => x.name).join(", ")} {unsolvable.length === 1 ? "fills" : "fill"}{" "}
            an allowance (“as much as possible”), so there is no amount to solve for. Give{" "}
            {unsolvable.length === 1 ? "it" : "them"} a fixed amount or a share to include{" "}
            {unsolvable.length === 1 ? "it" : "them"} here.
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          {state.status === "running" ? (
            <>
              <Button variant="secondary" onClick={() => abort.current?.abort()}>
                Cancel
              </Button>
              <span className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
                <Loader2 className="size-3.5 animate-spin" /> Searching…{" "}
                {state.evals ? `${state.evals} evaluations` : ""}
              </span>
            </>
          ) : (
            <Button
              variant="primary"
              onClick={run}
              disabled={(kind === "retirement" && !milestoneId) || (kind === "savings" && !flowId)}
            >
              <Search /> Solve
            </Button>
          )}
        </div>
        {state.status === "error" ? (
          notImplementedInfo(state.error) ? (
            <NotAvailable
              what="Goal seek"
              error={state.error}
              onPreview={() => {
                const cur =
                  kind === "retirement"
                    ? result.periods.findIndex((p) => p.year === result.summary.retirementYear) *
                        12 || 120
                    : 1;
                setState({
                  status: "done",
                  result: exampleGoalSeek(kind, cur),
                  example: true,
                  evals: 6,
                });
              }}
            />
          ) : (
            <ErrorState error={state.error} title="The solver failed" />
          )
        ) : null}
        {r ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
              <div>
                <div className="eyebrow">Answer at {f.percent(target, 0)}</div>
                <div className="display num text-[26px] font-semibold">{answer(r.value)}</div>
              </div>

              {r.achieved !== null ? (
                <Badge tone="accent">{f.percent(r.achieved)} achieved</Badge>
              ) : null}
              <Badge>{r.evaluations.length} evaluations</Badge>
            </div>
            <p className="text-[13px] text-ink-2">{r.explanation}</p>
            {r.sensitivity.length ? (
              <div className="flex flex-wrap gap-2">
                {r.sensitivity.map((s) => (
                  <span key={s.label} className="rounded-md bg-surface-2 px-2 py-1 text-[12px]">
                    {s.label}: <span className="num font-medium">{answer(s.value)}</span>
                  </span>
                ))}
              </div>
            ) : null}
            {curve ? (
              <SeriesChart
                labels={curve.map((e) => formatCurveX(e.value))}
                xValues={curve.map((e) => e.value)}
                formatX={formatCurveX}
                format="percent"
                locale={f.locale}
                height={160}
                ariaLabel="Success rate at each value the solver tried"
                refLines={[{ value: target, label: "target" }]}
                series={[
                  {
                    name: "Chance of success",
                    color: (t) => t.accent,
                    values: curve.map((e) => e.metric),
                    symbol: true,
                  },
                ]}
              />
            ) : null}
            {variant ? (
              <PlanChangePreview
                input={input}
                base={result}
                variant={variant}
                projectionNote={SOLVER_PROJECTION_NOTE}
                title={
                  kind === "spending"
                    ? "max spending"
                    : kind === "retirement"
                      ? "earliest retirement"
                      : "required savings"
                }
              />
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------------------------

function GuardrailsPanel({ input, plan }: { input: SimulationInput; plan: Plan }) {
  const f = useFormat();
  const [state, setState] = useState<{
    status: "idle" | "running" | "done" | "error";
    value?: Awaited<ReturnType<typeof bridge.evaluateGuardrails>>;
    error?: unknown;
    example?: boolean;
  }>({ status: "idle" });
  const g =
    plan.riskGuardrails ?? RiskGuardrails.parse({ enabled: true, start: { kind: "planStart" } });
  const run = async () => {
    setState({ status: "running" });
    try {
      const v = await bridge.evaluateGuardrails(input, g, {
        evaluate: (inp: SimulationInput) =>
          runChanceOfSuccess(inp, {
            ...inp.plan.monteCarlo,
            trials: 300,
            seed: inp.plan.monteCarlo.seed ?? 20260101,
          }),
      });
      setState({ status: "done", value: v });
    } catch (e) {
      setState({ status: "error", error: e });
    }
  };
  const preview = () => {
    const start = Number(input.finances.asOf.slice(0, 4));
    const spend = 52000;
    const path = Array.from({ length: 25 }, (_, i) => {
      const sr = 0.82 + Math.sin(i / 3) * 0.12;
      const action: "cut" | "raise" | "hold" =
        sr < g.lowerGuardrail ? "cut" : sr > g.upperGuardrail ? "raise" : "hold";
      return {
        year: start + i,
        successRate: sr,
        spendingReal: spend * (1 + Math.sin(i / 3) * 0.08),
        action,
      };
    });
    setState({
      status: "done",
      example: true,
      value: {
        current: path[0]!,
        path,
        explanation:
          "Example: spending stays inside the guardrails most years; cut 10% when the chance of success drops below 70%.",
      },
    });
  };
  const v = state.value;
  return (
    <Card>
      <CardHeader
        eyebrow="Guardrails"
        title="Where the guardrails put spending this year"
        actions={state.example ? <ExampleBadge /> : null}
      />
      <CardBody className="flex flex-col gap-3">
        <div className="text-[12.5px] text-ink-2">
          Keep the chance of success between{" "}
          <span className="num font-semibold">{f.percent(g.lowerGuardrail, 0)}</span> and{" "}
          <span className="num font-semibold">{f.percent(g.upperGuardrail, 0)}</span> (target{" "}
          {f.percent(g.targetSuccess, 0)}); adjust{" "}
          {g.scope === "discretionary" ? "discretionary" : "all"} spending in{" "}
          {f.percent(g.adjustmentStep, 0)} steps.
          {plan.riskGuardrails ? "" : " (Default settings — set your own in the plan editor.)"}
        </div>
        {state.status !== "done" ? (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={run} disabled={state.status === "running"}>
              {state.status === "running" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}{" "}
              Evaluate guardrails
            </Button>
          </div>
        ) : null}
        {state.status === "error" ? (
          notImplementedInfo(state.error) ? (
            <NotAvailable what="Guardrails" error={state.error} onPreview={preview} />
          ) : (
            <ErrorState error={state.error} />
          )
        ) : null}
        {v ? (
          <>
            <div
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2",
                v.current.action === "cut"
                  ? "bg-negative-soft"
                  : v.current.action === "raise"
                    ? "bg-accent-soft"
                    : "bg-surface-2",
              )}
            >
              <Gauge className="size-5 text-ink-2" />
              <div>
                <div className="font-semibold">
                  {v.current.action === "cut"
                    ? "Guardrails cut spending"
                    : v.current.action === "raise"
                      ? "Guardrails allow more spending"
                      : "Guardrails hold spending"}{" "}
                  in {v.current.year}:{" "}
                  <span className="num">{f.money(v.current.spendingReal)}</span>
                </div>
                <div className="text-[12px] text-ink-2">
                  Chance of success at that level: {f.percent(v.current.successRate, 0)}.{" "}
                  {v.explanation}
                </div>
              </div>
            </div>
            {v.targetReachable === false || v.thresholds?.targetReachable === false ? (
              <div className="flex gap-2 rounded-md bg-ochre-soft px-3 py-2 text-[12.5px]">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-ochre" />
                <span>
                  Cutting {g.scope === "discretionary" ? "discretionary" : "in-scope"} spending
                  alone cannot bring the chance of success back to {f.percent(g.targetSuccess, 0)}.
                  Even at the deepest cut it is about {f.percent(v.current.successRate, 0)}. The
                  model&rsquo;s other levers are retiring later, saving more and reducing essential
                  costs.
                </span>
              </div>
            ) : null}
            {v.thresholds ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-md bg-surface-2 px-3 py-2 text-[12.5px]">
                  <div className="eyebrow mb-0.5">Lower guardrail</div>
                  {v.thresholds.lowerPortfolio !== null && v.thresholds.cutTo !== null ? (
                    <>
                      If investments fall below{" "}
                      <span className="num font-semibold">
                        {f.money(v.thresholds.lowerPortfolio, true)}
                      </span>
                      , the lower guardrail rule would cut spending to{" "}
                      <span className="num font-semibold">{f.money(v.thresholds.cutTo)}</span> a
                      year.
                    </>
                  ) : (
                    <span className="text-ink-3">
                      No further cut is shown: there is no in-scope spending left to cut.
                    </span>
                  )}
                </div>
                <div className="rounded-md bg-surface-2 px-3 py-2 text-[12.5px]">
                  <div className="eyebrow mb-0.5">Upper guardrail</div>
                  {v.thresholds.upperPortfolio !== null && v.thresholds.raiseTo !== null ? (
                    <>
                      If investments rise above{" "}
                      <span className="num font-semibold">
                        {f.money(v.thresholds.upperPortfolio, true)}
                      </span>
                      , the upper guardrail rule would allow spending of{" "}
                      <span className="num font-semibold">{f.money(v.thresholds.raiseTo)}</span> a
                      year.
                    </>
                  ) : (
                    <span className="text-ink-3">
                      No higher spending level meets the target at the current guardrail result.
                    </span>
                  )}
                </div>
              </div>
            ) : null}
            <div className="grid gap-3 lg:grid-cols-2">
              <SeriesChart
                labels={v.path.map((p) => String(p.year))}
                format="money"
                locale={f.locale}
                currency={f.currency}
                height={180}
                ariaLabel="Guardrail spending path"
                series={[
                  {
                    name: "Spending (today’s money)",
                    color: (t) => slotColor(t.theme, 1),
                    values: v.path.map((p) => p.spendingReal),
                    type: "area",
                  },
                ]}
                tooltipExtra={(i) => tooltipRow(null, "Action", v.path[i]!.action)}
              />
              <SeriesChart
                labels={v.path.map((p) => String(p.year))}
                format="percent"
                locale={f.locale}
                height={180}
                yMin={0}
                yMax={1}
                ariaLabel="Chance of success along the guardrail path"
                refLines={[
                  { value: g.lowerGuardrail, label: "lower" },
                  { value: g.upperGuardrail, label: "upper" },
                ]}
                series={[
                  {
                    name: "Chance of success",
                    color: (t) => t.accent,
                    values: v.path.map((p) => p.successRate),
                  },
                ]}
              />
            </div>
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Assumption audit
// ---------------------------------------------------------------------------------------------

function AuditPanel({ input, result }: { input: SimulationInput; result: ProjectionResult }) {
  const audit = useMemo(
    () => attempt(() => bridge.auditAssumptions(input, result)),
    [input, result],
  );
  const [example, setExample] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const findings = example ? exampleFindings(result) : (audit.value ?? null);
  return (
    <Card>
      <CardHeader
        eyebrow="Assumption audit"
        title="Checks on your inputs"
        actions={
          example ? (
            <ExampleBadge onExit={() => setExample(false)} />
          ) : findings ? (
            <Badge>{findings.length} found</Badge>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-2">
        {!findings && audit.error ? (
          <NotAvailable
            what="The assumption audit"
            error={audit.error}
            onPreview={() => setExample(true)}
          />
        ) : null}
        {findings && findings.length === 0 ? (
          <EmptyState icon={<ShieldCheck className="size-5" />} title="No issues found" />
        ) : null}
        {findings?.map((x) => {
          const fix = (
            x as Finding & {
              fix?: { description: string; patch: Parameters<typeof bridge.applyPlanPatch>[1] };
            }
          ).fix;
          const key = x.code + x.title;
          const fixed = fix ? attempt(() => bridge.applyPlanPatch(input.plan, fix.patch)) : null;
          return (
            <div key={key} className="rounded-md border border-border px-3 py-2">
              <div className="flex gap-2">
                <SeverityIcon s={x.severity} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{x.title}</div>
                  <div className="text-[12.5px] text-ink-2">{x.message}</div>
                  {x.suggestion ? (
                    <div className="mt-0.5 text-[12.5px]">
                      <span className="text-ink-3">Example change:</span> {x.suggestion}
                    </div>
                  ) : null}
                </div>
                {x.code.startsWith("XB_") ? (
                  <CrossBorderFix code={x.code} planId={input.plan.id} />
                ) : null}
                {fix && fixed?.value ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setOpen(open === key ? null : key)}
                  >
                    <Wrench /> {open === key ? "Hide" : "Preview this change"}
                  </Button>
                ) : null}
              </div>
              {open === key && fix && fixed?.value ? (
                <div className="mt-2">
                  <PlanChangePreview
                    input={input}
                    base={result}
                    variant={{ plan: fixed.value, changes: [fix.description] }}
                    title={fix.description}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
        {example ? (
          <div className="text-[11.5px] text-ink-3">
            Example findings show the layout; one-click fixes appear when the audit returns
            machine-applicable patches.
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Sensitivity tornado
// ---------------------------------------------------------------------------------------------

function Tornado({
  rows,
  base,
  metric,
}: {
  rows: TornadoRow[];
  base: number;
  metric: SensitivityMetric;
}) {
  const f = useFormat();
  const build = useCallback(
    (t: ChartTokens) => {
      const fmt = (v: number) =>
        metric === "endNetWorth"
          ? formatMoney(v, { locale: f.locale, currency: f.currency, compact: true })
          : `${Math.round(v)} yrs`;
      const ax = axisStyle(t);
      const labels = rows.map((r) => r.label).reverse();
      const rev = [...rows].reverse();
      const d = (v: number | null) => (v === null ? 0 : v - base);
      const maxAbs = Math.max(1, ...rev.flatMap((r) => [Math.abs(d(r.low)), Math.abs(d(r.high))]));
      const fits = (v: number) => Math.abs(v) > maxAbs * 0.14;
      return {
        ...baseOption(t),
        grid: { left: 8, right: 16, top: 30, bottom: 8, containLabel: true },
        legend: { ...baseOption(t).legend, data: ["Downside case", "Upside case"] },
        tooltip: {
          ...baseOption(t).tooltip,
          trigger: "axis",
          axisPointer: { type: "shadow", shadowStyle: { color: `${t.ink3}14` } },
          formatter: (ps: { dataIndex: number }[]) => {
            const r = rev[ps[0]?.dataIndex ?? 0]!;
            return `${tooltipHeader(r.label)}${tooltipRow(slotColor(t.theme, 3), r.lowLabel, r.low === null ? "n/a" : `${fmt(r.low)} (${d(r.low) >= 0 ? "+" : "−"}${fmt(Math.abs(d(r.low)))})`)}${tooltipRow(slotColor(t.theme, 0), r.highLabel, r.high === null ? "n/a" : `${fmt(r.high)} (${d(r.high) >= 0 ? "+" : "−"}${fmt(Math.abs(d(r.high)))})`)}${tooltipRow(null, "Current plan", fmt(base), true)}`;
          },
        },
        xAxis: {
          type: "value",
          ...ax,
          axisLabel: {
            ...ax.axisLabel,
            formatter: (v: number) => `${v >= 0 ? "+" : "−"}${fmt(Math.abs(v))}`,
          },
        },
        yAxis: {
          type: "category",
          data: labels,
          ...ax,
          axisLabel: { ...ax.axisLabel, color: t.ink2, fontSize: 11.5 },
          splitLine: { show: false },
        },
        series: [
          {
            name: "Downside case",
            type: "bar",
            stack: "a",
            barWidth: "58%",
            itemStyle: { color: slotColor(t.theme, 3), borderRadius: 3 },
            data: rev.map((r) => d(r.low)),
            label: {
              show: true,
              position: "insideLeft",
              formatter: (p: { dataIndex: number }) =>
                fits(d(rev[p.dataIndex]!.low)) ? rev[p.dataIndex]!.lowLabel : "",
              color: "#fff",
              fontSize: 10.5,
            },
          },
          {
            name: "Upside case",
            type: "bar",
            stack: "b",
            barGap: "-100%",
            barWidth: "58%",
            itemStyle: { color: slotColor(t.theme, 0), borderRadius: 3 },
            data: rev.map((r) => d(r.high)),
            label: {
              show: true,
              position: "insideRight",
              formatter: (p: { dataIndex: number }) =>
                fits(d(rev[p.dataIndex]!.high)) ? rev[p.dataIndex]!.highLabel : "",
              color: "#fff",
              fontSize: 10.5,
            },
            markLine: {
              symbol: "none",
              silent: true,
              data: [{ xAxis: 0 }],
              lineStyle: { color: t.ink, width: 1.5, type: "solid" },
              label: { show: false },
            },
          },
        ],
      };
    },
    [rows, base, metric, f],
  );
  return (
    <Chart
      build={build}
      height={Math.max(220, rows.length * 38 + 50)}
      ariaLabel="Tornado chart: change in the outcome when each assumption moves up or down, largest effect first"
    />
  );
}

function SensitivityPanel({ input, result }: { input: SimulationInput; result: ProjectionResult }) {
  const f = useFormat();
  const [metric, setMetric] = useState<SensitivityMetric>("endNetWorth");
  const [state, setState] = useState<{
    running: boolean;
    done: number;
    total: number;
    data?: { base: number; rows: TornadoRow[] };
    error?: unknown;
  }>({ running: false, done: 0, total: DRIVERS.length * 2 });
  const run = async (m = metric) => {
    setState({ running: true, done: 0, total: DRIVERS.length * 2 });
    try {
      const data = await runSensitivity(input, result, m, (done, total) =>
        setState((s) => ({ ...s, done, total })),
      );
      setState({ running: false, done: 0, total: 0, data });
    } catch (e) {
      setState({ running: false, done: 0, total: 0, error: e });
    }
  };
  return (
    <Card>
      <CardHeader
        eyebrow="Sensitivity"
        title="Which assumptions matter most"
        actions={
          <Segmented
            aria-label="Outcome measured"
            size="sm"
            value={metric}
            onChange={(m) => {
              setMetric(m);
              if (state.data) run(m);
            }}
            options={[
              { value: "endNetWorth", label: "End net worth" },
              { value: "fundedYears", label: "Years funded" },
            ]}
          />
        }
      />
      <CardBody className="flex flex-col gap-3">
        {!state.data && !state.running ? (
          <EmptyState
            icon={<Sparkles className="size-5" />}
            title="Stress each assumption one at a time"
            action={
              <Button variant="primary" size="sm" onClick={() => run()}>
                <Play /> Run {DRIVERS.length * 2} simulations
              </Button>
            }
          >
            Moves returns, inflation, spending, retirement age, earnings, contributions and lifespan
            up and down and ranks them by impact.
          </EmptyState>
        ) : null}
        {state.running ? (
          <ChartLoading label={`Running variant ${state.done} of ${state.total}…`} height={200} />
        ) : null}
        {state.error ? <ErrorState error={state.error} /> : null}
        {state.data && !state.running ? (
          <>
            <Tornado rows={state.data.rows} base={state.data.base} metric={metric} />
            <p className="text-[12px] text-ink-2">
              Centre line: the current plan (
              {metric === "endNetWorth"
                ? f.money(state.data.base, true)
                : `${state.data.base} funded years`}
              ). Bars show how far the outcome moves; the longest bar is the assumption to watch.
              Deterministic runs in today's money.
            </p>
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// What-if gallery
// ---------------------------------------------------------------------------------------------

function ScenarioGallery({
  input,
  result,
  plan,
}: {
  input: SimulationInput;
  result: ProjectionResult;
  plan: Plan;
}) {
  const f = useFormat();
  const [open, setOpen] = useState<string | null>(null);
  const variants = useMemo(
    () =>
      SCENARIOS.map((s) => ({ s, v: s.build(plan, result, input.finances.asOf) })).filter(
        (x): x is { s: (typeof SCENARIOS)[number]; v: Variant } => !!x.v,
      ),
    [plan, result, input],
  );
  const [outcomes, setOutcomes] = useState<
    Record<string, ReturnType<typeof outcomeOf> | { error: unknown }>
  >({});
  const [running, setRunning] = useState(false);
  const runAll = async () => {
    setRunning(true);
    for (const { s, v } of variants) {
      try {
        const r = await runVariant(input, v);
        setOutcomes((o) => ({ ...o, [s.id]: outcomeOf(r) }));
      } catch (e) {
        setOutcomes((o) => ({ ...o, [s.id]: { error: e } }));
      }
    }
    setRunning(false);
  };
  const base = outcomeOf(result);
  const selected = variants.find((x) => x.s.id === open);
  return (
    <Card>
      <CardHeader
        eyebrow="What if…"
        title="Scenario gallery"
        actions={
          <Button size="sm" variant="secondary" onClick={runAll} disabled={running}>
            {running ? <Loader2 className="animate-spin" /> : <Play />} Run all
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {variants.map(({ s }) => {
            const o = outcomes[s.id];
            const ok = o && !("error" in o) ? o : null;
            const d = ok ? ok.endNetWorthReal - base.endNetWorthReal : null;
            return (
              <button
                type="button"
                key={s.id}
                onClick={() => setOpen(open === s.id ? null : s.id)}
                aria-expanded={open === s.id}
                className={cn(
                  "flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors hover:border-border-strong",
                  open === s.id ? "border-accent bg-accent-soft/40" : "border-border",
                )}
              >
                <div className="font-semibold">{s.title}</div>
                <div className="text-[12px] text-ink-2">{s.description}</div>
                {ok ? (
                  <div className="mt-auto flex flex-wrap gap-x-3 text-[12px]">
                    <span
                      className={
                        d === null || Math.abs(d) < 0.5
                          ? "text-ink-3"
                          : d < 0
                            ? "text-negative"
                            : "text-positive"
                      }
                    >
                      {d !== null
                        ? Math.abs(d) < 0.5
                          ? "Same end net worth"
                          : `${formatSigned(d, (v) => f.money(v, true))} at end`
                        : ""}
                    </span>
                    <span className={ok.success ? "text-ink-3" : "text-negative"}>
                      {ok.success ? "still funded" : `short from ${ok.firstShortfallYear}`}
                    </span>
                  </div>
                ) : o && "error" in o ? (
                  <div className="text-[12px] text-ink-3">
                    {notImplementedInfo(o.error) ? "Not modelled yet" : "Could not simulate"}
                  </div>
                ) : (
                  <div className="text-[12px] text-ink-3">Click to preview</div>
                )}
              </button>
            );
          })}
        </div>
        {selected ? (
          <PlanChangePreview
            key={selected.s.id}
            input={input}
            base={result}
            variant={selected.v}
            title={selected.s.title}
          />
        ) : null}
      </CardBody>
    </Card>
  );
}

export function InsightsView() {
  const { plan, input, result, isLoading, error, index, doc } = useAnalysis();
  return (
    <Page
      title="Insights"
      description="Explain the plan, solve for the numbers you need, and stress-test it before life does."
    >
      {isLoading ? <ChartLoading /> : null}
      {error ? <ErrorState error={error} title="The plan could not be simulated" /> : null}
      {input && result && plan && doc ? (
        <>
          <div className="grid gap-5 xl:grid-cols-2">
            <WhyCard input={input} result={result} index={index} />
            <AuditPanel input={input} result={result} />
          </div>
          <GoalSeekPanel input={input} result={result} plan={plan} asOf={input.finances.asOf} />
          <TaxStrategyPanel input={input} plan={plan} />
          <StrategyMatrixPanel input={input} plan={plan} />
          <ScenarioGallery input={input} result={result} plan={plan} />
          <TemplateGallery input={input} result={result} />
          <RelocationPanel input={input} result={result} />
          <SurvivorPanel input={input} result={result} />
          <div className="grid gap-5 xl:grid-cols-2">
            <SensitivityPanel input={input} result={result} />
            <GuardrailsPanel input={input} plan={plan} />
          </div>
          <DebtPayoffPanel input={input} plan={plan} />
          <SeppPanel input={input} />
        </>
      ) : null}
    </Page>
  );
}
