/**
 * Tax-strategy optimisation: core's candidate strategies (UK pension / ISA / GIA drawdown order,
 * personal-allowance gap years, tax-free lump sum timing; US bracket filling) are each simulated and
 * ranked. A row can be applied as a branch or to the plan in one click.
 */
import {
  applyPlanPatch,
  type Plan,
  type SimulationInput,
  type StrategyComparison,
  type StrategyEvaluation,
  type StrategyObjective,
} from "@glideworth/core";
import { useQueryClient } from "@tanstack/react-query";
import { Check, GitBranch, Loader2, Play } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorState } from "../../components/charts/states";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Select } from "../../components/ui/select";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { useActivePlan, useFormat } from "../../lib/workspace";
import { applyToPlan, saveAsBranch } from "./save-plan";
import { rankStrategies } from "./strategy-client";
import { PrivateText } from "../../components/ui/private-text";

const OBJECTIVES: { value: StrategyObjective; label: string }[] = [
  { value: "endNetWorthReal", label: "Highest net worth at the end" },
  { value: "lifetimeTaxesReal", label: "Lowest lifetime tax" },
];

function Delta({
  now,
  was,
  money,
  better,
}: {
  now: number | null;
  was: number | null;
  money: (v: number) => string;
  better: "higher" | "lower";
}) {
  if (now === null || was === null) return <span className="text-ink-3">—</span>;
  const d = now - was;
  if (Math.abs(d) < 0.5) return <span className="text-ink-3">no change</span>;
  const good = better === "higher" ? d > 0 : d < 0;
  return (
    <span className={cn("num", good ? "text-positive" : "text-negative")}>
      {d > 0 ? "+" : "−"}
      {money(Math.abs(d))}
    </span>
  );
}

