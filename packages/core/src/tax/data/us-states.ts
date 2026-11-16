/**
 * US state individual income tax, tax year 2026, all 50 states + DC. Data only; calculation in
 * ../jurisdictions/us-state.ts.
 *
 * Each row cites the state's own revenue department, statute or official tax-year publication
 * (`sources`, read 2026-11-16). Figures are facts transcribed from those publications. Where an
 * official page could not be opened (several state sites refuse automated clients) the row keeps
 * its earlier figures and says what is unconfirmed in `unconfirmed`; that text is shown with the
 * state's tax results.
 *
 * Married brackets: where the state doubles single brackets `mfj` is omitted and `mfjFactor`
 * applies; where it publishes different married brackets they are listed explicitly. Rows flagged
 * `approx` carry approximations (noted inline): check before relying on them for a specific return.
 *
 * Simplifications: starting point is federal AGI for every state; itemised deductions, state
 * credits other than personal-exemption credits, AMT/minimum taxes and income-tested phase-outs
 * are not modelled; retirement exclusions are included only where they are a simple per-person
 * amount by age.
 */

export interface StateSource {
  url: string;
  note?: string;
}

export interface StateRow {
  code: string;
  name: string;
  kind: "none" | "flat" | "brackets" | "capital-gains-only";
  /** Single filer [threshold, rate]. Flat states: one row. */
  single: [number, number][];
  /** Married filing jointly brackets, when not simply `single x mfjFactor`. */
  mfj?: [number, number][];
  mfjFactor?: number;
  standardDeduction?: { single: number; mfj: number };
  /** Personal exemption per filer/dependent; `credit` = amounts are tax credits, not deductions. */
  exemption?: { single: number; mfj: number; dependent: number; credit?: boolean };
  /** Taxes Social Security benefits (to the extent federally taxable). Default false. */
  taxesSocialSecurity?: boolean;
  /**
   * Per-person exclusion of retirement income (pensions + tax-deferred withdrawals).
   * amount Infinity = fully exempt. `minAge` = age from which it applies.
   */
  retirementExclusion?: { amount: number; minAge: number }[];
  /** What the exclusion covers: 'pension' (pension/annuity income only) or 'retirement' (also IRA/401k withdrawals). */
  retirementExclusionAppliesTo?: "pension" | "retirement";
  /** Capital gains: taxed as ordinary (default) or exempt. */
  capitalGains?: "ordinary" | "exempt";
  /** Washington: separate tax on long-term gains above a standard deduction. */
  capitalGainsTax?: { deduction: number; brackets: [number, number][] };
  /** Payroll: state disability insurance rate on all wages (CA SDI). */
  sdiRate?: number;
  approx?: string;
  /** Official publications the row was checked against (read 2026-11-16). */
  sources: StateSource[];
  /** Figures that could not be confirmed from an official source (kept from the earlier table). */
  unconfirmed?: string;
}

/** Date every state source in this file was read. */
export const US_STATES_CHECKED = "2026-11-16";

const NONE = (
  code: string,
  name: string,
  sources: StateSource[],
  extra: Partial<StateRow> = {},
): StateRow => ({
  code,
  name,
  kind: "none",
  single: [[0, 0]],
  sources,
  ...extra,
});
const FLAT = (
  code: string,
  name: string,
  rate: number,
  sources: StateSource[],
  extra: Partial<StateRow> = {},
): StateRow => ({
  code,
  name,
  kind: "flat",
  single: [[0, rate]],
  sources,
  ...extra,
});
const ALL = Number.POSITIVE_INFINITY;
const READ = "read 2026-11-16";
const BLOCKED = (site: string): StateSource => ({
  url: site,
  note: `official site; could not be opened on 2026-11-16 (refuses automated clients or did not respond)`,
});

