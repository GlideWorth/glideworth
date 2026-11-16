/**
 * Canada, tax year 2026 (calendar year). Nominal CAD. Calculation: ../jurisdictions/ca.ts.
 * Sources (Canada Revenue Agency, all read 2026-11-16; listed in `CA_2026.sources`):
 *   2026 federal and provincial/territorial rates and brackets (CRA current-year page)
 *   2026 indexation amounts (federal BPA, age amount, Canada employment amount, OAS repayment)
 *   T4127 Payroll Deductions Formulas, 122nd edition (provincial BPAs, Ontario surtax, QPP, QPIP)
 *   2026 TD1 forms, federal and each province/territory except Quebec (age and pension amounts)
 *   CPP, CPP2 and EI 2026 rates and maximums
 * Quebec's own income tax brackets and basic amount come from Revenu Québec, whose site refused
 * automated access on 2026-11-16: they are not confirmed from an official source (see the QC row).
 * Provincial dividend tax credit rates and the Ontario Health Premium schedule were not re-checked;
 * rows flagged `approx` should be re-checked when updating.
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
    pensionAmount: 2_000,
    canadaEmploymentAmount: 1_501,
    dtcEligible: 0.150198,
    dtcNonEligible: 0.090301,
    quebecAbatement: 0.165,
  },
  dividends: { grossUpEligible: 0.38, grossUpNonEligible: 0.15 },
  capitalGainsInclusion: 0.5,
  cpp: {
    ympe: 74_600,
    yampe: 85_000,
    basicExemption: 3_500,
    baseRate: 0.0495,
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
      url: "https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4127-payroll-deductions-formulas/t4127-jan.html",
      note: "CRA T4127, 122nd edition (1 January 2026), tables 8.1-8.8: provincial basic amounts, Ontario surtax 20% over 5,818 and 36% over 7,446, Quebec abatement 16.5%, QPP 5.3% + 1% (read 2026-11-16)",
    },
    {
      url: "https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/td1/td1-26e.pdf",
      note: "CRA 2026 TD1 and the provincial/territorial TD1 forms (td1ab-26e.pdf ... td1yt-26e.pdf, all but Quebec): age amounts and thresholds, pension income amounts (read 2026-11-16)",
    },
    {
      url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/payroll/payroll-deductions-contributions/canada-pension-plan-cpp/cpp-contribution-rates-maximums-exemptions.html",
      note: "CRA: 2026 YMPE 74,600, basic exemption 3,500, rate 5.95% (read 2026-11-16)",
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
      note: "Revenu Québec 2026 changes: refused automated access on 2026-11-16; Quebec brackets and basic amount not confirmed from an official source",
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
    bpa: 11_188,
    ageAmount: 7_142,
    ageThreshold: 39_138,
    pensionAmount: 1_000,
    dtcEligible: 0.063,
    dtcNonEligible: 0.032,
    approx: "DTC rates",
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
      [200_000, 0.2],
    ],
    bpa: 15_000,
    ageAmount: 6_510,
    ageThreshold: 36_600,
    pensionAmount: 1_000,
    dtcEligible: 0.105,
    dtcNonEligible: 0.013,
    approx: "DTC rates",
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
    approx: "DTC rates",
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
    approx: "DTC rates",
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
      "Quebec age/pension amounts and the separate QC return are not modelled; Quebec brackets and basic amount not confirmed from an official source (Revenu Québec could not be opened)",
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
    brackets: [
      [0, 0.108],
      [47_564, 0.1275],
      [101_200, 0.174],
    ],
    bpa: 15_780,
    ageAmount: 3_728,
    ageThreshold: 27_749,
    pensionAmount: 1_000,
    dtcEligible: 0.08,
    dtcNonEligible: 0.007835,
    approx: "BPA phase-out ($200k-$400k) not modelled",
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
    dtcEligible: 0.11,
    dtcNonEligible: 0.02519,
    approx: "DTC rates",
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
    ageAmount: 9_208,
    ageThreshold: 46_432,
    pensionAmount: 2_000,
    dtcEligible: 0.1202,
    dtcNonEligible: 0.0067,
    approx: "DTC rates",
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
    approx: "DTC rates",
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
    approx: "DTC rates",
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
