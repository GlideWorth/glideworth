/**
 * US state individual income tax, tax year 2026, all 50 states + DC. Data only; calculation in
 * ../jurisdictions/us-state.ts.
 *
 * Each row cites the state's own revenue department, statute or official tax-year publication
 * (`sources`, read 2026-11-16 or 2026-11-19 as noted). Figures are facts transcribed from those
 * publications. Where an official page could not be opened (several state sites refuse automated
 * clients) the row says what is unconfirmed in `unconfirmed`; that text is shown with the state's
 * tax results.
 *
 * Married brackets: where the state doubles single brackets `mfj` is omitted and `mfjFactor`
 * applies; where it publishes different married brackets they are listed explicitly. Rows flagged
 * `approx` carry approximations (noted inline): check before relying on them for a specific return.
 *
 * Simplifications: the starting point is federal AGI (or the federal deduction, for states that
 * start from federal taxable income); itemised deductions, state AMT/minimum taxes and credits
 * other than those listed on a row are not modelled; retirement exclusions, Social Security rules
 * and age amounts are modelled where the row lists them.
 */

export interface StateSource {
  url: string;
  note?: string;
}

/** Single / married-filing-jointly pair. */
export interface ByJoint {
  single: number;
  mfj: number;
}

/**
 * Partial exemption of federally taxable Social Security (when `taxesSocialSecurity`). Benefits of
 * people at or above `minAge` are exempt in full while federal AGI is at or below `agiLimit`; above
 * it the exemption falls by `phaseOut` (share of the exemption lost per dollar over a width, in
 * optional steps), by `reductionPerDollar` (dollars of exemption lost per dollar of AGI), or to the
 * `maxTaxableShare` of benefits, and otherwise stops (a cliff). `exemptFromAge` exempts benefits of
 * older people at any income. Thresholds are statutory and not indexed unless `indexed`.
 */
export interface StateSocialSecurityRule {
  agiLimit?: ByJoint;
  minAge?: number;
  exemptFromAge?: number;
  phaseOut?: { width: ByJoint; step?: number };
  reductionPerDollar?: number;
  maxTaxableShare?: number;
  indexed?: boolean;
}

/** Income test on the retirement exclusion: linear phase-out, or steps of [AGI above, share kept]. */
export interface StateIncomeTest {
  phaseOut?: { start: ByJoint; width: ByJoint };
  steps?: { single: [number, number][]; mfj: [number, number][] };
  indexed?: boolean;
}

/** Deduction for age against any income (VA, SC, WV). Per person. */
export interface StateAgeDeduction {
  amount: number;
  minAge: number;
  /** Reduced by the same person's retirement exclusion (SC). */
  lessRetirementExclusion?: boolean;
  /** Reduced by the same person's exempt Social Security (WV). */
  lessExemptSocialSecurity?: boolean;
  /** Total reduced $1 per $1 of federal AGI less taxable Social Security above this (VA). */
  agiReduction?: ByJoint;
}

/** Extra amount per filer of `minAge` (default 65) or over; `married` applies on joint returns. */
export interface StateAgedAmount {
  single: number;
  married: number;
  /** A tax credit rather than a deduction. */
  credit?: boolean;
  minAge?: number;
  /** Part of the exemption, so lost with it above `exemption.zeroAboveAgi` (Illinois). */
  withExemption?: boolean;
}

/** Steps of [state AGI above, share]; the share of the highest step exceeded applies, else 0. */
export interface StateAgiSteps {
  single: [number, number][];
  mfj: [number, number][];
}

export interface StateRow {
  code: string;
  name: string;
  kind: "none" | "flat" | "brackets" | "capital-gains-only";
  /** Single filer [threshold, rate]. Flat states: one row. */
  single: [number, number][];
  /** Married filing jointly brackets, when not simply `single x mfjFactor`. */
  mfj?: [number, number][];
  mfjFactor?: number;
  /**
   * Schedule for taxable income at or below `maxIncome` (Arkansas). Above it the main brackets
   * apply, less a bracket adjustment falling linearly from `adjustment.amount` to nothing at
   * `adjustment.to`.
   */
  lowIncomeTable?: {
    maxIncome: number;
    brackets: [number, number][];
    adjustment?: { amount: number; to: number };
  };
  /** Fixed amount added once taxable income exceeds `threshold` (Ohio's $332 base). */
  stepTax?: { threshold: number; amount: number };
  standardDeduction?: { single: number; mfj: number };
  /**
   * The standard deduction falls linearly from its full amount at state AGI `start` to `floor` at
   * `end` (Alabama's chart).
   */
  standardDeductionPhaseOut?: { start: ByJoint; end: ByJoint; floor: ByJoint };
  /** Above federal AGI `agiAbove` the federal deduction is limited to `cap` (Colorado addback). */
  federalDeductionLimit?: { agiAbove: number; cap: ByJoint };
  /**
   * Deduction for federal income tax after credits: `share` steps by state AGI (all of it when
   * absent), at most `cap` (Alabama, Missouri).
   */
  federalTaxDeduction?: { share?: StateAgiSteps; cap?: ByJoint };
  /** Credit equal to a share of the tax, by state AGI (Connecticut's personal tax credit). */
  taxCreditShare?: StateAgiSteps;
  /**
   * Use the federal deduction instead of `standardDeduction` when the federal level ran: 'standard'
   * = the federal standard (or itemised) deduction including the 65+ amounts; 'taxable-income' =
   * that plus the OBBBA senior deduction (states that start from federal taxable income).
   */
  federalDeduction?: "standard" | "taxable-income";
  /** Extra deductions (or credits) per filer by age. */
  aged?: StateAgedAmount[];
  /** Personal exemption per filer/dependent; `credit` = amounts are tax credits, not deductions. */
  exemption?: {
    single: number;
    mfj: number;
    dependent: number;
    credit?: boolean;
    /** No exemption above this federal AGI (Oregon's credit, Illinois). */
    zeroAboveAgi?: ByJoint;
    /** Reduced `perDollar` for each dollar of state AGI above `start` (Connecticut). */
    phaseOut?: { start: ByJoint; perDollar: number };
    /** Per-exemption amount by federal AGI: [AGI above, amount] replacing the base amounts (Ohio). */
    byAgi?: [number, number][];
    /** Dependents count only after the first, and only on joint returns (New Mexico). */
    dependentsAfterFirstJointOnly?: boolean;
  };
  /** Taxes Social Security benefits (to the extent federally taxable). Default false. */
  taxesSocialSecurity?: boolean;
  /** Partial exemption of Social Security in a state that taxes it. */
  socialSecurity?: StateSocialSecurityRule;
  /**
   * Per-person exclusion of retirement income (pensions + tax-deferred withdrawals).
   * amount Infinity = fully exempt. `minAge` = age from which it applies.
   */
  retirementExclusion?: { amount: number; minAge: number }[];
  /**
   * What the exclusion covers: 'pension' (pension/annuity income only), 'employer' (pensions and
   * workplace plans such as 401(k), not IRAs), 'retirement' (also IRA withdrawals) or
   * 'retirement-and-investment' (also interest, dividends, capital gains and rent: Georgia,
   * Delaware).
   */
  retirementExclusionAppliesTo?:
    | "pension"
    | "employer"
    | "retirement"
    | "retirement-and-investment";
  /** Pension and annuity income is exempt in full at any age; the exclusion covers the rest (Alabama). */
  pensionIncomeExempt?: boolean;
  /** Cap per return instead of (or as well as) per person (Michigan, New Jersey). */
  retirementExclusionPerReturn?: ByJoint;
  /**
   * The per-person cap is reduced by that person's Social Security: benefits received (`true`;
   * Maine, Maryland) or the benefits the state exempts (`'exempt'`; Colorado).
   */
  retirementExclusionLessSocialSecurity?: boolean | "exempt";
  /** Income test on the exclusion (New Jersey, Maine, Rhode Island). */
  retirementExclusionIncomeTest?: StateIncomeTest;
  /** Deduction for age against any income. */
  ageDeduction?: StateAgeDeduction;
  /** Capital gains: taxed as ordinary (default) or exempt. */
  capitalGains?: "ordinary" | "exempt";
  /** Washington: separate tax on long-term gains above a standard deduction. */
  capitalGainsTax?: { deduction: number; brackets: [number, number][] };
  /** Payroll: state disability insurance rate on all wages (CA SDI). */
  sdiRate?: number;
  /** Published SDI rates from a calendar year on, replacing `sdiRate` (CA 2027). */
  sdiRateFrom?: [number, number][];
  approx?: string;
  /** Official publications the row was checked against. */
  sources: StateSource[];
  /** Figures that could not be confirmed from an official source. */
  unconfirmed?: string;
}

/** Date of the latest check of the state sources in this file. */
export const US_STATES_CHECKED = "2026-11-19";

const NONE = (
  code: string,
  name: string,
  sources: StateSource[],
  extra: Partial<StateRow> = {},
): StateRow => ({
  code,
  name,
  kind: "none",
  single: [[0, 0]],
  sources,
  ...extra,
});
const FLAT = (
  code: string,
  name: string,
  rate: number,
  sources: StateSource[],
  extra: Partial<StateRow> = {},
): StateRow => ({
  code,
  name,
  kind: "flat",
  single: [[0, rate]],
  sources,
  ...extra,
});
const ALL = Number.POSITIVE_INFINITY;
const READ = "read 2026-11-16";
const READ19 = "read 2026-11-19";
const BLOCKED = (site: string): StateSource => ({
  url: site,
  note: `official site; could not be opened on 2026-11-16 (refuses automated clients or did not respond)`,
});

