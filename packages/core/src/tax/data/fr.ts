/**
 * France (résidents fiscaux). Calendar income year. Nominal EUR. Calculation: ../jurisdictions/fr.ts.
 *
 * Income-tax figures are the loi n° 2026-103 du 19 février 2026 de finances pour 2026 values, which
 * tax 2025 income (the latest enacted barème; the 2027 finance law setting the barème for 2026
 * income is not enacted). They are used for 2025 income and, under the threshold policy, carried
 * forward. Social contributions and prélèvements sociaux are the 2026 rates. Checked against the
 * sources in `sources` on 2026-11-19 (impots.gouv.fr was down for maintenance that day, so the
 * service-public.gouv.fr and BOFiP pages were used).
 *
 * In flux on 2026-11-19 and NOT applied: the projet de loi de finances pour 2027 (barème for 2026
 * income, and a proposed 3,000 EUR sub-cap on the 10% pension allowance, which the Assemblée's
 * finance committee removed), and the 2027 PASS of 48,900 EUR announced by service-public.gouv.fr
 * (the 2026 figure is indexed instead).
 */

export interface FrYear {
  startYear: number;
  label: string;
  bareme: [number, number][];
  /** Plafonnement du QF: per half-part, and for the two half-parts of a single parent's first child. */
  quotient: { capPerHalfPart: number; capSingleParentFirstChild: number };
  decote: { single: number; couple: number; rate: number };
  fraisPro: { rate: number; min: number; max: number };
  pensionAllowance: { rate: number; minPerPerson: number; maxPerHousehold: number };
  /** Micro-foncier: gross rents up to `limit` get a flat `allowance` (régime réel otherwise). */
  microFoncier: { limit: number; allowance: number };
  payroll: {
    /** Plafond annuel de la Sécurité sociale (2026). */
    pass: number;
    vieillessePlafonnee: number;
    vieillesseDeplafonnee: number;
    /** AGIRC-ARRCO employee share incl. CEG: tranche 1 (to 1 PASS), tranche 2 (1-8 PASS). */
    agircT1: number;
    agircT2: number;
    /** CET, employee share, on earnings up to 8 PASS when earnings exceed 1 PASS. */
    cet: number;
    csgBaseShare: number;
    csgBaseCapPass: number;
    csg: number;
    csgDeductible: number;
    crds: number;
  };
  /**
   * CSG / CRDS / CASA on pensions by tier of revenu fiscal de référence (the RFR of two years
   * earlier): a tier applies above `rfrAbove` for one part, plus `perHalfPart` per extra half-part.
   * Ordered from the lowest tier (taux zéro) up to the normal rate.
   */
  pensionsSocial: {
    label: string;
    rfrAbove: number;
    perHalfPart: number;
    csg: number;
    csgDeductible: number;
    crds: number;
    casa: number;
  }[];
  capital: {
    pfuIncomeTax: number;
    socialGeneral: number;
    socialAssuranceVieAndProperty: number;
    csgDeductible: number;
    dividendAllowance: number;
  };
  assuranceVie: { allowanceSingle: number; allowanceCouple: number; rateAfter8: number };
  per: { rate: number; passPriorYear: number; maxPass: number };
  sources: { url: string; note?: string }[];
}

