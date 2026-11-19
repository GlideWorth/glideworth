/**
 * US payroll taxes: employee FICA (Social Security 6.2% to the wage base, Medicare 1.45%),
 * Additional Medicare Tax 0.9% above the filing-status threshold, and self-employment tax
 * (12.4% + 2.9% on 92.35% of SE earnings, coordinating the wage base with W-2 wages).
 * Per person; pre-tax 401(k) deferrals do NOT reduce FICA wages.
 */

import { alivePeople, clamp0, collectIncome, LineSink, periodScale } from "../common.js";
import { US_PAYROLL_SIMPLIFICATIONS } from "../data/anglo.js";
import { US_FIXED, US_PAYROLL_YEARS } from "../data/us-federal.js";
import type { TaxJurisdiction, TaxYearInput, TaxYearOutput } from "../types.js";
import { usTable } from "./us-index.js";

export interface UsPayrollResult {
  socialSecurity: number;
  medicare: number;
  additionalMedicare: number;
  seTax: number;
  /** Deductible half of SE tax (excluding Additional Medicare). */
  seDeduction: number;
  wages: number;
  seEarnings: number;
}

export function usPayroll(input: TaxYearInput): UsPayrollResult {
  const { row: P, factor: f } = usTable(US_PAYROLL_YEARS, input);
  const scale = periodScale(input);
  const base = P.socialSecurityWageBase * f * scale;
  const people = alivePeople(input);
  const r: UsPayrollResult = {
    socialSecurity: 0,
    medicare: 0,
    additionalMedicare: 0,
    seTax: 0,
    seDeduction: 0,
    wages: 0,
    seEarnings: 0,
  };
  let medicareWagesAndSe = 0;
  for (const p of people) {
    const b = collectIncome(input, "us-payroll", p.id, people);
    const wages = b.wage;
    r.wages += wages;
    r.socialSecurity += P.socialSecurityRate * Math.min(wages, base);
    r.medicare += P.medicareRate * wages;
    const se = clamp0(b.selfEmployment) * P.seNetEarningsFactor;
    if (se >= 400 * scale) {
      const ssPart = 2 * P.socialSecurityRate * Math.min(se, clamp0(base - wages));
      const medPart = 2 * P.medicareRate * se;
      r.seTax += ssPart + medPart;
      r.seDeduction += (ssPart + medPart) / 2;
      r.seEarnings += se;
      medicareWagesAndSe += wages + se;
    } else medicareWagesAndSe += wages;
  }
  const thr = US_FIXED.additionalMedicare.threshold[input.filingStatus] * scale;
  r.additionalMedicare = US_FIXED.additionalMedicare.rate * clamp0(medicareWagesAndSe - thr);
  return r;
}

function compute(input: TaxYearInput): TaxYearOutput {
  const r = usPayroll(input);
  const sink = new LineSink("us-payroll");
  sink.add("payroll", "Social Security (OASDI)", r.socialSecurity, r.wages);
  sink.add("payroll", "Medicare", r.medicare, r.wages);
  sink.add("payroll", "Additional Medicare Tax", r.additionalMedicare);
  sink.add("self-employment", "Self-employment tax", r.seTax, r.seEarnings);
  const { row: P, factor } = usTable(US_PAYROLL_YEARS, input);
  const base = P.socialSecurityWageBase * factor * periodScale(input);
  return {
    lines: sink.lines,
    grossIncome: r.wages + r.seEarnings / P.seNetEarningsFactor,
    taxableIncome: r.wages + r.seEarnings,
    // Payroll taxes apply to wages, not to generic ordinary income.
    marginalRate: 0,
    facts: {
      "us.ficaWages": r.wages,
      "us.seTaxDeduction": r.seDeduction,
      "us.payrollMarginalWage":
        (r.wages < base ? P.socialSecurityRate : 0) +
        P.medicareRate +
        (r.additionalMedicare > 0 ? 0.009 : 0),
    },
  };
}

export const usPayrollJurisdiction: TaxJurisdiction = {
  id: "us-payroll",
  label: "US payroll (FICA, Medicare, Additional Medicare, SE tax)",
  level: "payroll",
  country: "US",
  status: "implemented",
  owner: "b",
  computeYear: compute,
  explainYear: compute,
  sources: US_PAYROLL_YEARS.flatMap((y) =>
    y.sources.map((s) => ({ taxYear: String(y.year), ...s })),
  ),
  simplifications: US_PAYROLL_SIMPLIFICATIONS,
};
