/**
 * The public, read-only page behind a share link (`/share/<token>`). No sign-in and no way into the
 * app: it renders only the snapshot the API serves for the token (`GET /api/v1/shared/{token}`),
 * which never contains the household, people, accounts or other plans.
 */
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { CircleAlert, Eye, Flag } from "lucide-react";
import { useEffect, useMemo } from "react";
import { SeriesChart } from "../../components/charts/series-chart";
import { GlideworthMark } from "../../components/layout/logo";
import { Badge } from "../../components/ui/badge";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Stat } from "../../components/ui/stat";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { ApiRequestError, api, type SharedPlan } from "../../lib/api";
import { formatDay, formatMoney, formatMonth, formatPercent } from "../../lib/format";

const locale = typeof navigator !== "undefined" ? navigator.language : "en-GB";

function useAmount(s: SharedPlan | undefined) {
  return useMemo(() => {
    const unit = s?.privacy;
    return (v: number | null, compact = false): string => {
      if (v === null || unit === "hidden") return "—";
      if (unit === "percent") return formatPercent(v / 100, locale, 1);
      return formatMoney(v, { locale, currency: s?.currency ?? "USD", compact });
    };
  }, [s]);
}

export function SharedPlanPage() {
  const { token } = useParams({ strict: false }) as { token?: string };
  const q = useQuery({
    queryKey: ["shared", token],
    enabled: !!token,
    queryFn: () => api.getShared(token!),
    retry: (n, e) => !(e instanceof ApiRequestError && e.status < 500) && n < 2,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const s = q.data;
  const money = useAmount(s);
  useEffect(() => {
    document.title = s ? `${s.plan.name} · shared with Glideworth` : "Shared plan · Glideworth";
  }, [s]);

  return (
    <div className="min-h-dvh bg-bg text-ink">
      <header className="border-b border-border bg-surface/80">
        <div className="mx-auto flex max-w-[1080px] items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <GlideworthMark />
            <span className="display text-[19px] font-semibold tracking-tight">Glideworth</span>
          </div>
          <Badge tone="accent">
            <Eye className="size-3" /> Read-only snapshot
          </Badge>
        </div>
      </header>
      <main id="main" className="mx-auto flex max-w-[1080px] flex-col gap-5 px-4 py-6 sm:px-6">
        {q.isLoading ? (
          <div role="status" aria-busy="true" className="py-20 text-center text-ink-3">
            Loading the shared plan…
          </div>
        ) : q.error || !s ? (
          <NotAvailable error={q.error} />
        ) : (
          <SharedBody s={s} money={money} />
        )}
        <footer className="mt-4 border-t border-border pt-4 text-center text-[11.5px] text-ink-3">
          Shared from a private Glideworth install. This page shows a snapshot of one plan&rsquo;s
          results; it contains no accounts or personal details and does not update by itself.
        </footer>
      </main>
    </div>
  );
}

function NotAvailable({ error }: { error: unknown }) {
  const gone = error instanceof ApiRequestError && error.status === 404;
  const busy = error instanceof ApiRequestError && error.status === 429;
  return (
    <div className="mx-auto mt-12 flex max-w-[440px] flex-col items-center gap-3 text-center">
      <CircleAlert className="size-8 text-ink-3" />
      <h1 className="display text-[24px] font-semibold">
        {gone
          ? "This link is no longer available"
          : busy
            ? "Too many requests"
            : "Could not load this plan"}
      </h1>
      <p className="text-ink-2">
        {gone
          ? "It may have expired or been revoked by the person who shared it. Ask them for a new link."
          : busy
            ? "Wait a minute and reload the page."
            : "The server could not be reached. Try again in a moment."}
      </p>
    </div>
  );
}

function SharedBody({
  s,
  money,
}: {
  s: SharedPlan;
  money: (v: number | null, compact?: boolean) => string;
}) {
  const hidden = s.privacy === "hidden";
  const sum = s.summary;
  const labels = s.years.map((y) => String(y.year));
  // Percent links carry percentages (123.4 = 123.4% of the starting net worth).
  const chartValue = (v: number | null) =>
    v === null ? null : s.privacy === "percent" ? v / 100 : v;
  const basisLabel =
    s.privacy === "percent"
      ? "% of starting net worth"
      : s.basis === "real"
        ? "Today's money"
        : "Future money";
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="eyebrow mb-1">{s.label ?? "Shared plan"}</div>
          <h1 className="display text-[26px] leading-tight font-semibold text-balance sm:text-[30px]">
            {s.plan.name}
          </h1>
          <p className="mt-1 text-ink-2">
            Snapshot taken {formatDay(s.generatedAt.slice(0, 10), locale)} · link expires{" "}
            {formatDay(s.expiresAt.slice(0, 10), locale)}
            {hidden ? "" : ` · ${basisLabel}`}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-4 rounded-[var(--radius-card)] border border-border bg-surface px-5 py-4 shadow-card sm:grid-cols-4">
        <Stat
          label="Chance of success"
          value={sum.successRate !== null ? formatPercent(sum.successRate, locale, 0) : "—"}
          sub={
            sum.monteCarloTrials
              ? `${sum.monteCarloTrials.toLocaleString(locale)} simulated markets`
              : undefined
          }
        />
        <Stat
          label="Funded"
          value={sum.fundedThroughout ? "Every year" : `Until ${sum.firstShortfallYear}`}
          tone={sum.fundedThroughout ? "positive" : "negative"}
        />
        <Stat label="Retirement" value={sum.retirementYear ?? "—"} />
        <Stat
          label={sum.endYear ? `Net worth in ${sum.endYear}` : "Final net worth"}
          value={money(sum.endNetWorth, true)}
          sub={hidden ? "Amounts hidden by the owner" : basisLabel}
        />
      </div>

      {!hidden ? (
        <Card>
          <CardHeader eyebrow="Projection" title="Net worth and portfolio" />
          <CardBody>
            <SeriesChart
              labels={labels}
              format={s.privacy === "percent" ? "percent" : "money"}
              locale={locale}
              currency={s.currency ?? "USD"}
              height={300}
              ariaLabel={`Projected net worth of ${s.plan.name} by year`}
              markers={
                sum.retirementYear
                  ? [
                      {
                        index: labels.indexOf(String(sum.retirementYear)),
                        label: "Retire",
                        tone: "ochre",
                      },
                    ]
                  : []
              }
              series={[
                {
                  name: "Net worth",
                  color: (t) => t.accent,
                  type: "area",
                  values: s.years.map((y) => chartValue(y.netWorth)),
                },
                {
                  name: "Portfolio",
                  color: (t) => t.ink3,
                  type: "line",
                  dashed: true,
                  values: s.years.map((y) => chartValue(y.portfolio)),
                },
              ]}
            />
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader eyebrow="Timeline" title="Milestones" />
          <CardBody className="flex flex-col gap-2">
            {s.milestones.length === 0 ? (
              <div className="text-ink-3">No milestones reached.</div>
            ) : null}
            {s.milestones.map((m) => (
              <div key={`${m.name}-${m.month}`} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Flag className="size-3.5 text-ochre" /> {m.name}
                </span>
                <span className="num text-[12.5px] text-ink-2">
                  {m.month ? formatMonth(m.month, locale) : "—"}
                </span>
              </div>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader eyebrow="Year by year" title={hidden ? "Funded years" : basisLabel} />
          <div className="max-h-[420px] overflow-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Year</TH>
                  {hidden ? null : (
                    <>
                      <TH numeric>Income</TH>
                      <TH numeric>Spending</TH>
                      <TH numeric className="max-sm:hidden">
                        Taxes
                      </TH>
                      <TH numeric>Net worth</TH>
                    </>
                  )}
                  <TH numeric>Funded</TH>
                </TR>
              </THead>
              <TBody>
                {s.years.map((y) => (
                  <TR key={y.year} className={y.funded ? undefined : "text-negative"}>
                    <TD className="num py-1">{y.year}</TD>
                    {hidden ? null : (
                      <>
                        <TD numeric className="py-1">
                          {money(y.income, true)}
                        </TD>
                        <TD numeric className="py-1">
                          {money(y.spending, true)}
                        </TD>
                        <TD numeric className="py-1 max-sm:hidden">
                          {money(y.taxes, true)}
                        </TD>
                        <TD numeric className="py-1 font-medium">
                          {money(y.netWorth, true)}
                        </TD>
                      </>
                    )}
                    <TD numeric className="py-1">
                      {y.funded ? "Yes" : "Short"}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </Card>
      </div>
      <p className="text-center text-[12px] text-ink-3">{s.note}</p>
    </>
  );
}
