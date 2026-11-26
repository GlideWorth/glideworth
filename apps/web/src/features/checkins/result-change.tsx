/**
 * "Why did my number change?": the movement of the headline results since the last check-in, split by cause
 * (Glideworth's side, the passage of time, updated balances, household details, plan edits). Shown inside the
 * dashboard's check-in card, next to the numbers that moved. Data: GET /plans/{id}/result-change (read-only;
 * the server recomputes, Monte Carlo included, and stores nothing).
 */
import { useQuery } from "@tanstack/react-query";
import { HelpCircle, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { PrivateText } from "../../components/ui/private-text";
import { api, type ResultChangeReport } from "../../lib/api";
import { cn } from "../../lib/cn";
import { formatMoney } from "../../lib/format";
import { useFormat } from "../../lib/workspace";

type Metric = ResultChangeReport["metrics"][number];
type FullMetric = Extract<ResultChangeReport, { available: true }>["metrics"][number];

/** Smallest movement worth showing, per unit (a tenth of a point, a year, one unit of money). */
const tiny = (unit: Metric["unit"], v: number) =>
  unit === "fraction" ? Math.abs(v) < 0.0005 : unit === "year" ? v === 0 : Math.abs(v) < 0.5;

export function useResultChange(planId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["result-change", planId],
    enabled: enabled && !!planId,
    queryFn: () => api.resultChange(planId!),
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/**
 * Loads by itself when something the user did changed (edits or balances); otherwise one click away, because
 * the server re-runs Monte Carlo for every step.
 */
export function WhyResultsMoved({ planId, auto }: { planId: string; auto: boolean }) {
  const [asked, setAsked] = useState(false);
  const q = useResultChange(planId, auto || asked);
  if (!auto && !asked)
    return (
      <div>
        <Button size="sm" variant="ghost" onClick={() => setAsked(true)}>
          <HelpCircle /> Why did the numbers move?
        </Button>
      </div>
    );
  if (q.isLoading)
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
        <Loader2 className="size-4 animate-spin" /> Working out why the numbers moved…
      </div>
    );
  if (q.isError || !q.data)
    return (
      <div className="text-[12.5px] text-ink-3">Could not work out why the numbers moved.</div>
    );
  return <ResultChangeView report={q.data} />;
}

export function ResultChangeView({ report }: { report: ResultChangeReport }) {
  const f = useFormat();
  const money = (v: number) =>
    formatMoney(v, { locale: f.locale, currency: report.currency, compact: true });
  const value = (m: Metric, v: number | null) =>
    v === null
      ? m.unit === "year"
        ? "not reached"
        : "—"
      : m.unit === "fraction"
        ? f.percent(v, 0)
        : m.unit === "year"
          ? String(v)
          : money(v);
  const delta = (m: Metric, v: number) => {
    const sign = v > 0 ? "+" : v < 0 ? "−" : "±";
    const a = Math.abs(v);
    if (m.unit === "fraction") return `${sign}${f.number(a * 100, 1)} pts`;
    if (m.unit === "year") return `${sign}${f.number(a, 0)} ${a === 1 ? "yr" : "yrs"}`;
    return `${sign}${money(a)}`;
  };
  const shown = report.metrics.filter((m) => m.before !== null || m.after !== null);

  return (
    <section aria-label="Why the numbers moved" className="flex flex-col gap-2">
      <div className="eyebrow">Why the numbers moved</div>
      {!report.available ? (
        <p className="text-[12.5px] text-ink-2">{report.reason}</p>
      ) : report.noChange ? (
        <p className="text-[12.5px] text-ink-2">
          Nothing changed since the check-in: the same plan, balances and start month, and the same
          engine, tax tables and market history.
        </p>
      ) : null}
      {report.available && report.noChange ? null : (
        <ul className="flex flex-col gap-2.5">
          {shown.map((m) => (
            <li key={m.metric} className="text-[13px]">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{m.label}</span>
                <span className="num text-ink-2">
                  <PrivateText>{`${value(m, m.before)} → ${value(m, m.after)}`}</PrivateText>
                </span>
                {m.total !== null && !tiny(m.unit, m.total) ? (
                  <span className={cn("num font-semibold", tone(m, m.total))}>
                    <PrivateText>{`(${delta(m, m.total)})`}</PrivateText>
                  </span>
                ) : (
                  <span className="text-ink-3">(no change)</span>
                )}
              </div>
              {report.available ? (
                <Causes m={report.metrics.find((x) => x.metric === m.metric)!} delta={delta} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {report.available ? <Steps report={report} /> : null}
      <p className="text-[11.5px] text-ink-3">
        {report.available
          ? "Causes are measured one at a time in the order listed, each on top of the ones before; another order could split the same total differently. "
          : ""}
        Estimates from your plan&rsquo;s assumptions, not advice.
      </p>
    </section>
  );
}

function tone(m: Metric, v: number) {
  // A later FI year is worse; for the others, more is better.
  const good = m.unit === "year" ? v < 0 : v > 0;
  return good ? "text-positive" : "text-negative";
}

function Causes({ m, delta }: { m: FullMetric; delta: (m: Metric, v: number) => string }) {
  const unexplained = m.unexplained;
  const rows = m.parts.filter((p) => p.delta !== null && !tiny(m.unit, p.delta));
  const rest = unexplained !== null && !tiny(m.unit, unexplained) ? unexplained : null;
  if (rows.length === 0 && rest === null) return null;
  return (
    <ul className="mt-1 flex flex-col gap-0.5 border-l border-border pl-3 text-[12.5px]">
      {rows.map((p) => (
        <li key={p.cause}>
          <div className="flex justify-between gap-3">
            <span className="text-ink-2">{p.label}</span>
            <span className={cn("num shrink-0", tone(m, p.delta!))}>
              <PrivateText>{delta(m, p.delta!)}</PrivateText>
            </span>
          </div>
          {p.edits && m.unit !== "fraction" ? (
            <ul className="ml-3 flex flex-col">
              {p.edits
                .filter((e) => e.delta !== null && !tiny(m.unit, e.delta))
                .slice(0, 5)
                .map((e) => (
                  <li key={e.key} className="flex justify-between gap-3 text-ink-3">
                    <span className="min-w-0 truncate">
                      <PrivateText>{e.description}</PrivateText>
                    </span>
                    <span className="num shrink-0">
                      <PrivateText>{delta(m, e.delta!)}</PrivateText>
                    </span>
                  </li>
                ))}
            </ul>
          ) : null}
        </li>
      ))}
      {rest !== null ? (
        <li className="flex justify-between gap-3">
          <span className="text-ink-3">Unexplained (the same inputs gave a different answer)</span>
          <span className="num shrink-0 text-ink-3">
            <PrivateText>{delta(m, rest)}</PrivateText>
          </span>
        </li>
      ) : null}
    </ul>
  );
}

function Steps({ report }: { report: Extract<ResultChangeReport, { available: true }> }) {
  const changed = report.steps.filter((s) => s.changed && s.details.length);
  if (changed.length === 0) return null;
  return (
    <details className="text-[12.5px]">
      <summary className="cursor-pointer text-ink-2">What changed</summary>
      <ul className="mt-1.5 flex flex-col gap-1">
        {changed.map((s) => (
          <li key={s.cause}>
            <span className="text-ink-2">{s.label}:</span>{" "}
            <span className="text-ink-3">
              <PrivateText>{s.details.slice(0, 6).join("; ")}</PrivateText>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
