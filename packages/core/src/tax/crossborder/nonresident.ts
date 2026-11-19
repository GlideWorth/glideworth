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
    "https://www.gov.uk/tax-uk-income-live-abroad",
    "Non-residents usually pay UK tax on UK income such as pensions (relief where a double-taxation agreement applies) but not usually on the State Pension",
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
    "gains-securities": N("Non-residents pay no UK CGT on shares and funds."),
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
      contributions: "none",
      note: "Pensions keep their UK tax treatment. Relief on up to £3,600 gross a year continues for the 5 tax years after leaving (if UK resident when the scheme was joined); Glideworth does not know when you left, so it blocks contributions while you live abroad.",
    },
  ],
  simplifications: [
    "Non-residents who are not British or EEA citizens lose the Personal Allowance; Glideworth does not give it to people who worked for the UK government that year or whose treaty allows it (claim with form R43).",
    "Disregarded income: interest, dividends and the State Pension; other disregarded items (some social security benefits) are not separated.",
    "Property gains of non-residents: rebasing needs a valuation at 5 April 2015 / 2019 on the asset; otherwise time apportionment from the acquisition month; otherwise the whole gain. Private residence relief for a former home (90-day test) is not modelled.",
    "Statutory residence test not evaluated: you are non-resident when the household lives in another country.",
    "Pension lump sums and regular pension payments are not told apart at source: a UK lump sum paid to someone whose treaty gives lump sums to the UK (the US, Art. 17(2)) is taxed where they live instead.",
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
      "Social Security to non-resident aliens: 85% of the benefit is taxed at 30% (25.5%), unless a treaty exempts it (the UK and Canada treaties do).",
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
      "Capital gains of non-resident aliens on securities are not taxed (the 30% tax for people in the US 183 days or more in the year does not apply to someone living abroad).",
    ),
    other: N("Other income not modelled as taxable."),
  },
  personalAllowance: {
    kind: "none",
    note: "Non-resident aliens cannot claim the standard deduction (Publication 519); Glideworth taxes their effectively connected income at the single rates with no standard deduction.",
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
      note: "US retirement accounts keep their US treatment. Contributions need US-taxable pay: an IRA needs compensation that is not excluded under the FEIE, and a 401(k) or 403(b) needs a US employer (Glideworth does not check either).",
    },
  ],
  citizenshipTaxation: {
    foreignEarnedIncomeExclusion: [
      { year: 2025, amount: 130_000 },
      { year: 2026, amount: 132_900 },
      { year: 2027, amount: 137_300 },
    ],
    note: "US citizens and green-card holders are taxed on worldwide income wherever they live. Foreign earned income up to the exclusion is excluded (Form 2555), and the rest is taxed at the rates that would apply without the exclusion (stacking rule). Foreign income tax on other foreign income is credited (Form 1116), limited to the US tax on that income; no credit is given for foreign tax on the excluded income. Treaties do not stop this, except that US Social Security is taxed only where you live if that is the UK or Canada.",
    sources: [
      {
        url: "https://www.irs.gov/individuals/international-taxpayers/figuring-the-foreign-earned-income-exclusion",
        year: "2026",
        note: "Maximum foreign earned income exclusion: $130,000 (2025), $132,900 (2026); prorated for part years",
      },
      {
        url: "https://www.irs.gov/pub/irs-drop/rp-25-32.pdf",
        year: "2026",
        note: "Rev. Proc. 2025-32 section 4.39: exclusion $132,900 for taxable years beginning in 2026",
      },
      {
        url: "https://www.irs.gov/pub/irs-drop/rp-26-35.pdf",
        year: "2027",
        note: "Rev. Proc. 2026-35 section 3.41: exclusion $137,300 for taxable years beginning in 2027",
      },
      {
        url: "https://www.irs.gov/publications/p54",
        year: "2025",
        note: "Publication 54: tax on income not excluded is figured at the rates that would apply without the exclusion (Foreign Earned Income Tax Worksheet)",
      },
      {
        url: "https://www.irs.gov/publications/p514",
        year: "2025",
        note: "Publication 514: foreign tax credit limit; no credit for foreign tax on income excluded under the FEIE (Taxes on Excluded Income)",
      },
    ],
  },
  simplifications: [
    "Citizenship-based taxation: federal income tax and the Net Investment Income Tax (which the foreign tax credit does not reduce here). No state tax and no self-employment tax abroad (self-employment tax is due where no totalisation agreement covers the work). From 65 the Medicare income surcharge (IRMAA) is charged as if you were enrolled in Medicare.",
    "FEIE: everyone abroad is assumed to qualify (bona fide residence or physical presence test) for the months in the year; the foreign housing exclusion or deduction is not applied. The stacking rule is applied with the standard deduction of the year.",
    "Foreign tax credit: one basket, no carryback or carryforward. Foreign tax is the person's equal share of the residence country's tax plus their source taxes, less the share on income excluded under the FEIE (pro rata to income). Foreign social security contributions (such as UK National Insurance) are never counted: no credit is allowed for those paid to a country with a US social security agreement, and Glideworth does not check which countries have one.",
    "Treaty saving clauses: the US taxes its citizens abroad on everything except what the UK and Canada treaties keep for them (US Social Security is taxed only where they live). Contribution relief for UK pensions (UK-US Art. 18(5)) is not applied.",
    "Non-resident aliens: rental income assumed taxed on the net-income election; married non-resident aliens are taxed at single rates (married filing separately in law); FIRPTA withholding on sales is not separated from the final tax.",
    "Exit tax on renouncing citizenship (covered expatriates) is not modelled.",
    "Not modelled: US estate tax on the US assets (US real estate and shares of US companies) of people who are neither US citizens nor US residents, which applies when they are worth more than $60,000 at death; and the PFIC rules for non-US funds held by US persons (for example UK or EU funds, in an ISA or not), which can tax them much more heavily than shown.",
  ],
  sources: [
    {
      url: "https://www.irs.gov/individuals/international-taxpayers/taxation-of-nonresident-aliens",
      year: "2026",
      note: "Taxation of non-resident aliens: effectively connected income at graduated rates; FDAP income at 30% unless a treaty reduces it",
    },
    {
      url: "https://www.irs.gov/publications/p519",
      year: "2025",
      note: "Publication 519: 85% of Social Security is FDAP income taxed at 30%; portfolio interest exempt; no standard deduction for non-resident aliens; net-income election for real property",
    },
    {
      url: "https://www.irs.gov/individuals/international-taxpayers/some-nonresidents-with-us-assets-must-file-estate-tax-returns",
      year: "2026",
      note: "Estate tax return (Form 706-NA) when US-situated assets of a non-resident non-citizen exceed $60,000 at death (not modelled)",
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
    note: "Non-residents can claim most non-refundable credits only when 90% or more of their world income is taxable in Canada; Glideworth's Canadian calculation still gives them (see simplifications).",
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
      note: "RRSPs keep their deferral and earn no new room from foreign pay; unused room can still be used, but Glideworth blocks contributions while you live abroad.",
    },
  ],
  simplifications: [
    "Part XIII withholding is treated as the final tax on rent, pensions and dividends (no section 216/217 elections).",
    "Pay and gains on Canadian property of a non-resident use the resident federal and provincial calculation with its personal credits; in law the credits usually need 90% of world income to be Canadian, and a federal surtax replaces provincial tax, so Canadian tax may be understated.",
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
  simplifications: [
    "Foreign residents have no tax-free threshold and their own rates, but Glideworth uses the resident calculation (with the tax-free threshold, less the Medicare levy), so Australian tax on Australian pay, rent and property gains of foreign residents is understated. The foreign-resident rates could not be read from ato.gov.au in this check (access refused) and are not applied.",
    "Unfranked dividends to foreign residents carry 30% withholding (15% under most treaties); Glideworth treats all Australian dividends as franked (no Australian tax).",
    "Super paid to someone under 60 is not taxed in Australia here.",
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
      "Basic level: non-residents are taxed with the resident calculation, including its allowances, on income sourced in the country (rent, property gains, pensions, work); withholding taxes on interest and dividends are not modelled unless listed. These rules were not checked against this country's non-resident guidance.",
    ],
    sources: [],
    ...extra,
  };
}

