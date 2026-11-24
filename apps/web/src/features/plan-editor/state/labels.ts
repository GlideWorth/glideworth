/**
 * Human labels and contextual help for every schema enum the editors expose. Country-aware where
 * the vocabulary differs (a UK user sees "State Pension", "ISA", "SIPP" first).
 */

import {
  ACCOUNT_TYPE_INFO,
  type AccountCategory,
  type AccountType,
  type DrawdownCategory,
  type ExpenseType,
  type Frequency,
  type IncomeType,
  type MilestoneMetric,
} from "@glideworth/core";
import { groupedAccountTypes } from "../../../lib/countries";

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  once: "Once",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  semimonthly: "Twice a month",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannually: "Twice a year",
  yearly: "Yearly",
};
export const FREQUENCY_SHORT: Record<Frequency, string> = {
  once: "once",
  weekly: "/wk",
  biweekly: "/2wk",
  semimonthly: "/half-mo",
  monthly: "/mo",
  quarterly: "/qtr",
  semiannually: "/half-yr",
  yearly: "/yr",
};

/**
 * The unit after an event's amount ("/mo", "/yr"). An hourly wage's amount is per hour: the engine
 * pays rate × hours per week every week whatever `frequency` says.
 */
export function amountUnit(e: { type: string; frequency: Frequency }): string {
  return e.type === "hourly" ? "/hr" : e.frequency === "once" ? "" : FREQUENCY_SHORT[e.frequency];
}

export interface TypeMeta<T extends string> {
  value: T;
  label: string;
  hint: string;
  countries?: string[];
}

export const INCOME_TYPES: TypeMeta<IncomeType>[] = [
  {
    value: "salary",
    label: "Salary",
    hint: "Employment income; optional defined-benefit pension accrual.",
  },
  {
    value: "bonus",
    label: "Bonus",
    hint: "Irregular employment income: a fixed amount or a % of a salary.",
  },
  { value: "self-employment", label: "Self-employment", hint: "Sole trader or contractor profit." },
  {
    value: "state-pension",
    label: "State Pension",
    hint: "Government retirement pension (e.g. UK new State Pension).",
    countries: ["GB", "IE", "AU", "NZ", "DE", "NL", "FR", "ES", "IL", "AE", "XX"],
  },
  {
    value: "pension",
    label: "Pension income",
    hint: "A defined-benefit or final-salary pension in payment.",
  },
  { value: "annuity", label: "Annuity", hint: "Guaranteed income bought with a lump sum." },
  { value: "hourly", label: "Hourly wage", hint: "Hourly rate × hours per week." },
  { value: "rsu", label: "Share awards (RSU)", hint: "Vesting schedule of company shares." },
  { value: "inheritance", label: "Inheritance", hint: "Usually a one-off amount." },
  {
    value: "windfall",
    label: "Windfall",
    hint: "Any other one-off receipt: a sale, a gift, a prize.",
  },
  {
    value: "social-security",
    label: "Social Security",
    hint: "US retirement benefit (amount or PIA estimate).",
    countries: ["US"],
  },
  { value: "ca-cpp", label: "CPP / QPP", hint: "Canada Pension Plan.", countries: ["CA"] },
  {
    value: "ca-oas",
    label: "Old Age Security",
    hint: "Canadian OAS, subject to clawback.",
    countries: ["CA"],
  },
  { value: "ca-gis", label: "GIS", hint: "Guaranteed Income Supplement.", countries: ["CA"] },
  {
    value: "other",
    label: "Other income",
    hint: "Anything else: maintenance, rental outside a property, etc.",
  },
];

export const EXPENSE_TYPES: TypeMeta<ExpenseType>[] = [
  {
    value: "living",
    label: "Living expenses",
    hint: "Day-to-day spending: food, bills, everything routine.",
  },
  {
    value: "housing",
    label: "Housing / rent",
    hint: "Rent or housing costs not modelled on a property.",
  },
  {
    value: "healthcare",
    label: "Healthcare",
    hint: "Insurance, care and medical costs. Grows faster than inflation by default.",
  },
  {
    value: "long-term-care",
    label: "Long-term care",
    hint: "Care home, home care or nursing later in life. Grows like healthcare by default.",
  },
  { value: "childcare", label: "Childcare", hint: "Nursery, childminders, after-school care." },
  { value: "education", label: "Education", hint: "School or university fees." },
  {
    value: "dependent-support",
    label: "Support for dependants",
    hint: "Money for children or relatives.",
  },
  { value: "travel", label: "Travel", hint: "Holidays. Discretionary by default." },
  {
    value: "transportation",
    label: "Transport",
    hint: "Cars, fuel, season tickets, replacement vehicles.",
  },
  { value: "insurance", label: "Insurance", hint: "Life, income-protection and other premiums." },
  { value: "entertainment", label: "Leisure", hint: "Hobbies, eating out, subscriptions." },
  { value: "personal", label: "Personal", hint: "Clothing, gifts, personal care." },
  { value: "pets", label: "Pets", hint: "" },
  { value: "wedding", label: "Wedding", hint: "A one-off celebration." },
  { value: "charity", label: "Charity", hint: "Giving, including Gift Aid / QCD / DAF vehicles." },
  { value: "tax-payment", label: "Tax payment", hint: "A known tax bill outside the tax model." },
  {
    value: "tax-deduction",
    label: "Tax deduction / credit",
    hint: "Reduces taxable income or tax due.",
  },
  { value: "other", label: "Other expense", hint: "" },
];

