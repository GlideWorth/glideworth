/**
 * Country defaults: the ONE place that decides what a new household, plan, sample, template or
 * import gets from its country (tax jurisdiction stack and region, historical market dataset, tax
 * year convention, typical account types, state-pension settings, base currency and locale).
 *
 * Used by `createUkSampleDocument`, `planDefaultsForHousehold` (templates / onboarding in the web and
 * API) and the ProjectionLab importer, so a GB household never silently gets US market history or a
 * flat tax rate. Pure; no clock: callers that need "now" pass it in.
 */
import type { AccountType } from "../schema/accounts.js";
import type { Household, Location } from "../schema/household.js";
import type { CurrentFinancesInput, PlanInput } from "../schema/plan.js";
import type { MonthDate } from "../schema/primitives.js";
import type { DatasetId } from "../stochastic/data/index.js";
import { pickYear } from "../tax/common.js";
import { pegFxRates } from "../tax/crossborder/currency.js";
import { deRegelaltersgrenze } from "../tax/data/de.js";
import { nlAowAge } from "../tax/data/nl.js";
import { UK_TAX_YEARS, ukStatePensionAge } from "../tax/data/uk.js";
import { defaultStackIds } from "../tax/registry.js";

export interface CountryDefaults {
  country: string;
  /** Base currency and formatting locale for a new household. */
  currency: string;
  locale: string;
  /** Region used when the household has none and the tax stack needs one (null: not needed / unknown). */
  defaultRegion: string | null;
  tax: {
    /** 'estimate' when Glideworth has a tax preset for the country (and region, where required), else 'flat'. */
    mode: "estimate" | "flat";
    /** The jurisdiction stack the estimate resolves to ([] in flat mode). */
    jurisdictions: string[];
    /** Flat rates kept on the plan so switching to 'flat' starts from sensible numbers. */
    flat: { ordinary: number; capitalGains: number; dividends: number; local: number };
    /** Why the mode was chosen (shown in onboarding / import notes). */
    note: string;
  };
  /** Tax-year convention: when the tax year starts, and the plan year alignment that matches it. */
  taxYear: {
    startMonth: number;
    startDay: number;
    label: string;
    yearAlignment: { kind: "calendar" } | { kind: "fiscal"; startMonth: number };
  };
  monteCarlo: {
    /** Historical dataset in the household's own currency when one is bundled. */
    dataset: DatasetId;
    /** Shown next to the dataset choice (coverage, licence, why a foreign dataset is used). */
    note: string;
  };
  /** Typical inflation assumption for the country. */
  inflation: number;
  /**
   * Retirement age suggested for a new plan's retirement milestone (an editable starting point, not a
   * statutory age; the statutory ages are `statePension.startAge` and the plug-ins' pension access ages).
   */
  suggestedRetirementAge: number;
  /** Account types to offer first for each role. */
  accountTypes: {
    cash: AccountType;
    taxable: AccountType;
    taxFree: AccountType | null;
    personalPension: AccountType | null;
    workplacePension: AccountType | null;
  };
  /** Government pension defaults (null when Glideworth has no model for the country's scheme). */
  statePension: {
    incomeType: "state-pension" | "social-security" | "ca-cpp";
    /** Age the benefit starts by default (UK: State Pension age from the birth month when given). */
    startAge: number;
    /** Full annual amount in today's money where the rules fix one (UK new State Pension), else null. */
    annualAmount: number | null;
    tripleLock: { earningsPremium: number; floor: number } | null;
    /** Deferral uplift applies when it starts after the statutory age (UK; DE +0.5% a month). */
    deferralUplift: boolean;
    /** Plain-language name of the scheme ('AOW', 'gesetzliche Rente'...), when known. */
    label?: string;
  } | null;
  filingStatus: (people: number) => "single" | "married-joint";
  /** FX-table rows to pre-fill (currency pegs, e.g. AED/USD with zero drift). */
  fxRates?: { from: string; to: string; rate: number; annualDrift: number }[];
  /** Plain-language notes for onboarding (pension scheme coverage, pegs...). */
  notes?: string[];
}

const FLAT_DEFAULT = { ordinary: 0.2, capitalGains: 0.15, dividends: 0.15, local: 0 };

function estimateStack(location: Location): string[] | null {
  try {
    return defaultStackIds(location);
  } catch {
    return null;
  }
}