export function TaxStrategyPanel({ input, plan }: { input: SimulationInput; plan: Plan }) {
  const f = useFormat();
  const qc = useQueryClient();
  const { workspace } = useActivePlan();
  const [objective, setObjective] = useState<StrategyObjective>("endNetWorthReal");
  const [state, setState] = useState<{
    status: "idle" | "running" | "done" | "error";
    done: number;
    comparison?: StrategyComparison;
    error?: unknown;
  }>({ status: "idle", done: 0 });
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const money = (v: number) => f.money(v, true);

  const run = async () => {
    setState({ status: "running", done: 0 });
    setSaved(null);
    try {
      const comparison = await rankStrategies({ input, objective }, (done) =>
        setState((s) => ({ ...s, done })),
      );
      setState({ status: "done", done: 0, comparison });
    } catch (e) {
      setState({ status: "error", done: 0, error: e });
    }
  };

  const persist = async (ev: StrategyEvaluation, kind: "branch" | "apply") => {
    if (!workspace) return;
    setErr(null);
    setBusy(`${kind}:${ev.id}`);
    try {
      const body = applyPlanPatch(plan, ev.patch);
      if (kind === "branch") {
        await saveAsBranch(qc, workspace, plan, body, `${plan.name} · ${ev.label}`, ev.description);
        setSaved(`Saved “${ev.label}” as a branch`);
      } else {
        await applyToPlan(qc, workspace, plan, body);
        setSaved(`Applied “${ev.label}” to the plan`);
      }
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  const cmp = state.comparison;
  const base = cmp?.baseline;
  return (
    <Card>
      <CardHeader
        eyebrow="Tax strategy"
        title="How do drawdown and tax strategies compare on your inputs?"
        actions={
          <>
            <Select
              aria-label="Compare by"
              className="w-[220px]"
              value={objective}
              onValueChange={(v) => setObjective(v as StrategyObjective)}
              options={OBJECTIVES}
            />
            <Button size="sm" variant="primary" onClick={run} disabled={state.status === "running"}>
              {state.status === "running" ? <Loader2 className="animate-spin" /> : <Play />} Compare
            </Button>
          </>
        }
      />
      <CardBody className="flex flex-col gap-3">
        <p className="text-[12.5px] text-ink-2">
          {input.household.location.country === "GB"
            ? "Tries every pension, ISA and general-account drawdown order, using the personal allowance in the years before State Pension starts, and taking the 25% tax-free lump sum up front versus bit by bit. Each is a full simulation of your plan."
            : input.household.location.country === "US"
              ? "Tries every drawdown order across your account types plus filling a tax bracket with Roth conversions each year. Each is a full simulation of your plan."
              : "Tries every drawdown order across your account types. Each is a full simulation of your plan."}
        </p>
        {state.status === "idle" ? (
          <EmptyState title="Nothing compared yet">
            Run the comparison to see the strategies ranked against your current plan.
          </EmptyState>
        ) : null}
        {state.status === "running" ? (
          <div className="flex items-center gap-2 text-[12.5px] text-ink-3" aria-live="polite">
            <Loader2 className="size-3.5 animate-spin" /> Simulating strategies… {state.done} done
          </div>
        ) : null}
        {state.status === "error" ? (
          <ErrorState error={state.error} title="The comparison failed" />
        ) : null}
        {cmp && base ? (
          <>
            <p className="text-[13px] font-medium">
              <PrivateText>{cmp.explanation}</PrivateText>
            </p>
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH className="w-8">#</TH>
                    <TH>Strategy</TH>
                    <TH numeric>End net worth</TH>
                    <TH numeric>Lifetime tax</TH>
                    <TH className="whitespace-nowrap">Outcome</TH>
                    <TH>
                      <span className="sr-only">Actions</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {cmp.ranked
                    .map((r, i) => ({ r, i }))
                    .filter(({ r, i }) => showAll || i < 8 || r.id === "baseline")
                    .map(({ r, i }) => {
                      const isBase = r.id === "baseline";
                      return (
                        <TR key={r.id} className={cn(isBase && "bg-surface-2/60")}>
                          <TD className="num text-ink-3">{i + 1}</TD>
                          <TD>
                            <div className="font-medium">
                              {r.label}{" "}
                              {isBase && r.label !== "Current plan" ? (
                                <Badge>Current plan</Badge>
                              ) : null}
                            </div>
                            <div className="max-w-[420px] text-[11.5px] text-ink-3">
                              <PrivateText>{r.description}</PrivateText>
                            </div>
                          </TD>
                          <TD numeric>
                            <div className="num">
                              {r.endNetWorthReal === null ? "—" : money(r.endNetWorthReal)}
                            </div>
                            {!isBase ? (
                              <div className="text-[11.5px]">
                                <Delta
                                  now={r.endNetWorthReal}
                                  was={base.endNetWorthReal}
                                  money={money}
                                  better="higher"
                                />
                              </div>
                            ) : null}
                          </TD>
                          <TD numeric>
                            <div className="num">
                              {r.lifetimeTaxesReal === null ? "—" : money(r.lifetimeTaxesReal)}
                            </div>
                            {!isBase ? (
                              <div className="text-[11.5px]">
                                <Delta
                                  now={r.lifetimeTaxesReal}
                                  was={base.lifetimeTaxesReal}
                                  money={money}
                                  better="lower"
                                />
                              </div>
                            ) : null}
                          </TD>
                          <TD>
                            {r.success ? (
                              <span className="whitespace-nowrap text-positive">Fully funded</span>
                            ) : (
                              <span className="text-negative">
                                Short from {r.firstShortfallYear}
                              </span>
                            )}
                          </TD>
                          <TD>
                            {isBase ? null : (
                              <div className="flex flex-wrap justify-end gap-1">
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={!!busy}
                                  onClick={() => persist(r, "branch")}
                                  title="Create a new branch of this plan with the strategy applied"
                                >
                                  {busy === `branch:${r.id}` ? (
                                    <Loader2 className="animate-spin" />
                                  ) : (
                                    <GitBranch />
                                  )}
                                  Apply as branch
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={!!busy}
                                  onClick={() => persist(r, "apply")}
                                >
                                  <Check /> Apply
                                </Button>
                              </div>
                            )}
                          </TD>
                        </TR>
                      );
                    })}
                </TBody>
              </Table>
            </div>
            {cmp.ranked.length > 8 ? (
              <Button
                size="sm"
                variant="ghost"
                className="self-start"
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll ? "Show the top 8" : `Show all ${cmp.ranked.length}`}
              </Button>
            ) : null}
            {saved ? (
              <div className="text-[12px] text-positive">
                {saved}
                {workspace?.source === "sample" ? " (this session only)" : ""}
              </div>
            ) : null}
            {err ? <ErrorState error={err} title="Could not save" /> : null}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
