/**
 * Australia, resident and foreign-resident individuals. Income year 1 July `startYear` to 30 June `startYear + 1`;
 * engine period year Y uses income year Y/Y+1. Nominal AUD. Calculation: ../jurisdictions/au.ts.
 * Sources (re-checked 2026-11-19; listed in `SOURCES`): the rate tables and Medicare thresholds
 * from the amending Acts on the Federal Register of Legislation; the super contribution caps from the
 * ATO "Contributions caps" page and ITAA 1997 s 291-20 and s 292-85 (read 2026-11-22).
 */

/** Rates and thresholds below are legislated nominal amounts, not indexed, through this year. */
export const AU_LEGISLATED_THROUGH = 2027;

export interface AuYear {
  startYear: number;
  label: string;
  brackets: [number, number][];
  /**
   * Foreign residents (Income Tax Rates Act 1986 Schedule 7 Part II): no tax-free threshold. The
   * first two rates are defined as the second and third resident personal tax rates (s 3(1)).
   */
  foreignResidentBrackets: [number, number][];
  medicare: {
    rate: number;
    /** Low-income threshold (single), family threshold and per-child increment; shade-in rate. */
    singleThreshold: number;
    familyThreshold: number;
    perChild: number;
    shadeInRate: number;
    seniorSingleThreshold: number;
    dataYear: string;
  };
  lito: {
    max: number;
    taper1Start: number;
    taper1Rate: number;
    taper2Start: number;
    taper2Rate: number;
  };
  cgtDiscount: number;
  franking: { corporateRate: number };
  super: {
    contributionsTax: number;
    concessionalCap: number;
    nonConcessionalCap: number;
    div293Threshold: number;
    div293Rate: number;
    preservationAge: number;
    taxFreeAge: number;
    /** Offset on the taxable component of benefits taken between preservation age and 60. */
    underSixtyOffset: number;
  };
  sources: { url: string; note?: string }[];
}

const SOURCES = [
  {
    url: "https://www.legislation.gov.au/C2025A00028/asmade/text",
    note: "Treasury Laws Amendment (More Cost of Living Relief) Act 2025 (No. 28, 2025), Schedule 1: Income Tax Rates Act 1986 Schedule 7 resident rates for 2026-27 (15% / 30% / 37% / 45% over 45,000 / 135,000 / 190,000) and for 2027-28 and later (14% first rate). 2025-26: 16% (Treasury Laws Amendment (Cost of Living Tax Cuts) Act 2024) (read 2026-11-19)",
  },
  {
    url: "https://www.legislation.gov.au/C2026A00058/asmade/text",
    note: "Treasury Laws Amendment (Delivering an Efficient and Trusted Tax System) Act 2026 (No. 58, assented 30 June 2026), Schedule 5: Medicare levy low-income thresholds for 2025-26 and later years: singles 27,222 -> 28,011 (phase-in limit 35,013); families 45,907 -> 47,238 plus 4,216 -> 4,338 per child; single seniors and pensioners 43,020 -> 44,268 (phase-in limit 55,335) (read 2026-11-19)",
  },
  {
    url: "https://budget.gov.au/content/bp2/download/bp2_2026-27.pdf",
    note: "2026-27 Budget Paper No. 2, 'Increasing the Medicare levy low-income thresholds': the same figures, from 1 July 2025 (read 2026-11-19)",
  },
  {
    url: "https://www.ato.gov.au/tax-rates-and-codes/key-superannuation-rates-and-thresholds/contributions-caps",
    note: "ATO 'Contributions caps' (last updated 11 September 2026), Table 1.1 'Concessional contributions caps': 2026-27 $32,500, 2025-26 $30,000; Table 4 'Non-concessional contributions cap': 2026-27 $130,000, 2025-26 $120,000 (read 2026-11-22)",
  },
  {
    url: "https://www.legislation.gov.au/C2004A05138/2026-10-01/2026-10-01/text/original/epub/OEBPS/document_6/document_6.html",
    note: "Income Tax Assessment Act 1997, compilation No. 268 (1 October 2026), volume 6: s 291-20(2) concessional cap $25,000 for 2017-18, indexed annually (Subdivision 960-M, s 960-285); s 292-85(2)(a) non-concessional cap is 4 times the s 291-20(2) concessional cap (4 x 32,500 = 130,000 for 2026-27); s 292-85(3)-(5) bring-forward of up to 3 times that cap, not modelled (read 2026-11-22)",
  },
  {
    url: "https://www.legislation.gov.au/C2026A00008/asmade/text",
    note: "Treasury Laws Amendment (Building a Stronger and Fairer Super System) Act 2026 (No. 8, assented 13 March 2026): Division 296 tax on earnings for total super balances over 3,000,000 (and over 10,000,000) from 2026-27; not modelled (read 2026-11-19)",
  },
  {
    url: "https://www.legislation.gov.au/C2004A03348/2026-07-01/2026-07-01/text/original/epub/OEBPS/document_1/document_1.html",
    note: "Income Tax Rates Act 1986, Compilation No. 66 (1 July 2026), Schedule 7 Part II, 'Tax rates for non-resident taxpayers for the 2024-25 year of income or a later year of income': up to 135,000 the second resident personal tax rate, 135,000-190,000 the third resident personal tax rate, over 190,000 45%; s 3(1) defines those as items 2 and 3 of the Part I table (30% and 37% for 2025-26, 2026-27 and 2027-28 or later). No tax-free threshold (read 2026-11-22)",
  },
  {
    url: "https://www.legislation.gov.au/C2004A05138/2026-10-01/2026-10-01/text/original/epub/OEBPS/document_2/document_2.html",
    note: "Income Tax Assessment Act 1997, Compilation No. 268 (1 October 2026), Volume 2, s 61-110(1)(a): LITO only for an individual who is an Australian resident at any time during the income year, so none for a foreign resident all year (read 2026-11-22)",
  },
  {
    url: "https://www.legislation.gov.au/C1936A00027/2026-10-01/2026-10-01/text/original/epub/OEBPS/document_4/document_4.html",
    note: "Income Tax Assessment Act 1936, Compilation No. 193 (1 October 2026), Volume 4, s 251T(a) (Medicare levy not payable by a person who was a prescribed person for the whole year) and s 251U(1)(d) (a non-resident for the whole period is a prescribed person; s 251U(2): only if every dependant is too) (read 2026-11-22)",
  },
  {
    url: "https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/tax-offsets/low-income-tax-offset",
    note: "LITO 700, reduced by 5% of income over 37,500 and 1.5% over 45,000 (Income Tax Assessment Act 1997 s 61-115); ATO page refused automated access",
  },
];

