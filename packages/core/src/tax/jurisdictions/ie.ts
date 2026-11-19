/**
 * Ireland: income tax (20% / 40% with the single, single-parent and married bands, joint
 * assessment), personal, employee (PAYE), earned-income and age credits, USC with its exemption
 * threshold, Class A PRSI, DIRT on deposit interest, CGT with the annual exemption, age-related
 * pension relief and the lifetime limits on tax-free retirement lump sums. Data: ../data/ie.ts.
 * Known simplifications: IE_SIMPLIFICATIONS.
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
  statePensionOf,
} from "../common.js";
import { IE_SIMPLIFICATIONS, IE_YEARS, type IeYear } from "../data/ie.js";
import type { BracketFill, TaxContributionLimitQuery, TaxYearInput } from "../types.js";
import { type CountryResult, nationalJurisdiction } from "./intl.js";

const ID = "ie";

export function iePensionReliefShare(d: IeYear, age: number): number {
  let r = d.pensionRelief.bands[0]![1];
  for (const [from, share] of d.pensionRelief.bands) if (age >= from) r = share;
  return r;
}

/** Last year with its own table: thresholds stay nominal to here under the legislated policy. */
const LAST_TABLE_YEAR = Math.max(...IE_YEARS.map((y) => y.startYear));

/**
 * Tax on the tax-free share of pension withdrawals (retirement lump sums), given the lifetime total
 * already taken: tax-free to `taxFree`, standard rate to `standardRateTo`, higher rate above.
 */
export function ieLumpSumTax(d: IeYear, prior: number, amount: number): number {
  const L = d.lumpSum;
  const slice = (lo: number, hi: number) =>
    clamp0(Math.min(prior + amount, hi) - Math.max(prior, lo));
  return (
    d.rates.standard * slice(L.taxFree, L.standardRateTo) +
    d.rates.higher * slice(L.standardRateTo, Number.POSITIVE_INFINITY)
  );
}

/** Part of a lump sum above the 20% band (`standardRateTo`), the only part that pays USC. */
export function ieLumpSumExcess(d: IeYear, prior: number, amount: number): number {
  return clamp0(prior + amount - Math.max(prior, d.lumpSum.standardRateTo));
}

/** USC on `income` (0 when income is at or below the exemption threshold). */
export function ieUsc(d: IeYear, income: number, f = 1): number {
  if (income <= d.usc.exemptUpTo * f) return 0;
  return sliceTax(bands(d.usc.rows, f), 0, income).tax;
}

