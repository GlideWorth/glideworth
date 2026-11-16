/**
 * United Arab Emirates (individuals). Tax year = calendar year. AED, pegged to the US dollar.
 * Calculation: ../jurisdictions/ae.ts. Every figure below carries its official source; anything
 * that could not be confirmed from an official source is left out and listed in AE_SIMPLIFICATIONS.
 */

export interface AeSource {
  url: string;
  note?: string;
}

export interface AeYear {
  startYear: number;
  label: string;
  /** Individuals: no personal income tax, CGT, tax on dividends/interest, wealth or inheritance tax. */
  personalIncomeTax: 0;
  /**
   * Out of scope, listed so the UI can say so: Corporate Tax on a natural person's business
   * turnover above the threshold (wages, personal investment and unlicensed real-estate income are
   * excluded) and VAT.
   */
  corporateTaxOnBusiness: { turnoverThreshold: number; zeroRateBand: number; standardRate: number };
  vatRate: number;
  sources: AeSource[];
}

export const AE_YEARS: readonly AeYear[] = [
  {
    startYear: 2026,
    label: "2026 (calendar year)",
    personalIncomeTax: 0,
    corporateTaxOnBusiness: {
      turnoverThreshold: 1_000_000,
      zeroRateBand: 375_000,
      standardRate: 0.09,
    },
    vatRate: 0.05,
    sources: [
      {
        url: "https://tax.gov.ae/en/taxes/corporate.tax/corporate.tax.topics/basis.of.taxation.natural.person.aspx",
        note: "FTA: a natural person is subject to Corporate Tax only on Business Activities whose turnover exceeds AED 1,000,000 in a calendar year (Cabinet Decision No. 49 of 2023); wages, personal investment income and unlicensed real-estate investment income are not Business Activities. Not modelled.",
      },
      {
        url: "https://tax.gov.ae/DataFolder/Files/Legislation/05-06-2023/3/Cabinet%20Decision%20No.%2049%20of%202023%20-%20for%20publishing.pdf",
        note: "Cabinet Decision No. 49 of 2023 (natural persons conducting business), in force 1 June 2023",
      },
      {
        url: "https://mof.gov.ae/en/news/ministry-of-finance-announces-issuance-of-uae-cabinet-decision-on-treatment-of-natural-persons-undertaking-a-business-or-business-activity/",
        note: "Ministry of Finance: personal income from employment, investments and real estate (without a licence) is not subject to Corporate Tax",
      },
    ],
  },
];

// ------------------------------------------------------------------ end-of-service gratuity

/**
 * End-of-service gratuity for expatriate employees in the private sector (Federal Decree-Law No. 33
 * of 2021, Article 51), as published on the UAE government portal:
 *   - nothing for less than 1 year of continuous service;
 *   - 21 days' basic wage for each of the first 5 years, 30 days' for each year after;
 *   - fractions of a year pro rata (once 1 year is completed);
 *   - computed on the last basic wage (allowances excluded);
 *   - the total may not exceed 2 years' wage.
 */
export const AE_GRATUITY = {
  minYears: 1,
  daysFirstFiveYears: 21,
  daysAfterFiveYears: 30,
  firstTierYears: 5,
  capYearsOfWage: 2,
  /**
   * Daily wage convention: monthly basic wage / 30. This is Glideworth's convention (the portal gives
   * the rule in days of wage but no daily-wage formula); annual basic / 365 gives about 1.4% less.
   */
  daysPerMonth: 30,
  sources: [
    {
      url: "https://u.ae/en/information-and-services/jobs/Sector-of-employment/employment-in-the-private-sector/end-of-service-benefits-for-employees-in-the-private-sector",
      note: "UAE government portal (2026): Article 51 of the Labour Law; 21 days per year for years 1-5, 30 days per year after, pro rata for fractions after one year, last basic wage, total capped at 2 years of wage",
    },
  ] as AeSource[],
} as const;

/**
 * Gratuity for `years` of continuous service with a final MONTHLY basic wage of `monthlyBasic`.
 * The cap is applied to 2 years of basic wage (the portal says "the wage of 2 years"; whether the
 * cap uses basic or total wage is not settled there, and basic is the conservative reading).
 */
export function aeGratuity(years: number, monthlyBasic: number): number {
  const g = AE_GRATUITY;
  if (!(years >= g.minYears) || !(monthlyBasic > 0)) return 0;
  const daily = monthlyBasic / g.daysPerMonth;
  const first = Math.min(years, g.firstTierYears);
  const rest = Math.max(0, years - g.firstTierYears);
  const days = first * g.daysFirstFiveYears + rest * g.daysAfterFiveYears;
  return Math.min(days * daily, g.capYearsOfWage * 12 * monthlyBasic);
}

// ------------------------------------------------------------------ savings schemes

/**
 * DIFC Employee Workplace Savings (DEWS): replaces the gratuity for DIFC employees. Employer pays a
 * share of the monthly basic wage; employees may add voluntary savings (no cap confirmed).
 */
export const AE_DEWS = {
  employerRateUnder5Years: 0.0583,
  employerRateFrom5Years: 0.0833,
  sources: [
    {
      url: "https://assets.difc.com/v1/media/edge/images/dubaiintern0078-difcexperie96c5-production-3253/media/project/difcexperiences/difc/difcwebsite/documents/laws--regulations/employment-law.pdf",
      note: "DIFC Employment Law No. 2 of 2019 (consolidated July 2025): employer contributions 5.83% of monthly basic wage for the first five years of service, 8.33% for each year after",
    },
    {
      url: "https://www.difc.com/business/qualifying-schemes",
      note: "DEWS: voluntary employee savings on top of employer contributions (no cap published there)",
    },
  ] as AeSource[],
} as const;