const Y2026: AuYear = {
  startYear: 2026,
  label: "2026-27",
  brackets: [
    [0, 0],
    [18_200, 0.15],
    [45_000, 0.3],
    [135_000, 0.37],
    [190_000, 0.45],
  ],
  // Schedule 7 Part II: the same for 2024-25 and later years (Compilation No. 66, read 2026-11-22).
  foreignResidentBrackets: [
    [0, 0.3],
    [135_000, 0.37],
    [190_000, 0.45],
  ],
  medicare: {
    rate: 0.02,
    singleThreshold: 28_011,
    familyThreshold: 47_238,
    perChild: 4_338,
    shadeInRate: 0.1,
    seniorSingleThreshold: 44_268,
    dataYear: "2025-26 and later (Act No. 58 of 2026)",
  },
  lito: { max: 700, taper1Start: 37_500, taper1Rate: 0.05, taper2Start: 45_000, taper2Rate: 0.015 },
  cgtDiscount: 0.5,
  franking: { corporateRate: 0.3 },
  super: {
    contributionsTax: 0.15,
    // ATO "Contributions caps" Tables 1.1 and 4 for 2026-27; ITAA 1997 s 291-20, s 292-85(2)(a) (read 2026-11-22)
    concessionalCap: 32_500,
    nonConcessionalCap: 130_000,
    div293Threshold: 250_000,
    div293Rate: 0.15,
    preservationAge: 60,
    taxFreeAge: 60,
    underSixtyOffset: 0.15,
  },
  sources: SOURCES,
};

export const AU_YEARS: readonly AuYear[] = [
  {
    ...Y2026,
    startYear: 2025,
    label: "2025-26",
    brackets: [
      [0, 0],
      [18_200, 0.16],
      [45_000, 0.3],
      [135_000, 0.37],
      [190_000, 0.45],
    ],
    super: { ...Y2026.super, concessionalCap: 30_000, nonConcessionalCap: 120_000 },
  },
  Y2026,
  {
    ...Y2026,
    startYear: 2027,
    label: "2027-28 (legislated)",
    brackets: [
      [0, 0],
      [18_200, 0.14],
      [45_000, 0.3],
      [135_000, 0.37],
      [190_000, 0.45],
    ],
  },
];

/** Minimum annual pension-phase drawdown (SIS Regulations Schedule 7) by age. */
export function auMinimumDrawdownRate(age: number): number {
  if (age < 65) return 0.04;
  if (age < 75) return 0.05;
  if (age < 80) return 0.06;
  if (age < 85) return 0.07;
  if (age < 90) return 0.09;
  if (age < 95) return 0.11;
  return 0.14;
}
