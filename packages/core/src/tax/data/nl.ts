/**
 * Netherlands (residents). Calendar tax year. Nominal EUR. Calculation: ../jurisdictions/nl.ts.
 *
 * Every figure was checked against the Belastingdienst pages in `sources` on 2026-11-19.
 *
 * Box 3 regime implemented: after the Hoge Raad's Kerstarrest (24 December 2021) box 3 is taxed under
 * the "overbruggingswet box 3" deemed-return system (forfaitair rendement per asset category:
 * banktegoeden, overige bezittingen, schulden) with the heffingsvrij vermogen. Since the Wet
 * tegenbewijsregeling box 3 (2025) the taxpayer may instead be taxed on the actual return when it is
 * lower; that counter-evidence route is NOT applied (the deemed return is always used). The 2026
 * savings and debt percentages are the provisional figures used for the voorlopige aanslag; the
 * definitive figures are set after the year ends. The Wet werkelijk rendement box 3 (36748: actual
 * return taxed from 2028) passed the Tweede Kamer on 12 February 2026 but was still before the Eerste
 * Kamer on 2026-11-19, with a novelle (37053, 3 November 2026); it is not law and NOT applied. The
 * model assumes the deemed-return system continues in every later year.
 */

export interface NlYear {
  startYear: number;
  label: string;
  box1: {
    /** Under AOW age: [from, rate] (rates include premies volksverzekeringen). */
    belowAow: [number, number][];
    /** AOW age, born on or after 1 January 1946. */
    aow: [number, number][];
    /** AOW age, born before 1 January 1946 (longer first bracket). */
    aowBefore1946: [number, number][];
  };
  /** Algemene heffingskorting: max, phase-out start, phase-out rate (below / at AOW age). */
  ahk: { belowAow: [number, number, number]; aow: [number, number, number] };
  /** Arbeidskorting rows: [from, base, rate] meaning base + rate x (income - from); last row phases out. */
  arbeidskorting: {
    belowAow: [number, number, number][];
    aow: [number, number, number][];
    zeroFrom: number;
  };
  ouderenkorting: { max: number; threshold: number; rate: number };
  alleenstaandeOuderenkorting: number;
  box2: { rows: [number, number][] };
  /**
   * Inkomensafhankelijke bijdrage Zvw paid by the person (pension, AOW, lijfrente, profit); on wages
   * the employer pays the werkgeversheffing instead. Capped at the maximum bijdrage-inkomen.
   */
  zvw: { rate: number; maxIncome: number };
  box3: {
    heffingsvrijVermogen: number;
    schuldendrempel: number;
    returnSavings: number;
    returnOther: number;
    returnDebts: number;
    rate: number;
  };
  sources: { url: string; note?: string }[];
}

