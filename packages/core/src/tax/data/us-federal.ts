/**
 * US federal tax data (tax year = calendar year). Nominal USD. Calculation: ../jurisdictions/us-*.ts.
 * Future years index these with the plan's price index (IRS indexes with chained CPI).
 */
import type { FilingStatus } from "../../schema/tax.js";

type ByStatus<T> = Record<FilingStatus, T>;

export interface UsFederalYear {
  year: number;
  /** Alias so pickYear works. */
  startYear: number;
  sources: { url: string; note?: string }[];
  /** [lower threshold of taxable income, rate]. */
  brackets: ByStatus<[number, number][]>;
  standardDeduction: ByStatus<number>;
  /** Additional standard deduction per person aged 65+ (or blind). */
  additionalAged: { married: number; unmarried: number };
  /** Max taxable income taxed at 0% / 15% for qualified dividends and LTCG. */
  capitalGains: ByStatus<{ zeroMax: number; fifteenMax: number }>;
  /** Personal exemption (0 under TCJA/OBBBA). */
  personalExemption: number;
  seniorDeduction?: {
    amount: number;
    phaseoutStart: ByStatus<number>;
    phaseoutRate: number;
    lastYear: number;
  };
  amt: {
    exemption: ByStatus<number>;
    phaseoutStart: ByStatus<number>;
    breakpoint28: ByStatus<number>;
  };
  childTaxCredit: { perChild: number; refundable: number; phaseoutStart: ByStatus<number> };
  qbi: { threshold: ByStatus<number>; phaseInRange: ByStatus<number> };
}

const RP_2025_32 = "https://www.irs.gov/pub/irs-drop/rp-25-32.pdf";
const IRB_2025_45 = "https://www.irs.gov/irb/2025-45_IRB";

const mfsHalf = (mfj: number) => mfj / 2;

