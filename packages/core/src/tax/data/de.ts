/**
 * Germany (unbeschränkt Steuerpflichtige). Calendar tax year (Veranlagungszeitraum). Nominal EUR.
 * Calculation: ../jurisdictions/de.ts. Every figure below is from the cited statute / official
 * announcement for 2026; nothing is extrapolated. Checked against the sources listed in `sources`
 * on 2026-11-19 (each note gives the section or table). Cross-check: the BMF Lohnsteuer interface
 * (bmf-steuerrechner.de, PAP 2026), see test/tax-de.test.ts.
 *
 * 2027 and later: the Einkommensteuerreformgesetz 2027 (cabinet draft of 2 September 2026:
 * Grundfreibetrag 12,564 EUR in 2027 and 12,900 EUR in 2028, Arbeitnehmer-Pauschbetrag 1,430 EUR, a
 * flatter tariff between 17,800 and 70,600 EUR) was not enacted on 2026-11-19, so it is NOT applied:
 * later years carry the 2026 tables forward and index them with the plan threshold policy.
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
  /**
   * Aktivrente, §3 Nr. 21 EStG (from 1 January 2026): wages for work done from the month after the
   * Regelaltersgrenze are tax-free up to this amount a year (one twelfth a month).
   */
  aktivrente: number;
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

/**
 * §22 Nr. 1 Satz 3 a) aa) EStG: taxable share of statutory pensions by first year of payment. 50% to
 * 2005, +2 points a year to 80% (2020), +1 point to 82% (2022); from 2023 +0.5 points a year
 * (Wachstumschancengesetz), so 84% for 2026 and 100% from 2058. Checked 2026-11-19.
 */
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
  aktivrente: 24_000,
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
      note: "§32a(1) EStG tariff 'ab dem Veranlagungszeitraum 2026' (12,348 / 17,799 / 69,878 / 277,825 and coefficients); splitting §32a(5). Read 2026-11-19",
    },
    {
      url: "https://www.gesetze-im-internet.de/solzg_1995/__3.html",
      note: "§3(3) SolzG: Freigrenze 20,350 / 40,700. Read 2026-11-19",
    },
    {
      url: "https://www.gesetze-im-internet.de/solzg_1995/__4.html",
      note: "Soli 5.5%, 11.9% Milderungszone",
    },
    {
      url: "https://www.gesetze-im-internet.de/estg/__22.html",
      note: "§22 Nr. 1 Satz 3 a) aa) Besteuerungsanteil table: 2023 82.5% ... 2026 84.0%, 2030 86.0%, 2058 100%. Read 2026-11-19",
    },
    {
      url: "https://www.bundesregierung.de/breg-de/aktuelles/beitragsbemessungsgrenzen-2386514",
      note: "SV-Rechengrößen 2026: BBG RV 8,450 / 101,400, knappschaftliche RV 124,800, KV/PV 69,750; Versicherungspflichtgrenze 77,400. Read 2026-11-19",
    },
    {
      url: "https://www.bundesgesundheitsministerium.de/beitraege",
      note: "KV 14.6% (14.0% without Krankengeld), average Zusatzbeitrag 2.9% (2026); Versorgungsbezüge allowance 197.75 EUR a month (not modelled). Read 2026-11-19",
    },
    {
      url: "https://www.bundesgesundheitsministerium.de/themen/pflege/online-ratgeber-pflege/die-pflegeversicherung/finanzierung",
      note: "PV 3.6%; childless surcharge 0.6 points from age 23; -0.25 points per child under 25 from the 2nd to the 5th; Saxony employee 2.3%. Read 2026-11-19",
    },
    {
      url: "https://www.deutsche-rentenversicherung.de/DRV/DE/Experten/Zahlen-und-Fakten/Werte-der-Rentenversicherung/werte-der-rentenversicherung",
      note: "RV 18.6%, AV 2.6%, BBG RV 8,450 a month (2026). Read 2026-11-19",
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
    {
      url: "https://www.gesetze-im-internet.de/estg/__10a.html",
      note: "§10a(1) Riester: up to 2,100 EUR a year incl. the Zulage. Read 2026-11-19",
    },
    {
      url: "https://www.gesetze-im-internet.de/estg/__3.html",
      note: "§3 Nr. 63 bAV 8% of BBG RV; §3 Nr. 21 Aktivrente 24,000 EUR a year from the month after the Regelaltersgrenze. Read 2026-11-19",
    },
    {
      url: "https://www.deutsche-rentenversicherung.de/DRV/DE/Rente/Moeglichkeiten-der-Altersvorsorge/Altervorsorgereformgesetz.html",
      note: "Altersvorsorgereformgesetz (Bundesrat 8 May 2026): new subsidised products replace Riester from 2027; existing contracts keep their rules. The §10a maximum from 2027 is not confirmed (2,100 kept). Read 2026-11-19",
    },
    {
      url: "https://www.bundesregierung.de/breg-de/aktuelles/einkommensteuerreform-2027-2451192",
      note: "Einkommensteuerreformgesetz 2027: cabinet draft only (2 Sep 2026); not applied. Read 2026-11-19",
    },
  ],
};

