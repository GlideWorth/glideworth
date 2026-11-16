/**
 * Spain (residents in territorio común; not Navarra / País Vasco). Calendar tax year. Nominal EUR.
 * Calculation: ../jurisdictions/es.ts.
 *
 * IRPF scales and minimums: ejercicio 2025, the latest year published by the AEAT (Manual práctico
 * de Renta 2025); 2026 regional scales are not yet consolidated by the AEAT. Social security: 2026.
 * Regional scales are a data-table hook: add a row to ES_REGIONAL_SCALES to support a region.
 */

export interface EsRegion {
  code: string;
  name: string;
  general: [number, number][];
  /** Optional regional wealth-tax scale (state scale otherwise) and bonificación (0-1). */
  wealthScale?: [number, number][];
  wealthBonus?: number;
  source: string;
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

export const ES_REGIONAL_SCALES: Record<string, EsRegion> = {
  // Default: an autonomous-community scale equal to the state scale (the general 50/50 split).
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
    wealthBonus: 1,
    source: `${AEAT}/c15-calculo-impuesto-determinacion-cuotas-integras/gravamen-base-liquidable-general/gravamen-autonomico/comunidad-madrid.html`,
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
    wealthBonus: 1,
    source: `${AEAT}/c15-calculo-impuesto-determinacion-cuotas-integras/gravamen-base-liquidable-general/gravamen-autonomico/comunidad-autonoma-andalucia.html`,
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
    source: `${AEAT}/c15-calculo-impuesto-determinacion-cuotas-integras/gravamen-base-liquidable-general/gravamen-autonomico/comunitat-valenciana.html`,
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
  label: "2025 (IRPF) / 2026 (Seguridad Social)",
  stateGeneral: STATE,
  savingsHalf: [
    [0, 0.095],
    [6_000, 0.105],
    [50_000, 0.115],
    [200_000, 0.135],
    [300_000, 0.15],
  ],
  minimums: {
    personal: 5_550,
    over65: 1_150,
    over75: 1_400,
    descendants: [2_400, 2_700, 4_000, 4_500],
    under3: 2_800,
  },
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
  sources: [
    {
      url: `${AEAT}/c15-calculo-impuesto-determinacion-cuotas-integras/gravamen-base-liquidable-general/gravamen-estatal.html`,
      note: "State general scale 2025",
    },
    {
      url: `${AEAT}/c15-calculo-impuesto-determinacion-cuotas-integras/gravamen-base-liquidable-ahorro/gravamen-estatal.html`,
      note: "State savings scale 2025 (regional savings scale has the same rates, art. 76)",
    },
    ...Object.values(ES_REGIONAL_SCALES)
      .filter((r) => r.code !== "DEFAULT")
      .map((r) => ({ url: r.source, note: `${r.name} general scale 2025` })),
    {
      url: `${AEAT}/c14-adecuacion-impuesto-circunstancias-personales/minimo-contribuyente.html`,
      note: "Mínimo personal y familiar (state amounts)",
    },
    {
      url: `${AEAT}/c03-rendimientos-trabajo/rendimiento-neto-trabajo-integrar-base-imponible/fase-3-determinacion-rendimiento-neto-reducido.html`,
      note: "Work-income reduction (art. 20), 2,000 other expenses",
    },
    {
      url: "https://www.seg-social.es/wps/portal/wss/internet/Trabajadores/CotizacionRecaudacionTrabajadores/36537",
      note: "Régimen General 2026: employee 4.70 + 1.55 + 0.10 + MEI 0.15; base máxima 5,101.20/month",
    },
    {
      url: "https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-practicos/patrimonio-2025/c-4-determinacion-base-liquidable-integra/determinacion-cuota-integra/regla-general/escala-estatal.html",
      note: "Wealth tax state scale 2025; Valencia scale; mínimo exento 700,000",
    },
    {
      url: "https://sede.agenciatributaria.gob.es/static_files/Sede/Biblioteca/Manual/Practicos/Patrimonio/Patrimonio-2025/ManualPatrimonio2025_es_es.pdf",
      note: "Wealth tax: Madrid and Andalucía 100% bonificación",
    },
  ],
};

export const ES_YEARS: readonly EsYear[] = [Y2025];

export const ES_SIMPLIFICATIONS: readonly string[] = [
  "IRPF uses the 2025 state and regional scales (latest AEAT manual), carried forward with the threshold policy; social security uses 2026 rates. Only Madrid, Cataluña, Andalucía and Comunitat Valenciana have their own scales; other regions use a scale equal to the state scale.",
  "Individual returns only (the joint-return option and its 3,400 EUR reduction are not modelled). Regional personal and family minimums and all regional deductions are not modelled (state minimums are used for both halves).",
  "Descendant minimums are split evenly between two parents and count dependents under 25; ascendant and disability minimums are not modelled.",
  "Pensions and pension-plan withdrawals are work income (reduction and 2,000 EUR expenses apply); the 40% reduction for pre-2007 contributions withdrawn as capital is not modelled.",
  "Rental income: no 50-90% housing reduction and no expenses. Self-employed: no social contributions (RETA) and no expense deductions.",
  "Social security: employee contributions on salary up to the 2026 maximum base; the solidarity contribution above it and fixed-term contract rates are not modelled.",
  "Wealth tax (law toggle es.wealthTax, off by default) taxes period-start net worth above 700,000 EUR per person with the state scale (Valencia own scale; Madrid and Andalucía 100% bonificación). The main-home exemption, regional exempt minimums, the IRPF + wealth tax 60% cap and the temporary solidarity tax on large fortunes are not modelled.",
  "Main-home sale gains are not excluded (the exemption depends on age 65+ or reinvestment).",
];