export const US_FEDERAL_2026: UsFederalYear = {
  year: 2026,
  startYear: 2026,
  sources: [
    {
      url: RP_2025_32,
      note: "Rev. Proc. 2025-32: 2026 brackets, standard deduction, LTCG, AMT, CTC, QBI",
    },
    { url: IRB_2025_45, note: "IRB 2025-45 (HTML of Rev. Proc. 2025-32)" },
    {
      url: "https://www.irs.gov/newsroom/working-families-tax-cuts-individuals-and-workers",
      note: "OBBBA: senior deduction $6,000 (2025-2028), SALT cap",
    },
  ],
  brackets: {
    single: [
      [0, 0.1],
      [12_400, 0.12],
      [50_400, 0.22],
      [105_700, 0.24],
      [201_775, 0.32],
      [256_225, 0.35],
      [640_600, 0.37],
    ],
    "married-joint": [
      [0, 0.1],
      [24_800, 0.12],
      [100_800, 0.22],
      [211_400, 0.24],
      [403_550, 0.32],
      [512_450, 0.35],
      [768_700, 0.37],
    ],
    "qualifying-surviving-spouse": [
      [0, 0.1],
      [24_800, 0.12],
      [100_800, 0.22],
      [211_400, 0.24],
      [403_550, 0.32],
      [512_450, 0.35],
      [768_700, 0.37],
    ],
    "head-of-household": [
      [0, 0.1],
      [17_700, 0.12],
      [67_450, 0.22],
      [105_700, 0.24],
      [201_750, 0.32],
      [256_200, 0.35],
      [640_600, 0.37],
    ],
    "married-separate": [
      [0, 0.1],
      [12_400, 0.12],
      [50_400, 0.22],
      [105_700, 0.24],
      [201_775, 0.32],
      [256_225, 0.35],
      [384_350, 0.37],
    ],
  },
  standardDeduction: {
    single: 16_100,
    "married-joint": 32_200,
    "qualifying-surviving-spouse": 32_200,
    "head-of-household": 24_150,
    "married-separate": 16_100,
  },
  additionalAged: { married: 1_650, unmarried: 2_050 },
  capitalGains: {
    single: { zeroMax: 49_450, fifteenMax: 545_500 },
    "married-joint": { zeroMax: 98_900, fifteenMax: 613_700 },
    "qualifying-surviving-spouse": { zeroMax: 98_900, fifteenMax: 613_700 },
    "head-of-household": { zeroMax: 66_200, fifteenMax: 579_600 },
    "married-separate": { zeroMax: 49_450, fifteenMax: 306_850 },
  },
  personalExemption: 0,
  seniorDeduction: {
    amount: 6_000,
    phaseoutStart: {
      single: 75_000,
      "married-joint": 150_000,
      "qualifying-surviving-spouse": 75_000,
      "head-of-household": 75_000,
      "married-separate": 75_000,
    },
    phaseoutRate: 0.06,
    lastYear: 2028,
  },
  amt: {
    exemption: {
      single: 90_100,
      "married-joint": 140_200,
      "qualifying-surviving-spouse": 140_200,
      "head-of-household": 90_100,
      "married-separate": 70_100,
    },
    phaseoutStart: {
      single: 500_000,
      "married-joint": 1_000_000,
      "qualifying-surviving-spouse": 1_000_000,
      "head-of-household": 500_000,
      "married-separate": 500_000,
    },
    breakpoint28: {
      single: 244_500,
      "married-joint": 244_500,
      "qualifying-surviving-spouse": 244_500,
      "head-of-household": 244_500,
      "married-separate": 122_250,
    },
  },
  childTaxCredit: {
    perChild: 2_200,
    refundable: 1_700,
    phaseoutStart: {
      single: 200_000,
      "married-joint": 400_000,
      "qualifying-surviving-spouse": 200_000,
      "head-of-household": 200_000,
      "married-separate": 200_000,
    },
  },
  qbi: {
    threshold: {
      single: 201_750,
      "married-joint": 403_500,
      "qualifying-surviving-spouse": 201_750,
      "head-of-household": 201_750,
      "married-separate": 201_775,
    },
    phaseInRange: {
      single: 75_000,
      "married-joint": 150_000,
      "qualifying-surviving-spouse": 75_000,
      "head-of-household": 75_000,
      "married-separate": 75_000,
    },
  },
};

/**
 * ESTIMATE used only when the 'us.tcjaSunset' toggle is on (pre-TCJA law). OBBBA made the TCJA
 * rates permanent, so this is a what-if: 2017 brackets/deductions x 1.33 (approx. chained CPI
 * 2017->2026), with personal exemptions restored.
 */
const SUNSET_FACTOR = 1.33;
const s17 = (rows: [number, number][]) =>
  rows.map(([t, r]) => [t * SUNSET_FACTOR, r] as [number, number]);
const MFJ17: [number, number][] = [
  [0, 0.1],
  [18_650, 0.15],
  [75_900, 0.25],
  [153_100, 0.28],
  [233_350, 0.33],
  [416_700, 0.35],
  [470_700, 0.396],
];
export const US_FEDERAL_SUNSET_2026: UsFederalYear = {
  ...US_FEDERAL_2026,
  sources: [
    { url: "https://www.irs.gov/pub/irs-prior/p17--2017.pdf", note: "2017 law x 1.33 (estimate)" },
  ],
  brackets: {
    single: s17([
      [0, 0.1],
      [9_325, 0.15],
      [37_950, 0.25],
      [91_900, 0.28],
      [191_650, 0.33],
      [416_700, 0.35],
      [418_400, 0.396],
    ]),
    "married-joint": s17(MFJ17),
    "qualifying-surviving-spouse": s17(MFJ17),
    "head-of-household": s17([
      [0, 0.1],
      [13_350, 0.15],
      [50_800, 0.25],
      [131_200, 0.28],
      [212_500, 0.33],
      [416_700, 0.35],
      [444_550, 0.396],
    ]),
    "married-separate": s17(MFJ17.map(([t, r]) => [mfsHalf(t), r] as [number, number])),
  },
  standardDeduction: {
    single: 6_350 * SUNSET_FACTOR,
    "married-joint": 12_700 * SUNSET_FACTOR,
    "qualifying-surviving-spouse": 12_700 * SUNSET_FACTOR,
    "head-of-household": 9_350 * SUNSET_FACTOR,
    "married-separate": 6_350 * SUNSET_FACTOR,
  },
  personalExemption: 4_050 * SUNSET_FACTOR,
  childTaxCredit: { ...US_FEDERAL_2026.childTaxCredit, perChild: 1_000, refundable: 1_000 },
};

