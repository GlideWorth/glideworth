/**
 * SYNTHETIC sample data. Every name and number here is invented. It mirrors the STRUCTURE of real
 * exports (accounts, assets, debts, plans, events, milestones, flows) for tests, demos, API seed
 * and the web app's first-run experience. Never copy real user data into this file.
 */
import { planDefaultsForHousehold } from "../defaults/country.js";
import {
  GlideworthDocument,
  type GlideworthDocumentInput,
  SCHEMA_VERSION,
} from "../schema/document.js";
import type { HouseholdInput } from "../schema/household.js";
import type { PlanInput } from "../schema/plan.js";

const HOUSEHOLD_ID = "hh-sample";
const AVERY = "p-avery";
const JORDAN = "p-jordan";

const ret = (personId: string, age: number) => ({
  id: "ms-retire",
  name: "Retirement",
  kind: "retirement" as const,
  personId,
  builtIn: true,
  criteria: [{ kind: "age" as const, personId, age }],
});

const lifeExpectancy = (id: string, personId: string, age: number) => ({
  id,
  name: personId === AVERY ? "Avery life expectancy" : "Jordan life expectancy",
  kind: "life-expectancy" as const,
  personId,
  builtIn: true,
  criteria: [{ kind: "age" as const, personId, age }],
});

