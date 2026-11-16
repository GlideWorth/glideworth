/**
 * How each supported country taxes NON-residents on income sourced there, what happens to its
 * tax-advantaged wrappers when the holder lives abroad, and its exit / arrival rules.
 *
 * Depth: GB 'high' (gov.uk guidance, cited per rule); US 'basic+' (citizenship-based taxation, FEIE,
 * FTC); every other country 'basic' (resident-only treatment of most income, source taxation of
 * property rental and property gains, pensions by the general rule). Treaties can override any of
 * these rules (treaties.ts).
 */
import type { IncomeCategory, NonResidentRules, Source, SourceRule } from "./types.js";

const T = (
  note: string,
  method: SourceRule["method"] = "resident-rates",
  rate?: number,
): SourceRule => ({
  taxed: true,
  method,
  ...(rate !== undefined ? { rate } : {}),
  note,
});
const N = (note: string): SourceRule => ({ taxed: false, note });

/** EU and EEA states plus Switzerland-free EEA list (EU 27 + Iceland, Liechtenstein, Norway). */
export const EEA_COUNTRIES: readonly string[] = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
];

const GOVUK = (url: string, note: string, year = "2026"): Source => ({ url, year, note });

// ------------------------------------------------------------------------------------- UK (high)

const UK_SOURCES = {
  liveAbroad: GOVUK(
    "https://www.gov.uk/tax-uk-income-live-abroad",
    "Tax on UK income if you live abroad: UK income is taxable; non-residents pay no UK tax on foreign income",
  ),
  rent: GOVUK(
    "https://www.gov.uk/tax-uk-income-live-abroad/rent",
    "Non-resident landlords pay UK tax on UK rent; the letting agent or tenant deducts basic-rate tax unless HMRC approves gross payment (NRL1)",
  ),
  pa: GOVUK(
    "https://www.gov.uk/tax-uk-income-live-abroad/personal-allowance",
    "Personal Allowance while non-resident: British citizens, EEA citizens, anyone who worked for the UK government in the year, or where a tax treaty allows it",
  ),
  nrcgt: GOVUK(
    "https://www.gov.uk/guidance/capital-gains-tax-for-non-residents-uk-residential-property",
    "Non-residents report and pay CGT on UK land and property within 60 days; annual exempt amount available once a year",
  ),
  nrcgtCalc: GOVUK(
    "https://www.gov.uk/guidance/capital-gains-tax-for-non-residents-calculating-taxable-gain-or-loss",
    "Gain from the value at 5 April 2015 (residential) / 5 April 2019 (non-residential), straight-line time apportionment, or the whole gain",
  ),
  isa: GOVUK(
    "https://www.gov.uk/individual-savings-accounts/if-you-move-abroad",
    "You can keep an ISA and its UK tax relief after moving abroad, but cannot pay in while non-resident (Crown servants excepted)",
  ),
  pensionRelief: GOVUK(
    "https://www.gov.uk/tax-on-your-private-pension/pension-tax-relief",
    "Relief on contributions up to 100% of UK earnings, or £3,600 gross a year without UK earnings; non-residents keep relief for 5 tax years after leaving if they were UK resident when they joined",
  ),
  pensionAbroad: GOVUK(
    "https://www.gov.uk/tax-uk-income-live-abroad/pensions",
    "Non-residents usually pay UK tax on UK pensions (relief where a double-taxation agreement applies) but not usually on the State Pension",
  ),
  statePensionAbroad: GOVUK(
    "https://www.gov.uk/state-pension-if-you-retire-abroad/rates-of-state-pension",
    "Yearly increases only in the EEA, Gibraltar, Switzerland and countries with a social security agreement (not Canada or New Zealand); frozen elsewhere, back to the current rate on return to the UK",
  ),
  voluntaryNi: GOVUK(
    "https://www.gov.uk/voluntary-national-insurance-contributions/if-you-live-or-work-abroad",
    "From 2026-27 Class 2 cannot be paid for time abroad; Class 3 needs 10 years of UK residence or 10 qualifying years",
  ),
  voluntaryNiRates: GOVUK(
    "https://www.gov.uk/voluntary-national-insurance-contributions/rates",
    "Class 3: £18.40 a week (2026-27); Class 2: £3.65 a week",
  ),
  tnr: GOVUK(
    "https://www.gov.uk/government/publications/temporary-non-residents-and-capital-gains-tax-hs278-self-assessment-helpsheet/hs278-temporary-non-residents-and-capital-gains-tax-2026",
    "HS278: sole UK residence in 4 of the 7 tax years before leaving and non-residence of 5 years or less: gains of the non-resident period are taxed in the year of return",
  ),
  iht: GOVUK(
    "https://www.gov.uk/guidance/inheritance-tax-if-youre-a-long-term-uk-resident",
    "From 6 April 2025: worldwide assets in scope for long-term UK residents (UK resident 10 of the previous 20 tax years); after leaving, in scope for 3 to 10 tax years",
    "2025",
  ),
  ihtManual: GOVUK(
    "https://www.gov.uk/hmrc-internal-manuals/inheritance-tax-manual/ihtm47020",
    "IHTM47020: long-term residence test; tail of 3 tax years for 10-13 years of residence, +1 per extra year, at most 10",
    "2025",
  ),
};

