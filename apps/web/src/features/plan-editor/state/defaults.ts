/**
 * Factories for new entities. Every factory returns a fully parsed schema object (defaults filled
 * in), with sensible, editable starting values that feel native to the household's country.
 */
import {
  ACCOUNT_TYPE_INFO,
  Account,
  type AccountType,
  type CurrentFinances,
  type DateRef,
  Debt,
  defaultsForCountry,
  ExpenseEvent,
  type ExpenseType,
  Flow,
  type Household,
  IncomeEvent,
  type IncomeType,
  JOINT,
  Milestone,
  type Plan,
  RealAsset,
  type RealAssetType,
} from "@glideworth/core";
import { addMonths } from "./finance-math";

export function newId(prefix: string): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `${prefix}-${rand}`;
}

export interface CountryDefaults {
  currency: string;
  locale: string;
  statePensionAge: number;
  /** Full yearly State Pension in today's money where the rules fix one (UK), else null. */
  statePensionAmount: number | null;
  retirementAge: number;
  /** Account types core suggests for this country, most tax-advantaged first. */
  preferredSavingsTypes: AccountType[];
}

/**
 * Starting points for new entities, all from core's `defaultsForCountry` (the single source for what a
 * household gets from its country), so the editor cannot drift from onboarding, templates and the API.
 */
/** `birthMonth` (YYYY-MM) makes the State Pension age the person's own (the UK's depends on the birth date). */
export const countryDefaults = (c: string, birthMonth?: string): CountryDefaults => {
  const core = defaultsForCountry(c, birthMonth ? { birthMonth } : {});
  const t = core.accountTypes;
  return {
    currency: core.currency,
    locale: core.locale,
    statePensionAge: core.statePension?.startAge ?? 67,
    statePensionAmount: core.statePension?.annualAmount ?? null,
    retirementAge: core.suggestedRetirementAge,
    preferredSavingsTypes: [
      ...new Set(
        [t.taxFree, t.personalPension, t.workplacePension, t.taxable].filter((x) => x !== null),
      ),
    ],
  };
};

export interface Ctx {
  household: Household;
  finances: CurrentFinances;
}

const primary = (h: Household) => h.people.find((p) => p.role === "primary") ?? h.people[0]!;
const defaultOwner = (h: Household) => (h.people.length > 1 ? JOINT : primary(h).id);
const planStart: DateRef = { kind: "planStart", offsetMonths: 0 };
const planEnd: DateRef = { kind: "planEnd", offsetMonths: 0 };
const never: DateRef = { kind: "never" };

export function retirementMilestone(
  plan: Plan | undefined,
): Plan["milestones"][number] | undefined {
  return plan?.milestones.find((m) => m.kind === "retirement" && m.enabled);
}

function untilRetirement(plan: Plan | undefined, personId?: string): DateRef {
  const r =
    plan?.milestones.find(
      (m) => m.kind === "retirement" && (!personId || !m.personId || m.personId === personId),
    ) ?? retirementMilestone(plan);
  return r ? { kind: "milestone", milestoneId: r.id, offsetMonths: 0 } : planEnd;
}

function nextYearMonth(ctx: Ctx): string {
  return addMonths(ctx.finances.asOf, 12);
}

// ------------------------------------------------------------------------------------ income

