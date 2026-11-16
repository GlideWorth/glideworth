/**
 * Israel (residents). Calendar tax year. Nominal ILS. Calculation: ../jurisdictions/il.ts.
 *
 * 2026: brackets after the Economic Efficiency Law 2026 (20% band to 228,000 and 31% band to
 * 301,200 a year; other brackets and the credit point frozen at 2025 values for 2025-2027).
 * Not confirmed from an official source: the Israel Tax Authority (gov.il) and the National
 * Insurance Institute (btl.gov.il) refused automated access again on 2026-11-16, so the bracket
 * edges, credit point, capital-income rates, surtax threshold and National Insurance rates could not
 * be checked against them. The figures are unchanged; they match each other in several independent
 * publications, none of which is cited as a source.
 */

export interface IlYear {
  startYear: number;
  label: string;
  brackets: [number, number][];
  creditPoint: number;
  residentPoints: number;
  surtax: { threshold: number; rate: number; capitalExtra: number };
  capital: { rate: number };
  /** Employee Bituach Leumi + health: reduced rate up to `reducedUpTo`, full rate up to `max` (annual). */
  nationalInsurance: {
    reducedRate: number;
    fullRate: number;
    reducedUpTo: number;
    max: number;
    untilAge: number;
  };
  pension: { creditRate: number; wageShare: number; accessAge: number };
  sources: { url: string; note?: string }[];
}

const Y2026: IlYear = {
  startYear: 2026,
  label: "2026",
  brackets: [
    [0, 0.1],
    [84_120, 0.14],
    [120_720, 0.2],
    [228_000, 0.31],
    [301_200, 0.35],
    [560_280, 0.47],
  ],
  creditPoint: 2_904,
  residentPoints: 2.25,
  surtax: { threshold: 721_560, rate: 0.03, capitalExtra: 0.02 },
  capital: { rate: 0.25 },
  nationalInsurance: {
    reducedRate: 0.0104 + 0.0323,
    fullRate: 0.07 + 0.0517,
    reducedUpTo: 7_703 * 12,
    max: 51_910 * 12,
    untilAge: 67,
  },
  pension: { creditRate: 0.35, wageShare: 0.07, accessAge: 67 },
  sources: [
    {
      url: "https://www.gov.il/he/pages/income-tax-monthly-deductions-booklet",
      note: "ITA monthly deductions booklet 2026 (brackets incl. Economic Efficiency Law 2026, credit point 242/month); could not be opened on 2026-11-16 (gov.il refuses automated access): not confirmed from an official source",
    },
    {
      url: "https://www.gov.il/BlobFolder/generalpage/new-immigrants-france-081026/he/IncomeTax_new-immigrants-english-081026.pdf",
      note: "ITA guide for new immigrants: credit point 2,904 per year; 2.25 points for a resident. Could not be opened on 2026-11-16: not confirmed from an official source",
    },
    {
      url: "https://www.btl.gov.il/Insurance/Rates/Pages/%D7%9C%D7%A2%D7%95%D7%91%D7%93%D7%99%D7%9D%20%D7%A9%D7%9B%D7%99%D7%A8%D7%99%D7%9D.aspx",
      note: "National Insurance Institute, employee rates: NI 1.04% + health 3.23% to 7,703/month; 7% + 5.17% to 51,910/month (from 1 Jan 2026). Could not be opened on 2026-11-16 (empty response to automated clients): not confirmed from an official source",
    },
    {
      url: "https://www.gov.il/he/pages/income-tax-monthly-deductions-booklet",
      note: "Israel Tax Authority (Income Tax Ordinance ss. 91, 125B, 125C, 121B): 25% on real capital gains, dividends and interest; 3% surtax, plus 2% on capital income, above 721,560. Could not be opened on 2026-11-16: not confirmed from an official source",
    },
  ],
};

export const IL_YEARS: readonly IlYear[] = [Y2026];

export const IL_SIMPLIFICATIONS: readonly string[] = [
  "Tax year 2026 (brackets per the Economic Efficiency Law 2026). Not confirmed from an official source: the Tax Authority and National Insurance Institute sites could not be opened, so brackets, credit points, capital-income rates, the surtax threshold and National Insurance rates are as published by independent sources.",
  "Capital gains are taxed at 25% of the nominal gain: Glideworth does not know purchase dates, so the inflationary part of the gain (exempt in Israel, which taxes only the real gain) is not removed. Long-held assets are over-taxed in high-inflation scenarios.",
  "Interest and dividends are taxed at 25% (the 15% rate for some unlinked deposits, the 30% substantial-shareholder rate and the 31% minimum rate on passive income under 60 are not modelled).",
  "Credit points: 2.25 per resident (the extra half point for women, children, new immigrants, degrees and other points are not modelled).",
  "Pension contributions: a 35% credit on the employee contribution up to 7% of salary (the insured-salary ceiling and self-employed deductions are not modelled). Keren hishtalmut is a tax-free account (employer contributions within the ceiling are not income; the 6-year rule is not checked).",
  "Pension annuities are taxed in full as income: the partial exemption for qualifying pensions (קצבה מזכה) could not be confirmed from an official source and is not applied. National Insurance and health tax stop at 67; health tax on pensions is not modelled.",
  "Self-employed National Insurance rates are not modelled (employee rates are applied to wages only).",
  "Pension funds are accessible from 67 (the statutory retirement age for men; the lower, rising age for women is not modelled). No main-home sale exemption is applied.",
];