/**
 * Voluntary alternative end-of-service benefits (savings) scheme, Cabinet Resolution No. 96 of
 * 2023: an employer that joins pays a monthly contribution on basic salary into an approved fund
 * instead of the gratuity; employees may top up to 25% of their wage (top-ups are not part of the
 * end-of-service benefit); the balance is paid out within 14 days of the end of service.
 */
export const AE_SAVINGS_SCHEME = {
  employerRateUnder5Years: 0.0583,
  employerRateFrom5Years: 0.0833,
  voluntaryCapShareOfWage: 0.25,
  sources: [
    {
      url: "https://www.mohre.gov.ae/en/media-centre/news/1/11/2023/voluntary-alternative-end-of-service-benefits-scheme-goes-into-effect-by-cabinet-resolution-aiming-to-boost-ease-of-doing-business-generate-investment-returns-for-employees.aspx",
      note: "MOHRE: Cabinet Resolution No. 96 of 2023 in force; employer contribution 5.83% of basic salary under five years of service, 8.33% from five years",
    },
    {
      url: "https://www.mohre.gov.ae/en/faq.aspx",
      note: "MOHRE FAQ: voluntary employee top-ups up to 25% of the wage, not part of the end-of-service benefit",
    },
  ] as AeSource[],
} as const;

// ------------------------------------------------------------------ GPSSA (UAE nationals)

/**
 * General Pension and Social Security Authority, Federal Decree-Law No. 57 of 2023 (UAE nationals
 * whose first job starts on or after 31 October 2023). Basic level only: contribution rates, the salary
 * ceiling and the accrual formula. Eligibility ages and the older law's rates are not modelled.
 */
export const AE_GPSSA = {
  employeeRate: 0.11,
  employerRate: 0.15,
  /** Share of the private employer's rate paid by the government below the salary threshold. */
  governmentSupportRate: 0.025,
  governmentSupportBelowMonthlySalary: 20_000,
  maxMonthlySalaryPrivate: 70_000,
  maxMonthlySalaryGovernment: 100_000,
  accrualPerYearTo30: 0.0267,
  accrualPerYearAfter30: 0.04,
  maxReplacement: 1,
  averagingYears: 6,
  sources: [
    {
      url: "https://www.gpssa.gov.ae/pages/en/media-center/news/gpssa-reviews-most-prominent-features-federal-law-no-57-2023",
      note: "GPSSA (Nov 2023): total contribution 26% (insured 11%, employer 15%; government bears 2.5% of the private employer share below AED 20,000); contribution salary ceiling AED 70,000 private / 100,000 government; pension 2.67% of the calculation salary per year to 30 years, +4% a year beyond, at most 100%; calculation salary = average of the last six years",
    },
    {
      url: "https://u.ae/en/information-and-services/jobs/Sector-of-employment/working-in-uae-government-sector/pensions-and-social-security-for-uae-citizens",
      note: "Scope of the new law: UAE nationals whose first job starts on or after 31 October 2023",
    },
  ] as AeSource[],
} as const;

/** GPSSA pension as a share of the calculation salary after `years` of contributions. */
export function aeGpssaReplacementRate(years: number): number {
  const g = AE_GPSSA;
  const y = Math.max(0, years);
  return Math.min(
    g.maxReplacement,
    Math.min(y, 30) * g.accrualPerYearTo30 + Math.max(0, y - 30) * g.accrualPerYearAfter30,
  );
}

/** Monthly GPSSA contributions on a monthly contribution salary (private sector). */
export function aeGpssaContributions(monthlySalary: number): {
  employee: number;
  employer: number;
  government: number;
} {
  const g = AE_GPSSA;
  const base = Math.min(Math.max(0, monthlySalary), g.maxMonthlySalaryPrivate);
  const support = base < g.governmentSupportBelowMonthlySalary ? g.governmentSupportRate : 0;
  return {
    employee: base * g.employeeRate,
    employer: base * (g.employerRate - support),
    government: base * support,
  };
}

// ------------------------------------------------------------------ currency peg

/** AED is pegged to the US dollar: 3.6725 AED per USD (Central Bank of the UAE). */
export const AED_PER_USD = 3.6725;
export const AE_PEG_SOURCE: AeSource = {
  url: "https://www.centralbank.ae/",
  note: "Central Bank of the UAE: the dirham is pegged to the US dollar at 3.6725 (fixed since 1997)",
};

export const AE_SIMPLIFICATIONS: readonly string[] = [
  "The UAE levies no personal income tax, capital gains tax, tax on dividends or interest, wealth tax or inheritance tax on individuals: the UAE tax line is always zero.",
  "Out of scope: Corporate Tax on a natural person whose business or freelance-licence turnover exceeds AED 1 million a year (9% above AED 375,000 of taxable income), and VAT (5%) on spending. Model business tax as an expense if it applies.",
  "End-of-service gratuity: Article 51 rules (21 days of basic wage per year for the first five years, 30 days after, pro rata after one year, capped at two years of wage) with a daily wage of monthly basic / 30 (Glideworth convention). Reductions for resignation under the old law, unpaid leave days and limited-contract rules are not modelled.",
  "DEWS and the federal savings scheme are modelled as accounts: enter employer contributions as an employer contribution flow (5.83% of basic wage, 8.33% after five years of service). The scheme replaces the gratuity: do not also set a gratuity on that salary.",
  "GPSSA (UAE nationals): basic level only. Use aeGpssaReplacementRate / aeGpssaContributions to set up a defined-benefit pension on the salary; eligibility ages, early-retirement reductions, the pre-2023 law and GCC nationals contributing to their home schemes are not modelled.",
  "Expatriates have no UAE state pension.",
];