export const DE_YEARS: readonly DeYear[] = [Y2026];

export const DE_SIMPLIFICATIONS: readonly string[] = [
  "Tax year 2026 (VZ 2026). Later years index the 2026 thresholds with the plan threshold policy. The Einkommensteuerreformgesetz 2027 (cabinet draft: Grundfreibetrag 12,564 EUR in 2027 and 12,900 EUR in 2028, Arbeitnehmer-Pauschbetrag 1,430 EUR, a flatter tariff) was not enacted on 2026-11-19 and is not applied.",
  "Statutory health insurance (GKV) is assumed at the average supplementary rate (2.9%); private health insurance (PKV) is not modelled.",
  "Long-term care: the childless surcharge applies from age 23 when the household has no dependents under 25, unless the de.parent setting says the person has children (grown-up children count). People born before 1940 pay no surcharge. The Saxony employee rate is not modelled.",
  "Children: Kindergeld vs. Kinderfreibetrag comparison (Günstigerprüfung) is not modelled; neither is Kindergeld itself.",
  "Self-employed: no social contributions; no trade tax (Gewerbesteuer).",
  "Employees past the Regelaltersgrenze still pay the employee pension and unemployment contributions in the model; in law they are usually exempt (for example when drawing a full old-age pension).",
  "Statutory pension: the taxable share (Besteuerungsanteil) is applied to the whole pension each year; the fixed Rentenfreibetrag in euros is not frozen. Pensioners pay half the health rate plus the full care rate on the statutory pension and the full rates on bAV pensions (the 197.75 EUR a month Versorgungsbezüge allowance is not modelled). Riester and private pensions pay no contributions.",
  "Riester: contributions are deducted up to 2,100 EUR; the allowance (Zulage) and the Günstigerprüfung are not modelled. Riester, bAV and Rürup payouts are fully taxable except Rürup, which uses the Besteuerungsanteil. The Altersvorsorgereformgesetz (2026) replaces Riester for new contracts from 2027 with new allowances; its deduction maximum is not confirmed, so 2,100 EUR is kept for every year.",
  "Aktivrente (§3 Nr. 21 EStG): wages are tax-free up to 24,000 EUR a year for work from the month after the Regelaltersgrenze. Without a birth month, the birthday is taken as 1 July. It is not checked that the job pays pension contributions or that the person is not a company director.",
  "Capital income: dividends and gains are assumed to come from equity funds (30% Teilfreistellung) unless the de.equityFunds toggle is off; the Vorabpauschale on accumulating funds (an advance on the tax due on sale, so mainly a timing difference) and the Günstigerprüfung (personal rate below 25%) are not modelled.",
  'Unemployment insurance and other "sonstige Vorsorgeaufwendungen" are not deducted (the 1,900 EUR cap is normally used up by health and care contributions).',
  "Altersentlastungsbetrag, Versorgungsfreibetrag, Mini-/Midijobs and the progression clause are not modelled.",
  "Taxable income and income tax are not rounded down to whole euros as §32a EStG requires, so results can differ from an assessment by less than 2 EUR per person.",
];
