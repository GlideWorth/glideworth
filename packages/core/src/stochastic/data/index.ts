/**
 * Historical annual market datasets for historical / bootstrap chance-of-success runs and
 * deterministic historical sequences. Provenance, licences and construction: ./README.md and
 * DATA-LICENSES.md at the repository root.
 *
 * Every series is a nominal annual rate (decimal fraction) in the dataset's currency:
 * - `stocks`         equity PRICE return (excluding dividends), matching `MarketPeriod.stocks`
 * - `dividendYield`  dividends paid in the year / price at the start of the year
 * - `bonds`          government bond total return minus `bondYield` (the price component)
 * - `bondYield`      bond income (coupon) for the year; `bonds + bondYield` = bond total return
 * - `cash`           short-term rate; `null` where the source has no data (falls back to the plan)
 * - `inflation`      consumer price inflation
 *
 * Bundled datasets (`MARKET_DATASETS`) are openly licensed and ship everywhere, including the hosted
 * service and the browser bundle. One optional dataset, `us-1871-local` (Robert Shiller's US data
 * from 1871), is NOT bundled because it carries no explicit licence: a self-hoster can download it for
 * personal use with `scripts/fetch_shiller_local.py`, and the engine loads it from the directory in
 * the `GLIDEWORTH_LOCAL_DATA_DIR` environment variable (Node only) or from `registerLocalDataset`.
 */
import type { HistoricalDataset, SimWarning } from "../../engine/types.js";
import type { MonteCarloSettings, RetiredDatasetId } from "../../schema/montecarlo.js";
import { ScenarioError, ValidationError } from "../../errors.js";
import { UK_1983_RAW } from "./uk-open.generated.js";
import { US_1928_RAW } from "./us.generated.js";

/** Datasets bundled with every build. */
export type MarketDatasetId = "us-1928" | "uk-1983";
/** Optional datasets a self-hoster can install locally (never bundled, never in the hosted service). */
export type LocalDatasetId = "us-1871-local";
/** Every dataset id a plan may name (`MonteCarloSettings.dataset`). */
export type DatasetId = MarketDatasetId | LocalDatasetId;

export interface MarketSeriesSet {
  stocks: readonly number[];
  dividendYield: readonly number[];
  bonds: readonly number[];
  bondYield: readonly number[];
  cash: readonly (number | null)[];
  inflation: readonly number[];
}

export interface MarketDataset {
  id: DatasetId;
  label: string;
  region: "US" | "GB";
  currency: "USD" | "GBP";
  firstYear: number;
  lastYear: number;
  /** How a data "year" is measured. */
  yearBasis: "calendar" | "january-to-january";
  series: MarketSeriesSet;
  /** Short provenance line; full detail in data/README.md. */
  source: string;
  licence: string;
  /**
   * Attribution statements that must be displayed wherever results from this dataset are shown
   * (the texts in `DATASET_ATTRIBUTIONS`, joined). Required by the Open Government Licence for the
   * UK series and requested by the other publishers.
   */
  attribution: string;
  /** What the user should know before relying on it (coverage, substitutions). */
  limits: string;
}

/** One attribution statement (DATA-LICENSES.md "Required attribution statements"). */
export interface DatasetAttribution {
  id: "ogl-uk" | "federal-reserve-h10" | "bls-cpi" | "damodaran" | "shiller";
  /** Publisher(s), for a heading or link text. */
  provider: string;
  /** The statement to display, verbatim. */
  text: string;
  /** Licence or source page to link to. */
  url: string;
  /** Datasets this statement applies to. */
  datasets: readonly DatasetId[];
}

/**
 * Attribution statements for the market datasets, to render on an "About the data" page and next to
 * the dataset choice. The OGL statement is a condition of the Open Government Licence v3.0.
 */
