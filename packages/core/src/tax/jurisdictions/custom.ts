/**
 * Custom jurisdiction: user-defined rules for any country (TaxConfig.custom / CustomTaxRules).
 * Ordinary brackets (or one flat effective rate), standard deduction + per-person allowance,
 * capital gains (inclusion rate; own table or as ordinary), dividends (own table or as ordinary),
 * payroll table on earned income, wealth tax on a chosen wealth metric (TaxYearInput.wealth) and a
 * financial transaction tax (TaxYearInput.transactions). Household or per-person taxation.
 * 'real' tables are indexed with the price index unless the threshold policy is 'frozen'.
 */
import { ScenarioError } from "../../errors.js";
import type { BracketTable, CustomTaxRules } from "../../schema/tax.js";
import { progressiveTax } from "../brackets.js";
import {
  alivePeople,
  clamp0,
  collectIncome,
  LineSink,
  ownerShare,
  periodScale,
  thresholdPolicy,
} from "../common.js";
import type {
  BracketFill,
  TaxJurisdiction,
  TaxPerson,
  TaxYearInput,
  TaxYearOutput,
} from "../types.js";
import { defaultCharacterForIncomeType } from "./flat.js";

const ID = "custom";

function fillOf(
  table: BracketTable,
  income: number,
  pi: number,
  scale: number,
): BracketFill["bands"] {
  const index = table.basis === "real" ? pi : 1;
  const rows = [...table.brackets].sort((a, b) => a.from - b.from);
  const out: BracketFill["bands"] = [];
  for (let i = 0; i < rows.length; i++) {
    const lo = rows[i]!.from * index * scale;
    const hi = rows[i + 1] ? rows[i + 1]!.from * index * scale : Number.POSITIVE_INFINITY;
    const amt = clamp0(Math.min(income, hi) - lo);
    if (amt > 0)
      out.push({
        label: `${rows[i]!.rate * 100}%`,
        rate: rows[i]!.rate,
        from: lo,
        to: hi,
        amount: amt,
        tax: amt * rows[i]!.rate,
      });
  }
  return out;
}

/** Shift every bracket rate by `delta` (TaxConfig.flat.modifier in custom mode). */
function shifted(table: BracketTable, delta: number): BracketTable {
  if (delta === 0) return table;
  return {
    ...table,
    brackets: table.brackets.map((b) => ({ ...b, rate: Math.max(0, b.rate + delta) })),
  };
}

/** Tax on `amount` stacked on top of `below` in `table` (US-style preferential stacking). */
function stackedTax(
  table: BracketTable,
  below: number,
  amount: number,
  pi: number,
  scale: number,
): number {
  if (amount <= 0) return 0;
  return (
    progressiveTax(below + amount, table, pi, scale).tax -
    progressiveTax(below, table, pi, scale).tax
  );
}