function basePlan(id: string, name: string, retireAge: number, isMain: boolean): PlanInput {
  return {
    id,
    householdId: HOUSEHOLD_ID,
    name,
    isMain,
    description: isMain
      ? "Baseline: both work until Avery turns 57."
      : `What if Avery retires at ${retireAge}?`,
    milestones: [
      ret(AVERY, retireAge),
      lifeExpectancy("ms-le-avery", AVERY, 92),
      lifeExpectancy("ms-le-jordan", JORDAN, 94),
      {
        id: "ms-fi",
        name: "Financial independence",
        kind: "financial-independence",
        criteria: [
          {
            kind: "metric",
            metric: { kind: "liquidNetWorth" },
            comparator: ">=",
            threshold: { kind: "multipleOf", multiple: 25, of: "spending", measurement: "current" },
          },
        ],
      },
      {
        id: "ms-mortgage-free",
        name: "Mortgage paid off",
        kind: "debt-free",
        criteria: [
          {
            kind: "metric",
            metric: { kind: "loanBalance", assetId: "ra-home" },
            comparator: "<=",
            threshold: { kind: "amount", amount: { value: 0, basis: "nominal" } },
          },
        ],
      },
    ],
    income: [
      {
        id: "inc-avery-salary",
        type: "salary",
        name: "Avery salary",
        owner: AVERY,
        amount: { value: 132_000, basis: "real" },
        frequency: "yearly",
        range: {
          start: { kind: "planStart" },
          end: { kind: "milestone", milestoneId: "ms-retire" },
        },
        change: { kind: "inflation", plus: 0.01 },
      },
      {
        id: "inc-jordan-salary",
        type: "salary",
        name: "Jordan salary",
        owner: JORDAN,
        amount: { value: 7_400, basis: "real" },
        frequency: "monthly",
        range: {
          start: { kind: "planStart" },
          end: { kind: "milestone", milestoneId: "ms-retire" },
        },
        partTime: {
          range: {
            start: { kind: "age", personId: JORDAN, age: 45 },
            end: { kind: "milestone", milestoneId: "ms-retire" },
          },
          share: 0.6,
        },
      },
      {
        id: "inc-avery-benefit",
        type: "social-security",
        name: "Avery state benefit",
        owner: AVERY,
        amount: { value: 2_300, basis: "real" },
        frequency: "monthly",
        range: { start: { kind: "age", personId: AVERY, age: 67 }, end: { kind: "planEnd" } },
      },
      {
        id: "inc-jordan-benefit",
        type: "social-security",
        name: "Jordan state benefit",
        owner: JORDAN,
        amount: { value: 1_700, basis: "real" },
        frequency: "monthly",
        range: { start: { kind: "age", personId: JORDAN, age: 67 }, end: { kind: "planEnd" } },
      },
    ],
    expenses: [
      {
        id: "exp-living",
        type: "living",
        name: "Living expenses",
        owner: "joint",
        amount: { value: 5_200, basis: "real" },
        frequency: "monthly",
        range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
        spendingType: "essential",
      },
      {
        id: "exp-travel",
        type: "travel",
        name: "Travel",
        owner: "joint",
        amount: { value: 9_000, basis: "real" },
        frequency: "yearly",
        range: { start: { kind: "planStart" }, end: { kind: "age", personId: AVERY, age: 80 } },
        spendingType: "discretionary",
      },
      {
        id: "exp-health",
        type: "healthcare",
        name: "Healthcare",
        owner: "joint",
        amount: { value: 6_000, basis: "real" },
        frequency: "yearly",
        range: { start: { kind: "milestone", milestoneId: "ms-retire" }, end: { kind: "planEnd" } },
        change: { kind: "inflation", plus: 0.02 },
      },
      {
        id: "exp-car",
        type: "transportation",
        name: "Replacement car",
        owner: "joint",
        amount: { value: 32_000, basis: "real" },
        frequency: "once",
        range: { start: { kind: "date", date: "2031-06" }, end: { kind: "never" } },
        spendingType: "hybrid",
        discretionaryShare: 0.4,
      },
    ],
    flows: [
      {
        kind: "contribution",
        id: "fl-401k",
        name: "Workplace retirement",
        owner: AVERY,
        accountId: "acc-avery-401k",
        range: {
          start: { kind: "planStart" },
          end: { kind: "milestone", milestoneId: "ms-retire" },
        },
        method: { kind: "amount", amount: { value: 23_000, basis: "real" }, frequency: "yearly" },
        mandatory: true,
      },
      {
        kind: "contribution",
        id: "fl-roth",
        name: "Roth IRA",
        owner: JORDAN,
        accountId: "acc-jordan-roth",
        range: {
          start: { kind: "planStart" },
          end: { kind: "milestone", milestoneId: "ms-retire" },
        },
        method: { kind: "amount", amount: { value: 7_000, basis: "real" }, frequency: "yearly" },
      },
      {
        kind: "contribution",
        id: "fl-emergency",
        name: "Emergency fund to 6 months",
        owner: "joint",
        accountId: "acc-cash",
        range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
        strategy: { kind: "target", target: { value: 36_000, basis: "real" } },
        method: { kind: "max" },
      },
      {
        kind: "contribution",
        id: "fl-taxable",
        name: "Invest the rest",
        owner: "joint",
        accountId: "acc-brokerage",
        range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
        method: { kind: "percentOfRemaining", share: 1 },
      },
    ],
    leftover: { kind: "save", accountId: "acc-cash" },
    tax: {
      mode: "flat",
      filingStatus: "married-joint",
      flat: { ordinary: 0.24, capitalGains: 0.15, dividends: 0.15, local: 0.04 },
    },
    assumptions: {
      inflation: { kind: "fixed", rate: 0.025 },
      stockReturn: { kind: "fixed", rate: 0.06 },
      dividendYield: { kind: "fixed", rate: 0.015 },
      bondAllocation: { kind: "fixed", share: 0.3 },
    },
  };
}

