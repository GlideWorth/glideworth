/**
 * Australia (residents): progressive income tax per person, Medicare levy with low-income
 * shade-in, low income tax offset, 50% CGT discount (assets held > 12 months), franked dividends
 * (gross-up + refundable franking credit), super: 15% contributions tax on concessional
 * contributions, Division 293, excess concessional contributions, benefits tax-free from 60,
 * pension-phase earnings untaxed (no tax items arise), minimum pension drawdowns. Data: ../data/au.ts.
 *
 * Not modelled: Medicare levy surcharge (needs private-cover status), SAPTO, HELP repayments,
 * non-resident rates, family Medicare thresholds (each person uses the single threshold).
 */

import {
  alivePeople,
  bands,
  clamp0,
  collectIncome,
  finiteMarginal,
  indexFactor,
  LineSink,
  ownerShare,
  periodScale,
  pickYear,
  sliceTax,
} from "../common.js";
import { AU_SIMPLIFICATIONS } from "../data/anglo.js";
import { AU_YEARS, auMinimumDrawdownRate } from "../data/au.js";
import type {
  RequiredDistributionQuery,
  TaxContributionLimitQuery,
  TaxJurisdiction,
  TaxYearInput,
  TaxYearOutput,
} from "../types.js";
import { defaultCharacterForIncomeType } from "./flat.js";

const ID = "au";
const SUPER = new Set(["au-super-accumulation", "au-super-pension"]);

function compute(input: TaxYearInput): { out: TaxYearOutput; total: number } {
  const d = pickYear(AU_YEARS, input.year);
  const idx = indexFactor(input, "au", undefined);
  const scale = periodScale(input);
  const fs = idx.factor * scale;
  const people = alivePeople(input);
  const sink = new LineSink(ID);
  const multi = people.length > 1;
  let taxableTotal = 0;
  let grossTotal = 0;
  const bracketFacts: Record<string, number> = {};
  const S = d.super;
  for (const p of people) {
    const sfx = multi ? ` (${p.id})` : "";
    const b = collectIncome(input, ID, p.id, people);
    // super benefits: tax-free from 60; under 60 the taxable component is assessable with a 15% offset
    let superTaxable = 0;
    let otherDeferred = 0;
    for (const w of input.withdrawals) {
      if (w.treatment !== "tax-deferred") continue;
      const share = ownerShare(w.owner, p.id, people);
      if (share === 0) continue;
      if (SUPER.has(w.accountType)) {
        if (p.age < S.taxFreeAge) superTaxable += clamp0(w.taxableAmount) * share;
      } else otherDeferred += clamp0(w.taxableAmount) * share;
    }
    let concessional = 0;
    let employerConcessional = 0;
    let deductions = 0;
    let credits = 0;
    for (const it of input.deductions) {
      const share = ownerShare(it.owner, p.id, people);
      if (share === 0 || it.amount <= 0) continue;
      const amt = it.amount * share;
      if (it.kind === "credit") credits += amt;
      else if (it.kind === "deduction") deductions += amt;
      else if (it.employer) employerConcessional += amt;
      else if (!it.accountType || SUPER.has(it.accountType)) concessional += amt;
      else deductions += amt;
    }
    const franked = b.auFranked + b.untaggedQualified;
    const unfranked = b.auUnfranked + b.untaggedOrdinary + b.caEligible + b.caNonEligible;
    const frankingCredit = (franked * d.franking.corporateRate) / (1 - d.franking.corporateRate);
    const netGain = b.gainsLong * (1 - d.cgtDiscount) + b.gainsShort;
    const cap = S.concessionalCap * scale;
    const totalConcessional = concessional + employerConcessional;
    const excess = clamp0(totalConcessional - cap);
    const nonGain =
      b.wage +
      b.selfEmployment +
      b.pension +
      b.socialSecurity +
      b.ordinary +
      b.interest +
      b.rental +
      franked +
      frankingCredit +
      unfranked +
      otherDeferred +
      superTaxable +
      excess -
      concessional -
      deductions;
    const taxable = clamp0(nonGain + netGain);
    const brackets = bands(d.brackets, fs);
    const it = sliceTax(brackets, 0, taxable);
    const incomeTax = it.tax;
    bracketFacts[`tax.ordinaryBracketRate.${p.id}`] = taxable > 0 ? it.marginal : 0;
    if (people[0] === p) bracketFacts["tax.ordinaryBracketRate"] = taxable > 0 ? it.marginal : 0;
    const withoutGains = sliceTax(brackets, 0, clamp0(nonGain)).tax;
    const L = d.lito;
    const lito =
      taxable <= L.taper1Start * fs
        ? L.max * fs
        : taxable <= L.taper2Start * fs
          ? L.max * fs - L.taper1Rate * (taxable - L.taper1Start * fs)
          : clamp0(
              L.max * fs -
                L.taper1Rate * (L.taper2Start - L.taper1Start) * fs -
                L.taper2Rate * (taxable - L.taper2Start * fs),
            );
    const offsets = Math.min(
      incomeTax,
      clamp0(lito) + S.underSixtyOffset * superTaxable + S.contributionsTax * excess + credits,
    );
    const M = d.medicare;
    const thr = (p.age >= 67 ? M.seniorSingleThreshold : M.singleThreshold) * fs;
    const medicare =
      taxable <= thr ? 0 : Math.min(M.rate * taxable, M.shadeInRate * (taxable - thr));
    const contribTax = S.contributionsTax * Math.min(totalConcessional, cap);
    const div293Income = taxable + Math.min(totalConcessional, cap);
    const div293 =
      S.div293Rate *
      Math.min(Math.min(totalConcessional, cap), clamp0(div293Income - S.div293Threshold * scale));
    sink.add("income", `Income tax${sfx}`, withoutGains, taxable);
    sink.add(
      "capital-gains",
      `Capital gains (in income tax)${sfx}`,
      incomeTax - withoutGains,
      netGain,
    );
    sink.add("credit", `Tax offsets (LITO etc.)${sfx}`, -offsets);
    sink.add("credit", `Franking credits${sfx}`, -frankingCredit);
    sink.add("other", `Medicare levy${sfx}`, medicare, taxable);
    sink.add("other", `Super contributions tax (15%)${sfx}`, contribTax, totalConcessional);
    sink.add("other", `Division 293 tax${sfx}`, div293);
    taxableTotal += taxable;
    grossTotal +=
      b.wage +
      b.selfEmployment +
      b.pension +
      b.socialSecurity +
      b.ordinary +
      b.interest +
      b.rental +
      b.qualifiedDividends +
      b.ordinaryDividends +
      b.gainsLong +
      b.gainsShort +
      b.deferredWithdrawals +
      b.deferredTaxFree;
  }
  const penalty = input.withdrawals.reduce(
    (s, w) => s + clamp0(w.taxableAmount) * w.penaltyRate,
    0,
  );
  sink.add("penalty", "Early access penalty", penalty);
  return {
    out: {
      lines: sink.lines,
      grossIncome: grossTotal,
      taxableIncome: taxableTotal,
      marginalRate: 0,
      facts: {
        ...bracketFacts,
        ...idx.facts,
        "tax.year": input.year,
        "tax.priceIndex": input.priceIndex,
        "au.taxableIncome": taxableTotal,
      },
    },
    total: sink.total(),
  };
}

