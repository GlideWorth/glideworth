/**
 * Spain (residents in territorio común; not Navarra / País Vasco). Calendar tax year. Nominal EUR.
 * Calculation: ../jurisdictions/es.ts.
 *
 * Checked against official sources on 2026-11-19:
 * - State IRPF scales, minimums, work-income reduction and pension-plan limits: Ley 35/2006 (LIRPF),
 *   consolidated text in the BOE (last updated 18/11/2026), arts. 19, 20, 52, 57, 58, 63, 66, 76. These
 *   articles have no end date, so the same figures apply to 2025 and 2026.
 * - Regional IRPF scales: AEAT Manual práctico de Renta 2025 (the latest the AEAT has published).
 *   They are used for 2026 too; 2026 regional scales are NOT confirmed.
 * - Seguridad Social 2026: seg-social.es, Régimen General bases and rates for 2026.
 * - Wealth tax (Impuesto sobre el Patrimonio) and the solidarity tax on large fortunes (ITSGF):
 *   AEAT Manual práctico de Patrimonio 2025 and Ley 38/2022 art. 3 (BOE). 2026 regional wealth-tax
 *   rules are NOT confirmed (the 2025 rules are used).
 * Regional scales are a data-table hook: add a row to ES_REGIONAL_SCALES to support a region.
 */

export interface EsRegion {
  code: string;
  name: string;
  general: [number, number][];
  /** Optional regional wealth-tax scale (state scale otherwise). */
  wealthScale?: [number, number][];
  /** Optional regional wealth-tax mínimo exento (state 700,000 otherwise). */
  wealthExempt?: number;
  /**
   * Regional 100% wealth-tax bonificación that, while the ITSGF is in force, is limited to the part of
   * the wealth tax above the ITSGF (Madrid, Andalucía): the taxpayer pays the ITSGF amount as wealth tax.
   */
  wealthBonusDownToSolidarity?: boolean;
  source: string;
  wealthSource?: string;
}

export interface EsYear {
  startYear: number;
  label: string;
  stateGeneral: [number, number][];
  /** Savings scale: state (art. 66) and regional (art. 76) parts have the same rates. */
  savingsHalf: [number, number][];
  minimums: {
    personal: number;
    over65: number;
    over75: number;
    descendants: number[];
    under3: number;
  };
  work: {
    otherExpenses: number;
    /** Art. 20 reduction: [upTo, base, slope, from] rows; none above `limit`. */
    reduction: { upTo: number; base: number; slope: number; from: number }[];
    limit: number;
    otherIncomeLimit: number;
  };
  social: { employeeRate: number; maxBase: number };
  pensionPlan: { personalLimit: number; employerExtra: number; incomeShare: number };
  wealth: { exempt: number; stateScale: [number, number][] };
  /** Impuesto temporal de solidaridad de las grandes fortunas (Ley 38/2022 art. 3). */
  solidarity: { exempt: number; scale: [number, number][] };
  sources: { url: string; note?: string }[];
}

const STATE: [number, number][] = [
  [0, 0.095],
  [12_450, 0.12],
  [20_200, 0.15],
  [35_200, 0.185],
  [60_000, 0.225],
  [300_000, 0.245],
];

const AEAT =
  "https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-practicos/irpf-2025";
const PATRIMONIO =
  "https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-practicos/patrimonio-2025";
const LIRPF = "https://www.boe.es/buscar/act.php?id=BOE-A-2006-20764";

