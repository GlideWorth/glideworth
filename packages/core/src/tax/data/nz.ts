/**
 * New Zealand (residents). Tax year 1 April `startYear` to 31 March `startYear + 1`; engine period
 * year Y uses the year starting 1 April Y. Nominal NZD. Calculation: ../jurisdictions/nz.ts.
 * Sources: Inland Revenue (ird.govt.nz), read 2026-11-19; listed with each year.
 */

/** Rates and thresholds below are nominal amounts set in law, not indexed, through this year. */
export const NZ_PUBLISHED_THROUGH = 2027;

export interface NzYear {
  startYear: number;
  label: string;
  brackets: [number, number][];
  acc: { rate: number; maxEarnings: number };
  /** Company tax rate used for imputation credits (dividends assumed fully imputed). */
  imputationRate: number;
  kiwisaver: { accessAge: number };
  sources: { url: string; note?: string }[];
}

const BRACKETS: [number, number][] = [
  [0, 0.105],
  [15_600, 0.175],
  [53_500, 0.3],
  [78_100, 0.33],
  [180_000, 0.39],
];

const SOURCES: NzYear["sources"] = [
  {
    url: "https://www.ird.govt.nz/income-tax/income-tax-for-individuals/tax-codes-and-tax-rates-for-individuals/tax-rates-for-individuals",
    note: "IRD rate table headed 'From 1 April 2025' with no end date: 10.5% to 15,600, 17.5% to 53,500, 30% to 78,100, 33% to 180,000, 39% above (read 2026-11-19)",
  },
  {
    url: "https://www.ird.govt.nz/income-tax/income-tax-for-individuals/acc-clients-and-carers/acc-earners-levy-rates",
    note: "ACC earners' levy (GST inclusive): 1.75% for 2026-27 on earnings up to 156,641 (maximum levy 2,741.22); 1.83% for 2027-28 up to 160,244 (maximum 2,932.47) (read 2026-11-19)",
  },
  {
    url: "https://www.ird.govt.nz/kiwisaver/kiwisaver-individuals/how-kiwisaver-works",
    note: "KiwiSaver: contributions from before-tax pay (default 3.5%), employer minimum 3.5%; government contribution up to 260.72 for taxable income of 180,000 or less; NZ Super from 65 (read 2026-11-19)",
  },
];

export const NZ_YEARS: readonly NzYear[] = [
  {
    startYear: 2026,
    label: "2026-27 (tax year ending 31 March 2027)",
    brackets: BRACKETS,
    acc: { rate: 0.0175, maxEarnings: 156_641 },
    imputationRate: 0.28,
    kiwisaver: { accessAge: 65 },
    sources: SOURCES,
  },
  {
    startYear: 2027,
    label: "2027-28 (tax year ending 31 March 2028)",
    brackets: BRACKETS,
    acc: { rate: 0.0183, maxEarnings: 160_244 },
    imputationRate: 0.28,
    kiwisaver: { accessAge: 65 },
    sources: SOURCES,
  },
];

export const NZ_SIMPLIFICATIONS: readonly string[] = [
  "Tax year 1 April 2026 - 31 March 2027 is applied to calendar period 2026. Income tax rates are IRD’s rates from 1 April 2025, which IRD lists with no end date (checked 2026-11-19); the ACC earners’ levy is 1.75% up to 156,641 for 2026-27 and 1.83% up to 160,244 for 2027-28. These are not indexed in law, so they keep their values through 2027-28; later years index thresholds with the plan threshold policy.",
  "New Zealand has no general capital gains tax: gains are not taxed. The bright-line test, land-dealing and trader rules, and the foreign investment fund (FIF) rules for overseas shares are not modelled.",
  "Dividends are assumed fully imputed at the 28% company rate (gross-up and credit). Interest is taxed at the marginal rate; RWT and the prescribed investor rates of PIE funds are not modelled.",
  "KiwiSaver contributions come from taxed pay (no deduction); fund earnings are taxed inside the fund (PIE) and withdrawals from 65 are tax-free. The government contribution (up to 260.72 a year, for incomes up to 180,000) and the employer superannuation contribution tax (ESCT) on employer contributions are not modelled.",
  "Not modelled: the independent earner tax credit, Working for Families and student loan repayments. NZ Superannuation is an amount you enter; it is taxed as income.",
];
