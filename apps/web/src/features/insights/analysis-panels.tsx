/**
 * More analysis on the Insights page, all computed in the analysis worker:
 *  - strategies × metrics heatmap (core `strategyMetricsMatrix`),
 *  - debt payoff strategies: minimum vs avalanche vs snowball (core `compareDebtPayoffStrategies`),
 *  - 72(t) SEPP methods (core `compareSeppMethods`; cheap, so computed inline).
 */
import {
  ACCOUNT_TYPE_INFO,
  compareSeppMethods,
  type Plan,
  type SimulationInput,
  type StrategyMetricsMatrix,
} from "@glideworth/core";
import { useQueryClient } from "@tanstack/react-query";
import { Grid3x3, Landmark, Loader2, Play, Scale } from "lucide-react";
import { useMemo, useState } from "react";
import { HeatTable } from "../../components/charts/heat-table";
import { ErrorState } from "../../components/charts/states";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Field } from "../../components/ui/input";
import { CurrencyInput, NumberInput, PercentInput } from "../../components/ui/number-input";
import { Select } from "../../components/ui/select";
import { SwitchField } from "../../components/ui/switch";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { formatMonth } from "../../lib/format";
import { useFormat } from "../../lib/workspace";
import { useAnalysisQuery } from "../analysis/analysis-client";

const planKey = (plan: Plan, input: SimulationInput) =>
  `${plan.id}:${plan.version}:${input.finances.asOf}`;

// ------------------------------------------------------------------------ strategies × metrics

export function StrategyMatrixPanel({ input, plan }: { input: SimulationInput; plan: Plan }) {
  const f = useFormat();
  const qc = useQueryClient();
  const [success, setSuccess] = useState(true);
  const [started, setStarted] = useState(false);
  const q = useAnalysisQuery<"strategyMatrix">(
    ["strategy-matrix", planKey(plan, input), success],
    { kind: "strategyMatrix", input, opts: { successRate: success } },
    started,
  );
  const m = q.data;
  return (
    <Card>
      <CardHeader
        eyebrow="Compare strategies"
        title="Strategies × outcomes"
        actions={
          q.isFetching ? null : (
            <Button
              size="sm"
              variant={m ? "ghost" : "primary"}
              onClick={() => {
                if (m) void qc.invalidateQueries({ queryKey: ["analysis", "strategy-matrix"] });
                setStarted(true);
              }}
            >
              <Play /> {m ? "Run again" : "Compare"}
            </Button>
          )
        }
      />
      <CardBody className="flex flex-col gap-3">
        <p className="text-[12.5px] text-ink-2">
          Each withdrawal and tax strategy Glideworth can model for your household, scored on
          lifetime tax, what your heirs keep, the chance of success and final net worth. Greener is
          better in each column; the outlined cell is the best.
        </p>
        {!started ? (
          <SwitchField
            label="Include the chance of success"
            hint="Runs Monte Carlo for every strategy; slower."
            checked={success}
            onCheckedChange={setSuccess}
          />
        ) : null}
        {q.isFetching ? (
          <div className="flex items-center gap-2 py-4 text-[12.5px] text-ink-3">
            <Loader2 className="size-4 animate-spin" /> Simulating every strategy in the background…
          </div>
        ) : q.isError ? (
          <ErrorState error={q.error} title="Strategies could not be compared" />
        ) : m ? (
          <MatrixTable m={m} money={(v) => f.money(v, true)} pct={(v) => f.percent(v, 0)} />
        ) : null}
      </CardBody>
    </Card>
  );
}

