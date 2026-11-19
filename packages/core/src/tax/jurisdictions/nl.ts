/**
 * Netherlands: box 1 (brackets below / at AOW age, incl. premies volksverzekeringen), algemene
 * heffingskorting and arbeidskorting with their phase-outs, ouderenkorting and alleenstaande-
 * ouderenkorting, box 2 (substantial interest), box 3 (2026 deemed-return regime with the
 * heffingsvrij vermogen) and the income-related Zvw contribution on non-wage income. Pension
 * contributions are deducted from box 1.
 * Data: ../data/nl.ts. Known simplifications: NL_SIMPLIFICATIONS.
 */
import {
  alivePeople,
  bands,
  birthYearOf,
  clamp0,
  collectIncome,
  indexFactor,
  LineSink,
  ownerShare,
  periodScale,
  personDeductions,
  pickYear,
  sliceTax,
} from "../common.js";
import { NL_SIMPLIFICATIONS, NL_YEARS, type NlYear, nlAowAge } from "../data/nl.js";
import type { BracketFill, TaxYearInput } from "../types.js";
import { type CountryResult, nationalJurisdiction } from "./intl.js";

const ID = "nl";

/** Algemene heffingskorting for verzamelinkomen `vi`. */
export function nlAhk(d: NlYear, vi: number, aow: boolean, f = 1): number {
  const [max, start, rate] = aow ? d.ahk.aow : d.ahk.belowAow;
  return clamp0(max * f - rate * clamp0(vi - start * f));
}

/** Arbeidskorting for arbeidsinkomen `ai`. */
export function nlArbeidskorting(d: NlYear, ai: number, aow: boolean, f = 1): number {
  if (ai <= 0 || ai >= d.arbeidskorting.zeroFrom * f) return 0;
  const rows = aow ? d.arbeidskorting.aow : d.arbeidskorting.belowAow;
  let row = rows[0]!;
  for (const r of rows) if (ai >= r[0] * f) row = r;
  return clamp0(row[1] * f + row[2] * (ai - row[0] * f));
}

export function nlOuderenkorting(d: NlYear, vi: number, f = 1): number {
  const o = d.ouderenkorting;
  return clamp0(o.max * f - o.rate * clamp0(vi - o.threshold * f));
}

/** Box 3 tax for the household (annual, before proration) and its taxable benefit (voordeel). */
export function nlBox3(
  d: NlYear,
  w: NonNullable<TaxYearInput["wealth"]>,
  persons: number,
  f = 1,
): { tax: number; voordeel: number; grondslag: number } {
  const B = d.box3;
  const savings = clamp0(w.cash ?? 0);
  const other = clamp0(w.taxableInvestments ?? w.portfolio);
  const debts = clamp0((w.debts ?? 0) - B.schuldendrempel * persons * f);
  const base = savings + other - debts;
  if (base <= 0) return { tax: 0, voordeel: 0, grondslag: 0 };
  const ret = savings * B.returnSavings + other * B.returnOther - debts * B.returnDebts;
  const grondslag = clamp0(base - B.heffingsvrijVermogen * persons * f);
  const voordeel = (clamp0(ret) * grondslag) / base;
  return { tax: B.rate * voordeel, voordeel, grondslag };
}

