/**
 * Explainability from the engine's own records: period totals, line items, the ledger and the
 * trace. Every finding cites evidence (`source: 'trace' | 'ledger' | 'period' | 'warning'`).
 */
import {
  type MoneyMeasure,
  type PeriodResult,
  type ProjectionResult,
  type SimulationInput,
  type TraceEntry,
  toBasis,
} from "../engine/types.js";
import { ScenarioError } from "../errors.js";
import type { PatchOp } from "../schema/changes.js";
import type { MilestoneCriterion } from "../schema/milestones.js";
import type { Explanation, Finding } from "./contracts.js";
import { fmtMoney, fmtPercent } from "./format.js";

type Evidence = Record<string, unknown>;

export interface ExplainOptions {
  /** 'real' (default) reports today's money; 'nominal' reports actual future money. */
  basis?: "real" | "nominal";
  locale?: string;
}

const NON_SPENDING = new Set(["tax-payment", "tax-deduction"]);

function money(input: SimulationInput, v: number, o: ExplainOptions = {}): string {
  return fmtMoney(v, {
    currency: input.household.currency,
    locale: o.locale ?? input.household.locale,
  });
}

/** Today's money: flows by the start-of-period index, stocks by the end-of-period index. */
const toReal = (p: PeriodResult, v: number, measure: MoneyMeasure = "flow") =>
  toBasis(v, p, "real", measure);

function traceEvidence(t: TraceEntry): Evidence {
  return {
    source: "trace",
    periodIndex: t.periodIndex,
    phase: t.phase,
    code: t.code,
    message: t.message,
    refs: t.refs,
  };
}

function names(input: SimulationInput): Map<string, string> {
  const m = new Map<string, string>();
  const sc = input.plan.startingConditions;
  const fin = sc.kind === "snapshot" ? sc.finances : input.finances;
  for (const a of [...fin.accounts, ...input.plan.plannedAccounts]) m.set(a.id, a.name);
  for (const r of fin.realAssets) m.set(r.id, r.name);
  for (const d of fin.debts) m.set(d.id, d.name);
  for (const e of [
    ...input.plan.income,
    ...input.plan.expenses,
    ...input.plan.flows,
    ...input.plan.milestones,
  ])
    m.set(e.id, e.name);
  return m;
}

function personAt(input: SimulationInput, p: PeriodResult): string {
  const primary = input.household.people.find((x) => x.role === "primary");
  const age = primary ? p.ages[primary.id] : undefined;
  return age === undefined ? "" : ` (${primary!.name} ${Math.floor(age)})`;
}

// ------------------------------------------------------------------------------------- failure