export const DATASET_ATTRIBUTIONS: readonly DatasetAttribution[] = [
  {
    id: "ogl-uk",
    provider: "Office for National Statistics; Bank of England",
    text:
      "Contains public sector information licensed under the Open Government Licence v3.0. " +
      "Sources: Office for National Statistics (CPI, RPI); Bank of England (Bank Rate, gilt yields).",
    url: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    datasets: ["uk-1983"],
  },
  {
    id: "federal-reserve-h10",
    provider: "Board of Governors of the Federal Reserve System",
    text: "Exchange rates: Board of Governors of the Federal Reserve System, H.10 Foreign Exchange Rates.",
    url: "https://www.federalreserve.gov/releases/h10/",
    datasets: ["uk-1983"],
  },
  {
    id: "bls-cpi",
    provider: "U.S. Bureau of Labor Statistics",
    text: "US inflation: U.S. Bureau of Labor Statistics, Consumer Price Index for All Urban Consumers (CPI-U), series CUUR0000SA0.",
    url: "https://www.bls.gov/cpi/",
    datasets: ["us-1928"],
  },
  {
    id: "damodaran",
    provider: "Aswath Damodaran, NYU Stern",
    text: "US stock, bond and bill returns: Aswath Damodaran, Historical Returns on Stocks, Bonds and Bills, NYU Stern (pages.stern.nyu.edu/~adamodar).",
    url: "https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histret.html",
    datasets: ["us-1928", "uk-1983", "us-1871-local"],
  },
  {
    id: "shiller",
    provider: "Robert J. Shiller",
    text: "US 1871 data: Robert J. Shiller, ie_data.xls, shillerdata.com (downloaded by this installation for personal use; not distributed with Glideworth).",
    url: "https://shillerdata.com/",
    datasets: ["us-1871-local"],
  },
];

function attributionFor(id: DatasetId): string {
  return DATASET_ATTRIBUTIONS.filter((a) => a.datasets.includes(id))
    .map((a) => a.text)
    .join(" ");
}

const years = (raw: { firstYear: number; lastYear: number }) =>
  `${raw.firstYear}-${raw.lastYear} (${raw.lastYear - raw.firstYear + 1} years)`;

/** A dataset bundled with every build (its id is a `MarketDatasetId`). */
export interface BundledMarketDataset extends MarketDataset {
  id: MarketDatasetId;
}

export const MARKET_DATASETS: Readonly<Record<MarketDatasetId, BundledMarketDataset>> = {
  "us-1928": {
    id: "us-1928",
    label: `US ${years(US_1928_RAW)}: S&P 500, 10-year Treasuries, T-bills, CPI-U`,
    region: "US",
    currency: "USD",
    yearBasis: "calendar",
    ...US_1928_RAW,
    source:
      'Damodaran, "Historical Returns on Stocks, Bonds and Bills" (histretSP.xls, NYU Stern, 2026 update); ' +
      "inflation: BLS CPI-U NSA (series CUUR0000SA0), December to December.",
    licence:
      "Damodaran: free use, attribution appreciated. BLS CPI: US government work (public domain).",
    attribution: attributionFor("us-1928"),
    limits:
      "US market history in dollars. It starts after the 1920s boom, so it holds the Great Depression " +
      "but nothing earlier.",
  },
  "uk-1983": {
    id: "uk-1983",
    label: `UK ${years(UK_1983_RAW)}: UK inflation, gilts and Bank Rate; US shares in sterling`,
    region: "GB",
    currency: "GBP",
    yearBasis: "calendar",
    ...UK_1983_RAW,
    source:
      "ONS CPI (D7BT) from 1989 and RPI (CDKO) before, December to December; Bank of England Bank Rate " +
      "(IUAABEDR) and 10-year gilt yield (IUDMNZC); equities: S&P 500 (Damodaran, histretSP.xls) in sterling " +
      "at Federal Reserve H.10 year-end rates. There is no openly licensed UK share history.",
    licence:
      "Contains public sector information licensed under the Open Government Licence v3.0 (ONS, Bank of " +
      "England). Exchange rates: Federal Reserve Board (public domain). Equities: Damodaran, free use.",
    attribution: attributionFor("uk-1983"),
    limits:
      `Only ${UK_1983_RAW.lastYear - UK_1983_RAW.firstYear + 1} years, all after 1982: no 1970s ` +
      "inflation, no world wars, and the shares are US shares converted to sterling (they beat UK shares " +
      "over this period). Historical runs on it are more optimistic than long UK history, and a plan " +
      "longer than the data cannot be run year by year without repeating years.",
  },
};

// ------------------------------------------------------------------- optional local datasets

const LOCAL_FILES: Record<LocalDatasetId, string> = { "us-1871-local": "us-1871.json" };

const LOCAL_META: Record<
  LocalDatasetId,
  Omit<MarketDataset, "firstYear" | "lastYear" | "series" | "attribution">