const sampleInput: GlideworthDocumentInput = {
  app: "glideworth",
  schemaVersion: SCHEMA_VERSION,
  household: {
    id: HOUSEHOLD_ID,
    name: "Avery & Jordan (sample)",
    planningMode: "couple",
    people: [
      { id: AVERY, name: "Avery", role: "primary", birthMonth: "1984-03" },
      { id: JORDAN, name: "Jordan", role: "partner", birthMonth: "1986-10" },
    ],
    dependents: [{ id: "dep-robin", name: "Robin", birthMonth: "2017-05" }],
    location: { country: "US", region: "CO" },
    currency: "USD",
    locale: "en-US",
  },
  finances: {
    asOf: "2026-11",
    accounts: [
      {
        id: "acc-cash",
        name: "High-yield savings",
        type: "savings",
        owner: "joint",
        balance: 28_500,
      },
      {
        id: "acc-brokerage",
        name: "Joint brokerage",
        type: "taxable",
        owner: "joint",
        balance: 164_000,
        costBasis: 118_000,
      },
      {
        id: "acc-avery-401k",
        name: "Avery 401(k)",
        type: "401k",
        owner: AVERY,
        balance: 286_000,
        behaviour: { earlyWithdrawal: { enabled: true, qualifiedAge: 59.5, penaltyRate: 0.1 } },
      },
      {
        id: "acc-jordan-roth",
        name: "Jordan Roth IRA",
        type: "roth-ira",
        owner: JORDAN,
        balance: 71_000,
        contributionBasis: 52_000,
        behaviour: { earlyWithdrawal: { enabled: true, qualifiedAge: 59.5, penaltyRate: 0.1 } },
      },
      { id: "acc-hsa", name: "Family HSA", type: "hsa", owner: AVERY, balance: 14_200 },
    ],
    realAssets: [
      {
        id: "ra-home",
        name: "Home",
        type: "house",
        owner: "joint",
        currentValue: 585_000,
        purchasePrice: 470_000,
        loan: {
          id: "loan-home",
          balance: 342_000,
          interest: { apr: 0.0575, method: "compound", compounding: "monthly" },
          monthlyPayment: { value: 2_480, basis: "nominal" },
        },
        behaviour: {
          usage: "primary-residence",
          appreciation: { kind: "inflation", plus: 0.005 },
          propertyTax: { cost: { kind: "percentOfValue", rate: 0.0055 } },
          maintenance: { kind: "percentOfValue", rate: 0.008 },
          insurance: { kind: "amountPerYear", amount: { value: 2_100, basis: "real" } },
          // Last resort: sell the home if the accounts run out late in life.
          liquidateIfNeeded: true,
        },
      },
    ],
    debts: [
      {
        id: "debt-car",
        name: "Car loan",
        type: "auto-loan",
        owner: AVERY,
        balance: 12_600,
        interest: { apr: 0.064, method: "compound", compounding: "monthly" },
        monthlyPayment: { value: 410, basis: "nominal" },
      },
    ],
  },
  plans: [
    basePlan("plan-main", "Main plan", 57, true),
    basePlan("plan-early", "Retire at 52", 52, false),
  ],
  progress: [
    {
      id: "snap-1",
      householdId: HOUSEHOLD_ID,
      date: "2025-11-01",
      source: "manual",
      netWorth: 612_000,
      assets: 1_002_000,
      liabilities: 390_000,
    },
    {
      id: "snap-2",
      householdId: HOUSEHOLD_ID,
      date: "2026-05-01",
      source: "manual",
      netWorth: 690_000,
      assets: 1_062_000,
      liabilities: 372_000,
    },
  ],
  settings: { theme: "system", valueBasis: "real" },
};

/** A fresh, parsed copy of the synthetic sample document. */
export function createSampleDocument(): GlideworthDocument {
  return GlideworthDocument.parse(structuredClone(sampleInput));
}

export const SAMPLE_PLAN_ID = "plan-main";

// ---------------------------------------------------------------------------------------------
// UK single-person sample (SYNTHETIC). GBP; savings, ISA, GIA, crypto, SIPP and a workplace
// pension; salary until 60, then drawdown with UFPLS; State Pension from 67 with the triple lock.
// ---------------------------------------------------------------------------------------------

const UK_HOUSEHOLD_ID = "hh-uk-sample";
const SAM = "p-sam";

const ukHousehold = {
  id: UK_HOUSEHOLD_ID,
  name: "Sam (UK sample)",
  planningMode: "individual",
  people: [{ id: SAM, name: "Sam", role: "primary", birthMonth: "1978-06" }],
  location: { country: "GB", region: "ENG" },
  currency: "GBP",
  locale: "en-GB",
} satisfies HouseholdInput;

/**
 * Country defaults (`defaultsForCountry`): UK tax rules in estimate mode, the UK tax year (April
 * alignment) and the country's default market history for chance-of-success runs (US 1928-2025 in
 * real terms; see `defaultsForCountry` for why UK plans do not default to the short UK 1983-2025 set).
 */
const ukDefaults = planDefaultsForHousehold(ukHousehold);

