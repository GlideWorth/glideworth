/**
 * Australia, resident individuals. Income year 1 July `startYear` to 30 June `startYear + 1`;
 * engine period year Y uses income year Y/Y+1. Nominal AUD. Calculation: ../jurisdictions/au.ts.
 */

export interface AuYear {
  startYear: number;
  label: string;
  brackets: [number, number][];
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
    url: "https://www.ato.gov.au/tax-rates-and-codes/tax-rates-australian-residents",
    note: "Resident rates; 16% -> 15% from 1 July 2026, 14% from 1 July 2027 (Treasury Laws Amendment (Cost of Living Tax Cuts) Act 2024 / 2025 amendments)",
  },
  {
    url: "https://www.ato.gov.au/individuals-and-families/medicare-and-private-health-insurance/medicare-levy/medicare-levy-reduction-for-low-income-earners",
    note: "Medicare levy low-income thresholds: 2024-25 values (singles 27,222; families 45,907 + 4,216 per child; single seniors 43,020), used for every year. ATO pages refuse automated access; checked against the Budget paper below on 2026-11-16",
  },
  {
    url: "https://budget.gov.au/content/bp2/download/bp2_2026-27.pdf",
    note: "2026-27 Budget Paper No. 2: the 2024-25 thresholds (27,222 / 45,907 / 4,216 / 43,020) are to rise 2.9% from 1 July 2025 (singles 28,011); not applied. No 2026-27 thresholds published (read 2026-11-16)",
  },
  {
    url: "https://www.ato.gov.au/tax-rates-and-codes/key-superannuation-rates-and-thresholds/contributions-caps",
    note: "Concessional cap $32,500 and non-concessional cap $130,000 from 1 July 2026",
  },
  {
    url: "https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/tax-offsets/low-income-tax-offset",
    note: "LITO",
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
  medicare: {
    rate: 0.02,
    singleThreshold: 27_222,
    familyThreshold: 45_907,
    perChild: 4_216,
    shadeInRate: 0.1,
    seniorSingleThreshold: 43_020,
    dataYear: "2024-25",
  },
  lito: { max: 700, taper1Start: 37_500, taper1Rate: 0.05, taper2Start: 45_000, taper2Rate: 0.015 },
  cgtDiscount: 0.5,
  franking: { corporateRate: 0.3 },
  super: {
    contributionsTax: 0.15,
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