/** Whether Glideworth has an 'estimate' tax preset for the country (whatever tax plug-ins are registered). */
export function hasTaxPreset(country: string): boolean {
  return (
    country.toUpperCase() !== "XX" && estimateStack({ country: country.toUpperCase() }) !== null
  );
}

/**
 * Why GB plans default to US history rather than `uk-1983` (numbers and reasoning:
 * docs/design/uk-dataset-replacement.md, "Default for UK plans").
 */
const GB_DATASET_NOTE =
  "UK plans use US history 1928-2025 by default, in real terms (returns net of that history's inflation). " +
  "The openly licensed UK history (1983-2025) is short, has no 1970s inflation or wartime years and uses US " +
  "shares in sterling, so it gives a much higher chance of success than long UK history did; US 1928-2025 is " +
  "longer and includes the Depression and the 1970s. Both are still more favourable than long-run UK " +
  "history, where shares returned less, so leave a margin. You can switch to UK 1983-2025 in the " +
  "chance-of-success settings.";

const DATASET_NOTES: Record<DatasetId, string> = {
  "uk-1983":
    "UK history 1983-2025: UK inflation (ONS), Bank Rate and 10-year gilts (Bank of England), with US shares converted to sterling because no openly licensed UK share history exists. Only 43 years, all after 1982 (no 1970s inflation, no wartime years), and US shares beat UK shares over the period, so it is markedly more optimistic than long UK history. A plan longer than 43 years cannot use 'every start year once'.",
  "us-1928": "US history 1928-2025 (S&P 500, 10-year Treasuries, T-bills, CPI-U), in dollars.",
  "us-1871-local":
    "US history from 1871 (Robert Shiller's data), downloaded by this installation for personal use. Not bundled with Glideworth.",
};

/**
 * Defaults for a household in `country` (ISO 3166-1 alpha-2; 'XX' = custom). `region` is the
 * household's region if known; `birthMonth` (primary person) makes the UK State Pension age exact.
 * `year` picks the tax-data year for amounts such as the full new State Pension (default 2026).
 */
