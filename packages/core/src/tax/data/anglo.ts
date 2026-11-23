/**
 * Known simplifications of the UK, US, Canadian and Australian plug-ins, written from what
 * ../jurisdictions/{uk,us-federal,us-payroll,us-state,ca,au}.ts and the engine actually do.
 * Shown in the UI as "what this estimate leaves out". Keep them in step with the code.
 */

/** Applies to every jurisdiction: how the engine feeds investment income to the tax plug-ins. */
const ENGINE_GAINS =
  "Gains are realised pro rata to cost basis when a taxable account is drawn, and all of them are treated as long-term; losses are never realised, so there is no loss relief or carry-forward. Selling specific lots is not modelled.";

export const UK_SIMPLIFICATIONS: readonly string[] = [
  "Tax years 2025/26 and 2026/27, with the 2027/28 changes announced at Budget 2025 and Budget 2026 and the 2029/30 salary sacrifice change; later years carry the last rates forward, with thresholds frozen to April 2031 (the legislated policy) and then indexed, unless you choose another threshold policy.",
  "2027/28 savings and property income rates are the 24%, 44% and 49% announced at Budget 2026 (Finance Act 2026 enacted 22%, 42% and 47%; the further rise awaits Finance Bill 2026-27). Property rates apply in England, Wales and Northern Ireland; in Scotland property income stays on the Scottish rates until the Scottish Parliament sets property rates.",
  "Plans on calendar years map year Y onto tax year Y/Y+1; choose the April tax-year alignment for exact UK years.",
  "Independent taxation: each person is taxed alone and jointly owned income is split 50:50 (no Form 17 unequal split).",
  "Not modelled: blind person’s allowance, married couple’s allowance (born before 1935), trading and property allowances (the trading allowance rises to £3,000 from April 2027), Gift Aid band extension, and the four-year foreign income and gains regime for new arrivals (the remittance basis ended on 5 April 2025).",
  "Residence is where the household lives for the whole plan; the statutory residence test is not applied. A household living outside the UK pays UK tax only on UK income and keeps the personal allowance only as a British or EEA citizen (treaty entitlements are not modelled).",
  "Pension Tax Allowance (announced, 2027/28 to 2029/30): people over State Pension age get up to 20% of (£13,037 − the personal allowance) off their income tax, withdrawn at £1 for every £3 of income above £13,037 (Annex A puts full withdrawal at £13,319; the formula gives about £13,317). The government will uprate it with the new State Pension; the 2028/29 and 2029/30 amounts are not published, so Glideworth indexes the 2027/28 threshold with prices. Income is approximated by net income.",
  "Pension annual allowance: tapered and MPAA rules apply, but unused allowance is not carried forward from earlier years; any charge on the excess is paid as tax that year (scheme pays is not modelled).",
  "Tax-free pension cash is the tax-free share you set on the account (usually 25%), limited by the £268,275 lump sum allowance; the lump sum and death benefit allowance, transitional protections and death benefits are not modelled.",
  "Lifetime ISA: the 25% bonus, the £4,000 limit from 18 to 49 and the 25% charge on withdrawals before 60 apply; the rule that the first payment must be made before 40 is not checked. The first-home exemption, the reduced 20% charge for first-time buyers of homes over £450,000 (from 29 October 2026) and the First Time Buyer ISA that replaces it for new savers from April 2029 are not modelled.",
  "National Insurance: Class 1 employee and Class 4 only; no voluntary Class 2 or Class 3, no employer NI, and NI is assessed on the year’s earnings rather than per pay period. From April 2029 salary-sacrificed pension contributions above £2,000 a year pay employee NI (announced; the detail is still to come in secondary legislation).",
  "Capital gains tax uses one basic and one higher rate for all assets; Business Asset Disposal Relief, investors’ relief, the announced founders’ relief and the 60-day property return are not modelled. A main home is fully exempt (private residence relief).",
  "Student loans: repayments are 9% (6% postgraduate) of earnings above the threshold, capped by the balance you enter; loan interest is ignored and the write-off applies only when you enter its year.",
  "High Income Child Benefit Charge applies only when the plan says Child Benefit is claimed, and falls on the partner with the higher adjusted net income.",
  "Scottish taxpayers: Scottish rates apply to non-savings income; savings, dividends and gains use UK rates (as the law does). Scottish starter and basic bands are indexed with prices and the higher and advanced thresholds stay frozen through 2027/28 (assumed; the Scottish Government sets them each year). Welsh rates are currently equal to the rest of the UK.",
  "Means-tested benefits (Universal Credit, Pension Credit) and the tax-free childcare scheme are not modelled.",
  "Inheritance tax is an estimate on the Estate page (nil-rate and residence bands, transfers, spouse and charity rules, pensions from April 2027); gift taper relief and business/agricultural relief are not modelled.",
  ENGINE_GAINS,
];