export function newIncome(type: IncomeType, ctx: Ctx, plan?: Plan): IncomeEvent {
  const h = ctx.household;
  const me = primary(h);
  const cd = countryDefaults(h.location.country, me.birthMonth);
  const base = {
    id: newId("inc"),
    type,
    owner: me.id,
    name: "",
    amount: { value: 0, basis: "real" as const },
    frequency: "yearly" as const,
    range: { start: planStart, end: untilRetirement(plan, me.id) },
  };
  const make = (over: Record<string, unknown>) => IncomeEvent.parse({ ...base, ...over });
  switch (type) {
    case "salary":
      return make({ name: `${me.name}'s salary`, amount: { value: 45_000, basis: "real" } });
    case "hourly":
      return make({
        name: "Hourly work",
        amount: { value: 18, basis: "real" },
        frequency: "weekly",
        hoursPerWeek: 37.5,
      });
    case "self-employment":
      return make({
        name: "Self-employment",
        amount: { value: 30_000, basis: "real" },
        tax: { character: "self-employment" },
      });
    case "bonus":
      return make({ name: "Annual bonus", amount: { value: 5_000, basis: "real" } });
    case "rsu":
      return make({ name: "Share awards", amount: { value: 10_000, basis: "real" } });
    case "state-pension":
    case "social-security":
    case "ca-cpp":
    case "ca-oas":
      return make({
        name:
          type === "state-pension"
            ? `${me.name}'s State Pension`
            : type === "social-security"
              ? `${me.name}'s Social Security`
              : type === "ca-cpp"
                ? `${me.name}'s CPP`
                : `${me.name}'s OAS`,
        // UK full new State Pension 2025/26: £230.25 a week. Elsewhere a neutral placeholder.
        amount: { value: cd.statePensionAmount ?? 20_000, basis: "real" },
        range: {
          start: { kind: "age", personId: me.id, age: cd.statePensionAge, offsetMonths: 0 },
          end: planEnd,
        },
        ...(type === "state-pension" ? { country: h.location.country } : {}),
        tax: { character: type === "social-security" ? "social-security" : "pension" },
      });
    case "ca-gis":
      return make({
        name: "GIS",
        amount: { value: 5_000, basis: "real" },
        range: { start: { kind: "age", personId: me.id, age: 65, offsetMonths: 0 }, end: planEnd },
      });
    case "pension":
      return make({
        name: "Pension income",
        amount: { value: 12_000, basis: "real" },
        range: { start: untilRetirement(plan, me.id), end: planEnd },
        tax: { character: "pension" },
      });
    case "annuity":
      return make({
        name: "Annuity",
        amount: { value: 8_000, basis: "nominal" },
        change: { kind: "none" },
        range: { start: untilRetirement(plan, me.id), end: planEnd },
        tax: { character: "pension" },
      });
    case "inheritance":
    case "windfall":
      return make({
        name: type === "inheritance" ? "Inheritance" : "Windfall",
        amount: { value: 50_000, basis: "real" },
        frequency: "once",
        range: { start: { kind: "date", date: nextYearMonth(ctx), offsetMonths: 0 }, end: never },
        tax: { character: "tax-free" },
      });
    default:
      return make({ name: "Other income", amount: { value: 5_000, basis: "real" } });
  }
}

// ------------------------------------------------------------------------------------ expenses

export function newExpense(type: ExpenseType, ctx: Ctx, healthcarePremium = 0.02): ExpenseEvent {
  const h = ctx.household;
  const base = {
    id: newId("exp"),
    type,
    owner: defaultOwner(h),
    name: "",
    amount: { value: 0, basis: "real" as const },
    frequency: "monthly" as const,
    range: { start: planStart, end: planEnd },
  };
  const make = (over: Record<string, unknown>) => ExpenseEvent.parse({ ...base, ...over });
  const once = {
    frequency: "once",
    range: { start: { kind: "date", date: nextYearMonth(ctx), offsetMonths: 0 }, end: never },
  };
  switch (type) {
    case "living":
      return make({ name: "Living expenses", amount: { value: 2_200, basis: "real" } });
    case "housing":
      return make({ name: "Rent", amount: { value: 1_400, basis: "real" } });
    case "healthcare":
      return make({
        name: "Healthcare",
        amount: { value: 150, basis: "real" },
        change: { kind: "inflation", plus: healthcarePremium },
      });
    case "childcare":
      return make({
        name: "Childcare",
        amount: { value: 900, basis: "real" },
        range: {
          start: planStart,
          end: { kind: "date", date: addMonths(ctx.finances.asOf, 48), offsetMonths: 0 },
        },
      });
    case "education":
      return make({
        name: "School fees",
        amount: { value: 6_000, basis: "real" },
        frequency: "yearly",
      });
    case "dependent-support":
      return make({ name: "Support for dependants", amount: { value: 200, basis: "real" } });
    case "travel":
      return make({
        name: "Holidays",
        amount: { value: 4_000, basis: "real" },
        frequency: "yearly",
        spendingType: "discretionary",
        range: {
          start: planStart,
          end: { kind: "age", personId: primary(h).id, age: 80, offsetMonths: 0 },
        },
      });
    case "transportation":
      return make({
        name: "Replacement car",
        amount: { value: 18_000, basis: "real" },
        ...once,
        spendingType: "hybrid",
        discretionaryShare: 0.4,
      });
    case "insurance":
      return make({ name: "Insurance", amount: { value: 60, basis: "real" } });
    case "entertainment":
      return make({
        name: "Leisure",
        amount: { value: 250, basis: "real" },
        spendingType: "discretionary",
      });
    case "personal":
      return make({
        name: "Personal",
        amount: { value: 150, basis: "real" },
        spendingType: "discretionary",
      });
    case "pets":
      return make({ name: "Pets", amount: { value: 80, basis: "real" } });
    case "wedding":
      return make({
        name: "Wedding",
        amount: { value: 20_000, basis: "real" },
        ...once,
        spendingType: "discretionary",
      });
    case "charity":
      return make({
        name: "Charitable giving",
        amount: { value: 1_000, basis: "real" },
        frequency: "yearly",
        spendingType: "discretionary",
        charity: { vehicle: "cash" },
      });
    case "tax-payment":
      return make({
        name: "Tax bill",
        amount: { value: 2_000, basis: "nominal" },
        ...once,
        spendingType: "not-spending",
      });
    case "tax-deduction":
      return make({
        name: "Tax deduction",
        amount: { value: 1_000, basis: "real" },
        frequency: "yearly",
        spendingType: "not-spending",
        tax: { deductible: true },
      });
    default:
      return make({ name: "Other expense", amount: { value: 100, basis: "real" } });
  }
}

