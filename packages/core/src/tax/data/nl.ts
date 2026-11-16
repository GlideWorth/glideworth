/**
 * Netherlands (residents). Calendar tax year. Nominal EUR. Calculation: ../jurisdictions/nl.ts.
 *
 * Box 3 regime implemented: the 2026 "overbruggingswet box 3" deemed-return system (forfaitair
 * rendement per asset category: banktegoeden, overige bezittingen, schulden) with the
 * heffingsvrij vermogen. The statutory counter-evidence route (tegenbewijsregeling: tax the actual
 * return when lower) is NOT applied. The 2026 savings and debt percentages are the provisional
 * figures the Belastingdienst uses for the voorlopige aanslag; the definitive figures are set after
 * the year ends. The actual-return system (Wet werkelijk rendement box 3) is not in force for 2026.
 */

export interface NlYear {
  startYear: number;
  label: string;
  box1: {
    /** Under AOW age: [from, rate] (rates include premies volksverzekeringen). */
    belowAow: [number, number][];
    /** AOW age, born on or after 1 January 1946. */
    aow: [number, number][];
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
      note: "Box 1 brackets (35.75/37.56/49.50; AOW 17.85), box 2 (24.5% to 68,843; 31%), box 3 rates (Fiscale informatie 2026, ch. 29)",
    },
    {
      url: "https://www.belastingdienst.nl/wps/wcm/connect/fisin/fisin2026/heffingskortingen",
      note: "Algemene heffingskorting, arbeidskorting, ouderenkorting 2026 (below and at AOW age)",
    },
    {
      url: "https://www.belastingdienst.nl/wps/wcm/connect/nl/voorlopige-aanslag/content/voorlopige-aanslag-tarieven-en-heffingskortingen",
      note: "Box 3 heffingsvrij vermogen 59,357 (118,714 with partner); deemed returns 1.28% / 6.00% / 2.70% (provisional); 36%; alleenstaande-ouderenkorting 540",
    },
    {
      url: "https://www.rijksoverheid.nl/themas/belastingen-uitkeringen-en-toeslagen/algemene-ouderdomswet-aow/aow-leeftijd",
      note: "AOW age 67 (2026-2027), 67y3m from 2028 (born 1 Jan 1961 - 30 Sep 1965)",
    },
  ],
};

export const NL_YEARS: readonly NlYear[] = [Y2026];

/**
 * AOW age by birth date (Rijksoverheid / SVB). Fixed by law up to the cohort born 30 Sep 1965
 * (67 years 3 months); later cohorts are assumed to keep 67y3m until the cabinet sets them.
 */
export function nlAowAge(birthYear: number): number {
  return birthYear < 1961 ? 67 : 67.25;
}

export const NL_SIMPLIFICATIONS: readonly string[] = [
  "Tax year 2026. Box 3 uses the 2026 bridging-act deemed returns (provisional savings and debt rates) with the tax-free allowance; the counter-evidence route (tax on the actual return when lower) is not applied.",
  'Box 3 assets come from period-start wealth: savings, taxable investments and debts when the engine supplies them, otherwise the whole portfolio is treated as "other assets" (pensions and real estate are not separated). Partners share the allowance and split box 3 evenly.',
  "Box 3 replaces tax on actual interest, dividends and gains, which are therefore not taxed again; rental income from a second home is assumed to be covered by box 3. Dividend withholding tax credits are ignored.",
  'Box 2 applies only to income items tagged incomeType "nl-box2" (substantial-interest dividends).',
  "People born before 1946 use the same first-bracket edge as later cohorts. The year someone reaches AOW age is taxed at the AOW rate for the whole year if they reach it by 1 January, otherwise at the under-AOW rate (no monthly blend).",
  "Pension and lijfrente contributions are deducted in full; the jaarruimte / reserveringsruimte limits are not computed. Pension income is taxed in box 1.",
  "Not modelled: mortgage interest deduction and eigenwoningforfait, inkomensafhankelijke combinatiekorting, the Zvw income-related contribution for pensioners and self-employed, self-employed deductions (zelfstandigenaftrek, MKB-winstvrijstelling), fiscal-partner allocation of common items, the limit on deductions at the top rate, and the non-refundability split between tax and premium parts of the credits.",
];