function compute(input: TaxYearInput, explain: boolean): TaxYearOutput {
  const raw: CustomTaxRules | undefined = input.config.custom;
  if (!raw) throw new ScenarioError("tax.mode 'custom' requires tax.custom rules", {});
  const mod = input.config.flat.modifier;
  const rules: CustomTaxRules = {
    ...raw,
    ordinary: shifted(raw.ordinary, mod?.ordinary ?? 0),
    ...(raw.capitalGains
      ? { capitalGains: shifted(raw.capitalGains, mod?.capitalGains ?? 0) }
      : {}),
    ...(raw.flatEffectiveRate !== undefined
      ? { flatEffectiveRate: Math.max(0, raw.flatEffectiveRate + (mod?.ordinary ?? 0)) }
      : {}),
  };
  const pi = thresholdPolicy(input) === "frozen" ? 1 : input.priceIndex;
  const scale = periodScale(input);
  const people = alivePeople(input);
  const groups: (TaxPerson | undefined)[] = rules.perPerson ? people : [undefined];
  const sink = new LineSink(ID);
  const fill: BracketFill[] = [];
  let taxableTotal = 0;
  let grossTotal = 0;
  let marginal = 0;
  const allowanceIndex = pi;
  for (const [gi, g] of groups.entries()) {
    const pid = g?.id;
    const sfx = pid && groups.length > 1 ? ` (${pid})` : "";
    const b = collectIncome(input, ID, pid, people);
    const share = (owner: string) => (pid === undefined ? 1 : ownerShare(owner, pid, people));
    let deductions = 0;
    let credits = 0;
    for (const d of input.deductions) {
      if (d.amount <= 0 || d.employer) continue;
      if (d.kind === "credit") credits += d.amount * share(d.owner);
      else deductions += d.amount * share(d.owner);
    }
    // Bond fund distributions arrive as interest tagged 'bond-dividend'; with their own table they
    // leave ordinary income.
    let bondIncome = 0;
    if (rules.bondDividends)
      for (const it of input.income)
        if (it.incomeType === "bond-dividend" && it.amount > 0 && !it.exemptIn.includes(ID))
          bondIncome += it.amount * share(it.owner);
    const dividends = b.qualifiedDividends + b.ordinaryDividends;
    const gains = b.gainsLong * rules.capitalGainsInclusion;
    const gainsSeparate = !!rules.capitalGains && !rules.capitalGainsAsOrdinary;
    const divSeparate = !!rules.dividends;
    let ordinary =
      b.wage +
      b.selfEmployment +
      b.pension +
      b.socialSecurity +
      b.ordinary +
      b.interest -
      bondIncome +
      b.rental +
      b.gainsShort +
      b.deferredWithdrawals +
      (gainsSeparate ? 0 : gains) +
      (divSeparate ? 0 : dividends);
    const nPeople = pid === undefined ? people.length : 1;
    let allowance =
      (rules.standardDeduction + rules.personalAllowancePerPerson * nPeople) *
        allowanceIndex *
        scale +
      deductions;
    const use = (x: number) => {
      const u = Math.min(x, allowance);
      allowance -= u;
      return x - u;
    };
    ordinary = use(ordinary);
    const gainsT = gainsSeparate ? use(gains) : 0;
    const divAllowance =
      (rules.dividendAllowance ?? 0) *
      (pid === undefined ? people.length : 1) *
      allowanceIndex *
      scale;
    const divT = divSeparate ? clamp0(use(dividends) - divAllowance) : 0;
    const bondT = rules.bondDividends ? use(bondIncome) : 0;
    let ordTax: number;
    if (rules.flatEffectiveRate !== undefined) {
      ordTax = ordinary * rules.flatEffectiveRate;
      if (gi === 0) marginal = rules.flatEffectiveRate;
    } else {
      const r = progressiveTax(ordinary, rules.ordinary, pi, scale);
      ordTax = r.tax;
      if (gi === 0) marginal = r.marginalRate;
      if (explain)
        fill.push({
          jurisdictionId: ID,
          ...(pid ? { personId: pid } : {}),
          schedule: "ordinary",
          bands: fillOf(rules.ordinary, ordinary, pi, scale),
        });
    }
    const cgTax = gainsSeparate
      ? stackedTax(
          rules.capitalGains!,
          rules.capitalGainsOffset === "income" ? ordinary : 0,
          gainsT,
          pi,
          scale,
        )
      : 0;
    const divTax = divSeparate
      ? stackedTax(
          rules.dividends!,
          rules.dividendOffset === "income" ? ordinary : 0,
          divT,
          pi,
          scale,
        )
      : 0;
    const bondTax = rules.bondDividends
      ? progressiveTax(bondT, rules.bondDividends, pi, scale).tax
      : 0;
    const earned = b.wage + b.selfEmployment;
    const payroll = rules.payroll ? progressiveTax(earned, rules.payroll, pi, scale).tax : 0;
    for (const x of rules.extraTaxes ?? []) {
      const base =
        x.base === "earned"
          ? earned
          : x.base === "total"
            ? ordinary + gainsT + divT + bondT
            : ordinary;
      sink.add("income", `${x.name}${sfx}`, progressiveTax(base, x.table, pi, scale).tax, base);
    }
    const before = ordTax + cgTax + divTax + bondTax;
    sink.add("income", `Income tax${sfx}`, ordTax, ordinary);
    sink.add("capital-gains", `Capital gains tax${sfx}`, cgTax, gainsT);
    sink.add("dividends", `Dividend tax${sfx}`, divTax, divT);
    sink.add("dividends", `Bond dividend tax${sfx}`, bondTax, bondT);
    sink.add("payroll", `Payroll tax${sfx}`, payroll, earned);
    sink.add("credit", `Credits${sfx}`, -Math.min(credits, before));
    taxableTotal += ordinary + gainsT + divT + bondT;
    grossTotal +=
      earned +
      b.pension +
      b.socialSecurity +
      b.ordinary +
      b.interest +
      b.rental +
      b.gainsShort +
      b.gainsLong +
      b.deferredWithdrawals +
      b.deferredTaxFree +
      dividends;
  }
  if (rules.wealthTax && input.wealth) {
    const base = input.wealth[rules.wealthTax.metric];
    // Wealth tax is annual: prorate for partial periods.
    const wt = progressiveTax(base, rules.wealthTax.table, pi).tax * scale;
    sink.add("wealth", "Wealth tax", wt, base);
  }
  if (rules.financialTransactionTax && input.transactions) {
    const t = rules.financialTransactionTax;
    const base =
      t.base === "purchases"
        ? input.transactions.purchases
        : t.base === "sales"
          ? input.transactions.sales
          : input.transactions.purchases + input.transactions.sales;
    sink.add("other", "Financial transaction tax", t.rate * base, base);
  }
  const penalty = input.withdrawals.reduce(
    (s, w) => s + clamp0(w.taxableAmount) * w.penaltyRate,
    0,
  );
  sink.add("penalty", "Early withdrawal penalty", penalty);
  const out: TaxYearOutput = {
    lines: sink.lines,
    grossIncome: grossTotal,
    taxableIncome: taxableTotal,
    marginalRate: marginal,
    facts: {
      "custom.taxableIncome": taxableTotal,
      "tax.ordinaryBracketRate": taxableTotal > 0 ? marginal : 0,
    },
  };
  if (explain) out.brackets = fill;
  return out;
}

export const customJurisdiction: TaxJurisdiction = {
  id: ID,
  label: "Custom brackets",
  level: "synthetic",
  status: "implemented",
  owner: "b",
  computeYear: (input) => compute(input, false),
  explainYear: (input) => compute(input, true),
  defaultCharacter: defaultCharacterForIncomeType,
};