// ------------------------------------------------------------------------------------ milestones

export function newMilestone(
  ctx: Ctx,
  kind: Plan["milestones"][number]["kind"] = "custom",
): Milestone {
  const me = primary(ctx.household);
  const base = { id: newId("ms"), kind, name: "", combinator: "all" as const };
  switch (kind) {
    case "financial-independence":
    case "lean-fi":
    case "fat-fi":
    case "coast-fi":
    case "barista-fi": {
      const multiple =
        kind === "lean-fi" ? 20 : kind === "fat-fi" ? 33 : kind === "coast-fi" ? 12 : 25;
      const name = {
        "financial-independence": "Financial independence",
        "lean-fi": "Lean FI",
        "fat-fi": "Fat FI",
        "coast-fi": "Coast FI",
        "barista-fi": "Barista FI",
      }[kind];
      return Milestone.parse({
        ...base,
        name,
        criteria: [
          {
            kind: "metric",
            metric: { kind: "liquidNetWorth" },
            comparator: ">=",
            threshold: { kind: "multipleOf", multiple, of: "spending", measurement: "current" },
          },
        ],
      });
    }
    case "debt-free":
      return Milestone.parse({
        ...base,
        name: "Debt free",
        criteria: [
          {
            kind: "metric",
            metric: { kind: "totalDebt" },
            comparator: "<=",
            threshold: { kind: "amount", amount: { value: 0, basis: "nominal" } },
          },
        ],
      });
    case "retirement":
      return Milestone.parse({
        ...base,
        name: `${me.name} retires`,
        personId: me.id,
        criteria: [
          {
            kind: "age",
            personId: me.id,
            age: countryDefaults(ctx.household.location.country).retirementAge,
          },
        ],
      });
    case "life-expectancy":
      return Milestone.parse({
        ...base,
        name: `${me.name} life expectancy`,
        personId: me.id,
        criteria: [{ kind: "age", personId: me.id, age: 90 }],
      });
    case "move":
      return Milestone.parse({
        ...base,
        name: "Move",
        criteria: [{ kind: "date", date: addMonths(ctx.finances.asOf, 60) }],
      });
    default:
      return Milestone.parse({
        ...base,
        name: "New milestone",
        criteria: [{ kind: "age", personId: me.id, age: 50 }],
      });
  }
}

/** Built-ins every plan starts with: retirement for the primary person, life expectancy for each. */
export function builtInMilestones(ctx: Ctx, retirementAge?: number): Milestone[] {
  const cd = countryDefaults(ctx.household.location.country);
  const me = primary(ctx.household);
  return [
    Milestone.parse({
      id: "ms-retire",
      name: "Retirement",
      kind: "retirement",
      personId: me.id,
      builtIn: true,
      criteria: [{ kind: "age", personId: me.id, age: retirementAge ?? cd.retirementAge }],
    }),
    ...ctx.household.people.map((p) =>
      Milestone.parse({
        id: `ms-le-${p.id}`.slice(0, 64),
        name: `${p.name} life expectancy`,
        kind: "life-expectancy",
        personId: p.id,
        builtIn: true,
        criteria: [{ kind: "age", personId: p.id, age: 92 }],
      }),
    ),
  ];
}