export const ACCOUNT_CATEGORY_LABEL: Record<AccountCategory, string> = {
  cash: "Cash & savings",
  investment: "Investments",
  retirement: "Pensions & retirement",
  education: "Education",
  health: "Health",
  other: "Other",
};

export const DRAWDOWN_LABEL: Record<DrawdownCategory, string> = {
  cash: "Cash",
  taxable: "Taxable investments",
  crypto: "Crypto",
  "tax-deferred": "Pensions / tax-deferred",
  "tax-free": "Tax-free (ISA, Roth…)",
  hsa: "Health (HSA)",
  education: "Education",
  "real-assets": "Property & possessions",
};

export const DRAWDOWN_HINT: Record<DrawdownCategory, string> = {
  cash: "Current and savings accounts.",
  taxable: "Gains are taxed when you sell (GIA, brokerage).",
  crypto: "Taxed like taxable investments.",
  "tax-deferred": "Taxed as income when withdrawn (SIPP, workplace pension, 401k, RRSP).",
  "tax-free": "No tax on withdrawals (ISA, Roth, TFSA).",
  hsa: "Tax-free for qualified medical use.",
  education: "For qualified education costs.",
  "real-assets": "Only assets marked “sell if needed”.",
};

export function accountTypeLabel(t: AccountType): string {
  return ACCOUNT_TYPE_INFO[t].label;
}

/**
 * Account types grouped for pickers: the household's country first, then every other supported
 * country, then the types that work anywhere (lib/countries).
 */
export function accountTypeGroups(country: string): { label: string; types: AccountType[] }[] {
  const groups = groupedAccountTypes(country).map((g) => ({
    label: g.group,
    types: g.types,
    country: g.country,
  }));
  const home = groups.filter((g) => g.country === country);
  const anywhere = groups.filter((g) => g.country === null);
  const rest = groups.filter((g) => g.country !== country && g.country !== null);
  return [...home, ...anywhere, ...rest].map(({ label, types }) => ({ label, types }));
}

export const ACCOUNT_TYPE_HINT: Partial<Record<AccountType, string>> = {
  "uk-isa": "Stocks & shares or cash ISA. Tax-free growth and withdrawals.",
  "uk-lisa":
    "Lifetime ISA: 25% government bonus; 25% penalty if withdrawn before 60 (except first home).",
  "uk-sipp": "Self-invested personal pension. Accessible from 57; 25% tax-free.",
  "uk-workplace-pension": "Defined-contribution workplace scheme.",
  "uk-pension": "Any other UK defined-contribution pension pot.",
  "uk-gia": "General investment account: gains and dividends are taxable.",
  taxable: "Taxable brokerage (non-UK).",
  savings: "Easy-access or fixed savings.",
  cash: "Current account / cash.",
  crypto: "Crypto holdings; returns modelled separately.",
  "de-bav": "Occupational pension: contributions from gross pay, taxed on payout (from 62).",
  "de-riester": "State-subsidised pension with allowances; taxed on payout.",
  "de-ruerup":
    "Basisrente: deductible contributions, annuity-only payout taxed on the Besteuerungsanteil.",
  "nl-pension": "Pension or lijfrente: contributions deductible in box 1, payouts taxed in box 1.",
  "fr-pea":
    "Plan d'épargne en actions: gains free of income tax after 5 years (prélèvements sociaux still due).",
  "fr-assurance-vie":
    "Life-insurance wrapper: gains taxed on withdrawal with an allowance after 8 years.",
  "fr-per": "Plan d'épargne retraite: deductible contributions, taxed on payout.",
  "es-plan-pensiones":
    "Pension plan: contributions reduce the general base (capped), payouts taxed as work income.",
  "il-pension": "Israeli pension fund (kupat gemel): payouts from 67.",
  "il-keren-hishtalmut": "Study fund: tax-free after six years, within the contribution ceiling.",
  "ie-pension":
    "Occupational pension or PRSA: age-related relief on contributions, 25% tax-free lump sum.",
  "nz-kiwisaver":
    "KiwiSaver: employer and government contributions; locked until 65 (first-home exception).",
  "ae-dews":
    "DIFC Employee Workplace Savings: employer contributions replace the end-of-service gratuity. Untaxed in the UAE; if you live elsewhere, your country may tax its earnings.",
  "ae-savings-scheme":
    "An employer end-of-service savings scheme (instead of the gratuity). Untaxed in the UAE; if you live elsewhere, your country may tax its earnings.",
};

