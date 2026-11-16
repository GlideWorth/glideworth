/**
 * Registered-but-unimplemented jurisdictions. They exist so the UI/API can list them and plans
 * can reference them; computeYear throws NotImplementedError until workstream (b) lands them.
 */
import { NotImplementedError } from "../../errors.js";
import type { TaxJurisdiction } from "../types.js";

function stub(
  id: string,
  label: string,
  level: TaxJurisdiction["level"],
  country?: string,
): TaxJurisdiction {
  return {
    id,
    label,
    level,
    ...(country ? { country } : {}),
    status: "stub",
    owner: "b",
    computeYear() {
      throw new NotImplementedError(`tax.${id}`, "b");
    },
  };
}

export const STUB_JURISDICTIONS: TaxJurisdiction[] = [
  stub("custom", "Custom brackets", "synthetic"),
  stub("us-federal", "US federal income tax", "national", "US"),
  stub("us-payroll", "US payroll (FICA, Medicare, SE)", "payroll", "US"),
  stub("us-state", "US state income tax (data-driven table)", "state", "US"),
  stub("us-local", "US local income tax", "local", "US"),
  stub("uk", "United Kingdom (income tax, NI, CGT, dividends)", "national", "GB"),
  stub("ca-federal", "Canada federal", "national", "CA"),
  stub("ca-province", "Canada provincial", "state", "CA"),
  stub("au", "Australia", "national", "AU"),
];