export const US_STATES_2026: StateRow[] = [
  {
    code: "AL",
    name: "Alabama",
    kind: "brackets",
    single: [
      [0, 0.02],
      [500, 0.04],
      [3_000, 0.05],
    ],
    mfjFactor: 2,
    standardDeduction: { single: 3_000, mfj: 8_500 },
    exemption: { single: 1_500, mfj: 3_000, dependent: 1_000 },
    retirementExclusion: [{ amount: 6_000, minAge: 65 }],
    approx:
      "standard deduction shown at its maximum (phases down with income); dependent exemption shown at $1,000 (falls to $500 above $50,000 and $300 above $100,000 of income); DB pensions fully exempt not separated",
    sources: [
      {
        url: "https://www.revenue.alabama.gov/faqs/how-much-is-the-alabama-standard-deduction/",
        note: `Rates 2%/4%/5% at $500/$3,000 (doubled for joint); personal exemption $1,500/$3,000 (${READ})`,
      },
      {
        url: "https://www.revenue.alabama.gov/wp-content/uploads/2026/01/25f40bk.pdf",
        note: `2025 Form 40 booklet (rates statutory, unchanged for 2026): standard deduction chart maximum $3,000/$8,500; dependent exemption $1,000/$500/$300 by income; $6,000 retirement exclusion from 65 (${READ})`,
      },
    ],
  },
  NONE("AK", "Alaska", [
    {
      url: "https://tax.alaska.gov/programs/programs/reports/AnnualReport.aspx?Year=2024",
      note: `Tax Division history: the individual income tax was repealed in 1980 (${READ})`,
    },
  ]),
  FLAT(
    "AZ",
    "Arizona",
    0.025,
    [
      {
        url: "https://www.azleg.gov/ars/43/01041.htm",
        note: `A.R.S. 43-1041: standard deduction $15,750 single / $31,500 joint, adjusted for inflation like the federal basic standard deduction (subsection H) (${READ})`,
      },
      {
        url: "https://www.azleg.gov/legtext/57leg/2R/laws/0140.pdf",
        note: `Laws 2026, ch. 140 (HB 4168): 43-1041 amounts apply from 2025; dependent credit $100 -> $125 under 17 from 2026 (${READ})`,
      },
      BLOCKED("https://azdor.gov/"),
    ],
    {
      standardDeduction: { single: 16_100, mfj: 32_200 },
      exemption: { single: 0, mfj: 0, dependent: 125, credit: true },
      approx:
        "2026 standard deduction derived from the statutory 2025 amounts indexed like the federal deduction ($16,100/$32,200); dependent credit shown at $125 for every dependent ($25 from age 17)",
      unconfirmed: "the 2.5% rate (ADOR pages could not be opened)",
    },
  ),
  {
    code: "AR",
    name: "Arkansas",
    kind: "brackets",
    single: [
      [0, 0.02],
      [4_700, 0.037],
    ],
    mfjFactor: 1,
    standardDeduction: { single: 2_470, mfj: 4_940 },
    exemption: { single: 29, mfj: 58, dependent: 29, credit: true },
    retirementExclusion: [{ amount: 6_000, minAge: 59.5 }],
    approx:
      "the schedule for net income above $94,700 is applied to every income; the lower-income table (0% to $5,599, then 2%, 3%, 3.4%, 3.7%) and its bracket adjustment are not modelled",
    sources: [
      {
        url: "https://www.arkleg.state.ar.us/Home/FTPDocument?path=%2FACTS%2F2026S1%2FPublic%2FACT1.pdf",
        note: `Act 1 of the 2026 First Extraordinary Session (approved 6 May 2026), A.C.A. 26-51-201(a)(4): from 2026, 2% to $4,700 and 3.7% above for net income over $94,700 (${READ})`,
      },
      {
        url: "https://www.dfa.arkansas.gov/wp-content/uploads/2026_Final_AR1000ES_2.pdf",
        note: `2026 AR1000ES: standard deduction $2,470 per taxpayer; personal credit $29 (${READ})`,
      },
      {
        url: "https://www.dfa.arkansas.gov/wp-content/uploads/2025_AR1000F_and_AR1000NR_Instructions.pdf",
        note: `$6,000 retirement income exemption (${READ})`,
      },
    ],
  },
  {
    code: "CA",
    name: "California",
    kind: "brackets",
    single: [
      [0, 0.01],
      [11_456, 0.02],
      [27_157, 0.04],
      [42_861, 0.06],
      [59_498, 0.08],
      [75_197, 0.093],
      [384_109, 0.103],
      [460_927, 0.113],
      [768_213, 0.123],
      [1_000_000, 0.133],
    ],
    mfj: [
      [0, 0.01],
      [22_912, 0.02],
      [54_314, 0.04],
      [85_722, 0.06],
      [118_996, 0.08],
      [150_394, 0.093],
      [768_218, 0.103],
      [921_854, 0.113],
      [1_000_000, 0.123],
      [1_536_426, 0.133],
    ],
    standardDeduction: { single: 5_900, mfj: 11_800 },
    exemption: { single: 158, mfj: 316, dependent: 491, credit: true },
    sdiRate: 0.013,
    approx:
      "the 1% Behavioral Health Services Tax on taxable income over $1m (all filing statuses) is folded into the brackets",
    sources: [
      {
        url: "https://www.ftb.ca.gov/about-ftb/newsroom/tax-news/2026/10.html",
        note: `FTB Tax News, October 2026 (2026 indexing): Schedules X and Y, standard deduction $5,900/$11,800, exemption credits $158/$316, dependent $491 (${READ})`,
      },
      {
        url: "https://www.ftb.ca.gov/forms/2026/2026-540-es-instructions.html",
        note: `Behavioral Health Services Tax: 1% of taxable income over $1,000,000 (${READ})`,
      },
      {
        url: "https://edd.ca.gov/en/payroll_taxes/rates_and_withholding/",
        note: `EDD: SDI withholding rate 1.3% for 2026, no taxable wage limit (${READ})`,
      },
    ],
  },
  FLAT(
    "CO",
    "Colorado",
    0.044,
    [
      {
        url: "https://tax.colorado.gov/sites/default/files/documents/DR_0104EP_2026.pdf",
        note: `DR 0104EP 2026: estimated tax at 4.4% of Colorado taxable income (starts from federal taxable income) (${READ})`,
      },
      {
        url: "https://tax.colorado.gov/sites/default/files/documents/Book104_2025.pdf",
        note: `2025 booklet: pension/annuity subtraction $20,000 (55-64) / $24,000 (65+), shared with the social security subtraction (${READ})`,
      },
    ],
    {
      standardDeduction: { single: 16_100, mfj: 32_200 },
      taxesSocialSecurity: true,
      retirementExclusion: [
        { amount: 20_000, minAge: 55 },
        { amount: 24_000, minAge: 65 },
      ],
      approx:
        "the social security subtraction (all of it from 65; from 55 subject to an income test) is not modelled and the exclusion shown covers pensions and retirement withdrawals only",
    },
  ),
  {
    code: "CT",
    name: "Connecticut",
    kind: "brackets",
    single: [
      [0, 0.02],
      [10_000, 0.045],
      [50_000, 0.055],
      [100_000, 0.06],
      [200_000, 0.065],
      [250_000, 0.069],
      [500_000, 0.0699],
    ],
    mfjFactor: 2,
    exemption: { single: 15_000, mfj: 24_000, dependent: 0 },
    taxesSocialSecurity: true,
    approx: "exemption phase-out, recapture and the 2%-bracket phase-out not modelled",
    sources: [
      {
        url: "https://www.cga.ct.gov/current/pub/chap_229.htm",
        note: `C.G.S. 12-700(a)(10) (rates for 2024 onward; joint brackets double the single ones) and 12-702 (exemptions $15,000 / $24,000) (${READ})`,
      },
    ],
  },
  {
    code: "DE",
    name: "Delaware",
    kind: "brackets",
    single: [
      [0, 0],
      [2_000, 0.022],
      [5_000, 0.039],
      [10_000, 0.048],
      [20_000, 0.052],
      [25_000, 0.0555],
      [60_000, 0.066],
    ],
    mfjFactor: 1,
    standardDeduction: { single: 3_250, mfj: 6_500 },
    exemption: { single: 110, mfj: 220, dependent: 110, credit: true },
    retirementExclusion: [{ amount: 12_500, minAge: 60 }],
    sources: [
      {
        url: "https://revenue.delaware.gov/frequently-asked-questions/personal-income-tax-faqs/",
        note: `Rates 2.2%-5.55% below $60,000 and 6.6% above; pension exclusion up to $12,500 from 60 (${READ})`,
      },
      {
        url: "https://delcode.delaware.gov/title30/c011/sc02/index.html",
        note: `30 Del. C. 1108 (standard deduction $3,250 / $6,500) and 1110 ($110 personal credit) (${READ})`,
      },
    ],
  },
  NONE("FL", "Florida", [
    {
      url: "https://floridarevenue.com/faq/Pages/FAQDetails.aspx?FAQID=1466",
      note: `Florida does not impose a personal income tax (${READ})`,
    },
  ]),
  FLAT(
    "GA",
    "Georgia",
    0.0499,
    [
      {
        url: "https://dor.georgia.gov/taxes/important-tax-updates",
        note: `2026: flat rate reduced to 4.99% (${READ})`,
      },
      {
        url: "https://dor.georgia.gov/document/document/2026-employers-tax-guide-updated-september-2026/download",
        note: `HB 463 (2026), retroactive to 1 Jan 2026: 4.99%; standard deduction $15,000 / $30,000; dependent deduction $5,000 (${READ})`,
      },
    ],
    {
      standardDeduction: { single: 15_000, mfj: 30_000 },
      exemption: { single: 0, mfj: 0, dependent: 5_000 },
      retirementExclusion: [
        { amount: 35_000, minAge: 62 },
        { amount: 65_000, minAge: 65 },
      ],
      unconfirmed: "the retirement income exclusion amounts ($35,000 from 62, $65,000 from 65)",
    },
  ),
  {
    code: "HI",
    name: "Hawaii",
    kind: "brackets",
    single: [
      [0, 0.014],
      [9_600, 0.032],
      [14_400, 0.055],
      [19_200, 0.064],
      [24_000, 0.068],
      [36_000, 0.072],
      [48_000, 0.076],
      [125_000, 0.079],
      [175_000, 0.0825],
      [225_000, 0.09],
      [275_000, 0.1],
      [325_000, 0.11],
    ],
    mfjFactor: 2,
    standardDeduction: { single: 8_000, mfj: 16_000 },
    exemption: { single: 1_144, mfj: 2_288, dependent: 1_144 },
    retirementExclusion: [{ amount: ALL, minAge: 0 }],
    retirementExclusionAppliesTo: "pension",
    approx:
      "all pension-character income treated as employer-funded (exempt); IRA/401(k) withdrawals taxable",
    sources: [
      {
        url: "https://tax.hawaii.gov/forms/d_25table-on/d_25table-on_p13/",
        note: `Tax rate schedules for taxable years beginning after 31 Dec 2024 (Schedule II doubles Schedule I) (${READ})`,
      },
      {
        url: "https://tax.hawaii.gov/faq/",
        note: `2026 standard deduction $8,000 / $16,000; personal exemption $1,144 (${READ})`,
      },
    ],
  },
  FLAT("ID", "Idaho", 0.053, [BLOCKED("https://tax.idaho.gov/")], {
    single: [
      [0, 0],
      [4_811, 0.053],
    ],
    mfj: [
      [0, 0],
      [9_622, 0.053],
    ],
    standardDeduction: { single: 16_100, mfj: 32_200 },
    unconfirmed: "all Idaho figures (tax.idaho.gov did not respond)",
  }),
  FLAT(
    "IL",
    "Illinois",
    0.0495,
    [
      {
        url: "https://tax.illinois.gov/research/taxrates/income.html",
        note: `Individuals: 4.95% of net income (${READ})`,
      },
      {
        url: "https://tax.illinois.gov/questionsandanswers/answer.851.html",
        note: `Exemption allowance $2,925 per exemption for 2026 (${READ})`,
      },
    ],
    {
      exemption: { single: 2_925, mfj: 5_850, dependent: 2_925 },
      retirementExclusion: [{ amount: ALL, minAge: 0 }],
    },
  ),
  FLAT(
    "IN",
    "Indiana",
    0.0295,
    [
      {
        url: "https://www.in.gov/dor/resources/tax-rates-and-reports/rates-fees-and-penalties/",
        note: `Individual adjusted gross income tax rate 2.95% for 2026 (${READ})`,
      },
      {
        url: "https://iga.in.gov/ic/2026/Title_6/Article_3/Chapter_1.pdf",
        note: `IC 6-3-1-3.5(a): $1,000 per exemption, plus $1,500 for each dependent child (${READ})`,
      },
    ],
    {
      exemption: { single: 1_000, mfj: 2_000, dependent: 2_500 },
      approx: "county income taxes are not included",
    },
  ),
  FLAT(
    "IA",
    "Iowa",
    0.038,
    [
      {
        url: "https://revenue.iowa.gov/press-release/2025-10-21/idr-announces-2026-individual-income-tax-and-interest-rates",
        note: `Flat 3.8% on all taxable income in 2026 (${READ})`,
      },
      {
        url: "https://revenue.iowa.gov/taxes/tax-guidance/individual-income-tax/individual-income-tax-provisions",
        note: `Retirement income excluded from 55 (${READ})`,
      },
    ],
    {
      standardDeduction: { single: 16_100, mfj: 32_200 },
      exemption: { single: 40, mfj: 80, dependent: 40, credit: true },
      retirementExclusion: [{ amount: ALL, minAge: 55 }],
      unconfirmed: "the $40 exemption credit amount",
    },
  ),
  {
    code: "KS",
    name: "Kansas",
    kind: "brackets",
    single: [
      [0, 0.052],
      [23_000, 0.0558],
    ],
    mfjFactor: 2,
    standardDeduction: { single: 3_605, mfj: 8_240 },
    exemption: { single: 9_160, mfj: 18_320, dependent: 2_320 },
    sources: [BLOCKED("https://www.ksrevenue.gov/")],
    unconfirmed: "all Kansas figures (ksrevenue.gov refused the connection)",
  },
  FLAT(
    "KY",
    "Kentucky",
    0.035,
    [
      {
        url: "https://revenue.ky.gov/News/Pages/Kentucky-DOR-Announces-2026-Standard-Deduction.aspx",
        note: `2026 standard deduction $3,360 (${READ})`,
      },
      {
        url: "https://revenue.ky.gov/Forms/42A804%20(K-4)%20(2026).pdf",
        note: `2026 K-4: flat 3.5% rate (${READ})`,
      },
    ],
    {
      standardDeduction: { single: 3_360, mfj: 3_360 },
      retirementExclusion: [{ amount: 31_110, minAge: 0 }],
      unconfirmed: "the $31,110 pension exclusion",
    },
  ),
  FLAT("LA", "Louisiana", 0.03, [BLOCKED("https://revenue.louisiana.gov/")], {
    standardDeduction: { single: 12_875, mfj: 25_750 },
    retirementExclusion: [{ amount: 6_000, minAge: 65 }],
    unconfirmed:
      "all Louisiana figures (revenue.louisiana.gov and legis.la.gov could not be reached)",
  }),
  {
    code: "ME",
    name: "Maine",
    kind: "brackets",
    single: [
      [0, 0.058],
      [27_400, 0.0675],
      [64_850, 0.0715],
      [1_000_000, 0.0915],
    ],
    mfj: [
      [0, 0.058],
      [54_850, 0.0675],
      [129_750, 0.0715],
      [1_500_000, 0.0915],
    ],
    standardDeduction: { single: 15_700, mfj: 31_400 },
    exemption: { single: 5_300, mfj: 10_600, dependent: 0 },
    approx:
      "the 2% surcharge from 2026 is folded into the top bracket; the dependent credit, pension deduction and standard deduction phase-out are not modelled",
    sources: [
      {
        url: "https://www.maine.gov/revenue/sites/maine.gov.revenue/files/2026-05/ind_tax_rate_sched_2026_rev.pdf",
        note: `2026 rate schedules (revised 20 May 2026): brackets, 2% surcharge above $1m single / $1.5m joint, personal exemption $5,300, standard deduction $15,700 / $31,400 (${READ})`,
      },
    ],
  },
  {
    code: "MD",
    name: "Maryland",
    kind: "brackets",
    single: [
      [0, 0.02],
      [1_000, 0.03],
      [2_000, 0.04],
      [3_000, 0.0475],
      [100_000, 0.05],
      [125_000, 0.0525],
      [150_000, 0.055],
      [250_000, 0.0575],
      [500_000, 0.0625],
      [1_000_000, 0.065],
    ],
    mfj: [
      [0, 0.02],
      [1_000, 0.03],
      [2_000, 0.04],
      [3_000, 0.0475],
      [150_000, 0.05],
      [175_000, 0.0525],
      [225_000, 0.055],
      [300_000, 0.0575],
      [600_000, 0.0625],
      [1_200_000, 0.065],
    ],
    standardDeduction: { single: 3_350, mfj: 6_700 },
    exemption: { single: 3_200, mfj: 6_400, dependent: 3_200 },
    approx: "county income tax (2.25%-3.3%) not included; use the local rate option",
    sources: [
      {
        url: "https://www.marylandcomptroller.gov/content/dam/mdcomp/tax/forms/worksheets/2026-pv-worksheet.pdf",
        note: `2026 payment voucher worksheet: rate schedules, standard deduction $3,350 / $6,700, exemption $3,200 (${READ})`,
      },
    ],
  },
  {
    code: "MA",
    name: "Massachusetts",
    kind: "brackets",
    single: [
      [0, 0.05],
      [1_107_750, 0.09],
    ],
    mfjFactor: 1,
    exemption: { single: 4_400, mfj: 8_800, dependent: 1_000 },
    approx: "short-term gains (8.5%) taxed at 5%",
    sources: [
      {
        url: "https://www.mass.gov/info-details/massachusetts-tax-rates",
        note: `5.00%; 4% surtax on income over $1,107,750 for tax year 2026; short-term gains 8.5% (${READ})`,
      },
      {
        url: "https://www.mass.gov/info-details/massachusetts-personal-income-tax-exemptions",
        note: `Personal exemption $4,400 / $8,800; $1,000 per dependent (${READ})`,
      },
    ],
  },
  FLAT("MI", "Michigan", 0.0425, [BLOCKED("https://www.michigan.gov/taxes")], {
    exemption: { single: 5_900, mfj: 11_800, dependent: 5_900 },
    unconfirmed:
      "all Michigan figures (michigan.gov and legislature.mi.gov refused automated access)",
  }),
  {
    code: "MN",
    name: "Minnesota",
    kind: "brackets",
    single: [
      [0, 0.0535],
      [33_310, 0.068],
      [109_430, 0.0785],
      [203_150, 0.0985],
    ],
    mfj: [
      [0, 0.0535],
      [48_700, 0.068],
      [193_480, 0.0785],
      [337_930, 0.0985],
    ],
    standardDeduction: { single: 15_300, mfj: 30_600 },
    exemption: { single: 0, mfj: 0, dependent: 5_300 },
    taxesSocialSecurity: true,
    approx: "social security subtraction not modelled",
    sources: [
      {
        url: "https://www.revenue.state.mn.us/sites/default/files/2025-12/inflation-adjusted-amounts-2026.pdf",
        note: `Tax year 2026 inflation-adjusted amounts: bracket thresholds, standard deduction $15,300 / $30,600, dependent exemption $5,300 (${READ})`,
      },
      {
        url: "https://www.revenue.state.mn.us/sites/default/files/2026-10/tax-year-2026-tax-professional-desk-reference-chart-final.pdf",
        note: `2026 brackets at 5.35% / 6.8% / 7.85% / 9.85% (${READ})`,
      },
    ],
  },
  FLAT(
    "MS",
    "Mississippi",
    0.04,
    [
      {
        url: "https://www.dor.ms.gov/sites/default/files/tax-forms/business/89700251revised1.13.2026.pdf",
        note: `Pub 89-700: tax year 2026, 0% on the first $10,000 and 4.0% above; exemptions $6,000 / $12,000 / $1,500 per dependent; standard deduction $2,300 / $4,600 (${READ})`,
      },
      {
        url: "https://www.dor.ms.gov/general-information",
        note: `Tax year 2026: excess of $10,000 taxed at 4% (${READ})`,
      },
    ],
    {
      single: [
        [0, 0],
        [10_000, 0.04],
      ],
      mfj: [
        [0, 0],
        [10_000, 0.04],
      ],
      standardDeduction: { single: 2_300, mfj: 4_600 },
      exemption: { single: 6_000, mfj: 12_000, dependent: 1_500 },
      retirementExclusion: [{ amount: ALL, minAge: 0 }],
      approx:
        "on a joint return the 0% band is one $10,000 (spouses filing combined may each use it)",
    },
  ),
  {
    code: "MO",
    name: "Missouri",
    kind: "brackets",
    single: [
      [0, 0],
      [1_348, 0.02],
      [2_696, 0.025],
      [4_044, 0.03],
      [5_392, 0.035],
      [6_740, 0.04],
      [8_088, 0.045],
      [9_436, 0.047],
    ],
    mfjFactor: 1,
    standardDeduction: { single: 16_100, mfj: 32_200 },
    capitalGains: "exempt",
    unconfirmed: "the capital gains subtraction",
    sources: [
      {
        url: "https://dor.mo.gov/forms/MO-1040ES_2026.pdf",
        note: `2026 MO-1040ES: tax rate table and standard deduction $16,100 / $32,200 (${READ})`,
      },
    ],
  },
  {
    code: "MT",
    name: "Montana",
    kind: "brackets",
    single: [
      [0, 0.047],
      [47_500, 0.0565],
    ],
    mfjFactor: 2,
    standardDeduction: { single: 16_100, mfj: 32_200 },
    taxesSocialSecurity: true,
    approx: "capital gains rate differential (3%/4.1%) and the senior subtraction not modelled",
    sources: [
      {
        url: "https://revenue.mt.gov/news/recent-news/HB-337",
        note: `HB 337: tax year 2026, 4.7% to $47,500 ($95,000 joint) and 5.65% above; capital gains 3.0% / 4.1% (${READ})`,
      },
    ],
  },
  {
    code: "NE",
    name: "Nebraska",
    kind: "brackets",
    single: [
      [0, 0.0246],
      [4_130, 0.0351],
      [24_760, 0.0455],
    ],
    mfj: [
      [0, 0.0246],
      [8_250, 0.0351],
      [49_530, 0.0455],
    ],
    standardDeduction: { single: 8_850, mfj: 17_700 },
    exemption: { single: 176, mfj: 352, dependent: 176, credit: true },
    sources: [
      {
        url: "https://revenue.nebraska.gov/sites/default/files/doc/research/chronology/4-607table1.pdf",
        note: `Tax rate chronology (rev. 2-2026): from 1 Jan 2026 rates 2.46% / 3.51% / 4.55%, brackets by filing status, personal exemption credit $176, standard deduction $8,850 / $17,700 (${READ})`,
      },
    ],
  },
  NONE("NV", "Nevada", [
    {
      url: "https://tax.nv.gov/about-nevada-department-of-taxation/income-tax-in-nevada/",
      note: `Nevada does not impose a state income tax on individuals (${READ})`,
    },
  ]),
  NONE("NH", "New Hampshire", [BLOCKED("https://www.revenue.nh.gov/")], {
    unconfirmed:
      "the repeal of the interest and dividends tax from 2025 (revenue.nh.gov refused automated access)",
  }),
  {
    code: "NJ",
    name: "New Jersey",
    kind: "brackets",
    single: [
      [0, 0.014],
      [20_000, 0.0175],
      [35_000, 0.035],
      [40_000, 0.05525],
      [75_000, 0.0637],
      [500_000, 0.0897],
      [1_000_000, 0.1075],
    ],
    mfj: [
      [0, 0.014],
      [20_000, 0.0175],
      [50_000, 0.0245],
      [70_000, 0.035],
      [80_000, 0.05525],
      [150_000, 0.0637],
      [500_000, 0.0897],
      [1_000_000, 0.1075],
    ],
    exemption: { single: 1_000, mfj: 2_000, dependent: 1_500 },
    approx: "pension exclusion (income-tested, up to $100k MFJ) not modelled",
    sources: [
      {
        url: "https://www.nj.gov/treasury/taxation/pdf/current/1040esi.pdf",
        note: `2026 NJ-1040-ES: Tables A and B; exemptions $1,000 each, $1,500 per dependent (${READ})`,
      },
    ],
  },
  {
    code: "NM",
    name: "New Mexico",
    kind: "brackets",
    single: [
      [0, 0.015],
      [5_500, 0.032],
      [16_500, 0.043],
      [33_500, 0.047],
      [66_500, 0.049],
      [210_000, 0.059],
    ],
    mfj: [
      [0, 0.015],
      [8_000, 0.032],
      [25_000, 0.043],
      [50_000, 0.047],
      [100_000, 0.049],
      [315_000, 0.059],
    ],
    standardDeduction: { single: 16_100, mfj: 32_200 },
    exemption: { single: 0, mfj: 0, dependent: 4_000 },
    taxesSocialSecurity: true,
    approx:
      "NM exempts SS below $100k/$150k income; modelled as taxable. Brackets checked against the 2025 tax rate table (statutory, not indexed)",
    sources: [
      {
        url: "https://realfile.tax.newmexico.gov/2025trt.pdf",
        note: `2025 PIT-1 tax rate table (latest published; the brackets are statutory): 4.9% to $210,000 single / $315,000 joint, 5.9% above (${READ})`,
      },
    ],
  },
  {
    code: "NY",
    name: "New York",
    kind: "brackets",
    single: [
      [0, 0.039],
      [8_500, 0.044],
      [11_700, 0.0515],
      [13_900, 0.054],
      [80_650, 0.059],
      [215_400, 0.0685],
      [1_077_550, 0.0965],
      [5_000_000, 0.103],
      [25_000_000, 0.109],
    ],
    mfj: [
      [0, 0.039],
      [17_150, 0.044],
      [23_600, 0.0515],
      [27_900, 0.054],
      [161_550, 0.059],
      [323_200, 0.0685],
      [2_155_350, 0.0965],
      [5_000_000, 0.103],
      [25_000_000, 0.109],
    ],
    standardDeduction: { single: 8_000, mfj: 16_050 },
    exemption: { single: 0, mfj: 0, dependent: 1_000 },
    retirementExclusion: [{ amount: 20_000, minAge: 59.5 }],
    approx: "benefit recapture for high incomes not modelled",
    sources: [
      {
        url: "https://www.tax.ny.gov/pdf/2026/inc/it2105i_2026.pdf",
        note: `IT-2105-I (2026): New York State and City rate schedules, standard deduction $8,000 / $16,050, $1,000 per dependent (${READ})`,
      },
      {
        url: "https://www.tax.ny.gov/pit/file/information_for_seniors.htm",
        note: `Pension and annuity exclusion up to $20,000 from 59 1/2 (${READ})`,
      },
    ],
  },
  FLAT(
    "NC",
    "North Carolina",
    0.0399,
    [
      {
        url: "https://www.ncdor.gov/taxes-forms/individual-income-tax/tax-rate-schedules",
        note: `Taxable years after 2025: 3.99% (${READ})`,
      },
      {
        url: "https://www.ncdor.gov/taxes-forms/individual-income-tax/filing-topics/north-carolina-standard-deduction-or-north-carolina-itemized-deductions",
        note: `Standard deduction $12,750 / $25,500 (${READ})`,
      },
    ],
    { standardDeduction: { single: 12_750, mfj: 25_500 } },
  ),
  {
    code: "ND",
    name: "North Dakota",
    kind: "brackets",
    single: [
      [0, 0],
      [49_575, 0.0195],
      [250_400, 0.025],
    ],
    mfj: [
      [0, 0],
      [82_800, 0.0195],
      [304_850, 0.025],
    ],
    standardDeduction: { single: 16_100, mfj: 32_200 },
    sources: [
      {
        url: "https://www.tax.nd.gov/sites/www/files/documents/forms/individual/2025-iit/28709-form-nd-1es-2026.pdf",
        note: `2026 Form ND-1ES rate schedules (${READ})`,
      },
    ],
  },
  FLAT(
    "OH",
    "Ohio",
    0.0275,
    [BLOCKED("https://codes.ohio.gov/ohio-revised-code/section-5747.02")],
    {
      single: [
        [0, 0],
        [26_050, 0.0275],
      ],
      mfj: [
        [0, 0],
        [26_050, 0.0275],
      ],
      exemption: { single: 2_400, mfj: 4_800, dependent: 2_400 },
      unconfirmed:
        "the 2026 schedule and exemption (the Revised Code and LSC analyses could not be reached; the Department's 2026 estimate worksheet still shows the 2025 schedule)",
    },
  ),
  {
    code: "OK",
    name: "Oklahoma",
    kind: "brackets",
    single: [
      [0, 0],
      [3_750, 0.025],
      [4_900, 0.035],
      [7_200, 0.045],
    ],
    mfjFactor: 2,
    standardDeduction: { single: 6_350, mfj: 12_700 },
    exemption: { single: 1_000, mfj: 2_000, dependent: 1_000 },
    retirementExclusion: [{ amount: 10_000, minAge: 0 }],
    unconfirmed: "the standard deduction, exemptions and $10,000 retirement exclusion",
    sources: [
      {
        url: "https://oklahoma.gov/content/dam/ok/en/tax/documents/resources/publications/legislation/2025LegislativeUpdate.pdf",
        note: `HB 2764: brackets for tax year 2026 (joint brackets double the single ones) (${READ})`,
      },
    ],
  },
  {
    code: "OR",
    name: "Oregon",
    kind: "brackets",
    single: [
      [0, 0.0475],
      [4_550, 0.0675],
      [11_400, 0.0875],
      [125_000, 0.099],
    ],
    mfjFactor: 2,
    standardDeduction: { single: 2_900, mfj: 5_800 },
    exemption: { single: 260, mfj: 520, dependent: 260, credit: true },
    approx:
      "standard deduction and exemption credit are the Department's estimated 2026 indexed amounts; federal tax subtraction not modelled",
    sources: [
      {
        url: "https://www.oregon.gov/dor/forms/FormsPubs/publication-or-estimate_101-026_2026.pdf",
        note: `2026 Publication OR-ESTIMATE: rate charts S and J, estimated standard deduction $2,900 / $5,800, personal exemption credit $260 (${READ})`,
      },
    ],
  },
  FLAT(
    "PA",
    "Pennsylvania",
    0.0307,
    [
      {
        url: "https://www.pa.gov/agencies/revenue/resources/tax-rates",
        note: `Personal income tax 3.07 percent (${READ})`,
      },
      {
        url: "https://www.pa.gov/content/dam/copapwp-pagov/en/revenue/documents/formsandpublications/formsforindividuals/pit/documents/2025/2025_pa-40in.pdf",
        note: `IRA and retirement distributions on or after 59 1/2 are not taxable (${READ})`,
      },
    ],
    { retirementExclusion: [{ amount: ALL, minAge: 59.5 }] },
  ),
  {
    code: "RI",
    name: "Rhode Island",
    kind: "brackets",
    single: [
      [0, 0.0375],
      [82_050, 0.0475],
      [186_450, 0.0599],
    ],
    mfjFactor: 1,
    standardDeduction: { single: 11_200, mfj: 22_400 },
    exemption: { single: 5_250, mfj: 10_500, dependent: 5_250 },
    taxesSocialSecurity: true,
    sources: [BLOCKED("https://tax.ri.gov/")],
    unconfirmed: "all Rhode Island figures (tax.ri.gov refused automated access)",
  },
  {
    code: "SC",
    name: "South Carolina",
    kind: "brackets",
    single: [
      [0, 0.0199],
      [30_000, 0.0521],
    ],
    mfjFactor: 1,
    standardDeduction: { single: 15_000, mfj: 30_000 },
    exemption: { single: 0, mfj: 0, dependent: 4_930 },
    retirementExclusion: [
      { amount: 3_000, minAge: 0 },
      { amount: 10_000, minAge: 65 },
    ],
    approx:
      "the South Carolina Income Adjusted Deduction is shown at its maximum (it phases out between AGI $40,000 and $95,000 single, $80,000 and $190,000 joint)",
    unconfirmed: "the dependent exemption and the retirement deductions",
    sources: [
      {
        url: "https://dor.sc.gov/iit",
        note: `Tax year 2026: 1.99% below $30,000; 5.21% minus $966 from $30,000 (${READ})`,
      },
      {
        url: "https://dor.sc.gov/sites/dor/files/policies/IL26-23.pdf",
        note: `Information Letter 26-23 (Act 110 of 2026): federal AGI is the starting point; SC Income Adjusted Deduction $15,000 single / $30,000 joint with its phase-out (${READ})`,
      },
    ],
  },
  NONE("SD", "South Dakota", [
    {
      url: "https://dor.sd.gov/individuals/taxes/",
      note: `South Dakota does not impose a state income tax (${READ})`,
    },
  ]),
  NONE("TN", "Tennessee", [
    {
      url: "https://www.tn.gov/revenue/taxes/hall-income-tax.html",
      note: `Hall income tax repealed for tax periods beginning on or after 1 Jan 2021 (${READ})`,
    },
  ]),
  NONE("TX", "Texas", [
    {
      url: "https://comptroller.texas.gov/economy/fiscal-notes/industry/2025/small-biz-info/",
      note: `Texas Comptroller: Texas has no state income tax (${READ})`,
    },
  ]),
  FLAT(
    "UT",
    "Utah",
    0.0445,
    [
      {
        url: "https://le.utah.gov/xcode/title59/chapter10/C59-10-S104_2026050620260506.pdf",
        note: `Utah Code 59-10-104 (effective 1 Jan 2026, ch. 250 of 2026): 4.45% (${READ})`,
      },
    ],
    {
      taxesSocialSecurity: true,
      approx:
        "taxpayer credit (6% of deductions, phased out) and SS/retirement credits not modelled",
    },
  ),
  {
    code: "VT",
    name: "Vermont",
    kind: "brackets",
    single: [
      [0, 0.0335],
      [49_400, 0.066],
      [119_700, 0.076],
      [249_700, 0.0875],
    ],
    mfj: [
      [0, 0.0335],
      [82_500, 0.066],
      [199_450, 0.076],
      [304_000, 0.0875],
    ],
    standardDeduction: { single: 7_650, mfj: 15_300 },
    exemption: { single: 5_300, mfj: 10_600, dependent: 5_300 },
    taxesSocialSecurity: true,
    approx: "MFJ lower thresholds estimated",
    unconfirmed:
      "the 2026 bracket thresholds, standard deduction and exemption (the 2026 rate schedules page could not be opened); the four rates are confirmed",
    sources: [
      {
        url: "https://tax.vermont.gov/sites/tax/files/documents/GB-1210-2026.pdf",
        note: `2026 withholding guide: rates 3.35% / 6.60% / 7.60% / 8.75% (${READ})`,
      },
      BLOCKED("https://tax.vermont.gov/document/2026-vt-rate-schedules"),
    ],
  },
  {
    code: "VA",
    name: "Virginia",
    kind: "brackets",
    single: [
      [0, 0.02],
      [3_000, 0.03],
      [5_000, 0.05],
      [17_000, 0.0575],
    ],
    mfjFactor: 1,
    standardDeduction: { single: 8_750, mfj: 17_500 },
    exemption: { single: 930, mfj: 1_860, dependent: 930 },
    retirementExclusion: [{ amount: 12_000, minAge: 65 }],
    approx: "age deduction income test not modelled",
    sources: [
      {
        url: "https://www.tax.virginia.gov/sites/default/files/vatax-pdf/2025-760-instructions.pdf",
        note: `2025 Form 760 instructions: tax rate schedule (statutory), $930 exemptions, $12,000 age deduction (${READ})`,
      },
      {
        url: "https://www.tax.virginia.gov/news/new-virginia-tax-laws",
        note: `Standard deduction stays $8,750 / $17,500 for tax year 2026 (${READ})`,
      },
    ],
  },
  NONE(
    "WA",
    "Washington",
    [
      {
        url: "https://dor.wa.gov/taxes-rates/other-taxes/capital-gains-tax/do-you-owe-capital-gains-tax",
        note: `Capital gains standard deduction $290,000 for 2026 (${READ})`,
      },
      {
        url: "https://app.leg.wa.gov/RCW/default.aspx?cite=82.87.040",
        note: `RCW 82.87.040: 7%, plus 2.9% on Washington capital gains over $1,000,000 from 2025 (${READ})`,
      },
    ],
    {
      kind: "capital-gains-only",
      capitalGainsTax: {
        deduction: 290_000,
        brackets: [
          [0, 0.07],
          [1_000_000, 0.099],
        ],
      },
      approx:
        "long-term gains on real estate and retirement accounts are exempt; all long-term gains assumed in scope",
    },
  ),
  {
    code: "WV",
    name: "West Virginia",
    kind: "brackets",
    single: [
      [0, 0.0211],
      [10_000, 0.0281],
      [25_000, 0.0316],
      [40_000, 0.0422],
      [60_000, 0.0458],
    ],
    mfjFactor: 1,
    exemption: { single: 2_000, mfj: 4_000, dependent: 2_000 },
    retirementExclusion: [{ amount: 8_000, minAge: 0 }],
    unconfirmed: "the exemption and the $8,000 retirement exclusion",
    sources: [
      {
        url: "https://tax.wv.gov/Individuals/Pages/PersonalIncomeTaxReductionBill.aspx",
        note: `SB 392 (signed 31 March 2026, retroactive to 1 Jan 2026): 2.11% / 2.81% / 3.16% / 4.22% / 4.58% (${READ})`,
      },
    ],
  },
  {
    code: "WI",
    name: "Wisconsin",
    kind: "brackets",
    single: [
      [0, 0.035],
      [15_110, 0.044],
      [51_950, 0.053],
      [332_720, 0.0765],
    ],
    mfjFactor: 4 / 3,
    standardDeduction: { single: 13_960, mfj: 25_840 },
    exemption: { single: 700, mfj: 1_400, dependent: 700 },
    approx: "sliding-scale standard deduction shown at its maximum; MFJ = 4/3 single",
    sources: [BLOCKED("https://www.revenue.wi.gov/")],
    unconfirmed: "all Wisconsin figures (revenue.wi.gov did not resolve)",
  },
  NONE("WY", "Wyoming", [
    {
      url: "https://governor.wyo.gov/news-releases/governor-gordon-urges-property-tax-refund-program-applications",
      note: `Governor's office (27 April 2026): Wyoming does not collect a personal income tax (${READ})`,
    },
  ]),
  {
    code: "DC",
    name: "District of Columbia",
    kind: "brackets",
    single: [
      [0, 0.04],
      [10_000, 0.06],
      [40_000, 0.065],
      [60_000, 0.085],
      [250_000, 0.0925],
      [500_000, 0.0975],
      [1_000_000, 0.1075],
    ],
    mfjFactor: 1,
    standardDeduction: { single: 16_100, mfj: 32_200 },
    sources: [
      {
        url: "https://otr.cfo.dc.gov/sites/default/files/dc/sites/otr/publication/attachments/2026_D40ES_Book_wLinks04012026.pdf",
        note: `2026 D-40ES: tax rate table and standard deduction $16,100 / $32,200 (${READ})`,
      },
    ],
  },
];