export const REAL_ASSET_TYPES_LABEL: Record<string, string> = {
  house: "Home",
  car: "Car",
  "rental-property": "Rental property",
  "commercial-property": "Commercial property",
  land: "Land",
  building: "Building",
  motorcycle: "Motorbike",
  boat: "Boat",
  jewelry: "Jewellery",
  "precious-metals": "Precious metals",
  furniture: "Furniture",
  instrument: "Instrument",
  machinery: "Machinery",
  collectible: "Collectible",
  business: "Business",
  custom: "Other asset",
};

export const DEBT_TYPES_LABEL: Record<string, string> = {
  "credit-card": "Credit card",
  "student-loan": "Student loan",
  "auto-loan": "Car finance",
  "personal-loan": "Personal loan",
  heloc: "Home equity line",
  medical: "Medical debt",
  "tax-debt": "Tax owed",
  debt: "Loan",
  other: "Other debt",
};

export const METRIC_LABEL: Record<MilestoneMetric["kind"], string> = {
  netWorth: "Net worth",
  liquidNetWorth: "Liquid net worth",
  portfolio: "Investments",
  cash: "Cash",
  accountBalance: "Account balance",
  totalDebt: "Total debt",
  debtBalance: "Debt balance",
  loanBalance: "Loan on asset",
  passiveIncome: "Passive income",
  income: "Income",
  spending: "Spending",
  expenses: "Expenses",
};

export const MILESTONE_KIND_LABEL: Record<string, string> = {
  retirement: "Retirement",
  "life-expectancy": "Life expectancy",
  "financial-independence": "Financial independence",
  "coast-fi": "Coast FI",
  "lean-fi": "Lean FI",
  "fat-fi": "Fat FI",
  "barista-fi": "Barista FI",
  "debt-free": "Debt free",
  move: "Move house",
  custom: "Custom",
};

/** Contextual help for non-obvious fields, keyed by a stable id used across editors. */
export const HELP = {
  basis:
    "“Today” amounts are in today's money and rise with inflation automatically. “Future” amounts are exactly what you'll see on the day.",
  growFromToday:
    "On: the amount you enter is today’s value and grows from now even if the event starts later. Off: it starts at exactly this amount.",
  change: "How the amount evolves each year after it starts.",
  frequency: "How often this amount is paid. Yearly totals are computed for you.",
  endExclusive:
    "The event stops at the start of this month. Tick “through” to include the end month.",
  spendingType:
    "Essential spending is protected in a shortfall; discretionary is cut first. “Not spending” keeps it out of spending metrics (e.g. business costs).",
  taxCharacter:
    "How tax treats this income. “Auto” lets the tax model decide from the income type.",
  withholding:
    "Tax deducted at source (PAYE). Affects cash-flow timing only, not the total tax due.",
  sendTo:
    "By default income joins the cash pool and is routed by your Flows. Choose accounts to deposit directly.",
  payFrom:
    "By default expenses are paid from this year’s income, then the drawdown order. Pick accounts to pay directly (first listed first).",
  partTime: "Scale this income down for part of its range, e.g. 60% for a four-day week.",
  costBasis:
    "What you paid for the holdings. Gains above it are taxable when you sell. Can exceed the balance.",
  contributionBasis: "Total contributions so far. These can be withdrawn without tax or penalty.",
  qualifiedAge:
    "Age from which withdrawals are allowed without penalty (UK pensions: 57 from 2028).",
  liquid: "Whether the balance counts towards liquid net worth.",
  ufpls:
    "UFPLS: 25% of each withdrawal is tax-free. PCLS: take the 25% tax-free lump sum up front, the rest is taxed.",
  monteCarloTreatment:
    "“Auto” varies this account in Chance of Success trials; “Fixed” keeps its override rate.",
  excessCash: "Drawn first in a shortfall, before the normal drawdown order.",
  mandatoryFlow:
    "Always fund: takes priority and draws from other accounts when income alone can’t cover it.",
  leftover: "What happens to any surplus after every flow has been funded.",
  drawdownOrder: "When spending exceeds income, accounts are drawn in this order.",
  glidePath:
    "Bond share of the portfolio over time. Points are interpolated between ages or dates.",
  appreciation: "Yearly change in value. Cars depreciate; property usually tracks inflation.",
  liquidate: "Sell automatically if the plan runs short, at its position in the drawdown order.",
  milestoneCombinator: "“All” waits for every condition; “Any” fires at the first one met.",
  metricMultiple:
    "e.g. 25× annual spending is the classic financial-independence target (a 4% withdrawal rate).",
  before:
    "“Before” conditions are true from the plan start until that point, so pair them with another condition.",
  offset: "Shift the date by whole months: −6 means six months earlier.",
  yearAlignment: "Which 12-month window each simulated year covers. UK tax years start in April.",
  taxMode:
    "Estimate: full tax model for your location. Flat: one effective rate per income type. Custom: your own brackets.",
  seed: "A fixed seed makes Chance of Success reproducible run to run.",
  withdrawalStrategy:
    "Textbook strategies override normal spending from a start date. Use them for comparison, not as a plan.",
  flex: "Cut flexible spending when markets fall from their all-time high.",
} as const;