// ------------------------------------------------------------------------------------ flows

export function newFlow(kind: Flow["kind"], ctx: Ctx, plan?: Plan): Flow {
  const accounts = ctx.finances.accounts.filter((a) => !a.archived);
  const pref = countryDefaults(ctx.household.location.country).preferredSavingsTypes;
  const target =
    pref.map((t) => accounts.find((a) => a.type === t)).find(Boolean) ??
    accounts.find((a) => ACCOUNT_TYPE_INFO[a.type].category !== "cash") ??
    accounts[0];
  const range = { start: planStart, end: untilRetirement(plan) };
  const base = { id: newId("fl"), owner: target?.owner ?? defaultOwner(ctx.household), range };
  if (kind === "debtPaydown") {
    const debt = ctx.finances.debts[0];
    const asset = ctx.finances.realAssets.find((r) => r.loan);
    return Flow.parse({
      ...base,
      kind,
      name: debt
        ? `Overpay ${debt.name}`
        : asset
          ? `Overpay ${asset.name} loan`
          : "Extra debt payment",
      targetId: debt?.id ?? asset?.id ?? "",
      method: { kind: "amount", amount: { value: 200, basis: "real" }, frequency: "monthly" },
    });
  }
  if (kind === "transfer") {
    const from = accounts[0];
    const to = accounts[1] ?? accounts[0];
    return Flow.parse({
      ...base,
      kind,
      name: "Transfer",
      fromAccountId: from?.id ?? "",
      to: { kind: "account", accountId: to?.id ?? "" },
      amount: { kind: "amount", amount: { value: 1_000, basis: "real" }, frequency: "yearly" },
    });
  }
  const limited = target ? ACCOUNT_TYPE_INFO[target.type].hasContributionLimit : false;
  return Flow.parse({
    ...base,
    kind: "contribution",
    name: target ? `Save into ${target.name}` : "Savings",
    accountId: target?.id ?? "",
    method: { kind: "amount", amount: { value: 400, basis: "real" }, frequency: "monthly" },
    limit: limited ? { kind: "jurisdiction" } : { kind: "none" },
  });
}

// ------------------------------------------------------------------------------------ finances

export function newAccount(type: AccountType, ctx: Ctx): Account {
  const info = ACCOUNT_TYPE_INFO[type];
  const me = primary(ctx.household);
  const owner = info.category === "cash" && ctx.household.people.length > 1 ? JOINT : me.id;
  const behaviour: Record<string, unknown> = {};
  const isUkPension = ["uk-sipp", "uk-workplace-pension", "uk-pension"].includes(type);
  if (isUkPension) {
    behaviour.withdrawals = { kind: "afterQualifiedAge" };
    behaviour.earlyWithdrawal = {
      enabled: false,
      qualifiedAge: info.qualifiedAge ?? 57,
      penaltyRate: 0.55,
    };
    behaviour.ukDrawdownMethod = "ufpls";
    behaviour.taxFreeWithdrawalShare = 0.25;
  } else if (type === "uk-lisa") {
    behaviour.earlyWithdrawal = { enabled: true, qualifiedAge: 60, penaltyRate: 0.25 };
  } else if (info.qualifiedAge && info.qualifiedAge > 0 && info.country === "US") {
    behaviour.earlyWithdrawal = {
      enabled: true,
      qualifiedAge: info.qualifiedAge,
      penaltyRate: type === "hsa" ? 0.2 : 0.1,
    };
  } else if (info.qualifiedAge && info.qualifiedAge > 0) {
    behaviour.withdrawals = { kind: "afterQualifiedAge" };
    behaviour.earlyWithdrawal = { enabled: false, qualifiedAge: info.qualifiedAge, penaltyRate: 0 };
  }
  if (
    [
      "traditional-ira",
      "401k",
      "403b",
      "457b",
      "sep-ira",
      "simple-ira",
      "solo-401k",
      "tsp",
      "401a",
    ].includes(type)
  )
    behaviour.distributions = { kind: "required", rule: "us-rmd" };
  if (type === "inherited-ira")
    behaviour.distributions = { kind: "required", rule: "us-inherited-10-year" };
  if (type === "ca-rrif") behaviour.distributions = { kind: "required", rule: "ca-rrif-minimum" };
  if (type === "au-super-pension")
    behaviour.distributions = { kind: "required", rule: "au-minimum-drawdown" };
  if (type === "hsa") behaviour.hsaCoverage = "self";
  if (info.assetClass === "cash") behaviour.growth = { kind: "inherit" };
  return Account.parse({
    id: newId("acc"),
    name: defaultAccountName(type, ctx),
    type,
    owner,
    balance: 0,
    ...(info.tracksCostBasis ? { costBasis: 0 } : {}),
    ...(info.tracksContributionBasis ? { contributionBasis: 0 } : {}),
    behaviour,
  });
}

