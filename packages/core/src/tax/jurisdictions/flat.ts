/**
 * Flat jurisdiction: single effective rates for ordinary income, capital gains and dividends,
 * plus an optional local rate. Implemented; used by the minimal engine and the sample plans.
 */
import type { TaxLine } from "../../engine/types.js";
import type {
  ResolvedTaxCharacter,
  TaxJurisdiction,
  TaxYearInput,
  TaxYearOutput,
} from "../types.js";

const GAINS: ResolvedTaxCharacter[] = ["capital-gains-long"];
const DIVIDENDS: ResolvedTaxCharacter[] = ["qualified-dividend"];

export function defaultCharacterForIncomeType(type: string): ResolvedTaxCharacter {
  switch (type) {
    case "salary":
    case "hourly":
    case "bonus":
    case "rsu":
      return "wage";
    case "self-employment":
      return "self-employment";
    case "social-security":
      return "social-security";
    case "pension":
    case "annuity":
    case "state-pension":
    case "ca-cpp":
    case "ca-oas":
      return "pension";
    case "inheritance":
    case "ca-gis":
      return "tax-free";
    default:
      return "ordinary";
  }
}

export const flatJurisdiction: TaxJurisdiction = {
  id: "flat",
  label: "Flat effective rates",
  level: "synthetic",
  status: "implemented",
  owner: "b",
  defaultCharacter: defaultCharacterForIncomeType,
  computeYear(input: TaxYearInput): TaxYearOutput {
    const rates = input.config.flat;
    const mod = rates.modifier;
    const ordinaryRate = Math.max(0, rates.ordinary + (mod?.ordinary ?? 0));
    const gainsRate = Math.max(0, rates.capitalGains + (mod?.capitalGains ?? 0));
    const bond = rates.bondDividends ?? { treatment: "income" as const };
    const items: { character: ResolvedTaxCharacter; amount: number; incomeType?: string }[] = [
      ...input.income.filter((i) => !i.exemptIn.includes("flat")),
      ...input.withdrawals.map((w) => ({ character: w.character, amount: w.taxableAmount })),
    ];
    let ordinary = 0;
    let gains = 0;
    let dividends = 0;
    let bondOwnRate = 0;
    let gross = 0;
    for (const it of items) {
      if (it.character === "tax-free" || it.amount <= 0) continue;
      gross += it.amount;
      if (it.incomeType === "bond-dividend" && bond.treatment !== "income") {
        if (bond.treatment === "dividends") dividends += it.amount;
        else bondOwnRate += it.amount;
      } else if (GAINS.includes(it.character)) gains += it.amount;
      else if (DIVIDENDS.includes(it.character)) dividends += it.amount;
      else ordinary += it.amount;
    }
    // Employer pension contributions are never deductions of the employee.
    const own = input.deductions.filter((d) => !d.employer);
    const deductions = own.filter((d) => d.kind !== "credit").reduce((s, d) => s + d.amount, 0);
    const credits = own.filter((d) => d.kind === "credit").reduce((s, d) => s + d.amount, 0);
    const taxableOrdinary = Math.max(0, ordinary - deductions);
    const lines: TaxLine[] = [];
    const push = (kind: TaxLine["kind"], label: string, base: number, rate: number) => {
      const amount = base * rate;
      if (amount !== 0) lines.push({ jurisdictionId: "flat", kind, label, amount, base });
    };
    push("income", "Income tax", taxableOrdinary, ordinaryRate);
    push("capital-gains", "Capital gains tax", gains, gainsRate);
    push("dividends", "Dividend tax", dividends, rates.dividends);
    push("dividends", "Bond dividend tax", bondOwnRate, bond.rate ?? rates.ordinary);
    push("local", "Local income tax", taxableOrdinary, rates.local);
    const penalties = input.withdrawals.reduce((s, w) => s + w.taxableAmount * w.penaltyRate, 0);
    if (penalties > 0)
      lines.push({
        jurisdictionId: "flat",
        kind: "penalty",
        label: "Early withdrawal penalty",
        amount: penalties,
      });
    const before = lines.reduce((s, l) => s + l.amount, 0);
    if (credits > 0)
      lines.push({
        jurisdictionId: "flat",
        kind: "credit",
        label: "Tax credits",
        amount: -Math.min(credits, before),
      });
    return {
      lines,
      grossIncome: gross,
      taxableIncome: taxableOrdinary + gains + dividends + bondOwnRate,
      marginalRate: ordinaryRate + rates.local,
      facts: {
        ordinaryIncome: ordinary,
        capitalGains: gains,
        dividends,
        deductions,
        "tax.ordinaryBracketRate": taxableOrdinary > 0 ? ordinaryRate : 0,
      },
    };
  },
};
