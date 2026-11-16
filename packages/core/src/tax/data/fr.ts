/**
 * France (résidents fiscaux). Calendar income year. Nominal EUR. Calculation: ../jurisdictions/fr.ts.
 *
 * Income-tax figures are the loi n° 2026-103 du 19 février 2026 de finances pour 2026 values, which
 * tax 2025 income (the latest enacted barème; the 2027 finance law setting the barème for 2026
 * income is not enacted). They are used for 2025 income and, under the threshold policy, carried
 * forward. Social contributions and prélèvements sociaux are the 2026 rates.
 */

export interface FrYear {
  startYear: number;
  label: string;
  bareme: [number, number][];
  quotient: { capPerHalfPart: number };
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
  pensionsSocial: { csg: number; csgDeductible: number; crds: number; casa: number };
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
  quotient: { capPerHalfPart: 1_807 },
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
  pensionsSocial: { csg: 0.083, csgDeductible: 0.059, crds: 0.005, casa: 0.003 },
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
      note: "Barème 2026 (revenus 2025), plafonnement du quotient familial 1,807 per half-part",
    },
    {
      url: "https://bofip.impots.gouv.fr/bofip/2495-PGP.html/identifiant=BOI-IR-LIQ-20-20-30-20260407",
      note: "Décote 897 / 1,483 - 45.25% (revenus 2025)",
    },
    {
      url: "https://www.impots.gouv.fr/particulier/questions/comment-puis-je-beneficier-de-la-deduction-forfaitaire-de-10",
      note: "Déduction forfaitaire 10%: min 509, max 14,555 (revenus 2025)",
    },
    {
      url: "https://www.impots.gouv.fr/particulier/pensions-de-retraite",
      note: "Abattement pensions 10%, max 4,439 per foyer, min 454",
    },
    {
      url: "https://www.urssaf.fr/accueil/outils-documentation/taux-baremes/plafonds-securite-sociale.html",
      note: "PASS 2026 48,060 (2025: 47,100)",
    },
    {
      url: "https://reglementation.agirc-arrco.fr/home/baremes/listes-area/baremes-1/cotisations-au-regime-agirc-arrco-en-2026.html",
      note: "AGIRC-ARRCO employee 3.15% + CEG 0.86% (T1), 8.64% + 1.08% (T2), CET 0.14%",
    },
    {
      url: "https://www.service-public.gouv.fr/particuliers/vosdroits/F2329",
      note: "Prélèvements sociaux 2026: 18.6% general, 17.2% assurance-vie and property; CSG deductible 6.8 points",
    },
    {
      url: "https://entreprendre.service-public.gouv.fr/actualites/A18796",
      note: "PFU 31.4% from 1 Jan 2026 (12.8% income tax + 18.6% social)",
    },
    {
      url: "https://www.impots.gouv.fr/particulier/lassurance-vie-et-le-pea-0",
      note: "Assurance-vie after 8 years: 4,600 / 9,200 allowance, 7.5%; PEA after 5 years",
    },
    {
      url: "https://www.service-public.gouv.fr/particuliers/vosdroits/F34982",
      note: "PER deduction: 10% of professional income, max 10% of 8 PASS, min 10% PASS (prior year)",
    },
    {
      url: "https://www.service-public.gouv.fr/particuliers/vosdroits/F2971",
      note: "CSG/CRDS/CASA on pensions (full rate 8.3% + 0.5% + 0.3%, 5.9 points deductible)",
    },
  ],
};

export const FR_YEARS: readonly FrYear[] = [Y];

export const FR_SIMPLIFICATIONS: readonly string[] = [
  "Income tax uses the barème, décote and allowances of the 2026 finance law (2025 income), carried forward with the threshold policy; the 2027 law for 2026 income is not enacted.",
  "The PFU is 31.4% from 2026 (12.8% income tax + 18.6% prélèvements sociaux); assurance-vie, property income and gains keep 17.2%. The barème option (law toggle fr.baremeOption) applies to all capital income of the household.",
  "Salaries are gross: employee pension contributions (vieillesse, AGIRC-ARRCO incl. CEG/CET) and CSG/CRDS are deducted; health, unemployment and prévoyance contributions (mostly employer-paid) and executive (APEC) contributions are not modelled. Self-employed social contributions are not modelled (only CSG/CRDS).",
  "Pensions pay CSG at the full 8.3% rate plus CRDS and CASA; the reduced and zero rates by household income are not modelled. PER withdrawals are taxed as pensions (no split between the capital and gains parts); the PER is locked until 64.",
  "PEA and assurance-vie: gains are taxed only on withdrawal and are assumed held for 5 / 8 years (law toggles fr.peaHeld5Years and fr.assuranceVieHeld8Years); the 12.8% rate above 150,000 EUR of assurance-vie premiums is not modelled. The engine keeps their dividends inside the wrapper (no annual tax; part of the gain on withdrawal).",
  "Quotient familial: children under 18 count; a single parent gets the extra half part at the general 1,807 EUR cap (the 4,262 EUR first-child cap and other special half parts are not modelled).",
  "PER deductions are capped at 10% of the current year's professional income (the law uses the prior year and allows carry-forward of unused ceilings).",
  "Not modelled: contribution exceptionnelle sur les hauts revenus, tax reductions/credits other than user-entered credits, real-expense regimes, micro-BIC/BNC allowances, IFI (property wealth tax).",
];
