/**
 * Germany (unbeschränkt Steuerpflichtige). Calendar tax year (Veranlagungszeitraum). Nominal EUR.
 * Calculation: ../jurisdictions/de.ts. Every figure below is from the cited statute / official
 * announcement for 2026; nothing is extrapolated.
 */

export interface DeYear {
  startYear: number;
  label: string;
  /** §32a(1) EStG tariff: zone edges and formula coefficients (y, z in units of 10,000 EUR). */
  tariff: {
    grundfreibetrag: number;
    zone2End: number;
    zone2: [number, number];
    zone3End: number;
    zone3: [number, number, number];
    zone4End: number;
    zone4Minus: number;
    zone5Minus: number;
  };
  soli: { rate: number; freigrenzeSingle: number; freigrenzeJoint: number; milderungsRate: number };
  /** Kirchensteuer: 8% in Bayern and Baden-Württemberg, 9% elsewhere (optional, law toggle). */
  churchTax: { rate: number; reducedRate: number; reducedRegions: string[] };
  social: {
    /** Gesetzliche Rentenversicherung (total; employee pays half). */
    pension: number;
    unemployment: number;
    health: number;
    /** Durchschnittlicher Zusatzbeitragssatz (each Krankenkasse sets its own). */
    healthSupplementAverage: number;
    longTermCare: number;
    longTermCareChildlessSurcharge: number;
    longTermCareChildDiscount: number;
    /** Beitragsbemessungsgrenzen (annual). */
    ceilingPension: number;
    ceilingHealth: number;
    /** Share of the employee health contribution not deductible (Krankengeld portion, §10(1) Nr. 3). */
    sickPayShare: number;
  };
  capital: {
    /** Abgeltungsteuer §32d(1) EStG. */
    rate: number;
    sparerPauschbetrag: number;
    /** Teilfreistellung for equity funds §20(1) InvStG. */
    equityFundExemption: number;
  };
  allowances: { werbungskosten: number; werbungskostenPensions: number; sonderausgaben: number };
  pensions: {
    /** §10(3) EStG: Höchstbeitrag knappschaftliche Rentenversicherung (124,800 x 24.7%, rounded up). */
    altersvorsorgeMax: number;
    /** §10a EStG Riester Sonderausgabenabzug (incl. allowances). */
    riesterMax: number;
    /** §3 Nr. 63 EStG: bAV contributions tax-free up to 8% of the pension BBG. */
    bavTaxFreeShare: number;
    /** §1(1) Nr. 9 SvEV: social-security-free up to 4% of the pension BBG. */
    bavSocialFreeShare: number;
    /** Earliest payout age for Riester/Rürup/bAV contracts concluded from 2012. */
    accessAge: number;
  };
  sources: { url: string; note?: string }[];
}

/** §22 Nr. 1 Satz 3 a) aa) EStG: taxable share of statutory pensions by first year of payment. */
/**
 * Regelaltersgrenze (§235 SGB VI): 65 for cohorts born up to 1946, +1 month a year for 1947-1958
 * (66 for 1958), +2 months a year for 1959-1963, 67 from the 1964 cohort.
 */
export function deRegelaltersgrenze(birthYear: number): number {
  if (birthYear <= 1946) return 65;
  if (birthYear <= 1958) return 65 + (birthYear - 1946) / 12;
  if (birthYear <= 1963) return 66 + (2 * (birthYear - 1958)) / 12;
  return 67;
}

/** Zugangsfaktor uplift for a statutory pension drawn after the Regelaltersgrenze (§77 SGB VI): +0.5% a month. */
export const DE_DEFERRAL_UPLIFT_PER_MONTH = 0.005;

export function deBesteuerungsanteil(startYear: number): number {
  if (startYear <= 2005) return 0.5;
  if (startYear <= 2020) return 0.5 + 0.02 * (startYear - 2005);
  if (startYear <= 2022) return 0.8 + 0.01 * (startYear - 2020);
  return Math.min(1, 0.825 + 0.005 * (startYear - 2023));
}

