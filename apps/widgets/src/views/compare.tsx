import { useEffect, useRef, useState } from "react";
import { type Guide, TimeChart } from "../components/chart";
import {
  Actions,
  Button,
  ChangeList,
  Chip,
  Chips,
  Collapsible,
  Notice,
  Shell,
} from "../components/ui";
import { messageOf, useFormatter, useWidget } from "../context";
import type { Formatter } from "../format";
import { bodyOf, payloadFrom } from "../routing";
import type { CompareView as CompareViewData, TemplateParam } from "../types";
import { clip, outcomeDeltas, useAction, useOpenView, worseWarning } from "./shared";

const INLINE_CHANGES = 3;

function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

function formatParam(param: TemplateParam, value: number, fmt: Formatter): string {
  switch (param.format) {
    case "money":
      return fmt.money(value);
    case "year":
      return fmt.year(value);
    case "percent":
      return fmt.percent(value, Math.max(0, decimalsOf(param.step) - 2));
    default:
      return fmt.number(value);
  }
}

function Stepper(props: {
  param: TemplateParam;
  value: number;
  fmt: Formatter;
  onChange(value: number): void;
}) {
  const { param, value, fmt } = props;
  const decimals = decimalsOf(param.step);
  const set = (next: number) => {
    const clamped = Math.min(param.max, Math.max(param.min, next));
    props.onChange(Number(clamped.toFixed(decimals)));
  };
  const shown = formatParam(param, value, fmt);
  return (
    <div className="stepper">
      <div className="stepper-row">
        <span className="stepper-label">{param.label}</span>
        <div className="stepper-controls">
          <button
            type="button"
            className="step-btn"
            aria-label={`Decrease ${param.label}`}
            disabled={value <= param.min}
            onClick={() => set(value - param.step)}
          >
            −
          </button>
          <output className="stepper-value num" aria-live="polite">
            {shown}
          </output>
          <button
            type="button"
            className="step-btn"
            aria-label={`Increase ${param.label}`}
            disabled={value >= param.max}
            onClick={() => set(value + param.step)}
          >
            +
          </button>
        </div>
      </div>
      <input
        type="range"
        min={param.min}
        max={param.max}
        step={param.step}
        value={value}
        aria-label={param.label}
        aria-valuetext={shown}
        onChange={(e) => set(Number(e.currentTarget.value))}
      />
    </div>
  );
}

