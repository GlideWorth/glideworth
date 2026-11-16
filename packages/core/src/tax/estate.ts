/**
 * Estate / inheritance tax estimates for the Estate view, plus a generic Net Legacy helper.
 *
 *   estimateUkInheritanceTax: nil-rate band, residence nil-rate band (with £2m taper), transfer
 *     of a late spouse's unused bands, spouse exemption, 36% charity rate, pensions in the estate
 *     from 6 April 2027, gifts within seven years using the NRB first (taper relief ignored).
 *   estimateUsEstateTax: basic exclusion ($15m in 2026, indexed from 2027), portability (DSUE),
 *     marital and charitable deductions, unified rate schedule. State estate taxes not modelled.
 *   estimateNetLegacy: Legacy minus estate tax, heirs' income tax on tax-deferred accounts,
 *     embedded gains (unless step-up), liquidation and admin costs (EstateSettings).
 */

import { clamp0, pickYear, type ThresholdPolicy } from "./common.js";
import { UK_TAX_YEARS } from "./data/uk.js";
import { US_ESTATE } from "./data/us-federal.js";

export interface UkInheritanceTaxInput {
  /** Calendar year of death (tax year starting that April). */
  year: number;
  /** Net estate excluding pensions (assets less debts and funeral costs). */
  netEstate: number;
  /** Value of the home (or share) passing to direct descendants (0 if none). */
  homeToDescendants: number;
  /** Unused defined-contribution pension funds and death benefits. */
  pensions?: number;
  /** Whole estate passes to a UK-domiciled spouse/civil partner (exempt). */
  toSpouse?: boolean;
  /** Share (0..1) of a late spouse's nil-rate band that was unused and is transferred. */
  transferredNrbShare?: number;
  /** Share (0..1) of a late spouse's residence nil-rate band transferred. */
  transferredRnrbShare?: number;
  /** Fraction of the estate left to charity. */
  charityShare?: number;
  /** Chargeable lifetime gifts within 7 years of death (use the NRB first). */
  giftsWithin7Years?: number;
  priceIndex?: number;
  policy?: ThresholdPolicy;
  /** Price index at the end of the threshold freeze (legislated policy). */
  freezeEndPriceIndex?: number;
}

export interface UkInheritanceTaxResult {
  tax: number;
  rate: number;
  grossEstate: number;
  nilRateBand: number;
  residenceNilRateBand: number;
  charity: number;
  taxable: number;
  pensionsIncluded: number;
  source: string;
}

export function estimateUkInheritanceTax(q: UkInheritanceTaxInput): UkInheritanceTaxResult {
  const d = pickYear(UK_TAX_YEARS, q.year).iht;
  const policy = q.policy ?? "legislated";
  const pi = q.priceIndex ?? 1;
  const f =
    policy === "frozen"
      ? 1
      : policy === "indexed"
        ? pi
        : q.year <= d.frozenThrough
          ? 1
          : pi / (q.freezeEndPriceIndex ?? pi);
  const pensionsIncluded = q.year >= d.pensionsInEstateFrom ? (q.pensions ?? 0) : 0;
  const gross = clamp0(q.netEstate) + clamp0(pensionsIncluded);
  const base = {
    grossEstate: gross,
    pensionsIncluded,
    source: "https://www.gov.uk/inheritance-tax",
  };
  if (q.toSpouse)
    return {
      ...base,
      tax: 0,
      rate: 0,
      nilRateBand: 0,
      residenceNilRateBand: 0,
      charity: 0,
      taxable: 0,
    };
  const nrbTotal = d.nilRateBand * f * (1 + clamp0(Math.min(1, q.transferredNrbShare ?? 0)));
  const nrb = clamp0(nrbTotal - clamp0(q.giftsWithin7Years ?? 0));
  const rnrbMax =
    d.residenceNilRateBand * f * (1 + clamp0(Math.min(1, q.transferredRnrbShare ?? 0)));
  const taper = clamp0(gross - d.rnrbTaperThreshold * f) / 2;
  const rnrb = Math.min(clamp0(q.homeToDescendants), clamp0(rnrbMax - taper));
  const charity = gross * clamp0(Math.min(1, q.charityShare ?? 0));
  // 36% applies when at least 10% of the baseline (estate after NRB, before charity) goes to charity.
  const baseline = clamp0(gross - nrb);
  const rate = charity > 0 && charity >= 0.1 * baseline ? d.charityRate : d.rate;
  const taxable = clamp0(gross - charity - nrb - rnrb);
  return {
    ...base,
    tax: taxable * rate,
    rate,
    nilRateBand: nrb,
    residenceNilRateBand: rnrb,
    charity,
    taxable,
  };
}

