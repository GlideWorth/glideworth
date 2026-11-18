import {
  ACCOUNT_TYPE_INFO,
  type Finding,
  type GlideworthDocument,
  type Plan,
  type ProjectionResult,
} from "@glideworth/core";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  Camera,
  Dices,
  Flag,
  Info,
  Printer,
  Settings2,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";
import { Popover } from "radix-ui";
import { type ReactNode, useMemo } from "react";
import { useChartPrefs } from "../../components/charts/chart-prefs";
import { Sparkline } from "../../components/charts/mini";
import { categoryColor } from "../../components/charts/palette";
import { ChartLoading, ErrorState } from "../../components/charts/states";
import { Page } from "../../components/layout/app-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Stat } from "../../components/ui/stat";
import { useCloudSession } from "../../lib/auth";
import { formatMonth } from "../../lib/format";
import { financesInBase } from "../../lib/fx-math";
import { firstFullYear, total } from "../../lib/money";
import { useResolvedTheme } from "../../lib/theme";
import { useFormat, useProjection } from "../../lib/workspace";
import { successTone } from "../../stores/prefs";
import { useUi } from "../../stores/ui";
import { useMcStore } from "../chance/mc-store";
import { ChangesSinceCheckInCard, useChangesSinceCheckin } from "../checkins/checkins";
import { attempt, bridge } from "../results/core-bridge";
import {
  buildEntityIndex,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  retirementIndex,
} from "../results/model";
import { ProjectionChart } from "../results/projection-chart";
import { useAnalysis } from "../results/use-analysis";

const WIDGETS = [
  ["metrics", "Plan headline metrics"],
  ["projection", "Projected net worth"],
  ["checkin", "What changed since my last check-in"],
  ["milestones", "Upcoming milestones"],
  ["warnings", "Assumption checks"],
  ["balances", "Assets & liabilities"],
  ["plans", "Plans"],
  ["actions", "Quick actions"],
] as const;
type WidgetId = (typeof WIDGETS)[number][0];

export function currentNetWorth(doc: GlideworthDocument | undefined) {
  const fin = doc ? financesInBase(doc.finances, doc.household.currency) : undefined;
  const assets =
    (fin?.accounts.reduce((s, a) => s + a.balance, 0) ?? 0) +
    (fin?.realAssets.reduce((s, r) => s + r.currentValue, 0) ?? 0);
  const liabilities =
    (fin?.debts.reduce((s, d) => s + d.balance, 0) ?? 0) +
    (fin?.realAssets.reduce((s, r) => s + (r.loan?.balance ?? 0), 0) ?? 0);
  return { assets, liabilities, netWorth: assets - liabilities };
}

/** Headline FI metrics from a deterministic projection. */
export function fiMetrics(result: ProjectionResult, plan: Plan | undefined) {
  const isFi = (id: string) =>
    plan?.milestones.find((x) => x.id === id)?.kind === "financial-independence" || id === "ms-fi";
  const fiMs = result.milestones.find((m) => isFi(m.milestoneId));
  const hasFiMilestone = (plan?.milestones ?? []).some((m) => isFi(m.id));
  const retireIdx = retirementIndex(result);
  const first = result.periods[0];
  // The retirement year itself is usually part salary, part drawdown (retiring in June draws half a
  // year), so its withdrawal rate understates the real one. Use the first FULL drawdown year.
  const retireMonth = result.milestones.find(
    (m) => m.milestoneId === "ms-retire" || /retire/i.test(m.name),
  )?.month;
  const retireP0 = retireIdx !== null ? result.periods[retireIdx] : undefined;
  const partialRetireYear =
    retireP0 !== undefined && !!retireMonth && retireMonth > retireP0.startMonth;
  const drawdown =
    retireIdx !== null ? result.periods.slice(retireIdx + (partialRetireYear ? 1 : 0)) : [];
  const firstWr =
    drawdown.map((p) => p.totals.withdrawalRate).find((x): x is number => x !== null && x > 0) ??
    null;
  const realReturns = result.periods
    .slice(0, 30)
    .map((p) => (1 + p.market.stocks) / (1 + p.market.inflation) - 1);
  const r = realReturns.length ? realReturns.reduce((s, x) => s + x, 0) / realReturns.length : 0.04;
  const retireP = retireIdx !== null ? result.periods[retireIdx] : undefined;
  const fiTarget = retireP ? 25 * total(retireP, "spending", "real") : null;
  const yearsToRetire = retireIdx ?? 0;
  const coastNumber = fiTarget !== null ? fiTarget / (1 + r) ** yearsToRetire : null;
  const liquidNow = first ? total(first, "liquidNetWorth", "real") : 0;
  const fy = firstFullYear(result);
  const spendP = fy !== null ? result.periods[fy] : undefined;
  return {
    spendingYear: spendP?.year ?? null,
    /** Spending in the first full year, in today's money (what the plan's amounts add up to). */
    spendingReal: spendP ? total(spendP, "spending", "real") : null,
    spendingNominal: spendP ? total(spendP, "spending", "nominal") : null,
    hasFiMilestone,
    fiYear: fiMs?.month ? Number(fiMs.month.slice(0, 4)) : null,
    fiMonth: fiMs?.month ?? null,
    yearsToFi: fiMs?.month && first ? Number(fiMs.month.slice(0, 4)) - first.year : null,
    retireMonth: retireMonth ?? null,
    firstWithdrawalRate: firstWr,
    savingsRate: first?.totals.savingsRate ?? null,
    fiTarget,
    coastNumber,
    coastReached: coastNumber !== null ? liquidNow >= coastNumber : null,
    realReturn: r,
  };
}