export const US_FEDERAL_SIMPLIFICATIONS: readonly string[] = [
  "Tax years 2026 and 2027 as published by the IRS (Rev. Proc. 2025-32 and 2026-35, as amended by OBBBA); later years index the 2027 figures with the plan threshold policy from the start of 2027. Statutory thresholds that are not indexed (net investment income tax, Additional Medicare Tax, Social Security benefit taxation, child tax credit phase-out) stay fixed.",
  "Itemised deductions are only what you enter as itemised; the SALT cap and its phase-down, the limit on itemised deductions for the 37% bracket, the 0.5%-of-AGI floor on charitable gifts and the charitable deduction for people who do not itemise (from 2026) are not applied automatically.",
  "AMT adds back the standard deduction and the senior deduction only; incentive stock options, state and local taxes and other preference items are not modelled.",
  "QBI deduction is simplified: 20% of self-employment income, treated as a specified service business (phased out above the threshold); W-2 wage and property limits and the $400 minimum deduction are not modelled.",
  "Credits: the child tax credit and the ACA premium tax credit only; no credit for other dependents, earned income credit, education credits, child and dependent care credit, saver’s credit, foreign tax credit or energy credits. Other credits can be entered as amounts.",
  "Social Security benefit taxation leaves tax-exempt interest out of provisional income, and treats a married person filing separately as having lived with their spouse (up to 85% taxable from the first dollar).",
  "Capital gains: long-term gains and qualified dividends use the 0%, 15% and 20% bands; the 25% rate on unrecaptured section 1250 gain and the 28% rate on collectibles are not modelled.",
  "IRMAA (Part B and Part D surcharges) is estimated from the MAGI of two years earlier, or the latest year available early in the plan, using the published 2026 and 2027 tiers, indexed after 2027 like other thresholds.",
  "ACA premium tax credit: you enter the benchmark (second-lowest-cost silver) premium; there is no credit below 100% or above 400% of the poverty line, and Medicaid eligibility is not modelled.",
  "Dependents count from the year they are born until they reach the “independent at” age you set for each one; the IRS qualifying-child and qualifying-relative tests (relationship, residence, support, the full-time student rule) are not checked. The child tax credit then applies its own under-17 test. An automatic ACA household size is the living adults on the return plus these dependents; Medicaid or CHIP coverage of a family member and dependents filing their own return are not modelled.",
  "Early-withdrawal penalties apply to accounts whose early-withdrawal setting is on (plus the HSA and 529 statutory penalties); 72(t) payments are penalty-free, other exceptions must be reflected in the account settings.",
  "Required minimum distributions use the Uniform Lifetime Table; the Joint Life table for a spouse more than 10 years younger, the still-working exception for workplace plans and the April 1 deferral of the first distribution are not modelled.",
  "Contribution limits are the IRS 2026 and 2027 figures, indexed from the plan start after 2027. On a joint return an IRA is capped by the couple's combined compensation less the other spouse's IRA contributions (spousal IRA); IRA contributions are made in flow order, so a spouse's IRA is only deducted from that cap once its flow has run. The traditional IRA deduction is phased out by MAGI for a person covered by a workplace plan, or whose spouse is (IRC 219(g), 2026 and 2027 IRS ranges, indexed after 2027); a person counts as covered in a year when money goes into their 401(k), 403(b), 401(a), TSP, SEP or SIMPLE account, so membership of a defined benefit pension alone is not seen, and spouses filing separately are assumed to have lived together. The nondeductible part stays in the IRA as basis that later withdrawals and conversions recover tax-free pro rata, per account rather than across all of the owner's IRAs. The income limit on Roth IRA contributions is not applied.",
  "The OBBBA deductions for qualified tips, overtime pay and car-loan interest are not modelled.",
  "No state and local taxes here (see the state and local entries), no kiddie tax and no estimated-tax underpayment penalties.",
  ENGINE_GAINS,
];

