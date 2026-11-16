/**
 * United Kingdom tax data, one row per tax year (6 April `startYear` to 5 April `startYear + 1`).
 * Data only: calculation lives in ../jurisdictions/uk.ts. Yearly updates add a row here.
 *
 * Amounts are nominal GBP for that tax year. Thresholds marked "frozen" stay nominal until the
 * `frozenThrough` year under the default `legislated` threshold policy, then index with inflation.
 *
 * Engine periods are mapped onto tax years by calendar year: period year Y uses tax year Y/Y+1
 * (it overlaps nine of the twelve months).
 */

export interface UkStudentLoanPlan {
  threshold: number;
  rate: number;
  /** Last tax year (startYear) the threshold stays nominal under the legislated policy. */
  frozenThrough?: number;
}

export interface UkTaxYear {
  startYear: number;
  label: string;
  sources: { url: string; note?: string }[];
  income: {
    personalAllowance: number;
    /** Adjusted net income above which the PA is withdrawn at £1 per £2. */
    paTaperThreshold: number;
    basicRateBand: number;
    /** Additional-rate threshold (taxable income). */
    higherRateLimit: number;
    rates: { basic: number; higher: number; additional: number };
    /** Scottish non-savings rates: [taxable income above PA where band starts, rate]. */
    scotland: { bands: [number, number][]; labels: string[] };
    savings: {
      startingRateLimit: number;
      startingRate: number;
      personalSavingsAllowance: { basic: number; higher: number; additional: number };
      rates: { basic: number; higher: number; additional: number };
    };
    dividends: { allowance: number; rates: { basic: number; higher: number; additional: number } };
    /** Separate property income rates (England, Wales, NI) from April 2027. Absent = non-savings rates. */
    property?: {
      rates: { basic: number; higher: number; additional: number };
      appliesInScotland: boolean;
    };
    marriageAllowance: number;
    /** Income tax thresholds (PA, bands, savings starting limit) frozen through this tax year. */
    frozenThrough: number;
    /** Scottish higher/advanced/top thresholds frozen through this tax year (lower bands indexed). */
    scotlandUpperFrozenThrough: number;
  };
  ni: {
    /** Employee Class 1 primary threshold and upper earnings limit (annual). */
    primaryThreshold: number;
    upperEarningsLimit: number;
    class1Main: number;
    class1Upper: number;
    /** Class 4 (self-employed). */
    lowerProfitsLimit: number;
    upperProfitsLimit: number;
    class4Main: number;
    class4Upper: number;
    /** Salary sacrifice pension contributions NI-free only up to this amount (from April 2029). */
    salarySacrificeNicCap?: number;
    frozenThrough: number;
  };
  cgt: { annualExemptAmount: number; basicRate: number; higherRate: number };
  pensions: {
    annualAllowance: number;
    moneyPurchaseAnnualAllowance: number;
    taperThresholdIncome: number;
    taperAdjustedIncome: number;
    taperMinimum: number;
    lumpSumAllowance: number;
    lumpSumAndDeathBenefitAllowance: number;
    /** Gross contributions always relievable even without earnings. */
    basicAmount: number;
    /** Basic rate used for relief at source top-ups. */
    reliefAtSourceRate: number;
  };
  isa: { overall: number; lisa: number; junior: number; cashUnder65?: number };
  /** Full new State Pension (weekly, uprated each April). */
  statePension: { fullNewWeekly: number };
  childBenefit: {
    eldestWeekly: number;
    otherWeekly: number;
    hicbcThreshold: number;
    hicbcTaperWidth: number;
  };
  studentLoans: Record<"plan1" | "plan2" | "plan4" | "plan5" | "postgraduate", UkStudentLoanPlan>;
  iht: {
    nilRateBand: number;
    residenceNilRateBand: number;
    rnrbTaperThreshold: number;
    rate: number;
    charityRate: number;
    frozenThrough: number;
    /** Unused pension funds count toward the estate on deaths on/after 6 April of this year. */
    pensionsInEstateFrom: number;
  };
}

const GOVUK_RATES =
  "https://www.gov.uk/government/publications/budget-2025-overview-of-tax-legislation-and-rates-ootlar/annex-a-rates-and-allowances";
const GOVUK_EMPLOYER =
  "https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027";
const GOVUK_SCOT = "https://www.gov.uk/scottish-income-tax";
const GOVSCOT_SRR =
  "https://www.gov.scot/publications/scottish-rate-resolution-2026-2027-draft-motion-explanatory-note/pages/2/";
const BUDGET_2025 =
  "https://www.gov.uk/government/publications/budget-2025-document/budget-2025-html";