/** Unified transfer tax rate schedule, IRC §2001(c). */
const UNIFIED: [number, number][] = [
  [0, 0.18],
  [10_000, 0.2],
  [20_000, 0.22],
  [40_000, 0.24],
  [60_000, 0.26],
  [80_000, 0.28],
  [100_000, 0.3],
  [150_000, 0.32],
  [250_000, 0.34],
  [500_000, 0.37],
  [750_000, 0.39],
  [1_000_000, 0.4],
];

function unifiedTax(x: number): number {
  let t = 0;
  for (let i = 0; i < UNIFIED.length; i++) {
    const [lo, r] = UNIFIED[i]!;
    const hi = UNIFIED[i + 1]?.[0] ?? Number.POSITIVE_INFINITY;
    if (x <= lo) break;
    t += (Math.min(x, hi) - lo) * r;
  }
  return t;
}

export interface UsEstateTaxInput {
  year: number;
  grossEstate: number;
  /** Passing to a US-citizen spouse (unlimited marital deduction). */
  toSpouse?: number;
  toCharity?: number;
  /** Deceased spousal unused exclusion (portability). */
  dsue?: number;
  /** Adjusted taxable gifts made in life. */
  lifetimeGifts?: number;
  priceIndex?: number;
  /** Price index in the exclusion's base year (2026); defaults to 1. */
  basePriceIndex?: number;
}

export function estimateUsEstateTax(q: UsEstateTaxInput): {
  tax: number;
  exclusion: number;
  taxableEstate: number;
  source: string;
} {
  const pi = q.priceIndex ?? 1;
  const exclusion =
    US_ESTATE.basicExclusion * (q.year > US_ESTATE.year ? pi / (q.basePriceIndex ?? 1) : 1) +
    clamp0(q.dsue ?? 0);
  const taxableEstate = clamp0(q.grossEstate - clamp0(q.toSpouse ?? 0) - clamp0(q.toCharity ?? 0));
  const base = taxableEstate + clamp0(q.lifetimeGifts ?? 0);
  const tax = clamp0(unifiedTax(base) - unifiedTax(exclusion));
  return { tax, exclusion, taxableEstate, source: US_ESTATE.source };
}

export interface NetLegacyInput {
  /** End-of-plan balances by bucket. */
  taxDeferred: number;
  taxable: number;
  taxableCostBasis: number;
  taxFree: number;
  cash: number;
  realEstate: number;
  otherAssets: number;
  debts: number;
  /** Estate/inheritance tax computed by the country function (or 0). */
  estateTax: number;
  settings: {
    liquidationCostRate: number;
    adminCostRate: number;
    stepUpBasis: boolean;
    heirTaxDeferredRate: number;
    heirCapitalGainsRate: number;
    charitableShare: number;
  };
}

export function estimateNetLegacy(q: NetLegacyInput) {
  const s = q.settings;
  const legacy =
    q.taxDeferred + q.taxable + q.taxFree + q.cash + q.realEstate + q.otherAssets - q.debts;
  const gross = legacy + q.debts;
  const heirIncomeTax = q.taxDeferred * s.heirTaxDeferredRate;
  const embeddedGains = s.stepUpBasis
    ? 0
    : clamp0(q.taxable - q.taxableCostBasis) * s.heirCapitalGainsRate;
  const liquidation = q.realEstate * s.liquidationCostRate;
  const admin = gross * s.adminCostRate;
  const net = legacy - q.estateTax - heirIncomeTax - embeddedGains - liquidation - admin;
  const charity = clamp0(net) * s.charitableShare;
  return {
    legacy,
    estateTax: q.estateTax,
    heirIncomeTax,
    embeddedGainsTax: embeddedGains,
    liquidationCosts: liquidation,
    adminCosts: admin,
    netLegacy: net,
    toCharity: charity,
    toHeirs: net - charity,
  };
}