const ukSampleInput: GlideworthDocumentInput = {
  app: "glideworth",
  schemaVersion: SCHEMA_VERSION,
  household: ukHousehold,
  finances: {
    asOf: "2026-11",
    accounts: [
      { id: "uk-cash", name: "Easy-access savings", type: "savings", owner: SAM, balance: 18_000 },
      { id: "uk-isa", name: "Stocks & shares ISA", type: "uk-isa", owner: SAM, balance: 64_000 },
      {
        id: "uk-gia",
        name: "General investment account",
        type: "uk-gia",
        owner: SAM,
        balance: 22_000,
        costBasis: 15_000,
      },
      {
        id: "uk-crypto",
        name: "Crypto",
        type: "crypto",
        owner: SAM,
        balance: 4_000,
        costBasis: 3_000,
      },
      { id: "uk-sipp", name: "SIPP", type: "uk-sipp", owner: SAM, balance: 95_000 },
      {
        id: "uk-workplace",
        name: "Workplace pension",
        type: "uk-workplace-pension",
        owner: SAM,
        balance: 48_000,
      },
    ],
  },
  plans: [
    {
      id: "uk-plan-main",
      householdId: UK_HOUSEHOLD_ID,
      name: "Retire at 60",
      isMain: true,
      milestones: [
        {
          id: "uk-retire",
          name: "Retirement",
          kind: "retirement",
          personId: SAM,
          builtIn: true,
          criteria: [{ kind: "age", personId: SAM, age: 60 }],
        },
        {
          id: "uk-le",
          name: "Life expectancy",
          kind: "life-expectancy",
          personId: SAM,
          builtIn: true,
          criteria: [{ kind: "age", personId: SAM, age: 92 }],
        },
      ],
      income: [
        {
          id: "uk-salary",
          type: "salary",
          name: "Salary",
          owner: SAM,
          amount: { value: 58_000, basis: "real" },
          frequency: "yearly",
          range: {
            start: { kind: "planStart" },
            end: { kind: "milestone", milestoneId: "uk-retire" },
          },
          change: { kind: "inflation", plus: 0.005 },
        },
        {
          id: "uk-state-pension",
          type: "state-pension",
          name: "State Pension",
          owner: SAM,
          country: "GB",
          amount: { value: 11_973, basis: "real" },
          frequency: "yearly",
          // Born June 1978: State Pension age 68 under the Pensions Act 2007 (ukStatePensionAge).
          range: { start: { kind: "age", personId: SAM, age: 68 }, end: { kind: "planEnd" } },
          tripleLock: { earningsPremium: 0.01, floor: 0.025 },
        },
      ],
      expenses: [
        {
          id: "uk-living",
          type: "living",
          name: "Living costs",
          owner: SAM,
          amount: { value: 2_300, basis: "real" },
          frequency: "monthly",
          range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
        },
        {
          id: "uk-travel",
          type: "travel",
          name: "Travel",
          owner: SAM,
          amount: { value: 4_000, basis: "real" },
          frequency: "yearly",
          range: { start: { kind: "planStart" }, end: { kind: "age", personId: SAM, age: 80 } },
          spendingType: "discretionary",
        },
      ],
      flows: [
        {
          kind: "contribution",
          id: "uk-fl-workplace",
          name: "Workplace pension (5% + 5% match)",
          owner: SAM,
          accountId: "uk-workplace",
          range: {
            start: { kind: "planStart" },
            end: { kind: "milestone", milestoneId: "uk-retire" },
          },
          method: { kind: "percentOfIncome", incomeId: "uk-salary", share: 0.05 },
          employer: { incomeId: "uk-salary", matchShare: 1, upToShareOfPay: 0.05 },
          limit: { kind: "jurisdiction" },
          mandatory: true,
        },
        {
          kind: "contribution",
          id: "uk-fl-emergency",
          name: "Emergency fund",
          owner: SAM,
          accountId: "uk-cash",
          range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
          strategy: { kind: "target", target: { value: 15_000, basis: "real" } },
          method: { kind: "max" },
        },
        {
          kind: "contribution",
          id: "uk-fl-isa",
          name: "ISA allowance",
          owner: SAM,
          accountId: "uk-isa",
          range: {
            start: { kind: "planStart" },
            end: { kind: "milestone", milestoneId: "uk-retire" },
          },
          method: { kind: "max" },
          limit: { kind: "jurisdiction" },
        },
        {
          kind: "contribution",
          id: "uk-fl-sipp",
          name: "SIPP top-up",
          owner: SAM,
          accountId: "uk-sipp",
          range: {
            start: { kind: "planStart" },
            end: { kind: "milestone", milestoneId: "uk-retire" },
          },
          method: { kind: "percentOfRemaining", share: 1 },
          limit: { kind: "jurisdiction" },
        },
      ],
      leftover: { kind: "save", accountId: "uk-cash" },
      drawdown: {
        order: [
          { kind: "category", category: "cash" },
          { kind: "category", category: "taxable" },
          { kind: "category", category: "crypto" },
          { kind: "category", category: "tax-deferred" },
          { kind: "category", category: "tax-free" },
        ],
        cashBuffer: { value: 10_000, basis: "real" },
      },
      tax: ukDefaults.tax,
      monteCarlo: ukDefaults.monteCarlo,
      assumptions: {
        ...ukDefaults.assumptions,
        inflation: { kind: "fixed", rate: 0.025 },
        stockReturn: { kind: "fixed", rate: 0.05 },
        dividendYield: { kind: "fixed", rate: 0.02 },
        bondAllocation: {
          kind: "glidepath",
          interpolation: "linear",
          points: [
            { at: { kind: "age", personId: SAM, age: 50 }, value: 0.2 },
            { at: { kind: "age", personId: SAM, age: 70 }, value: 0.5 },
          ],
        },
      },
    },
  ],
  settings: { theme: "system", valueBasis: "real" },
};