const Y: FrYear = {
  startYear: 2025,
  label: "revenus 2025 (LF 2026) / social 2026",
  bareme: [
    [0, 0],
    [11_600, 0.11],
    [29_579, 0.3],
    [84_577, 0.41],
    [181_917, 0.45],
  ],
  quotient: { capPerHalfPart: 1_807, capSingleParentFirstChild: 4_262 },
  decote: { single: 897, couple: 1_483, rate: 0.4525 },
  fraisPro: { rate: 0.1, min: 509, max: 14_555 },
  pensionAllowance: { rate: 0.1, minPerPerson: 454, maxPerHousehold: 4_439 },
  microFoncier: { limit: 15_000, allowance: 0.3 },
  payroll: {
    pass: 48_060,
    vieillessePlafonnee: 0.069,
    vieillesseDeplafonnee: 0.004,
    agircT1: 0.0315 + 0.0086,
    agircT2: 0.0864 + 0.0108,
    cet: 0.0014,
    csgBaseShare: 0.9825,
    csgBaseCapPass: 4,
    csg: 0.092,
    csgDeductible: 0.068,
    crds: 0.005,
  },
  pensionsSocial: [
    { label: "taux zéro", rfrAbove: 0, perHalfPart: 0, csg: 0, csgDeductible: 0, crds: 0, casa: 0 },
    {
      label: "taux réduit",
      rfrAbove: 13_048,
      perHalfPart: 3_484,
      csg: 0.038,
      csgDeductible: 0.038,
      crds: 0.005,
      casa: 0,
    },
    {
      label: "taux médian",
      rfrAbove: 17_057,
      perHalfPart: 4_555,
      csg: 0.066,
      csgDeductible: 0.042,
      crds: 0.005,
      casa: 0.003,
    },
    {
      label: "taux normal",
      rfrAbove: 26_472,
      perHalfPart: 7_066,
      csg: 0.083,
      csgDeductible: 0.059,
      crds: 0.005,
      casa: 0.003,
    },
  ],
  capital: {
    pfuIncomeTax: 0.128,
    socialGeneral: 0.186,
    socialAssuranceVieAndProperty: 0.172,
    csgDeductible: 0.068,
    dividendAllowance: 0.4,
  },
  assuranceVie: { allowanceSingle: 4_600, allowanceCouple: 9_200, rateAfter8: 0.075 },
  per: { rate: 0.1, passPriorYear: 47_100, maxPass: 8 },
  sources: [
    {
      url: "https://www.service-public.gouv.fr/particuliers/vosdroits/F1419",
      note: "Barème 2026 (revenus 2025): 11,600 / 29,579 / 84,577 / 181,917; plafonnement du QF 1,807 per half-part, 4,262 for a single parent's first child (verified by the page 12 Nov 2026). Read 2026-11-19",
    },
    {
      url: "https://bofip.impots.gouv.fr/bofip/2495-PGP.html/identifiant=BOI-IR-LIQ-20-20-30-20260407",
      note: "Décote 897 / 1,483 - 45.25% (revenus 2025). Read 2026-11-19",
    },
    {
      url: "https://www.service-public.gouv.fr/particuliers/vosdroits/F1989",
      note: "Déduction forfaitaire 10%: min 509, max 14,555 per member of the foyer (revenus 2025). Read 2026-11-19",
    },
    {
      url: "https://www.service-public.gouv.fr/particuliers/vosdroits/F415",
      note: "Abattement pensions 10%: min 454 per pensioner, max 4,439 per foyer (déclaration 2026). Read 2026-11-19",
    },
    {
      url: "https://www.urssaf.fr/accueil/outils-documentation/taux-baremes/plafonds-securite-sociale.html",
      note: "PASS 2026 48,060 (4,005 a month; arrêté du 22 décembre 2025); 2025: 47,100. Read 2026-11-19 via service-public / Légifrance (urssaf.fr did not answer)",
    },
    {
      url: "https://reglementation.agirc-arrco.fr/home/baremes/listes-area/baremes-1/cotisations-au-regime-agirc-arrco-en-2026.html",
      note: "AGIRC-ARRCO employee 3.15% + CEG 0.86% (T1), 8.64% + 1.08% (T2), CET 0.14%. NOT re-read on 2026-11-19 (the site's certificate failed); unchanged since 2019",
    },
    {
      url: "https://www.service-public.gouv.fr/particuliers/vosdroits/F2329",
      note: "Prélèvements sociaux on income received in 2026: 18.6% (CSG 10.6, CRDS 0.5, solidarité 7.5) in general incl. dividends and securities gains; 17.2% for assurance-vie, PEL, CEL, PEP, revenus fonciers and property gains; 6.8 points of CSG deductible under the barème (loi n° 2025-1403 du 30 décembre 2025, art. 12). Read 2026-11-19",
    },
    {
      url: "https://entreprendre.service-public.gouv.fr/actualites/A18796",
      note: "PFU 31.4% from 1 Jan 2026 (12.8% income tax + 18.6% social). Read 2026-11-19",
    },
    {
      url: "https://www.service-public.gouv.fr/particuliers/vosdroits/F22414",
      note: "Assurance-vie (premiums from 27 Sep 2017): after 8 years 4,600 / 9,200 allowance then 7.5% (12.8% on the share above 150,000 of premiums); before 8 years 12.8%; social 17.2%. Read 2026-11-19",
    },
    {
      url: "https://www.service-public.gouv.fr/particuliers/vosdroits/F22449",
      note: "PEA: gains exempt from income tax after 5 years, 12.8% before; CSG/CRDS due in both cases (rate not stated on the page). Read 2026-11-19",
    },
    {
      url: "https://www.service-public.gouv.fr/particuliers/vosdroits/F34982",
      note: "PER deduction: 10% of professional income, max 10% of 8 PASS, min 10% PASS (prior year). Not re-read on 2026-11-19",
    },
    {
      url: "https://www.service-public.gouv.fr/particuliers/vosdroits/F2971",
      note: "CSG/CRDS/CASA on pensions in 2026 by 2024 RFR: zéro to 13,048; réduit 3.8% (all deductible) + 0.5% to 17,057; médian 6.6% (4.2 deductible) + 0.5% + 0.3% to 26,472; normal 8.3% (5.9 deductible) + 0.5% + 0.3%; +3,484 / 4,555 / 7,066 per extra half-part (verified 1 Jun 2026). Read 2026-11-19",
    },
    {
      url: "https://www.service-public.gouv.fr/particuliers/vosdroits/F14043",
      note: "Âge légal de départ by date of birth after the LFSS 2026 suspension: 62y9m for 1963 to 31 Mar 1965, 63 for Apr-Dec 1965, 63y3m 1966, 63y6m 1967, 63y9m 1968, 64 from 1969 (verified 14 Aug 2026). Read 2026-11-19",
    },
  ],
};

