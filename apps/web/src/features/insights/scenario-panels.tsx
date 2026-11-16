import type { ProjectionResult, SimulationInput } from "@glideworth/core";
import { Loader2, Play } from "lucide-react";
import { useMemo, useState } from "react";
import { notImplementedInfo } from "../../components/charts/states";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { cn } from "../../lib/cn";
import { formatSigned } from "../../lib/format";
import { useFormat } from "../../lib/workspace";
import { type Outcome, outcomeOf, runVariant } from "./insights-model";
import { PlanChangePreview } from "./plan-preview";
import {
  type BuiltTemplate,
  buildSurvivorTemplates,
  buildTemplates,
  variantOf,
} from "./scenario-templates";

type Result = Outcome | { error: unknown };

function TemplateGrid({
  input,
  result,
  items,
  eyebrow,
  title,
  emptyNote,
}: {
  input: SimulationInput;
  result: ProjectionResult;
  items: BuiltTemplate[];
  eyebrow: string;
  title: string;
  emptyNote?: string;
}) {
  const f = useFormat();
  const [open, setOpen] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Result>>({});
  const [running, setRunning] = useState(false);
  const base = outcomeOf(result);
  const runnable = items.filter((i) => i.template);
  const runAll = async () => {
    setRunning(true);
    for (const it of runnable) {
      try {
        const r = await runVariant(input, variantOf(input, it.template!));
        setOutcomes((o) => ({ ...o, [it.id]: outcomeOf(r) }));
      } catch (e) {
        setOutcomes((o) => ({ ...o, [it.id]: { error: e } }));
      }
    }
    setRunning(false);
  };
  const selected = items.find((i) => i.id === open && i.template);
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <Card>
      <CardHeader
        eyebrow={eyebrow}
        title={title}
        actions={
          runnable.length ? (
            <Button size="sm" variant="secondary" onClick={runAll} disabled={running}>
              {running ? <Loader2 className="animate-spin" /> : <Play />} Run all
            </Button>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-4">
        {items.length === 0 ? <p className="text-[12.5px] text-ink-2">{emptyNote}</p> : null}
        {groups.map((g) => (
          <div key={g} className="flex flex-col gap-2">
            {groups.length > 1 ? <div className="eyebrow">{g}</div> : null}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {items
                .filter((i) => i.group === g)
                .map((it) => {
                  const o = outcomes[it.id];
                  const ok = o && !("error" in o) ? o : null;
                  const d = ok ? ok.endNetWorthReal - base.endNetWorthReal : null;
                  return (
                    <button
                      type="button"
                      key={it.id}
                      disabled={!it.template}
                      onClick={() => setOpen(open === it.id ? null : it.id)}
                      aria-expanded={open === it.id}
                      className={cn(
                        "flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors enabled:hover:border-border-strong disabled:opacity-70",
                        open === it.id ? "border-accent bg-accent-soft/40" : "border-border",
                      )}
                    >
                      <div className="font-semibold">{it.template?.title ?? it.fallbackTitle}</div>
                      <div className="text-[12px] text-ink-2">
                        {it.template?.description ?? it.error ?? "Not available for this plan."}
                      </div>
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
                        <div className="text-[12px] text-negative">
                          {notImplementedInfo(o.error)
                            ? "Not modelled yet"
                            : o.error instanceof Error
                              ? o.error.message
                              : "Could not simulate"}
                        </div>
                      ) : it.template ? (
                        <div className="text-[12px] text-ink-3">Click to preview</div>
                      ) : null}
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
        {selected?.template ? (
          <PlanChangePreview
            key={selected.id}
            input={input}
            base={result}
            variant={variantOf(input, selected.template)}
            title={selected.template.title}
          />
        ) : null}
      </CardBody>
    </Card>
  );
}

export function TemplateGallery({
  input,
  result,
}: {
  input: SimulationInput;
  result: ProjectionResult;
}) {
  const items = useMemo(() => buildTemplates(input, result), [input, result]);
  return (
    <TemplateGrid
      input={input}
      result={result}
      items={items}
      eyebrow="What if…"
      title="Life-event templates"
    />
  );
}

export function SurvivorPanel({
  input,
  result,
}: {
  input: SimulationInput;
  result: ProjectionResult;
}) {
  const items = useMemo(() => buildSurvivorTemplates(input), [input]);
  if (input.household.people.length < 2) return null;
  return (
    <TemplateGrid
      input={input}
      result={result}
      items={items}
      eyebrow="Couples"
      title="If one of you dies first"
      emptyNote="No survivor scenarios apply to this plan."
    />
  );
}