export function defaultsForCountry(
  country: string,
  opts: { region?: string | undefined; birthMonth?: MonthDate | undefined; year?: number } = {},
): CountryDefaults {
  const c = country.toUpperCase();
  const year = opts.year ?? 2026;
  switch (c) {
    case "GB": {
      const region = opts.region ?? "ENG";
      const stack = estimateStack({ country: "GB", region }) ?? [];
      const [by, bm] = opts.birthMonth
        ? opts.birthMonth.split("-").map(Number)
        : [undefined, undefined];
      const spa = by !== undefined ? ukStatePensionAge(by, bm) : 67;
      const weekly = pickYear(UK_TAX_YEARS, year).statePension.fullNewWeekly;
      return {
        country: c,
        currency: "GBP",
        locale: "en-GB",
        defaultRegion: "ENG",
        tax: {
          mode: stack.length ? "estimate" : "flat",
          jurisdictions: stack,
          flat: { ordinary: 0.2, capitalGains: 0.18, dividends: 0.0875, local: 0 },
          note: "UK income tax, National Insurance, dividend and capital gains tax, with the personal allowance and Scottish bands from the region.",
        },
        taxYear: {
          startMonth: 4,
          startDay: 6,
          label: "6 April to 5 April",
          yearAlignment: { kind: "fiscal", startMonth: 4 },
        },
        monteCarlo: { dataset: "us-1928", note: GB_DATASET_NOTE },
        inflation: 0.025,
        suggestedRetirementAge: 60,
        accountTypes: {
          cash: "savings",
          taxable: "uk-gia",
          taxFree: "uk-isa",
          personalPension: "uk-sipp",
          workplacePension: "uk-workplace-pension",
        },
        statePension: {
          incomeType: "state-pension",
          startAge: spa,
          annualAmount: Math.round(weekly * 52 * 100) / 100,
          tripleLock: { earningsPremium: 0.01, floor: 0.025 },
          deferralUplift: true,
        },
        filingStatus: () => "single",
      };
    }
    case "US": {
      const stack = opts.region ? estimateStack({ country: "US", region: opts.region }) : null;
      return {
        country: c,
        currency: "USD",
        locale: "en-US",
        defaultRegion: null,
        tax: {
          mode: stack ? "estimate" : "flat",
          jurisdictions: stack ?? [],
          flat: { ordinary: 0.22, capitalGains: 0.15, dividends: 0.15, local: 0 },
          note: stack
            ? "US federal, payroll and state income tax for the household state."
            : "Set the household state to use US federal, payroll and state tax rules; flat rates until then.",
        },
        taxYear: {
          startMonth: 1,
          startDay: 1,
          label: "calendar year",
          yearAlignment: { kind: "calendar" },
        },
        monteCarlo: { dataset: "us-1928", note: DATASET_NOTES["us-1928"] },
        inflation: 0.025,
        suggestedRetirementAge: 62,
        accountTypes: {
          cash: "savings",
          taxable: "taxable",
          taxFree: "roth-ira",
          personalPension: "traditional-ira",
          workplacePension: "401k",
        },
        statePension: {
          incomeType: "social-security",
          startAge: 67,
          annualAmount: null,
          tripleLock: null,
          deferralUplift: false,
        },
        filingStatus: (n) => (n > 1 ? "married-joint" : "single"),
      };
    }
    case "CA": {
      const stack = estimateStack({
        country: "CA",
        ...(opts.region ? { region: opts.region } : {}),
      });
      return {
        country: c,
        currency: "CAD",
        locale: "en-CA",
        defaultRegion: null,
        tax: {
          mode: stack ? "estimate" : "flat",
          jurisdictions: stack ?? [],
          flat: FLAT_DEFAULT,
          note: "Canadian federal tax, plus provincial tax when the province is set.",
        },
        taxYear: {
          startMonth: 1,
          startDay: 1,
          label: "calendar year",
          yearAlignment: { kind: "calendar" },
        },
        monteCarlo: {
          dataset: "us-1928",
          note: `No Canadian history is bundled; US history is the closest available. ${DATASET_NOTES["us-1928"]}`,
        },
        inflation: 0.02,
        suggestedRetirementAge: 62,
        accountTypes: {
          cash: "savings",
          taxable: "ca-non-registered",
          taxFree: "ca-tfsa",
          personalPension: "ca-rrsp",
          workplacePension: "ca-rrsp",
        },
        statePension: {
          incomeType: "ca-cpp",
          startAge: 65,
          annualAmount: null,
          tripleLock: null,
          deferralUplift: false,
        },
        filingStatus: () => "single",
      };
    }
    case "AU": {
      const stack = estimateStack({ country: "AU" });
      return {
        country: c,
        currency: "AUD",
        locale: "en-AU",
        defaultRegion: null,
        tax: {
          mode: stack ? "estimate" : "flat",
          jurisdictions: stack ?? [],
          flat: FLAT_DEFAULT,
          note: "Australian income tax and superannuation rules.",
        },
        taxYear: {
          startMonth: 7,
          startDay: 1,
          label: "1 July to 30 June",
          yearAlignment: { kind: "fiscal", startMonth: 7 },
        },
        monteCarlo: {
          dataset: "us-1928",
          note: `No Australian history is bundled; US history is the closest available. ${DATASET_NOTES["us-1928"]}`,
        },
        inflation: 0.025,
        suggestedRetirementAge: 62,
        accountTypes: {
          cash: "savings",
          taxable: "taxable",
          taxFree: null,
          personalPension: "au-super-accumulation",
          workplacePension: "au-super-accumulation",
        },
        statePension: null,
        filingStatus: () => "single",
      };
    }
    case "DE":
    case "NL":
    case "FR":
    case "ES":
    case "IL":
    case "IE":
    case "NZ":
      return intlDefaults(c, opts);
    case "AE": {
      const stack = estimateStack({ country: "AE" }) ?? [];
      return {
        country: c,
        currency: "AED",
        locale: "en-AE",
        defaultRegion: null,
        tax: {
          mode: stack.length ? "estimate" : "flat",
          jurisdictions: stack,
          flat: { ordinary: 0, capitalGains: 0, dividends: 0, local: 0 },
          note: "The UAE has no personal income, capital gains, dividend, interest, wealth or inheritance tax for individuals. Corporate Tax on business turnover above AED 1m and VAT are out of scope.",
        },
        taxYear: CALENDAR,
        monteCarlo: {
          dataset: "us-1928",
          note: `No UAE history is bundled; the dirham is pegged to the US dollar, so US history is used. ${DATASET_NOTES["us-1928"]}`,
        },
        inflation: 0.02,
        suggestedRetirementAge: 60,
        accountTypes: {
          cash: "savings",
          taxable: "taxable",
          taxFree: null,
          personalPension: "ae-savings-scheme",
          workplacePension: "ae-dews",
        },
        // Expatriates have no UAE state pension; UAE nationals: GPSSA (aeGpssaReplacementRate).
        statePension: null,
        filingStatus: () => "single",
        fxRates: pegFxRates("AED").map((r) => ({ ...r })),
        notes: [
          "No state pension for expatriates. UAE nationals: GPSSA pension (set it up as a defined-benefit pension on the salary with aeGpssaReplacementRate).",
          "End-of-service gratuity: set it on the salary (endOfService); employers in DEWS or the federal savings scheme pay contributions instead.",
          "The dirham is pegged to the US dollar (AED 3.6725 per USD): the AED/USD rate is pre-filled with zero drift. Add a pair to your base currency if it is not AED or USD.",
        ],
      };
    }
    default: {
      // Countries with a preset registered later get 'estimate' automatically; everything else
      // starts on flat rates.
      const stack =
        c === "XX"
          ? null
          : estimateStack({ country: c, ...(opts.region ? { region: opts.region } : {}) });
      return {
        country: c,
        currency: CURRENCY_BY_COUNTRY[c] ?? "EUR",
        locale: LOCALE_BY_COUNTRY[c] ?? "en-GB",
        defaultRegion: null,
        tax: {
          mode: stack ? "estimate" : "flat",
          jurisdictions: stack ?? [],
          flat: FLAT_DEFAULT,
          note: stack
            ? "Country tax preset."
            : "Glideworth has no tax preset for this country yet: flat rates (or your own brackets in custom mode).",
        },
        taxYear: {
          startMonth: 1,
          startDay: 1,
          label: "calendar year",
          yearAlignment: { kind: "calendar" },
        },
        monteCarlo: {
          dataset: "us-1928",
          note: `No history is bundled for this country; US history is used. ${DATASET_NOTES["us-1928"]}`,
        },
        inflation: 0.02,
        suggestedRetirementAge: 62,
        accountTypes: {
          cash: "savings",
          taxable: "taxable",
          taxFree: "generic-tax-free",
          personalPension: "generic-tax-deferred",
          workplacePension: "generic-tax-deferred",
        },
        statePension: null,
        filingStatus: () => "single",
      };
    }
  }
}

