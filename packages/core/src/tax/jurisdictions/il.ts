/**
 * Israel: income tax brackets with credit points, 3% surtax above the threshold (+2% on capital
 * income above it), 25% tax on capital income (nominal gains: see IL_SIMPLIFICATIONS), employee
 * National Insurance and health tax at reduced / full rates, pension-contribution credit and keren
 * hishtalmut as a tax-free account. The Ordinance's amounts are frozen through 2027 (s. 120B(e));
 * National Insurance thresholds follow the price index. Data: ../data/il.ts.
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
import { IL_SIMPLIFICATIONS, IL_YEARS } from "../data/il.js";
import type { BracketFill, TaxYearInput } from "../types.js";
import { type CountryResult, nationalJurisdiction, splitTax } from "./intl.js";

const ID = "il";

function compute(input: TaxYearInput, explain: boolean): CountryResult {
  const d = pickYear(IL_YEARS, input.year);
  const idx = indexFactor(input, ID, d.frozenThroughYear);
  const fs = idx.factor * periodScale(input);
  const fsNi = indexFactor(input, `${ID}.ni`, undefined).factor * periodScale(input);
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
    const ordinary = clamp0(
      b.wage +
        b.selfEmployment +
        b.pension +
        b.socialSecurity +
        b.ordinary +
        b.rental +
        b.deferredWithdrawals -
        ded.deductions,
    );
    const capInc = b.interest + b.qualifiedDividends + b.ordinaryDividends;
    const capGain = b.gainsLong + b.gainsShort;
    const capital = capInc + capGain;
    const bf: BracketFill["bands"] | undefined = explain ? [] : undefined;
    const t = sliceTax(bands(d.brackets, fs), 0, ordinary, bf);
    if (bf)
      fill.push({ jurisdictionId: ID, personId: p.id, schedule: "personal effort", bands: bf });
    // credits: credit points and the pension contribution credit
    const P = d.pension;
    const pensionCredit =
      P.creditRate * Math.min(ded.pretax, P.wageShare * b.wage, P.maxContribution * fs);
    const credits = Math.min(
      t.tax,
      d.residentPoints * d.creditPoint * fs + pensionCredit + ded.credits,
    );
    const capTax = d.capital.rate * capital;
    // surtax: 3% on total taxable income above the threshold (s. 121B(a)), plus 2% on taxable income
    // from capital sources above the same threshold (s. 121B(a1)), measured on capital income alone
    const thr = d.surtax.threshold * fs;
    const over = clamp0(ordinary + capital - thr);
    const surtax = d.surtax.rate * over + d.surtax.capitalExtra * clamp0(capital - thr);
    // National Insurance + health (employees, below the age limit)
    const N = d.nationalInsurance;
    const ni =
      p.age < N.untilAge
        ? N.reducedRate * Math.min(b.wage, N.reducedUpTo * fsNi) +
          N.fullRate * clamp0(Math.min(b.wage, N.max * fsNi) - N.reducedUpTo * fsNi)
        : 0;
    const [onInc, onGain] = splitTax(capTax, [capInc, capGain]);
    sink.add("income", `Income tax${sfx}`, t.tax, ordinary);
    sink.add("credit", `Credit points and pension credit${sfx}`, -credits);
    sink.add("dividends", `Tax on interest and dividends (25%)${sfx}`, onInc!, capInc);
    sink.add("capital-gains", `Capital gains tax (25%)${sfx}`, onGain!, capGain);
    sink.add("income", `Surtax (mas yesef)${sfx}`, surtax, over);
    sink.add("payroll", `National Insurance and health tax${sfx}`, ni, b.wage);
    const rate = ordinary > 0 ? t.marginal : 0;
    facts[`tax.ordinaryBracketRate.${p.id}`] = rate;
    if (i === 0) facts["tax.ordinaryBracketRate"] = rate;
    taxable += ordinary + capital;
    gross +=
      b.wage +
      b.selfEmployment +
      b.pension +
      b.socialSecurity +
      b.ordinary +
      b.rental +
      capital +
      b.deferredWithdrawals +
      b.deferredTaxFree;
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

export const ilJurisdiction = nationalJurisdiction({
  id: ID,
  label: "Israel (income tax, credit points, surtax, capital income, National Insurance)",
  country: "IL",
  compute,
  pensionAccessAge: (q) =>
    q.accountType === "il-pension" ? pickYear(IL_YEARS, 2026).pension.accessAge : null,
  sources: IL_YEARS.flatMap((y) => y.sources.map((s) => ({ taxYear: y.label, ...s }))),
  simplifications: IL_SIMPLIFICATIONS,
});