export const US_STATES_2026: StateRow[] = [
  {
    code: "AL",
    name: "Alabama",
    kind: "brackets",
    single: [
      [0, 0.02],
      [500, 0.04],
      [3_000, 0.05],
    ],
    mfjFactor: 2,
    standardDeduction: { single: 3_000, mfj: 8_500 },
    // Standard deduction chart: $25 ($175 joint) less for each $500 of AL AGI from $26,000, to
    // $2,500 ($5,000 joint) from $35,500; smoothed into a line.
    standardDeductionPhaseOut: {
      start: { single: 25_500, mfj: 25_500 },
      end: { single: 35_500, mfj: 35_500 },
      floor: { single: 2_500, mfj: 5_000 },
    },
    exemption: { single: 1_500, mfj: 3_000, dependent: 1_000 },
    // Defined benefit pensions are exempt at any age; from 65 the first $6,000 of other taxable
    // retirement income (IRA, 401(k)) per person is excluded.
    pensionIncomeExempt: true,
    retirementExclusion: [{ amount: 6_000, minAge: 65 }],
    // Form 40 line 12: federal income tax after credits, in full.
    federalTaxDeduction: {},
    approx:
      "pension and annuity income is treated as paid by a defined benefit plan (exempt); the dependent exemption is shown at $1,000 (it is $500 above $50,000 and $300 above $100,000 of income); the standard deduction chart's $500 steps are smoothed",
    sources: [
      {
        url: "https://www.revenue.alabama.gov/faqs/how-much-is-the-alabama-standard-deduction/",
        note: `Rates 2% / 4% / 5% at $500 / $3,000 single, $1,000 / $6,000 joint (${READ19})`,
      },
      {
        url: "https://www.revenue.alabama.gov/wp-content/uploads/2026/01/25f40bk.pdf",
        note: `2025 Form 40 booklet (amounts statutory, not indexed): personal exemption $1,500 / $3,000; dependent exemption $1,000 / $500 / $300 by income; standard deduction chart $3,000 to $2,500 single and $8,500 to $5,000 joint between AL AGI $26,000 and $35,500; defined benefit plans and Social Security exempt; line 12 federal income tax deduction (worksheet page 31) (${READ19})`,
      },
      {
        url: "https://www.revenue.alabama.gov/wp-content/uploads/2026/01/25schrsblk.pdf",
        note: `2025 Schedule RS: up to $6,000 of taxable retirement income excluded for each taxpayer 65 or older (${READ19})`,
      },
    ],
  },
  NONE("AK", "Alaska", [
    {
      url: "https://tax.alaska.gov/programs/programs/reports/AnnualReport.aspx?Year=2024",
      note: `Tax Division history: the individual income tax was repealed in 1980 (${READ})`,
    },
  ]),
  FLAT(
    "AZ",
    "Arizona",
    0.025,
    [
      {
        url: "https://www.azleg.gov/legtext/57leg/2R/laws/0140.pdf",
        note: `Laws 2026, ch. 140 (HB 4168), sec. 16, 18 and 35: A.R.S. 43-1041 standard deduction $15,750 / $31,500 from 2025, indexed like the federal basic standard deduction; dependent credit $125 under 17 and $25 from 17 from 2026 (${READ19})`,
      },
      {
        url: "https://www.azleg.gov/ars/43/01023.htm",
        note: `A.R.S. 43-1023(E): exemption of $2,100 for a taxpayer, and a spouse on a joint return, aged 65 or over (${READ19})`,
      },
      {
        url: "https://www.azleg.gov/legtext/57leg/1R/fiscal/HCR2012.DOCX.htm",
        note: `JLBC fiscal note on HCR 2012 (31 Jan 2025): "the current rate of 2.5%"; the resolution would cut it to 2.0% from tax year 2027 if approved by voters (${READ19})`,
      },
      BLOCKED("https://azdor.gov/"),
    ],
    {
      standardDeduction: { single: 16_100, mfj: 32_200 },
      aged: [{ single: 2_100, married: 2_100 }],
      exemption: { single: 0, mfj: 0, dependent: 125, credit: true },
      approx:
        "2026 standard deduction derived from the statutory 2025 amounts indexed like the federal basic deduction ($16,100 / $32,200); dependent credit shown at $125 for every dependent ($25 from age 17) and its phase-out above $200,000 / $400,000 is not modelled; the charitable addition to the standard deduction is not modelled",
      unconfirmed:
        "the 2.5% rate for 2026 (the Legislature's 2025 fiscal note gives it as the current rate; the Department's pages and the online statute text could not be read), and whether voters approved HCR 2012's 2.0% rate from 2027",
    },
  ),
  {
    code: "AR",
    name: "Arkansas",
    kind: "brackets",
    single: [
      [0, 0.02],
      [4_700, 0.037],
    ],
    mfjFactor: 1,
    // A.C.A. 26-51-201(a)(4)(A): net income up to $94,700; (C): bracket adjustment from $290 at
    // $94,701 down by $10 per $100 to nothing at $97,600 (smoothed into a line).
    lowIncomeTable: {
      maxIncome: 94_700,
      brackets: [
        [0, 0],
        [5_600, 0.02],
        [11_200, 0.03],
        [16_000, 0.034],
        [26_400, 0.037],
      ],
      adjustment: { amount: 290, to: 97_600 },
    },
    standardDeduction: { single: 2_470, mfj: 4_940 },
    exemption: { single: 29, mfj: 58, dependent: 29, credit: true },
    aged: [{ single: 29, married: 29, credit: true }],
    retirementExclusion: [{ amount: 6_000, minAge: 59.5 }],
    approx:
      "the $6,000 retirement exemption is applied from 59 1/2 to all retirement income (employer plan payments qualify at any age); the second $29 credit at 65 for people who claim no retirement exemption is not modelled",
    sources: [
      {
        url: "https://www.arkleg.state.ar.us/Home/FTPDocument?path=%2FACTS%2F2026S1%2FPublic%2FACT1.pdf",
        note: `Act 1 of the 2026 First Extraordinary Session, A.C.A. 26-51-201(a)(4): from 2026, net income up to $94,700: 0% to $5,599, 2%, 3%, 3.4%, 3.7% from $26,400; above $94,700: 2% to $4,700 and 3.7% above, less a bracket adjustment up to $97,600 (${READ19})`,
      },
      {
        url: "https://www.dfa.arkansas.gov/wp-content/uploads/2026_Final_AR1000ES_2.pdf",
        note: `2026 AR1000ES: standard deduction $2,470 per taxpayer; personal credit $29 each, and $29 for each person over 65 (${READ19})`,
      },
      {
        url: "https://www.dfa.arkansas.gov/wp-content/uploads/2025_AR1000F_and_AR1000NR_Instructions.pdf",
        note: `2025 AR1000F instructions: first $6,000 of employer-plan or IRA (from 59 1/2) income exempt per taxpayer; Social Security exempt (${READ19})`,
      },
    ],
  },
  {
    code: "CA",
    name: "California",
    kind: "brackets",
    single: [
      [0, 0.01],
      [11_456, 0.02],
      [27_157, 0.04],
      [42_861, 0.06],
      [59_498, 0.08],
      [75_197, 0.093],
      [384_109, 0.103],
      [460_927, 0.113],
      [768_213, 0.123],
      [1_000_000, 0.133],
    ],
    mfj: [
      [0, 0.01],
      [22_912, 0.02],
      [54_314, 0.04],
      [85_722, 0.06],
      [118_996, 0.08],
      [150_394, 0.093],
      [768_218, 0.103],
      [921_854, 0.113],
      [1_000_000, 0.123],
      [1_536_426, 0.133],
    ],
    standardDeduction: { single: 5_900, mfj: 11_800 },
    exemption: { single: 158, mfj: 316, dependent: 491, credit: true },
    // Form 540 line 9: a senior exemption credit, equal to the personal credit, for each spouse 65+.
    aged: [{ single: 158, married: 158, credit: true }],
    sdiRate: 0.013,
    sdiRateFrom: [[2027, 0.014]],
    approx:
      "the 1% Behavioral Health Services Tax on taxable income over $1m (all filing statuses) is folded into the brackets; the reduction of exemption credits above federal AGI of $252,203 single / $504,411 joint (2025) is not modelled",
    sources: [
      {
        url: "https://www.ftb.ca.gov/about-ftb/newsroom/tax-news/2026/10.html",
        note: `FTB Tax News, October 2026 (2026 indexing, CCPI 3.4%): Schedules X and Y, standard deduction $5,900 / $11,800, personal and senior exemption credit $158 ($316 joint), dependent $491 (${READ19})`,
      },
      {
        url: "https://www.ftb.ca.gov/forms/2025/2025-540-booklet.html",
        note: `2025 Form 540 instructions: line 9 senior exemption for each spouse 65 or older; credit limitation above federal AGI $252,203 / $504,411 (${READ19})`,
      },
      {
        url: "https://www.ftb.ca.gov/forms/2026/2026-540-es-instructions.html",
        note: `Behavioral Health Services Tax: 1% of taxable income over $1,000,000 (${READ})`,
      },
      {
        url: "https://edd.ca.gov/en/payroll_taxes/rates_and_withholding/",
        note: `EDD: SDI withholding rate 1.3% for 2026 and 1.4% for 2027, no taxable wage limit (${READ19})`,
      },
    ],
  },
  FLAT(
    "CO",
    "Colorado",
    0.044,
    [
      {
        url: "https://tax.colorado.gov/sites/default/files/documents/DR_0104EP_2026.pdf",
        note: `DR 0104EP 2026: estimated tax at 4.4% of Colorado taxable income, which starts from federal taxable income (${READ})`,
      },
      {
        url: "https://tax.colorado.gov/individual-income-tax-guide",
        note: `Income tax guide: 4.4% for 2025; above AGI $300,000 the federal standard or itemised deduction over $1,000 single / $2,000 joint is added back from 2026 (${READ19})`,
      },
      {
        url: "https://tax.colorado.gov/sites/tax/files/documents/ITT_Social_Security_Pensions_and_Annuities_Jan_2025.pdf",
        note: `Income Tax Topics (Jan 2025): pension, annuity, IRA (not premature) and taxable Social Security subtraction up to $20,000 from 55 and $24,000 from 65, per person; all taxable Social Security from 65, and from 55 at AGI up to $75,000 single / $95,000 joint from 2025; Social Security subtracted reduces the pension limit (${READ19})`,
      },
      {
        url: "https://tax.colorado.gov/january-2026-tax-policy-updates",
        note: `2026 changes: overtime deduction addback and the standard or itemised deduction addback; no addback of the senior deduction is listed (${READ19})`,
      },
    ],
    {
      standardDeduction: { single: 16_100, mfj: 32_200 },
      federalDeduction: "taxable-income",
      federalDeductionLimit: { agiAbove: 300_000, cap: { single: 1_000, mfj: 2_000 } },
      taxesSocialSecurity: true,
      socialSecurity: {
        exemptFromAge: 65,
        minAge: 55,
        agiLimit: { single: 75_000, mfj: 95_000 },
      },
      retirementExclusion: [
        { amount: 20_000, minAge: 55 },
        { amount: 24_000, minAge: 65 },
      ],
      retirementExclusionLessSocialSecurity: "exempt",
      approx:
        "from 55 to 64 above the AGI limit, Social Security is taxed in full here instead of sharing the $20,000 subtraction; premature IRA distributions, which do not qualify, are treated as qualifying",
      unconfirmed:
        "whether the federal senior deduction is added back (the Department's list of 2026 changes names no such addback, so it is allowed here)",
    },
  ),
  {
    code: "CT",
    name: "Connecticut",
    kind: "brackets",
    single: [
      [0, 0.02],
      [10_000, 0.045],
      [50_000, 0.055],
      [100_000, 0.06],
      [200_000, 0.065],
      [250_000, 0.069],
      [500_000, 0.0699],
    ],
    mfjFactor: 2,
    // C.G.S. 12-702: reduced $1,000 for each $1,000 of CT AGI over $30,000 / $48,000.
    exemption: {
      single: 15_000,
      mfj: 24_000,
      dependent: 0,
      phaseOut: { start: { single: 30_000, mfj: 48_000 }, perDollar: 1 },
    },
    taxesSocialSecurity: true,
    // C.G.S. 12-701(a)(20)(B)(x): all taxable benefits subtracted below federal AGI $75,000 /
    // $100,000; above, at most 25% of benefits stays taxable.
    socialSecurity: { agiLimit: { single: 75_000, mfj: 100_000 }, maxTaxableShare: 0.25 },
    // C.G.S. 12-701(a)(20)(B)(xxi), (xxii), (xxviii), (xxix): pension and annuity income and (from
    // 2026 in full) traditional IRA distributions, by federal AGI.
    retirementExclusion: [{ amount: ALL, minAge: 0 }],
    retirementExclusionIncomeTest: {
      steps: {
        single: [
          [74_999.99, 0.85],
          [77_499.99, 0.7],
          [79_999.99, 0.55],
          [82_499.99, 0.4],
          [84_999.99, 0.25],
          [87_499.99, 0.1],
          [89_999.99, 0.05],
          [94_999.99, 0.025],
          [99_999.99, 0],
        ],
        mfj: [
          [99_999.99, 0.85],
          [104_999.99, 0.7],
          [109_999.99, 0.55],
          [114_999.99, 0.4],
          [119_999.99, 0.25],
          [124_999.99, 0.1],
          [129_999.99, 0.05],
          [139_999.99, 0.025],
          [149_999.99, 0],
        ],
      },
    },
    // C.G.S. 12-703(a)(2)(I) and (c): personal tax credit, a share of the tax by CT AGI.
    taxCreditShare: {
      single: [
        [15_000, 0.75],
        [18_800, 0.7],
        [19_300, 0.65],
        [19_800, 0.6],
        [20_300, 0.55],
        [20_800, 0.5],
        [21_300, 0.45],
        [21_800, 0.4],
        [22_300, 0.35],
        [25_000, 0.3],
        [25_500, 0.25],
        [26_000, 0.2],
        [26_500, 0.15],
        [31_300, 0.14],
        [31_800, 0.13],
        [32_300, 0.12],
        [32_800, 0.11],
        [33_300, 0.1],
        [60_000, 0.09],
        [60_500, 0.08],
        [61_000, 0.07],
        [61_500, 0.06],
        [62_000, 0.05],
        [62_500, 0.04],
        [63_000, 0.03],
        [63_500, 0.02],
        [64_000, 0.01],
        [64_500, 0],
      ],
      mfj: [
        [24_000, 0.75],
        [30_000, 0.7],
        [30_500, 0.65],
        [31_000, 0.6],
        [31_500, 0.55],
        [32_000, 0.5],
        [32_500, 0.45],
        [33_000, 0.4],
        [33_500, 0.35],
        [40_000, 0.3],
        [40_500, 0.25],
        [41_000, 0.2],
        [41_500, 0.15],
        [50_000, 0.14],
        [50_500, 0.13],
        [51_000, 0.12],
        [51_500, 0.11],
        [52_000, 0.1],
        [96_000, 0.09],
        [96_500, 0.08],
        [97_000, 0.07],
        [97_500, 0.06],
        [98_000, 0.05],
        [98_500, 0.04],
        [99_000, 0.03],
        [99_500, 0.02],
        [100_000, 0.01],
        [100_500, 0],
      ],
    },
    approx:
      "the phase-out of the 2% bracket and the benefit recapture at higher incomes are not modelled; the exemption phases out by the dollar rather than in $1,000 steps; above the Social Security income limit the alternative limit (25% of the excess over the federal base amount) is not applied; all workplace-plan payments count as pension or annuity income",
    sources: [
      {
        url: "https://www.cga.ct.gov/current/pub/chap_229.htm",
        note: `C.G.S. 12-700(a)(10) (rates for 2024 onward; joint brackets double the single ones), 12-702 (exemptions $15,000 / $24,000, reduced over CT AGI $30,000 / $48,000), 12-701(a)(20)(B) (Social Security, pension and IRA subtractions by federal AGI) and 12-703 (personal tax credit) (${READ19})`,
      },
    ],
  },
  {
    code: "DE",
    name: "Delaware",
    kind: "brackets",
    single: [
      [0, 0],
      [2_000, 0.022],
      [5_000, 0.039],
      [10_000, 0.048],
      [20_000, 0.052],
      [25_000, 0.0555],
      [60_000, 0.066],
    ],
    mfjFactor: 1,
    standardDeduction: { single: 3_250, mfj: 6_500 },
    exemption: { single: 110, mfj: 220, dependent: 110, credit: true },
    aged: [
      // 30 Del. C. 1108(b): $2,500 more standard deduction for each filer 65 or over.
      { single: 2_500, married: 2_500 },
      // 30 Del. C. 1110(b)(2): $110 more personal credit for each person 60 or over.
      { single: 110, married: 110, credit: true, minAge: 60 },
    ],
    // 30 Del. C. 1106(b)(3)b: $2,000 of employer pensions under 60; from 60, $12,500 of pensions
    // and eligible retirement income (IRA and plan payments, interest, dividends, gains, rent).
    retirementExclusion: [
      { amount: 2_000, minAge: 0 },
      { amount: 12_500, minAge: 60 },
    ],
    retirementExclusionAppliesTo: "retirement-and-investment",
    approx:
      "a joint return uses one rate table on the couple's combined income (spouses may instead file separately on one return, which often costs less); under 60 the $2,000 exclusion applies to retirement and investment income alike (only employer pensions qualify)",
    sources: [
      {
        url: "https://revenue.delaware.gov/frequently-asked-questions/personal-income-tax-faqs/",
        note: `Rates 2.2%-5.55% below $60,000 and 6.6% above; pension exclusion up to $12,500 from 60 (${READ})`,
      },
      {
        url: "https://delcode.delaware.gov/title30/c011/sc01/index.html",
        note: `30 Del. C. 1102(a): rates for taxable years after 2013, 0% to $2,000 and 6.6% above $60,000 (${READ19})`,
      },
      {
        url: "https://delcode.delaware.gov/title30/c011/sc02/index.html",
        note: `30 Del. C. 1106(b)(3) (pension and eligible retirement income exclusion, 2022-2026), 1108 (standard deduction $3,250 / $6,500, $2,500 more at 65) and 1110 ($110 personal credit, $110 more at 60) (${READ19})`,
      },
    ],
  },
  NONE("FL", "Florida", [
    {
      url: "https://floridarevenue.com/faq/Pages/FAQDetails.aspx?FAQID=1466",
      note: `Florida does not impose a personal income tax (${READ})`,
    },
  ]),
  FLAT(
    "GA",
    "Georgia",
    0.0499,
    [
      {
        url: "https://dor.georgia.gov/taxes/important-tax-updates",
        note: `2026: flat rate 4.99%; standard deduction $15,000 / $30,000 (${READ19})`,
      },
      {
        url: "https://dor.georgia.gov/document/document/2026-employers-tax-guide-updated-september-2026/download",
        note: `HB 463 (2026), retroactive to 1 Jan 2026: 4.99%; standard deduction $15,000 / $30,000; dependent deduction $5,000 (${READ19})`,
      },
      {
        url: "https://dor.georgia.gov/document/document/2025-it-511-individual-income-tax-booklet/download",
        note: `2025 IT-511: retirement income exclusion up to $35,000 at 62-64 and $65,000 from 65, per spouse, covering pensions, IRAs, interest, dividends, rent, capital gains and up to $5,000 of earned income (${READ19})`,
      },
      {
        url: "https://dor.georgia.gov/georgia-standard-deductions-increases",
        note: `The $1,300 addition for age 65 or blindness is listed only for 2021-2022, not from 2024 (${READ19})`,
      },
    ],
    {
      standardDeduction: { single: 15_000, mfj: 30_000 },
      exemption: { single: 0, mfj: 0, dependent: 5_000 },
      retirementExclusion: [
        { amount: 35_000, minAge: 62 },
        { amount: 65_000, minAge: 65 },
      ],
      retirementExclusionAppliesTo: "retirement-and-investment",
      approx:
        "the up to $5,000 of earned income that may count toward the retirement exclusion is not included",
    },
  ),
  {
    code: "HI",
    name: "Hawaii",
    kind: "brackets",
    single: [
      [0, 0.014],
      [9_600, 0.032],
      [14_400, 0.055],
      [19_200, 0.064],
      [24_000, 0.068],
      [36_000, 0.072],
      [48_000, 0.076],
      [125_000, 0.079],
      [175_000, 0.0825],
      [225_000, 0.09],
      [275_000, 0.1],
      [325_000, 0.11],
    ],
    mfjFactor: 2,
    standardDeduction: { single: 8_000, mfj: 16_000 },
    exemption: { single: 1_144, mfj: 2_288, dependent: 1_144 },
    aged: [{ single: 1_144, married: 1_144 }],
    retirementExclusion: [{ amount: ALL, minAge: 0 }],
    retirementExclusionAppliesTo: "pension",
    approx:
      "all pension-character income treated as employer-funded (exempt); IRA/401(k) withdrawals taxable; the bracket and standard deduction changes legislated for 2027 onward (Act 46, SLH 2024) are not applied, so later years carry the 2026 tables forward",
    sources: [
      {
        url: "https://tax.hawaii.gov/forms/d_25table-on/d_25table-on_p13/",
        note: `Tax rate schedules for taxable years beginning after 31 Dec 2024 (Schedule II doubles Schedule I) (${READ19})`,
      },
      {
        url: "https://tax.hawaii.gov/faq/",
        note: `2026 standard deduction $8,000 / $16,000; personal exemption $1,144, with an additional exemption for those 65 or older (${READ19})`,
      },
      {
        url: "https://files.hawaii.gov/tax/news/announce/ann24-03.pdf",
        note: `Announcement 2024-03 (Act 46, SLH 2024): standard deduction and brackets change again for 2027 and later years (${READ19})`,
      },
    ],
  },
  FLAT(
    "ID",
    "Idaho",
    0.053,
    [
      {
        url: "https://tax.idaho.gov/",
        note: `official site; refused connections on 2026-11-16 and 2026-11-19 (legislature.idaho.gov likewise)`,
      },
    ],
    {
      single: [
        [0, 0],
        [4_811, 0.053],
      ],
      mfj: [
        [0, 0],
        [9_622, 0.053],
      ],
      standardDeduction: { single: 16_100, mfj: 32_200 },
      unconfirmed:
        "all Idaho figures: the 5.3% rate, the zero-rate band ($4,811 / $9,622 appear to be the 2025 amounts; the 2026 amounts are indexed), the standard deduction and how Idaho treats the federal senior deduction (tax.idaho.gov and legislature.idaho.gov refused connections)",
    },
  ),
  FLAT(
    "IL",
    "Illinois",
    0.0495,
    [
      {
        url: "https://tax.illinois.gov/research/taxrates/income.html",
        note: `Individuals: 4.95% of net income (${READ})`,
      },
      {
        url: "https://tax.illinois.gov/questionsandanswers/answer.851.html",
        note: `Exemption allowance $2,925 per exemption for 2026; $1,000 more if 65 or older; no exemption allowance above federal AGI $250,000 ($500,000 joint) (${READ19})`,
      },
      {
        url: "https://tax.illinois.gov/content/dam/soi/en/web/tax/forms/incometax/documents/currentyear/individual/il-1040-instr.pdf",
        note: `IL-1040 instructions (2025): line 10 exemption allowance, 65-or-older additions and the AGI limits; retirement income and Social Security subtracted (${READ19})`,
      },
    ],
    {
      exemption: {
        single: 2_925,
        mfj: 5_850,
        dependent: 2_925,
        zeroAboveAgi: { single: 250_000, mfj: 500_000 },
      },
      aged: [{ single: 1_000, married: 1_000, withExemption: true }],
      retirementExclusion: [{ amount: ALL, minAge: 0 }],
    },
  ),
  FLAT(
    "IN",
    "Indiana",
    0.0295,
    [
      {
        url: "https://www.in.gov/dor/resources/tax-rates-and-reports/rates-fees-and-penalties/",
        note: `Individual adjusted gross income tax rate 2.95% for 2026 (${READ})`,
      },
      {
        url: "https://iga.in.gov/ic/2026/Title_6/Article_3/Chapter_1.pdf",
        note: `IC 6-3-1-3.5(a): $1,000 per exemption, plus $1,500 for each dependent child (${READ})`,
      },
    ],
    {
      exemption: { single: 1_000, mfj: 2_000, dependent: 2_500 },
      // IC 6-3-1-3.5(a)(4)(B): $1,000 more for each filer aged 65 or over.
      aged: [{ single: 1_000, married: 1_000 }],
      approx:
        "county income taxes are not included; the extra $500 exemption for people 65+ with federal AGI under $40,000 is not modelled",
    },
  ),
  FLAT(
    "IA",
    "Iowa",
    0.038,
    [
      {
        url: "https://revenue.iowa.gov/press-release/2025-10-21/idr-announces-2026-individual-income-tax-and-interest-rates",
        note: `Flat 3.8% on all taxable income in 2026 (${READ})`,
      },
      {
        url: "https://revenue.iowa.gov/taxes/tax-guidance/individual-income-tax/retirement-income-tax-guidance",
        note: `Retirement income (pensions, 401(k), 457(b), IRAs) excluded in full from 55, per person (${READ19})`,
      },
      {
        url: "https://revenue.iowa.gov/taxes/tax-guidance/individual-income-tax/1040-expanded-instructions/federal-taxable-income",
        note: `Iowa starts from federal taxable income (rolling conformity), so the federal deductions apply (${READ19})`,
      },
      {
        url: "https://revenue.iowa.gov/taxes/tax-guidance/individual-income-tax/1040-expanded-instructions/exemption-credits",
        note: `Exemption credits $40 per filer and dependent, $20 more per person 65+ (${READ19})`,
      },
    ],
    {
      standardDeduction: { single: 16_100, mfj: 32_200 },
      federalDeduction: "taxable-income",
      exemption: { single: 40, mfj: 80, dependent: 40, credit: true },
      aged: [{ single: 20, married: 20, credit: true }],
      retirementExclusion: [{ amount: ALL, minAge: 55 }],
    },
  ),
  {
    code: "KS",
    name: "Kansas",
    kind: "brackets",
    single: [
      [0, 0.052],
      [23_000, 0.0558],
    ],
    mfjFactor: 2,
    standardDeduction: { single: 3_605, mfj: 8_240 },
    // K.S.A. 79-32,119(b): $850 single / $700 per married filer aged 65+.
    aged: [{ single: 850, married: 700 }],
    exemption: { single: 9_160, mfj: 18_320, dependent: 2_320 },
    approx:
      "KPERS, federal civil service and military pensions are exempt but other retirement income is taxed; only the general rule is modelled",
    sources: [
      {
        url: "https://www.kslegislature.gov/li/b2025_26/statute/079_000_0000_chapter/079_032_0000_article/079_032_0110_section/079_032_0110_k/",
        note: `K.S.A. 79-32,110: 5.2% to $23,000 ($46,000 joint), 5.58% above (${READ19})`,
      },
      {
        url: "https://www.kslegislature.gov/li/b2025_26/statute/079_000_0000_chapter/079_032_0000_article/079_032_0119_section/079_032_0119_k/",
        note: `K.S.A. 79-32,119: standard deduction $3,605 / $8,240; 65+ addition (${READ19})`,
      },
      {
        url: "https://www.kslegislature.gov/li/b2025_26/statute/079_000_0000_chapter/079_032_0000_article/079_032_0121_section/079_032_0121_k/",
        note: `K.S.A. 79-32,121: exemptions $9,160 / $18,320, $2,320 per dependent (${READ19})`,
      },
      {
        url: "https://www.ksrevenue.gov/taxnotices/notice26-11.pdf",
        note: `Notice 26-11: no revenue-trigger rate cut for 2026 or 2027 (archived copy of the official PDF, ${READ19}); Social Security exempt from 2024 (K.S.A. 79-32,117(c)(xviii))`,
      },
    ],
  },
  FLAT(
    "KY",
    "Kentucky",
    0.035,
    [
      {
        url: "https://revenue.ky.gov/News/Pages/Kentucky-DOR-Announces-2026-Standard-Deduction.aspx",
        note: `2026 standard deduction $3,360 (${READ})`,
      },
      {
        url: "https://revenue.ky.gov/Forms/42A804%20(K-4)%20(2026).pdf",
        note: `2026 K-4: flat 3.5% rate (${READ})`,
      },
      {
        url: "https://revenue.ky.gov/Forms/740%20Packet%20Instructions.pdf",
        note: `Form 740 instructions, Schedule M: $31,110 pension/IRA exclusion per taxpayer, no age test (statutory) (${READ19})`,
      },
    ],
    {
      // One standard deduction per joint return (Form 740 instructions, line 10).
      standardDeduction: { single: 3_360, mfj: 3_360 },
      retirementExclusion: [{ amount: 31_110, minAge: 0 }],
    },
  ),
  FLAT(
    "LA",
    "Louisiana",
    0.03,
    [
      {
        url: "https://dam.ldr.la.gov/lawspolicies/RIB-25-012-Louisiana-Individual-Income-Tax-Reform-1.pdf",
        note: `RIB 25-012: flat 3% from 2025; personal and dependent exemptions repealed (${READ19})`,
      },
      {
        url: "https://dam.ldr.la.gov/lawspolicies/RIB%2026-005-Updated%20Withholding%20Tables.pdf",
        note: `RIB 26-005: provisional 2026 standard deduction $12,875 / $25,750 (may change with final CPI) (${READ19})`,
      },
      {
        url: "https://dam.ldr.la.gov/lawspolicies/NOI-1311.pdf",
        note: `Louisiana Register, notice of intent LAC 61:I.1311: retirement income exclusion $12,324 per person 65+ for 2026 ($12,000 in 2025, indexed) (${READ19})`,
      },
    ],
    {
      standardDeduction: { single: 12_875, mfj: 25_750 },
      retirementExclusion: [{ amount: 12_324, minAge: 65 }],
      unconfirmed:
        "the final 2026 standard deduction (the Department's provisional $12,875 / $25,750 is used)",
    },
  ),
  {
    code: "ME",
    name: "Maine",
    kind: "brackets",
    single: [
      [0, 0.058],
      [27_400, 0.0675],
      [64_850, 0.0715],
      [1_000_000, 0.0915],
    ],
    mfj: [
      [0, 0.058],
      [54_850, 0.0675],
      [129_750, 0.0715],
      [1_500_000, 0.0915],
    ],
    standardDeduction: { single: 15_700, mfj: 31_400 },
    aged: [{ single: 2_050, married: 1_650 }],
    exemption: { single: 5_300, mfj: 10_600, dependent: 0 },
    // Pension income deduction: $49,824 per person for 2026 at any age, covering pensions,
    // workplace plans and IRAs, less Social Security received; phased out above federal AGI.
    retirementExclusion: [{ amount: 49_824, minAge: 0 }],
    retirementExclusionLessSocialSecurity: true,
    retirementExclusionIncomeTest: {
      phaseOut: {
        start: { single: 125_000, mfj: 250_000 },
        width: { single: 100_000, mfj: 100_000 },
      },
    },
    approx:
      "the 2% surcharge from 2026 is folded into the top bracket; the dependent credit and the standard deduction phase-out are not modelled",
    unconfirmed:
      "the 2026 thresholds of the pension deduction phase-out (the 2025 thresholds, $125,000 / $250,000 over $100,000, are used)",
    sources: [
      {
        url: "https://www.maine.gov/revenue/sites/maine.gov.revenue/files/2026-05/ind_tax_rate_sched_2026_rev.pdf",
        note: `2026 rate schedules (revised 20 May 2026): brackets, 2% surcharge above $1m single / $1.5m joint, personal exemption $5,300, standard deduction $15,700 / $31,400 (${READ})`,
      },
      {
        url: "https://www.maine.gov/revenue/sites/maine.gov.revenue/files/inline-files/26_1040es_fillable.pdf",
        note: `2026 Form 1040ES-ME instructions, worksheet line 2: pension deduction $49,824 per person (${READ19})`,
      },
      {
        url: "https://www.maine.gov/revenue/faq/individual-income-tax",
        note: `FAQ 14-15: pension deduction covers pensions, 401(k)/403(b)/457 and IRAs, reduced by Social Security; Social Security exempt (${READ19})`,
      },
    ],
  },
  {
    code: "MD",
    name: "Maryland",
    kind: "brackets",
    single: [
      [0, 0.02],
      [1_000, 0.03],
      [2_000, 0.04],
      [3_000, 0.0475],
      [100_000, 0.05],
      [125_000, 0.0525],
      [150_000, 0.055],
      [250_000, 0.0575],
      [500_000, 0.0625],
      [1_000_000, 0.065],
    ],
    mfj: [
      [0, 0.02],
      [1_000, 0.03],
      [2_000, 0.04],
      [3_000, 0.0475],
      [150_000, 0.05],
      [175_000, 0.0525],
      [225_000, 0.055],
      [300_000, 0.0575],
      [600_000, 0.0625],
      [1_200_000, 0.065],
    ],
    standardDeduction: { single: 3_350, mfj: 6_700 },
    // $1,000 more exemption for each filer 65+.
    aged: [{ single: 1_000, married: 1_000 }],
    exemption: { single: 3_200, mfj: 6_400, dependent: 3_200 },
    // Pension exclusion: $40,600 per person 65+ for 2026, employer plans only (no IRAs), less
    // Social Security received.
    retirementExclusion: [{ amount: 40_600, minAge: 65 }],
    retirementExclusionAppliesTo: "employer",
    retirementExclusionLessSocialSecurity: true,
    approx:
      "county income tax (2.25%-3.3%) not included (use the local rate option); the exemption phase-out above $100,000 and the 2% surtax on capital gains above $350,000 of AGI are not modelled",
    sources: [
      {
        url: "https://www.marylandcomptroller.gov/content/dam/mdcomp/tax/forms/worksheets/2026-pv-worksheet.pdf",
        note: `2026 payment voucher worksheet: rate schedules, standard deduction $3,350 / $6,700, exemption $3,200 (${READ})`,
      },
      {
        url: "https://services.marylandcomptroller.gov/taxes/en/maryland-pension-exclusion?id=kb_article_view&sysparm_article=KB0010012",
        note: `Maximum pension exclusion $40,600 for 2026 (${READ19})`,
      },
      {
        url: "https://www.marylandcomptroller.gov/content/dam/mdcomp/tax/instructions/2025/resident-booklet.pdf",
        note: `Instruction 13 and Worksheet 13A: 65+, employer plans only, reduced by Social Security; $1,000 extra exemption at 65 (${READ19})`,
      },
    ],
  },
  {
    code: "MA",
    name: "Massachusetts",
    kind: "brackets",
    single: [
      [0, 0.05],
      [1_107_750, 0.09],
    ],
    mfjFactor: 1,
    exemption: { single: 4_400, mfj: 8_800, dependent: 1_000 },
    // $700 more exemption for each filer 65+.
    aged: [{ single: 700, married: 700 }],
    approx:
      "short-term gains (8.5%) taxed at 5%; government pensions exempt in Massachusetts are taxed (private pensions and IRAs are taxable)",
    sources: [
      {
        url: "https://www.mass.gov/info-details/massachusetts-tax-rates",
        note: `5.00%; 4% surtax on income over $1,107,750 for tax year 2026; short-term gains 8.5% (${READ})`,
      },
      {
        url: "https://www.mass.gov/info-details/massachusetts-personal-income-tax-exemptions",
        note: `Personal exemption $4,400 / $8,800; $1,000 per dependent (${READ})`,
      },
    ],
  },
  FLAT(
    "MI",
    "Michigan",
    0.0425,
    [
      {
        url: "https://www.michigan.gov/taxes/-/media/Project/Websites/taxes/Forms/SUW/TY2026/446_Withholding-Guide_2026.pdf",
        note: `Form 446 (2026): 4.25%; exemption $5,900; retirement deduction up to $67,610 single / $135,220 joint (${READ19})`,
      },
      {
        url: "https://www.michigan.gov/taxes/iit/tax-guidance/tax-situations/retirement-and-pension-benefits",
        note: `Retirement deduction phase-in complete in 2026 for everyone; Social Security exempt (${READ19})`,
      },
    ],
    {
      exemption: { single: 5_900, mfj: 11_800, dependent: 5_900 },
      // 2026: pensions, IRA and most workplace-plan distributions deductible up to a per-return limit.
      retirementExclusion: [{ amount: ALL, minAge: 0 }],
      retirementExclusionPerReturn: { single: 67_610, mfj: 135_220 },
      approx:
        "457 plan payments, 401(k) payments from employee contributions alone and premature distributions, which do not qualify for the retirement deduction, are treated as qualifying",
    },
  ),
  {
    code: "MN",
    name: "Minnesota",
    kind: "brackets",
    single: [
      [0, 0.0535],
      [33_310, 0.068],
      [109_430, 0.0785],
      [203_150, 0.0985],
    ],
    mfj: [
      [0, 0.0535],
      [48_700, 0.068],
      [193_480, 0.0785],
      [337_930, 0.0985],
    ],
    standardDeduction: { single: 15_300, mfj: 30_600 },
    aged: [{ single: 2_000, married: 1_600 }],
    exemption: { single: 0, mfj: 0, dependent: 5_300 },
    taxesSocialSecurity: true,
    // Simplified subtraction: all taxable SS, less 10% per $4,000 (or part) of AGI above
    // $86,410 single / $110,780 joint (2026).
    socialSecurity: {
      agiLimit: { single: 86_410, mfj: 110_780 },
      phaseOut: { width: { single: 40_000, mfj: 40_000 }, step: 4_000 },
      indexed: true,
    },
    approx:
      "only the simplified Social Security subtraction is modelled (the alternate subtraction, which can be larger at higher incomes, is not)",
    sources: [
      {
        url: "https://www.revenue.state.mn.us/sites/default/files/2025-12/inflation-adjusted-amounts-2026.pdf",
        note: `Tax year 2026 inflation-adjusted amounts: bracket thresholds, standard deduction $15,300 / $30,600, dependent exemption $5,300, Social Security subtraction thresholds $86,410 / $110,780 (${READ19})`,
      },
      {
        url: "https://www.revisor.mn.gov/statutes/cite/290.0132",
        note: `Minn. Stat. 290.0132 subd. 26: Social Security subtraction reduced 10% per $4,000 of AGI over the threshold (${READ19})`,
      },
      {
        url: "https://www.revenue.state.mn.us/sites/default/files/2026-10/tax-year-2026-tax-professional-desk-reference-chart-final.pdf",
        note: `2026 brackets at 5.35% / 6.8% / 7.85% / 9.85% (${READ})`,
      },
    ],
  },
  FLAT(
    "MS",
    "Mississippi",
    0.04,
    [
      {
        url: "https://www.dor.ms.gov/sites/default/files/tax-forms/business/89700251revised1.13.2026.pdf",
        note: `Pub 89-700: tax year 2026, 0% on the first $10,000 and 4.0% above; exemptions $6,000 / $12,000 / $1,500 per dependent; standard deduction $2,300 / $4,600 (${READ})`,
      },
      {
        url: "https://www.dor.ms.gov/general-information",
        note: `Tax year 2026: excess of $10,000 taxed at 4%; $1,500 extra exemption at 65 (${READ})`,
      },
      {
        url: "https://www.dor.ms.gov/individual/individual-income-tax-frequently-asked-questions",
        note: `Joint filers: the first $10,000 of each taxpayer's taxable income is exempt; qualified retirement income and Social Security exempt (${READ19})`,
      },
    ],
    {
      single: [
        [0, 0],
        [10_000, 0.04],
      ],
      // The first $10,000 of each spouse's taxable income is exempt (DOR FAQ).
      mfj: [
        [0, 0],
        [20_000, 0.04],
      ],
      standardDeduction: { single: 2_300, mfj: 4_600 },
      // $1,500 more exemption for each filer 65+.
      aged: [{ single: 1_500, married: 1_500 }],
      exemption: { single: 6_000, mfj: 12_000, dependent: 1_500 },
      retirementExclusion: [{ amount: ALL, minAge: 0 }],
      approx:
        "on a joint return the 0% band is $20,000 (each spouse's first $10,000), assuming each spouse has at least $10,000 of taxable income; early retirement-plan distributions, which are taxable, are treated as exempt",
    },
  ),
  {
    code: "MO",
    name: "Missouri",
    kind: "brackets",
    single: [
      [0, 0],
      [1_348, 0.02],
      [2_696, 0.025],
      [4_044, 0.03],
      [5_392, 0.035],
      [6_740, 0.04],
      [8_088, 0.045],
      [9_436, 0.047],
    ],
    mfjFactor: 1,
    standardDeduction: { single: 16_100, mfj: 32_200 },
    capitalGains: "exempt",
    // RSMo 143.171.2: a share of federal income tax after credits by Missouri income, at most
    // $5,000 ($10,000 on a combined return); statutory, not indexed.
    federalTaxDeduction: {
      share: {
        single: [
          [0, 0.35],
          [25_000, 0.25],
          [50_000, 0.15],
          [100_000, 0.05],
          [125_000, 0],
        ],
        mfj: [
          [0, 0.35],
          [25_000, 0.25],
          [50_000, 0.15],
          [100_000, 0.05],
          [125_000, 0],
        ],
      },
      cap: { single: 5_000, mfj: 10_000 },
    },
    approx:
      "on a combined return each spouse's share of income goes through the rate chart separately (overstated by up to about $180 here); Social Security is exempt from 62 but modelled as exempt at any age; the public pension exclusion, the income-tested $6,000 private pension exclusion and the 65+ addition to the standard deduction are not modelled",
    sources: [
      {
        url: "https://dor.mo.gov/forms/MO-1040ES_2026.pdf",
        note: `2026 MO-1040ES: tax rate table and standard deduction $16,100 / $32,200 (${READ})`,
      },
      {
        url: "https://revisor.mo.gov/main/OneSection.aspx?section=143.121",
        note: `143.121.3(14) RSMo: 100% capital gains subtraction from tax year 2025 (${READ19})`,
      },
      {
        url: "https://revisor.mo.gov/main/OneSection.aspx?section=143.171",
        note: `143.171.2 RSMo: federal income tax deduction, 35% / 25% / 15% / 5% / 0% by Missouri gross income ($25,000, $50,000, $100,000, $125,000 steps), at most $5,000 / $10,000 (${READ19})`,
      },
      {
        url: "https://dor.mo.gov/forms/MO-A_2025.pdf",
        note: `Form MO-A: Social Security exempt from 62; public and private pension exemptions (${READ19})`,
      },
    ],
  },
  {
    code: "MT",
    name: "Montana",
    kind: "brackets",
    single: [
      [0, 0.047],
      [47_500, 0.0565],
    ],
    mfjFactor: 2,
    standardDeduction: { single: 16_100, mfj: 32_200 },
    federalDeduction: "taxable-income",
    taxesSocialSecurity: true,
    approx:
      "the capital gains rates (3% / 4.1%) and the subtraction for taxpayers 65+ ($5,660 each in 2025, indexed) are not modelled",
    unconfirmed: "the 2026 senior subtraction (not yet published; not modelled)",
    sources: [
      {
        url: "https://revenue.mt.gov/news/recent-news/HB-337",
        note: `HB 337: tax year 2026, 4.7% to $47,500 ($95,000 joint) and 5.65% above; capital gains 3.0% / 4.1% (${READ})`,
      },
      {
        url: "https://revenue.mt.gov/files/forms/Montana-Individual-Income-Tax-Return-Form-2-Instructions/2025_Montana_Individual_Income_Tax_Return_Form_2_Instructions.pdf",
        note: `Form 2 instructions: Montana starts from federal taxable income (federal deductions incl. the senior deduction); Social Security taxed as federally (${READ19})`,
      },
    ],
  },
  {
    code: "NE",
    name: "Nebraska",
    kind: "brackets",
    single: [
      [0, 0.0246],
      [4_130, 0.0351],
      [24_760, 0.0455],
    ],
    mfj: [
      [0, 0.0246],
      [8_250, 0.0351],
      [49_530, 0.0455],
    ],
    standardDeduction: { single: 8_850, mfj: 17_700 },
    exemption: { single: 176, mfj: 352, dependent: 176, credit: true },
    approx:
      "the addition to the standard deduction for filers 65+ ($2,000 / $1,650 in 2025; 2026 not yet published) is not modelled",
    sources: [
      {
        url: "https://revenue.nebraska.gov/sites/default/files/doc/research/chronology/4-607table1.pdf",
        note: `Tax rate chronology (rev. 2-2026): from 1 Jan 2026 rates 2.46% / 3.51% / 4.55%, brackets by filing status, personal exemption credit $176, standard deduction $8,850 / $17,700 (${READ})`,
      },
    ],
  },
  NONE("NV", "Nevada", [
    {
      url: "https://tax.nv.gov/about-nevada-department-of-taxation/income-tax-in-nevada/",
      note: `Nevada does not impose a state income tax on individuals (${READ})`,
    },
  ]),
  NONE("NH", "New Hampshire", [
    {
      url: "https://www.revenue.nh.gov/taxes-glance/interest-dividends-tax",
      note: `Interest and dividends tax repealed for taxable periods beginning after 31 Dec 2024 (archived copy, ${READ19})`,
    },
  ]),
  {
    code: "NJ",
    name: "New Jersey",
    kind: "brackets",
    single: [
      [0, 0.014],
      [20_000, 0.0175],
      [35_000, 0.035],
      [40_000, 0.05525],
      [75_000, 0.0637],
      [500_000, 0.0897],
      [1_000_000, 0.1075],
    ],
    mfj: [
      [0, 0.014],
      [20_000, 0.0175],
      [50_000, 0.0245],
      [70_000, 0.035],
      [80_000, 0.05525],
      [150_000, 0.0637],
      [500_000, 0.0897],
      [1_000_000, 0.1075],
    ],
    exemption: { single: 1_000, mfj: 2_000, dependent: 1_500 },
    // $1,000 more exemption for each filer 65+.
    aged: [{ single: 1_000, married: 1_000 }],
    // Pension exclusion from 62: pensions, annuities and IRA withdrawals up to $75,000 single /
    // $100,000 joint per return; full to $100,000 of income, then 37.5% / 50% to $125,000 and
    // 18.75% / 25% to $150,000; none above (statutory).
    retirementExclusion: [{ amount: ALL, minAge: 62 }],
    retirementExclusionPerReturn: { single: 75_000, mfj: 100_000 },
    retirementExclusionIncomeTest: {
      steps: {
        single: [
          [100_000, 0.375],
          [125_000, 0.1875],
          [150_000, 0],
        ],
        mfj: [
          [100_000, 0.5],
          [125_000, 0.25],
          [150_000, 0],
        ],
      },
    },
    approx:
      "the income test uses federal AGI for NJ gross income; above $100,000 the percentages are applied to the excludable amount rather than to all pension income; the other retirement income exclusion is not modelled",
    sources: [
      {
        url: "https://www.nj.gov/treasury/taxation/pdf/current/1040esi.pdf",
        note: `2026 NJ-1040-ES: Tables A and B; exemptions $1,000 each, $1,500 per dependent; pension exclusion at 62 with income up to $150,000 (${READ})`,
      },
      {
        url: "https://www.nj.gov/treasury/taxation/pdf/current/1040i.pdf",
        note: `NJ-1040 instructions, line 28a: pension exclusion caps and income percentages; Social Security exempt; $1,000 extra exemption at 65 (${READ19})`,
      },
    ],
  },
  {
    code: "NM",
    name: "New Mexico",
    kind: "brackets",
    single: [
      [0, 0.015],
      [5_500, 0.032],
      [16_500, 0.043],
      [33_500, 0.047],
      [66_500, 0.049],
      [210_000, 0.059],
    ],
    mfj: [
      [0, 0.015],
      [8_000, 0.032],
      [25_000, 0.043],
      [50_000, 0.047],
      [100_000, 0.049],
      [315_000, 0.059],
    ],
    standardDeduction: { single: 16_100, mfj: 32_200 },
    federalDeduction: "standard",
    // $4,000 for each dependent after the first, joint and head-of-household returns only.
    exemption: { single: 0, mfj: 0, dependent: 4_000, dependentsAfterFirstJointOnly: true },
    taxesSocialSecurity: true,
    // All Social Security exempt while federal AGI is at most $100,000 single / $150,000 joint
    // (a cliff: none exempt above).
    socialSecurity: { agiLimit: { single: 100_000, mfj: 150_000 } },
    approx:
      "brackets from the 2025 tax rate table (statutory, not indexed); the income-tested $8,000 exemption for people 65+ and the low- and middle-income exemption are not modelled",
    sources: [
      {
        url: "https://realfile.tax.newmexico.gov/2025trt.pdf",
        note: `2025 PIT-1 tax rate table (latest published; the brackets are statutory): 4.9% to $210,000 single / $315,000 joint, 5.9% above (${READ})`,
      },
      {
        url: "https://realfile.tax.newmexico.gov/2025pit-adj-ins.pdf",
        note: `PIT-ADJ line 25: Social Security exempt at federal AGI up to $100,000 single / $150,000 joint (${READ19})`,
      },
      {
        url: "https://realfile.tax.newmexico.gov/2025pit-1-ins.pdf",
        note: `PIT-1 lines 12-13: federal standard deduction; $4,000 per dependent after the first (joint / head of household) (${READ19})`,
      },
    ],
  },
  {
    code: "NY",
    name: "New York",
    kind: "brackets",
    single: [
      [0, 0.039],
      [8_500, 0.044],
      [11_700, 0.0515],
      [13_900, 0.054],
      [80_650, 0.059],
      [215_400, 0.0685],
      [1_077_550, 0.0965],
      [5_000_000, 0.103],
      [25_000_000, 0.109],
    ],
    mfj: [
      [0, 0.039],
      [17_150, 0.044],
      [23_600, 0.0515],
      [27_900, 0.054],
      [161_550, 0.059],
      [323_200, 0.0685],
      [2_155_350, 0.0965],
      [5_000_000, 0.103],
      [25_000_000, 0.109],
    ],
    standardDeduction: { single: 8_000, mfj: 16_050 },
    exemption: { single: 0, mfj: 0, dependent: 1_000 },
    retirementExclusion: [{ amount: 20_000, minAge: 59.5 }],
    approx: "benefit recapture for high incomes not modelled",
    sources: [
      {
        url: "https://www.tax.ny.gov/pdf/2026/inc/it2105i_2026.pdf",
        note: `IT-2105-I (2026): New York State and City rate schedules, standard deduction $8,000 / $16,050, $1,000 per dependent (${READ})`,
      },
      {
        url: "https://www.tax.ny.gov/pit/file/information_for_seniors.htm",
        note: `Pension and annuity exclusion up to $20,000 from 59 1/2 (${READ})`,
      },
    ],
  },
  FLAT(
    "NC",
    "North Carolina",
    0.0399,
    [
      {
        url: "https://www.ncdor.gov/taxes-forms/individual-income-tax/tax-rate-schedules",
        note: `Taxable years after 2025: 3.99% (${READ})`,
      },
      {
        url: "https://www.ncdor.gov/taxes-forms/individual-income-tax/filing-topics/north-carolina-standard-deduction-or-north-carolina-itemized-deductions",
        note: `Standard deduction $12,750 / $25,500 (${READ})`,
      },
    ],
    { standardDeduction: { single: 12_750, mfj: 25_500 } },
  ),
  {
    code: "ND",
    name: "North Dakota",
    kind: "brackets",
    single: [
      [0, 0],
      [49_575, 0.0195],
      [250_400, 0.025],
    ],
    mfj: [
      [0, 0],
      [82_800, 0.0195],
      [304_850, 0.025],
    ],
    standardDeduction: { single: 16_100, mfj: 32_200 },
    federalDeduction: "taxable-income",
    sources: [
      {
        url: "https://www.tax.nd.gov/sites/www/files/documents/forms/individual/2025-iit/28709-form-nd-1es-2026.pdf",
        note: `2026 Form ND-1ES rate schedules; starts from federal taxable income (${READ})`,
      },
    ],
  },
  FLAT(
    "OH",
    "Ohio",
    0.0275,
    [
      {
        url: "https://tax.ohio.gov/individual/who-must-file/whats-new",
        note: `2026 brackets (R.C. 5747.02(A)(3)): 0% to $26,050, then $332 plus 2.75% of the excess (${READ19})`,
      },
      {
        url: "https://dam.assets.ohio.gov/image/upload/v1767095693/tax.ohio.gov/forms/ohio_individual/individual/2025/it1040-booklet.pdf",
        note: `2025 booklet: exemption $2,400 / $2,150 / $1,900 by modified AGI; Social Security exempt (${READ19})`,
      },
      {
        url: "https://dam.assets.ohio.gov/image/upload/v1768492829/tax.ohio.gov/forms/ohio_individual/individual/2026/ites-oupc.pdf",
        note: `2026 estimate worksheet: no exemption at $500,000 of income or more (${READ19})`,
      },
    ],
    {
      single: [
        [0, 0],
        [26_050, 0.0275],
      ],
      mfj: [
        [0, 0],
        [26_050, 0.0275],
      ],
      stepTax: { threshold: 26_050, amount: 332 },
      exemption: {
        single: 2_400,
        mfj: 4_800,
        dependent: 2_400,
        byAgi: [
          [40_000, 2_150],
          [80_000, 1_900],
          [500_000, 0],
        ],
      },
      approx:
        "the retirement income credit (up to $200) and the senior citizen credit ($50) are not modelled",
      unconfirmed:
        "the 2026 personal exemption amounts (the 2025 amounts by income are used; the Revised Code could not be reached)",
    },
  ),
  {
    code: "OK",
    name: "Oklahoma",
    kind: "brackets",
    single: [
      [0, 0],
      [3_750, 0.025],
      [4_900, 0.035],
      [7_200, 0.045],
    ],
    mfjFactor: 2,
    standardDeduction: { single: 6_350, mfj: 12_700 },
    exemption: { single: 1_000, mfj: 2_000, dependent: 1_000 },
    retirementExclusion: [{ amount: 10_000, minAge: 0 }],
    sources: [
      {
        url: "https://oklahoma.gov/content/dam/ok/en/tax/documents/forms/individuals/current/511-Pkt.pdf",
        note: `Form 511 packet: standard deduction $6,350 / $12,700, $1,000 exemptions, $10,000 retirement exclusion per person (Schedule 511-A) (${READ19})`,
      },
      {
        url: "https://oklahoma.gov/content/dam/ok/en/tax/documents/resources/publications/legislation/2025LegislativeUpdate.pdf",
        note: `HB 2764: brackets for tax year 2026 (joint brackets double the single ones) (${READ})`,
      },
    ],
  },
  {
    code: "OR",
    name: "Oregon",
    kind: "brackets",
    single: [
      [0, 0.0475],
      [4_550, 0.0675],
      [11_400, 0.0875],
      [125_000, 0.099],
    ],
    mfjFactor: 2,
    standardDeduction: { single: 2_910, mfj: 5_820 },
    exemption: {
      single: 263,
      mfj: 526,
      dependent: 263,
      credit: true,
      zeroAboveAgi: { single: 100_000, mfj: 200_000 },
    },
    approx:
      "the federal tax subtraction (up to $8,750), the 65+ addition to the standard deduction and the retirement income credit are not modelled",
    sources: [
      {
        url: "https://www.oregon.gov/dor/forms/FormsPubs/withholding-tax-formulas_206-436_2026.pdf",
        note: `2026 withholding formulas: standard deduction $2,910 / $5,820, exemption credit $263 (2026 indexed amounts) (${READ19})`,
      },
      {
        url: "https://www.oregon.gov/dor/forms/FormsPubs/publication-or-estimate_101-026_2026.pdf",
        note: `2026 Publication OR-ESTIMATE: rate charts S and J, estimated standard deduction $2,900 / $5,800, personal exemption credit $260 (${READ})`,
      },
    ],
  },
  FLAT(
    "PA",
    "Pennsylvania",
    0.0307,
    [
      {
        url: "https://www.pa.gov/agencies/revenue/resources/tax-rates",
        note: `Personal income tax 3.07 percent (${READ})`,
      },
      {
        url: "https://www.pa.gov/content/dam/copapwp-pagov/en/revenue/documents/formsandpublications/formsforindividuals/pit/documents/2025/2025_pa-40in.pdf",
        note: `IRA and retirement distributions on or after 59 1/2 are not taxable (${READ})`,
      },
    ],
    { retirementExclusion: [{ amount: ALL, minAge: 59.5 }] },
  ),
  {
    code: "RI",
    name: "Rhode Island",
    kind: "brackets",
    single: [
      [0, 0.0375],
      [82_050, 0.0475],
      [186_450, 0.0599],
    ],
    mfjFactor: 1,
    standardDeduction: { single: 11_200, mfj: 22_400 },
    exemption: { single: 5_250, mfj: 10_500, dependent: 5_250 },
    taxesSocialSecurity: true,
    // Social Security and up to $50,000 per person of pensions and workplace plans (not IRAs) are
    // exempt from full retirement age (taken here as 67) while federal AGI is below the limit (a
    // cliff). 2025 limits; indexed.
    socialSecurity: { agiLimit: { single: 107_000, mfj: 133_750 }, minAge: 67, indexed: true },
    retirementExclusion: [{ amount: 50_000, minAge: 67 }],
    retirementExclusionAppliesTo: "employer",
    retirementExclusionIncomeTest: {
      steps: { single: [[107_000, 0]], mfj: [[133_750, 0]] },
      indexed: true,
    },
    approx:
      "full retirement age is taken as 67 for everyone; the exemption and standard deduction phase-out above $261,000 of income is not modelled",
    unconfirmed:
      "the 2026 income limits of the Social Security and pension modifications (2025 limits $107,000 / $133,750 used; the Division's retirement guide gives $133,500 joint)",
    sources: [
      {
        url: "https://tax.ri.gov/sites/g/files/xkgbur541/files/2025-11/ADV_2025_22_Inflation_Adjustments.pdf",
        note: `ADV 2025-22: 2026 rate schedule, standard deduction $11,200 / $22,400, exemption $5,250; 2025 modification limits (archived copy, ${READ19})`,
      },
      {
        url: "https://tax.ri.gov/sites/g/files/xkgbur541/files/2026-02/PUB_2026-01_Retirement_Income_Guide.pdf",
        note: `PUB 2026-01: pension modification up to $50,000 per person (not IRAs), full retirement age and income test (archived copy, ${READ19})`,
      },
    ],
  },
  {
    code: "SC",
    name: "South Carolina",
    kind: "brackets",
    single: [
      [0, 0.0199],
      [30_000, 0.0521],
    ],
    mfjFactor: 1,
    standardDeduction: { single: 15_000, mfj: 30_000 },
    exemption: { single: 0, mfj: 0, dependent: 4_930 },
    retirementExclusion: [
      { amount: 3_000, minAge: 0 },
      { amount: 10_000, minAge: 65 },
    ],
    // Age 65 deduction: $15,000 per person against any income, less the retirement deduction.
    ageDeduction: { amount: 15_000, minAge: 65, lessRetirementExclusion: true },
    approx:
      "the South Carolina Income Adjusted Deduction is shown at its maximum (it phases out between AGI $40,000 and $95,000 single, $80,000 and $190,000 joint)",
    unconfirmed: "the 2026 dependent exemption (the 2025 amount, $4,930, is used)",
    sources: [
      {
        url: "https://dor.sc.gov/iit",
        note: `Tax year 2026: 1.99% below $30,000; 5.21% minus $966 from $30,000 (${READ})`,
      },
      {
        url: "https://dor.sc.gov/sites/dor/files/policies/IL26-23.pdf",
        note: `Information Letter 26-23 (Act 110 of 2026): federal AGI is the starting point; SC Income Adjusted Deduction $15,000 single / $30,000 joint with its phase-out (${READ})`,
      },
      {
        url: "https://dor.sc.gov/sites/dor/files/forms/SC1040Instr_2025.pdf",
        note: `SC1040 instructions: retirement deduction $3,000 / $10,000 from 65; age 65 deduction $15,000 less retirement deductions; dependent exemption $4,930 (2025) (${READ19})`,
      },
    ],
  },
  NONE("SD", "South Dakota", [
    {
      url: "https://dor.sd.gov/individuals/taxes/",
      note: `South Dakota does not impose a state income tax (${READ})`,
    },
  ]),
  NONE("TN", "Tennessee", [
    {
      url: "https://www.tn.gov/revenue/taxes/hall-income-tax.html",
      note: `Hall income tax repealed for tax periods beginning on or after 1 Jan 2021 (${READ})`,
    },
  ]),
  NONE("TX", "Texas", [
    {
      url: "https://comptroller.texas.gov/economy/fiscal-notes/industry/2025/small-biz-info/",
      note: `Texas Comptroller: Texas has no state income tax (${READ})`,
    },
  ]),
  FLAT(
    "UT",
    "Utah",
    0.0445,
    [
      {
        url: "https://le.utah.gov/xcode/title59/chapter10/C59-10-S104_2026050620260506.pdf",
        note: `Utah Code 59-10-104 (effective 1 Jan 2026, ch. 250 of 2026): 4.45% (${READ})`,
      },
      {
        url: "https://le.utah.gov/xcode/Title59/Chapter10/C59-10-S1042_2026010120250507.html",
        note: `Utah Code 59-10-1042: Social Security credit, phased out at 2.5 cents per dollar over $54,000 / $90,000 (${READ19})`,
      },
    ],
    {
      taxesSocialSecurity: true,
      // Social Security credit: 4.45% of the benefits taxed, less 2.5 cents per dollar of
      // modified AGI over $54,000 single / $90,000 joint, shown as the equivalent exemption.
      socialSecurity: {
        agiLimit: { single: 54_000, mfj: 90_000 },
        reductionPerDollar: 0.025 / 0.0445,
      },
      approx:
        "the taxpayer credit (6% of deductions, phased out) and the $450 retirement credit for people born before 1953 are not modelled; the Social Security credit uses federal AGI for modified AGI",
    },
  ),
  {
    code: "VT",
    name: "Vermont",
    kind: "brackets",
    single: [
      [0, 0.0335],
      [49_400, 0.066],
      [119_700, 0.076],
      [249_700, 0.0875],
    ],
    mfj: [
      [0, 0.0335],
      [82_500, 0.066],
      [199_450, 0.076],
      [304_000, 0.0875],
    ],
    standardDeduction: { single: 7_850, mfj: 15_700 },
    aged: [{ single: 1_300, married: 1_300 }],
    exemption: { single: 5_400, mfj: 10_800, dependent: 5_400 },
    taxesSocialSecurity: true,
    // Exempt at AGI up to $55,000 single / $70,000 joint, phased out over the next $10,000.
    socialSecurity: {
      agiLimit: { single: 55_000, mfj: 70_000 },
      phaseOut: { width: { single: 10_000, mfj: 10_000 } },
    },
    unconfirmed:
      "the 2026 bracket thresholds (not yet published; the 2025 schedules are used); the four rates are confirmed",
    sources: [
      {
        url: "https://tax.vermont.gov/sites/tax/files/documents/GB-1210-2026.pdf",
        note: `2026 withholding guide: rates 3.35% / 6.60% / 7.60% / 8.75% (${READ})`,
      },
      {
        url: "https://tax.vermont.gov/sites/tax/files/documents/2026%20Fall%20Symposium%20-%20All%20Slides%20w%20alt%20text.pdf",
        note: `Department's 2026 Fall Symposium (22 Oct 2026), Form IN-111: standard deduction $7,850 / $15,700, $1,300 per person 65+, exemption $5,400 (${READ19})`,
      },
      {
        url: "https://tax.vermont.gov/sites/tax/files/documents/IN-111-Instr-2025.pdf",
        note: `2025 IN-111 instructions: 2025 rate schedules X and Y-1 (used for 2026) (${READ19})`,
      },
      {
        url: "https://legislature.vermont.gov/statutes/section/32/151/05830e",
        note: `32 V.S.A. 5830e: Social Security exempt to $55,000 / $70,000 of AGI, phased out over $10,000 (${READ19})`,
      },
    ],
  },
  {
    code: "VA",
    name: "Virginia",
    kind: "brackets",
    single: [
      [0, 0.02],
      [3_000, 0.03],
      [5_000, 0.05],
      [17_000, 0.0575],
    ],
    mfjFactor: 1,
    standardDeduction: { single: 8_750, mfj: 17_500 },
    exemption: { single: 930, mfj: 1_860, dependent: 930 },
    // $800 more exemption for each filer 65+.
    aged: [{ single: 800, married: 800 }],
    // Age deduction $12,000 per person 65+, against any income, reduced $1 per $1 of federal AGI
    // less taxable Social Security over $50,000 single / $75,000 married.
    ageDeduction: { amount: 12_000, minAge: 65, agiReduction: { single: 50_000, mfj: 75_000 } },
    approx:
      "people born before 2 January 1939, whose age deduction has no income test, are not distinguished",
    sources: [
      {
        url: "https://www.tax.virginia.gov/sites/default/files/vatax-pdf/2025-760-instructions.pdf",
        note: `2025 Form 760 instructions: tax rate schedule (statutory), $930 exemptions, $12,000 age deduction (${READ})`,
      },
      {
        url: "https://www.tax.virginia.gov/news/new-virginia-tax-laws",
        note: `Standard deduction stays $8,750 / $17,500 for tax year 2026 (${READ})`,
      },
    ],
  },
  NONE(
    "WA",
    "Washington",
    [
      {
        url: "https://dor.wa.gov/taxes-rates/other-taxes/capital-gains-tax/do-you-owe-capital-gains-tax",
        note: `Capital gains standard deduction $290,000 for 2026 (${READ})`,
      },
      {
        url: "https://app.leg.wa.gov/RCW/default.aspx?cite=82.87.040",
        note: `RCW 82.87.040: 7%, plus 2.9% on Washington capital gains over $1,000,000 from 2025 (${READ})`,
      },
    ],
    {
      kind: "capital-gains-only",
      capitalGainsTax: {
        deduction: 290_000,
        brackets: [
          [0, 0.07],
          [1_000_000, 0.099],
        ],
      },
      approx:
        "long-term gains on real estate and retirement accounts are exempt; all long-term gains assumed in scope",
    },
  ),
  {
    code: "WV",
    name: "West Virginia",
    kind: "brackets",
    single: [
      [0, 0.0211],
      [10_000, 0.0281],
      [25_000, 0.0316],
      [40_000, 0.0422],
      [60_000, 0.0458],
    ],
    mfjFactor: 1,
    exemption: { single: 2_000, mfj: 4_000, dependent: 2_000 },
    // Senior deduction $8,000 per person 65+, against any income, less that person's Social
    // Security modification (Social Security is fully exempt from 2026).
    ageDeduction: { amount: 8_000, minAge: 65, lessExemptSocialSecurity: true },
    approx:
      "the $2,000 exclusion for WV public and federal civil service pensions and the military pension exemption are not modelled",
    sources: [
      {
        url: "https://tax.wv.gov/Individuals/Pages/PersonalIncomeTaxReductionBill.aspx",
        note: `SB 392 (signed 31 March 2026, retroactive to 1 Jan 2026): 2.11% / 2.81% / 3.16% / 4.22% / 4.58% (${READ})`,
      },
      {
        url: "https://tax.wv.gov/Documents/PIT/2025/it140.PersonalIncomeTaxFormsAndInstructions.2025.pdf",
        note: `IT-140 booklet: $2,000 exemptions; Schedule M senior deduction $8,000 from 65, less other modifications (${READ19})`,
      },
      {
        url: "https://tax.wv.gov/Individuals/SeniorCitizens/Pages/SeniorCitizenSocialSecurityModification.aspx",
        note: `Social Security 100% exempt from 2026 (${READ19})`,
      },
    ],
  },
  {
    code: "WI",
    name: "Wisconsin",
    kind: "brackets",
    single: [
      [0, 0.035],
      [15_110, 0.044],
      [51_950, 0.053],
      [332_720, 0.0765],
    ],
    mfj: [
      [0, 0.035],
      [20_150, 0.044],
      [69_260, 0.053],
      [443_630, 0.0765],
    ],
    standardDeduction: { single: 13_960, mfj: 25_840 },
    // $250 more exemption for each filer 65+.
    aged: [{ single: 250, married: 250 }],
    exemption: { single: 700, mfj: 1_400, dependent: 700 },
    // Retirement income subtraction from 2025: up to $24,000 per person aged 67+ (pensions and IRAs).
    retirementExclusion: [{ amount: 24_000, minAge: 67 }],
    approx:
      "sliding-scale standard deduction shown at its maximum (it phases out to nothing at $136,453 single / $159,690 joint); claiming the retirement subtraction forfeits most credits, which are not modelled anyway",
    sources: [
      {
        url: "https://www.revenue.wi.gov/TaxForms2026/2026-Form1-ES-Inst.pdf",
        note: `2026 Form 1-ES instructions: Schedules A and B, standard deduction maximum $13,960 / $25,840, $700 exemption (${READ19})`,
      },
      {
        url: "https://www.revenue.wi.gov/TaxForms2025/2025-ScheduleSB-Inst.pdf",
        note: `Schedule SB instructions: retirement income subtraction up to $24,000 per person 67+; Social Security exempt; $250 exemption at 65 (${READ19})`,
      },
    ],
  },
  NONE("WY", "Wyoming", [
    {
      url: "https://governor.wyo.gov/news-releases/governor-gordon-urges-property-tax-refund-program-applications",
      note: `Governor's office (27 April 2026): Wyoming does not collect a personal income tax (${READ})`,
    },
  ]),
  {
    code: "DC",
    name: "District of Columbia",
    kind: "brackets",
    single: [
      [0, 0.04],
      [10_000, 0.06],
      [40_000, 0.065],
      [60_000, 0.085],
      [250_000, 0.0925],
      [500_000, 0.0975],
      [1_000_000, 0.1075],
    ],
    mfjFactor: 1,
    standardDeduction: { single: 16_100, mfj: 32_200 },
    federalDeduction: "standard",
    sources: [
      {
        url: "https://otr.cfo.dc.gov/sites/default/files/dc/sites/otr/publication/attachments/2026_D40ES_Book_wLinks04012026.pdf",
        note: `2026 D-40ES: tax rate table and standard deduction $16,100 / $32,200 (${READ})`,
      },
    ],
  },
];

