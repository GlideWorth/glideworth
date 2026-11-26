/**
 * Roth conversion plan (US): core proposes a conversion amount for each year and person, filling the
 * room left under a ceiling after the year's other income, and compares it with no conversions.
 * Applying it goes through a change set (proposed, reviewed, then applied), never a silent write.
 */
import {
  applyPlanPatch,
  type ChangeSet,
  type Plan,
  type PlanChange,
  type RothConversionPlan,
  type SimulationInput,
} from "@glideworth/core";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Play, X } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorState } from "../../components/charts/states";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { PrivateText } from "../../components/ui/private-text";
import { Select } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useActivePlan, useFormat } from "../../lib/workspace";
import { planConversions } from "./roth-plan-client";
import { applyToPlan } from "./save-plan";

const BRACKETS = [
  { value: "auto", label: "Let Glideworth choose" },
  { value: "0.12", label: "Up to the 12% bracket" },
  { value: "0.22", label: "Up to the 22% bracket" },
  { value: "0.24", label: "Up to the 24% bracket" },
  { value: "0.32", label: "Up to the 32% bracket" },
] as const;
const IRMAA = [
  { value: "none", label: "No IRMAA ceiling" },
  { value: "1", label: "Avoid any IRMAA surcharge" },
  { value: "2", label: "Stay within IRMAA tier 2" },
  { value: "3", label: "Stay within IRMAA tier 3" },
] as const;

const BINDING: Record<string, string> = {
  bracket: "Bracket",
  irmaa: "IRMAA",
  aca: "ACA",
  balance: "Account used up",
  "already-above-ceiling": "No room",
  "no-ceiling": "None planned",
  "no-source": "Nothing to convert",
  "not-alive": "—",
};

type Review = { kind: "api"; changeSet: ChangeSet & { changes: PlanChange[] } } | { kind: "local" };