export const UK_NON_RESIDENT_SOURCES = UK_SOURCES;

const UK: NonResidentRules = {
  country: "GB",
  label: "United Kingdom",
  depth: "high",
  rules: {
    employment: T("Pay for work done in the UK is taxable in the UK (UK rates; Class 1 NI)."),
    "self-employment": T("Profits of a trade carried on in the UK are taxable in the UK."),
    rental: T(
      "UK rental profits are taxable at UK rates (non-resident landlord scheme: basic-rate tax deducted by the agent or tenant is a payment on account).",
    ),
    "private-pension": T(
      "UK pensions are taxable in the UK at UK rates unless a tax treaty gives the right to the country of residence.",
    ),
    "pension-lump-sum": T(
      "The tax-free part of a UK pension lump sum stays tax-free (within the lump sum allowance).",
    ),
    "state-pension": T(
      'The UK State Pension is taxable but is "disregarded income": UK tax on it is limited to tax deducted at source (none).',
    ),
    "government-pension": T(
      "UK government service pensions stay taxable in the UK under most treaties.",
    ),
    interest: T(
      "UK interest is disregarded income: UK tax is limited to tax deducted at source (UK bank interest is paid gross, so none).",
    ),
    dividends: T(
      "UK dividends are disregarded income: no UK tax beyond tax deducted at source (none).",
    ),
    "gains-property": T(
      "Non-resident capital gains tax on UK land and property, on the gain since 5 April 2015 (residential) or 5 April 2019 (non-residential), or time-apportioned.",
    ),
    "gains-securities": N(
      "Non-residents pay no UK CGT on shares and funds (except under the temporary non-residence rule).",
    ),
    other: N("Other income of a non-resident from UK sources is not modelled as taxable."),
  },
  personalAllowance: {
    kind: "citizens",
    citizens: ["GB", ...EEA_COUNTRIES],
    note: "British and EEA citizens keep the Personal Allowance while non-resident; others only where a treaty allows (not modelled).",
  },
  pensionLumpSumTaxFree: true,
  disregardedIncome: {
    categories: ["interest", "dividends", "state-pension"],
    note: "UK tax of a non-resident is the lower of (a) the normal calculation with the personal allowance and (b) tax on income other than disregarded income without any personal allowance plus tax deducted at source on disregarded income.",
  },
  propertyGains: {
    rebasing: { residential: "2015-04", commercial: "2019-04" },
    timeApportionment: true,
    note: "Glideworth uses the lowest of: the gain over the value at the rebasing date (when a valuation is entered on the asset), the time-apportioned gain (when the acquisition month is known), and the whole gain.",
  },
  wrappers: [
    {
      accountTypes: ["uk-isa", "uk-lisa"],
      keepsShelter: true,
      contributions: "none",
      note: "ISAs keep their UK tax shelter, but no subscriptions while non-resident (allowed in the tax year you leave).",
    },
    {
      accountTypes: ["uk-sipp", "uk-pension", "uk-workplace-pension"],
      keepsShelter: true,
      contributions: "relief-capped",
      capGross: 3600,
      yearsAfterDeparture: 5,
      note: "Relief on up to £3,600 gross a year for the 5 tax years after leaving (if UK resident when the scheme was joined), then no relief; Glideworth stops contributions after that.",
    },
  ],
  temporaryNonResidence: {
    maxYears: 5,
    priorResidentYears: 4,
    ofYears: 7,
    note: "Gains realised while non-resident on assets held before leaving are taxed in the tax year of return when non-residence lasts 5 years or less (and the person was UK resident in 4 of the 7 tax years before leaving).",
    sources: [UK_SOURCES.tnr],
  },
  simplifications: [
    "Split-year treatment is approximated by prorating the year by months in each country; the UK personal allowance is prorated the same way (the real split year keeps a full allowance).",
    "Non-residents who are not British or EEA citizens lose the Personal Allowance; treaty-based entitlements are not modelled.",
    "Disregarded income: interest, dividends and the State Pension; other disregarded items (some social security benefits) are not separated.",
    "Property gains of non-residents: rebasing needs a valuation at 5 April 2015 / 2019 on the asset; otherwise time apportionment from the acquisition month; otherwise the whole gain. Private residence relief for a former home (90-day test) is not modelled.",
    "Temporary non-residence covers capital gains only; pension lump sums and flexi-access drawdown taken abroad, and close-company dividends, are not brought back into charge.",
    "Statutory residence test not evaluated: residence follows the timeline you enter.",
  ],
  sources: Object.values(UK_SOURCES),
};

