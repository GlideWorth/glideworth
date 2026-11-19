/**
 * US federal tax data (tax year = calendar year). Nominal USD. Calculation: ../jurisdictions/us-*.ts.
 * Tax years 2026 and 2027 are published figures. Later years index the latest published year with
 * the plan's price index from the start of that year (the IRS indexes with chained CPI); see
 * ../jurisdictions/us-index.ts. Every table names its official source; figures checked 2026-11-19.
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
    /** Filing statuses that cannot claim it (married people must file jointly). */
    notAllowed: FilingStatus[];
  };
  amt: {
    exemption: ByStatus<number>;
    phaseoutStart: ByStatus<number>;
    /** Exemption reduction per dollar of AMTI above the phase-out start (50% from 2026, OBBBA). */
    phaseoutRate: number;
    breakpoint28: ByStatus<number>;
  };
  childTaxCredit: { perChild: number; refundable: number; phaseoutStart: ByStatus<number> };
  qbi: { threshold: ByStatus<number>; phaseInRange: ByStatus<number> };
}

const RP_2025_32 = "https://www.irs.gov/pub/irs-drop/rp-25-32.pdf";
const IRB_2025_45 = "https://www.irs.gov/irb/2025-45_IRB";
const RP_2026_35 = "https://www.irs.gov/pub/irs-drop/rp-26-35.pdf";
const OBBBA_SENIORS =
  "https://www.irs.gov/newsroom/one-big-beautiful-bill-act-tax-deductions-for-working-americans-and-seniors";
const OBBBA_INDIVIDUALS =
  "https://www.irs.gov/newsroom/working-families-tax-cuts-individuals-and-workers";

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
      url: OBBBA_SENIORS,
      note: "OBBBA senior deduction: $6,000 per person 65+, 2025-2028, phased out at 6% of MAGI over $75,000 ($150,000 joint)",
    },
    {
      url: OBBBA_INDIVIDUALS,
      note: "Senior deduction: married taxpayers must file jointly to claim it (read 2026-11-19)",
    },
  ],
  // Rev. Proc. 2025-32 section 4.01, Tables 1-4 (read 2026-11-19).
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
  // Rev. Proc. 2025-32 section 4.14(1) and (3).
  standardDeduction: {
    single: 16_100,
    "married-joint": 32_200,
    "qualifying-surviving-spouse": 32_200,
    "head-of-household": 24_150,
    "married-separate": 16_100,
  },
  additionalAged: { married: 1_650, unmarried: 2_050 },
  // Rev. Proc. 2025-32 section 4.03.
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
    notAllowed: ["married-separate"],
  },
  // Rev. Proc. 2025-32 section 4.10: exemption, 28% breakpoint, phase-out from $500,000 /
  // $1,000,000 to $680,200 / $1,280,400 (so 50 cents per dollar, IRC 55(d)(3) as amended by OBBBA).
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
    phaseoutRate: 0.5,
    breakpoint28: {
      single: 244_500,
      "married-joint": 244_500,
      "qualifying-surviving-spouse": 244_500,
      "head-of-household": 244_500,
      "married-separate": 122_250,
    },
  },
  // Rev. Proc. 2025-32 section 4.05; phase-out thresholds statutory (IRC 24(b)).
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
  // Rev. Proc. 2025-32 section 4.26: threshold; phase-in range width $75,000 ($150,000 joint).
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

