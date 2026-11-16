/**
 * Expense phase: expense events -> expense lines (paid from the cash pool, or preferentially from
 * specific accounts), deductions/credits, payroll deductions, charity (cash, DAF, QCD) and
 * Medicare premiums (explicit events or the US auto-expense per person from 65).
 */
import type { ExpenseEvent } from "../schema/events.js";
import { type PeriodAmountArgs, periodAmount, resolveWindow } from "./amounts.js";
import { type EngineContext, type PeriodState, traceEvent } from "./context.js";
import { monthAtAge } from "./dates.js";
import { fxAt, isForeign } from "./indices.js";
import { resolveRef } from "./milestones.js";
import { pushRequiredExpense } from "./realAssets.js";
import { ownerCutoff } from "./survivor.js";

/** Medicare defaults (monthly, today's money): Part B standard premium and an average Part D. */
export const MEDICARE_DEFAULTS = { partA: 0, partB: 202.9, partD: 39 };

function addTaxDeduction(
  ps: PeriodState,
  sourceId: string,
  amount: number,
  owner: string,
  kind: "deduction" | "credit" | "pre-tax-contribution",
  itemized: boolean,
  levels: ("federal" | "state" | "local")[] = ["federal", "state", "local"],
) {
  if (amount > 0) ps.taxDeductions.push({ sourceId, kind, amount, itemized, levels, owner });
}

/** Synthesise Medicare expense events for each person (US, assumptions.autoMedicare). */
export function autoMedicareEvents(ctx: EngineContext): ExpenseEvent[] {
  if (!ctx.plan.assumptions.autoMedicare || ctx.household.location.country !== "US") return [];
  const out: ExpenseEvent[] = [];
  for (const p of ctx.people) {
    const exists = ctx.plan.expenses.some(
      (e) =>
        e.type === "healthcare" &&
        e.healthcare.kind === "medicare" &&
        e.healthcare.personId === p.id,
    );
    if (exists) continue;
    out.push({
      id: `auto-medicare-${p.id}`,
      type: "healthcare",
      name: `Medicare (${p.name})`,
      owner: p.id,
      amount: { value: 0, basis: "real" },
      frequency: "monthly",
      range: {
        start: { kind: "age", personId: p.id, age: 65, offsetMonths: 0 },
        end: { kind: "planEnd", offsetMonths: 0 },
        endInclusive: false,
      },
      change: { kind: "inflation", plus: ctx.plan.assumptions.healthcareInflationPremium },
      growFromToday: true,
      enabled: true,
      spendingType: "essential",
      payFrom: { kind: "auto" },
      tax: {
        treatment: "auto",
        deductible: false,
        itemized: false,
        deductibleIn: ["federal", "state", "local"],
      },
      healthcare: { kind: "medicare", personId: p.id, supplemental: { kind: "none" } },
    });
  }
  return out;
}

function medicareMonthly(e: Extract<ExpenseEvent, { type: "healthcare" }>): {
  value: number;
  basis: "real" | "nominal";
} {
  const h = e.healthcare;
  if (h.kind !== "medicare") return e.amount;
  const part = (a: { value: number; basis: "real" | "nominal" } | undefined, d: number) =>
    a?.value ?? d;
  const supplemental = h.supplemental.kind === "none" ? 0 : h.supplemental.premium.value;
  return {
    value:
      part(h.partA, MEDICARE_DEFAULTS.partA) +
      part(h.partB, MEDICARE_DEFAULTS.partB) +
      part(h.partD, MEDICARE_DEFAULTS.partD) +
      supplemental,
    basis: h.partB?.basis ?? "real",
  };
}

/**
 * ACA marketplace coverage: the expense amount is the full (unsubsidised) premium. The benchmark
 * (second-lowest-cost silver) premium and household size go to the US federal plug-in, which
 * computes the premium tax credit from ACA MAGI. With `advanceCreditShare` > 0 that share of the
 * expected credit (last year's credit, capped by the benchmark) is paid to the insurer in advance
 * and reduces the premium paid here; the difference is reconciled on the return. Returns the
 * advance credit.
 */