function PlanCard({ plan, doc }: { plan: Plan; doc: GlideworthDocument }) {
  const { data, isLoading, error } = useProjection(plan.id);
  const basis = useUi((s) => s.basis);
  const f = useFormat();
  const setActive = useUi((s) => s.setActivePlan);
  const r = data?.result;
  const values = r ? r.periods.map((p) => total(p, "netWorth", basis)) : [];
  const last = r?.periods.at(-1);
  void doc;
  return (
    <button
      type="button"
      onClick={() => setActive(plan.id)}
      className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-left hover:border-border-strong hover:bg-surface-2 pointer-coarse:min-h-11"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 font-medium">
          <span className="truncate">{plan.name}</span>
          {plan.isMain ? <Badge tone="accent">Main</Badge> : null}
          {plan.lineage ? <Badge>Branch</Badge> : null}
        </div>
        <div className="text-[12px] text-ink-3">
          {isLoading
            ? "Simulating…"
            : error
              ? "Cannot simulate yet"
              : r && last
                ? `${r.summary.success ? "Fully funded" : `Short from ${r.summary.firstShortfallYear}`} · ${f.money(total(last, "netWorth", basis), true)} in ${last.year}`
                : ""}
        </div>
      </div>
      <Sparkline
        values={values}
        ariaLabel={`${plan.name} projected net worth`}
        color={r && !r.summary.success ? "var(--negative)" : "var(--accent)"}
      />
    </button>
  );
}