export const US_FEDERAL_YEARS: readonly UsFederalYear[] = [US_FEDERAL_2026];

/** Thresholds NOT indexed for inflation (statutory dollar amounts). */
export const US_FIXED = {
  niit: {
    rate: 0.038,
    threshold: {
      single: 200_000,
      "married-joint": 250_000,
      "qualifying-surviving-spouse": 250_000,
      "head-of-household": 200_000,
      "married-separate": 125_000,
    } as ByStatus<number>,
    source: "https://www.irs.gov/individuals/net-investment-income-tax",
  },
  additionalMedicare: {
    rate: 0.009,
    threshold: {
      single: 200_000,
      "married-joint": 250_000,
      "qualifying-surviving-spouse": 200_000,
      "head-of-household": 200_000,
      "married-separate": 125_000,
    } as ByStatus<number>,
    source: "https://www.irs.gov/taxtopics/tc560",
  },
  /** Social Security benefit taxation base amounts (IRC §86), not indexed. */
  socialSecurity: {
    base1: { joint: 32_000, other: 25_000, separate: 0 },
    base2: { joint: 44_000, other: 34_000, separate: 0 },
    source: "https://www.irs.gov/pub/irs-pdf/p915.pdf",
  },
  earlyWithdrawalPenalty: 0.1,
  /** IRC §121 exclusion of gain on the sale of a main home (2 of the last 5 years), not indexed. */
  homeSaleExclusion: {
    single: 250_000,
    joint: 500_000,
    source: "https://www.irs.gov/taxtopics/tc701",
  },
  /** HSA non-qualified distributions: 20% additional tax before 65 (IRC §223(f)(4)). */
  hsaNonQualifiedPenalty: 0.2,
  hsaPenaltyFreeAge: 65,
  /** 529 non-qualified earnings: 10% additional tax (IRC §529(c)(6)). */
  educationNonQualifiedPenalty: 0.1,
  /** Roth IRA earnings are qualified after age 59.5 AND five tax years since the first contribution. */
  rothFiveYearRule: 5,
  /** Age for penalty-free access to qualified retirement plans and IRAs. */
  retirementAccessAge: 59.5,
};

export const US_PAYROLL_2026 = {
  year: 2026,
  socialSecurityRate: 0.062,
  socialSecurityWageBase: 184_500,
  medicareRate: 0.0145,
  seNetEarningsFactor: 0.9235,
  sources: [
    {
      url: "https://www.ssa.gov/oact/cola/cbb.html",
      note: "2026 contribution and benefit base $184,500",
    },
    { url: "https://www.irs.gov/taxtopics/tc751", note: "FICA rates" },
  ],
};