// ------------------------------------------------------------------------------------- US

const US: NonResidentRules = {
  country: "US",
  label: "United States",
  depth: "basic",
  rules: {
    employment: T(
      "Pay for services performed in the US is effectively connected income taxed at graduated rates.",
    ),
    "self-employment": T(
      "Business income effectively connected with a US trade or business: graduated rates.",
    ),
    rental: T(
      "US real-property rent: 30% of the gross rent withheld unless the owner elects to be taxed on net income (most do; Glideworth assumes the election, at graduated rates without a standard deduction).",
    ),
    "private-pension": T(
      "US pensions and IRA distributions to non-resident aliens: 30% withholding (treaties reduce it).",
      "flat",
      0.3,
    ),
    "pension-lump-sum": T("Lump sums: as other distributions.", "flat", 0.3),
    "state-pension": T(
      "Social Security to non-resident aliens: 30% on 85% of the benefit (25.5%), unless a treaty exempts it.",
      "flat",
      0.255,
    ),
    "government-pension": T(
      "US government pensions: 30% withholding unless a treaty applies.",
      "flat",
      0.3,
    ),
    interest: N("Bank deposit and portfolio interest paid to non-resident aliens is exempt."),
    dividends: T(
      "US dividends to non-resident aliens: 30% withholding (treaties reduce it, typically to 15%).",
      "flat",
      0.3,
    ),
    "gains-property": T("FIRPTA: gains on US real property are taxed at graduated rates."),
    "gains-securities": N(
      "Capital gains of non-resident aliens on securities are not taxed (183-day rule ignored).",
    ),
    other: N("Other income not modelled as taxable."),
  },
  personalAllowance: {
    kind: "none",
    note: "Non-resident aliens get no standard deduction (Glideworth approximates the graduated calculation with the federal plug-in as filed single).",
  },
  pensionLumpSumTaxFree: false,
  wrappers: [
    {
      accountTypes: [
        "traditional-ira",
        "roth-ira",
        "401k",
        "roth-401k",
        "403b",
        "roth-403b",
        "tsp",
        "roth-tsp",
      ],
      keepsShelter: true,
      contributions: "allowed",
      note: "US retirement accounts keep their US treatment; IRA contributions need taxable compensation (foreign pay excluded under the FEIE does not count).",
    },
  ],
  citizenshipTaxation: {
    foreignEarnedIncomeExclusion: [
      { year: 2025, amount: 130_000 },
      { year: 2026, amount: 132_900 },
    ],
    note: "US citizens and green-card holders are taxed on worldwide income wherever they live. Foreign earned income up to the exclusion is excluded (Form 2555); foreign income tax on other foreign income is credited (Form 1116), limited to the US tax on that income.",
    sources: [
      {
        url: "https://www.irs.gov/individuals/international-taxpayers/figuring-the-foreign-earned-income-exclusion",
        year: "2026",
        note: "Maximum foreign earned income exclusion: $130,000 (2025), $132,900 (2026); prorated for part years",
      },
      {
        url: "https://www.irs.gov/publications/p514",
        year: "2025",
        note: "Publication 514: foreign tax credit for individuals; limit = US tax x foreign-source taxable income / total taxable income",
      },
    ],
  },
  simplifications: [
    "Citizenship-based taxation: federal income tax only (no state tax, no NIIT/self-employment tax abroad, totalisation agreements not applied).",
    "FEIE prorated by months abroad in the year; the housing exclusion and the stacking rule are not applied.",
    "Foreign tax credit: one basket, no carryback/carryforward; foreign tax on the item is estimated from the residence country's tax on it.",
    "Non-resident aliens: rental income assumed net-basis election; FIRPTA withholding on sales not separated from the final tax.",
    "Exit tax on renouncing citizenship (covered expatriates) is not modelled.",
  ],
  sources: [
    {
      url: "https://www.irs.gov/individuals/international-taxpayers/taxation-of-nonresident-aliens",
      year: "2026",
      note: "Taxation of non-resident aliens: effectively connected income at graduated rates; FDAP income at 30% unless a treaty reduces it",
    },
  ],
};