function acaCoverage(
  ctx: EngineContext,
  ps: PeriodState,
  e: Extract<ExpenseEvent, { type: "healthcare" }>,
  base: PeriodAmountArgs,
): number {
  const h = e.healthcare;
  if (h.kind !== "aca") return 0;
  const benchmark = periodAmount(ctx, ps, { ...base, amount: h.benchmarkPremium });
  if (!(benchmark > 0)) return 0;
  const lastPtc = ctx.taxHistory[ctx.taxHistory.length - 1]?.["us.ptc"] ?? 0;
  const advance =
    h.advanceCreditShare > 0 ? h.advanceCreditShare * Math.min(benchmark, lastPtc) : 0;
  const prev = ps.aca;
  ps.aca = {
    benchmarkPremium: (prev?.benchmarkPremium ?? 0) + benchmark,
    householdSize: Math.max(prev?.householdSize ?? 0, h.householdSize),
    ...(h.advanceCreditShare > 0 ? { advanceCredit: (prev?.advanceCredit ?? 0) + advance } : {}),
  };
  traceEvent(
    ctx,
    ps,
    "expenses",
    "ACA_COVERAGE",
    () =>
      `${e.name}: benchmark premium ${benchmark.toFixed(2)}, advance credit ${advance.toFixed(2)}`,
    [e.id],
    { benchmark, advance },
  );
  return advance;
}

export function runExpenses(ctx: EngineContext, ps: PeriodState): void {
  for (const e of ctx.expenseEvents) {
    if (!e.enabled) continue;
    const refs = [e.id];
    const cutoff = ownerCutoff(ctx, e.owner);
    const base: PeriodAmountArgs = {
      amount: e.amount,
      frequency: e.frequency,
      range: e.range,
      change: e.change,
      growFromToday: e.growFromToday,
      refs,
      changeLimit: e.changeLimit,
      recurrence: e.recurrence,
      inflationCategory: e.inflationCategory,
      currency: e.currency,
      cutoff,
    };
    let amount = periodAmount(ctx, ps, base);
    if (e.type === "healthcare" && e.healthcare.kind === "medicare") {
      const h = e.healthcare;
      const person = ctx.people.find((p) => p.id === h.personId);
      const enrol = h.enrollment
        ? resolveRef(ctx, h.enrollment)
        : person
          ? monthAtAge(person.birth, 65)
          : null;
      const w = resolveWindow(ctx, e.range);
      if (typeof enrol === "number" && w.start !== null) {
        amount += periodAmount(ctx, ps, {
          ...base,
          amount: medicareMonthly(e),
          frequency: "monthly",
          window: { start: Math.max(w.start, enrol), end: w.end },
          cutoff: Math.min(cutoff, ownerCutoff(ctx, h.personId)),
        });
      }
    }
    if (e.type === "healthcare" && e.healthcare.kind === "aca" && amount > 0)
      amount -= acaCoverage(ctx, ps, e, base);
    if (!(amount > 0)) continue;
    if (e.type === "healthcare") ps.qualified.healthcare += amount;
    if (e.type === "education") ps.qualified.education += amount;
    if (e.type === "tax-deduction") {
      addTaxDeduction(
        ps,
        e.id,
        amount,
        e.owner,
        e.creditOrDeduction,
        e.tax.itemized,
        e.tax.deductibleIn,
      );
      continue;
    }
    const line = {
      sourceId: e.id,
      sourceKind: "expense" as const,
      label: e.name,
      category: e.type,
      owner: e.owner,
      requested: amount,
      funded: amount,
      spendingType: e.spendingType,
      ...(isForeign(ctx, e.currency)
        ? {
            currency: e.currency,
            requestedOriginal: amount / fxAt(ctx, e.currency, ps.bounds.start),
          }
        : {}),
    };
    pushRequiredExpense(ps, line);
    const qcd = e.type === "charity" && e.charity?.vehicle === "qcd" && e.charity.qcdFromAccountId;
    if (qcd) ps.targeted.push({ line, accountIds: [e.charity!.qcdFromAccountId!], qcd: true });
    else if (e.payFrom.kind === "accounts")
      ps.targeted.push({ line, accountIds: e.payFrom.accountIds });
    if (e.tax.payrollDeductionFromIncomeId)
      addTaxDeduction(ps, e.id, amount, e.owner, "pre-tax-contribution", false, e.tax.deductibleIn);
    else if (e.tax.deductible && !qcd)
      addTaxDeduction(ps, e.id, amount, e.owner, "deduction", e.tax.itemized, e.tax.deductibleIn);
  }
}