const Y2026: DeYear = {
  startYear: 2026,
  label: "2026",
  tariff: {
    grundfreibetrag: 12_348,
    zone2End: 17_799,
    zone2: [914.51, 1_400],
    zone3End: 69_878,
    zone3: [173.1, 2_397, 1_034.87],
    zone4End: 277_825,
    zone4Minus: 11_135.63,
    zone5Minus: 19_470.38,
  },
  soli: { rate: 0.055, freigrenzeSingle: 20_350, freigrenzeJoint: 40_700, milderungsRate: 0.119 },
  churchTax: { rate: 0.09, reducedRate: 0.08, reducedRegions: ["BY", "BW"] },
  social: {
    pension: 0.186,
    unemployment: 0.026,
    health: 0.146,
    healthSupplementAverage: 0.029,
    longTermCare: 0.036,
    longTermCareChildlessSurcharge: 0.006,
    longTermCareChildDiscount: 0.0025,
    ceilingPension: 101_400,
    ceilingHealth: 69_750,
    sickPayShare: 0.04,
  },
  capital: { rate: 0.25, sparerPauschbetrag: 1_000, equityFundExemption: 0.3 },
  allowances: { werbungskosten: 1_230, werbungskostenPensions: 102, sonderausgaben: 36 },
  pensions: {
    altersvorsorgeMax: 30_826,
    riesterMax: 2_100,
    bavTaxFreeShare: 0.08,
    bavSocialFreeShare: 0.04,
    accessAge: 62,
  },
  sources: [
    {
      url: "https://www.gesetze-im-internet.de/estg/__32a.html",
      note: "§32a EStG tariff from VZ 2026; splitting §32a(5)",
    },
    {
      url: "https://www.gesetze-im-internet.de/solzg_1995/__3.html",
      note: "Soli Freigrenze 20,350 / 40,700",
    },
    {
      url: "https://www.gesetze-im-internet.de/solzg_1995/__4.html",
      note: "Soli 5.5%, 11.9% Milderungszone",
    },
    {
      url: "https://www.gesetze-im-internet.de/estg/__22.html",
      note: "Besteuerungsanteil table (84% for 2026)",
    },
    {
      url: "https://www.bundesregierung.de/breg-de/aktuelles/beitragsbemessungsgrenzen-2386514",
      note: "SV-Rechengrößen 2026: BBG RV 101,400, KV 69,750 (Knappschaft 124,800)",
    },
    {
      url: "https://www.bundesgesundheitsministerium.de/beitraege",
      note: "KV 14.6%, average Zusatzbeitrag 2.9% (2026)",
    },
    {
      url: "https://www.bundesgesundheitsministerium.de/themen/pflege/online-ratgeber-pflege/die-pflegeversicherung/finanzierung",
      note: "PV 3.6%, childless +0.6, -0.25 per child 2-5 under 25",
    },
    {
      url: "https://www.deutsche-rentenversicherung.de/DRV/DE/Experten/Zahlen-und-Fakten/Werte-der-Rentenversicherung/werte-der-rentenversicherung",
      note: "RV 18.6%, AV 2.6% (2026)",
    },
    { url: "https://www.gesetze-im-internet.de/estg/__32d.html", note: "Abgeltungsteuer 25%" },
    {
      url: "https://www.gesetze-im-internet.de/estg/__20.html",
      note: "Sparer-Pauschbetrag 1,000 / 2,000 (§20(9))",
    },
    {
      url: "https://www.gesetze-im-internet.de/invstg_2018/__20.html",
      note: "Teilfreistellung 30% equity funds",
    },
    {
      url: "https://www.gesetze-im-internet.de/estg/__9a.html",
      note: "Werbungskosten-Pauschbeträge 1,230 / 102",
    },
    {
      url: "https://www.gesetze-im-internet.de/estg/__10.html",
      note: "Vorsorgeaufwendungen, Höchstbetrag §10(3)",
    },
    { url: "https://www.gesetze-im-internet.de/estg/__10a.html", note: "Riester 2,100" },
    { url: "https://www.gesetze-im-internet.de/estg/__3.html", note: "§3 Nr. 63 bAV 8% of BBG RV" },
  ],
};

export const DE_YEARS: readonly DeYear[] = [Y2026];

export const DE_SIMPLIFICATIONS: readonly string[] = [
  "Tax year 2026 (VZ 2026). Later years index the 2026 thresholds with the plan threshold policy.",
  "Statutory health insurance (GKV) is assumed at the average supplementary rate (2.9%); private health insurance (PKV) is not modelled.",
  "Long-term care: childless surcharge when the household has no dependents; the Saxony employee rate is not modelled.",
  "Children: Kindergeld vs. Kinderfreibetrag comparison (Günstigerprüfung) is not modelled; neither is Kindergeld itself.",
  "Self-employed: no social contributions; no trade tax (Gewerbesteuer).",
  "Statutory pension: the taxable share (Besteuerungsanteil) is applied to the whole pension each year; the fixed Rentenfreibetrag in euros is not frozen. Pensioners pay half the health rate plus the full care rate on the statutory pension and the full rates on other pensions (the Versorgungsbezüge allowance is not modelled).",
  "Riester: contributions are deducted up to 2,100 EUR; the allowance (Zulage) and the Günstigerprüfung are not modelled. Riester, bAV and Rürup payouts are fully taxable except Rürup, which uses the Besteuerungsanteil.",
  "Capital income: dividends and gains are assumed to come from equity funds (30% Teilfreistellung) unless the de.equityFunds toggle is off; the Vorabpauschale and the Günstigerprüfung (personal rate below 25%) are not modelled.",
  'Unemployment insurance and other "sonstige Vorsorgeaufwendungen" are not deducted (the 1,900 EUR cap is normally used up by health and care contributions).',
  "Altersentlastungsbetrag, Versorgungsfreibetrag, Mini-/Midijobs and the progression clause are not modelled.",
  "Taxable income and income tax are not rounded down to whole euros as §32a EStG requires, so results can differ from an assessment by less than 2 EUR per person.",
];