export const ES_REGIONAL_SCALES: Record<string, EsRegion> = {
  // Default: an autonomous-community scale equal to the state scale (the general 50/50 split). This is
  // an assumption for regions without a row here, not any region's real scale.
  // Every scale below is the 2025 table (AEAT Manual práctico de Renta 2025, checked 2026-11-19).
  DEFAULT: {
    code: "DEFAULT",
    name: "Default (mirror of the state scale)",
    general: STATE,
    source: `${AEAT}/c15-calculo-impuesto-determinacion-cuotas-integras/gravamen-base-liquidable-general/gravamen-estatal.html`,
  },
  MD: {
    code: "MD",
    name: "Comunidad de Madrid",
    general: [
      [0, 0.085],
      [13_362.22, 0.107],
      [19_004.63, 0.128],
      [35_425.68, 0.174],
      [57_320.4, 0.205],
    ],
    // Wealth tax: state scale and 700,000 exempt; the 100% bonificación (art. 20 TR Madrid) is
    // limited to the wealth tax above the ITSGF while the ITSGF is in force (disp. trans. 7.ª).
    wealthBonusDownToSolidarity: true,
    source: `${AEAT}/c15-calculo-impuesto-determinacion-cuotas-integras/gravamen-base-liquidable-general/gravamen-autonomico/comunidad-madrid.html`,
    wealthSource: `${PATRIMONIO}/c-5-determinacion-cuota-ingresar/deducciones-bonificaciones-autonomicas/bonificaciones-autonomicas/madrid.html`,
  },
  CT: {
    code: "CT",
    name: "Cataluña",
    general: [
      [0, 0.095],
      [12_500, 0.125],
      [22_000, 0.16],
      [33_000, 0.19],
      [53_000, 0.215],
      [90_000, 0.235],
      [120_000, 0.245],
      [175_000, 0.255],
    ],
    // Wealth tax: own scale (disp. trans. 1.ª DL 1/2024, while the ITSGF is in force) and 500,000
    // mínimo exento.
    wealthScale: [
      [0, 0.0021],
      [167_129.45, 0.00315],
      [334_252.88, 0.00525],
      [668_499.75, 0.00945],
      [1_336_999.75, 0.01365],
      [2_673_999.01, 0.01785],
      [5_347_998.03, 0.02205],
      [10_695_996.06, 0.0275],
      [20_000_000, 0.0348],
    ],
    wealthExempt: 500_000,
    wealthSource: `${PATRIMONIO}/c-4-determinacion-base-liquidable-integra/determinacion-cuota-integra/regla-general/escalas-autonomicas/comunidad-autonoma-cataluna.html`,
    source: `${AEAT}/c15-calculo-impuesto-determinacion-cuotas-integras/gravamen-base-liquidable-general/gravamen-autonomico/comunidad-autonoma-cataluna.html`,
  },
  AN: {
    code: "AN",
    name: "Andalucía",
    general: [
      [0, 0.095],
      [13_000, 0.12],
      [21_100, 0.15],
      [35_200, 0.185],
      [60_000, 0.225],
    ],
    // Wealth tax: the state rates (disp. trans. 5.ª Ley 5/2021) and 700,000 exempt; the 100%
    // bonificación (art. 25 bis) is limited to the wealth tax above the ITSGF while it is in force.
    wealthBonusDownToSolidarity: true,
    source: `${AEAT}/c15-calculo-impuesto-determinacion-cuotas-integras/gravamen-base-liquidable-general/gravamen-autonomico/comunidad-autonoma-andalucia.html`,
    wealthSource: `${PATRIMONIO}/c-5-determinacion-cuota-ingresar/deducciones-bonificaciones-autonomicas/bonificaciones-autonomicas/andalucia.html`,
  },
  VC: {
    code: "VC",
    name: "Comunitat Valenciana",
    general: [
      [0, 0.09],
      [12_000, 0.12],
      [22_000, 0.15],
      [32_000, 0.175],
      [42_000, 0.2],
      [52_000, 0.225],
      [62_000, 0.25],
      [72_000, 0.265],
      [100_000, 0.275],
      [150_000, 0.285],
      [200_000, 0.295],
    ],
    wealthScale: [
      [0, 0.0025],
      [167_129.45, 0.0037],
      [334_252.88, 0.0062],
      [668_499.75, 0.0112],
      [1_336_999.51, 0.0162],
      [2_673_999.01, 0.0212],
      [5_347_998.03, 0.0262],
      [10_695_996.06, 0.035],
    ],
    // Wealth tax: own scale (art. 9 Ley 13/1997) and a 1,000,000 mínimo exento.
    wealthExempt: 1_000_000,
    source: `${AEAT}/c15-calculo-impuesto-determinacion-cuotas-integras/gravamen-base-liquidable-general/gravamen-autonomico/comunitat-valenciana.html`,
    wealthSource: `${PATRIMONIO}/c-4-determinacion-base-liquidable-integra/determinacion-cuota-integra/regla-general/escalas-autonomicas/comunitat-valenciana.html`,
  },
};

/** Region code aliases (ISO 3166-2:ES suffixes and common names). */
export const ES_REGION_ALIASES: Record<string, string> = {
  M: "MD",
  MADRID: "MD",
  "ES-MD": "MD",
  CATALUNA: "CT",
  CATALUNYA: "CT",
  CATALONIA: "CT",
  B: "CT",
  "ES-CT": "CT",
  ANDALUCIA: "AN",
  ANDALUSIA: "AN",
  "ES-AN": "AN",
  VALENCIA: "VC",
  "COMUNITAT VALENCIANA": "VC",
  "ES-VC": "VC",
};

