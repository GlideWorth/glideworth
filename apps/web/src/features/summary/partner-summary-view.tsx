/**
 * The plan in five minutes, for a partner: plain words, few numbers, printable. The landing page of a
 * view-only partner.
 *
 * Signed in, the page shows the server's summary (`GET /plans/{id}/partner-summary`), which is built from
 * engine results only and lists every number with the result it came from. In the offline sample the same
 * builder from @glideworth/core runs on the projection already in the browser.
 */
import { buildPartnerSummary } from "@glideworth/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dices, Printer } from "lucide-react";
import { useMemo } from "react";
import { ChartLoading, ErrorState } from "../../components/charts/states";
import { Button } from "../../components/ui/button";
import { api, type PartnerSummary } from "../../lib/api";
import { useAccess } from "../../lib/access";
import { useUi } from "../../stores/ui";
import { useAnalysis } from "../results/use-analysis";

const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 16mm 14mm; }
  html, body { background: #fff !important; }
  .h-dvh { height: auto !important; overflow: visible !important; display: block !important; background: #fff !important; }
  main { overflow: visible !important; }
  aside, .min-w-0 > header, [data-viewer-banner] { display: none !important; }
  .summary-noprint { display: none !important; }
  .summary-page { max-width: none !important; padding: 0 !important; }
  .summary-block { break-inside: avoid; page-break-inside: avoid; }
}`;

/** Hide-amounts mode: every money figure in the sentences becomes dots (years and percentages stay). */
function masker(s: PartnerSummary, hidden: boolean) {
  const money = s.figures.filter((f) => f.kind === "money").map((f) => f.display);
  return (text: string) => (hidden ? money.reduce((t, m) => t.split(m).join("•••"), text) : text);
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="summary-block flex flex-col gap-1.5">
      <h2 className="display text-[18px] font-semibold">{title}</h2>
      <div className="max-w-[68ch] text-[15px] leading-relaxed text-pretty">{children}</div>
    </section>
  );
}

export function PartnerSummaryView() {
  const { plan, workspace, input, result, isLoading, error } = useAnalysis();
  const access = useAccess();
  const hidden = useUi((s) => s.hideAmounts);
  const qc = useQueryClient();
  const fromApi = workspace?.source === "api";
  const planId = plan?.id;

  const remote = useQuery({
    queryKey: ["partner-summary", planId, plan?.version],
    enabled: fromApi && !!planId,
    queryFn: () => api.partnerSummary(planId!),
  });
  const local = useMemo((): PartnerSummary | undefined => {
    if (fromApi || !input || !result) return undefined;
    try {
      return buildPartnerSummary({ input, result });
    } catch {
      return undefined;
    }
  }, [fromApi, input, result]);
  const runChance = useMutation({
    mutationFn: () => api.runDefaultMonteCarlo(planId!),
    onSettled: () => qc.invalidateQueries({ queryKey: ["partner-summary", planId] }),
  });

  const s = fromApi ? remote.data : local;
  const loading = fromApi ? remote.isLoading : isLoading;
  const failure = fromApi ? remote.error : error;
  const m = s ? masker(s, hidden) : (t: string) => t;
  const names = s?.people.map((p) => p.name) ?? [];

  const print = () => window.print();

  return (
    <div className="summary-page mx-auto flex w-full max-w-[820px] flex-col gap-7 px-5 py-6 sm:px-8">
      <style>{PRINT_CSS}</style>
      <div className="summary-noprint flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 shadow-card">
        <span className="text-[12.5px] text-ink-2">
          One page in plain words. Every number comes from the plan's own results.
        </span>
        <Button size="sm" variant="primary" onClick={print} disabled={!s}>
          <Printer /> Print / PDF
        </Button>
      </div>
      {loading ? <ChartLoading /> : null}
      {failure ? <ErrorState error={failure} /> : null}
      {s ? (
        <>
          <header className="summary-block flex flex-col gap-2">
            <div className="eyebrow">
              {names.length > 1 ? `For ${names.join(" and ")}` : "Your plan"} · {s.planName}
            </div>
            <h1 className="display text-[28px] leading-tight font-semibold text-balance sm:text-[32px]">
              {m(s.headline)}
            </h1>
          </header>

          <Block title="When can we stop working?">
            <p>{m(s.stopWork.text)}</p>
          </Block>
          <Block title="How much can we spend?">
            <p>{m(s.spending.text)}</p>
          </Block>
          <Block title="How sure is it?">
            <p>{m(s.confidence.text)}</p>
            {s.confidence.level === "unknown" && fromApi ? (
              <Button
                className="summary-noprint mt-2"
                size="sm"
                onClick={() => runChance.mutate()}
                disabled={runChance.isPending || !planId}
              >
                <Dices />{" "}
                {runChance.isPending ? "Working it out…" : "Work out the chance of success"}
              </Button>
            ) : null}
          </Block>
          {s.survivor.applicable ? (
            <Block title="If one of us dies">
              <p>{m(s.survivor.text)}</p>
            </Block>
          ) : null}
          <Block title="The biggest risks">
            {s.risks.length ? (
              <ul className="list-disc pl-5">
                {s.risks.map((r) => (
                  <li key={r.id}>{m(r.text)}</li>
                ))}
              </ul>
            ) : (
              <p>The checks found nothing that stands out.</p>
            )}
          </Block>
          <Block title="What the plan assumes">
            <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {s.assumptions.map((a) => (
                <li key={a.label}>
                  <span className="text-ink-2">{a.label}</span> {a.value}
                </li>
              ))}
            </ul>
          </Block>
          <footer className="summary-block flex flex-col gap-1 border-t border-border pt-3 text-[12.5px] text-ink-2">
            {s.caveats.map((c) => (
              <p key={c}>{c}</p>
            ))}
            {!access.canWrite && !access.loading ? (
              <p>
                You have view-only access: you can look and try what-ifs, but not change the plan.
              </p>
            ) : null}
            <details className="summary-noprint mt-1">
              <summary className="cursor-pointer">Where each number comes from</summary>
              <ul className="mt-1 font-mono text-[11.5px]">
                {s.figures.map((f) => (
                  <li key={f.id}>
                    {hidden && f.kind === "money" ? "•••" : f.display}: {f.source}
                  </li>
                ))}
              </ul>
            </details>
          </footer>
        </>
      ) : null}
    </div>
  );
}