function contributionLimit(q: TaxContributionLimitQuery): number | null {
  if (q.accountType !== "au-super-accumulation") return null;
  const d = pickYear(AU_YEARS, q.year);
  return d.super.concessionalCap * (q.year > d.startYear ? q.priceIndex : 1);
}

function requiredDistribution(q: RequiredDistributionQuery): number {
  if (
    q.accountType !== "au-super-pension" &&
    q.rule !== "au-minimum" &&
    q.rule !== "au-minimum-drawdown"
  )
    return 0;
  return clamp0(q.priorYearEndBalance) * auMinimumDrawdownRate(q.ownerAge);
}

export const auJurisdiction: TaxJurisdiction = {
  id: ID,
  label: "Australia (resident income tax, Medicare levy, super, CGT, franking)",
  level: "national",
  country: "AU",
  status: "implemented",
  owner: "b",
  computeYear(input) {
    const { out } = compute(input);
    out.marginalRate = finiteMarginal((i) => compute(i).total, input, "ordinary");
    return out;
  },
  contributionLimit,
  requiredDistribution,
  // Preservation age is 60 for everyone born after 30 June 1964 (SIS Regulations 6.01).
  pensionAccessAge: (q) => (q.accountType.startsWith("au-super") ? 60 : null),
  defaultCharacter: defaultCharacterForIncomeType,
  // Main residence exemption: the gain on a main home is exempt.
  homeSaleExclusion: () => Number.POSITIVE_INFINITY,
  sources: AU_YEARS.flatMap((y) => y.sources.map((s) => ({ taxYear: y.label, ...s }))),
  simplifications: AU_SIMPLIFICATIONS,
};