const Y2026: NlYear = {
  startYear: 2026,
  label: "2026",
  box1: {
    belowAow: [
      [0, 0.3575],
      [38_883, 0.3756],
      [78_426, 0.495],
    ],
    aow: [
      [0, 0.1785],
      [38_883, 0.3756],
      [78_426, 0.495],
    ],
    aowBefore1946: [
      [0, 0.1785],
      [41_123, 0.3756],
      [78_426, 0.495],
    ],
  },
  ahk: { belowAow: [3_115, 29_736, 0.06398], aow: [1_556, 29_736, 0.03195] },
  arbeidskorting: {
    belowAow: [
      [0, 0, 0.08324],
      [11_965, 996, 0.31009],
      [25_845, 5_300, 0.0195],
      [45_592, 5_685, -0.0651],
    ],
    aow: [
      [0, 0, 0.04156],
      [11_965, 498, 0.15483],
      [25_845, 2_647, 0.00974],
      [45_592, 2_840, -0.0325],
    ],
    zeroFrom: 132_920,
  },
  ouderenkorting: { max: 2_067, threshold: 46_002, rate: 0.15 },
  alleenstaandeOuderenkorting: 540,
  box2: {
    rows: [
      [0, 0.245],
      [68_843, 0.31],
    ],
  },
  zvw: { rate: 0.0485, maxIncome: 79_409 },
  box3: {
    heffingsvrijVermogen: 59_357,
    schuldendrempel: 3_800,
    returnSavings: 0.0128,
    returnOther: 0.06,
    returnDebts: 0.027,
    rate: 0.36,
  },
  sources: [
    {
      url: "https://www.belastingdienst.nl/wps/wcm/connect/fisin/fisin2026/belastingberekening",
      note: "Box 1 brackets (35.75/37.56/49.50; AOW 17.85), box 2 (24.5% to 68,843; 31%), box 3 36% with the 2026 example (59,357; schuldendrempel 3,800) and percentages 1.28 / 6.00 / 2.70; tegenbewijsregeling until new box 3 law (probably 1 January 2028). Read 2026-11-19",
    },
    {
      url: "https://www.belastingdienst.nl/wps/wcm/connect/fisin/fisin2026/heffingskortingen",
      note: "Algemene heffingskorting 3,115 / AOW 1,556, phase-out 6.398% / 3.195% above 29,736; arbeidskorting rows below and at AOW age (zero from 132,920). Read 2026-11-19",
    },
    {
      url: "https://www.belastingdienst.nl/wps/wcm/connect/nl/voorlopige-aanslag/content/voorlopige-aanslag-tarieven-en-heffingskortingen",
      note: "Box 1 incl. born before 1946 (17.85% to 41,123); ouderenkorting 2,067 reduced 15% above 46,002 (nil from 59,782); alleenstaande-ouderenkorting 540; box 3 heffingsvrij vermogen 59,357 (118,714 with partner), percentages 1.28% / 6.00% / 2.70% (voorlopig), 36%. Read 2026-11-19",
    },
    {
      url: "https://www.belastingdienst.nl/wps/wcm/connect/fisin/fisin2026/inkomensafhankelijke_bijdrage_zorgverzekeringswet",
      note: "Bijdrage Zvw 2026: 4.85% on pension, lijfrente and other benefits with loonheffing and on profit (aanslag); werkgeversheffing 6.10% on wages; maximum bijdrage-inkomen 79,409. Read 2026-11-19",
    },
    {
      url: "https://www.svb.nl/nl/aow/bedragen-aow/wat-gaat-er-van-uw-aow-af",
      note: "SVB withholds loonheffing and the bijdrage Zvw (4.85% in 2026) from the AOW of residents. Read 2026-11-19",
    },
    {
      url: "https://www.eerstekamer.nl/wetsvoorstel/36748_wet_werkelijk_rendement_box",
      note: "Wet werkelijk rendement box 3: adopted by the Tweede Kamer 12 Feb 2026; pending in the Eerste Kamer with novelle 37053 (3 Nov 2026); not law. Read 2026-11-19",
    },
    {
      url: "https://www.rijksoverheid.nl/themas/belastingen-uitkeringen-en-toeslagen/algemene-ouderdomswet-aow/aow-leeftijd",
      note: "AOW age 67 (2026-2027), 67y3m for 2028 to 2032 (2032 set; born 1 Jan 1961 - 30 Sep 1965). Read 2026-11-19",
    },
  ],
};

export const NL_YEARS: readonly NlYear[] = [Y2026];

/**
 * AOW age by birth date (Rijksoverheid / SVB, read 2026-11-19). 67 to 2027; 67 years 3 months for
 * 2028 to 2032 (the 2032 age is set), so fixed up to the cohort born 30 Sep 1965. Later cohorts are
 * assumed to keep 67y3m until the cabinet sets them (the age follows life expectancy).
 */
export function nlAowAge(birthYear: number): number {
  return birthYear < 1961 ? 67 : 67.25;
}

export const NL_SIMPLIFICATIONS: readonly string[] = [
  "Tax year 2026; later years index the 2026 tables with the plan threshold policy (2027 figures are not used).",
  "Box 3 uses the 2026 bridging-act deemed returns (provisional savings and debt rates) with the tax-free allowance, for every year. The counter-evidence route (Wet tegenbewijsregeling box 3: tax on the actual return when lower) is not applied, so box 3 can be overstated in years of low returns. The actual-return law (Wet werkelijk rendement box 3, planned for 2028) was not enacted on 2026-11-19 and is not applied.",
  'Box 3 assets come from period-start wealth: savings, taxable investments and debts when the engine supplies them, otherwise the whole portfolio is treated as "other assets" (pensions and real estate are not separated). Partners share the allowance and split box 3 evenly.',
  "Box 3 replaces tax on actual interest, dividends and gains, which are therefore not taxed again; rental income from a second home is assumed to be covered by box 3. Dividend withholding tax credits are ignored.",
  'Box 2 applies only to income items tagged incomeType "nl-box2" (substantial-interest dividends).',
  "The year someone reaches AOW age is taxed at the AOW rate for the whole year if they reach it by 1 January, otherwise at the under-AOW rate (no monthly blend).",
  "Pension and lijfrente contributions are deducted in full; the jaarruimte / reserveringsruimte limits are not computed. Pension income is taxed in box 1.",
  "The income-related Zvw contribution (4.85% in 2026, up to 79,409 EUR of income) is charged on pensions, AOW, pension and lijfrente withdrawals and self-employment profit, less any wages (on which the employer pays). The flat health insurance premium (nominale premie) is not a tax and is not included.",
  "AOW age: 67 to 2027 and 67 years 3 months from 2028, fixed by law up to 2032; later cohorts are assumed to stay at 67 years 3 months although the age follows life expectancy.",
  "Not modelled: mortgage interest deduction and eigenwoningforfait, inkomensafhankelijke combinatiekorting, self-employed deductions (zelfstandigenaftrek, MKB-winstvrijstelling), fiscal-partner allocation of common items, the limit on deductions at the top rate, and the non-refundability split between tax and premium parts of the credits.",
];