/** A fresh, parsed copy of the synthetic UK sample document. */
export function createUkSampleDocument(): GlideworthDocument {
  return GlideworthDocument.parse(structuredClone(ukSampleInput));
}

export const UK_SAMPLE_PLAN_ID = "uk-plan-main";

// ---------------------------------------------------------------------------------------------
// Germany and Netherlands single-person samples (SYNTHETIC). Every name and number is invented.
// ---------------------------------------------------------------------------------------------

interface EuroSampleSpec {
  householdId: string;
  planId: string;
  personId: string;
  name: string;
  birthMonth: string;
  country: string;
  region?: string;
  retireAge: number;
  salary: number;
  statePension: { name: string; monthly: number; age: number };
  living: number;
  accounts: GlideworthDocumentInput["finances"]["accounts"];
  pensionFlow: { accountId: string; name: string; share: number; employerShare: number };
  taxableAccountId: string;
  cashAccountId: string;
}

function euroSample(s: EuroSampleSpec): GlideworthDocumentInput {
  const household = {
    id: s.householdId,
    name: `${s.name} (${s.country} sample)`,
    planningMode: "individual",
    people: [{ id: s.personId, name: s.name, role: "primary", birthMonth: s.birthMonth }],
    location: { country: s.country, ...(s.region ? { region: s.region } : {}) },
    currency: "EUR",
    locale: s.country === "DE" ? "de-DE" : "nl-NL",
  } satisfies HouseholdInput;
  const d = planDefaultsForHousehold(household);
  const retire = `${s.planId}-retire`;
  return {
    app: "glideworth",
    schemaVersion: SCHEMA_VERSION,
    household,
    finances: { asOf: "2026-11", accounts: s.accounts },
    plans: [
      {
        id: s.planId,
        householdId: s.householdId,
        name: `Retire at ${s.retireAge}`,
        isMain: true,
        milestones: [
          {
            id: retire,
            name: "Retirement",
            kind: "retirement",
            personId: s.personId,
            builtIn: true,
            criteria: [{ kind: "age", personId: s.personId, age: s.retireAge }],
          },
          {
            id: `${s.planId}-le`,
            name: "Life expectancy",
            kind: "life-expectancy",
            personId: s.personId,
            builtIn: true,
            criteria: [{ kind: "age", personId: s.personId, age: 90 }],
          },
        ],
        income: [
          {
            id: `${s.planId}-salary`,
            type: "salary",
            name: "Salary",
            owner: s.personId,
            amount: { value: s.salary, basis: "real" },
            frequency: "yearly",
            range: {
              start: { kind: "planStart" },
              end: { kind: "milestone", milestoneId: retire },
            },
            change: { kind: "inflation", plus: 0.005 },
          },
          {
            id: `${s.planId}-state-pension`,
            type: "state-pension",
            name: s.statePension.name,
            owner: s.personId,
            amount: { value: s.statePension.monthly, basis: "real" },
            frequency: "monthly",
            range: {
              start: { kind: "age", personId: s.personId, age: s.statePension.age },
              end: { kind: "planEnd" },
            },
          },
        ],
        expenses: [
          {
            id: `${s.planId}-living`,
            type: "living",
            name: "Living costs",
            owner: s.personId,
            amount: { value: s.living, basis: "real" },
            frequency: "monthly",
            range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
          },
        ],
        flows: [
          {
            kind: "contribution",
            id: `${s.planId}-fl-pension`,
            name: s.pensionFlow.name,
            owner: s.personId,
            accountId: s.pensionFlow.accountId,
            range: {
              start: { kind: "planStart" },
              end: { kind: "milestone", milestoneId: retire },
            },
            method: {
              kind: "percentOfIncome",
              incomeId: `${s.planId}-salary`,
              share: s.pensionFlow.share,
            },
            employer: {
              incomeId: `${s.planId}-salary`,
              matchShare: 1,
              upToShareOfPay: s.pensionFlow.employerShare,
            },
            limit: { kind: "jurisdiction" },
            mandatory: true,
          },
          {
            kind: "contribution",
            id: `${s.planId}-fl-cash`,
            name: "Emergency fund",
            owner: s.personId,
            accountId: s.cashAccountId,
            range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
            strategy: { kind: "target", target: { value: 15_000, basis: "real" } },
            method: { kind: "max" },
          },
          {
            kind: "contribution",
            id: `${s.planId}-fl-invest`,
            name: "Invest the rest",
            owner: s.personId,
            accountId: s.taxableAccountId,
            range: {
              start: { kind: "planStart" },
              end: { kind: "milestone", milestoneId: retire },
            },
            method: { kind: "percentOfRemaining", share: 1 },
          },
        ],
        leftover: { kind: "save", accountId: s.cashAccountId },
        // Pensions are drawn from the access age before the taxable account (box 3 / Abgeltungsteuer).
        drawdown: {
          order: [
            { kind: "category", category: "cash" },
            { kind: "category", category: "tax-deferred" },
            { kind: "category", category: "taxable" },
          ],
          cashBuffer: { value: 8_000, basis: "real" },
        },
        tax: d.tax,
        monteCarlo: d.monteCarlo,
        assumptions: {
          ...d.assumptions,
          stockReturn: { kind: "fixed", rate: 0.05 },
          dividendYield: { kind: "fixed", rate: 0.02 },
          bondAllocation: { kind: "fixed", share: 0.3 },
        },
      },
    ],
    settings: { theme: "system", valueBasis: "real" },
  };
}

