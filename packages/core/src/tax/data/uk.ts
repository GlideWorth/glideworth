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
    /**
     * Separate property income rates from April 2027. They apply in England, Wales and Northern
     * Ireland; in Scotland the Scottish non-savings rates stay on property income until the Scottish
     * Parliament sets property rates (Finance Act 2026 s.8 lets it). Absent = non-savings rates.
     */
    property?: {
      rates: { basic: number; higher: number; additional: number };
      appliesInScotland: boolean;
    };
    marriageAllowance: number;
    /**
     * Pension Tax Allowance (announced at Budget 2026, 2027/28 to 2029/30): a reduction in income tax
     * for people over State Pension age whose total income is at or below the full new State Pension
     * (`threshold`), worth up to the basic rate on (threshold - personal allowance) and withdrawn at
     * £1 for every £3 of income above the threshold. Applies up to and including `lastYear`.
     */
    pensionTaxAllowance?: { threshold: number; withdrawalPerPound: number; lastYear: number };
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
  /** ISA subscription limits. Budget 2026 kept the cash ISA limit at the full £20,000. */
  isa: { overall: number; lisa: number; junior: number };
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
const OOTLAR_2025 =
  "https://www.gov.uk/government/publications/budget-2025-overview-of-tax-legislation-and-rates-ootlar/budget-2025-overview-of-tax-legislation-and-rates-ootlar";
const FINANCE_ACT_2026 = "https://www.legislation.gov.uk/ukpga/2026/11/contents";
const BUDGET_2026 =
  "https://www.gov.uk/government/publications/budget-2026-document/budget-2026-html";
const OOTLAR_2026 =
  "https://www.gov.uk/government/publications/budget-2026-overview-of-tax-legislation-and-rates-ootlar/budget-2026-overview-of-tax-legislation-and-rates-ootlar";