> = {
  "us-1871-local": {
    id: "us-1871-local",
    label: "US 1871 onwards (Shiller; downloaded locally, personal use)",
    region: "US",
    currency: "USD",
    yearBasis: "january-to-january",
    source:
      "Robert J. Shiller, ie_data.xls (shillerdata.com), downloaded by this installation with " +
      "scripts/fetch_shiller_local.py; cash from 1928: Damodaran 3-month T-bill (null before 1928).",
    licence:
      "No explicit licence: downloaded by the person running this installation for personal use. " +
      "Not distributed with Glideworth and not available in the hosted service.",
    limits: "No bill series before 1928, so cash uses the plan assumption in those years.",
  },
};

const localDatasets = new Map<LocalDatasetId, MarketDataset>();
const localLoadAttempted = new Set<LocalDatasetId>();

export function isLocalDatasetId(id: string): id is LocalDatasetId {
  return Object.hasOwn(LOCAL_FILES, id);
}

const SERIES_KEYS = [
  "stocks",
  "dividendYield",
  "bonds",
  "bondYield",
  "cash",
  "inflation",
] as const satisfies readonly (keyof MarketSeriesSet)[];

/**
 * Register a locally downloaded dataset (the JSON written by `scripts/fetch_shiller_local.py`:
 * `{ firstYear, lastYear, series: { stocks, dividendYield, bonds, bondYield, cash, inflation } }`).
 * Validates the shape and returns the registered dataset.
 */
export function registerLocalDataset(id: LocalDatasetId, raw: unknown): MarketDataset {
  const r = raw as { firstYear?: unknown; lastYear?: unknown; series?: Record<string, unknown> };
  const first = r?.firstYear;
  const last = r?.lastYear;
  if (!Number.isInteger(first) || !Number.isInteger(last) || (last as number) < (first as number))
    throw new ValidationError(`local dataset ${id}: firstYear/lastYear missing or invalid`);
  const n = (last as number) - (first as number) + 1;
  const series = {} as Record<(typeof SERIES_KEYS)[number], (number | null)[]>;
  for (const k of SERIES_KEYS) {
    const v = r.series?.[k];
    const ok =
      Array.isArray(v) &&
      v.length === n &&
      v.every((x) => (x === null && k === "cash") || (typeof x === "number" && Number.isFinite(x)));
    if (!ok)
      throw new ValidationError(`local dataset ${id}: series '${k}' must have ${n} finite values`);
    series[k] = v as (number | null)[];
  }
  const ds: MarketDataset = {
    ...LOCAL_META[id],
    firstYear: first as number,
    lastYear: last as number,
    series: series as unknown as MarketSeriesSet,
    attribution: attributionFor(id),
  };
  localDatasets.set(id, ds);
  localLoadAttempted.add(id);
  return ds;
}

/** Forget registered local datasets (tests). */
export function clearLocalDatasets(): void {
  localDatasets.clear();
  localLoadAttempted.clear();
}

/**
 * Node only: read `<GLIDEWORTH_LOCAL_DATA_DIR>/<file>` once, if the variable is set and the file exists.
 * Browsers and Web Workers have no `process`, so this is a no-op there.
 */
function loadLocalFromEnv(id: LocalDatasetId): void {
  if (localLoadAttempted.has(id)) return;
  localLoadAttempted.add(id);
  const proc = (
    globalThis as {
      process?: {
        env?: Record<string, string | undefined>;
        getBuiltinModule?: (name: string) => unknown;
      };
    }
  ).process;
  const dir = proc?.env?.GLIDEWORTH_LOCAL_DATA_DIR;
  if (!dir || !proc?.getBuiltinModule) return;
  const fs = proc.getBuiltinModule("node:fs") as {
    existsSync(p: string): boolean;
    readFileSync(p: string, enc: "utf8"): string;
  };
  const path = `${dir.replace(/[/\\]+$/, "")}/${LOCAL_FILES[id]}`;
  if (!fs.existsSync(path)) return;
  registerLocalDataset(id, JSON.parse(fs.readFileSync(path, "utf8")));
}

/** A local dataset if it is installed (registered, or found in GLIDEWORTH_LOCAL_DATA_DIR), else null. */
export function getLocalDataset(id: LocalDatasetId): MarketDataset | null {
  loadLocalFromEnv(id);
  return localDatasets.get(id) ?? null;
}