const LENA = "p-lena";
const deSampleInput = euroSample({
  householdId: "hh-de-sample",
  planId: "de-plan-main",
  personId: LENA,
  name: "Lena",
  birthMonth: "1985-03",
  country: "DE",
  region: "HE",
  retireAge: 63,
  salary: 62_000,
  // Regelaltersgrenze 67 for this cohort.
  statePension: { name: "Gesetzliche Rente", monthly: 1_850, age: 67 },
  living: 2_600,
  accounts: [
    { id: "de-cash", name: "Tagesgeld", type: "savings", owner: LENA, balance: 14_000 },
    {
      id: "de-depot",
      name: "ETF-Depot",
      type: "taxable",
      owner: LENA,
      balance: 46_000,
      costBasis: 34_000,
    },
    { id: "de-bav", name: "Betriebsrente (bAV)", type: "de-bav", owner: LENA, balance: 21_000 },
    { id: "de-ruerup", name: "Rürup-Rente", type: "de-ruerup", owner: LENA, balance: 9_000 },
  ],
  pensionFlow: {
    accountId: "de-bav",
    name: "Entgeltumwandlung (bAV)",
    share: 0.04,
    employerShare: 0.04,
  },
  taxableAccountId: "de-depot",
  cashAccountId: "de-cash",
});