function defaultAccountName(type: AccountType, ctx: Ctx): string {
  const label = ACCOUNT_TYPE_INFO[type].label;
  const n = ctx.finances.accounts.filter((a) => a.type === type).length;
  return n ? `${label} ${n + 1}` : label;
}

export function newRealAsset(type: RealAssetType, ctx: Ctx, financed = false): RealAsset {
  const me = primary(ctx.household);
  const gb = ctx.household.location.country === "GB";
  const isProperty = [
    "house",
    "rental-property",
    "commercial-property",
    "building",
    "land",
  ].includes(type);
  const behaviour: Record<string, unknown> = {};
  if (type === "house") {
    behaviour.usage = "primary-residence";
    behaviour.maintenance = { kind: "percentOfValue", rate: 0.01 };
    behaviour.insurance = { kind: "amountPerYear", amount: { value: 400, basis: "real" } };
    if (!gb) behaviour.propertyTax = { cost: { kind: "percentOfValue", rate: 0.01 } };
  } else if (type === "rental-property" || type === "commercial-property") {
    behaviour.usage = "investment";
    behaviour.maintenance = { kind: "percentOfValue", rate: 0.01 };
    behaviour.rental = { enabled: true, income: { kind: "percentOfValue", rate: 0.05 } };
  } else if (["car", "motorcycle", "boat"].includes(type)) {
    behaviour.appreciation = { kind: "rate", rate: -0.15 };
  } else if (["furniture", "machinery", "instrument"].includes(type)) {
    behaviour.appreciation = { kind: "rate", rate: -0.05 };
  }
  const value = isProperty ? 300_000 : type === "car" ? 15_000 : 5_000;
  return RealAsset.parse({
    id: newId("ra"),
    name: type === "house" ? "Home" : (labelFor(type) ?? "Asset"),
    type,
    owner: isProperty && ctx.household.people.length > 1 ? JOINT : me.id,
    currentValue: value,
    purchasePrice: value,
    ...(financed
      ? {
          loan: {
            id: newId("loan"),
            balance: Math.round(value * 0.6),
            interest: {
              apr: isProperty ? 0.045 : 0.079,
              method: "compound",
              compounding: "monthly",
            },
            monthlyPayment: { value: isProperty ? 1_000 : 300, basis: "nominal" },
          },
        }
      : {}),
    behaviour,
  });
}

const labelFor = (t: string) =>
  ({
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
    custom: "Asset",
  })[t];

export function newDebt(type: Debt["type"], ctx: Ctx): Debt {
  const me = primary(ctx.household);
  const presets: Record<string, { name: string; apr: number; balance: number; payment: number }> = {
    "credit-card": { name: "Credit card", apr: 0.229, balance: 2_000, payment: 150 },
    "student-loan": { name: "Student loan", apr: 0.062, balance: 40_000, payment: 120 },
    "auto-loan": { name: "Car finance", apr: 0.079, balance: 12_000, payment: 320 },
    "personal-loan": { name: "Personal loan", apr: 0.069, balance: 8_000, payment: 250 },
    heloc: { name: "Home equity line", apr: 0.075, balance: 20_000, payment: 300 },
    medical: { name: "Medical debt", apr: 0, balance: 3_000, payment: 100 },
    "tax-debt": { name: "Tax owed", apr: 0.07, balance: 3_000, payment: 250 },
  };
  const p = presets[type] ?? { name: "Loan", apr: 0.06, balance: 5_000, payment: 200 };
  return Debt.parse({
    id: newId("debt"),
    name: p.name,
    type,
    owner: me.id,
    balance: p.balance,
    interest: { apr: p.apr, method: "compound", compounding: "monthly" },
    monthlyPayment: { value: p.payment, basis: "nominal" },
  });
}
