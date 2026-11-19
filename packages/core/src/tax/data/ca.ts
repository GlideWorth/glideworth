/**
 * Canada, tax year 2026 (calendar year). Nominal CAD. Calculation: ../jurisdictions/ca.ts.
 * Sources (all official, re-checked 2026-11-19; listed in `CA_2026.sources`):
 *   2026 federal and provincial/territorial rates and brackets (CRA current-year page)
 *   2026 indexation amounts (federal BPA, age amount, Canada employment amount, OAS repayment)
 *   T4127 Payroll Deductions Formulas, 123rd edition (1 July 2026), tables 8.1-8.2: provincial
 *     brackets, basic amounts and formulas (Manitoba and Yukon BPA), mid-year changes (BC first
 *     rate, NL basic amount, PEI top bracket), Ontario surtax, Quebec abatement, the 2027 CPP rate
 *   T4127 122nd edition (1 January 2026): CPP, CPP2, QPP and EI
 *   2026 TD1 forms, federal and each province/territory except Quebec (age and pension amounts,
 *     Saskatchewan senior supplementary amount)
 *   CRA 2025 provincial dividend tax credit worksheets 5001-D ... 5014-D (2026 not yet published)
 *   2025 ON428 (Ontario surtax order, Ontario Health Premium chart)
 * Where the CRA current-year page and the T4127 disagree (Manitoba), the province's own statement
 * decides (see the MB row). Quebec's thresholds and basic amount come from Quebec's Ministère des
 * Finances (Paramètres du régime d'imposition des particuliers 2026); Revenu Québec refused automated
 * access, so the three lower Quebec rates and Quebec's dividend tax credits are not confirmed.
 */

export interface CaProvince {
  code: string;
  name: string;
  brackets: [number, number][];
  bpa: number;
  ageAmount: number;
  ageThreshold: number;
  pensionAmount: number;
  /** Dividend tax credit as a share of the grossed-up dividend. */
  dtcEligible: number;
  dtcNonEligible: number;
  /** Basic personal amount follows the federal amount and its high-income reduction (Yukon). */
  bpaFollowsFederal?: boolean;
  /** Basic personal amount reduced to nil between these net incomes (Manitoba, not indexed). */
  bpaPhaseOut?: [number, number];
  /** Extra amount for everyone 65 or older, with no income test (Saskatchewan). */
  seniorSupplement?: number;
  /**
   * Legislated indexation pause: brackets and amounts stay at their 2026 values through this year,
   * then are indexed again. Manitoba's pause (from 2025) has no end date (Infinity).
   */
  frozenThrough?: number;
  /** A basic personal amount that applies from a later year (2026 money, indexed like the rest). */
  bpaFrom?: { year: number; amount: number };
  approx?: string;
}