const DAAN = "p-daan";
const nlSampleInput = euroSample({
  householdId: "hh-nl-sample",
  planId: "nl-plan-main",
  personId: DAAN,
  name: "Daan",
  birthMonth: "1982-09",
  country: "NL",
  retireAge: 65,
  salary: 58_000,
  // AOW age 67 years 3 months for this cohort.
  statePension: { name: "AOW", monthly: 1_500, age: 67.25 },
  living: 2_400,
  accounts: [
    { id: "nl-cash", name: "Spaarrekening", type: "savings", owner: DAAN, balance: 24_000 },
    {
      id: "nl-beleggen",
      name: "Beleggingsrekening",
      type: "taxable",
      owner: DAAN,
      balance: 72_000,
      costBasis: 55_000,
    },
    { id: "nl-pensioen", name: "Pensioen", type: "nl-pension", owner: DAAN, balance: 88_000 },
  ],
  pensionFlow: {
    accountId: "nl-pensioen",
    name: "Pensioenpremie",
    share: 0.06,
    employerShare: 0.12,
  },
  taxableAccountId: "nl-beleggen",
  cashAccountId: "nl-cash",
});

/** A fresh, parsed copy of the synthetic German sample (EUR, bAV + Rürup, depot, Rente from 67). */
export function createDeSampleDocument(): GlideworthDocument {
  return GlideworthDocument.parse(structuredClone(deSampleInput));
}

export const DE_SAMPLE_PLAN_ID = "de-plan-main";

/** A fresh, parsed copy of the synthetic Dutch sample (EUR, pension, box 3 savings/investments, AOW). */
export function createNlSampleDocument(): GlideworthDocument {
  return GlideworthDocument.parse(structuredClone(nlSampleInput));
}

export const NL_SAMPLE_PLAN_ID = "nl-plan-main";

// ---------------------------------------------------------------------------------------------
// United Arab Emirates sample (SYNTHETIC). An expatriate couple in Dubai; every name and number is
// invented. Shows AED with the USD peg, the end-of-service gratuity, DEWS and a UK pension kept from
// before the move (GBP, sourced in the UK).
// ---------------------------------------------------------------------------------------------

const AE_HOUSEHOLD = "hh-ae-sample";
const NOOR = "p-noor";
const ELLIS = "p-ellis";
const AE_PLAN = "ae-plan-main";

