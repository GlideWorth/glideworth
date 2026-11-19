/**
 * Israel (residents). Calendar tax year. Nominal ILS. Calculation: ../jurisdictions/il.ts.
 *
 * Checked 2026-11-19. The Israel Tax Authority and National Insurance Institute pages on gov.il and
 * btl.gov.il still refuse automated access, so the figures were confirmed from:
 * - the Knesset Book of Laws (Sefer HaChukim, fs.knesset.gov.il): no. 3511 of 31 March 2026, the
 *   Economic Efficiency Law 2026, chapter C (Income Tax Ordinance amendment 288, s. 121: 20% band to
 *   228,000 and 31% band to 301,200 from 1 January 2026), and no. 3342 of 26 December 2024, the
 *   Economic Efficiency Law 2025 (s. 120B(e): no indexation of the Ordinance's amounts in 2025-2027,
 *   resuming 1 January 2028; s. 121B(a1): an extra 2% on capital income above the surtax threshold);
 * - the Knesset Research and Information Center paper of 9 February 2026 on the bracket change, which
 *   quotes the Tax Authority's January 2026 tables (brackets, surtax threshold 721,560, credit point
 *   242 a month, 2.25 points, pension credit of 35% on up to 658 a month);
 * - the National Insurance Institute's rates page for salaried workers (as of 1 January 2026),
 *   read from the Internet Archive copy of 15 October 2026.
 * The 25% rates on capital gains, dividends and interest (Ordinance ss. 91, 125B, 125C) could not be
 * confirmed from an official text and are labelled so.
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
  /** Pension credit: `creditRate` on the employee contribution up to `wageShare` of salary and `maxContribution` a year. */
  pension: { creditRate: number; wageShare: number; maxContribution: number; accessAge: number };
  /** Last year in which the Ordinance's amounts are not indexed (s. 120B(e)). */
  frozenThroughYear: number;
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
  pension: { creditRate: 0.35, wageShare: 0.07, maxContribution: 658 * 12, accessAge: 67 },
  frozenThroughYear: 2027,
  sources: [
    {
      url: "https://fs.knesset.gov.il/25/law/25_lsr_12235101.pdf",
      note: "Sefer HaChukim 3511 (31 March 2026), Economic Efficiency Law 2026, chapter C: Ordinance s. 121 amended (amendment 288), 20% band to 228,000 and 31% band 228,001-301,200, from 1 January 2026. Checked 2026-11-19",
    },
    {
      url: "https://fs.knesset.gov.il/globaldocs/MMM/a4622f6b-9905-f111-a13e-005056aa7c52/2_a4622f6b-9905-f111-a13e-005056aa7c52_11_21431.pdf",
      note: "Knesset Research and Information Center, 9 February 2026, citing the Tax Authority's January 2026 tables: brackets 84,120 / 120,720 / 560,280, surtax above 721,560; credit point 242 a month (2,904 a year), 2.25 points per resident; pension credit 35% on up to 658 a month. Checked 2026-11-19",
    },
    {
      url: "https://fs.knesset.gov.il/25/law/25_lsr_5396578.pdf",
      note: "Sefer HaChukim 3342 (26 December 2024), Economic Efficiency Law 2025: s. 120B(e) no indexation in 2025-2027; s. 121B(a1) extra 2% on taxable income from capital sources above the s. 121B threshold. Checked 2026-11-19",
    },
    {
      url: "https://web.archive.org/web/20261015130305/https://www.btl.gov.il/English%20Homepage/Insurance/Ratesandamount/Pages/forSalaried.aspx",
      note: "National Insurance Institute, rates for salaried workers as of 1 January 2026 (archived 15 October 2026): employee NI 1.04% + health 3.23% up to 7,703 a month, 7% + 5.17% up to 51,910 a month; employees receiving an old-age pension pay no employee share. Checked 2026-11-19",
    },
    {
      url: "https://www.gov.il/he/pages/income-tax-monthly-deductions-booklet",
      note: "Israel Tax Authority monthly deductions booklet (the primary source for the tables above; gov.il refuses automated access). The 25% rates on real capital gains, dividends and interest (ss. 91, 125B, 125C) are not confirmed from an official text",
    },
  ],
};

export const IL_YEARS: readonly IlYear[] = [Y2026];

export const IL_SIMPLIFICATIONS: readonly string[] = [
  "Tax year 2026: brackets per the Economic Efficiency Law 2026 (Book of Laws 3511), credit point 2,904 a year, surtax threshold 721,560 and National Insurance rates, confirmed from Knesset publications and the National Insurance Institute (checked 2026-11-19). The Ordinance's amounts are not indexed in 2025-2027 (s. 120B(e)), so 2027 uses the 2026 amounts; from 2028 they follow the plan's threshold policy.",
  "Capital income: 25% on capital gains, dividends and interest (not confirmed from an official text). Gains are taxed on the nominal gain: Glideworth does not know purchase dates, so the inflationary part (exempt in Israel, which taxes only the real gain) is not removed, and long-held assets are over-taxed in high-inflation scenarios. The 15% rate on some unlinked deposits, the 30% substantial-shareholder rate and the 31% minimum rate on passive income under 60 are not modelled.",
  "Surtax: 3% on taxable income above 721,560, plus 2% on taxable income from capital sources above 721,560 (s. 121B(a1)). Glideworth counts interest, dividends and gains as capital income; rent and other non-work income are not counted in the 2% part.",
  "Credit points: 2.25 per resident only (the extra half point for women, children, new immigrants, degrees, reservists and other points are not modelled).",
  "Pension contributions: a 35% credit on the employee contribution up to 7% of salary and 658 a month (7,896 a year). The deduction for self-employed and additional contributions, and the tax exemption for employer contributions above their ceiling, are not modelled. Keren hishtalmut is a tax-free account (employer contributions within the ceiling are not income; the 6-year rule is not checked).",
  "Pension annuities are taxed in full as income: the partial exemption for qualifying pensions (קצבה מזכה) could not be confirmed from an official source and is not applied. The old-age allowance (Bituach Leumi) is an income you enter and is taxed as ordinary income; its tax treatment was not confirmed.",
  "National Insurance and health tax: employee rates on wages until 67, assuming an old-age pension is then claimed (the employee then pays no share). Employees aged 67-70 who defer the old-age pension pay 3.93% / 10.03%, and women reach retirement age at 62-65: neither is modelled. Health tax on pensions and other non-work income, and self-employed rates, are not modelled.",
  "Pension funds are accessible from 67 (the statutory retirement age for men; the lower, rising age for women is not modelled). No main-home sale exemption is applied.",
];