export const US_STATE_BY_CODE: Record<string, StateRow> = Object.fromEntries(
  US_STATES_2026.map((s) => [s.code, s]),
);

/**
 * Local income taxes on residents (2026). Rates on wages/earned income unless `onTaxable`.
 * Each row cites the city's or state's official page (read 2026-11-16). Newark's 1% payroll tax is
 * levied on employers, so residents owe nothing.
 */
export interface LocalRow {
  code: string;
  name: string;
  state: string;
  /**
   * Base: 'state-taxable' (NYC uses NY taxable income), 'earned' (wages + SE) or
   * 'earned-and-investment' (also interest, dividends, gains and rent; Detroit).
   */
  base: "state-taxable" | "earned" | "earned-and-investment";
  single: [number, number][];
  mfj?: [number, number][];
  /** Personal exemption deducted from the base (Detroit). */
  exemption?: number;
  source: string;
  /** What the source confirms, and the date read. */
  sourceNote: string;
  /** Figures that could not be confirmed from an official source. */
  unconfirmed?: string;
}

export const US_LOCALS_2026: LocalRow[] = [
  {
    code: "nyc",
    name: "New York City",
    state: "NY",
    base: "state-taxable",
    single: [
      [0, 0.03078],
      [12_000, 0.03762],
      [25_000, 0.03819],
      [50_000, 0.03876],
    ],
    mfj: [
      [0, 0.03078],
      [21_600, 0.03762],
      [45_000, 0.03819],
      [90_000, 0.03876],
    ],
    source: "https://www.tax.ny.gov/pdf/2026/inc/it2105i_2026.pdf",
    sourceNote: `IT-2105-I (2026), New York City resident tax rate schedules (${READ})`,
  },
  {
    code: "philadelphia",
    name: "Philadelphia",
    state: "PA",
    base: "earned",
    // 3.74% to 30 June 2026 and 3.735% from 1 July 2026: (3.74% + 3.735%) / 2 for calendar 2026.
    single: [[0, 0.037375]],
    source:
      "https://www.phila.gov/services/payments-assistance-taxes/taxes/business-taxes/business-taxes-by-type/wage-tax-employers/",
    sourceNote: `Resident Wage Tax 3.74% from 1 July 2025 and 3.735% from 1 July 2026; the calendar-2026 average is applied (${READ})`,
  },
  {
    code: "wilmington",
    name: "Wilmington",
    state: "DE",
    base: "earned",
    single: [[0, 0.0125]],
    source: "https://www.wilmingtonde.gov/home/showpublisheddocument/462/638206223264700000",
    sourceNote: `City Earned Income Tax Regulations 201-202: 1.25% of residents' wages and net profits; pensions, Social Security and investment income not taxed (archived copy, ${READ19})`,
  },
  {
    code: "detroit",
    name: "Detroit",
    state: "MI",
    base: "earned-and-investment",
    single: [[0, 0.024]],
    exemption: 600,
    source:
      "https://detroitmi.gov/departments/office-chief-financial-officer/ocfo-divisions/office-treasury/income-tax/income-tax-information",
    sourceNote: `Resident individuals 2.4% from 2013; personal exemption $600 from tax year 2005; residents are taxed on wages, business income, interest, dividends, gains and rent, not on pensions or Social Security (${READ19})`,
  },
  {
    code: "newark",
    name: "Newark",
    state: "NJ",
    base: "earned",
    single: [[0, 0]],
    source: "https://www.newarknj.gov/647/Payroll-Tax",
    sourceNote: `1% payroll tax filed and paid by employers on wages for work in Newark; nothing on residents (archived copy, ${READ19})`,
  },
];

export const US_LOCAL_BY_CODE: Record<string, LocalRow> = Object.fromEntries(
  US_LOCALS_2026.map((l) => [l.code, l]),
);