// ------------------------------------------------------------------------------------- CA

const CA: NonResidentRules = {
  country: "CA",
  label: "Canada",
  depth: "basic",
  rules: {
    employment: T("Employment in Canada is taxed at Canadian rates."),
    "self-employment": T("Business carried on in Canada is taxed at Canadian rates."),
    rental: T(
      "Part XIII: 25% of gross rent (a section 216 election taxes net rent at Canadian rates instead).",
      "flat",
      0.25,
    ),
    "private-pension": T(
      "Part XIII: 25% on pensions and RRSP/RRIF payments (treaties reduce it).",
      "flat",
      0.25,
    ),
    "pension-lump-sum": T("Part XIII: 25% on lump sums.", "flat", 0.25),
    "state-pension": T(
      "CPP/OAS paid abroad: 25% Part XIII tax unless a treaty reduces it.",
      "flat",
      0.25,
    ),
    "government-pension": T("25% Part XIII tax unless a treaty applies.", "flat", 0.25),
    interest: N("Arm's-length interest paid to non-residents is exempt from Part XIII tax."),
    dividends: T("Part XIII: 25% on dividends (treaties reduce it to 15%).", "flat", 0.25),
    "gains-property": T(
      "Gains on taxable Canadian property (Canadian real estate) are taxed at Canadian rates.",
    ),
    "gains-securities": N("Gains on listed securities of non-residents are generally not taxed."),
    other: N("Other income not modelled as taxable."),
  },
  personalAllowance: {
    kind: "none",
    note: "Non-residents generally cannot claim most non-refundable credits.",
  },
  pensionLumpSumTaxFree: false,
  wrappers: [
    {
      accountTypes: ["ca-tfsa"],
      keepsShelter: true,
      contributions: "none",
      note: "TFSA: income stays exempt in Canada, but contributions while non-resident attract a 1% monthly tax (Glideworth blocks them).",
    },
    {
      accountTypes: ["ca-rrsp", "ca-rrif", "ca-fhsa", "ca-lira"],
      keepsShelter: true,
      contributions: "none",
      note: "RRSPs keep their deferral; no new room from foreign earnings (Glideworth blocks contributions).",
    },
  ],
  departure: {
    kind: "deemed-disposal",
    scope:
      "Taxable (non-registered) investment accounts; Canadian real property and registered plans (RRSP, RRIF, TFSA, pensions) are excluded.",
    deferrable: true,
    note: "Emigrants are deemed to sell most property at fair market value the day before leaving; the tax can be deferred with security (form T1244).",
    sources: [
      {
        url: "https://www.canada.ca/en/revenue-agency/services/tax/international-non-residents/individuals-leaving-entering-canada-non-residents/dispositions-property.html",
        year: "2026",
        note: "Dispositions of property for emigrants of Canada",
      },
    ],
  },
  arrivalRebasing: {
    note: "Immigrants are deemed to acquire their property (other than taxable Canadian property) at fair market value on arrival.",
    sources: [
      {
        url: "https://www.canada.ca/en/revenue-agency/services/tax/international-non-residents/individuals-leaving-entering-canada-non-residents/newcomers-canada-immigrants/completing-return-newcomers.html",
        year: "2026",
      },
    ],
  },
  simplifications: [
    "Part XIII withholding is treated as the final tax on rent, pensions and dividends (no section 216/217 elections).",
    "Departure tax applies to taxable investment accounts at their opening balance in the year of departure; the security election is the `departureTax: defer` switch.",
  ],
  sources: [
    {
      url: "https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/t4058/non-residents-income-tax.html",
      year: "2024",
      note: "T4058 Non-Residents and Income Tax",
    },
  ],
};

