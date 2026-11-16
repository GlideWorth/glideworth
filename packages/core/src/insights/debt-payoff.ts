/**
 * "Compare payoff strategies": run the plan with minimum payments only, the avalanche (highest
 * rate first) and the snowball (smallest balance first) allocation of the same extra budget, and
 * report the interest paid, the interest saved against minimum payments and when each debt (and
 * all debt) is paid off.
 *
 * The extra budget is either an existing debtPaydown flow (`flowId`; its method sets the budget) or
 * a monthly amount (`extraPerMonth`, nominal) paid from surplus cash at top priority.
 */
import { formatMonth, parseMonth } from "../engine/dates.js";
import { simulate as coreSimulate } from "../engine/simulate.js";
import { type ProjectionResult, type SimulationInput, toBasis } from "../engine/types.js";
import { ScenarioError } from "../errors.js";
import type { Flow } from "../schema/flows.js";
import type { SolverDeps } from "../solvers/contracts.js";
import { fmtMoney } from "./format.js";

export type PayoffStrategyId = "minimum" | "avalanche" | "snowball";

export interface DebtPayoffDate {
  id: string;
  name: string;
  /** Last month of the year the balance reaches zero (annual resolution), or null if never. */
  paidOffBy: string | null;
  year: number | null;
  interest: number;
}

export interface PayoffStrategyResult {
  id: PayoffStrategyId;
  label: string;
  /** Interest on the debts in scope over the plan (nominal, and in today's money). */
  totalInterest: number;
  totalInterestReal: number;
  /** Interest saved against minimum payments only (positive = saved). */
  interestSaved: number;
  interestSavedReal: number;
  /** When the last debt in scope is paid off (null: not within the plan). */
  debtFreeBy: string | null;
  /** Months sooner than minimum payments (null when either is never). */
  monthsSooner: number | null;
  debts: DebtPayoffDate[];
  endNetWorthReal: number;
}

export interface PayoffComparison {
  extraPerYear: number | null;
  strategies: PayoffStrategyResult[];
  /** Strategy with the least interest (ties: earliest debt-free date). */
  best: PayoffStrategyId;
  explanation: string;
}

export interface PayoffCompareOptions {
  /** Existing debtPaydown flow whose budget is reallocated by each strategy. */
  flowId?: string;
  /** Otherwise: an extra monthly amount (nominal) paid from surplus. */
  extraPerMonth?: number;
  /** Debts / financed assets in scope (default: every debt and asset loan). */
  targetIds?: string[];
  /** Snowball rollover of freed payments (default true). */
  rollover?: boolean;
}

const COMPARE_FLOW_ID = "payoff-compare";

/** Debts and financed assets with a balance at the start. */
function liabilities(
  input: SimulationInput,
  ids?: string[],
): { id: string; name: string; asset: boolean }[] {
  const sc = input.plan.startingConditions;
  const fin = sc.kind === "snapshot" ? sc.finances : input.finances;
  const excluded = new Set(input.plan.excludedIds);
  const want = ids ? new Set(ids) : null;
  return [
    ...fin.debts
      .filter((d) => !d.archived && !excluded.has(d.id) && d.balance > 0)
      .map((d) => ({ id: d.id, name: d.name, asset: false })),
    ...fin.realAssets
      .filter((r) => !r.archived && !excluded.has(r.id) && (r.loan?.balance ?? 0) > 0)
      .map((r) => ({ id: r.id, name: `${r.name} loan`, asset: true })),
  ].filter((x) => !want || want.has(x.id));
}

function measure(
  r: ProjectionResult,
  scope: { id: string; name: string; asset: boolean }[],
): Omit<
  PayoffStrategyResult,
  "id" | "label" | "interestSaved" | "interestSavedReal" | "monthsSooner"
> {
  let total = 0;
  let totalReal = 0;
  const debts: DebtPayoffDate[] = scope.map((s) => ({
    ...s,
    paidOffBy: null,
    year: null,
    interest: 0,
  }));
  for (const p of r.periods) {
    for (const d of debts) {
      const s = scope.find((x) => x.id === d.id)!;
      let interest = 0;
      let closing = 0;
      if (s.asset) {
        const a = p.realAssets.find((x) => x.assetId === d.id);
        interest = a?.loanInterest ?? 0;
        closing = a?.owned ? a.loanBalance : 0;
      } else {
        const x = p.debts.find((y) => y.debtId === d.id);
        interest = x?.interest ?? 0;
        closing = x?.closing ?? 0;
      }
      d.interest += interest;
      total += interest;
      totalReal += toBasis(interest, p, "real", "flow");
      if (d.paidOffBy === null && closing <= 0.005) {
        d.paidOffBy = formatMonth(parseMonth(p.startMonth) + p.months - 1);
        d.year = p.year;
      }
    }
  }
  const all = debts.every((d) => d.paidOffBy !== null);
  const debtFreeBy = all
    ? debts.reduce<string | null>(
        (m, d) => (m === null || d.paidOffBy! > m ? d.paidOffBy : m),
        null,
      )
    : null;
  return {
    totalInterest: total,
    totalInterestReal: totalReal,
    debtFreeBy,
    debts,
    endNetWorthReal: r.summary.endNetWorthReal,
  };
}