export const FR_YEARS: readonly FrYear[] = [Y];

/**
 * Âge légal de départ à la retraite by birth year, under the 2023 reform as suspended by the LFSS
 * 2026 (service-public.gouv.fr F14043, verified 14 August 2026): 62 to 31 August 1961; 62y3m from
 * 1 September 1961; 62y6m for 1962; 62y9m for 1963, 1964 and January to March 1965; 63 for April to
 * December 1965; then +3 months a year to 64 from 1969. Without a birth month, 1961 counts as 62y3m
 * and 1965 as 63.
 */
export function frLegalRetirementAge(birthYear: number, birthMonth?: number): number {
  if (birthYear <= 1960) return 62;
  if (birthYear === 1961 && birthMonth !== undefined && birthMonth < 9) return 62;
  if (birthYear === 1965 && birthMonth !== undefined && birthMonth <= 3) return 62.75;
  if (birthYear <= 1963) return 62 + 0.25 * (birthYear - 1960);
  if (birthYear === 1964) return 62.75;
  return Math.min(64, 63 + 0.25 * (birthYear - 1965));
}

export const FR_SIMPLIFICATIONS: readonly string[] = [
  "Income tax uses the barème, décote and allowances of the 2026 finance law (2025 income), carried forward with the threshold policy; the 2027 law for 2026 income is not enacted.",
  "The PFU is 31.4% from 2026 (12.8% income tax + 18.6% prélèvements sociaux); assurance-vie, property income and gains keep 17.2%. The barème option (law toggle fr.baremeOption) applies to all capital income of the household.",
  "Salaries are gross: employee pension contributions (vieillesse, AGIRC-ARRCO incl. CEG/CET) and CSG/CRDS are deducted; health, unemployment and prévoyance contributions (mostly employer-paid) and executive (APEC) contributions are not modelled. Self-employed social contributions are not modelled (only CSG/CRDS).",
  "Pensions pay CSG, CRDS and CASA at the zero, reduced, median or normal rate by household income. The law uses the revenu fiscal de référence of two years earlier; the model uses the same year's income (net taxable income plus capital income under the PFU) and does not apply the rule that smooths a change of tier. PER withdrawals are taxed as pensions (no split between the capital and gains parts); the PER opens at the legal retirement age.",
  "Legal retirement age follows the LFSS 2026 suspension (62 years 9 months for people born from 1963 to March 1965, 64 from 1969); the state pension starts there by default (early retirement for long careers is not modelled).",
  "PEA and assurance-vie: gains are taxed only on withdrawal and are assumed held for 5 / 8 years (law toggles fr.peaHeld5Years and fr.assuranceVieHeld8Years); the 12.8% rate above 150,000 EUR of assurance-vie premiums, premiums paid before 27 September 2017 and the historic social-contribution rates on PEA gains made before 2018 are not modelled. PEA gains pay the general 18.6% rate. The engine keeps their dividends inside the wrapper (no annual tax; part of the gain on withdrawal).",
  "Quotient familial: children under 18 count; a single parent's first child is capped at 4,262 EUR and further half-parts at 1,807 EUR. Other special half-parts (disability, veterans, people living alone who raised children) are not modelled.",
  "PER deductions are capped at 10% of the current year's professional income (the law uses the prior year and allows carry-forward of unused ceilings).",
  "Prélèvements sociaux: the 18.6% general rate applies to income received from 2026; a plan year before 2026 also uses it (17.2% applied to 2025 income).",
  "Not modelled: contribution exceptionnelle sur les hauts revenus (CEHR) and the contribution différentielle sur les hauts revenus (CDHR, a 20% minimum tax above 250,000 / 500,000 EUR), tax reductions/credits other than user-entered credits, real-expense regimes, micro-BIC/BNC allowances, IFI (property wealth tax).",
];