export const CA_2026 = {
  year: 2026,
  federal: {
    brackets: [
      [0, 0.14],
      [58_523, 0.205],
      [117_045, 0.26],
      [181_440, 0.29],
      [258_482, 0.33],
    ] as [number, number][],
    creditRate: 0.14,
    bpaMax: 16_452,
    bpaMin: 14_829,
    ageAmount: 9_208,
    ageThreshold: 46_432,
    ageReductionRate: 0.15,
    /** Not indexed: $2,000 since 2006 (2026 TD1; absent from CRA's indexed amounts). */
    pensionAmount: 2_000,
    canadaEmploymentAmount: 1_501,
    dtcEligible: 0.150198,
    dtcNonEligible: 0.090301,
    quebecAbatement: 0.165,
  },
  dividends: { grossUpEligible: 0.38, grossUpNonEligible: 0.15 },
  /**
   * One-half: the enacted rate. The proposed two-thirds rate was cancelled (Prime Minister's
   * Office, 21 March 2025) and never enacted; CRA's 2026 indexation table still states "½ of the
   * capital gain is taxable".
   */
  capitalGainsInclusion: 0.5,
  cpp: {
    ympe: 74_600,
    yampe: 85_000,
    basicExemption: 3_500,
    baseRate: 0.0495,
    /**
     * Base CPP employee rate from 1 January 2027 (9.90% -> 9.50% combined), Bill C-30, Royal Assent
     * 18 June 2026 (CRA "What's new for payroll"; CRA CPP table: 2027 total employee rate 5.75%).
     * QPP 2027 not confirmed (Revenu Québec could not be opened): QPP keeps its 2026 rate.
     */
    baseRateFrom2027: 0.0475,
    /**
     * CPP contributions stop at 70 ("At the age of 70, you no longer contribute to the CPP, even if
     * you are still working": canada.ca, Contributions to the CPP, read 2026-11-19). Not applied to QPP.
     */
    maxAge: 70,
    enhancedRate: 0.01,
    cpp2Rate: 0.04,
    /** Quebec Pension Plan employee rate for 2026 (base 5.3% + 1% first additional; T4127 table 8.3-8.5). */
    qppRate: 0.063,
    qppBaseRate: 0.053,
  },
  ei: { maxInsurable: 68_900, rate: 0.0163, quebecRate: 0.013 },
  oas: { clawbackThreshold: 95_323, clawbackRate: 0.15 },
  limits: { rrspMax: 33_810, rrspRate: 0.18, tfsa: 7_000, fhsa: 8_000 },
  sources: [
    {
      url: "https://www.canada.ca/en/revenue-agency/services/tax/individuals/tax-rates-brackets/current-year.html",
      note: "CRA: 2026 federal and provincial/territorial rates and brackets (read 2026-11-16)",
    },
    {
      url: "https://www.canada.ca/en/revenue-agency/services/tax/individuals/frequently-asked-questions-individuals/adjustment-personal-income-tax-benefit-amounts.html",
      note: "CRA indexation amounts for 2026: basic personal amount 16,452 / 14,829, age amount 9,208 above 46,432, Canada employment amount 1,501, OAS repayment threshold 95,323 (read 2026-11-16)",
    },
    {
      url: "https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4127-payroll-deductions-formulas/t4127-jul/t4127-jul-payroll-deductions-formulas.html",
      note: "CRA T4127, 123rd edition (1 July 2026), 'What's new' and tables 8.1-8.2: provincial brackets, constants K/KP and basic amounts (Manitoba 47,000 / 100,000, 'no change for Manitoba'; Yukon BPA = federal formula BPAYT; NL basic amount 11,188 -> 13,094 for 2026; PEI new 20% rate over 200,000 for 2026; BC first rate 5.06% -> 5.60% for 2026), Ontario surtax 20% over 5,818 and 36% over 7,446, Quebec abatement 16.5%; BC indexation paused at 2026 levels for 2027-2030; base CPP 4.95% -> 4.75% from 1 January 2027 (read 2026-11-19)",
    },
    {
      url: "https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4127-payroll-deductions-formulas/t4127-jan.html",
      note: "CRA T4127, 122nd edition (1 January 2026): CPP 5.95% (4.95% base + 1%), QPP 6.3% (5.3% + 1%), CPP2/QPP2 4% to 85,000; EI 1.63% (Quebec 1.30%) to 68,900 (read 2026-11-16)",
    },
    {
      url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/payroll/whats-new-payroll.html",
      note: "CRA: 2027 base CPP contribution rate change made by Bill C-30 (Royal Assent 18 June 2026); 2027 YMPE 76,700 and YAMPE 87,400 announced (read 2026-11-19)",
    },
    {
      url: "https://www.gov.mb.ca/finance/personal/ptaxes.html",
      note: 'Manitoba Finance: "Indexation of Manitoba\'s tax bracket thresholds to inflation is paused, effective for the 2025 tax year" (brackets 47,000 / 100,000); Manitoba Budget 2026 announces no bracket change and keeps the basic amount at 15,780. The CRA current-year page shows 47,564 / 101,200 for 2026, which disagrees with the province, the T4127 and the unchanged 2026 TD1MB basic amount: not resolved (read 2026-11-19)',
    },
    {
      url: "https://www.gov.nl.ca/budget/2026/what-you-need-to-know/a-plan-for-lower-taxes/",
      note: "NL Budget 2026: basic personal amount increased to $15,000; T4127 July 2026: 13,094 for the 2026 tax year (payroll uses 15,000 for the second half). 15,000 is used from 2027; whether it is indexed for 2027 is not confirmed (read 2026-11-19)",
    },
    {
      url: "https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5006-d/5006-d-25e.txt",
      note: "CRA 2025 provincial dividend tax credit worksheets 5001-D to 5014-D (one per province/territory, same path pattern) and federal 5000-D1: every DTC rate in the rows below except Quebec's matches the 2025 worksheet; 2026 worksheets not yet published (read 2026-11-19)",
    },
    {
      url: "https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5006-c/5006-c-25e.pdf",
      note: "CRA 2025 ON428 Part C: the surtax is worked on Ontario tax after non-refundable credits but before the Ontario dividend tax credit (lines 62-71); Ontario Health Premium chart, not indexed (read 2026-11-19)",
    },
    {
      url: "https://www.pm.gc.ca/en/news/news-releases/2025/03/21/prime-minister-mark-carney-cancels-proposed-capital-gains-tax-increase",
      note: "Prime Minister's Office (21 March 2025): the proposed increase in the capital gains inclusion rate is cancelled, so the enacted one-half applies (read 2026-11-19)",
    },
    {
      url: "https://www.canada.ca/en/revenue-agency/services/tax/registered-plans-administrators/pspa/mp-rrsp-dpsp-tfsa-limits-ympe.html",
      note: "CRA: 2026 RRSP dollar limit 33,810 (35,390 for 2027), TFSA 7,000, YMPE 74,600 / YAMPE 85,000 (read 2026-11-19)",
    },
    {
      url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/completing-slips-summaries/t4rsp-t4rif-information-returns/payments/chart-prescribed-factors.html",
      note: "CRA: RRIF prescribed factors ('All other RRIFs' column), 1 / (90 - age) to 70, 20% from 95 (read 2026-11-19)",
    },
    {
      url: "https://www.bcbudget.gov.bc.ca/2026/highlights/",
      note: 'BC Budget 2026: first rate 5.06% -> 5.60%; "B.C. will also pause tax bracket indexing from 2027 until 2030" (read 2026-11-19)',
    },
    {
      url: "https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/td1/td1-26e.pdf",
      note: "CRA 2026 TD1 and the provincial/territorial TD1 forms (pbg/td1ab/td1ab-26e.pdf ... pbg/td1yt/td1yt-26e.pdf, all but Quebec): age amounts, thresholds and 15% reduction, pension income amounts, Saskatchewan senior supplementary amount 2,569 (re-read 2026-11-19)",
    },
    {
      url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/payroll/payroll-deductions-contributions/canada-pension-plan-cpp/cpp-contribution-rates-maximums-exemptions.html",
      note: "CRA: 2026 YMPE 74,600, basic exemption 3,500, rate 5.95%; 2027 YMPE 76,700 at 5.75% (re-read 2026-11-19)",
    },
    {
      url: "https://www.canada.ca/en/services/benefits/publicpensions/cpp/contributions.html",
      note: 'Canada.ca, Contributions to the CPP: "At the age of 70, you no longer contribute to the CPP, even if you are still working" (read 2026-11-19)',
    },
    {
      url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/payroll/calculating-deductions/making-deductions/second-additional-cpp-contribution-rates-maximums.html",
      note: "CRA: 2026 CPP2 YAMPE 85,000 at 4% (read 2026-11-16)",
    },
    {
      url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/payroll/payroll-deductions-contributions/employment-insurance-ei/ei-premium-rates-maximums.html",
      note: "CRA: 2026 EI maximum insurable earnings 68,900; rate 1.63% (Quebec 1.30%) (read 2026-11-16)",
    },
    {
      url: "https://www.revenuquebec.ca/en/businesses/source-deductions-and-employer-contributions/employers-kit/principal-changes-for-2026-employers-kit/",
      note: "Revenu Québec 2026 changes: refused automated access (2026-11-16 and 2026-11-19); Quebec's three lower rates (14% / 19% / 24%) and dividend tax credits not confirmed from an official source",
    },
    {
      url: "https://cdn-contenu.quebec.ca/cdn-contenu/adm/min/finances/publications-adm/parametres/AUTFR_RegimeImpot2026.pdf",
      note: "Quebec Ministère des Finances, Paramètres du régime d'imposition des particuliers 2026 (November 2025), tableau 3: bracket thresholds 54,345 / 108,680 / 132,245, basic personal amount 18,952, indexation 2.05% (read 2026-11-19)",
    },
    {
      url: "https://www.gov.mb.ca/asset_library/en/budget2026/budget2026.pdf",
      note: "Manitoba Budget 2026, 'Interprovincial Comparison of 2026 Tax Rates' (current at 19 March 2026): Quebec basic personal amount 18,952 and top rate 25.75% (read 2026-11-19)",
    },
  ],
};