export const US_PAYROLL_SIMPLIFICATIONS: readonly string[] = [
  "Social Security wage base for 2026 ($184,500) and 2027 ($192,300); later years index the 2027 base with the plan threshold policy (the law indexes it with average wages, not prices).",
  "Employee FICA, Additional Medicare Tax and self-employment tax only; employer payroll taxes are not modelled. California SDI is charged with California state tax (1.3% of all wages in 2026, 1.4% in 2027); other states’ disability and family-leave payroll taxes (NJ, NY, WA, MA…) are not modelled.",
  "Pre-tax 401(k) deferrals do not reduce FICA wages (as the law says); cafeteria-plan (section 125) deductions that would are not modelled separately.",
  "Excess Social Security tax from multiple employers is not refunded: wages from several jobs are combined per person.",
];

export const US_STATE_SIMPLIFICATIONS: readonly string[] = [
  "Tax year 2026 rates and brackets for all 50 states and DC, checked against each state’s revenue department, statute or tax-year publication (2026-11-16 and 2026-11-19); figures a state has not published or that could not be confirmed are named below for that state. Later years index the 2026 figures with the plan threshold policy (many state amounts are fixed in law and do not change).",
  "Every state starts from federal AGI (states that start from federal taxable income use the federal deduction); state additions and subtractions other than those listed, itemised deductions, state AMT/minimum taxes and most income-tested phase-outs are not modelled.",
  "Retirement income: Social Security exemptions with their age and income tests, per-person and per-return pension and IRA exclusions (and, in Georgia and Delaware, the investment income they cover), their income tests and Social Security offsets, and age deductions are modelled where the state has them; exclusions for government or military pensions only are not. Roth conversions count as retirement income for state exclusions.",
  "State credits other than personal-exemption, age, Social Security and Connecticut’s personal tax credits are not modelled. Alabama’s and Missouri’s deductions for federal income tax are modelled; Oregon’s federal tax subtraction is not.",
  "Some states carry noted approximations (for example joint-return thresholds or the scope of a pension exclusion); check them before relying on the figure for a specific return.",
  "The household lives in one state for the whole year; part-year residence, multi-state wages and credits for tax paid to other states are not modelled.",
];

export const US_LOCAL_SIMPLIFICATIONS: readonly string[] = [
  "Only the city income taxes in the data table are modelled (New York City, Philadelphia, Wilmington, Detroit, Newark); county taxes, school-district taxes and payroll-based local taxes elsewhere are not.",
  "Philadelphia and Wilmington tax wages and self-employment income only; Detroit also taxes residents’ interest, dividends, gains and rent (not pensions or Social Security). Philadelphia’s School Income Tax on residents’ unearned income is not modelled, and its 2026 wage tax rate is the average of the rates before and after 1 July.",
  "City brackets are statutory and not indexed.",
];