interface IntlSpec {
  currency: string;
  locale: string;
  flat: CountryDefaults["tax"]["flat"];
  note: string;
  taxYear: CountryDefaults["taxYear"];
  inflation: number;
  suggestedRetirementAge: number;
  accountTypes: CountryDefaults["accountTypes"];
  statePension: {
    label: string;
    age: (birthYear: number | undefined) => number;
    deferralUplift: boolean;
  };
  /** Couples assessed jointly by default (DE splitting, FR foyer fiscal, IE joint assessment). */
  joint: boolean;
}

const CALENDAR: CountryDefaults["taxYear"] = {
  startMonth: 1,
  startDay: 1,
  label: "calendar year",
  yearAlignment: { kind: "calendar" },
};

/**
 * France: âge légal de départ by cohort under the 2023 reform (62, rising by 3 months a cohort from
 * 1961 to 64 for 1968 onwards). The 2025 suspension of the reform's phase-in is not modelled.
 */
export function frLegalRetirementAge(birthYear: number): number {
  if (birthYear <= 1960) return 62;
  return Math.min(64, 62 + 0.25 * (birthYear - 1960));
}

/**
 * The seven countries with national presets added in workstream (b2). State-pension amounts depend
 * on the person's contribution or residence record, so only the starting age is defaulted.
 */