export function RothConversionPanel({ input, plan }: { input: SimulationInput; plan: Plan }) {
  const f = useFormat();
  const qc = useQueryClient();
  const { workspace } = useActivePlan();
  const [bracket, setBracket] = useState<(typeof BRACKETS)[number]["value"]>("auto");
  const [irmaa, setIrmaa] = useState<(typeof IRMAA)[number]["value"]>("none");
  const [aca, setAca] = useState(true);
  const [state, setState] = useState<{
    status: "idle" | "running" | "done" | "error";
    done: number;
    result?: RothConversionPlan;
    error?: unknown;
  }>({ status: "idle", done: 0 });
  const [showAll, setShowAll] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const money = (v: number) => f.money(v, true);
  const names = new Map(input.household.people.map((p) => [p.id, p.name]));

  const run = async () => {
    setState({ status: "running", done: 0 });
    setReview(null);
    setSaved(null);
    try {
      const result = await planConversions(
        {
          input,
          request: {
            ...(bracket === "auto" ? {} : { targets: [{ bracketRate: Number(bracket) }] }),
            irmaaTier: irmaa === "none" ? null : Number(irmaa),
            aca,
          },
        },
        (done) => setState((s) => ({ ...s, done })),
      );
      setState({ status: "done", done: 0, result });
    } catch (e) {
      setState({ status: "error", done: 0, error: e });
    }
  };

  const r = state.result;
  const summary = r?.summary ?? "";

  /** Step 1: propose the change set (the API computes the diff); nothing is changed yet. */
  const propose = async () => {
    if (!workspace || !r) return;
    setErr(null);
    setBusy(true);
    try {
      if (workspace.source === "api") {
        const changeSet = await api.proposeChangeSet(plan.id, {
          ops: r.patch,
          summary: "Roth conversion schedule",
          rationale: r.summary,
          baseVersion: plan.version,
        });
        setReview({ kind: "api", changeSet });
      } else setReview({ kind: "local" });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  /** Step 2: apply the reviewed change set. */
  const apply = async () => {
    if (!workspace || !r || !review) return;
    setErr(null);
    setBusy(true);
    try {
      if (review.kind === "api") {
        await api.applyChangeSet(review.changeSet.id);
        await qc.invalidateQueries({ queryKey: ["workspace"] });
      } else await applyToPlan(qc, workspace, plan, applyPlanPatch(plan, r.patch));
      setSaved("Applied the conversion schedule to the plan");
      setReview(null);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (review?.kind === "api") await api.discardChangeSet(review.changeSet.id).catch(() => {});
    setReview(null);
  };

  const rows = r ? r.schedule.filter((s) => showAll || s.amount > 0) : [];
  const none = r?.outcomes.find((o) => o.id === "none");
  return (
    <Card>
      <CardHeader
        eyebrow="Roth conversions"
        title="How much should you convert each year?"
        actions={
          <Button size="sm" variant="primary" onClick={run} disabled={state.status === "running"}>
            {state.status === "running" ? <Loader2 className="animate-spin" /> : <Play />} Plan
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-3">
        <p className="text-[12.5px] text-ink-2">
          Each year&apos;s amount fills only the room left after that year&apos;s other income
          (wages, pensions, taxable Social Security, interest, dividends, gains and RMDs), under the
          ceilings you choose. The schedule is compared with making no conversions. Estimates from
          your plan&apos;s assumptions, not tax advice.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Select
            aria-label="Bracket ceiling"
            className="w-[220px]"
            value={bracket}
            onValueChange={setBracket}
            options={[...BRACKETS]}
          />
          <Select
            aria-label="IRMAA ceiling"
            className="w-[220px]"
            value={irmaa}
            onValueChange={setIrmaa}
            options={[...IRMAA]}
          />
          <label className="flex items-center gap-2 text-[12.5px]">
            <Switch checked={aca} onCheckedChange={setAca} aria-label="ACA subsidy limit" />
            Keep ACA subsidies in marketplace years
          </label>
        </div>
        {state.status === "idle" ? (
          <EmptyState title="No schedule yet">
            Plan the conversions to see an amount for each year, what limits it, and how it compares
            with converting nothing.
          </EmptyState>
        ) : null}
        {state.status === "running" ? (
          <div className="flex items-center gap-2 text-[12.5px] text-ink-3" aria-live="polite">
            <Loader2 className="size-3.5 animate-spin" /> Trying schedules… {state.done} done
          </div>
        ) : null}
        {state.status === "error" ? (
          <ErrorState error={state.error} title="The conversion plan failed" />
        ) : null}
        {r ? (
          <>
            <p className="text-[13px] font-medium">
              {r.verdict === "no-conversions" && r.status === "ok" ? (
                <Badge className="mr-2">No conversions</Badge>
              ) : null}
              <PrivateText>{summary}</PrivateText>
            </p>
            {r.outcomes.length > 0 ? (
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Plan</TH>
                      <TH numeric>Converted</TH>
                      <TH numeric>Lifetime tax</TH>
                      <TH numeric>After-tax wealth at the end</TH>
                      <TH className="whitespace-nowrap">Outcome</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {r.outcomes.map((o) => (
                      <TR key={o.id} className={cn(o.id === "none" && "bg-surface-2/60")}>
                        <TD className="font-medium">{o.label}</TD>
                        <TD numeric className="num">
                          {money(o.totalConvertedReal)}
                        </TD>
                        <TD numeric>
                          <div className="num">{money(o.lifetimeTaxReal)}</div>
                          {none && o.id !== "none" ? (
                            <Diff
                              d={o.lifetimeTaxReal - none.lifetimeTaxReal}
                              better="lower"
                              money={money}
                            />
                          ) : null}
                        </TD>
                        <TD numeric>
                          <div className="num">{money(o.afterTaxEndWealthReal)}</div>
                          {none && o.id !== "none" ? (
                            <Diff
                              d={o.afterTaxEndWealthReal - none.afterTaxEndWealthReal}
                              better="higher"
                              money={money}
                            />
                          ) : null}
                        </TD>
                        <TD>
                          {o.success ? (
                            <span className="whitespace-nowrap text-positive">Fully funded</span>
                          ) : (
                            <span className="text-negative">Short from {o.firstShortfallYear}</span>
                          )}
                          {o.successRate !== null ? (
                            <div className="text-[11.5px] text-ink-3">
                              {Math.round(o.successRate * 100)}% chance of success
                            </div>
                          ) : null}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            ) : null}
            {rows.length > 0 ? (
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Year</TH>
                      <TH>Person</TH>
                      <TH numeric>Convert</TH>
                      <TH>Limited by</TH>
                      <TH numeric>Room left</TH>
                      <TH numeric>Tax on it</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rows.map((s) => (
                      <TR key={`${s.year}-${s.personId}`}>
                        <TD className="num">{s.year}</TD>
                        <TD>{names.get(s.personId) ?? s.personId}</TD>
                        <TD numeric className="num">
                          {money(s.amount)}
                        </TD>
                        <TD>
                          <div>{BINDING[s.binding] ?? s.binding}</div>
                          <div className="max-w-[460px] text-[11.5px] text-ink-3">
                            <PrivateText>{s.reason}</PrivateText>
                          </div>
                        </TD>
                        <TD numeric className="num">
                          {s.roomLeft === null ? "—" : money(s.roomLeft)}
                        </TD>
                        <TD numeric className="num">
                          {money(s.taxOnConversion)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            ) : null}
            {r.schedule.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                className="self-start"
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll ? "Only years with a conversion" : "Show every year, with the reason"}
              </Button>
            ) : null}
            {r.patch.length > 0 && !review ? (
              <Button
                size="sm"
                variant="secondary"
                className="self-start"
                disabled={busy}
                onClick={propose}
              >
                {busy ? <Loader2 className="animate-spin" /> : null} Review the changes
              </Button>
            ) : null}
            {review ? (
              <div className="flex flex-col gap-2 rounded-md border border-line p-3 text-[12.5px]">
                <div className="font-medium">Changes to the plan</div>
                <ul className="list-disc pl-5 text-ink-2">
                  {review.kind === "api"
                    ? review.changeSet.changes.slice(0, 12).map((c) => (
                        <li key={`${c.kind}:${c.path}`}>
                          <PrivateText>{c.description}</PrivateText>
                        </li>
                      ))
                    : r.patch
                        .slice(0, 12)
                        .map((op) => (
                          <li key={`${op.path}:${JSON.stringify("value" in op ? op.value : null)}`}>
                            {describeOp(op)}
                          </li>
                        ))}
                </ul>
                {(review.kind === "api" ? review.changeSet.changes.length : r.patch.length) > 12 ? (
                  <div className="text-ink-3">…and more.</div>
                ) : null}
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" disabled={busy} onClick={apply}>
                    <Check /> Apply {review.kind === "api" ? "change set" : "to this session"}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={discard}>
                    <X /> Discard
                  </Button>
                </div>
              </div>
            ) : null}
            {saved ? (
              <div className="text-[12px] text-positive">
                {saved}
                {workspace?.source === "sample" ? " (this session only)" : ""}
              </div>
            ) : null}
            {err ? <ErrorState error={err} title="Could not apply" /> : null}
            <details className="text-[11.5px] text-ink-3">
              <summary>What this leaves out</summary>
              <ul className="mt-1 list-disc pl-5">
                {r.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </details>
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

function Diff({
  d,
  better,
  money,
}: {
  d: number;
  better: "higher" | "lower";
  money: (v: number) => string;
}) {
  if (Math.abs(d) < 0.5) return <div className="text-[11.5px] text-ink-3">no change</div>;
  const good = better === "higher" ? d > 0 : d < 0;
  return (
    <div className={cn("num text-[11.5px]", good ? "text-positive" : "text-negative")}>
      {d > 0 ? "+" : "−"}
      {money(Math.abs(d))}
    </div>
  );
}

function describeOp(op: RothConversionPlan["patch"][number]): string {
  const v = "value" in op ? (op.value as { name?: string } | undefined) : undefined;
  if (op.op === "add" && op.path === "/flows/-") return `Add ${v?.name ?? "a conversion"}`;
  if (op.op === "add" && op.path === "/plannedAccounts/-") return `Open ${v?.name ?? "a Roth IRA"}`;
  if (op.path === "/taxStrategy/modules/rothConversions")
    return "Switch off the tax strategy's own Roth conversions";
  return `Switch off the existing conversion ${op.path.replace(/^\/flows\/\[id=(.*)\]\/enabled$/, "$1")}`;
}