export const CA_PROVINCES_2026: CaProvince[] = [
  {
    code: "NL",
    name: "Newfoundland and Labrador",
    brackets: [
      [0, 0.087],
      [44_678, 0.145],
      [89_354, 0.158],
      [159_528, 0.178],
      [223_340, 0.198],
      [285_319, 0.208],
      [570_638, 0.213],
      [1_141_275, 0.218],
    ],
    // 2026: 13,094 (T4127 July 2026; NL Budget 2026 raised the amount to 15,000 part-way through
    // the year). 15,000 from 2027; whether it is indexed for 2027 is not confirmed.
    bpa: 13_094,
    bpaFrom: { year: 2027, amount: 15_000 },
    ageAmount: 7_142,
    ageThreshold: 39_138,
    pensionAmount: 1_000,
    dtcEligible: 0.063,
    dtcNonEligible: 0.032,
    approx:
      "the basic amount is 13,094 for 2026 and 15,000 from 2027; whether 15,000 is indexed for 2027 is not confirmed",
  },
  {
    code: "PE",
    name: "Prince Edward Island",
    brackets: [
      [0, 0.095],
      [33_928, 0.1347],
      [65_820, 0.166],
      [106_890, 0.1762],
      [142_520, 0.19],
      // New 20% rate over 200,000 for 2026 and later (PEI, 14 April 2026; T4127 July 2026).
      [200_000, 0.2],
    ],
    bpa: 15_000,
    ageAmount: 6_510,
    ageThreshold: 36_600,
    pensionAmount: 1_000,
    dtcEligible: 0.105,
    dtcNonEligible: 0.013,
  },
  {
    code: "NS",
    name: "Nova Scotia",
    brackets: [
      [0, 0.0879],
      [30_995, 0.1495],
      [61_991, 0.1667],
      [97_417, 0.175],
      [157_124, 0.21],
    ],
    bpa: 11_932,
    ageAmount: 5_826,
    ageThreshold: 30_828,
    pensionAmount: 1_173,
    dtcEligible: 0.0885,
    dtcNonEligible: 0.015,
  },
  {
    code: "NB",
    name: "New Brunswick",
    brackets: [
      [0, 0.094],
      [52_333, 0.14],
      [104_666, 0.16],
      [193_861, 0.195],
    ],
    bpa: 13_664,
    ageAmount: 6_158,
    ageThreshold: 45_844,
    pensionAmount: 1_000,
    dtcEligible: 0.14,
    dtcNonEligible: 0.0275,
  },
  {
    code: "QC",
    name: "Quebec",
    brackets: [
      [0, 0.14],
      [54_345, 0.19],
      [108_680, 0.24],
      [132_245, 0.2575],
    ],
    bpa: 18_952,
    ageAmount: 0,
    ageThreshold: 0,
    pensionAmount: 0,
    dtcEligible: 0.117,
    dtcNonEligible: 0.0342,
    approx:
      "Quebec age/pension amounts and the separate QC return are not modelled; Quebec's thresholds and basic amount are from Quebec's Ministère des Finances, but the three lower rates (14% / 19% / 24%) and Quebec's dividend tax credits are not confirmed from an official source (Revenu Québec could not be opened); the top rate of 25.75% is confirmed by the Manitoba Budget 2026 comparison",
  },
  {
    code: "ON",
    name: "Ontario",
    brackets: [
      [0, 0.0505],
      [53_891, 0.0915],
      [107_785, 0.1116],
      [150_000, 0.1216],
      [220_000, 0.1316],
    ],
    bpa: 12_989,
    ageAmount: 6_342,
    ageThreshold: 47_210,
    pensionAmount: 1_796,
    dtcEligible: 0.1,
    dtcNonEligible: 0.029863,
  },
  {
    code: "MB",
    name: "Manitoba",
    // Indexation paused from 2025 (Manitoba Finance; T4127 July 2026). CRA's current-year rates page
    // shows 47,564 / 101,200 instead: not resolved, see the MB source note.
    brackets: [
      [0, 0.108],
      [47_000, 0.1275],
      [100_000, 0.174],
    ],
    bpa: 15_780,
    bpaPhaseOut: [200_000, 400_000],
    frozenThrough: Number.POSITIVE_INFINITY,
    ageAmount: 3_728,
    ageThreshold: 27_749,
    pensionAmount: 1_000,
    dtcEligible: 0.08,
    dtcNonEligible: 0.007835,
    approx:
      "brackets 47,000 / 100,000 per the T4127 and Manitoba Finance; CRA's current-year rates page shows 47,564 / 101,200, a conflict not resolved. Indexation is paused with no end date, so 2026 amounts are kept in later years",
  },
  {
    code: "SK",
    name: "Saskatchewan",
    brackets: [
      [0, 0.105],
      [54_532, 0.125],
      [155_805, 0.145],
    ],
    bpa: 20_381,
    ageAmount: 5_901,
    ageThreshold: 43_927,
    pensionAmount: 1_000,
    seniorSupplement: 2_569,
    dtcEligible: 0.11,
    dtcNonEligible: 0.02519,
  },
  {
    code: "AB",
    name: "Alberta",
    brackets: [
      [0, 0.08],
      [61_200, 0.1],
      [154_259, 0.12],
      [185_111, 0.13],
      [246_813, 0.14],
      [370_220, 0.15],
    ],
    bpa: 22_769,
    ageAmount: 6_345,
    ageThreshold: 47_234,
    pensionAmount: 1_753,
    dtcEligible: 0.0812,
    dtcNonEligible: 0.0218,
  },
  {
    code: "BC",
    name: "British Columbia",
    brackets: [
      [0, 0.056],
      [50_363, 0.077],
      [100_728, 0.105],
      [115_648, 0.1229],
      [140_430, 0.147],
      [190_405, 0.168],
      [265_545, 0.205],
    ],
    bpa: 13_216,
    // Indexation of brackets and non-refundable credits paused at 2026 levels for 2027-2030.
    frozenThrough: 2030,
    ageAmount: 5_927,
    ageThreshold: 44_119,
    pensionAmount: 1_000,
    dtcEligible: 0.12,
    dtcNonEligible: 0.0196,
  },
  {
    code: "YT",
    name: "Yukon",
    brackets: [
      [0, 0.064],
      [58_523, 0.09],
      [117_045, 0.109],
      [181_440, 0.128],
      [500_000, 0.15],
    ],
    bpa: 16_452,
    bpaFollowsFederal: true,
    ageAmount: 9_208,
    ageThreshold: 46_432,
    pensionAmount: 2_000,
    dtcEligible: 0.1202,
    dtcNonEligible: 0.0067,
  },
  {
    code: "NT",
    name: "Northwest Territories",
    brackets: [
      [0, 0.059],
      [53_003, 0.086],
      [106_009, 0.122],
      [172_346, 0.1405],
    ],
    bpa: 18_198,
    ageAmount: 8_902,
    ageThreshold: 46_432,
    pensionAmount: 1_000,
    dtcEligible: 0.115,
    dtcNonEligible: 0.06,
  },
  {
    code: "NU",
    name: "Nunavut",
    brackets: [
      [0, 0.04],
      [55_801, 0.07],
      [111_602, 0.09],
      [181_439, 0.115],
    ],
    bpa: 19_659,
    ageAmount: 12_550,
    ageThreshold: 46_432,
    pensionAmount: 2_000,
    dtcEligible: 0.0551,
    dtcNonEligible: 0.0261,
  },
];