const INTL: Record<string, IntlSpec> = {
  DE: {
    currency: "EUR",
    locale: "de-DE",
    flat: { ordinary: 0.3, capitalGains: 0.26375, dividends: 0.26375, local: 0 },
    note: "German income tax (§32a tariff, splitting for married couples), Solidaritätszuschlag, social contributions, Abgeltungsteuer and the taxable share of pensions; church tax is a toggle.",
    taxYear: CALENDAR,
    inflation: 0.02,
    suggestedRetirementAge: 63,
    accountTypes: {
      cash: "savings",
      taxable: "taxable",
      taxFree: null,
      personalPension: "de-ruerup",
      workplacePension: "de-bav",
    },
    statePension: {
      label: "gesetzliche Rente",
      age: (by) => (by === undefined ? 67 : deRegelaltersgrenze(by)),
      deferralUplift: true,
    },
    joint: true,
  },
  NL: {
    currency: "EUR",
    locale: "nl-NL",
    flat: { ordinary: 0.37, capitalGains: 0, dividends: 0, local: 0 },
    note: "Dutch box 1 income tax with the heffingskortingen, box 2 and box 3 (deemed return on savings and investments; pensions and the main home are excluded).",
    taxYear: CALENDAR,
    inflation: 0.02,
    suggestedRetirementAge: 63,
    accountTypes: {
      cash: "savings",
      taxable: "taxable",
      taxFree: null,
      personalPension: "nl-pension",
      workplacePension: "nl-pension",
    },
    statePension: { label: "AOW", age: (by) => nlAowAge(by ?? 1990), deferralUplift: false },
    joint: false,
  },
  FR: {
    currency: "EUR",
    locale: "fr-FR",
    flat: { ordinary: 0.3, capitalGains: 0.314, dividends: 0.314, local: 0 },
    note: "French impôt sur le revenu (quotient familial, décote), CSG/CRDS, the PFU on capital income, and PEA / assurance-vie / PER rules.",
    taxYear: CALENDAR,
    inflation: 0.02,
    suggestedRetirementAge: 62,
    accountTypes: {
      cash: "savings",
      taxable: "taxable",
      taxFree: "fr-pea",
      personalPension: "fr-per",
      workplacePension: "fr-per",
    },
    statePension: {
      label: "retraite de base et complémentaire",
      age: (by) => (by === undefined ? 64 : frLegalRetirementAge(by)),
      deferralUplift: false,
    },
    joint: true,
  },
  ES: {
    currency: "EUR",
    locale: "es-ES",
    flat: { ordinary: 0.3, capitalGains: 0.21, dividends: 0.21, local: 0 },
    note: "Spanish IRPF (state and regional scales, savings base), social security and the optional wealth tax; set the region for its own scale.",
    taxYear: CALENDAR,
    inflation: 0.02,
    suggestedRetirementAge: 63,
    accountTypes: {
      cash: "savings",
      taxable: "taxable",
      taxFree: null,
      personalPension: "es-plan-pensiones",
      workplacePension: "es-plan-pensiones",
    },
    // 67 from 2027 (65 with a contribution record of 38 years 6 months).
    statePension: { label: "pensión de jubilación", age: () => 67, deferralUplift: false },
    joint: false,
  },
  IL: {
    currency: "ILS",
    locale: "he-IL",
    flat: { ordinary: 0.2, capitalGains: 0.25, dividends: 0.25, local: 0 },
    note: "Israeli income tax with credit points, surtax, 25% tax on capital income and National Insurance.",
    taxYear: CALENDAR,
    inflation: 0.02,
    suggestedRetirementAge: 64,
    accountTypes: {
      cash: "savings",
      taxable: "taxable",
      taxFree: "il-keren-hishtalmut",
      personalPension: "il-pension",
      workplacePension: "il-pension",
    },
    // Statutory retirement age 67 for men (the women's age, rising to 65, is not defaulted).
    statePension: {
      label: "old-age pension (Bituach Leumi)",
      age: () => 67,
      deferralUplift: false,
    },
    joint: false,
  },
  IE: {
    currency: "EUR",
    locale: "en-IE",
    flat: { ordinary: 0.3, capitalGains: 0.33, dividends: 0.3, local: 0 },
    note: "Irish income tax (bands and credits, joint assessment), USC, PRSI, DIRT and CGT, with age-related pension relief.",
    taxYear: CALENDAR,
    inflation: 0.02,
    suggestedRetirementAge: 62,
    accountTypes: {
      cash: "savings",
      taxable: "taxable",
      taxFree: null,
      personalPension: "ie-pension",
      workplacePension: "ie-pension",
    },
    statePension: { label: "State Pension (Contributory)", age: () => 66, deferralUplift: false },
    joint: true,
  },
  NZ: {
    currency: "NZD",
    locale: "en-NZ",
    flat: { ordinary: 0.3, capitalGains: 0, dividends: 0.3, local: 0 },
    note: "New Zealand income tax, ACC earners' levy and imputation credits; no general capital gains tax.",
    taxYear: {
      startMonth: 4,
      startDay: 1,
      label: "1 April to 31 March",
      yearAlignment: { kind: "fiscal", startMonth: 4 },
    },
    inflation: 0.02,
    suggestedRetirementAge: 62,
    accountTypes: {
      cash: "savings",
      taxable: "taxable",
      taxFree: null,
      personalPension: "nz-kiwisaver",
      workplacePension: "nz-kiwisaver",
    },
    statePension: { label: "NZ Superannuation", age: () => 65, deferralUplift: false },
    joint: false,
  },
};

