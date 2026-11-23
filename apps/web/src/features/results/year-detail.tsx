/**
 * Year drill-down: a side sheet with the full picture of one year — balances, income,
 * expenses, taxes, flows, withdrawals and an evidence-backed narrative.
 */
import {
  type Finding,
  type PeriodResult,
  type ProjectionResult,
  reconcileYear,
  type SimulationInput,
  type ValueBasis,
  type YearReconciliation,
} from "@glideworth/core";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Flag,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import { Dialog as D } from "radix-ui";
import { type ReactNode, useMemo } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { PartialYearNote, PartialYearToggle, useAnnualise } from "../../components/ui/partial-year";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { isPartialPeriod, periodSpan } from "../../lib/period";
import { useRestoreFocus } from "../../lib/restore-focus";
import { useFormat } from "../../lib/workspace";
import { YearTaxByCountry } from "../crossborder/tax-by-country";
import { bridge } from "./core-bridge";
import { agesLabel, conv, type EntityIndex } from "./model";
import { ledgerByKind, yearNarrative } from "./narrative";

function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <h3 className="eyebrow">{title}</h3>
        {aside ? <span className="text-[11.5px] text-ink-3">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Rows({
  rows,
  money,
  empty = "None this year",
}: {
  rows: [string, number, string?][];
  money: (v: number) => string;
  empty?: string;
}) {
  if (rows.length === 0) return <div className="text-[12.5px] text-ink-3">{empty}</div>;
  const total = rows.reduce((s, r) => s + r[1], 0);
  return (
    <Table>
      <TBody>
        {rows.map(([k, v, sub]) => (
          <TR key={`${k}-${sub ?? ""}`}>
            <TD className="py-1">
              {k}
              {sub ? <span className="ml-1.5 text-[11.5px] text-ink-3">{sub}</span> : null}
            </TD>
            <TD numeric className="py-1">
              {money(v)}
            </TD>
          </TR>
        ))}
        {rows.length > 1 ? (
          <TR>
            <TD className="py-1 font-semibold">Total</TD>
            <TD numeric className="py-1 font-semibold">
              {money(total)}
            </TD>
          </TR>
        ) : null}
      </TBody>
    </Table>
  );
}

export function YearDetailSheet({
  result,
  periodIndex,
  basis,
  index,
  input,
  onClose,
  onNavigate,
}: {
  result: ProjectionResult;
  periodIndex: number | null;
  basis: ValueBasis;
  index: EntityIndex;
  input?: SimulationInput | undefined;
  onClose: () => void;
  onNavigate: (i: number) => void;
}) {
  const open = periodIndex !== null && !!result.periods[periodIndex];
  const restoreFocus = useRestoreFocus();
  return (
    <D.Root open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/20 print:hidden" />
        <D.Content
          {...restoreFocus}
          className="fixed top-0 right-0 bottom-0 z-50 flex w-full max-w-[560px] flex-col border-l border-border bg-surface shadow-pop outline-none"
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if (periodIndex === null) return;
            if (e.key === "ArrowLeft" && periodIndex > 0) onNavigate(periodIndex - 1);
            if (e.key === "ArrowRight" && periodIndex < result.periods.length - 1)
              onNavigate(periodIndex + 1);
          }}
        >
          {open ? (
            <YearDetailBody
              result={result}
              p={result.periods[periodIndex]!}
              basis={basis}
              index={index}
              input={input}
              onNavigate={onNavigate}
            />
          ) : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function YearDetailBody({
  result,
  p,
  basis,
  index,
  input,
  onNavigate,
}: {
  result: ProjectionResult;
  p: PeriodResult;
  basis: ValueBasis;
  index: EntityIndex;
  input?: SimulationInput | undefined;
  onNavigate: (i: number) => void;
}) {
  const f = useFormat();
  // Money that moved during the year (income, spending, tax, saving) is shown at the year's
  // starting prices; balances at the year end at its closing prices (see lib/money.ts).
  const m = (v: number) => f.money(conv(p, v, basis, "flow"));
  // The balances table converts every column at the year-end price level, so each row adds up.
  const mb = (v: number) => f.money(conv(p, v, basis, "stock"));
  const plain = (v: number) => f.money(v);
  const recon = useMemo((): YearReconciliation | null => {
    try {
      return reconcileYear(result, p.index, { basis });
    } catch {
      return null;
    }
  }, [result, p.index, basis]);
  const fxAccounts = p.accounts.filter(
    (a) => a.currency && (a.closingOriginal !== undefined || a.fxGain),
  );
  const i = p.index;
  const narrative = useMemo(
    () => yearNarrative(result, i, basis, index, f.money, (v) => f.percent(v)),
    [result, i, basis, index, f],
  );
  const findings = useMemo((): Finding[] | null => {
    if (!input) return null;
    try {
      return bridge.explainProjection(input, result).findings.filter((x) => x.periodIndex === i);
    } catch {
      return null;
    }
  }, [input, result, i]);
  const name = (ref: string | undefined, fallback: string) =>
    (ref && (index.accounts.get(ref)?.name ?? index.assets.get(ref) ?? index.debts.get(ref))) ||
    fallback;
  const withdrawals = ledgerByKind(p, "withdrawal");
  const flows = [
    ...ledgerByKind(p, "contribution"),
    ...ledgerByKind(p, "transfer"),
    ...ledgerByKind(p, "debt-payment"),
  ];
  const early = result.warnings.filter(
    (w) => w.periodIndex === i && w.code === "EARLY_WITHDRAWAL_PENALTY",
  );
  // How a bonus set as a share of a salary was worked out this year (engine trace).
  const bonusBasis = new Map(
    result.trace
      .filter((t) => t.periodIndex === i && t.code === "BONUS_FROM_SALARY")
      .map((t) => {
        const rate = Number((t.data as { rate?: number } | undefined)?.rate ?? 0);
        const salary = p.income.find((l) => l.sourceId === t.refs[1])?.label ?? "salary";
        return [t.refs[0], `${f.percent(rate)} of ${salary}`] as const;
      }),
  );
  const T = p.totals;
  const annualise = useAnnualise();
  const partial = isPartialPeriod(p);

  return (
    <>
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <div className="eyebrow">Year detail</div>
          <D.Title className="display num text-[24px] font-semibold leading-tight">
            {p.year}
            {partial ? (
              <span className="ml-2 text-[13px] font-normal text-ink-3">
                {periodSpan(p)} · {p.months} {p.months === 1 ? "month" : "months"}
              </span>
            ) : null}
          </D.Title>
          <div className="mt-0.5 text-[12.5px] text-ink-2">{agesLabel(p, index.people)}</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {p.status === "shortfall" ? (
              <Badge tone="negative">Shortfall</Badge>
            ) : (
              <Badge tone="accent">Fully funded</Badge>
            )}
            {p.milestonesReached.map((id) => (
              <Badge key={id} tone="ochre">
                <Flag className="size-3" />{" "}
                {result.milestones.find((x) => x.milestoneId === id)?.name ?? id}
              </Badge>
            ))}
            <Badge>{basis === "real" ? "Today's money" : "Future money"}</Badge>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Previous year"
            disabled={i === 0}
            onClick={() => onNavigate(i - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Next year"
            disabled={i >= result.periods.length - 1}
            onClick={() => onNavigate(i + 1)}
          >
            <ChevronRight />
          </Button>
          <D.Close asChild>
            <Button size="icon" variant="ghost" aria-label="Close">
              <X />
            </Button>
          </D.Close>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {partial ? (
          <div className="mb-4 flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] text-ink-2">Headline figures:</span>
              <PartialYearToggle periods={result.periods} />
            </div>
            <PartialYearNote period={p} />
            {annualise ? (
              <p className="text-[11.5px] text-ink-3">
                The headline figures below are scaled to 12 months; the detail further down (what
                happened, the ledger and “This adds up”) shows the actual {p.months} months.
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="mb-5 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          {(
            [
              ["Net worth", T.netWorth, "stock"],
              ["Income", T.income, "flow"],
              ["Spending", T.spending, "flow"],
              ["Taxes", T.taxes, "flow"],
              ["Saved", T.contributions, "flow"],
              ["Withdrawn", T.withdrawals, "flow"],
            ] as const
          ).map(([k, v, measure]) => (
            <div key={k}>
              <div className="eyebrow">
                {k}
                {partial && annualise && measure === "flow" ? " · a year" : ""}
              </div>
              <div className="num text-[16px] font-semibold">
                {f.money(conv(p, v, basis, measure, { annualise }))}
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-5">
          <Section title="What happened">
            <ul className="flex flex-col gap-1.5">
              {narrative.map((l) => (
                <li key={l.text} className="flex gap-2 text-[13px] leading-snug">
                  <span className="mt-0.5 shrink-0">
                    {l.tone === "negative" ? (
                      <TrendingDown className="size-3.5 text-negative" />
                    ) : l.tone === "warning" ? (
                      <AlertTriangle className="size-3.5 text-warning" />
                    ) : l.tone === "positive" ? (
                      <TrendingUp className="size-3.5 text-positive" />
                    ) : (
                      <span className="block size-3.5 text-center text-ink-3">•</span>
                    )}
                  </span>
                  <span>{l.text}</span>
                </li>
              ))}
              {findings?.map((x) => (
                <li
                  key={x.code + x.title}
                  className="rounded-md bg-surface-2 px-2.5 py-1.5 text-[12.5px]"
                >
                  <span className="font-semibold">{x.title}.</span> {x.message}
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Balances" aside="Opening → closing">
            <Table>
              <THead>
                <TR>
                  <TH>Account</TH>
                  <TH numeric>Opening</TH>
                  <TH numeric>In / out</TH>
                  <TH numeric>Growth</TH>
                  <TH numeric>Closing</TH>
                </TR>
              </THead>
              <TBody>
                {p.accounts
                  .filter((a) => Math.abs(a.opening) > 0.5 || Math.abs(a.closing) > 0.5)
                  .map((a) => {
                    const net = a.contributions - a.withdrawals + a.transfersIn - a.transfersOut;
                    return (
                      <TR key={a.accountId}>
                        <TD className="py-1">
                          {index.accounts.get(a.accountId)?.name ?? a.accountId}
                          {a.currency && a.closingOriginal !== undefined ? (
                            <span className="ml-1.5 text-[11.5px] text-ink-3">
                              {f.moneyIn(a.closingOriginal, a.currency)}
                            </span>
                          ) : null}
                        </TD>
                        <TD numeric className="py-1 text-ink-2">
                          {m(a.opening)}
                        </TD>
                        <TD
                          numeric
                          className={cn("py-1", net < 0 ? "text-negative" : "text-ink-2")}
                        >
                          {Math.abs(net) < 0.5 ? "—" : `${net > 0 ? "+" : "−"}${m(Math.abs(net))}`}
                        </TD>
                        <TD numeric className="py-1 text-ink-2">
                          {m(a.growth + a.dividends - a.fees)}
                        </TD>
                        <TD numeric className="py-1 font-medium">
                          {mb(a.closing)}
                        </TD>
                      </TR>
                    );
                  })}
                {p.realAssets
                  .filter((r) => r.value > 0.5 || r.loanBalance > 0.5)
                  .map((r) => (
                    <TR key={r.assetId}>
                      <TD className="py-1">{index.assets.get(r.assetId) ?? r.assetId}</TD>
                      <TD numeric className="py-1 text-ink-3" colSpan={3}>
                        value {mb(r.value)} · loan {mb(r.loanBalance)}
                      </TD>
                      <TD numeric className="py-1 font-medium">
                        {mb(r.equity)}
                      </TD>
                    </TR>
                  ))}
                {p.debts
                  .filter((d) => d.opening > 0.5 || d.closing > 0.5)
                  .map((d) => (
                    <TR key={d.debtId}>
                      <TD className="py-1">{index.debts.get(d.debtId) ?? d.debtId}</TD>
                      <TD numeric className="py-1 text-ink-2">
                        {mb(-d.opening)}
                      </TD>
                      <TD numeric className="py-1 text-ink-2">
                        {mb(d.payments)}
                      </TD>
                      <TD numeric className="py-1 text-negative">
                        {mb(-d.interest)}
                      </TD>
                      <TD numeric className="py-1 font-medium">
                        {mb(-d.closing)}
                      </TD>
                    </TR>
                  ))}
              </TBody>
            </Table>
          </Section>

          <Section title="Income">
            <Rows
              rows={p.income.map((l) => [
                l.label,
                conv(p, l.amount, basis, "flow"),
                [
                  index.ownerName(l.owner),
                  bonusBasis.get(l.sourceId),
                  l.currency && l.amountOriginal !== undefined
                    ? f.moneyIn(l.amountOriginal, l.currency)
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" · "),
              ])}
              money={plain}
            />
          </Section>
          <Section title="Expenses" aside="Funded">
            <Rows
              rows={p.expenses.map((l) => [
                l.label,
                conv(p, l.funded, basis, "flow"),
                l.requested - l.funded > 0.5
                  ? `${m(l.requested - l.funded)} unfunded`
                  : l.spendingType,
              ])}
              money={plain}
            />
          </Section>
          <Section
            title="Taxes"
            aside={`Effective ${f.percent(p.taxes.effectiveRate)} · marginal ${f.percent(p.taxes.marginalRate)}`}
          >
            <Rows
              rows={p.taxes.lines.map((l) => [
                l.label,
                conv(p, l.amount, basis, "flow"),
                l.basis ? `${l.country ?? l.jurisdictionId} · ${l.basis}` : l.jurisdictionId,
              ])}
              money={plain}
            />
            {p.taxes.byCountry ? (
              <div className="mt-3">
                <YearTaxByCountry
                  p={p}
                  basis={basis}
                  home={input?.household.location.country ?? ""}
                />
              </div>
            ) : null}
          </Section>
          <Section title="Savings flows">
            <Rows
              rows={flows.map((e) => [
                name(e.toRef, e.toLabel),
                conv(p, e.amount, basis, "flow"),
                e.kind.replace("-", " "),
              ])}
              money={plain}
              empty="Nothing saved this year"
            />
          </Section>
          <Section title="Withdrawals">
            {early.length ? (
              <div className="mb-1 flex items-center gap-1.5 rounded-md bg-negative-soft px-2.5 py-1.5 text-[12.5px] text-negative">
                <AlertTriangle className="size-3.5" /> {early[0]!.message}
              </div>
            ) : null}
            <Rows
              rows={withdrawals.map((e) => [
                name(e.fromRef, e.fromLabel),
                conv(p, e.amount, basis, "flow"),
              ])}
              money={plain}
              empty="No withdrawals this year"
            />
          </Section>
          {fxAccounts.length ? (
            <Section title="Currency" aside="Foreign holdings, valued in your base currency">
              <Table>
                <THead>
                  <TR>
                    <TH>Account</TH>
                    <TH numeric>Balance</TH>
                    <TH numeric>Rate</TH>
                    <TH numeric>FX gain</TH>
                  </TR>
                </THead>
                <TBody>
                  {fxAccounts.map((a) => (
                    <TR key={a.accountId}>
                      <TD className="py-1">
                        {index.accounts.get(a.accountId)?.name ?? a.accountId}
                      </TD>
                      <TD numeric className="py-1">
                        {a.closingOriginal !== undefined
                          ? f.moneyIn(a.closingOriginal, a.currency!)
                          : "—"}
                      </TD>
                      <TD numeric className="py-1 text-ink-2">
                        {a.fxRate !== undefined ? f.number(a.fxRate, 4) : "—"}
                      </TD>
                      <TD
                        numeric
                        className={cn(
                          "py-1",
                          (a.fxGain ?? 0) < -0.5 ? "text-negative" : "text-ink-2",
                        )}
                      >
                        {a.fxGain !== undefined && Math.abs(a.fxGain) > 0.5
                          ? f.signed(conv(p, a.fxGain, basis, "flow"))
                          : "—"}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <p className="text-[11.5px] text-ink-3">
                FX gain is the change in the base-currency value from the exchange rate moving; it
                is included in growth above.
              </p>
            </Section>
          ) : null}
          {recon ? <Reconciliation recon={recon} index={index} money={plain} /> : null}
        </div>
      </div>
    </>
  );
}

function Reconciliation({
  recon,
  index,
  money: fmt,
}: {
  recon: YearReconciliation;
  index: EntityIndex;
  money: (v: number) => string;
}) {
  const ok = (d: number) => Math.abs(d) <= Math.max(1, recon.tolerance);
  // Never print "−£0" for a change that rounds to nothing.
  const money = (v: number) => fmt(Math.abs(v) < 0.5 ? 0 : v);
  const t = recon.accounts.total;
  const real = recon.basis === "real";
  return (
    <Section
      title="This adds up"
      aside={
        <span className={recon.balanced ? "text-positive" : "text-negative"}>
          {recon.balanced ? "Balanced" : "Does not balance"}
        </span>
      }
    >
      <p className="text-[12px] text-ink-2">
        Every pound, dollar or euro that moved this year, accounted for: money in equals money out,
        and each account&rsquo;s opening balance plus its flows and growth equals its closing
        balance.
        {real
          ? " In today’s money, money moved during the year is valued at the prices when the year began and closing balances at the prices when it ended (as everywhere else in Glideworth), so “Inflation” shows the buying power the year’s money lost in between."
          : null}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Table>
          <THead>
            <TR>
              <TH>Money in</TH>
              <TH numeric>Amount</TH>
            </TR>
          </THead>
          <TBody>
            {recon.cash.inflows.map((r) => (
              <TR key={`${r.kind}-${r.refId ?? r.label}`}>
                <TD className="py-1">{r.label}</TD>
                <TD numeric className="py-1">
                  {money(r.amount)}
                </TD>
              </TR>
            ))}
            <TR>
              <TD className="py-1 font-semibold">Total in</TD>
              <TD numeric className="py-1 font-semibold">
                {money(recon.cash.totalIn)}
              </TD>
            </TR>
          </TBody>
        </Table>
        <Table>
          <THead>
            <TR>
              <TH>Money out</TH>
              <TH numeric>Amount</TH>
            </TR>
          </THead>
          <TBody>
            {recon.cash.outflows.map((r) => (
              <TR key={`${r.kind}-${r.refId ?? r.label}`}>
                <TD className="py-1">{r.label}</TD>
                <TD numeric className="py-1">
                  {money(r.amount)}
                </TD>
              </TR>
            ))}
            <TR>
              <TD className="py-1 font-semibold">Total out</TD>
              <TD numeric className="py-1 font-semibold">
                {money(recon.cash.totalOut)}
              </TD>
            </TR>
          </TBody>
        </Table>
      </div>
      <Table>
        <THead>
          <TR>
            <TH>Accounts</TH>
            <TH numeric>Opening</TH>
            <TH numeric>In</TH>
            <TH numeric>Growth</TH>
            <TH numeric>Out</TH>
            {real ? <TH numeric>Inflation</TH> : null}
            <TH numeric>Closing</TH>
          </TR>
        </THead>
        <TBody>
          {recon.accounts.rows
            .filter((r) => Math.abs(r.opening) > 0.5 || Math.abs(r.closing) > 0.5)
            .map((r) => (
              <TR key={r.accountId}>
                <TD className="py-1">{index.accounts.get(r.accountId)?.name ?? r.accountId}</TD>
                <TD numeric className="py-1 text-ink-2">
                  {money(r.opening)}
                </TD>
                <TD numeric className="py-1 text-ink-2">
                  {money(r.contributions + r.transfersIn)}
                </TD>
                <TD numeric className="py-1 text-ink-2">
                  {money(r.growth + r.dividendsReinvested - r.fees)}
                </TD>
                <TD numeric className="py-1 text-ink-2">
                  {money(r.withdrawals + r.transfersOut)}
                </TD>
                {real ? (
                  <TD numeric className="py-1 text-ink-3">
                    {money(r.inflation)}
                  </TD>
                ) : null}
                <TD
                  numeric
                  className={cn("py-1 font-medium", !ok(r.difference) && "text-negative")}
                >
                  {money(r.closing)}
                </TD>
              </TR>
            ))}
          <TR>
            <TD className="py-1 font-semibold">All accounts</TD>
            <TD numeric className="py-1 font-semibold">
              {money(t.opening)}
            </TD>
            <TD numeric className="py-1 font-semibold">
              {money(t.contributions + t.transfersIn)}
            </TD>
            <TD numeric className="py-1 font-semibold">
              {money(t.growth + t.dividendsReinvested - t.fees)}
            </TD>
            <TD numeric className="py-1 font-semibold">
              {money(t.withdrawals + t.transfersOut)}
            </TD>
            {real ? (
              <TD numeric className="py-1 font-semibold">
                {money(t.inflation)}
              </TD>
            ) : null}
            <TD numeric className="py-1 font-semibold">
              {money(t.closing)}
            </TD>
          </TR>
        </TBody>
      </Table>
      {recon.netWorth ? (
        <Table>
          <TBody>
            {(
              [
                ["Net worth last year", recon.netWorth.opening],
                ["Change in accounts", recon.netWorth.accounts],
                ["Change in property values", recon.netWorth.realAssets],
                ["Change in loans", -recon.netWorth.loans],
                ["Change in other debts", -recon.netWorth.debts],
                ...(real
                  ? ([
                      [
                        "Inflation (buying power of last year’s net worth)",
                        recon.netWorth.inflation,
                      ],
                    ] as const)
                  : []),
              ] as const
            ).map(([k, v]) => (
              <TR key={k}>
                <TD className="py-1">{k}</TD>
                <TD numeric className="py-1 text-ink-2">
                  {money(v)}
                </TD>
              </TR>
            ))}
            <TR>
              <TD className="py-1 font-semibold">Net worth this year</TD>
              <TD
                numeric
                className={cn(
                  "py-1 font-semibold",
                  !ok(recon.netWorth.difference) && "text-negative",
                )}
              >
                {money(recon.netWorth.closing)}
              </TD>
            </TR>
          </TBody>
        </Table>
      ) : null}
    </Section>
  );
}