const Y2025: EsYear = {
  startYear: 2025,
  label: "2025-2026 (IRPF state scales; 2025 regional scales) / 2026 (Seguridad Social)",
  stateGeneral: STATE,
  savingsHalf: [
    [0, 0.095],
    [6_000, 0.105],
    [50_000, 0.115],
    [200_000, 0.135],
    [300_000, 0.15],
  ],
  // Art. 57-58 LIRPF; the age increases apply from 65 and 75 ("edad igual o superior", AEAT manual).
  minimums: {
    personal: 5_550,
    over65: 1_150,
    over75: 1_400,
    descendants: [2_400, 2_700, 4_000, 4_500],
    under3: 2_800,
  },
  // Art. 19.2 f) (2,000 other expenses) and art. 20 (reduction, measured on net work income before
  // the 2,000: "minorar el rendimiento íntegro en los gastos ... a), b), c), d) y e) del art. 19.2").
  work: {
    otherExpenses: 2_000,
    reduction: [
      { upTo: 14_852, base: 7_302, slope: 0, from: 0 },
      { upTo: 17_673.52, base: 7_302, slope: 1.75, from: 14_852 },
      { upTo: 19_747.5, base: 2_364.34, slope: 1.14, from: 17_673.52 },
    ],
    limit: 19_747.5,
    otherIncomeLimit: 6_500,
  },
  // 2026: contingencias comunes 4.70%, desempleo (indefinido) 1.55%, formación profesional 0.10%,
  // MEI 0.15% (employee share of 0.90%); base máxima 5,101.20 a month (12 x, extra pays prorated).
  social: { employeeRate: 0.047 + 0.0155 + 0.001 + 0.0015, maxBase: 5_101.2 * 12 },
  pensionPlan: { personalLimit: 1_500, employerExtra: 8_500, incomeShare: 0.3 },
  wealth: {
    exempt: 700_000,
    stateScale: [
      [0, 0.002],
      [167_129.45, 0.003],
      [334_252.88, 0.005],
      [668_499.75, 0.009],
      [1_336_999.51, 0.013],
      [2_673_999.01, 0.017],
      [5_347_998.03, 0.021],
      [10_695_996.06, 0.035],
    ],
  },
  // Ley 38/2022 art. 3: 700,000 exempt; 0% to 3,000,000 of base, then 1.7%, 2.1%, 3.5%. Extended
  // indefinitely by Real Decreto-ley 8/2023 (AEAT Manual práctico de Patrimonio 2025).
  solidarity: {
    exempt: 700_000,
    scale: [
      [0, 0],
      [3_000_000, 0.017],
      [5_347_998.03, 0.021],
      [10_695_996.06, 0.035],
    ],
  },
  sources: [
    {
      url: `${LIRPF}#a63`,
      note: "LIRPF art. 63 (BOE consolidated text, 18/11/2026): state general scale, 2025 and 2026. Checked 2026-11-19",
    },
    {
      url: `${LIRPF}#a66`,
      note: "LIRPF arts. 66 and 76: savings scale halves 9.5% / 10.5% / 11.5% / 13.5% / 15% (19% to 30% combined) at 6,000 / 50,000 / 200,000 / 300,000, 2025 and 2026. Checked 2026-11-19",
    },
    {
      url: `${AEAT}/c15-calculo-impuesto-determinacion-cuotas-integras/gravamen-base-liquidable-general/gravamen-estatal.html`,
      note: "AEAT: state general scale 2025",
    },
    ...Object.values(ES_REGIONAL_SCALES)
      .filter((r) => r.code !== "DEFAULT")
      .map((r) => ({
        url: r.source,
        note: `${r.name} general scale 2025 (used for 2026; 2026 scale not confirmed)`,
      })),
    {
      url: `${AEAT}/c14-adecuacion-impuesto-circunstancias-personales/minimo-contribuyente.html`,
      note: "Mínimo personal (art. 57): 5,550; +1,150 from 65; +1,400 more from 75 (state amounts). Checked 2026-11-19",
    },
    {
      url: `${AEAT}/c03-rendimientos-trabajo/rendimiento-neto-trabajo-integrar-base-imponible/fase-3-determinacion-rendimiento-neto-reducido.html`,
      note: "Work-income reduction (art. 20) on net work income before the 2,000 other expenses. Checked 2026-11-19",
    },
    {
      url: `${LIRPF}#a52`,
      note: "LIRPF art. 52: pension-plan reduction limited to the lower of 30% of net work and activity income and 1,500 (+8,500 from employer contributions). Checked 2026-11-19",
    },
    {
      url: "https://www.seg-social.es/wps/portal/wss/internet/Trabajadores/CotizacionRecaudacionTrabajadores/36537",
      note: "Régimen General 2026: employee 4.70 + 1.55 + 0.10 + MEI 0.15; base máxima 5,101.20/month. Checked 2026-11-19",
    },
    {
      url: `${PATRIMONIO}/c-4-determinacion-base-liquidable-integra/determinacion-cuota-integra/regla-general/escala-estatal.html`,
      note: "Wealth tax state scale 2025. Checked 2026-11-19",
    },
    {
      url: `${PATRIMONIO}/c-4-determinacion-base-liquidable-integra/determinacion-base-liquidable-patrimonio-no-gravamen/sujetos-pasivos-residentes-ccaa.html`,
      note: "Wealth tax mínimo exento: 700,000 (state, Madrid, Andalucía); Cataluña 500,000; Comunitat Valenciana 1,000,000. Checked 2026-11-19",
    },
    ...Object.values(ES_REGIONAL_SCALES)
      .filter((r) => r.wealthSource)
      .map((r) => ({
        url: r.wealthSource!,
        note: `${r.name} wealth tax 2025 (scale or bonificación). Checked 2026-11-19`,
      })),
    {
      url: "https://www.boe.es/buscar/act.php?id=BOE-A-2022-22684#a3",
      note: "Ley 38/2022 art. 3: Impuesto temporal de solidaridad de las grandes fortunas, 700,000 exempt, 0% to 3,000,000 then 1.7% / 2.1% / 3.5%; extended by Real Decreto-ley 8/2023. Checked 2026-11-19",
    },
  ],
};