const Y2026: UkTaxYear = {
  startYear: 2026,
  label: "2026/27",
  sources: [
    {
      url: GOVUK_RATES,
      note: "Budget 2025 Annex A: income tax, allowances, NI, CGT, pensions, ISA, IHT",
    },
    {
      url: GOVUK_EMPLOYER,
      note: "Student loan thresholds; annual NI thresholds; Scottish PAYE bands",
    },
    {
      url: "https://www.gov.uk/new-state-pension/what-youll-get",
      note: "Full new State Pension £241.30 a week (2026/27)",
    },
    { url: GOVUK_SCOT, note: "Scottish income tax 2026/27" },
    { url: GOVSCOT_SRR, note: "Scottish Rate Resolution 2026/27 (band limits above the PA)" },
    {
      url: BUDGET_2025,
      note: "Freeze of income tax/NIC thresholds to April 2031; IHT thresholds to April 2031; dividend +2pp from April 2026; savings +2pp and property rates from April 2027; salary sacrifice NIC cap £2,000 from 2029; pensions in IHT from 6 April 2027; Plan 2 threshold held 2027/28-2029/30",
    },
    {
      url: "https://www.gov.uk/guidance/high-income-child-benefit-tax-charge",
      note: "HICBC: 1% per £200 above £60,000",
    },
    {
      url: "https://www.gov.uk/guidance/pension-schemes-work-out-your-tapered-annual-allowance",
      note: "Tapered AA: threshold income £200,000, adjusted income £260,000, minimum £10,000",
    },
  ],
  income: {
    personalAllowance: 12_570,
    paTaperThreshold: 100_000,
    basicRateBand: 37_700,
    higherRateLimit: 125_140,
    rates: { basic: 0.2, higher: 0.4, additional: 0.45 },
    scotland: {
      bands: [
        [0, 0.19],
        [3_967, 0.2],
        [16_956, 0.21],
        [31_092, 0.42],
        [62_430, 0.45],
        [125_140, 0.48],
      ],
      labels: ["Starter", "Basic", "Intermediate", "Higher", "Advanced", "Top"],
    },
    savings: {
      startingRateLimit: 5_000,
      startingRate: 0,
      personalSavingsAllowance: { basic: 1_000, higher: 500, additional: 0 },
      rates: { basic: 0.2, higher: 0.4, additional: 0.45 },
    },
    dividends: { allowance: 500, rates: { basic: 0.1075, higher: 0.3575, additional: 0.3935 } },
    marriageAllowance: 1_260,
    frozenThrough: 2030,
    scotlandUpperFrozenThrough: 2027,
  },
  ni: {
    primaryThreshold: 12_570,
    upperEarningsLimit: 50_270,
    class1Main: 0.08,
    class1Upper: 0.02,
    lowerProfitsLimit: 12_570,
    upperProfitsLimit: 50_270,
    class4Main: 0.06,
    class4Upper: 0.02,
    frozenThrough: 2030,
  },
  cgt: { annualExemptAmount: 3_000, basicRate: 0.18, higherRate: 0.24 },
  pensions: {
    annualAllowance: 60_000,
    moneyPurchaseAnnualAllowance: 10_000,
    taperThresholdIncome: 200_000,
    taperAdjustedIncome: 260_000,
    taperMinimum: 10_000,
    lumpSumAllowance: 268_275,
    lumpSumAndDeathBenefitAllowance: 1_073_100,
    basicAmount: 3_600,
    reliefAtSourceRate: 0.2,
  },
  isa: { overall: 20_000, lisa: 4_000, junior: 9_000 },
  statePension: { fullNewWeekly: 241.3 },
  childBenefit: {
    eldestWeekly: 27.05,
    otherWeekly: 17.9,
    hicbcThreshold: 60_000,
    hicbcTaperWidth: 20_000,
  },
  studentLoans: {
    plan1: { threshold: 26_900, rate: 0.09 },
    plan2: { threshold: 29_385, rate: 0.09, frozenThrough: 2029 },
    plan4: { threshold: 33_795, rate: 0.09 },
    plan5: { threshold: 25_000, rate: 0.09 },
    postgraduate: { threshold: 21_000, rate: 0.06 },
  },
  iht: {
    nilRateBand: 325_000,
    residenceNilRateBand: 175_000,
    rnrbTaperThreshold: 2_000_000,
    rate: 0.4,
    charityRate: 0.36,
    frozenThrough: 2030,
    pensionsInEstateFrom: 2027,
  },
};

/** 2025/26 kept for back-dated fixed-date plans. */
const Y2025: UkTaxYear = {
  ...Y2026,
  startYear: 2025,
  label: "2025/26",
  income: {
    ...Y2026.income,
    scotland: {
      bands: [
        [0, 0.19],
        [2_827, 0.2],
        [14_921, 0.21],
        [31_092, 0.42],
        [62_430, 0.45],
        [125_140, 0.48],
      ],
      labels: Y2026.income.scotland.labels,
    },
    dividends: { allowance: 500, rates: { basic: 0.0875, higher: 0.3375, additional: 0.3935 } },
  },
  childBenefit: { ...Y2026.childBenefit, eldestWeekly: 26.05, otherWeekly: 17.25 },
  statePension: { fullNewWeekly: 230.25 },
  studentLoans: {
    plan1: { threshold: 26_065, rate: 0.09 },
    plan2: { threshold: 28_470, rate: 0.09 },
    plan4: { threshold: 32_745, rate: 0.09 },
    plan5: { threshold: 25_000, rate: 0.09 },
    postgraduate: { threshold: 21_000, rate: 0.06 },
  },
};