// ------------------------------------------------------------------------------------- AU

const AU: NonResidentRules = {
  country: "AU",
  label: "Australia",
  depth: "basic",
  rules: {
    employment: T(
      "Australian-source pay of foreign residents: foreign-resident rates (no tax-free threshold).",
    ),
    "self-employment": T("Australian business income: foreign-resident rates."),
    rental: T("Australian rent: foreign-resident rates (no tax-free threshold)."),
    "private-pension": N(
      "Super benefits from a taxed fund paid to someone aged 60 or over are tax-free (younger: not modelled).",
    ),
    "pension-lump-sum": N("Lump sums from a taxed fund after 60 are tax-free."),
    "state-pension": T("Australian government pensions paid abroad are taxable in Australia."),
    "government-pension": T("Australian government pensions are taxable in Australia."),
    interest: T("Interest withholding tax 10%.", "flat", 0.1),
    dividends: N("Franked dividends carry no withholding (unfranked 30%: not separated)."),
    "gains-property": T(
      "Taxable Australian property (real estate): taxed, no 50% CGT discount for foreign residents.",
    ),
    "gains-securities": N(
      "Foreign residents pay no CGT on assets that are not taxable Australian property.",
    ),
    other: N("Other income not modelled as taxable."),
  },
  personalAllowance: { kind: "none", note: "Foreign residents have no tax-free threshold." },
  pensionLumpSumTaxFree: true,
  wrappers: [
    {
      accountTypes: ["au-super-accumulation", "au-super-pension"],
      keepsShelter: true,
      contributions: "allowed",
      note: "Super keeps its concessional treatment; contributions are possible but not deductible without Australian income.",
    },
  ],
  departure: {
    kind: "deemed-disposal",
    scope:
      "Assets that are not taxable Australian property (Glideworth: taxable investment accounts).",
    deferrable: true,
    note: "CGT event I1: ceasing residence is a deemed disposal of assets that are not taxable Australian property; individuals may choose to disregard it (the assets then stay taxable Australian property).",
    sources: [
      {
        url: "https://www.ato.gov.au/individuals-and-families/investments-and-assets/capital-gains-tax/foreign-residents-and-capital-gains-tax/how-changing-residency-affects-cgt",
        year: "2026",
        note: "How changing residency affects CGT",
      },
    ],
  },
  arrivalRebasing: {
    note: "On becoming resident, assets other than taxable Australian property are taken to be acquired at market value.",
    sources: [
      {
        url: "https://www.ato.gov.au/individuals-and-families/investments-and-assets/capital-gains-tax/foreign-residents-and-capital-gains-tax/how-changing-residency-affects-cgt",
        year: "2026",
      },
    ],
  },
  simplifications: [
    "Foreign-resident rates are approximated with the resident calculation (the tax-free threshold and Medicare levy differences are not modelled).",
  ],
  sources: [
    {
      url: "https://www.ato.gov.au/individuals-and-families/investments-and-assets/capital-gains-tax/foreign-residents-and-capital-gains-tax/how-changing-residency-affects-cgt",
      year: "2026",
    },
  ],
};

// ------------------------------------------------------------------------------------- basic

function basic(
  country: string,
  label: string,
  over: Partial<Record<IncomeCategory, SourceRule>> = {},
  extra: Partial<NonResidentRules> = {},
): NonResidentRules {
  return {
    country,
    label,
    depth: "basic",
    rules: {
      employment: T("Work done in the country is taxed there."),
      "self-employment": T("A business carried on in the country is taxed there."),
      rental: T("Rent from property in the country is taxed there."),
      "private-pension": T(
        "Pensions paid from the country may be taxed there (treaties usually give the right to the country of residence).",
      ),
      "pension-lump-sum": T("As pensions."),
      "state-pension": T(
        "State pensions paid from the country may be taxed there (treaties usually give the right to the country of residence).",
      ),
      "government-pension": T(
        "Government pensions are taxed by the paying country under most treaties.",
      ),
      interest: N(
        "Interest of non-residents: not modelled as taxed (withholding, if any, is usually credited or refunded under treaties).",
      ),
      dividends: N("Dividend withholding on non-residents is not modelled."),
      "gains-property": T("Gains on property in the country are taxed there."),
      "gains-securities": N("Gains on securities of non-residents are not taxed."),
      other: N("Other income not modelled as taxable."),
      ...over,
    },
    personalAllowance: {
      kind: "all",
      note: "The national calculation is used as for residents (basic level).",
    },
    pensionLumpSumTaxFree: false,
    wrappers: [],
    simplifications: [
      "Basic level: non-residents are taxed with the resident calculation on income sourced in the country (rent, property gains, pensions, work); withholding taxes on interest and dividends are not modelled.",
    ],
    sources: [],
    ...extra,
  };
}