export const CA_PROVINCE_BY_CODE: Record<string, CaProvince> = Object.fromEntries(
  CA_PROVINCES_2026.map((p) => [p.code, p]),
);

/** Ontario surtax (on basic Ontario tax) and Ontario Health Premium (on taxable income), 2026. */
export const ONTARIO_2026 = {
  surtax: [
    [5_818, 0.2],
    [7_446, 0.36],
  ] as [number, number][],
  /** OHP: piecewise [income from, premium at from, slope, cap]. */
  healthPremium: [
    [20_000, 0, 0.06, 300],
    [36_000, 300, 0.06, 450],
    [48_000, 450, 0.25, 600],
    [72_000, 600, 0.25, 750],
    [200_000, 750, 0.25, 900],
  ] as [number, number, number, number][],
};

/** RRIF minimum withdrawal factors (Income Tax Regulations s.7308). Under 71: 1 / (90 - age). */
export const RRIF_FACTORS: Record<number, number> = {
  71: 0.0528,
  72: 0.054,
  73: 0.0553,
  74: 0.0567,
  75: 0.0582,
  76: 0.0598,
  77: 0.0617,
  78: 0.0636,
  79: 0.0658,
  80: 0.0682,
  81: 0.0708,
  82: 0.0738,
  83: 0.0771,
  84: 0.0808,
  85: 0.0851,
  86: 0.0899,
  87: 0.0955,
  88: 0.1021,
  89: 0.1099,
  90: 0.1192,
  91: 0.1306,
  92: 0.1449,
  93: 0.1634,
  94: 0.1879,
};
