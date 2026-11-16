/**
 * Mapping from an account's dividend settings to the tax character + optional treatment fields
 * on TaxIncomeItem. For the engine's growth phase (replaces the TODO in phases.ts
 * dividendCharacter): spread the result onto the TaxIncomeItem.
 */
import type { AccountBehaviour } from "../schema/accounts.js";
import type { DividendTreatmentKind, ResolvedTaxCharacter } from "./types.js";

export interface DividendTaxDetail {
  character: ResolvedTaxCharacter;
  dividendTreatment?: DividendTreatmentKind;
  frankedShare?: number;
}

export function dividendTaxDetail(dividends: AccountBehaviour["dividends"]): DividendTaxDetail {
  switch (dividends.treatment) {
    case "auto":
    case "qualified":
      return { character: "qualified-dividend", dividendTreatment: "qualified" };
    case "ordinary":
      return { character: "ordinary-dividend", dividendTreatment: "ordinary" };
    case "tax-free":
    case "municipal":
      return { character: "tax-free" };
    case "treasury":
      return { character: "interest" };
    case "ca-eligible":
      return { character: "qualified-dividend", dividendTreatment: "ca-eligible" };
    case "ca-non-eligible":
      return { character: "ordinary-dividend", dividendTreatment: "ca-non-eligible" };
    case "au-franked":
      return {
        character: "qualified-dividend",
        dividendTreatment: "au-franked",
        frankedShare: dividends.qualifiedShare ?? 1,
      };
    case "au-unfranked":
      return { character: "ordinary-dividend", dividendTreatment: "au-unfranked" };
  }
}