function aePlan(id: string, name: string, isMain: boolean): PlanInput {
  const household = {
    location: { country: "AE" },
    people: [{ role: "primary", birthMonth: "1984-02" }],
  };
  const d = planDefaultsForHousehold(household);
  return {
    id,
    householdId: AE_HOUSEHOLD,
    name,
    isMain,
    description: "Both stop work when Noor turns 58 and stay in the UAE.",
    ...d,
    tax: { ...d.tax, filingStatus: "married-joint" },
    milestones: [
      {
        id: `${id}-retire`,
        name: "Retirement",
        kind: "retirement",
        personId: NOOR,
        builtIn: true,
        criteria: [{ kind: "age", personId: NOOR, age: 58 }],
      },
      {
        id: `${id}-le`,
        name: "Noor life expectancy",
        kind: "life-expectancy",
        personId: NOOR,
        builtIn: true,
        criteria: [{ kind: "age", personId: NOOR, age: 92 }],
      },
    ],
    income: [
      {
        id: `${id}-noor-pay`,
        name: "Noor salary (DIFC)",
        type: "salary",
        owner: NOOR,
        country: "AE",
        amount: { value: 42_000 },
        frequency: "monthly",
        range: {
          start: { kind: "planStart" },
          end: { kind: "milestone", milestoneId: `${id}-retire` },
        },
      },
      {
        id: `${id}-dews-employer`,
        name: "DEWS employer contribution (8.33% of basic)",
        type: "other",
        owner: NOOR,
        country: "AE",
        amount: { value: 2_499 },
        frequency: "monthly",
        tax: { character: "tax-free" },
        sendTo: { kind: "accounts", accountIds: ["ae-dews"] },
        range: {
          start: { kind: "planStart" },
          end: { kind: "milestone", milestoneId: `${id}-retire` },
        },
      },
      {
        id: `${id}-ellis-pay`,
        name: "Ellis salary (mainland)",
        type: "salary",
        owner: ELLIS,
        country: "AE",
        amount: { value: 26_000 },
        frequency: "monthly",
        endOfService: { scheme: "ae-gratuity", serviceStart: "2019-09", basicShare: 0.6 },
        range: {
          start: { kind: "planStart" },
          end: { kind: "milestone", milestoneId: `${id}-retire` },
        },
      },
      {
        id: `${id}-uk-sp`,
        name: "UK State Pension (Noor)",
        type: "state-pension",
        owner: NOOR,
        country: "GB",
        currency: "GBP",
        amount: { value: 7_600 },
        frequency: "yearly",
        range: { start: { kind: "age", personId: NOOR, age: 67 }, end: { kind: "planEnd" } },
      },
    ],
    expenses: [
      {
        id: `${id}-living`,
        name: "Living costs",
        type: "living",
        owner: "joint",
        amount: { value: 30_000 },
        frequency: "monthly",
        range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
      },
      {
        id: `${id}-rent`,
        name: "Rent",
        type: "housing",
        owner: "joint",
        amount: { value: 180_000 },
        frequency: "yearly",
        range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
      },
    ],
    flows: [
      {
        kind: "contribution",
        id: `${id}-invest`,
        name: "Brokerage",
        owner: "joint",
        accountId: "ae-brokerage",
        range: {
          start: { kind: "planStart" },
          end: { kind: "milestone", milestoneId: `${id}-retire` },
        },
        method: { kind: "amount", amount: { value: 8_000 }, frequency: "monthly" },
      },
    ],
    leftover: { kind: "save", accountId: "ae-cash" },
  };
}

const aeSampleInput: GlideworthDocumentInput = {
  app: "glideworth",
  schemaVersion: SCHEMA_VERSION,
  household: {
    id: AE_HOUSEHOLD,
    name: "Noor and Ellis (UAE sample)",
    planningMode: "couple",
    people: [
      { id: NOOR, name: "Noor", role: "primary", birthMonth: "1984-02", citizenships: ["GB"] },
      { id: ELLIS, name: "Ellis", role: "partner", birthMonth: "1986-10", citizenships: ["IE"] },
    ],
    location: { country: "AE" },
    currency: "AED",
    locale: "en-AE",
  },
  finances: {
    asOf: "2026-11",
    accounts: [
      { id: "ae-cash", name: "Current account", type: "savings", owner: "joint", balance: 140_000 },
      {
        id: "ae-brokerage",
        name: "Brokerage (USD funds)",
        type: "taxable",
        owner: "joint",
        balance: 520_000,
        costBasis: 410_000,
      },
      { id: "ae-dews", name: "DEWS", type: "ae-dews", owner: NOOR, balance: 165_000 },
      {
        id: "uk-sipp",
        name: "UK pension (from before the move)",
        type: "uk-sipp",
        owner: NOOR,
        balance: 61_000,
        currency: "GBP",
      },
    ],
    fxRates: [
      // The dirham's US-dollar peg (CBUAE): no drift.
      { from: "AED", to: "USD", rate: 1 / 3.6725, annualDrift: 0 },
      // Illustrative sterling rate, not a forecast.
      { from: "GBP", to: "AED", rate: 4.9, annualDrift: 0 },
    ],
  },
  plans: [aePlan(AE_PLAN, "Stay in the UAE", true)],
};

/** A fresh, parsed copy of the synthetic UAE sample (AED, gratuity, DEWS, UK pension and State Pension). */
export function createUaeSampleDocument(): GlideworthDocument {
  return GlideworthDocument.parse(structuredClone(aeSampleInput));
}

export const UAE_SAMPLE_PLAN_ID = AE_PLAN;