function Customise({
  on,
  set,
}: {
  on: (id: WidgetId) => boolean;
  set: (id: string, v: boolean) => void;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button size="sm" variant="secondary">
          <Settings2 /> Customise
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-[240px] rounded-lg border border-border bg-surface p-3 shadow-pop"
        >
          <div className="mb-2 text-[12.5px] font-semibold">Show on dashboard</div>
          {WIDGETS.map(([id, label]) => (
            <label
              key={id}
              className="flex cursor-pointer items-center gap-2 py-0.5 text-[12.5px] pointer-coarse:min-h-11"
            >
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                checked={on(id)}
                onChange={(e) => set(id, e.target.checked)}
              />
              {label}
            </label>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Quick({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px] font-medium pointer-coarse:min-h-11 hover:border-border-strong hover:bg-surface-2 [&_svg]:size-4 [&_svg]:text-accent"
    >
      {icon}
      {children}
    </Link>
  );
}

/** The last check-in's chance of success, when it was taken on the plan as it is now. */
export function checkInChance(
  last: { planVersion: number; successRate: number | null } | null | undefined,
  planVersion: number | undefined,
): number | null {
  return last && planVersion !== undefined && last.planVersion === planVersion
    ? last.successRate
    : null;
}

/**
 * Who the dashboard greets. Hosted: the signed-in person (the household's first person may be a sample or
 * someone else in the workspace), or a plain "there" when the account has no name. Self-host keeps
 * greeting the household's first person.
 */
export function greetingName(accountName: string | undefined, personName: string | undefined) {
  if (accountName !== undefined) return accountName.trim() || "there";
  return personName ?? "there";
}

export function DashboardView() {
  const { plan, doc, input, result, isLoading, error, basis, f } = useAnalysis();
  const theme = useResolvedTheme();
  const prefs = useChartPrefs((s) => s.dashboardWidgets);
  const setWidget = useChartPrefs((s) => s.setDashboardWidget);
  const on = (id: WidgetId) => prefs[id] !== false;
  const index = useMemo(() => buildEntityIndex(doc, plan), [doc, plan]);
  const now = currentNetWorth(doc);
  const mcEntry = useMcStore((s) => (plan ? s.byPlan[plan.id] : undefined));
  const mc = mcEntry && mcEntry.planVersion === plan?.version ? mcEntry : undefined;
  // Without a run in this browser, the last check-in's chance of success (same plan version) stands in,
  // so the headline agrees with the check-in card below it.
  const lastCheckIn = useChangesSinceCheckin(plan?.id).data?.lastCheckIn;
  const checkedRate = mc ? null : checkInChance(lastCheckIn, plan?.version);
  const primary = doc?.household.people.find((p) => p.role === "primary");
  const accountName = useCloudSession()?.user.name;
  const fi = result ? fiMetrics(result, plan) : null;
  const history = useMemo(
    () =>
      [...(doc?.progress ?? [])]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((s) => s.netWorth),
    [doc],
  );
  const spark = [...history, now.netWorth];
  const prevSnap = history.at(-1);
  const audit = useMemo((): { findings: Finding[]; source: "audit" | "warnings" } => {
    if (input) {
      const a = attempt(() => bridge.auditAssumptions(input));
      if (a.value) return { findings: a.value, source: "audit" };
    }
    const w = (result?.warnings ?? []).filter((x) => x.severity !== "info");
    const seen = new Set<string>();
    return {
      source: "warnings",
      findings: w
        .filter((x) => {
          if (seen.has(x.code)) return false;
          seen.add(x.code);
          return true;
        })
        .map((x) => ({
          code: x.code,
          severity: x.severity === "error" ? "critical" : "warning",
          title: x.message,
          message: "",
          periodIndex: x.periodIndex,
          refs: x.refs,
          evidence: [],
        })),
    };
  }, [input, result]);
  const upcoming = (result?.milestones ?? [])
    .filter((m) => m.status === "reached" && m.month)
    .sort((a, b) => a.month!.localeCompare(b.month!))
    .slice(0, 6);
  const startYear = result?.periods[0]?.year ?? 0;

  return (
    <Page
      title={doc ? `Good to see you, ${greetingName(accountName, primary?.name)}` : "Dashboard"}
      description="Where you stand today and where your main plan is heading."
      actions={<Customise on={on} set={setWidget} />}
    >
      <div className="grid gap-5 rounded-[var(--radius-card)] border border-border bg-surface px-5 py-4 shadow-card md:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)]">
        <div className="flex items-end justify-between gap-4">
          <Stat
            label="Net worth today"
            value={f.money(now.netWorth, true)}
            sub={
              <>
                {f.money(now.assets, true)} assets · {f.money(now.liabilities, true)} liabilities
                {prevSnap !== undefined && Math.abs(now.netWorth - prevSnap) < 0.5 ? (
                  <div className="text-ink-3">Unchanged since last snapshot</div>
                ) : prevSnap !== undefined ? (
                  <div className={now.netWorth >= prevSnap ? "text-positive" : "text-negative"}>
                    {now.netWorth >= prevSnap ? "▲" : "▼"}{" "}
                    {f.money(Math.abs(now.netWorth - prevSnap), true)} since last snapshot
                  </div>
                ) : null}
              </>
            }
          />
          <Link to="/progress" aria-label="Open progress history">
            <Sparkline
              values={spark}
              width={130}
              height={44}
              ariaLabel="Net worth history from progress snapshots"
            />
          </Link>
        </div>
        {on("metrics") ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 sm:gap-x-6 xl:grid-cols-5">
            <Stat
              label={fi?.spendingYear ? `Spending in ${fi.spendingYear}` : "Spending"}
              value={
                fi?.spendingReal !== null && fi?.spendingReal !== undefined
                  ? f.money(basis === "real" ? fi.spendingReal : (fi.spendingNominal ?? 0))
                  : "—"
              }
              sub={basis === "real" ? "Today's money" : "Future money"}
            />
            <Stat
              label="Retirement"
              value={fi?.retireMonth ? fi.retireMonth.slice(0, 4) : "—"}
              sub={
                fi?.retireMonth
                  ? formatMonth(fi.retireMonth, f.locale)
                  : plan
                    ? "No retirement milestone"
                    : undefined
              }
            />
            <Stat
              label="Financial independence"
              value={fi?.fiYear ?? "—"}
              sub={
                fi?.yearsToFi !== null && fi?.yearsToFi !== undefined
                  ? fi.yearsToFi <= 0
                    ? "Reached"
                    : `in ${fi.yearsToFi} year${fi.yearsToFi === 1 ? "" : "s"}`
                  : fi && !fi.hasFiMilestone
                    ? "No FI milestone in this plan"
                    : "Not reached in plan"
              }
            />
            <Stat
              label="Chance of success"
              value={
                mc
                  ? f.percent(mc.result.successRate, 0)
                  : checkedRate !== null
                    ? f.percent(checkedRate, 0)
                    : "—"
              }
              tone={
                mc || checkedRate !== null
                  ? // (i) success bands from Settings → Planning defaults
                    ({ positive: "positive", warning: undefined, negative: "negative" } as const)[
                      successTone(mc ? mc.result.successRate : checkedRate!)
                    ]
                  : undefined
              }
              sub={
                !mc && checkedRate !== null ? (
                  "At the last check-in"
                ) : mc ? (
                  mc.example ? (
                    "Example data"
                  ) : (
                    `${mc.result.trials.toLocaleString(f.locale)} trials`
                  )
                ) : (
                  <Link to="/chance" className="underline">
                    Run it
                  </Link>
                )
              }
            />
            <Stat
              label="Withdrawal rate"
              value={
                fi?.firstWithdrawalRate !== null && fi?.firstWithdrawalRate !== undefined
                  ? f.percent(fi.firstWithdrawalRate)
                  : "—"
              }
              sub={
                fi?.savingsRate !== null && fi?.savingsRate !== undefined && fi.savingsRate > 0
                  ? `First full retirement year · saving ${f.percent(fi.savingsRate)} now`
                  : "First full retirement year"
              }
            />
          </div>
        ) : null}
      </div>

      {on("projection") ? (
        <Card>
          <CardHeader
            eyebrow={plan?.name}
            title="Projected net worth"
            actions={
              <Button size="sm" variant="ghost" asChild>
                <Link to="/results">
                  Full results <ArrowRight />
                </Link>
              </Button>
            }
          />
          <CardBody>
            {isLoading ? <ChartLoading height={260} /> : null}
            {error ? <ErrorState error={error} title="Simulation failed" /> : null}
            {result ? (
              <ProjectionChart
                result={result}
                basis={basis}
                locale={f.locale}
                currency={f.currency}
                index={index}
                plan={plan}
                mode="netWorth"
                kind="bar"
                compact
                height={260}
              />
            ) : null}
            {fi && fi.coastNumber !== null ? (
              <div className="mt-2 text-[12px] text-ink-2">
                <Info className="mr-1 inline size-3.5 text-ink-3" />
                Coast FI number today:{" "}
                <span className="num font-medium">{f.money(fi.coastNumber, true)}</span>
                {fi.coastReached
                  ? " — reached: you could stop saving and still hit your FI target by retirement."
                  : " — not yet reached."}{" "}
                <span className="text-ink-3">
                  (25× retirement spending, discounted at {f.percent(fi.realReturn)} real.)
                </span>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {on("checkin") ? <ChangesSinceCheckInCard planId={plan?.id} /> : null}

      <div className="grid gap-5 md:grid-cols-2">
        {on("milestones") ? (
          <Card>
            <CardHeader eyebrow="Timeline" title="Upcoming milestones" />
            <CardBody className="flex flex-col gap-2">
              {upcoming.length === 0 ? (
                <div className="text-ink-3">No milestones reached in this plan.</div>
              ) : null}
              {upcoming.map((m) => {
                const y = Number(m.month!.slice(0, 4));
                return (
                  <div key={m.milestoneId} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <Flag className="size-3.5 text-ochre" /> {m.name}
                    </span>
                    <span className="num text-[12.5px] text-ink-2">
                      {formatMonth(m.month!, f.locale)}
                      <span className="ml-2 text-ink-3">
                        {y - startYear <= 0 ? "this year" : `in ${y - startYear}y`}
                      </span>
                    </span>
                  </div>
                );
              })}
            </CardBody>
          </Card>
        ) : null}
        {on("warnings") ? (
          <Card>
            <CardHeader
              eyebrow={audit.source === "audit" ? "Assumption audit" : "Simulation warnings"}
              title="Things to check"
              actions={
                <Button size="sm" variant="ghost" asChild>
                  <Link to="/insights">
                    Insights <ArrowRight />
                  </Link>
                </Button>
              }
            />
            <CardBody className="flex flex-col gap-2">
              {audit.findings.length === 0 ? (
                <div className="text-ink-3">Nothing flagged. </div>
              ) : null}
              {audit.findings.slice(0, 5).map((x) => (
                <div key={x.code + x.title} className="flex gap-2 text-[13px]">
                  <AlertTriangle
                    className={`mt-0.5 size-3.5 shrink-0 ${x.severity === "critical" ? "text-negative" : x.severity === "warning" ? "text-warning" : "text-ink-3"}`}
                  />
                  <span>{x.title}</span>
                </div>
              ))}
            </CardBody>
          </Card>
        ) : null}
        {on("balances") ? (
          <Card>
            <CardHeader
              eyebrow="Current finances"
              title="Assets & liabilities"
              actions={
                doc?.finances.asOf ? (
                  <Badge>As of {formatMonth(doc.finances.asOf, f.locale)}</Badge>
                ) : null
              }
            />
            <CardBody className="flex flex-col gap-3 py-3">
              {CATEGORY_ORDER.filter((c) => c !== "real-assets").map((cat) => {
                const accts = (doc?.finances.accounts ?? []).filter(
                  (a) => ACCOUNT_TYPE_INFO[a.type].drawdown === cat,
                );
                if (!accts.length) return null;
                return (
                  <div key={cat}>
                    <div className="mb-0.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-3 uppercase tracking-wide">
                      <span
                        className="size-2 rounded-[2px]"
                        style={{ background: categoryColor(theme, cat) }}
                      />
                      {CATEGORY_LABEL[cat]}
                    </div>
                    {accts.map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center justify-between py-0.5 text-[13px]"
                      >
                        <span className="truncate">{a.name}</span>
                        <span className="num">{f.money(a.balance)}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
              {(doc?.finances.realAssets.length ?? 0) > 0 ? (
                <div>
                  <div className="mb-0.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-3 uppercase tracking-wide">
                    <span
                      className="size-2 rounded-[2px]"
                      style={{ background: categoryColor(theme, "real-assets") }}
                    />
                    Property & real assets
                  </div>
                  {doc?.finances.realAssets.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center justify-between py-0.5 text-[13px]"
                    >
                      <span className="truncate">{r.name}</span>
                      <span className="num">{f.money(r.currentValue)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {now.liabilities > 0 ? (
                <div>
                  <div className="mb-0.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-3 uppercase tracking-wide">
                    <span className="size-2 rounded-[2px] bg-negative" /> Liabilities
                  </div>
                  {doc?.finances.realAssets
                    .filter((r) => r.loan)
                    .map((r) => (
                      <div
                        key={r.id}
                        className="flex items-center justify-between py-0.5 text-[13px]"
                      >
                        <span className="truncate">{r.name} loan</span>
                        <span className="num text-negative">−{f.money(r.loan!.balance)}</span>
                      </div>
                    ))}
                  {doc?.finances.debts.map((d) => (
                    <div
                      key={d.id}
                      className="flex items-center justify-between py-0.5 text-[13px]"
                    >
                      <span className="truncate">{d.name}</span>
                      <span className="num text-negative">−{f.money(d.balance)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </CardBody>
          </Card>
        ) : null}
        {on("plans") && doc ? (
          <Card>
            <CardHeader
              eyebrow="Scenarios"
              title="Plans"
              actions={
                <Button size="sm" variant="ghost" asChild>
                  <Link to="/compare">
                    Compare <ArrowRight />
                  </Link>
                </Button>
              }
            />
            <CardBody className="flex flex-col gap-2">
              {doc.plans.map((p) => (
                <PlanCard key={p.id} plan={p} doc={doc} />
              ))}
            </CardBody>
          </Card>
        ) : null}
      </div>
      {on("actions") ? (
        <Card>
          <CardHeader eyebrow="Shortcuts" title="Quick actions" />
          <CardBody className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <Quick to="/finances" icon={<Wallet />}>
              Update balances
            </Quick>
            <Quick to="/progress" icon={<Camera />}>
              Record a snapshot
            </Quick>
            <Quick to="/chance" icon={<Dices />}>
              Run chance of success
            </Quick>
            <Quick to="/insights" icon={<SlidersHorizontal />}>
              Solve & stress-test
            </Quick>
            <Quick to="/reports" icon={<Printer />}>
              Print plan report
            </Quick>
          </CardBody>
        </Card>
      ) : null}
    </Page>
  );
}