const ES = basic(
  "ES",
  "Spain",
  {
    rental: T(
      "IRNR: 24% of gross rent (19% with expenses deductible for EU/EEA residents).",
      "flat",
      0.24,
    ),
    "gains-property": T("IRNR: 19% on gains from Spanish property.", "flat", 0.19),
    employment: T("IRNR: 24% on Spanish employment income of non-residents.", "flat", 0.24),
  },
  {
    simplifications: [
      "IRNR flat rates: 24% on rent and pay (19% net for EU/EEA residents is not separated), 19% on property gains; pensions with the resident scale (the IRNR pension scale is not modelled).",
    ],
    sources: [
      {
        url: "https://sede.agenciatributaria.gob.es/Sede/en_gb/no-residentes.html",
        year: "2026",
        note: "Agencia Tributaria: Non-Resident Income Tax (IRNR)",
      },
    ],
  },
);

const AE: NonResidentRules = {
  country: "AE",
  label: "United Arab Emirates",
  depth: "basic",
  rules: Object.fromEntries(
    (
      [
        "employment",
        "self-employment",
        "rental",
        "private-pension",
        "pension-lump-sum",
        "state-pension",
        "government-pension",
        "interest",
        "dividends",
        "gains-property",
        "gains-securities",
        "other",
      ] as const
    ).map((c) => [c, N("The UAE does not tax individuals on income or gains.")]),
  ) as Record<IncomeCategory, SourceRule>,
  personalAllowance: { kind: "all", note: "No personal income tax." },
  pensionLumpSumTaxFree: true,
  wrappers: [
    {
      accountTypes: ["ae-dews", "ae-savings-scheme"],
      keepsShelter: true,
      contributions: "allowed",
      note: "End-of-service savings schemes are tied to UAE employment; other countries may tax their growth (see wrapper recognition).",
    },
  ],
  simplifications: [
    "No UAE tax on non-residents (Corporate Tax on business turnover above AED 1m is out of scope).",
  ],
  sources: [
    {
      url: "https://tax.gov.ae/en/taxes/corporate.tax/corporate.tax.topics/basis.of.taxation.natural.person.aspx",
      year: "2026",
    },
  ],
};

/** Non-resident rules by country (ISO alpha-2). */
export const NON_RESIDENT_RULES: Readonly<Record<string, NonResidentRules>> = {
  GB: UK,
  US,
  CA,
  AU,
  ES,
  AE,
  DE: basic("DE", "Germany", {
    dividends: T("Kapitalertragsteuer 26.375% withheld on German dividends.", "flat", 0.26375),
    "gains-property": T(
      "Gains on German property sold within 10 years of purchase (private sale) are taxed.",
    ),
  }),
  NL: basic("NL", "Netherlands", {
    dividends: T("Dividendbelasting 15% withheld on Dutch dividends.", "flat", 0.15),
  }),
  FR: basic("FR", "France", {
    "gains-property": T(
      "Non-residents: 19% on French property gains plus social charges (7.5% for EEA residents, 17.2% otherwise; Glideworth uses 7.5%).",
      "flat",
      0.265,
    ),
  }),
  IL: basic("IL", "Israel"),
  IE: basic("IE", "Ireland", {
    dividends: T("Dividend withholding tax 25% on Irish dividends.", "flat", 0.25),
  }),
  NZ: basic("NZ", "New Zealand"),
};

export function nonResidentRulesFor(country: string): NonResidentRules | undefined {
  return NON_RESIDENT_RULES[country];
}