export const ES_YEARS: readonly EsYear[] = [Y2025];

export const ES_SIMPLIFICATIONS: readonly string[] = [
  "IRPF: the state scales, minimums and work-income rules are the law in force for 2025 and 2026 (BOE, checked 2026-11-19); the regional scales are the 2025 tables (AEAT), used for 2026 too because the 2026 regional scales could not be confirmed. Later years carry these forward with the plan's threshold policy, although Spain does not index its scales by law. Social security uses 2026 rates.",
  "Region: only Madrid, Cataluña, Andalucía and Comunitat Valenciana have their own scales. Every other region (and a plan with no region) is assumed to have a regional scale equal to the state scale, which is not any region's real scale. Navarra and the País Vasco (foral regimes) are not modelled.",
  "Individual returns only (the joint-return option and its 3,400 EUR reduction are not modelled). Regional personal and family minimums and all regional deductions are not modelled (state minimums are used for both halves).",
  "Descendant minimums are split evenly between two parents and count dependents under 25 (their own income limit of 8,000 EUR is not checked); ascendant and disability minimums, and the maternity deduction, are not modelled.",
  "Pensions and pension-plan withdrawals are work income (the 2,000 EUR other expenses and the art. 20 reduction apply); the 40% reduction for pre-2007 contributions withdrawn as capital is not modelled.",
  "Pension-plan contributions are limited to 1,500 EUR and 30% of net work and activity income. The extra 8,500 EUR for employer contributions (and employee contributions matched by them) and the extra 4,250 EUR for self-employed plans are not modelled: employer contributions are left out of income and deductions alike.",
  "Rental income: no 50-90% housing reduction and no expenses. Self-employed: no social contributions (RETA) and no expense deductions.",
  "Social security: employee contributions on salary up to the 2026 maximum base. The solidarity contribution above the base, fixed-term contract rates (1.60% unemployment) and the exemption from most contributions for employees past the state pension age are not modelled.",
  "Wealth tax (law toggle es.wealthTax, off by default) taxes period-start net worth per person (split evenly) with the regional scale and mínimo exento (state 700,000 EUR; Cataluña 500,000 and its own scale; Valencia 1,000,000 and its own scale). The solidarity tax on large fortunes (above 3,000,000 EUR of base after the 700,000 exemption) is added where it exceeds the wealth tax; in Madrid and Andalucía the 100% bonificación only removes the wealth tax above it. The main-home exemption (300,000), exempt business assets, other regional bonificaciones and the 60% cap on income plus wealth tax are not modelled.",
  "Main-home sale gains are not excluded (the exemption depends on age 65+ or reinvestment).",
];