const ANNEX_A_2026 =
  "https://www.gov.uk/government/publications/budget-2026-overview-of-tax-legislation-and-rates-ootlar/annex-a-rates-and-allowances";

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
      note: "Freeze of income tax/NIC thresholds to April 2031; IHT thresholds to April 2031; dividend +2pp from April 2026; Plan 2 threshold held 2027/28-2029/30",
    },
    {
      url: OOTLAR_2025,
      note: "Para 1.1 PA and basic rate limit frozen to 2030/31; 1.7 starting rate for savings £5,000 to 2030/31; 1.13 IHT nil-rate bands to 5 April 2031; 2.1 NI PT/UEL to April 2031; 2.3 ISA £20,000 and JISA £9,000 to 5 April 2031 (read 2026-11-19)",
    },
    {
      url: FINANCE_ACT_2026,
      note: "Finance Act 2026 (18 March 2026): s.9 starting rate limit frozen to 2030/31; s.10 PA and basic rate limit frozen to 2030/31; ss.66-71 unused pensions in the IHT estate for deaths on or after 6 April 2027",
    },
    {
      url: "https://www.gov.uk/tax-on-dividends",
      note: "2026/27 dividend rates 10.75% / 35.75% / 39.35%, £500 allowance; worked example £29,570 wages + £3,000 dividends",
    },
    {
      url: "https://www.gov.uk/capital-gains-tax/rates",
      note: "CGT 18% / 24% and £3,000 annual exempt amount 2026/27; worked examples (£12,600 and £52,600 gains on £20,000 taxable income)",
    },
    {
      url: "https://www.gov.uk/self-employed-national-insurance-rates",
      note: "Class 4 2026/27: 6% on £12,570-£50,270, 2% above",
    },
    {
      url: "https://www.gov.uk/tax-on-your-private-pension/lump-sum-allowance",
      note: "Usually 25% tax-free; lump sum allowance £268,275; LSDBA £1,073,100",
    },
    {
      url: "https://www.gov.uk/child-benefit-tax-charge",
      note: "HICBC: 1% of Child Benefit per £200 of adjusted net income above £60,000, all of it above £80,000; the partner with the higher income pays (read 2026-11-19)",
    },
    {
      url: "https://www.gov.uk/lifetime-isa",
      note: "Lifetime ISA: first payment before 40, up to £4,000 a year until 50, 25% bonus (up to £1,000 a year), inside the £20,000 ISA allowance (read 2026-11-19)",
    },
    {
      url: "https://www.gov.uk/government/publications/state-pension-age-timetable/state-pension-age-timetable",
      note: "State Pension age tables 4 and 5: 66 + 1 to 11 months for births 6 April 1960 to 5 March 1961; dated rises to 68 for births 6 April 1977 to 5 April 1978 (read 2026-11-19)",
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
 * 2027/28: legislated and announced changes only. Savings rates and the new property income rates
 * are 22% / 42% / 47% in Finance Act 2026 (ss.5, 7); Budget 2026 announced a further 2 points, to
 * 24% / 44% / 49%, to be legislated in Finance Bill 2026-27, and those are used here. Budget 2026
 * also kept the cash ISA limit at £20,000 (the £12,000 limit announced at Budget 2025 will not
 * happen) and announced the Pension Tax Allowance. State Pension and Child Benefit are the published
 * 2027/28 rates. Other figures carry forward from 2026/27 (Annex A 2027-28 shows them unchanged).
 */
const Y2027: UkTaxYear = {
  ...Y2026,
  startYear: 2027,
  label: "2027/28 (announced)",
  sources: [
    {
      url: ANNEX_A_2026,
      note: "Budget 2026 Annex A 2027-28: PA £12,570, basic rate limit £37,700, savings and property rates 24/44/49, dividends unchanged, NI thresholds unchanged, CGT £3,000 18/24, AA £60,000, MPAA £10,000, LSA/LSDBA unchanged, ISA £20,000, IHT bands unchanged; Pension Tax Allowance threshold £13,037, withdrawn £1 per £3, fully withdrawn at £13,319; Child Benefit £28.00 / £18.55 (read 2026-11-19)",
    },
    {
      url: OOTLAR_2026,
      note: "Para 1.1 savings rates 24/44/49 UK-wide; 1.2 property rates 24/44/49 in England, Wales and NI (Scotland and Wales may set their own); 1.4 Pension Tax Allowance 2027/28-2029/30; to be legislated in Finance Bill 2026-27",
    },
    {
      url: BUDGET_2026,
      note: "Budget 2026 (28 October 2026): cash ISA limit kept at £20,000; Lifetime ISA replaced by a First Time Buyer ISA for new savers from April 2029; State Pension triple lock to April 2029, adjusted from April 2030",
    },
    {
      url: "https://www.legislation.gov.uk/ukpga/2026/11/section/5",
      note: "Finance Act 2026 s.5 (enacted): 2027/28 savings rates 22/42/47, superseded by the Budget 2026 announcement",
    },
    {
      url: "https://www.gov.uk/government/publications/income-tax-reduction-for-eligible-pensioners/reduction-in-income-tax-for-eligible-pensioners",
      note: "Pension Tax Allowance (HMRC policy paper, 28 October 2026): over State Pension age, total income (ITA 2007 s.23 step 1) up to the full new State Pension; 20% of (full new State Pension - PA) at step 6, never more than the tax due; reduced £1 per £3 above; uprated with the new State Pension this Parliament (read 2026-11-19)",
    },
    {
      url: "https://www.gov.uk/government/publications/benefit-and-pension-rates-2027-to-2028/proposed-benefit-and-pension-rates-2027-to-2028",
      note: "Proposed 2027/28 rates (published 11 November 2026): full new State Pension £250.70 a week",
    },
  ],
  income: {
    ...Y2026.income,
    savings: { ...Y2026.income.savings, rates: { basic: 0.24, higher: 0.44, additional: 0.49 } },
    property: { rates: { basic: 0.24, higher: 0.44, additional: 0.49 }, appliesInScotland: false },
    pensionTaxAllowance: { threshold: 13_037, withdrawalPerPound: 1 / 3, lastYear: 2029 },
  },
  statePension: { fullNewWeekly: 250.7 },
  childBenefit: { ...Y2026.childBenefit, eldestWeekly: 28, otherWeekly: 18.55 },
};

/**
 * From 6 April 2029: salary-sacrificed pension contributions above £2,000 a year pay Class 1 NI
 * (Budget 2025; National Insurance Contributions (Employer Pensions Contributions) Bill, with the
 * detail to follow in secondary legislation). Other figures carry forward from 2027/28.
 */
const Y2029: UkTaxYear = {
  ...Y2027,
  startYear: 2029,
  label: "2029/30 (announced)",
  sources: [
    {
      url: "https://www.gov.uk/government/publications/changes-to-salary-sacrifice-for-pensions-from-april-2029/changes-to-salary-sacrifice-for-pensions-from-april-2029",
      note: "Salary-sacrificed pension contributions above £2,000 a year liable to Class 1 NI from 6 April 2029",
    },
  ],
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

/**
 * Default first month (YYYY-MM) of a cash ISA sub-limit the user sets (`tax.uk.cashIsaLimit`).
 * There is no statutory cash ISA limit: Budget 2026 kept it at the full £20,000.
 */
export const UK_CASH_ISA_LIMIT_FROM = "2027-04";