/** 2026 IRMAA (SSA POMS HI 01101.020). Monthly Part B total premium and Part D adjustment. */
export const US_IRMAA_2026 = {
  year: 2026,
  standardPartB: 202.9,
  source: "https://secure.ssa.gov/poms.nsf/lnx/0601101020",
  /** [MAGI lower bound (exclusive), Part B total, Part D adjustment]. */
  single: [
    [109_000, 284.1, 14.5],
    [137_000, 405.8, 37.5],
    [171_000, 527.5, 60.4],
    [205_000, 649.2, 83.3],
    [499_999.99, 689.9, 91.0],
  ] as [number, number, number][],
  joint: [
    [218_000, 284.1, 14.5],
    [274_000, 405.8, 37.5],
    [342_000, 527.5, 60.4],
    [410_000, 649.2, 83.3],
    [749_999.99, 689.9, 91.0],
  ] as [number, number, number][],
  separate: [
    [109_000, 649.2, 83.3],
    [390_999.99, 689.9, 91.0],
  ] as [number, number, number][],
};

/** ACA premium tax credit, coverage year 2026 (Rev. Proc. 2025-25; enhanced credits expired after 2025). */
export const US_ACA_2026 = {
  year: 2026,
  /** 2025 HHS poverty guideline (48 states/DC) used for 2026 coverage. */
  fpl: { first: 15_650, additional: 5_500 },
  /** [FPL multiple lower bound, applicable % at lower bound, at upper bound of the segment]. */
  applicable: [
    [0, 0.021, 0.021],
    [1.33, 0.0314, 0.0419],
    [1.5, 0.0419, 0.066],
    [2.0, 0.066, 0.0844],
    [2.5, 0.0844, 0.0996],
    [3.0, 0.0996, 0.0996],
  ] as [number, number, number][],
  /** No credit at or above this multiple (the cliff). */
  cliff: 4.0,
  /** ARPA/IRA enhanced schedule (law toggle 'us.acaEnhanced'): 0% to 150%, 8.5% cap, no cliff. */
  enhanced: [
    [0, 0, 0],
    [1.5, 0, 0.02],
    [2.0, 0.02, 0.04],
    [2.5, 0.04, 0.06],
    [3.0, 0.06, 0.085],
    [4.0, 0.085, 0.085],
  ] as [number, number, number][],
  sources: [
    {
      url: "https://www.irs.gov/pub/irs-drop/rp-25-25.pdf",
      note: "Rev. Proc. 2025-25 applicable percentage table",
    },
    {
      url: "https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines",
      note: "2025 FPL",
    },
  ],
};

/** IRS Uniform Lifetime Table (Treas. Reg. §1.401(a)(9)-9(c), effective 2022). Age -> divisor. */
export const UNIFORM_LIFETIME: Record<number, number> = {
  70: 29.1,
  71: 28.2,
  72: 27.4,
  73: 26.5,
  74: 25.5,
  75: 24.6,
  76: 23.7,
  77: 22.9,
  78: 22.0,
  79: 21.1,
  80: 20.2,
  81: 19.4,
  82: 18.5,
  83: 17.7,
  84: 16.8,
  85: 16.0,
  86: 15.2,
  87: 14.4,
  88: 13.7,
  89: 12.9,
  90: 12.2,
  91: 11.5,
  92: 10.8,
  93: 10.1,
  94: 9.5,
  95: 8.9,
  96: 8.4,
  97: 7.8,
  98: 7.3,
  99: 6.8,
  100: 6.4,
  101: 6.0,
  102: 5.6,
  103: 5.2,
  104: 4.9,
  105: 4.6,
  106: 4.3,
  107: 4.1,
  108: 3.9,
  109: 3.7,
  110: 3.5,
  111: 3.4,
  112: 3.3,
  113: 3.1,
  114: 3.0,
  115: 2.9,
  116: 2.8,
  117: 2.7,
  118: 2.5,
  119: 2.3,
  120: 2.0,
};

/** SECURE 2.0 required beginning age by birth year. */
export function usRmdStartAge(birthYear: number): number {
  if (birthYear < 1949.5) return 70.5;
  if (birthYear < 1951) return 72;
  if (birthYear < 1960) return 73;
  return 75;
}

