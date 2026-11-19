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
  "Tax year 2026 (as amended by OBBBA); later years index the 2026 brackets with the plan threshold policy. Statutory unindexed thresholds (NIIT, Social Security taxation) stay fixed.",
  "Itemised deductions are only what you enter as itemised; the SALT cap and the phase-outs of individual itemised deductions are not applied automatically.",
  "AMT adds back only the standard deduction; incentive stock options and other preference items are not modelled.",
  "QBI deduction is simplified: 20% of self-employment income, treated as a specified service business (phased out above the threshold); W-2 wage and property limits are not modelled.",
  "Credits: the child tax credit and the ACA premium tax credit only; no earned income credit, education credits, child and dependent care credit, saver’s credit, foreign tax credit or energy credits. Other credits can be entered as amounts.",
  "IRMAA (Part B and Part D surcharges) is estimated from the MAGI of two years earlier, or the latest year available early in the plan, using the 2026 tiers indexed like other thresholds.",
  "Early-withdrawal penalties apply to accounts whose early-withdrawal setting is on (plus the HSA and 529 statutory penalties); 72(t) payments are penalty-free, other exceptions must be reflected in the account settings.",
  "The OBBBA deductions for qualified tips, overtime pay and car-loan interest are not modelled.",
  "No state and local taxes here (see the state and local entries), no kiddie tax and no estimated-tax underpayment penalties.",
  ENGINE_GAINS,
];

export const US_PAYROLL_SIMPLIFICATIONS: readonly string[] = [
  "Tax year 2026 wage base, indexed in later years with the plan threshold policy.",
  "Employee FICA, Additional Medicare Tax and self-employment tax only; employer payroll taxes are not modelled. California SDI is charged with California state tax (1.3% of all wages in 2026); other states’ disability and family-leave payroll taxes (NJ, NY, WA, MA…) are not modelled.",
  "Pre-tax 401(k) deferrals do not reduce FICA wages (as the law says); cafeteria-plan (section 125) deductions that would are not modelled separately.",
  "Excess Social Security tax from multiple employers is not refunded: wages from several jobs are combined per person.",
];

export const US_STATE_SIMPLIFICATIONS: readonly string[] = [
  "Tax year 2026 rates and brackets for all 50 states and DC, checked against each state’s revenue department, statute or tax-year publication (2026-11-16); figures a state’s site would not let us confirm are named below for that state. Later years index with the plan threshold policy.",
  "Every state starts from federal AGI; state additions and subtractions, itemised deductions, state AMT/minimum taxes and income-tested phase-outs are not modelled.",
  "State credits other than personal-exemption credits are not modelled; retirement exclusions are included only where they are a simple per-person amount by age.",
  "Some states carry noted approximations (for example MFJ thresholds or pension exclusions); check them before relying on the figure for a specific return.",
  "Residency is the household’s state for the whole year; part-year residence, multi-state wages and credits for tax paid to other states are not modelled (a relocation milestone switches state from the next period).",
];

export const US_LOCAL_SIMPLIFICATIONS: readonly string[] = [
  "Only the city income taxes in the data table are modelled (New York City, Philadelphia, Wilmington, Detroit, Newark); county taxes, school-district taxes and payroll-based local taxes elsewhere are not.",
  "Philadelphia, Wilmington and Detroit tax wages and self-employment income only; Detroit’s tax on residents’ other income and Philadelphia’s School Income Tax on unearned income are not modelled. Philadelphia’s 2026 rate is the average of the rates before and after 1 July.",
  "City brackets are statutory and not indexed.",
];

export const CA_FEDERAL_SIMPLIFICATIONS: readonly string[] = [
  "Tax year 2026; later years index with the plan threshold policy.",
  "Credits: basic personal (with the high-income reduction), age, pension income, Canada employment, CPP/QPP and EI and dividend tax credits only; no medical, disability, tuition, donation or caregiver credits (enter them as credits if you need them).",
  "AMT, the GIS and its clawback, the Canada Workers Benefit and the GST/HST credit are not modelled. OAS is reduced by the recovery tax in the same year (not with the one-year lag of real instalments).",
  "Pension income splitting is optimised in 5% steps over federal and provincial tax together.",
  "Capital gains use the 50% inclusion rate; the lifetime capital gains exemption and the principal residence designation details are not modelled (a main home is exempt).",
  "TFSA and FHSA withdrawals are tax-free; FHSA qualifying-home-purchase rules and TFSA room recapture are not tracked.",
  ENGINE_GAINS,
];

export const CA_PROVINCE_SIMPLIFICATIONS: readonly string[] = [
  "Tax year 2026 provincial and territorial brackets and basic amounts; later years index with the plan threshold policy.",
  "Ontario surtax and health premium are modelled; other provinces’ low-income reductions, surtaxes and refundable credits are not.",
  "Quebec: the federal abatement and QPP are applied, but the separate Quebec return’s age and pension amounts, QPIP premiums and the Quebec work premium are not modelled.",
  "Some provinces carry noted approximations (for example the BPA phase-out); check them before relying on the figure.",
];

export const AU_SIMPLIFICATIONS: readonly string[] = [
  "Income years 2025-26 and 2026-27 with the legislated 2027-28 rates; later years carry the last rates forward and index thresholds with the plan threshold policy.",
  "Residents only; non-resident and working-holiday rates are not modelled.",
  "Medicare levy uses the single low-income threshold for each person (the seniors and pensioners threshold from 67); family thresholds and the Medicare levy surcharge (private cover) are not modelled. The thresholds are the 2024-25 values for every year: the 2.9% increase from 1 July 2025 announced in the 2026-27 Budget is not applied and 2026-27 thresholds have not been published.",
  "Offsets: the low income tax offset and franking credits only; SAPTO, the private health insurance rebate and HELP/HECS repayments are not modelled.",
  "Super: 15% contributions tax on concessional contributions, Division 293 and excess concessional contributions are modelled; carry-forward of unused concessional cap, the transfer balance cap and excess non-concessional tax are not.",
  "Super benefits are tax-free from 60; below 60 the taxable component is taxed with the 15% offset (untaxed elements are not modelled). Pension-phase earnings are untaxed.",
  "Capital gains get the 50% discount (all gains are treated as held over 12 months); a main home is exempt.",
  ENGINE_GAINS,
];