/** Tax year 2027: Rev. Proc. 2026-35 (released 5 November 2026; read 2026-11-19). */
export const US_FEDERAL_2027: UsFederalYear = {
  year: 2027,
  startYear: 2027,
  sources: [
    {
      url: RP_2026_35,
      note: "Rev. Proc. 2026-35: 2027 brackets (3.01), LTCG (3.03), CTC (3.05), AMT (3.11), standard deduction (3.15), QBI (3.28)",
    },
    {
      url: "https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2027-taxpayers-continue-to-benefit-from-the-working-families-tax-cuts",
      note: "IRS news release on the 2027 adjustments",
    },
    { url: OBBBA_SENIORS, note: "Senior deduction $6,000 (not indexed), 2025-2028" },
  ],
  // Rev. Proc. 2026-35 section 3.01, Tables 1-4.
  brackets: {
    single: [
      [0, 0.1],
      [12_800, 0.12],
      [52_025, 0.22],
      [109_125, 0.24],
      [208_325, 0.32],
      [264_550, 0.35],
      [661_375, 0.37],
    ],
    "married-joint": [
      [0, 0.1],
      [25_600, 0.12],
      [104_050, 0.22],
      [218_250, 0.24],
      [416_650, 0.32],
      [529_100, 0.35],
      [793_650, 0.37],
    ],
    "qualifying-surviving-spouse": [
      [0, 0.1],
      [25_600, 0.12],
      [104_050, 0.22],
      [218_250, 0.24],
      [416_650, 0.32],
      [529_100, 0.35],
      [793_650, 0.37],
    ],
    "head-of-household": [
      [0, 0.1],
      [18_250, 0.12],
      [69_650, 0.22],
      [109_100, 0.24],
      [208_300, 0.32],
      [264_550, 0.35],
      [661_350, 0.37],
    ],
    "married-separate": [
      [0, 0.1],
      [12_800, 0.12],
      [52_025, 0.22],
      [109_125, 0.24],
      [208_325, 0.32],
      [264_550, 0.35],
      [396_825, 0.37],
    ],
  },
  // Rev. Proc. 2026-35 section 3.15(1) and (3).
  standardDeduction: {
    single: 16_600,
    "married-joint": 33_200,
    "qualifying-surviving-spouse": 33_200,
    "head-of-household": 24_925,
    "married-separate": 16_600,
  },
  additionalAged: { married: 1_700, unmarried: 2_100 },
  // Rev. Proc. 2026-35 section 3.03.
  capitalGains: {
    single: { zeroMax: 51_050, fifteenMax: 563_200 },
    "married-joint": { zeroMax: 102_100, fifteenMax: 633_600 },
    "qualifying-surviving-spouse": { zeroMax: 102_100, fifteenMax: 633_600 },
    "head-of-household": { zeroMax: 68_350, fifteenMax: 598_400 },
    "married-separate": { zeroMax: 51_050, fifteenMax: 316_800 },
  },
  personalExemption: 0,
  seniorDeduction: US_FEDERAL_2026.seniorDeduction!,
  // Rev. Proc. 2026-35 section 3.11 (complete phase-out amounts imply the 50% rate).
  amt: {
    exemption: {
      single: 93_000,
      "married-joint": 144_700,
      "qualifying-surviving-spouse": 144_700,
      "head-of-household": 93_000,
      "married-separate": 72_350,
    },
    phaseoutStart: {
      single: 515_950,
      "married-joint": 1_031_900,
      "qualifying-surviving-spouse": 1_031_900,
      "head-of-household": 515_950,
      "married-separate": 515_950,
    },
    phaseoutRate: 0.5,
    breakpoint28: {
      single: 252_500,
      "married-joint": 252_500,
      "qualifying-surviving-spouse": 252_500,
      "head-of-household": 252_500,
      "married-separate": 126_250,
    },
  },
  // Rev. Proc. 2026-35 section 3.05.
  childTaxCredit: {
    perChild: 2_300,
    refundable: 1_800,
    phaseoutStart: US_FEDERAL_2026.childTaxCredit.phaseoutStart,
  },
  // Rev. Proc. 2026-35 section 3.28(1).
  qbi: {
    threshold: {
      single: 208_300,
      "married-joint": 416_600,
      "qualifying-surviving-spouse": 208_300,
      "head-of-household": 208_300,
      "married-separate": 208_325,
    },
    phaseInRange: US_FEDERAL_2026.qbi.phaseInRange,
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
  // Pre-TCJA law phased the AMT exemption out at 25 cents per dollar.
  amt: { ...US_FEDERAL_2026.amt, phaseoutRate: 0.25 },
  childTaxCredit: { ...US_FEDERAL_2026.childTaxCredit, perChild: 1_000, refundable: 1_000 },
};

export const US_FEDERAL_YEARS: readonly UsFederalYear[] = [US_FEDERAL_2026, US_FEDERAL_2027];

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

export interface UsPayrollYear {
  year: number;
  startYear: number;
  socialSecurityRate: number;
  socialSecurityWageBase: number;
  medicareRate: number;
  seNetEarningsFactor: number;
  sources: { url: string; note?: string }[];
}

export const US_PAYROLL_2026: UsPayrollYear = {
  year: 2026,
  startYear: 2026,
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

/** 2027: SSA notice, Federal Register 26 October 2026 (base $192,300; read 2026-11-19). */
export const US_PAYROLL_2027: UsPayrollYear = {
  ...US_PAYROLL_2026,
  year: 2027,
  startYear: 2027,
  socialSecurityWageBase: 192_300,
  sources: [
    {
      url: "https://www.govinfo.gov/content/pkg/FR-2026-10-26/html/2026-21796.htm",
      note: "SSA notice (91 FR 67380): OASDI contribution and benefit base $192,300 for 2027",
    },
    { url: "https://www.irs.gov/taxtopics/tc751", note: "FICA rates (statutory, unchanged)" },
  ],
};

export const US_PAYROLL_YEARS: readonly UsPayrollYear[] = [US_PAYROLL_2026, US_PAYROLL_2027];

/** IRMAA tiers for one year: monthly Part B total premium and Part D adjustment by MAGI. */
export interface UsIrmaaYear {
  year: number;
  startYear: number;
  standardPartB: number;
  source: string;
  /** [MAGI lower bound (exclusive), Part B total, Part D adjustment]. */
  single: [number, number, number][];
  joint: [number, number, number][];
  separate: [number, number, number][];
}

/** 2026 IRMAA (SSA POMS HI 01101.020). Monthly Part B total premium and Part D adjustment. */
export const US_IRMAA_2026: UsIrmaaYear = {
  year: 2026,
  startYear: 2026,
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

/** 2027 IRMAA: CMS fact sheet of 17 November 2026 (Part B and Part D tables; read 2026-11-19). */
export const US_IRMAA_2027: UsIrmaaYear = {
  year: 2027,
  startYear: 2027,
  standardPartB: 209.4,
  source: "https://www.cms.gov/newsroom/fact-sheets/2027-medicare-parts-b-premiums-deductibles",
  single: [
    [112_000, 293.1, 15.4],
    [141_000, 418.8, 39.7],
    [177_000, 544.4, 64.0],
    [212_000, 670.0, 88.3],
    [499_999.99, 711.8, 96.4],
  ],
  joint: [
    [224_000, 293.1, 15.4],
    [282_000, 418.8, 39.7],
    [354_000, 544.4, 64.0],
    [424_000, 670.0, 88.3],
    [749_999.99, 711.8, 96.4],
  ],
  separate: [
    [112_000, 670.0, 88.3],
    [387_999.99, 711.8, 96.4],
  ],
};

export const US_IRMAA_YEARS: readonly UsIrmaaYear[] = [US_IRMAA_2026, US_IRMAA_2027];

/**
 * ACA premium tax credit, coverage year 2026 (Rev. Proc. 2025-25; enhanced credits expired after 2025,
 * confirmed by the 2026 Form 8962 instructions: no credit above 400% FPL, full repayment of excess APTC).
 */
export interface UsAcaYear {
  year: number;
  startYear: number;
  /** HHS poverty guideline (48 states/DC) of the year before coverage. */
  fpl: { first: number; additional: number };
  /** [FPL multiple lower bound, applicable % at lower bound, at upper bound of the segment]. */
  applicable: [number, number, number][];
  /** No credit above this multiple (Form 8962 line 5 is the whole percentage; 401% gets none). */
  cliff: number;
  /** No credit below this multiple (100% FPL; lawfully present exception removed from 2026). */
  floor: number;
  /** ARPA/IRA enhanced schedule (law toggle 'us.acaEnhanced'): 0% to 150%, 8.5% cap, no cliff. */
  enhanced: [number, number, number][];
  sources: { url: string; note?: string }[];
}

export const US_ACA_2026: UsAcaYear = {
  year: 2026,
  startYear: 2026,
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
  cliff: 4.0,
  floor: 1.0,
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
    {
      url: "https://www.irs.gov/pub/irs-dft/i8962--dft.pdf",
      note: "2026 Form 8962 instructions (draft): no PTC above 400% FPL or below 100%; excess APTC repaid in full",
    },
  ],
};

/** Coverage year 2027: Rev. Proc. 2026-26 and the 2026 HHS poverty guidelines (read 2026-11-19). */
export const US_ACA_2027: UsAcaYear = {
  ...US_ACA_2026,
  year: 2027,
  startYear: 2027,
  fpl: { first: 15_960, additional: 5_680 },
  applicable: [
    [0, 0.0215, 0.0215],
    [1.33, 0.0323, 0.043],
    [1.5, 0.043, 0.0678],
    [2.0, 0.0678, 0.0866],
    [2.5, 0.0866, 0.1022],
    [3.0, 0.1022, 0.1022],
  ],
  sources: [
    {
      url: "https://www.irs.gov/pub/irs-drop/rp-26-26.pdf",
      note: "Rev. Proc. 2026-26 section 3: 2027 applicable percentage table",
    },
    {
      url: "https://www.govinfo.gov/content/pkg/FR-2026-01-15/html/2026-00755.htm",
      note: "2026 HHS poverty guidelines: $15,960 for one person, $5,680 per additional person",
    },
  ],
};

export const US_ACA_YEARS: readonly UsAcaYear[] = [US_ACA_2026, US_ACA_2027];

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

export interface UsLimitsYear {
  year: number;
  startYear: number;
  electiveDeferral: number;
  catchUp50: number;
  catchUp60to63: number;
  ira: number;
  iraCatchUp: number;
  simple: number;
  simpleCatchUp: number;
  simpleCatchUp60to63: number;
  sepOrSoloTotal: number;
  hsa: { self: number; family: number; catchUp55: number };
  sources: { url: string; note?: string }[];
}

/** 2026 contribution limits (IRS IR-2025-111, Notice 2025-67; Rev. Proc. 2025-19 for HSA). */
export const US_LIMITS_2026: UsLimitsYear = {
  year: 2026,
  startYear: 2026,
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
    { url: "https://www.irs.gov/pub/irs-drop/n-25-67.pdf", note: "Notice 2025-67" },
    { url: "https://www.irs.gov/pub/irs-drop/rp-25-19.pdf", note: "Rev. Proc. 2025-19 (HSA 2026)" },
  ],
};

/** 2027 limits: Notice 2026-66 (IR-2026-136) and Rev. Proc. 2026-24 for HSAs (read 2026-11-19). */
export const US_LIMITS_2027: UsLimitsYear = {
  year: 2027,
  startYear: 2027,
  electiveDeferral: 25_500,
  catchUp50: 8_500,
  catchUp60to63: 11_750,
  ira: 7_500,
  iraCatchUp: 1_100,
  simple: 17_500,
  simpleCatchUp: 4_000,
  simpleCatchUp60to63: 5_250,
  sepOrSoloTotal: 75_000,
  // The $1,000 HSA catch-up (55+) is statutory and not indexed (IRC 223(b)(3)).
  hsa: { self: 4_500, family: 9_000, catchUp55: 1_000 },
  sources: [
    {
      url: "https://www.irs.gov/pub/irs-drop/n-26-66.pdf",
      note: "Notice 2026-66: 2027 retirement plan and IRA limits",
    },
    {
      url: "https://www.irs.gov/newsroom/401k-limit-increases-to-25500-for-2027-ira-limit-remains-7500",
      note: "IRS news release on the 2027 limits",
    },
    {
      url: "https://www.irs.gov/pub/irs-drop/rp-26-24.pdf",
      note: "Rev. Proc. 2026-24 section 3.01: 2027 HSA limits",
    },
  ],
};

export const US_LIMITS_YEARS: readonly UsLimitsYear[] = [US_LIMITS_2026, US_LIMITS_2027];

/** Estate tax basic exclusion amount (IRC 2010(c)(3)) by year of death. */
export const US_ESTATE_YEARS: readonly {
  year: number;
  startYear: number;
  basicExclusion: number;
  source: string;
}[] = [
  // Rev. Proc. 2025-32 section 4.41.
  { year: 2026, startYear: 2026, basicExclusion: 15_000_000, source: RP_2025_32 },
  // Rev. Proc. 2026-35 section 3.44 (read 2026-11-19).
  { year: 2027, startYear: 2027, basicExclusion: 15_480_000, source: RP_2026_35 },
];

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