/** Run minimum-only, avalanche and snowball on the same plan and compare them. */
export async function compareDebtPayoffStrategies(
  input: SimulationInput,
  opts: PayoffCompareOptions = {},
  deps: Pick<SolverDeps, "simulate"> = {},
): Promise<PayoffComparison> {
  const sim = deps.simulate ?? ((i: SimulationInput) => coreSimulate(i));
  const scope = liabilities(input, opts.targetIds);
  if (scope.length === 0) throw new ScenarioError("the plan has no debts or loans to pay off", {});
  const plan = input.plan;
  let base: Flow[];
  let flow: Extract<Flow, { kind: "debtPaydown" }>;
  if (opts.flowId) {
    const f = plan.flows.find((x) => x.id === opts.flowId);
    if (f?.kind !== "debtPaydown")
      throw new ScenarioError(`'${opts.flowId}' is not a debt paydown flow`, {
        flowId: opts.flowId,
      });
    flow = f;
    base = plan.flows.filter((x) => x.id !== f.id);
  } else {
    const extra = opts.extraPerMonth ?? 0;
    if (!(extra > 0))
      throw new ScenarioError(
        "give an extra monthly payment or a debt paydown flow to compare",
        {},
      );
    flow = {
      kind: "debtPaydown",
      id: COMPARE_FLOW_ID,
      name: "Extra debt payments",
      owner: "joint",
      range: {
        start: { kind: "planStart", offsetMonths: 0 },
        end: { kind: "planEnd", offsetMonths: 0 },
        endInclusive: false,
      },
      mandatory: false,
      enabled: true,
      targetId: scope[0]!.id,
      method: { kind: "amount", amount: { value: extra, basis: "nominal" }, frequency: "monthly" },
    };
    base = plan.flows;
  }
  const run = (flows: Flow[]) =>
    sim({
      ...input,
      plan: { ...plan, flows },
      options: { ...input.options, trace: "off", lean: false },
    });
  const ids = scope.map((s) => s.id);
  const variants: { id: PayoffStrategyId; label: string; flows: Flow[] }[] = [
    { id: "minimum", label: "Minimum payments only", flows: base },
    ...(["avalanche", "snowball"] as const).map((strategy) => ({
      id: strategy,
      label:
        strategy === "avalanche"
          ? "Avalanche (highest rate first)"
          : "Snowball (smallest balance first)",
      // Extra payments come first in the waterfall so the comparison is about allocation.
      flows: [
        {
          ...flow,
          enabled: true,
          targetId: ids.includes(flow.targetId) ? flow.targetId : ids[0]!,
          allocation: { strategy, targetIds: ids, rollover: opts.rollover ?? true },
        },
        ...base,
      ] as Flow[],
    })),
  ];
  const measured = variants.map((v) => ({ v, m: measure(run(v.flows), scope) }));
  const min = measured[0]!.m;
  const months = (m: string | null) => (m === null ? null : parseMonth(m));
  const strategies: PayoffStrategyResult[] = measured.map(({ v, m }) => {
    const a = months(m.debtFreeBy);
    const b = months(min.debtFreeBy);
    return {
      id: v.id,
      label: v.label,
      ...m,
      interestSaved: min.totalInterest - m.totalInterest,
      interestSavedReal: min.totalInterestReal - m.totalInterestReal,
      monthsSooner: a === null || b === null ? null : b - a,
    };
  });
  const ranked = [...strategies.slice(1)].sort(
    (x, y) =>
      x.totalInterest - y.totalInterest ||
      (months(x.debtFreeBy) ?? Number.POSITIVE_INFINITY) -
        (months(y.debtFreeBy) ?? Number.POSITIVE_INFINITY),
  );
  const best = ranked[0]!.id;
  const cur = input.household.currency;
  const m = (v: number) => fmtMoney(v, { currency: cur });
  const av = strategies.find((s) => s.id === "avalanche")!;
  const sb = strategies.find((s) => s.id === "snowball")!;
  const parts = [
    `Paying extra saves ${m(av.interestSavedReal)} of interest with the avalanche and ${m(sb.interestSavedReal)} with the snowball (today's money) against minimum payments.`,
  ];
  if (Math.abs(av.totalInterestReal - sb.totalInterestReal) > 0.5)
    parts.push(
      `${best === "avalanche" ? "The avalanche" : "The snowball"} costs ${m(Math.abs(av.totalInterestReal - sb.totalInterestReal))} less interest.`,
    );
  else parts.push("Both cost about the same interest for these debts.");
  const freeBy = (s: PayoffStrategyResult) => s.debtFreeBy ?? "not within the plan";
  parts.push(
    `Debt-free by ${freeBy(av)} (avalanche), ${freeBy(sb)} (snowball) and ${freeBy(strategies[0]!)} on minimum payments.`,
  );
  const first = (s: PayoffStrategyResult) =>
    [...s.debts]
      .filter((d) => d.paidOffBy)
      .sort((a, b) => a.paidOffBy!.localeCompare(b.paidOffBy!))[0];
  const sf = first(sb);
  if (sf) parts.push(`The snowball clears ${sf.name} first (${sf.paidOffBy}).`);
  return {
    extraPerYear:
      flow.method.kind === "amount"
        ? flow.method.amount.value *
          {
            once: 1,
            weekly: 52,
            biweekly: 26,
            semimonthly: 24,
            monthly: 12,
            quarterly: 4,
            semiannually: 2,
            yearly: 1,
          }[flow.method.frequency]
        : null,
    strategies,
    best,
    explanation: parts.join(" "),
  };
}