function MatrixTable({
  m,
  money,
  pct,
}: {
  m: StrategyMetricsMatrix;
  money: (v: number) => string;
  pct: (v: number) => string;
}) {
  const fmt = (j: number, v: number | null) =>
    v === null ? "—" : m.columns[j]!.unit === "share" ? pct(v) : money(v);
  const delta = (j: number, d: number | null, score: number | null) => {
    if (d === null || Math.abs(d) < (m.columns[j]!.unit === "share" ? 0.005 : 0.5)) return null;
    const better = m.columns[j]!.better === "higher" ? d > 0 : d < 0;
    // On a strongly tinted cell the tint already says "better"; keep the text readable.
    const tinted = score !== null && score > 0.62;
    return (
      <div
        className={cn(
          "text-[10.5px] font-normal",
          tinted ? "opacity-85" : better ? "text-positive" : "text-negative",
        )}
      >
        {d > 0 ? "+" : "−"}
        {m.columns[j]!.unit === "share" ? pct(Math.abs(d)) : money(Math.abs(d))}
      </div>
    );
  };
  return (
    <>
      <HeatTable
        caption="Strategies scored on each outcome"
        rowHeader="Strategy"
        tone="good"
        cellWidth={110}
        rows={m.rows.map((r) => ({
          key: r.id,
          label: r.label,
          sub:
            r.status !== "ok"
              ? r.status === "unsupported"
                ? "Not modelled for this plan"
                : r.error
              : undefined,
        }))}
        cols={m.columns.map((c) => ({
          key: c.id,
          label: c.label,
          sub: c.better === "lower" ? "lower is better" : "higher is better",
        }))}
        // oxlint-disable-next-line react/no-unstable-nested-components -- render-prop callback, not a component
        text={(r, c) => (
          <>
            {fmt(c, m.rows[r]!.values[c] ?? null)}
            {r > 0 ? delta(c, m.rows[r]!.deltas[c] ?? null, m.rows[r]!.scores[c] ?? null) : null}
          </>
        )}
        level={(r, c) => m.rows[r]!.scores[c] ?? null}
        highlight={(r, c) => m.best[c] === m.rows[r]!.id}
      />
      <p className="text-[11.5px] text-ink-3">
        The first row is your plan as it stands; differences are against it. Today&rsquo;s money.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------- debt payoff

export function DebtPayoffPanel({ input, plan }: { input: SimulationInput; plan: Plan }) {
  const f = useFormat();
  const fin =
    input.plan.startingConditions.kind === "snapshot"
      ? input.plan.startingConditions.finances
      : input.finances;
  const liabilities = [
    ...fin.debts.filter((d) => !d.archived && d.balance > 0),
    ...fin.realAssets.filter((r) => !r.archived && (r.loan?.balance ?? 0) > 0),
  ];
  const paydownFlows = plan.flows.filter((x) => x.kind === "debtPaydown");
  const [source, setSource] = useState<string>(paydownFlows[0]?.id ?? "extra");
  const [extra, setExtra] = useState<number>(200);
  const [rollover, setRollover] = useState(true);
  const [req, setReq] = useState<{
    flowId?: string;
    extraPerMonth?: number;
    rollover: boolean;
  } | null>(null);
  const q = useAnalysisQuery<"debtPayoff">(
    ["debt-payoff", planKey(plan, input), req],
    req ? { kind: "debtPayoff", input, opts: req } : null,
  );
  if (liabilities.length === 0) return null;
  const c = q.data;
  const best = c?.strategies.find((s) => s.id === c.best);
  return (
    <Card>
      <CardHeader eyebrow="Debts" title="Pay off debt faster: avalanche or snowball?" />
      <CardBody className="flex flex-col gap-4">
        <p className="text-[12.5px] text-ink-2">
          The same extra money each month, aimed three ways: minimum payments only, the{" "}
          <strong className="font-semibold text-ink">avalanche</strong> (highest interest rate
          first: least interest) and the{" "}
          <strong className="font-semibold text-ink">snowball</strong> (smallest balance first:
          quickest wins).
        </p>
        <div className="grid items-end gap-3 sm:grid-cols-[1.4fr_1fr_auto]">
          <Field label="Extra budget">
            {(id) => (
              <Select
                id={id}
                value={source}
                onValueChange={setSource}
                options={[
                  ...paydownFlows.map((x) => ({ value: x.id, label: `Flow: ${x.name}` })),
                  { value: "extra", label: "A fixed amount each month" },
                ]}
              />
            )}
          </Field>
          {source === "extra" ? (
            <Field label="Extra a month">
              {(id) => (
                <CurrencyInput
                  id={id}
                  decimals={0}
                  value={extra}
                  onValueChange={(v) => setExtra(Math.max(0, v ?? 0))}
                />
              )}
            </Field>
          ) : (
            <div />
          )}
          <Button
            variant="primary"
            disabled={q.isFetching || (source === "extra" && !(extra > 0))}
            onClick={() =>
              setReq(
                source === "extra"
                  ? { extraPerMonth: extra, rollover }
                  : { flowId: source, rollover },
              )
            }
          >
            {q.isFetching ? <Loader2 className="animate-spin" /> : <Scale />} Compare
          </Button>
        </div>
        <SwitchField
          label="Roll freed-up payments into the next debt"
          hint="When a debt is paid off, its regular payment joins the extra budget (the classic snowball)."
          checked={rollover}
          onCheckedChange={setRollover}
        />
        {q.isError ? (
          <ErrorState error={q.error} title="Could not compare payoff strategies" />
        ) : null}
        {c ? (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Strategy</TH>
                  <TH numeric>Interest paid</TH>
                  <TH numeric>Saved</TH>
                  <TH numeric>Debt-free</TH>
                </TR>
              </THead>
              <TBody>
                {c.strategies.map((s) => (
                  <TR key={s.id}>
                    <TD>
                      <span className="flex items-center gap-2">
                        {s.label}
                        {s.id === c.best ? (
                          <Badge tone="accent">Highest on this measure</Badge>
                        ) : null}
                      </span>
                    </TD>
                    <TD numeric>{f.money(s.totalInterestReal)}</TD>
                    <TD
                      numeric
                      className={s.interestSavedReal > 0.5 ? "text-positive" : "text-ink-3"}
                    >
                      {s.id === "minimum" ? "—" : f.money(s.interestSavedReal)}
                    </TD>
                    <TD numeric>
                      {s.debtFreeBy ? formatMonth(s.debtFreeBy, f.locale) : "Not in plan"}
                      {s.monthsSooner ? (
                        <div className="text-[11px] text-ink-3">{s.monthsSooner} months sooner</div>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            {best ? (
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Paid off by</TH>
                      {c.strategies.map((s) => (
                        <TH key={s.id} numeric>
                          {s.label}
                        </TH>
                      ))}
                    </TR>
                  </THead>
                  <TBody>
                    {best.debts.map((d) => (
                      <TR key={d.id}>
                        <TD>
                          <span className="flex items-center gap-1.5">
                            <Landmark className="size-3.5 text-ink-3" /> {d.name}
                          </span>
                        </TD>
                        {c.strategies.map((s) => {
                          const x = s.debts.find((y) => y.id === d.id);
                          return (
                            <TD key={s.id} numeric className="text-ink-2">
                              {x?.paidOffBy ? formatMonth(x.paidOffBy, f.locale) : "—"}
                            </TD>
                          );
                        })}
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            ) : null}
            <p className="text-[12px] text-ink-2">{c.explanation}</p>
            <p className="text-[11.5px] text-ink-3">
              Interest in today&rsquo;s money. To use a strategy, open a debt paydown flow in the
              plan editor (Flows) and choose avalanche or snowball.
            </p>
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

// -------------------------------------------------------------------------------- 72(t) SEPP

const SEPP_TYPES = new Set([
  "traditional-ira",
  "401k",
  "403b",
  "457b",
  "sep-ira",
  "simple-ira",
  "solo-401k",
]);

export function SeppPanel({ input }: { input: SimulationInput }) {
  const f = useFormat();
  const accounts = input.finances.accounts.filter(
    (a) =>
      !a.archived &&
      (SEPP_TYPES.has(a.type) ||
        (ACCOUNT_TYPE_INFO[a.type].country === "US" &&
          ACCOUNT_TYPE_INFO[a.type].taxTreatment === "tax-deferred")),
  );
  const primary =
    input.household.people.find((p) => p.role === "primary") ?? input.household.people[0];
  const ageNow = primary
    ? (() => {
        const [y, m] = primary.birthMonth.split("-").map(Number);
        const [ay, am] = input.finances.asOf.split("-").map(Number);
        return Math.floor((ay! * 12 + am! - (y! * 12 + m!)) / 12);
      })()
    : 50;
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const acct = accounts.find((a) => a.id === accountId);
  const [startAge, setStartAge] = useState(Math.min(59, Math.max(40, ageNow)));
  const [rate, setRate] = useState(0.05);
  const [growth, setGrowth] = useState(0.05);
  const result = useMemo(() => {
    if (!acct || !(acct.balance > 0)) return null;
    try {
      return {
        value: compareSeppMethods({
          balance: acct.balance,
          startAge,
          interestRate: rate,
          growthRate: growth,
        }),
      };
    } catch (e) {
      return { error: e };
    }
  }, [acct, startAge, rate, growth]);
  if (input.household.location.country !== "US" && accounts.length === 0) return null;
  return (
    <Card>
      <CardHeader eyebrow="Early access (US)" title="72(t) payments: compare the three methods" />
      <CardBody className="flex flex-col gap-4">
        <p className="text-[12.5px] text-ink-2">
          Substantially equal periodic payments let you draw from an IRA or 401(k) before 59½
          without the 10% penalty, if you keep them up for five years or until 59½, whichever is
          later.
        </p>
        {accounts.length === 0 ? (
          <EmptyState icon={Grid3x3} title="No retirement account to use" compact>
            Add a traditional IRA or 401(k) in Current finances.
          </EmptyState>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Account">
                {(id) => (
                  <Select
                    id={id}
                    value={accountId}
                    onValueChange={setAccountId}
                    options={accounts.map((a) => ({
                      value: a.id,
                      label: a.name,
                      hint: f.money(a.balance, true),
                    }))}
                  />
                )}
              </Field>
              <Field label="Start at age">
                {(id) => (
                  <NumberInput
                    id={id}
                    decimals={0}
                    value={startAge}
                    onValueChange={(v) =>
                      setStartAge(Math.min(70, Math.max(30, Math.round(v ?? startAge))))
                    }
                  />
                )}
              </Field>
              <Field label="Interest rate" hint="Up to 5% or 120% of the federal mid-term rate.">
                {(id) => (
                  <PercentInput
                    id={id}
                    value={rate}
                    onValueChange={(v) => setRate(Math.max(0, Math.min(0.12, v ?? 0.05)))}
                  />
                )}
              </Field>
              <Field label="Assumed growth">
                {(id) => (
                  <PercentInput
                    id={id}
                    value={growth}
                    onValueChange={(v) => setGrowth(v ?? 0.05)}
                  />
                )}
              </Field>
            </div>
            {result && "error" in result ? (
              <ErrorState error={result.error} title="Could not compare" />
            ) : null}
            {result && "value" in result && result.value ? (
              <>
                <Table>
                  <THead>
                    <TR>
                      <TH>Method</TH>
                      <TH numeric>First year</TH>
                      <TH numeric>Total over {result.value.rows[0]?.years} years</TH>
                      <TH numeric>Left after</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {result.value.rows.map((r) => (
                      <TR key={r.method}>
                        <TD>
                          {r.label}
                          <div className="text-[11.5px] text-ink-3">{r.note}</div>
                        </TD>
                        <TD numeric className="font-medium">
                          {f.money(r.firstYearPayment)}
                        </TD>
                        <TD numeric>{f.money(r.totalPayments, true)}</TD>
                        <TD numeric>{f.money(r.endingBalance, true)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
                <p className="text-[11.5px] text-ink-3">
                  Single-life expectancy {f.number(result.value.lifeExpectancy, 1)} years at{" "}
                  {startAge}. Future money (no inflation adjustment); not tax advice.
                </p>
              </>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}