function intlDefaults(
  c: string,
  opts: { region?: string | undefined; birthMonth?: MonthDate | undefined },
): CountryDefaults {
  const spec = INTL[c]!;
  const stack = estimateStack({ country: c, ...(opts.region ? { region: opts.region } : {}) });
  const by = opts.birthMonth ? Number(opts.birthMonth.slice(0, 4)) : undefined;
  return {
    country: c,
    currency: spec.currency,
    locale: spec.locale,
    defaultRegion: null,
    tax: {
      mode: stack ? "estimate" : "flat",
      jurisdictions: stack ?? [],
      flat: spec.flat,
      note: spec.note,
    },
    taxYear: spec.taxYear,
    monteCarlo: {
      dataset: "us-1928",
      note: `No history is bundled for this country; US history is used. ${DATASET_NOTES["us-1928"]}`,
    },
    inflation: spec.inflation,
    suggestedRetirementAge: spec.suggestedRetirementAge,
    accountTypes: spec.accountTypes,
    statePension: {
      incomeType: "state-pension",
      startAge: spec.statePension.age(by),
      annualAmount: null,
      tripleLock: null,
      deferralUplift: spec.statePension.deferralUplift,
      label: spec.statePension.label,
    },
    filingStatus: (n) => (spec.joint && n > 1 ? "married-joint" : "single"),
  };
}

const CURRENCY_BY_COUNTRY: Record<string, string> = {
  IE: "EUR",
  DE: "EUR",
  FR: "EUR",
  ES: "EUR",
  NL: "EUR",
  IT: "EUR",
  PT: "EUR",
  BE: "EUR",
  AT: "EUR",
  FI: "EUR",
  IL: "ILS",
  AE: "AED",
  CH: "CHF",
  SE: "SEK",
  NO: "NOK",
  DK: "DKK",
  NZ: "NZD",
  JP: "JPY",
  SG: "SGD",
  HK: "HKD",
  IN: "INR",
  ZA: "ZAR",
  XX: "USD",
};
const LOCALE_BY_COUNTRY: Record<string, string> = {
  IE: "en-IE",
  DE: "de-DE",
  FR: "fr-FR",
  ES: "es-ES",
  NL: "nl-NL",
  IT: "it-IT",
  IL: "he-IL",
  NZ: "en-NZ",
  AE: "en-AE",
  XX: "en-US",
};

/**
 * Plan settings derived from the household's country, ready to spread into a new `PlanInput`
 * (templates, onboarding, samples, importers): tax mode / filing status / flat fallbacks, the
 * tax-year alignment, inflation and the Monte Carlo dataset.
 */
export function planDefaultsForHousehold(household: {
  location: Pick<Household["location"], "country"> & { region?: string | undefined };
  people: readonly { role: string; birthMonth: MonthDate }[];
}): Pick<PlanInput, "tax" | "assumptions" | "monteCarlo"> {
  const primary = household.people.find((p) => p.role === "primary") ?? household.people[0];
  const d = defaultsForCountry(household.location.country, {
    region: household.location.region,
    birthMonth: primary?.birthMonth,
  });
  return {
    tax: {
      mode: d.tax.mode,
      filingStatus: d.filingStatus(household.people.length),
      flat: d.tax.flat,
    },
    assumptions: {
      inflation: { kind: "fixed", rate: d.inflation },
      yearAlignment: d.taxYear.yearAlignment,
    },
    monteCarlo: { dataset: d.monteCarlo.dataset },
  };
}

/**
 * The month a household created at `now` should be dated (CurrentFinances.asOf). Core has no
 * clock; the API / web pass the current time. Use this instead of a fixed placeholder month.
 */
export function monthOf(now: Date): MonthDate {
  return `${String(now.getUTCFullYear()).padStart(4, "0")}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Empty current finances dated `now` (a household created before any balances are entered). */
export function emptyFinances(now: Date): CurrentFinancesInput {
  return { asOf: monthOf(now), accounts: [], realAssets: [], debts: [] };
}