export function CompareView({ data: initial }: { data: CompareViewData }) {
  const { call, host, hostState, timing } = useWidget();
  const [data, setData] = useState(initial);
  const fmt = useFormatter(data.plan);
  const [selected, setSelected] = useState<number | null>(null);
  const [params, setParams] = useState<Record<string, unknown>>(initial.template?.params ?? {});
  const [loading, setLoading] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const action = useAction();
  const openView = useOpenView();
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const full = hostState.context.displayMode === "fullscreen";

  useEffect(() => () => clearTimeout(timer.current), []);

  const template = data.template;
  const changeParam = (name: string, value: number) => {
    if (!template) return;
    const next = { ...params, [name]: value };
    setParams(next);
    setSaved(null);
    setRerunError(null);
    setLoading(true);
    clearTimeout(timer.current);
    const id = ++latest.current;
    timer.current = setTimeout(() => {
      void call("preview_whatif", {
        planId: data.plan.planId,
        templateId: template.id,
        params: next,
      })
        .then((result) => {
          if (id !== latest.current) return;
          const payload = payloadFrom(result);
          if (payload?.view !== "compare") throw new Error("No updated comparison came back.");
          // Keep the parameters the user chose, even if the server echoes them differently.
          setData({
            ...payload,
            template: payload.template ? { ...payload.template, params: next } : template,
          });
        })
        .catch((err: unknown) => {
          if (id === latest.current) setRerunError(messageOf(err));
        })
        .finally(() => {
          if (id === latest.current) setLoading(false);
        });
    }, timing.debounceMs);
  };

  const deltas = outcomeDeltas(data.before, data.after, fmt).slice(0, 3);
  const n = data.years.length;
  const read = selected !== null && selected < n ? selected : null;
  const lastYear = data.years[n - 1];
  const summary = `${data.beforeLabel} against ${data.afterLabel}, net worth ${data.years[0]} to ${lastYear}. ${data.headline} At the end: ${fmt.compact(
    data.before.endNetWorth,
  )} against ${fmt.compact(data.after.endNetWorth)}.`;
  const guides: Guide[] = [
    ...(data.before.retirementYear !== null
      ? [{ year: data.before.retirementYear, label: "Retire", tone: "neutral" as const }]
      : []),
    ...(data.after.retirementYear !== null &&
    data.after.retirementYear !== data.before.retirementYear
      ? [{ year: data.after.retirementYear, label: "Retire (what-if)", tone: "neutral" as const }]
      : []),
    ...(data.after.depletionYear !== null
      ? [
          {
            year: data.after.depletionYear,
            label: `What-if short ${data.after.depletionYear}`,
            tone: "alert" as const,
          },
        ]
      : []),
    ...(data.before.depletionYear !== null && data.before.depletionYear !== data.after.depletionYear
      ? [
          {
            year: data.before.depletionYear,
            label: `Now short ${data.before.depletionYear}`,
            tone: "alert" as const,
          },
        ]
      : []),
  ];
  const warning = worseWarning(data.before, data.after, fmt);
  const tweakable = template?.tweakable ?? [];
  const valueOf = (p: TemplateParam) => {
    const v = params[p.name];
    return typeof v === "number" ? v : p.value;
  };
  /** The change-set summary: the what-if label, with parameter values only when the label lacks them. */
  const describeWhatIf = () => {
    const label = data.afterLabel || template?.label || data.headline;
    if (!template || !tweakable.length || /\d/.test(label)) return clip(label);
    const parts = tweakable.map((p) => `${p.label} ${formatParam(p, valueOf(p), fmt)}`);
    return clip(`${label}: ${parts.join(", ")}`);
  };

  return (
    <Shell plan={data.plan} title="What changes?">
      <p className="headline lead">{data.headline}</p>

      <div className="readout" aria-live="polite">
        {read !== null ? (
          <>
            <span className="readout-year num">{data.years[read]}</span>
            <span className="readout-item">
              <span className="swatch" style={{ background: "var(--chart-8)" }} />
              {data.beforeLabel}{" "}
              <strong className="num">{fmt.compact(data.beforeSeries[read] ?? 0)}</strong>
            </span>
            <span className="readout-item">
              <span className="swatch" style={{ background: "var(--chart-1)" }} />
              {data.afterLabel}{" "}
              <strong className="num">{fmt.compact(data.afterSeries[read] ?? 0)}</strong>
            </span>
          </>
        ) : (
          <span className="legend-inline">
            <span className="readout-item">
              <span className="swatch" style={{ background: "var(--chart-8)" }} />
              {data.beforeLabel}
            </span>
            <span className="readout-item">
              <span className="swatch" style={{ background: "var(--chart-1)" }} />
              {data.afterLabel}
            </span>
          </span>
        )}
      </div>

      <TimeChart
        years={data.years}
        lines={[
          {
            key: "before",
            label: data.beforeLabel,
            values: data.beforeSeries,
            color: "var(--chart-8)",
            dashed: true,
          },
          {
            key: "after",
            label: data.afterLabel,
            values: data.afterSeries,
            color: "var(--chart-1)",
          },
        ]}
        guides={guides}
        selected={selected}
        onSelect={setSelected}
        formatAxis={fmt.compact}
        height={full ? 280 : 176}
        label={summary}
        dim={loading}
        valueText={(i) =>
          `${data.years[i]}: ${data.beforeLabel} ${fmt.money(data.beforeSeries[i] ?? 0)}, ${data.afterLabel} ${fmt.money(
            data.afterSeries[i] ?? 0,
          )}`
        }
      />

      {deltas.length ? (
        <Chips>
          {deltas.map((d) => (
            <Chip
              key={d.key}
              label={d.label}
              value={d.after}
              detail={`was ${d.before}`}
              tone={d.tone}
            />
          ))}
        </Chips>
      ) : (
        <p className="muted small">The key outcomes don’t change.</p>
      )}

      {tweakable.length ? (
        <section className="tweaks" aria-busy={loading || undefined}>
          {tweakable.map((p) => (
            <Stepper
              key={p.name}
              param={p}
              value={valueOf(p)}
              fmt={fmt}
              onChange={(v) => changeParam(p.name, v)}
            />
          ))}
          {loading ? <p className="muted small">Updating…</p> : null}
          {rerunError ? <Notice tone="bad">{rerunError}</Notice> : null}
        </section>
      ) : null}

      {data.changes.length ? (
        <section>
          <h2 className="section-title">Changes</h2>
          <ChangeList changes={data.changes.slice(0, INLINE_CHANGES)} />
          {data.changes.length > INLINE_CHANGES ? (
            <Collapsible title={`${data.changes.length - INLINE_CHANGES} more`} defaultOpen={full}>
              <ChangeList changes={data.changes.slice(INLINE_CHANGES)} />
            </Collapsible>
          ) : null}
        </section>
      ) : null}

      {saved ? <Notice tone="good">{saved}</Notice> : null}
      {warning ? <p className="warning">{warning}</p> : null}
      {data.plan.canWrite && (data.ops?.length || template) ? (
        <Actions>
          {data.ops?.length ? (
            <Button
              variant={warning ? "secondary" : "primary"}
              disabled={loading}
              busy={action.busy === "propose"}
              onClick={() =>
                void action.run("propose", () =>
                  openView(
                    "propose_change_set",
                    { planId: data.plan.planId, ops: data.ops, summary: describeWhatIf() },
                    "review",
                  ),
                )
              }
            >
              Make this my plan
            </Button>
          ) : null}
          {template && !saved ? (
            <Button
              disabled={loading}
              busy={action.busy === "save"}
              onClick={() =>
                void action.run("save", async () => {
                  const result = await call("create_branch_from_template", {
                    planId: data.plan.planId,
                    templateId: template.id,
                    params,
                  });
                  const body = bodyOf(result);
                  const name = typeof body.name === "string" ? body.name : template.label;
                  setSaved(`Saved as a what-if: “${name}”. Your plan is unchanged.`);
                  await host.updateModelContext(
                    `The user saved the what-if "${describeWhatIf()}" as a branch plan "${name}"${
                      typeof body.id === "string" ? ` (id ${body.id})` : ""
                    } of plan ${data.plan.planId} in the Glideworth view.`,
                  );
                })
              }
            >
              Save as a what-if
            </Button>
          ) : null}
        </Actions>
      ) : null}
      {action.error ? <Notice tone="bad">{action.error}</Notice> : null}
    </Shell>
  );
}
