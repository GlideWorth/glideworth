/**
 * Shared shell for the national plug-ins added in workstream (b2): DE, NL, FR, ES, IL, IE, NZ.
 * Each country supplies `compute(input, explain)`; the shell adds the finite-difference marginal
 * rate, `explainYear`, sources and the known-simplifications list.
 */
import { ScenarioError } from "../../errors.js";
import { finiteMarginal } from "../common.js";
import type { TaxJurisdiction, TaxYearInput, TaxYearOutput } from "../types.js";
import { defaultCharacterForIncomeType } from "./flat.js";

export interface CountryResult {
  out: TaxYearOutput;
  total: number;
}

export type CountryCompute = (input: TaxYearInput, explain: boolean) => CountryResult;

export function nationalJurisdiction(
  spec: Omit<TaxJurisdiction, "computeYear" | "explainYear" | "level" | "status" | "owner"> & {
    compute: CountryCompute;
    level?: TaxJurisdiction["level"];
  },
): TaxJurisdiction {
  const { compute, level, ...rest } = spec;
  const run = (input: TaxYearInput, explain: boolean): TaxYearOutput => {
    if (input.months <= 0)
      throw new ScenarioError("tax period has no months", { months: input.months });
    const { out } = compute(input, explain);
    out.marginalRate = finiteMarginal((i) => compute(i, false).total, input, "ordinary");
    return out;
  };
  return {
    defaultCharacter: defaultCharacterForIncomeType,
    ...rest,
    level: level ?? "national",
    status: "implemented",
    owner: "b",
    computeYear: (input) => run(input, false),
    explainYear: (input) => run(input, true),
  };
}

/** Taxable-income share of each item in `parts`, used to split one flat tax over line kinds. */
export function splitTax(tax: number, parts: number[]): number[] {
  const sum = parts.reduce((s, x) => s + x, 0);
  return parts.map((x) => (sum > 0 ? (tax * x) / sum : 0));
}
