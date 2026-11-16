/**
 * United Arab Emirates: no personal income tax, capital gains tax, tax on dividends or interest,
 * wealth or inheritance tax for individuals. The plug-in still reports gross income (so effective
 * rates read 0%), charges early-withdrawal penalties that accounts model themselves, and supplies
 * the UAE statutory hooks (the savings-scheme top-up cap, no pension lock, no gain on a home sale).
 * Data and sources: ../data/ae.ts. Out of scope: AE_SIMPLIFICATIONS.
 */
import { alivePeople, clamp0, collectIncome, LineSink, pickYear } from "../common.js";
import { AE_SAVINGS_SCHEME, AE_SIMPLIFICATIONS, AE_YEARS } from "../data/ae.js";
import type { TaxContributionLimitQuery, TaxYearInput } from "../types.js";
import { type CountryResult, nationalJurisdiction } from "./intl.js";

const ID = "ae";

function compute(input: TaxYearInput, explain: boolean): CountryResult {
  pickYear(AE_YEARS, input.year);
  const people = alivePeople(input);
  const sink = new LineSink(ID);
  let gross = 0;
  for (const p of people) {
    const b = collectIncome(input, ID, p.id, people);
    gross +=
      b.wage +
      b.selfEmployment +
      b.pension +
      b.socialSecurity +
      b.ordinary +
      b.interest +
      b.qualifiedDividends +
      b.ordinaryDividends +
      b.rental +
      b.gainsLong +
      b.gainsShort +
      b.deferredWithdrawals +
      b.deferredTaxFree;
  }
  const penalty = input.withdrawals.reduce(
    (s, w) => s + clamp0(w.taxableAmount) * w.penaltyRate,
    0,
  );
  sink.add("penalty", "Early withdrawal penalty", penalty);
  const facts: Record<string, number> = {
    "tax.year": input.year,
    "tax.priceIndex": input.priceIndex,
  };
  for (const p of people) facts[`tax.ordinaryBracketRate.${p.id}`] = 0;
  facts["tax.ordinaryBracketRate"] = 0;
  const out = { lines: sink.lines, grossIncome: gross, taxableIncome: 0, marginalRate: 0, facts };
  return { out: explain ? { ...out, brackets: [] } : out, total: sink.total() };
}

function contributionLimit(q: TaxContributionLimitQuery): number | null {
  // Federal savings scheme: voluntary top-ups up to 25% of the wage (employer contributions are
  // made as employer flows and are not capped here).
  if (q.accountType === "ae-savings-scheme")
    return AE_SAVINGS_SCHEME.voluntaryCapShareOfWage * Math.max(0, q.earnedIncome);
  return null;
}

export const aeJurisdiction = nationalJurisdiction({
  id: ID,
  label: "United Arab Emirates (no personal income tax)",
  country: "AE",
  compute,
  contributionLimit,
  pensionAccessAge: () => null,
  homeSaleExclusion: () => Number.POSITIVE_INFINITY,
  sources: AE_YEARS.flatMap((y) => y.sources.map((s) => ({ taxYear: y.label, ...s }))),
  simplifications: AE_SIMPLIFICATIONS,
});