export const US_STATE_BY_CODE: Record<string, StateRow> = Object.fromEntries(
  US_STATES_2026.map((s) => [s.code, s]),
);

/**
 * Local income taxes on residents (2026). Rates on wages/earned income unless `onTaxable`.
 * Each row cites the city's or state's official page (read 2026-11-16). Newark's 1% payroll tax is
 * levied on employers, so residents owe nothing.
 */
export interface LocalRow {
  code: string;
  name: string;
  state: string;
  /** Base: 'state-taxable' (NYC uses NY taxable income) or 'earned' (wages + SE). */
  base: "state-taxable" | "earned";
  single: [number, number][];
  mfj?: [number, number][];
  /** Personal exemption deducted from the base (Detroit). */
  exemption?: number;
  source: string;
  /** What the source confirms, and the date read. */
  sourceNote: string;
  /** Figures that could not be confirmed from an official source. */
  unconfirmed?: string;
}

export const US_LOCALS_2026: LocalRow[] = [
  {
    code: "nyc",
    name: "New York City",
    state: "NY",
    base: "state-taxable",
    single: [
      [0, 0.03078],
      [12_000, 0.03762],
      [25_000, 0.03819],
      [50_000, 0.03876],
    ],
    mfj: [
      [0, 0.03078],
      [21_600, 0.03762],
      [45_000, 0.03819],
      [90_000, 0.03876],
    ],
    source: "https://www.tax.ny.gov/pdf/2026/inc/it2105i_2026.pdf",
    sourceNote: `IT-2105-I (2026), New York City resident tax rate schedules (${READ})`,
  },
  {
    code: "philadelphia",
    name: "Philadelphia",
    state: "PA",
    base: "earned",
    // 3.74% to 30 June 2026 and 3.735% from 1 July 2026: (3.74% + 3.735%) / 2 for calendar 2026.
    single: [[0, 0.037375]],
    source:
      "https://www.phila.gov/services/payments-assistance-taxes/taxes/business-taxes/business-taxes-by-type/wage-tax-employers/",
    sourceNote: `Resident Wage Tax 3.74% from 1 July 2025 and 3.735% from 1 July 2026; the calendar-2026 average is applied (${READ})`,
  },
  {
    code: "wilmington",
    name: "Wilmington",
    state: "DE",
    base: "earned",
    single: [[0, 0.0125]],
    source: "https://www.wilmingtonde.gov/residents/earned-income-tax-and-net-profits-tax",
    sourceNote: "City wage tax page; could not be opened on 2026-11-16",
    unconfirmed: "the 1.25% resident rate",
  },
  {
    code: "detroit",
    name: "Detroit",
    state: "MI",
    base: "earned",
    single: [[0, 0.024]],
    exemption: 600,
    source:
      "https://detroitmi.gov/departments/office-chief-financial-officer/ocfo-divisions/office-treasury/income-tax/income-tax-information",
    sourceNote: `Resident individuals 2.4% from 2013; personal exemption $600 from tax year 2005 (${READ})`,
  },
  {
    code: "newark",
    name: "Newark",
    state: "NJ",
    base: "earned",
    single: [[0, 0]],
    source: "https://www.newarknj.gov/647/Payroll-Tax",
    sourceNote: "City payroll tax page; could not be opened on 2026-11-16",
    unconfirmed: "that the 1% payroll tax falls on employers only",
  },
];

export const US_LOCAL_BY_CODE: Record<string, LocalRow> = Object.fromEntries(
  US_LOCALS_2026.map((l) => [l.code, l]),
);