/** 2026 contribution limits (IRS IR-2025-111; Rev. Proc. 2025-19 for HSA). */
export const US_LIMITS_2026 = {
  year: 2026,
  electiveDeferral: 24_500,
  catchUp50: 8_000,
  catchUp60to63: 11_250,
  ira: 7_500,
  iraCatchUp: 1_100,
  simple: 17_000,
  simpleCatchUp: 4_000,
  simpleCatchUp60to63: 5_250,
  sepOrSoloTotal: 72_000,
  hsa: { self: 4_400, family: 8_750, catchUp55: 1_000 },
  sources: [
    {
      url: "https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500",
      note: "2026 retirement plan limits",
    },
  ],
};

export const US_ESTATE = {
  year: 2026,
  basicExclusion: 15_000_000,
  source: RP_2025_32,
};

/**
 * Mortality rates q(x), ages 0-120, of 26 CFR 1.401(a)(9)-9(e) (T.D. 9930, the rates behind the
 * 2022 Single Life, Joint and Last Survivor and Uniform Lifetime tables). IRS Notice 2022-6 §2.02(c)
 * requires them for the 72(t) fixed annuitisation method. Source:
 * https://www.ecfr.gov/current/title-26/part-1/section-1.401(a)(9)-9 (paragraph (e)).
 */
export const IRS_MORTALITY_RATES: readonly number[] = [
  0.001762, 0.000441, 0.000292, 0.000232, 0.000177, 0.000161, 0.000153, 0.000145, 0.000132,
  0.000127, 0.000128, 0.000135, 0.000146, 0.000164, 0.000192, 0.000223, 0.000253, 0.000276,
  0.000293, 0.000304, 0.000313, 0.000343, 0.000377, 0.000421, 0.000466, 0.00052, 0.000581, 0.00063,
  0.000677, 0.00072, 0.000763, 0.000799, 0.000824, 0.000833, 0.00083, 0.000823, 0.000819, 0.000824,
  0.000836, 0.000853, 0.000879, 0.000909, 0.000945, 0.00098, 0.001019, 0.001065, 0.001132, 0.001225,
  0.001345, 0.001485, 0.001656, 0.001874, 0.002121, 0.002397, 0.002701, 0.003032, 0.00339, 0.003774,
  0.004181, 0.004613, 0.005071, 0.005554, 0.006071, 0.006624, 0.007225, 0.007884, 0.008238,
  0.008659, 0.009163, 0.009767, 0.010491, 0.011358, 0.012385, 0.013598, 0.015014, 0.01667, 0.018587,
  0.020815, 0.023391, 0.026387, 0.02985, 0.033883, 0.038544, 0.04388, 0.049956, 0.056799, 0.064436,
  0.072882, 0.082137, 0.092172, 0.102919, 0.114344, 0.126605, 0.139936, 0.154844, 0.171902, 0.18721,
  0.204659, 0.222921, 0.241884, 0.261476, 0.281536, 0.301847, 0.322371, 0.34294, 0.361261, 0.372886,
  0.381098, 0.383358, 0.385709, 0.388092, 0.390353, 0.392822, 0.395188, 0.397567, 0.4, 0.4, 0.4,
  0.4, 0.4, 0.4,
];

/**
 * 72(t) fixed annuitisation factor (Notice 2022-6 §2.01(c)): present value of an annuity of 1 a
 * year, first payment now, for the life of someone aged `age` (whole years), from the §1.401(a)(9)-9(e)
 * mortality rates at interest `rate`. Lives beyond 120 keep the age-120 rate.
 */
export function seppAnnuityFactor(age: number, rate: number): number {
  const x = Math.max(0, Math.min(120, Math.floor(age)));
  const v = 1 / (1 + rate);
  let survive = 1;
  let disc = 1;
  let sum = 0;
  for (let t = 0; t < 200 && survive > 1e-12; t++) {
    sum += survive * disc;
    survive *= 1 - IRS_MORTALITY_RATES[Math.min(120, x + t)]!;
    disc *= v;
  }
  return sum;
}
