/**
 * Ireland (resident, domiciled). Calendar tax year. Nominal EUR. Calculation: ../jurisdictions/ie.ts.
 */

export interface IeYear {
  startYear: number;
  label: string;
  rates: { standard: number; higher: number };
  bands: { single: number; singleParent: number; married: number; secondEarnerMax: number };
  credits: {
    personalSingle: number;
    personalMarried: number;
    employee: number;
    earned: number;
    ageSingle: number;
    ageMarried: number;
    ageFrom: number;
  };
  usc: { rows: [number, number][]; exemptUpTo: number };
  /** Class A employee PRSI averaged over the year (4.2% Jan-Sep, 4.35% from 1 Oct 2026). */
  prsi: { rate: number; weeklyThreshold: number; untilAge: number };
  dirt: number;
  /** CGT on most gains; 2026 averages 33% (to 6 Oct) and 31% (from 7 Oct) by days. */
  cgt: { rate: number; exemption: number };
  pensionRelief: { bands: [number, number][]; earningsCap: number; accessAge: number };
  sources: { url: string; note?: string }[];
}

const Y2026: IeYear = {
  startYear: 2026,
  label: "2026",
  rates: { standard: 0.2, higher: 0.4 },
  bands: { single: 44_000, singleParent: 48_000, married: 53_000, secondEarnerMax: 35_000 },
  credits: {
    personalSingle: 2_000,
    personalMarried: 4_000,
    employee: 2_000,
    earned: 2_000,
    ageSingle: 245,
    ageMarried: 490,
    ageFrom: 65,
  },
  usc: {
    rows: [
      [0, 0.005],
      [12_012, 0.02],
      [28_700, 0.03],
      [70_044, 0.08],
    ],
    exemptUpTo: 13_000,
  },
  prsi: { rate: (0.042 * 9 + 0.0435 * 3) / 12, weeklyThreshold: 352, untilAge: 66 },
  dirt: 0.33,
  // 33% for disposals to 6 October 2026 (279 days), 31% from 7 October 2026 (86 days).
  cgt: { rate: (0.33 * 279 + 0.31 * 86) / 365, exemption: 1_270 },
  pensionRelief: {
    bands: [
      [0, 0.15],
      [30, 0.2],
      [40, 0.25],
      [50, 0.3],
      [55, 0.35],
      [60, 0.4],
    ],
    earningsCap: 115_000,
    accessAge: 60,
  },
  sources: [
    {
      url: "https://www.revenue.ie/en/personal-tax-credits-reliefs-and-exemptions/tax-relief-charts/index.aspx",
      note: "Rate bands and tax credits 2026",
    },
    {
      url: "https://www.revenue.ie/en/jobs-and-pensions/usc/standard-rates-thresholds.aspx",
      note: "USC 2026: 0.5% / 2% / 3% / 8% at 12,012 / 28,700 / 70,044",
    },
    {
      url: "https://www.revenue.ie/en/jobs-and-pensions/usc/index.aspx",
      note: "USC not payable when total income is 13,000 or less",
    },
    {
      url: "https://assets.gov.ie/static/documents/cb168977/PRSI_C20260116_Contribution_Rates_and_User_Guide_-_SW_14_-_English_Version_-_January_2026_.pdf-web.pdf",
      note: "Class A employee 4.2% (4.35% from 1 Oct 2026); no employee PRSI at 352/week or less",
    },
    {
      url: "https://www.revenue.ie/en/gains-gifts-and-inheritance/transfering-an-asset/how-to-calculate-cgt.aspx",
      note: "CGT 31% for most gains from 7 October 2026 (33% from 6 December 2021 to 6 October 2026); 1,270 annual exemption (page published 7 October 2026, read 2026-11-16)",
    },
    {
      url: "https://www.revenue.ie/en/tax-professionals/tdm/pensions/chapter-03.pdf",
      note: "Age-related pension relief limits, 115,000 earnings limit",
    },
    {
      url: "https://www.revenue.ie/en/jobs-and-pensions/pensions/tax-relief-for-pension-contributions.aspx",
      note: "No USC/PRSI relief on pension contributions",
    },
    {
      url: "https://www.revenue.ie/en/additional-incomes/dirt/what-dirt-rate-is-applicable.aspx",
      note: "DIRT 33%",
    },
  ],
};

/** 2027 onward: the 2026 tables carried forward, with CGT at 31% for the whole year. */
const Y2027: IeYear = {
  ...Y2026,
  startYear: 2027,
  label: "2027 (2026 tables, CGT 31%)",
  cgt: { ...Y2026.cgt, rate: 0.31 },
  sources: Y2026.sources.filter((s) => s.url.includes("how-to-calculate-cgt")),
};

export const IE_YEARS: readonly IeYear[] = [Y2026, Y2027];

export const IE_SIMPLIFICATIONS: readonly string[] = [
  "Tax year 2026; later years carry the 2026 bands and credits forward. CGT on most gains is 33% to 6 October 2026 and 31% from 7 October 2026: Glideworth has no disposal dates, so 2026 gains use the average by days (32.53%) and later years 31%; the 33% rate on development land and the other special rates are not modelled. PRSI uses the 2026 average of 4.2% and 4.35%; the PRSI credit taper and PRSI on unearned income are not modelled.",
  "Married couples are jointly assessed (band 53,000 plus up to 35,000 for the second income); single parents get the 48,000 band but not the Single Person Child Carer Credit.",
  "Deposit interest pays DIRT at 33%; all other interest, dividends and fund distributions are taxed as income (exit tax on funds and deemed disposals are not modelled).",
  "USC: State Pension and other social welfare income are exempt (incomeType state-pension); reduced USC rates for over-70s and medical card holders are not modelled.",
  "Pension relief is limited by the age-related percentage of earnings capped at 115,000; employer contributions, the standard fund threshold and lump-sum rules are not modelled.",
];