const ES = basic(
  "ES",
  "Spain",
  {
    dividends: T(
      "IRNR: 19% on Spanish dividends of non-residents (treaties reduce it: UK 10%).",
      "flat",
      0.19,
    ),
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
      "IRNR flat rates: 24% on rent and pay (19% for residents of the EU, Iceland, Norway and Liechtenstein, with expenses deductible, is not separated), 19% on property gains and dividends. Pensions use the resident scale, not the IRNR pension scale (8% to €12,000, 30% to €18,700, 40% above). Interest (19% for non-EU residents without a treaty) and the yearly tax on a Spanish home that is not let (imputed income) are not modelled.",
    ],
    sources: [
      {
        url: "https://sede.agenciatributaria.gob.es/Sede/no-residentes/irnr-sin-establecimiento-permanente/tipos-gravamen-irnr-sin-establecimiento-permanente.html",
        year: "2025-06-18",
        note: "Agencia Tributaria: IRNR rates without a permanent establishment (24% general, 19% EU/EEA; dividends, interest and gains 19%; pension scale 8/30/40%); read 2026-11-19",
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
  DE: basic(
    "DE",
    "Germany",
    {
      dividends: T(
        "Kapitalertragsteuer 25% plus 5.5% solidarity surcharge (26.375%) withheld on German dividends; treaties cap it and the excess is reclaimed.",
        "flat",
        0.26375,
      ),
      "gains-property": T(
        "Gains on German property are taxed when no more than 10 years pass between purchase and sale (private sale, §23(1) EStG); after that they are exempt.",
      ),
    },
    {
      personalAllowance: {
        kind: "none",
        note: "Non-residents get no basic allowance: their taxable income is increased by the Grundfreibetrag before the tariff is applied (§50(1) EStG; for pay, only the part of the allowance above the pay), and joint assessment is not available.",
      },
      propertyGainsExemptAfterYears: 10,
      simplifications: [
        "Non-residents are taxed with the German tariff without the basic allowance (§50(1) EStG). Property gains within 10 years are taxed at the 25% flat rate of the German calculation, not at the tariff, and a sale is dated at the start of its plan year, so a sale in the year the 10 years run out may still be taxed. Glideworth does not offer the option for EU/EEA residents to be taxed as residents (§1(3) EStG).",
      ],
      sources: [
        {
          url: "https://www.gesetze-im-internet.de/estg/__50.html",
          year: "2026",
          note: "§50(1) EStG: taxable income of non-residents increased by the Grundfreibetrag; read 2026-11-19",
        },
        {
          url: "https://www.gesetze-im-internet.de/estg/__23.html",
          year: "2026",
          note: "§23(1) Nr. 1 EStG: land sold within no more than ten years of purchase is a private sale (taxed; §49(1) Nr. 8 for non-residents); read 2026-11-19",
        },
      ],
    },
  ),
  NL: basic("NL", "Netherlands", {
    dividends: T("Dividendbelasting 15% withheld on Dutch dividends.", "flat", 0.15),
  }),
  FR: basic(
    "FR",
    "France",
    {
      "gains-property": {
        ...T(
          "Non-residents: 19% on French property gains plus social levies: 7.5% for people covered by EU/EEA or UK social security, 17.2% otherwise.",
          "flat",
          0.362,
        ),
        rateByResidence: [{ residences: [...EEA_COUNTRIES, "GB"], rate: 0.265 }],
      },
    },
    {
      simplifications: [
        "French property gains of non-residents: 19% plus 7.5% (EU/EEA or UK residents, assumed covered by that social security) or 17.2% (everyone else) on the whole gain. The allowances for years of ownership (no income tax after 22 years, no social levies after 30) and the surtax on gains above €50,000 are not applied, so the tax on a long-held property is overstated.",
      ],
      sources: [
        {
          url: "https://bofip.impots.gouv.fr/bofip/7508-PGP.html/identifiant=BOI-RFPI-PVINR-20-20-20220629",
          year: "2022",
          note: "BOFiP BOI-RFPI-PVINR-20-20: 19% for individuals; only the 7.5% solidarity levy for people under EU social security coordination or, from 2021, UK social security; read 2026-11-19",
        },
      ],
    },
  ),
  IL: basic("IL", "Israel"),
  IE: basic(
    "IE",
    "Ireland",
    {
      dividends: N(
        "Dividend withholding tax (25%) does not apply to individuals resident in the EU/EEA or a country with an Irish tax treaty (every country Glideworth supports) once they file form V2A.",
      ),
    },
    {
      sources: [
        {
          url: "https://www.revenue.ie/en/companies-and-charities/dividend-withholding-tax/exemptions-for-non-residents.aspx",
          year: "2026",
          note: "Revenue: DWT exemption for individuals resident in an EU/EEA state or a treaty country (form V2A); read 2026-11-19",
        },
        {
          url: "https://www.revenue.ie/en/tax-professionals/tax-agreements/double-taxation-treaties/tax-treaties-by-country.aspx",
          year: "2026",
          note: "Revenue: Ireland's treaties include Australia, Canada, France, Germany, Israel, the Netherlands, New Zealand, Spain, the UAE, the UK and the US; read 2026-11-19",
        },
      ],
    },
  ),
  NZ: basic("NZ", "New Zealand"),
};

export function nonResidentRulesFor(country: string): NonResidentRules | undefined {
  return NON_RESIDENT_RULES[country];
}
