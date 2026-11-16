/** Versioned tax data tables (one module per country; yearly updates are data-only). */
export {
  AE_DEWS,
  AE_GPSSA,
  AE_GRATUITY,
  AE_PEG_SOURCE,
  AE_SAVINGS_SCHEME,
  AE_SIMPLIFICATIONS,
  AE_YEARS,
  AED_PER_USD,
  type AeYear,
  aeGpssaContributions,
  aeGpssaReplacementRate,
  aeGratuity,
} from "./ae.js";
export { AU_YEARS, type AuYear, auMinimumDrawdownRate } from "./au.js";
export { CA_2026, CA_PROVINCES_2026, type CaProvince, RRIF_FACTORS } from "./ca.js";
export {
  DE_DEFERRAL_UPLIFT_PER_MONTH,
  DE_SIMPLIFICATIONS,
  DE_YEARS,
  type DeYear,
  deBesteuerungsanteil,
  deRegelaltersgrenze,
} from "./de.js";
export {
  ES_REGION_ALIASES,
  ES_REGIONAL_SCALES,
  ES_SIMPLIFICATIONS,
  ES_YEARS,
  type EsRegion,
  type EsYear,
} from "./es.js";
export { FR_SIMPLIFICATIONS, FR_YEARS, type FrYear } from "./fr.js";
export { IE_SIMPLIFICATIONS, IE_YEARS, type IeYear } from "./ie.js";
export { IL_SIMPLIFICATIONS, IL_YEARS, type IlYear } from "./il.js";
export { NL_SIMPLIFICATIONS, NL_YEARS, type NlYear, nlAowAge } from "./nl.js";
export { NZ_SIMPLIFICATIONS, NZ_YEARS, type NzYear } from "./nz.js";
export { TAX_SIMPLIFICATIONS } from "./simplifications.js";
export {
  UK_CASH_ISA_LIMIT_FROM,
  UK_PENSION_ACCESS,
  UK_STATE_PENSION_DEFERRAL,
  UK_TAX_YEARS,
  type UkTaxYear,
  ukNormalMinimumPensionAge,
  ukStatePensionAge,
} from "./uk.js";
export {
  IRS_MORTALITY_RATES,
  seppAnnuityFactor,
  UNIFORM_LIFETIME,
  US_ACA_2026,
  US_FEDERAL_YEARS,
  US_FIXED,
  US_IRMAA_2026,
  US_LIMITS_2026,
  US_PAYROLL_2026,
  type UsFederalYear,
  usRmdStartAge,
} from "./us-federal.js";
export { type LocalRow, type StateRow, US_LOCALS_2026, US_STATES_2026 } from "./us-states.js";
