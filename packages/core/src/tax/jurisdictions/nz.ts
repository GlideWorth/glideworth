/**
 * New Zealand: progressive income tax per person, ACC earners' levy (capped), imputation credits
 * on dividends, no general capital gains tax, KiwiSaver (contributions from taxed pay, tax-free
 * withdrawals from 65). Data: ../data/nz.ts. Known simplifications: NZ_SIMPLIFICATIONS.
 */
import {
  alivePeople,
  bands,
  clamp0,
  collectIncome,
  indexFactor,
  LineSink,
  periodScale,
  personDeductions,
  pickYear,
  sliceTax,
} from "../common.js";
import { NZ_SIMPLIFICATIONS, NZ_YEARS } from "../data/nz.js";
import type { BracketFill, TaxYearInput } from "../types.js";
import { type CountryResult, nationalJurisdiction } from "./intl.js";

const ID = "nz";

function compute(input: TaxYearInput, explain: boolean): CountryResult {
  const d = pickYear(NZ_YEARS, input.year);
  const idx = indexFactor(input, ID, undefined);
  const fs = idx.factor * periodScale(input);
  const people = alivePeople(input);
  const sink = new LineSink(ID);
  const facts: Record<string, number> = {
    ...idx.facts,
    "tax.year": input.year,
    "tax.priceIndex": input.priceIndex,
  };
  const fill: BracketFill[] = [];
  const multi = people.length > 1;
  let taxable = 0;
  let gross = 0;
  people.forEach((p, i) => {
    const sfx = multi ? ` (${p.id})` : "";
    const b = collectIncome(input, ID, p.id, people);
    const ded = personDeductions(input, p.id, people);
    const dividends = b.qualifiedDividends + b.ordinaryDividends;
    const credit = (dividends * d.imputationRate) / (1 - d.imputationRate);
    // KiwiSaver contributions are not deductible; other user deductions are.
    const income = clamp0(
      b.wage +
        b.selfEmployment +
        b.pension +
        b.socialSecurity +
        b.deferredWithdrawals +
        b.rental +
        b.ordinary +
        b.interest +
        dividends +
        credit -
        ded.deductions,
    );
    const bf: BracketFill["bands"] | undefined = explain ? [] : undefined;
    const t = sliceTax(bands(d.brackets, fs), 0, income, bf);
    if (bf) fill.push({ jurisdictionId: ID, personId: p.id, schedule: "income", bands: bf });
    const acc = d.acc.rate * Math.min(b.wage + b.selfEmployment, d.acc.maxEarnings * fs);
    // Imputation credits are not refundable (excess is carried forward: not modelled).
    const credits = Math.min(t.tax, ded.credits + credit);
    sink.add("income", `Income tax${sfx}`, t.tax, income);
    sink.add("credit", `Imputation and other credits${sfx}`, -credits);
    sink.add("payroll", `ACC earners' levy${sfx}`, acc);
    const rate = income > 0 ? t.marginal : 0;
    facts[`tax.ordinaryBracketRate.${p.id}`] = rate;
    if (i === 0) facts["tax.ordinaryBracketRate"] = rate;
    facts[`nz.untaxedGains.${p.id}`] = b.gainsLong + b.gainsShort;
    taxable += income;
    gross +=
      b.wage +
      b.selfEmployment +
      b.pension +
      b.socialSecurity +
      b.deferredWithdrawals +
      b.deferredTaxFree +
      b.rental +
      b.ordinary +
      b.interest +
      dividends +
      b.gainsLong +
      b.gainsShort;
  });
  const penalty = input.withdrawals.reduce(
    (s, w) => s + clamp0(w.taxableAmount) * w.penaltyRate,
    0,
  );
  sink.add("penalty", "Early withdrawal penalty", penalty);
  const out = {
    lines: sink.lines,
    grossIncome: gross,
    taxableIncome: taxable,
    marginalRate: 0,
    facts,
  };
  return { out: explain ? { ...out, brackets: fill } : out, total: sink.total() };
}

export const nzJurisdiction = nationalJurisdiction({
  id: ID,
  label: "New Zealand (income tax, ACC levy, imputation; no capital gains tax)",
  country: "NZ",
  compute,
  pensionAccessAge: (q) =>
    q.accountType === "nz-kiwisaver" ? pickYear(NZ_YEARS, 2026).kiwisaver.accessAge : null,
  homeSaleExclusion: () => Number.POSITIVE_INFINITY,
  sources: NZ_YEARS.flatMap((y) => y.sources.map((s) => ({ taxYear: y.label, ...s }))),
  simplifications: NZ_SIMPLIFICATIONS,
});