function compute(input: TaxYearInput, explain: boolean): CountryResult {
  const d = pickYear(IE_YEARS, input.year);
  const idx = indexFactor(input, ID, LAST_TABLE_YEAR);
  const fs = idx.factor * periodScale(input);
  const people = alivePeople(input);
  const joint = input.filingStatus === "married-joint" && people.length === 2;
  const sink = new LineSink(ID);
  const facts: Record<string, number> = {
    ...idx.facts,
    "tax.year": input.year,
    "tax.priceIndex": input.priceIndex,
  };
  const fill: BracketFill[] = [];
  const multi = people.length > 1;
  const per = people.map((p) => {
    const b = collectIncome(input, ID, p.id, people);
    const ded = personDeductions(input, p.id, people);
    const earnings = b.wage + b.selfEmployment;
    const relief = Math.min(
      ded.pretax,
      iePensionReliefShare(d, p.age) * Math.min(earnings, d.pensionRelief.earningsCap * idx.factor),
    );
    const dividends = b.qualifiedDividends + b.ordinaryDividends;
    const income = clamp0(
      b.wage +
        b.selfEmployment +
        b.pension +
        b.socialSecurity +
        b.deferredWithdrawals +
        b.rental +
        b.ordinary +
        dividends -
        relief -
        ded.deductions,
    );
    const state = statePensionOf(input, p.id, people);
    const uscBase = clamp0(
      b.wage +
        b.selfEmployment +
        b.pension +
        b.socialSecurity -
        state +
        b.deferredWithdrawals +
        b.rental +
        b.ordinary +
        dividends,
    );
    const paye = Math.min(d.credits.employee * fs, d.rates.standard * b.wage);
    const earned = Math.min(
      clamp0(d.credits.earned * fs - paye),
      d.rates.standard * b.selfEmployment,
    );
    return { p, b, ded, income, uscBase, paye, earned, earnings };
  });
  // ---- income tax: one joint assessment or one per person
  const groups = joint ? [per] : per.map((x) => [x]);
  groups.forEach((g, gi) => {
    const sfx = !joint && multi ? ` (${g[0]!.p.id})` : "";
    const income = g.reduce((s, x) => s + x.income, 0);
    const kids = input.dependents.some((x) => x.age < 18);
    let band: number;
    if (joint) {
      const lower = Math.min(...g.map((x) => x.income));
      band = d.bands.married * fs + Math.min(d.bands.secondEarnerMax * fs, lower);
    } else
      band =
        (input.filingStatus === "head-of-household" && kids
          ? d.bands.singleParent
          : d.bands.single) * fs;
    const bf: BracketFill["bands"] | undefined = explain ? [] : undefined;
    const t = sliceTax(
      [
        { from: 0, rate: d.rates.standard, label: "Standard rate" },
        { from: band, rate: d.rates.higher, label: "Higher rate" },
      ],
      0,
      income,
      bf,
    );
    if (bf)
      fill.push({
        jurisdictionId: ID,
        ...(joint ? {} : { personId: g[0]!.p.id }),
        schedule: "income",
        bands: bf,
      });
    const C = d.credits;
    const older = g.some((x) => x.p.age >= C.ageFrom);
    const credits =
      (joint ? C.personalMarried : C.personalSingle) * fs +
      g.reduce((s, x) => s + x.paye + x.earned + x.ded.credits, 0) +
      (older ? (joint ? C.ageMarried : C.ageSingle) * fs : 0);
    sink.add("income", `Income tax${joint ? " (joint assessment)" : ""}${sfx}`, t.tax, income);
    sink.add("credit", `Tax credits${sfx}`, -Math.min(credits, t.tax));
    const rate = income > 0 ? t.marginal : 0;
    for (const x of g) facts[`tax.ordinaryBracketRate.${x.p.id}`] = rate;
    if (gi === 0) facts["tax.ordinaryBracketRate"] = rate;
  });
  // ---- per person: USC, PRSI, DIRT, CGT
  let taxable = 0;
  let gross = 0;
  for (const x of per) {
    const sfx = multi ? ` (${x.p.id})` : "";
    const lumpKey = `ie.lumpSumUsed.${x.p.id}`;
    const lumpPrior = input.history[input.history.length - 1]?.[lumpKey] ?? 0;
    // USC applies to the part of retirement lump sums above €500,000 (Revenue TDM 18D-00-01 11.4).
    const uscBase = x.uscBase + ieLumpSumExcess(d, lumpPrior, x.b.deferredTaxFree);
    const usc = ieUsc(d, uscBase, fs);
    const P = d.prsi;
    const prsiRate = input.year > d.startYear ? (P.rateAfter ?? P.rate) : P.rate;
    const prsiWage = x.b.wage > P.weeklyThreshold * 52 * fs ? x.b.wage : 0;
    const prsi = x.p.age < P.untilAge ? prsiRate * (prsiWage + x.b.selfEmployment) : 0;
    const gains = x.b.gainsLong + x.b.gainsShort;
    const cgt = d.cgt.rate * clamp0(gains - d.cgt.exemption * fs);
    sink.add("other", `Universal Social Charge${sfx}`, usc, uscBase);
    sink.add("payroll", `PRSI${sfx}`, prsi);
    sink.add("dividends", `DIRT (deposit interest)${sfx}`, d.dirt * x.b.interest, x.b.interest);
    sink.add("capital-gains", `Capital gains tax${sfx}`, cgt, gains);
    sink.add(
      "income",
      `Tax on retirement lump sum${sfx}`,
      ieLumpSumTax(d, lumpPrior, x.b.deferredTaxFree),
      x.b.deferredTaxFree,
    );
    if (lumpPrior + x.b.deferredTaxFree > 0) facts[lumpKey] = lumpPrior + x.b.deferredTaxFree;
    facts[`ie.taxableIncome.${x.p.id}`] = x.income;
    taxable += x.income;
    gross +=
      x.b.wage +
      x.b.selfEmployment +
      x.b.pension +
      x.b.socialSecurity +
      x.b.deferredWithdrawals +
      x.b.deferredTaxFree +
      x.b.rental +
      x.b.ordinary +
      x.b.interest +
      x.b.qualifiedDividends +
      x.b.ordinaryDividends +
      gains;
  }
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

function contributionLimit(q: TaxContributionLimitQuery): number | null {
  if (q.accountType !== "ie-pension") return null;
  const d = pickYear(IE_YEARS, q.year);
  return (
    iePensionReliefShare(d, q.ownerAge) * Math.min(q.earnedIncome, d.pensionRelief.earningsCap)
  );
}

export const ieJurisdiction = nationalJurisdiction({
  id: ID,
  label: "Ireland (income tax, USC, PRSI, DIRT, CGT, pension relief)",
  country: "IE",
  compute,
  contributionLimit,
  pensionAccessAge: (q) =>
    q.accountType === "ie-pension" ? pickYear(IE_YEARS, 2026).pensionRelief.accessAge : null,
  // Principal private residence relief.
  homeSaleExclusion: () => Number.POSITIVE_INFINITY,
  sources: IE_YEARS.flatMap((y) => y.sources.map((s) => ({ taxYear: y.label, ...s }))),
  simplifications: IE_SIMPLIFICATIONS,
});