export const CA_FEDERAL_SIMPLIFICATIONS: readonly string[] = [
  "Tax year 2026 (CRA, checked 2026-11-19). Later years index the 2026 amounts with the plan threshold policy; the only later change applied is the legislated base CPP rate of 4.75% from 2027 (Bill C-30). CRA’s published 2027 figures (YMPE 76,700, YAMPE 87,400, RRSP limit 35,390) are not used, and the TFSA limit is indexed smoothly rather than in $500 steps.",
  "Credits: basic personal (with the high-income reduction), age, pension income, Canada employment, CPP/QPP and EI and dividend tax credits only; no medical, disability, tuition, donation or caregiver credits (enter them as credits if you need them). Any tax-deferred withdrawal at 65 or older counts for the pension income amount, although in law an RRSP lump sum does not.",
  "AMT, the GIS and its clawback, the Canada Workers Benefit and the GST/HST credit are not modelled. OAS is reduced by the recovery tax in the same year (not with the one-year lag of real instalments).",
  "Pension income splitting is optimised in 5% steps over federal and provincial tax together. CPP contributions stop at 70; QPP contributions continue at the 2026 rate (QPP’s 2027 rate is not confirmed).",
  "Capital gains use the enacted 50% inclusion rate (the proposed two-thirds rate was cancelled in March 2025); the lifetime capital gains exemption and the principal residence designation details are not modelled (a main home is exempt).",
  "TFSA and FHSA withdrawals are tax-free; FHSA qualifying-home-purchase rules and TFSA room recapture are not tracked.",
  ENGINE_GAINS,
];

export const CA_PROVINCE_SIMPLIFICATIONS: readonly string[] = [
  "Tax year 2026 provincial and territorial brackets and amounts. Later years index them with the plan threshold policy, except Manitoba (indexation paused from 2025 with no end date) and British Columbia (paused 2027-2030), which keep their 2026 values during the pause.",
  "Ontario’s surtax (worked before the dividend tax credit) and Health Premium, Manitoba’s basic personal amount phase-out, Yukon’s federal-style basic amount and Saskatchewan’s senior supplementary amount are modelled; other provinces’ low-income reductions, surtaxes and refundable credits are not.",
  "Quebec: the federal abatement and QPP are applied, but the separate Quebec return’s age and pension amounts, QPIP premiums and the Quebec work premium are not modelled.",
  "Provincial dividend tax credit rates are CRA’s 2025 rates (the 2026 worksheets are not published yet). Provinces with an unconfirmed figure (Manitoba, Newfoundland and Labrador, Quebec) list it below.",
];

export const AU_SIMPLIFICATIONS: readonly string[] = [
  "Income years 2025-26 and 2026-27 and the legislated 2027-28 rates (Income Tax Rates Act 1986 as amended in 2024 and 2025). Rates and thresholds are not indexed in law, so they keep their legislated values through 2027-28; later years carry the 2027-28 rates forward and index thresholds with the plan threshold policy.",
  "Foreign-resident rates (no tax-free threshold, no LITO, no Medicare levy) apply only to Australian income of someone living in another country; working-holiday-maker rates are not modelled. The Age Pension is not modelled: enter it as income.",
  "Medicare levy uses the single low-income threshold (28,011 from 2025-26, Act No. 58 of 2026) for each person, or the seniors and pensioners threshold (44,268) from 67 without SAPTO’s other tests; family thresholds and the Medicare levy surcharge (private cover) are not modelled.",
  "Offsets: the low income tax offset and franking credits only (credits assume the 30% company rate, not the 25% base rate entity rate); SAPTO, the private health insurance rebate and HELP/HECS repayments are not modelled.",
  "Super: 15% contributions tax on concessional contributions, Division 293 and excess concessional contributions are modelled; carry-forward of unused concessional cap, the transfer balance cap, the non-concessional cap with its bring-forward and excess non-concessional tax, and Division 296 tax on earnings for total super balances over $3 million (law from 2026-27) are not. Caps for 2026-27: concessional 32,500 and non-concessional 130,000 (ATO, read 2026-11-22).",
  "Super benefits are tax-free from 60; below 60 the taxable component is taxed with the 15% offset (untaxed elements are not modelled). Pension-phase earnings are untaxed.",
  "Capital gains get the 50% discount (all gains are treated as held over 12 months); a main home is exempt.",
  ENGINE_GAINS,
];
