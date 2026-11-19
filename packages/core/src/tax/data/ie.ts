/**
 * Ireland (resident, domiciled). Calendar tax year. Nominal EUR. Calculation: ../jurisdictions/ie.ts.
 *
 * 2026 is from Revenue's published tables. 2027 is Budget 2027 (6 October 2026) as published by the
 * Department of Finance and the Parliamentary Budget Office; it is in Finance (No. 2) Bill 2026,
 * which was at Committee Stage in November 2026 and not yet enacted. Later years carry the last
 * table forward and index it with the plan's threshold policy.
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
  /**
   * Class A employee PRSI averaged over the year by months (2026: 4.2% Jan-Sep, 4.35% from 1 October;
   * 2027: 4.35% Jan-Sep, 4.5% from 1 October). `rateAfter` is the rate in force at the end of the
   * year, used for later years that have no table of their own.
   */
  prsi: { rate: number; weeklyThreshold: number; untilAge: number; rateAfter?: number };
  dirt: number;
  /** CGT on most gains; 2026 averages 33% (to 6 Oct) and 31% (from 7 Oct) by days. */
  cgt: { rate: number; exemption: number };
  pensionRelief: { bands: [number, number][]; earningsCap: number; accessAge: number };
  /**
   * Retirement lump sums, lifetime totals from all sources: tax-free up to `taxFree`, then the
   * standard rate up to `standardRateTo`, and the higher rate on the excess, which also pays USC.
   */
  lumpSum: { taxFree: number; standardRateTo: number };
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
  lumpSum: { taxFree: 200_000, standardRateTo: 500_000 },
  sources: [
    {
      url: "https://www.revenue.ie/en/personal-tax-credits-reliefs-and-exemptions/tax-relief-charts/index.aspx",
      note: "Rate bands and tax credits 2026 (read 2026-11-19)",
    },
    {
      url: "https://www.revenue.ie/en/jobs-and-pensions/calculating-your-income-tax/how-income-tax-is-calculated.aspx",
      note: "Worked examples 2026 (single monthly €4,000; civil partners €55,000 + €20,800, band €73,800)",
    },
    {
      url: "https://www.revenue.ie/en/jobs-and-pensions/usc/calculating-usc.aspx",
      note: "USC exemption €13,000 and worked examples 2026 (€25,000 -> €319.82; €50,000 -> €1,032.82; €75,000 -> €2,030.62)",
    },
    {
      url: "https://www.revenue.ie/en/jobs-and-pensions/usc/reduced-rates.aspx",
      note: "Reduced USC (70+ or full medical card, income €60,000 or less): 0.5% / 2% (not modelled)",
    },
    {
      url: "https://www.revenue.ie/en/jobs-and-pensions/pension/private/retirement-lump-sums.aspx",
      note: "Retirement lump sums: €200,000 lifetime tax-free; €200,001-€500,000 at 20%; excess at 40% under PAYE",
    },
    {
      url: "https://www.revenue.ie/en/tax-professionals/tdm/income-tax-capital-gains-tax-corporation-tax/part-18d/18D-00-01.pdf",
      note: "Tax and Duty Manual Part 18D-00-01 (USC), para 11.4: USC is payable only on the part of retirement lump sums above €500,000 (last reviewed January 2026; read 2026-11-19)",
    },
    {
      url: "https://www.revenue.ie/en/tax-professionals/ebrief/2026/no-0162026.aspx",
      note: "eBrief 016/26: exit tax on Irish and equivalent offshore funds for individuals 41% to 38% from 1 January 2026 (exit tax not modelled)",
    },
    {
      url: "https://www.citizensinformation.ie/en/social-welfare/older-and-retired-people/state-pension-contributory/",
      note: "State Pension (Contributory) from 66, maximum personal rate €299.30 a week in 2026; can be deferred to 70 (read 2026-11-19)",
    },
    {
      url: "https://www.revenue.ie/en/jobs-and-pensions/pension/dsp/index.aspx",
      note: "State Pension liable to income tax, not to USC or PRSI",
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
      note: "DSP SW14 (January 2026): Class A employee 4.2% to 30 September 2026, 4.35% from 1 October 2026; no employee PRSI at €352 a week or less (read 2026-11-19)",
    },
    {
      url: "https://www.revenue.ie/en/gains-gifts-and-inheritance/transfering-an-asset/how-to-calculate-cgt.aspx",
      note: "CGT 31% for most gains from 7 October 2026 (33% from 6 December 2021 to 6 October 2026); 1,270 annual exemption (page published 7 October 2026, read 2026-11-16)",
    },
    {
      url: "https://www.revenue.ie/en/jobs-and-pensions/pension/relief/tax-relief-limits.aspx",
      note: "Age-related pension relief limits (15% under 30 to 40% from 60), 115,000 earnings limit",
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

const BUDGET_2027_SUMMARY =
  "https://assets.gov.ie/static/documents/3aa2894e/Budget_2027_-_Tax_Policy_Changes_Summary_-_Eng.pdf";
const BUDGET_2027_BOOK =
  "https://assets.gov.ie/static/documents/c6792805/20261012_Budget_2027_Tax_Policy_Changes_Book.pdf";
const PBO_FINANCE_BILL_2026 =
  "https://data.oireachtas.ie/ie/oireachtas/parliamentaryBudgetOffice/2026/2026-10-28_finance-no-2-bill-2026_en.pdf";

/**
 * 2027 (Budget 2027, announced; Finance (No. 2) Bill 2026 not yet enacted): standard rate cut-off
 * +€2,500, personal, employee and earned income credits +€125, USC 2% band to €30,300, CGT 31% for
 * the whole year. Class A employee PRSI is 4.35% to 30 September 2027 and 4.5% from 1 October 2027
 * (the agreed increases, Department of Finance Tax Policy Changes book, Tables 2-3 note 2); later
 * years use 4.5% (any further rise is not confirmed).
 */
const Y2027: IeYear = {
  ...Y2026,
  startYear: 2027,
  label: "2027 (Budget 2027, announced)",
  bands: { single: 46_500, singleParent: 50_500, married: 55_500, secondEarnerMax: 37_500 },
  credits: {
    ...Y2026.credits,
    personalSingle: 2_125,
    personalMarried: 4_250,
    employee: 2_125,
    earned: 2_125,
  },
  usc: {
    rows: [
      [0, 0.005],
      [12_012, 0.02],
      [30_300, 0.03],
      [70_044, 0.08],
    ],
    exemptUpTo: 13_000,
  },
  prsi: { ...Y2026.prsi, rate: (0.0435 * 9 + 0.045 * 3) / 12, rateAfter: 0.045 },
  cgt: { ...Y2026.cgt, rate: 0.31 },
  sources: [
    {
      url: BUDGET_2027_SUMMARY,
      note: "Department of Finance: standard rate cut-off +€2,500; personal, employee and earned income credits +€125; home carer +€100; USC 2% ceiling +€1,600; CGT 33% to 31%; investment undertaking and life assurance exit tax 38% to 35%",
    },
    {
      url: PBO_FINANCE_BILL_2026,
      note: "PBO on Finance (No. 2) Bill 2026, Tables 4-5: bands €46,500 / €50,500 (SPCCC) / €55,500 married, second earner up to €37,500; credits €2,000 to €2,125; USC 0.5% to €12,012, 2% to €30,300, 3% to €70,044, 8% above, exempt to €13,000; CGT 31% for disposals from 7 October 2026 (s.36); Committee Stage from 4 November 2026",
    },
    {
      url: BUDGET_2027_BOOK,
      note: "Department of Finance, Budget 2027 Tax Policy Changes (12 October 2026): 2.1 bands and credits; 2.1.2 USC (exempt below €13,000); 2.2 exit tax 38% to 35%; 2.3 Investment Account from 1 July 2027; Table 2 single PAYE vectors; Tables 2-3 note 2: PRSI 4.35% from 1 October 2026 and 4.5% from 1 October 2027; Table 3 (married, one income) implies the married person's credit of €4,250 (read 2026-11-19)",
    },
    {
      url: "https://www.citizensinformation.ie/en/money-and-tax/budgets/social-welfare-rates-announced-in-budget-2027/",
      note: "State Pension (Contributory) maximum personal rate €299.30 (2026) to €309.30 a week (2027), €319.30 from age 80 (read 2026-11-19)",
    },
  ],
};

export const IE_YEARS: readonly IeYear[] = [Y2026, Y2027];

export const IE_SIMPLIFICATIONS: readonly string[] = [
  "Tax years 2026 (Revenue) and 2027 (Budget 2027 as announced; Finance (No. 2) Bill 2026 not yet enacted); later years carry the 2027 tables forward and index them with the plan's threshold policy.",
  "CGT on most gains is 33% to 6 October 2026 and 31% from 7 October 2026. Glideworth has no disposal dates, so 2026 gains use the average by days (32.53%) and later years 31%; development land (33%) and the other special rates are not modelled.",
  "Investment funds: all gains in a taxable account pay CGT and all interest, dividends and fund distributions are taxed as income. Exit tax on Irish and equivalent EU, EEA and OECD funds and ETFs (38% in 2026, 35% from 2027 as announced) and its 8-year deemed disposal are not modelled, nor is the Investment Account announced from 1 July 2027 (1% a year on the value above €50,000, up to €12,000 paid in a year), so a fund portfolio's tax can be well off.",
  "PRSI: Class A at 4.2% to 30 September 2026, 4.35% to 30 September 2027 and 4.5% from 1 October 2027; each year uses the average by months (4.2375% in 2026, 4.3875% in 2027) and later years 4.5%, since no further rise is confirmed. Self-employed income is charged at the same rate (Class S, assumed equal to Class A, with no €5,000 minimum). The PRSI credit taper and PRSI on rents and investment income are not modelled; PRSI stops at 66.",
  "Married couples are jointly assessed (married band plus up to the second-earner maximum for the second income); single parents get the single-parent band but not the Single Person Child Carer Credit. The home carer, rent and other credits are not modelled.",
  "Deposit interest pays DIRT at 33%.",
  "USC: State Pension and other social welfare income are exempt (incomeType state-pension); reduced USC rates for people aged 70+ or with a full medical card and income of €60,000 or less, and the 3% surcharge on self-employed income above €100,000, are not modelled.",
  "Pension relief is limited by the age-related percentage of earnings capped at €115,000; employer contributions and the standard fund threshold are not modelled.",
  "Retirement lump sums: the tax-free share you set on the account is tax-free up to €200,000 over a lifetime, taxed at 20% up to €500,000 and at 40% above (Revenue's manual says the person's marginal rate, which is 20% when other income is low; Glideworth always uses 40%); USC is charged only on the part above €500,000. Lump sums taken before the plan starts are not counted toward the lifetime limits. ARF imputed distributions are not modelled.",
  "State Pension (Contributory) is an income you enter (the maximum personal rate is €299.30 a week in 2026 and €309.30 from January 2027); it starts at 66 by default. It is taxable but pays no USC or PRSI. Deferring it to as late as 70, with a higher rate, is not modelled.",
];