function compute(input: TaxYearInput, explain: boolean): CountryResult {
  const d = pickYear(NL_YEARS, input.year);
  const idx = indexFactor(input, ID, undefined);
  const scale = periodScale(input);
  const fs = idx.factor * scale;
  const people = alivePeople(input);
  const sink = new LineSink(ID);
  const facts: Record<string, number> = {
    ...idx.facts,
    "tax.year": input.year,
    "tax.priceIndex": input.priceIndex,
  };
  const fill: BracketFill[] = [];
  const multi = people.length > 1;

  // ---- box 3 (household), split evenly between the people
  const box3 = input.wealth ? nlBox3(d, input.wealth, people.length, idx.factor) : null;
  const box3Tax = (box3?.tax ?? 0) * scale;
  const box3Voordeel = ((box3?.voordeel ?? 0) * scale) / people.length;

  let taxable = 0;
  let gross = 0;
  people.forEach((p, i) => {
    const sfx = multi ? ` (${p.id})` : "";
    const b = collectIncome(input, ID, p.id, people);
    const ded = personDeductions(input, p.id, people);
    const birthYear = birthYearOf(p, input.year);
    const aow = p.age >= nlAowAge(birthYear);
    let box2Income = 0;
    for (const it of input.income)
      if (it.incomeType === "nl-box2" && it.amount > 0)
        box2Income += it.amount * ownerShare(it.owner, p.id, people);
    const arbeidsinkomen = clamp0(b.wage - ded.pretax) + b.selfEmployment;
    const box1 = clamp0(
      b.wage +
        b.selfEmployment +
        b.pension +
        b.socialSecurity +
        b.ordinary +
        b.deferredWithdrawals -
        ded.pretax -
        ded.deductions,
    );
    const fillBands: BracketFill["bands"] | undefined = explain ? [] : undefined;
    const rows = !aow ? d.box1.belowAow : birthYear < 1946 ? d.box1.aowBefore1946 : d.box1.aow;
    const t1 = sliceTax(bands(rows, fs), 0, box1, fillBands);
    if (fillBands)
      fill.push({ jurisdictionId: ID, personId: p.id, schedule: "box 1", bands: fillBands });
    const t2 = sliceTax(bands(d.box2.rows, fs), 0, box2Income).tax;
    const vi = box1 + box2Income + box3Voordeel;
    const credits =
      nlAhk(d, vi, aow, fs) +
      nlArbeidskorting(d, arbeidsinkomen, aow, fs) +
      (aow ? nlOuderenkorting(d, vi, fs) : 0) +
      (aow && people.length === 1 ? d.alleenstaandeOuderenkorting * fs : 0);
    const ownBox3 = box3Tax / people.length;
    const applied = Math.min(credits + ded.credits, t1.tax + t2 + ownBox3);
    sink.add(
      "income",
      `Box 1 income tax and national insurance${aow ? " (AOW age)" : ""}${sfx}`,
      t1.tax,
      box1,
    );
    sink.add("credit", `Heffingskortingen${sfx}`, -applied);
    sink.add("dividends", `Box 2 (substantial interest)${sfx}`, t2, box2Income);
    // Bijdrage Zvw on pensions, AOW, withdrawals and profit, above any wages (employer-paid).
    const zvwBase = Math.min(
      clamp0(b.pension + b.socialSecurity + b.deferredWithdrawals + b.selfEmployment),
      clamp0(d.zvw.maxIncome * fs - b.wage),
    );
    sink.add("payroll", `Bijdrage Zvw (income-related)${sfx}`, d.zvw.rate * zvwBase, zvwBase);
    sink.add(
      "wealth",
      `Box 3 (savings and investments)${sfx}`,
      ownBox3,
      box3 ? box3.grondslag / people.length : 0,
    );
    const rate = box1 > 0 ? t1.marginal : 0;
    facts[`tax.ordinaryBracketRate.${p.id}`] = rate;
    if (i === 0) facts["tax.ordinaryBracketRate"] = rate;
    facts[`nl.box1.${p.id}`] = box1;
    facts[`nl.verzamelinkomen.${p.id}`] = vi;
    taxable += box1 + box2Income;
    gross +=
      b.wage +
      b.selfEmployment +
      b.pension +
      b.socialSecurity +
      b.ordinary +
      b.rental +
      b.interest +
      b.qualifiedDividends +
      b.ordinaryDividends +
      b.gainsLong +
      b.gainsShort +
      b.deferredWithdrawals +
      b.deferredTaxFree;
  });
  if (box3) {
    facts["nl.box3.voordeel"] = box3.voordeel * scale;
    facts["nl.box3.grondslag"] = box3.grondslag;
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

export const nlJurisdiction = nationalJurisdiction({
  id: ID,
  label: "Netherlands (box 1 with heffingskortingen, box 2, box 3 deemed return)",
  country: "NL",
  compute,
  // Earliest start is the AOW age here (earlier starts under the pension rules are not modelled).
  pensionAccessAge: (q) => (q.accountType === "nl-pension" ? nlAowAge(q.birthYear) : null),
  // AOW starts at the AOW age and cannot be deferred.
  statePensionAge: (q) => nlAowAge(q.birthYear),
  // Own home is taxed in box 1 via the eigenwoningforfait; there is no tax on its sale.
  homeSaleExclusion: () => Number.POSITIVE_INFINITY,
  sources: NL_YEARS.flatMap((y) => y.sources.map((s) => ({ taxYear: y.label, ...s }))),
  simplifications: NL_SIMPLIFICATIONS,
});