/**
 * 2027/28: legislated/announced changes only (Budget 2025). Savings rates +2pp; separate property
 * income rates in England, Wales and NI; cash ISA limit £12,000 for under-65s.
 * Other figures carry forward from 2026/27 and are indexed per the threshold policy.
 */
const Y2027: UkTaxYear = {
  ...Y2026,
  startYear: 2027,
  label: "2027/28 (announced)",
  income: {
    ...Y2026.income,
    savings: { ...Y2026.income.savings, rates: { basic: 0.22, higher: 0.42, additional: 0.47 } },
    property: { rates: { basic: 0.22, higher: 0.42, additional: 0.47 }, appliesInScotland: false },
  },
  isa: { ...Y2026.isa, cashUnder65: 12_000 },
};

/** From April 2029: NIC relief on salary-sacrificed pension contributions capped at £2,000 a year. */
const Y2029: UkTaxYear = {
  ...Y2027,
  startYear: 2029,
  label: "2029/30 (announced)",
  ni: { ...Y2027.ni, salarySacrificeNicCap: 2_000 },
};

export const UK_TAX_YEARS: readonly UkTaxYear[] = [Y2025, Y2026, Y2027, Y2029];

/**
 * Pension access (normal minimum pension age, Finance Act 2022): 55, rising to 57 from 6 April 2028.
 * The age in force at the time applies: someone who reaches 55 before that date can draw from 55
 * until April 2028 but, without a protected pension age, not again until 57 (engine:
 * `ukPensionOpenAt`). `ukNormalMinimumPensionAge` returns the age of FIRST access.
 */
export const UK_PENSION_ACCESS = {
  age: 55,
  laterAge: 57,
  laterFromYear: 2028,
  laterFromMonth: 4,
} as const;

/** Normal minimum pension age for someone born in `birthYear`/`birthMonth` (1-12; default 1). */
export function ukNormalMinimumPensionAge(birthYear: number, birthMonth = 1): number {
  const at = (birthYear + UK_PENSION_ACCESS.age) * 12 + (birthMonth - 1);
  const later = UK_PENSION_ACCESS.laterFromYear * 12 + (UK_PENSION_ACCESS.laterFromMonth - 1);
  return at < later ? UK_PENSION_ACCESS.age : UK_PENSION_ACCESS.laterAge;
}

/**
 * State Pension age (Pensions Acts 2007/2011/2014). The single source of truth for the engine,
 * the tax plug-in (NI stops at SPA) and the solvers. With a birth month (1-12) the transitional
 * cohorts are month-accurate (66 + n months for April 1960 - March 1961, 67 -> 68 for April 1977 -
 * March 1978 as legislated); without it the birth year's cohort midpoint is used. Also accepts a
 * birth month string 'YYYY-MM' (the form the solvers and the web use).
 */
export function ukStatePensionAge(birthYear: number, birthMonth?: number): number;
export function ukStatePensionAge(birthMonth: string): number;
export function ukStatePensionAge(birth: number | string, month?: number): number {
  let birthYear: number;
  let birthMonth = month;
  if (typeof birth === "string") {
    const [y, m] = birth.split("-").map(Number) as [number, number];
    birthYear = y;
    birthMonth = m;
  } else birthYear = birth;
  if (birthMonth === undefined) {
    if (birthYear < 1960) return 66;
    if (birthYear === 1960) return 66.5;
    if (birthYear <= 1976) return 67;
    if (birthYear === 1977) return 67.5;
    return 68;
  }
  const m = birthYear * 12 + (birthMonth - 1);
  const ym = (y: number, mo: number) => y * 12 + (mo - 1);
  if (m < ym(1960, 4)) return 66;
  if (m < ym(1961, 3)) return 66 + (m - ym(1960, 4) + 1) / 12;
  if (m < ym(1977, 4)) return 67;
  if (m < ym(1978, 4)) return 67 + (m - ym(1977, 4) + 1) / 12;
  return 68;
}

/**
 * New State Pension deferral (reaching State Pension age from 6 April 2016): +1% for every 9 weeks
 * deferred, provided at least 9 weeks are deferred.
 */
export const UK_STATE_PENSION_DEFERRAL = { minimumWeeks: 9, upliftPer9Weeks: 0.01 } as const;

/** First month (YYYY-MM) of the cash ISA sub-limit by default (6 April 2027, Budget 2025). */
export const UK_CASH_ISA_LIMIT_FROM = "2027-04";
