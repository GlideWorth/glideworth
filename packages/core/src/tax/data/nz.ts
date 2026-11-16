/**
 * New Zealand (residents). Tax year 1 April `startYear` to 31 March `startYear + 1`; engine period
 * year Y uses the year starting 1 April Y. Nominal NZD. Calculation: ../jurisdictions/nz.ts.
 */

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

export const NZ_YEARS: readonly NzYear[] = [
  {
    startYear: 2026,
    label: "2026-27 (tax year ending 31 March 2027)",
    brackets: BRACKETS,
    acc: { rate: 0.0175, maxEarnings: 156_641 },
    imputationRate: 0.28,
    kiwisaver: { accessAge: 65 },
    sources: [
      {
        url: "https://www.ird.govt.nz/income-tax/income-tax-for-individuals/tax-codes-and-tax-rates-for-individuals/tax-rates-for-individuals",
        note: "IRD rate table headed 'From 1 April 2025' with no end date (page carries IR340 Apr 2026), so it covers 2026-27 (read 2026-11-16)",
      },
      {
        url: "https://www.ird.govt.nz/income-tax/income-tax-for-individuals/acc-clients-and-carers/acc-earners-levy-rates",
        note: "ACC earners levy 1.75% from 1 April 2026; maximum liable earnings 156,641",
      },
      {
        url: "https://www.ird.govt.nz/kiwisaver/kiwisaver-individuals/how-kiwisaver-works",
        note: "KiwiSaver: withdrawals from 65; contributions from taxed pay",
      },
    ],
  },
];

export const NZ_SIMPLIFICATIONS: readonly string[] = [
  "Tax year 1 April 2026 - 31 March 2027 is applied to calendar period 2026. Income tax rates are IRD’s rates from 1 April 2025, which IRD lists with no end date (checked 2026-11-16); later years carry them forward.",
  "New Zealand has no general capital gains tax: gains are not taxed. The bright-line test, land-dealing and trader rules, and the foreign investment fund (FIF) rules for overseas shares are not modelled.",
  "Dividends are assumed fully imputed at the 28% company rate (gross-up and credit). Interest is taxed at the marginal rate; RWT/PIE prescribed investor rates are not modelled.",
  "KiwiSaver contributions come from taxed pay (no deduction); fund earnings are taxed inside the fund (PIE) and withdrawals from 65 are tax-free. The government contribution and employer contribution tax (ESCT) are not modelled.",
  "Not modelled: the independent earner tax credit, Working for Families, student loan repayments.",
];