function failureFindings(
  input: SimulationInput,
  r: ProjectionResult,
  o: ExplainOptions,
): Finding[] {
  const out: Finding[] = [];
  const nm = names(input);
  const idx = r.periods.findIndex((p) => p.status === "shortfall");
  if (idx < 0) return out;
  const fail = r.periods[idx]!;
  const shortfallPeriods = r.periods.filter((p) => p.status === "shortfall");
  const totalReal = r.periods.reduce((s, p) => s + toReal(p, p.totals.shortfall), 0);
  const traces = r.trace
    .filter((t) => t.code === "SHORTFALL")
    .slice(0, 3)
    .map(traceEvidence);
  out.push({
    code: "PLAN_FAILS",
    severity: "critical",
    title: `Money runs short in ${fail.year}`,
    message: `From ${fail.year}${personAt(input, fail)} the plan cannot pay for everything: ${money(input, toReal(fail, fail.totals.shortfall), o)} is unfunded that year and ${money(input, totalReal, o)} in total over ${shortfallPeriods.length} year${shortfallPeriods.length === 1 ? "" : "s"} (today's money).`,
    periodIndex: fail.index,
    refs: [],
    evidence: [
      {
        source: "period",
        periodIndex: fail.index,
        year: fail.year,
        field: "totals.shortfall",
        value: fail.totals.shortfall,
      },
      ...fail.ledger
        .filter((l) => l.kind === "shortfall")
        .map((l) => ({ source: "ledger", periodIndex: fail.index, ...l })),
      ...traces,
    ],
  });

  // What was exhausted, and what was locked away.
  if (fail.accounts.length > 0) {
    const first = r.periods[0]!;
    const emptied = fail.accounts.filter((a) => {
      const start = first.accounts.find((x) => x.accountId === a.accountId);
      return (start?.opening ?? 0) > 1 && a.closing <= 1;
    });
    for (const a of emptied) {
      const when = r.periods.find(
        (p) => (p.accounts.find((x) => x.accountId === a.accountId)?.closing ?? 1) <= 1,
      );
      out.push({
        code: "ACCOUNT_EXHAUSTED",
        severity: "warning",
        title: `${nm.get(a.accountId) ?? a.accountId} ran out`,
        message: `${nm.get(a.accountId) ?? a.accountId} was emptied in ${when?.year ?? fail.year}.`,
        periodIndex: when?.index ?? fail.index,
        refs: [a.accountId],
        evidence: [
          {
            source: "period",
            periodIndex: when?.index ?? fail.index,
            field: `accounts[${a.accountId}].closing`,
            value: a.closing,
          },
        ],
      });
    }
    const locked = fail.accounts.filter((a) => !a.withdrawable && a.closing > 1);
    for (const a of locked) {
      const opens = r.periods.find(
        (p) =>
          p.index > fail.index && p.accounts.find((x) => x.accountId === a.accountId)?.withdrawable,
      );
      out.push({
        code: "FUNDS_LOCKED",
        severity: "warning",
        title: `${nm.get(a.accountId) ?? a.accountId} could not be used`,
        message: `${money(input, toReal(fail, a.closing, "stock"), o)} sits in ${nm.get(a.accountId) ?? a.accountId}, which cannot be withdrawn from in ${fail.year}${opens ? ` (it becomes available in ${opens.year})` : ""}. The gap is a timing problem, not a lack of money.`,
        periodIndex: fail.index,
        refs: [a.accountId],
        evidence: [
          {
            source: "period",
            periodIndex: fail.index,
            field: `accounts[${a.accountId}].withdrawable`,
            value: false,
            balance: a.closing,
          },
        ],
        suggestion:
          "Bridge the gap with accessible savings (cash, ISA, taxable) or move the expense or retirement date.",
      });
    }
  }

  // Largest expenses and taxes in the failure year.
  if (fail.expenses.length > 0) {
    const top = [...fail.expenses].sort((a, b) => b.requested - a.requested).slice(0, 3);
    const tax = fail.taxes.total;
    const parts = top.map((e) => `${e.label} ${money(input, toReal(fail, e.requested), o)}`);
    if (tax > 0) parts.push(`taxes ${money(input, toReal(fail, tax), o)}`);
    out.push({
      code: "SHORTFALL_DRIVERS",
      severity: "info",
      title: `Biggest costs in ${fail.year}`,
      message: `The largest demands that year were ${parts.join(", ")} (today's money).`,
      periodIndex: fail.index,
      refs: top.map((e) => e.sourceId),
      evidence: [
        ...top.map((e) => ({
          source: "period",
          periodIndex: fail.index,
          field: `expenses[${e.sourceId}].requested`,
          value: e.requested,
          label: e.label,
        })),
        ...fail.ledger
          .filter((l) => l.kind === "tax")
          .map((l) => ({ source: "ledger", periodIndex: fail.index, ...l })),
      ],
    });
  }

  // Smallest fix (estimate): one uniform cut to spending that covers the total shortfall.
  const spendable = input.plan.expenses.filter(
    (e) => e.enabled && e.spendingType !== "not-spending" && !NON_SPENDING.has(e.type),
  );
  const totalSpendReal = r.periods.reduce(
    (s, p) =>
      s +
      toReal(
        p,
        p.expenses
          .filter((e) => spendable.some((x) => x.id === e.sourceId))
          .reduce((a, e) => a + e.requested, 0),
      ),
    0,
  );
  if (totalSpendReal > 0 && spendable.length > 0) {
    const cut = Math.min(1, totalReal / totalSpendReal);
    const years = r.periods.length;
    const patch: PatchOp[] = spendable.map((e) => ({
      op: "replace",
      path: `/expenses/[id=${e.id}]/amount/value`,
      value: e.amount.value * (1 - cut),
    }));
    out.push({
      code: "SMALLEST_FIX_ESTIMATE",
      severity: "info",
      title: "What change would roughly close the shortfall",
      message: `Spending about ${fmtPercent(cut)} less every year (roughly ${money(input, totalReal / years, o)} a year in today's money) would cover the shortfall before investment growth and tax effects. Run the max-spending or earliest-retirement solver for an exact answer.`,
      periodIndex: fail.index,
      refs: spendable.map((e) => e.id),
      evidence: [
        { source: "period", field: "sum(shortfall real)", value: totalReal },
        { source: "period", field: "sum(spending real)", value: totalSpendReal },
      ],
      suggestion: "Use solveMaxSpending / solveEarliestRetirement for the exact smallest change.",
      fix: { description: `Example change: reduce planned spending by ${fmtPercent(cut)}`, patch },
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------- withdrawals

function withdrawalFindings(
  input: SimulationInput,
  r: ProjectionResult,
  focus: string | null,
  o: ExplainOptions,
): Finding[] {
  const nm = names(input);
  const w = r.trace.filter((t) => t.code === "WITHDRAWAL" && (!focus || t.refs.includes(focus)));
  if (w.length === 0) return [];
  if (focus) {
    const years = [...new Set(w.map((t) => t.periodIndex))];
    const first = w[0]!;
    const p = r.periods[first.periodIndex];
    const pos = (first.data?.position as number | undefined) ?? null;
    const earlier = p
      ? r.trace
          .filter(
            (t) =>
              t.code === "WITHDRAWAL" &&
              t.periodIndex === first.periodIndex &&
              !t.refs.includes(focus),
          )
          .map((t) => nm.get(t.refs[0] ?? "") ?? t.refs[0])
      : [];
    return [
      {
        code: "WITHDRAWAL_SOURCE",
        severity: "info",
        title: `Why money came from ${nm.get(focus) ?? focus}`,
        message: `${nm.get(focus) ?? focus} is drawn on in ${years.length} year${years.length === 1 ? "" : "s"}, first in ${p?.year ?? "?"}. It is number ${pos ?? "?"} in your drawdown order (${input.plan.drawdown.order
          .map((e) =>
            e.kind === "category"
              ? e.category
              : (nm.get(e.kind === "account" ? e.accountId : e.assetId) ?? "asset"),
          )
          .join(
            " → ",
          )}), so it is used only after ${earlier.length ? earlier.join(", ") : "accounts earlier in the order"} ${earlier.length ? "were used or" : "are"} empty or locked, to cover a gap of ${money(input, p ? toReal(p, Number(first.data?.need ?? 0)) : 0, o)}.`,
        periodIndex: first.periodIndex,
        refs: [focus],
        evidence: w.slice(0, 5).map(traceEvidence),
      },
    ];
  }
  const firstIdx = w[0]!.periodIndex;
  const p = r.periods[firstIdx];
  const order = [...new Set(w.map((t) => t.refs[0]!).filter(Boolean))];
  return [
    {
      code: "WITHDRAWAL_ORDER",
      severity: "info",
      title: "Where withdrawals come from",
      message: `Withdrawals start in ${p?.year ?? "?"}. Accounts are drawn in this order: ${order.map((id) => nm.get(id) ?? id).join(" → ")}, following your drawdown order.`,
      periodIndex: firstIdx,
      refs: order,
      evidence: w.slice(0, 6).map(traceEvidence),
    },
  ];
}

// ------------------------------------------------------------------------------------- milestones

function metricValue(
  c: Extract<MilestoneCriterion, { kind: "metric" }>,
  p: PeriodResult,
): number | null {
  const t = p.totals;
  switch (c.metric.kind) {
    case "netWorth":
      return t.netWorth;
    case "liquidNetWorth":
      return t.liquidNetWorth;
    case "portfolio":
      return t.portfolio;
    case "cash":
      return t.cash;
    case "totalDebt":
      return t.liabilities;
    case "passiveIncome":
      return t.passiveIncome;
    case "income":
      return t.income;
    case "spending":
      return t.spending;
    case "expenses":
      return t.expenses;
    case "accountBalance": {
      const id = c.metric.accountId;
      return p.accounts.find((a) => a.accountId === id)?.closing ?? null;
    }
    case "debtBalance": {
      const id = c.metric.debtId;
      return p.debts.find((d) => d.debtId === id)?.closing ?? null;
    }
    case "loanBalance": {
      const id = c.metric.assetId;
      return p.realAssets.find((a) => a.assetId === id)?.loanBalance ?? null;
    }
  }
}

function thresholdValue(
  c: Extract<MilestoneCriterion, { kind: "metric" }>,
  p: PeriodResult,
): number {
  const th = c.threshold;
  if (th.kind === "amount")
    return th.amount.basis === "real" ? th.amount.value * p.priceIndex : th.amount.value;
  const base = th.of === "expenses" ? p.totals.expenses : p.totals.spending;
  return th.multiple * base;
}

function milestoneFindings(
  input: SimulationInput,
  r: ProjectionResult,
  o: ExplainOptions,
): Finding[] {
  const out: Finding[] = [];
  for (const res of r.milestones) {
    if (res.status !== "never") continue;
    const def = input.plan.milestones.find((m) => m.id === res.milestoneId);
    if (!def || def.kind === "life-expectancy") continue;
    const metric = def.criteria.find(
      (c): c is Extract<MilestoneCriterion, { kind: "metric" }> => c.kind === "metric",
    );
    let message = `${def.name} is never reached before the plan ends.`;
    const evidence: Evidence[] = [];
    if (metric && r.periods.length > 0) {
      const up = metric.comparator === ">=" || metric.comparator === ">";
      let best: { p: PeriodResult; ratio: number; v: number; th: number } | null = null;
      for (const p of r.periods) {
        const v = metricValue(metric, p);
        if (v === null) continue;
        const th = thresholdValue(metric, p);
        const ratio = up ? (th === 0 ? 0 : v / th) : v - th;
        if (!best || (up ? ratio > best.ratio : ratio < best.ratio)) best = { p, ratio, v, th };
      }
      if (best) {
        message = up
          ? `${def.name} needs ${metric.metric.kind} of ${money(input, toReal(best.p, best.th, "stock"), o)}; the closest the plan gets is ${money(input, toReal(best.p, best.v, "stock"), o)} in ${best.p.year} (${fmtPercent(Math.max(0, best.ratio))} of the target, today's money).`
          : `${def.name} needs ${metric.metric.kind} at or below ${money(input, toReal(best.p, best.th, "stock"), o)}; the lowest it gets is ${money(input, toReal(best.p, best.v, "stock"), o)} in ${best.p.year}.`;
        evidence.push({
          source: "period",
          periodIndex: best.p.index,
          year: best.p.year,
          field: metric.metric.kind,
          value: best.v,
          threshold: best.th,
        });
      }
    } else {
      const dep = def.criteria.find((c) => c.kind === "milestone");
      if (dep && dep.kind === "milestone") {
        const other = r.milestones.find((m) => m.milestoneId === dep.milestoneId);
        if (other?.status !== "reached")
          message = `${def.name} depends on ${other?.name ?? dep.milestoneId}, which is never reached.`;
      } else message = `${def.name}'s date falls outside the plan horizon.`;
    }
    out.push({
      code: "MILESTONE_NEVER_REACHED",
      severity: "info",
      title: `${def.name} is not reached`,
      message,
      periodIndex: null,
      refs: [def.id],
      evidence: [
        ...evidence,
        ...r.warnings
          .filter((w) => w.code === "MILESTONE_NEVER_REACHED" && w.refs.includes(def.id))
          .map((w) => ({ source: "warning", ...w })),
      ],
    });
  }
  return out;
}

function penaltyFindings(input: SimulationInput, r: ProjectionResult): Finding[] {
  const nm = names(input);
  const ws = r.warnings.filter((w) => w.code === "EARLY_WITHDRAWAL_PENALTY");
  const byAccount = new Map<string, typeof ws>();
  for (const w of ws) {
    const id = w.refs[0] ?? "?";
    byAccount.set(id, [...(byAccount.get(id) ?? []), w]);
  }
  return [...byAccount.entries()].map(([id, list]) => ({
    code: "EARLY_WITHDRAWAL_PENALTY",
    severity: "warning" as const,
    title: `Penalised early withdrawals from ${nm.get(id) ?? id}`,
    message: `${nm.get(id) ?? id} is drawn before its qualifying age in ${list.length} year${list.length === 1 ? "" : "s"} (first in ${r.periods[list[0]!.periodIndex ?? 0]?.year ?? "?"}), paying an early-withdrawal penalty.`,
    periodIndex: list[0]!.periodIndex,
    refs: [id],
    evidence: list.slice(0, 5).map((w) => ({ source: "warning", ...w })),
    suggestion:
      "Move this account later in the drawdown order, or bridge the early years from accessible accounts.",
  }));
}

/** "Why did this plan fail / why did withdrawal X come from account Y / which milestones were missed?" */
export function explainProjection(
  input: SimulationInput,
  result: ProjectionResult,
  question?: string,
  opts: ExplainOptions = {},
): Explanation {
  const q = (question ?? "").toLowerCase();
  const nm = names(input);
  let focus: string | null = null;
  if (q) {
    const esc = (s: string) => s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mentions = (s: string) => new RegExp(`(^|[^a-z0-9])${esc(s)}($|[^a-z0-9])`).test(q);
    const candidates = [...nm.entries()]
      .filter(([id]) => result.trace.some((t) => t.code === "WITHDRAWAL" && t.refs.includes(id)))
      .flatMap(([id, name]) => [
        { id, text: name },
        { id, text: id },
      ])
      .sort((a, b) => b.text.length - a.text.length);
    focus = candidates.find((c) => mentions(c.text))?.id ?? null;
  }
  const wantWithdrawals = !q || focus !== null || /withdr|drawn|drawdown|account|came from/.test(q);
  const wantFailure = !q || /fail|short|run out|enough|why|wrong/.test(q);
  const wantMilestones = !q || /milestone|reach|never|retire|independen|fi\b/.test(q);
  const findings: Finding[] = [
    ...(wantFailure ? failureFindings(input, result, opts) : []),
    ...(wantWithdrawals ? withdrawalFindings(input, result, focus, opts) : []),
    ...(wantMilestones ? milestoneFindings(input, result, opts) : []),
    ...(wantFailure || wantWithdrawals ? penaltyFindings(input, result) : []),
  ];
  const s = result.summary;
  const last = result.periods[result.periods.length - 1];
  const headline = s.success
    ? `The plan works: every year is fully funded, ending with ${money(input, s.endNetWorthReal, opts)} in today's money${last ? ` in ${last.year}` : ""}.`
    : `The plan runs short from ${s.firstShortfallYear}: ${money(
        input,
        result.periods.reduce((a, p) => a + toReal(p, p.totals.shortfall), 0),
        opts,
      )} of spending cannot be funded (today's money).`;
  return { headline, findings };
}

// ------------------------------------------------------------------------------------- per-year narrative

export interface NarrativeLine {
  label: string;
  amount: number;
  kind: string;
  refId?: string;
}

export interface YearNarrative {
  periodIndex: number;
  year: number;
  basis: "real" | "nominal";
  inflows: NarrativeLine[];
  outflows: NarrativeLine[];
  withdrawals: NarrativeLine[];
  contributions: NarrativeLine[];
  /** Investment growth + dividends - fees across accounts. */
  investmentReturn: number;
  netWorth: { start: number | null; end: number };
  shortfall: number;
  sentences: string[];
  evidence: Evidence[];
}

/** "Where did the money go" for one year, built from the ledger and line items. */
export function explainYear(
  input: SimulationInput,
  result: ProjectionResult,
  periodIndex: number,
  opts: ExplainOptions = {},
): YearNarrative {
  const p = result.periods[periodIndex];
  if (!p) throw new ScenarioError(`no period ${periodIndex}`, { periodIndex });
  if (p.ledger.length === 0 && p.totals.income + p.totals.expenses > 0)
    throw new ScenarioError("explainYear needs a full (non-lean) projection", { periodIndex });
  const basis = opts.basis ?? "real";
  const conv = (v: number) => toBasis(v, p, basis, "flow");
  const m = (v: number) => money(input, v, opts);
  const nodes = new Map(p.ledgerNodes.map((n) => [n.id, n]));
  const label = (id: string) => nodes.get(id)?.label ?? id;
  const sum = (xs: NarrativeLine[]) => xs.reduce((s, x) => s + x.amount, 0);

  const inflows: NarrativeLine[] = p.income
    .filter((l) => l.amount > 0)
    .map((l) => ({
      label: l.label,
      amount: conv(l.amount),
      kind: l.sourceKind,
      refId: l.sourceId,
    }));
  const outflows: NarrativeLine[] = p.expenses
    .filter((e) => e.funded > 0)
    .map((e) => ({
      label: e.label,
      amount: conv(e.funded),
      kind: e.sourceKind,
      refId: e.sourceId,
    }));
  if (p.taxes.total > 0)
    outflows.push({ label: "Taxes", amount: conv(p.taxes.total), kind: "tax" });
  const withdrawals: NarrativeLine[] = p.ledger
    .filter((l) => l.kind === "withdrawal")
    .map((l) => ({
      label: label(l.from),
      amount: conv(l.amount),
      kind: "withdrawal",
      ...(l.causeId ? { refId: l.causeId } : {}),
    }));
  const contributions: NarrativeLine[] = p.ledger
    .filter((l) => l.kind === "contribution" || l.kind === "leftover")
    .map((l) => ({
      label: label(l.to),
      amount: conv(l.amount),
      kind: l.kind,
      ...(l.causeId ? { refId: l.causeId } : {}),
    }));
  const investmentReturn = conv(
    p.accounts.reduce((s, a) => s + a.growth + a.dividends - a.fees, 0),
  );
  const prev = periodIndex > 0 ? result.periods[periodIndex - 1]! : null;
  const netWorth = {
    start: prev ? toBasis(prev.totals.netWorth, prev, basis, "stock") : null,
    end: toBasis(p.totals.netWorth, p, basis, "stock"),
  };
  const shortfall = conv(p.totals.shortfall);

  const top = (xs: NarrativeLine[], n = 4) =>
    [...xs]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, n)
      .map((x) => `${x.label} ${m(x.amount)}`)
      .join(", ");
  const sentences: string[] = [];
  const unit = basis === "real" ? " (today's money)" : "";
  sentences.push(
    inflows.length
      ? `In ${p.year}${personAt(input, p)} ${m(sum(inflows))} came in${unit}: ${top(inflows)}.`
      : `In ${p.year}${personAt(input, p)} there was no income.`,
  );
  if (outflows.length) sentences.push(`${m(sum(outflows))} went out: ${top(outflows)}.`);
  if (contributions.length)
    sentences.push(`${m(sum(contributions))} was saved: ${top(contributions)}.`);
  if (withdrawals.length)
    sentences.push(`${m(sum(withdrawals))} was withdrawn to cover the gap: ${top(withdrawals)}.`);
  if (Math.abs(investmentReturn) > 0.5)
    sentences.push(
      `Investments ${investmentReturn >= 0 ? "grew" : "fell"} by ${m(Math.abs(investmentReturn))}.`,
    );
  if (netWorth.start !== null)
    sentences.push(
      `Net worth ${netWorth.end >= netWorth.start ? "rose" : "fell"} from ${m(netWorth.start)} to ${m(netWorth.end)}.`,
    );
  if (shortfall > 0.005) sentences.push(`${m(shortfall)} of planned spending could not be paid.`);
  const acaSize = p.taxes.facts["us.acaHouseholdSize"];
  if (acaSize)
    sentences.push(
      p.taxes.facts["us.acaHouseholdSizeAuto"]
        ? `The ACA premium tax credit used a household of ${acaSize}: the adults on the tax return plus the dependents still dependent this year.`
        : `The ACA premium tax credit used a household of ${acaSize}, the size set on the ACA expense.`,
    );
  return {
    periodIndex,
    year: p.year,
    basis,
    inflows,
    outflows,
    withdrawals,
    contributions,
    investmentReturn,
    netWorth,
    shortfall,
    sentences,
    evidence: [
      ...p.ledger.map((l) => ({ source: "ledger", periodIndex, ...l })),
      ...result.trace.filter((t) => t.periodIndex === periodIndex).map(traceEvidence),
    ],
  };
}

/** Narratives for every year. */
export function explainYears(
  input: SimulationInput,
  result: ProjectionResult,
  opts: ExplainOptions = {},
): YearNarrative[] {
  return result.periods.map((p) => explainYear(input, result, p.index, opts));
}