export function getMarketDataset(id: DatasetId): MarketDataset {
  if (isLocalDatasetId(id)) {
    const local = getLocalDataset(id);
    if (local) return local;
    throw new ScenarioError(
      `historical dataset '${id}' is not installed. It is an optional download for self-hosted ` +
        "installations (packages/core/src/stochastic/data/scripts/fetch_shiller_local.py, then set " +
        "GLIDEWORTH_LOCAL_DATA_DIR); choose 'us-1928' or 'uk-1983' instead.",
      { id },
    );
  }
  const ds = MARKET_DATASETS[id as MarketDatasetId];
  if (!ds) throw new ScenarioError(`unknown historical dataset '${id}'`, { id });
  return ds;
}

export function datasetLength(ds: MarketDataset): number {
  return ds.lastYear - ds.firstYear + 1;
}

/** Engine series id -> dataset field. Deterministic US series come from the bundled `us-1928`. */
const ENGINE_SERIES: Record<string, keyof MarketSeriesSet> = {
  "us-stocks": "stocks",
  "us-bonds": "bonds",
  "us-cash": "cash",
  "us-inflation": "inflation",
  "us-dividends": "dividendYield",
};

/** The dataset behind deterministic `RateSpec.historical` sequences. */
export const HISTORICAL_SERIES_DATASET: MarketDatasetId = "us-1928";

/**
 * The engine's `HistoricalDataset` contract (deterministic `RateSpec.historical` sequences):
 * pass it as `simulate(input, { historical: HISTORICAL_SERIES })`. The stochastic runners inject it
 * automatically. `us-bonds` is the bond PRICE component (total return minus coupon), matching
 * `MarketPeriod.bonds`; every series covers 1928-2025 (`us-1928`); `crypto` has no history.
 * A sequence that asks for years before 1928 starts in 1928 instead, with a warning (engine/growth.ts).
 */
export const HISTORICAL_SERIES: HistoricalDataset = {
  range(series) {
    const key = ENGINE_SERIES[series];
    if (!key) return null;
    const ds = MARKET_DATASETS[HISTORICAL_SERIES_DATASET];
    const data = ds.series[key];
    let first = 0;
    while (first < data.length && (data[first] === null || data[first] === undefined)) first++;
    let last = data.length - 1;
    while (last >= first && (data[last] === null || data[last] === undefined)) last--;
    return first > last ? null : { first: ds.firstYear + first, last: ds.firstYear + last };
  },
  value(series, year) {
    const key = ENGINE_SERIES[series];
    if (!key) return undefined;
    const ds = MARKET_DATASETS[HISTORICAL_SERIES_DATASET];
    return ds.series[key][year - ds.firstYear] ?? undefined;
  },
};

// ------------------------------------------------------------------- retired datasets

const REPLACED_MESSAGES: Record<RetiredDatasetId, string> = {
  "uk-1871":
    "The UK market history this plan used (1871-2020, Jordà-Schularick-Taylor) has been withdrawn " +
    "because its licence does not allow commercial use. Chance-of-success runs now use UK history for " +
    "1983-2025: UK inflation, gilts and Bank Rate, with US shares converted to sterling (no openly " +
    "licensed UK share history exists). It is shorter and has no 1970s or wartime years, so results " +
    "will differ from before and are likely to look more favourable.",
  "us-1871":
    "The US market history this plan used (1871-2025, Robert Shiller's data) is no longer included " +
    "because it has no explicit licence. Chance-of-success runs now use US history for 1928-2025 " +
    "(S&P 500, 10-year Treasuries, T-bills, CPI-U). It has no years before 1928, so results will " +
    "differ from before.",
};

/** Remove the DATASET_REPLACED marker (the user has seen the notice). Returns new settings. */
export function acknowledgeReplacedDataset<T extends { replacedDataset?: unknown }>(
  settings: T,
): Omit<T, "replacedDataset"> {
  const { replacedDataset: _seen, ...rest } = settings;
  return rest;
}

/**
 * The DATASET_REPLACED notice for settings read with a retired dataset id (`replacedDataset`, set
 * by `withReplacedDataset`), or none. Reported by `simulate` (plan settings) and by the stochastic
 * runners (`MonteCarloResult.warnings`, run settings).
 */
export function datasetReplacedWarnings(
  settings: Pick<MonteCarloSettings, "dataset" | "replacedDataset"> | undefined,
): SimWarning[] {
  const from = settings?.replacedDataset;
  if (!from) return [];
  return [
    {
      code: "DATASET_REPLACED",
      // 'warning', not 'info': the web app hides 'info' warnings on the dashboard and in reports.
      severity: "warning",
      message: REPLACED_MESSAGES[from],
      periodIndex: null,
      refs: [from, settings.dataset],
    },
  ];
}
