/**
 * Guided setup → a complete, valid GlideworthDocument with one sensible main plan. Pure: the caller
 * passes the current month and id seed, so tests are deterministic.
 */
import {
  type AccountType,
  type ExpenseEvent,
  GlideworthDocument,
  type Household,
  JOINT,
  type Plan,
  SCHEMA_VERSION,
} from "@glideworth/core";
import { COUNTRY_LIST, CURRENCY_CODES, countryDefaultsFor } from "../../lib/countries";
import { countryDefaults, newAccount, newExpense } from "../plan-editor/state/defaults";
import { buildPlanFromTemplate } from "../plans/templates";

export type OwnerChoice = "me" | "partner" | "joint";

export interface SetupAccount {
  key: string;
  type: AccountType;
  name: string;
  balance: number;
  owner: OwnerChoice;
}

export interface SetupPerson {
  name: string;
  /** YYYY-MM */
  birthMonth: string;
}

export interface SetupAnswers {
  country: string;
  region?: string;
  currency: string;
  locale: string;
  you: SetupPerson;
  partner: SetupPerson | null;
  accounts: SetupAccount[];
  /** Gross yearly salary, today's money. */
  salary: { me: number; partner: number };
  /** Spending in today's money, per `frequency`. */
  spending: { essential: number; discretionary: number; frequency: "monthly" | "yearly" };
  retirementAge: number;
  lifeExpectancy: number;
  planName: string;
  assumptions?: { inflation: number; stockReturn: number; bondReturn: number };
  monteCarloTrials?: number;
}

export interface CountryOption {
  code: string;
  label: string;
  regions?: { code: string; label: string }[];
  regionLabel?: string;
  regionAffectsTax?: boolean;
}

/** Every supported country with its regions (lib/countries, built on core's country defaults). */
export const COUNTRIES: CountryOption[] = COUNTRY_LIST.map((c) => ({
  code: c.code,
  label: c.label,
  ...(c.regions ? { regions: c.regions.map((r) => ({ code: r.value, label: r.label })) } : {}),
  ...(c.regionLabel ? { regionLabel: c.regionLabel } : {}),
  ...(c.regionAffectsTax ? { regionAffectsTax: true } : {}),
}));

export const CURRENCIES = CURRENCY_CODES;

/** A few account suggestions per country, in the order most people hold them. */
export function suggestedAccounts(country: string): { type: AccountType; name: string }[] {
  switch (country) {
    case "GB":
      return [
        { type: "savings", name: "Easy-access savings" },
        { type: "uk-isa", name: "Stocks & shares ISA" },
        { type: "uk-workplace-pension", name: "Workplace pension" },
        { type: "uk-sipp", name: "SIPP" },
        { type: "uk-gia", name: "General investment account" },
      ];
    case "US":
      return [
        { type: "savings", name: "Savings" },
        { type: "401k", name: "401(k)" },
        { type: "roth-ira", name: "Roth IRA" },
        { type: "taxable", name: "Brokerage" },
        { type: "hsa", name: "HSA" },
      ];
    case "CA":
      return [
        { type: "savings", name: "Savings" },
        { type: "ca-tfsa", name: "TFSA" },
        { type: "ca-rrsp", name: "RRSP" },
        { type: "ca-non-registered", name: "Non-registered" },
      ];
    case "AU":
      return [
        { type: "savings", name: "Savings" },
        { type: "au-super-accumulation", name: "Super" },
        { type: "taxable", name: "Shares" },
      ];
    case "DE":
      return [
        { type: "savings", name: "Tagesgeld" },
        { type: "taxable", name: "Depot" },
        { type: "de-bav", name: "Betriebsrente (bAV)" },
        { type: "de-riester", name: "Riester-Rente" },
      ];
    case "NL":
      return [
        { type: "savings", name: "Spaarrekening" },
        { type: "taxable", name: "Beleggingsrekening" },
        { type: "nl-pension", name: "Pensioen" },
      ];
    case "FR":
      return [
        { type: "savings", name: "Livret A" },
        { type: "fr-pea", name: "PEA" },
        { type: "fr-assurance-vie", name: "Assurance-vie" },
        { type: "fr-per", name: "PER" },
      ];
    case "ES":
      return [
        { type: "savings", name: "Cuenta de ahorro" },
        { type: "taxable", name: "Cartera de inversión" },
        { type: "es-plan-pensiones", name: "Plan de pensiones" },
      ];
    case "IL":
      return [
        { type: "savings", name: "Savings" },
        { type: "il-keren-hishtalmut", name: "Keren hishtalmut" },
        { type: "il-pension", name: "Pension fund" },
        { type: "taxable", name: "Brokerage" },
      ];
    case "IE":
      return [
        { type: "savings", name: "Savings" },
        { type: "ie-pension", name: "Pension / PRSA" },
        { type: "taxable", name: "Investments" },
      ];
    case "NZ":
      return [
        { type: "savings", name: "Savings" },
        { type: "nz-kiwisaver", name: "KiwiSaver" },
        { type: "taxable", name: "Investments" },
      ];
    case "AE":
      return [
        { type: "savings", name: "Current account" },
        { type: "taxable", name: "Brokerage" },
        { type: "ae-dews", name: "DEWS" },
        { type: "ae-savings-scheme", name: "End-of-service savings scheme" },
      ];
    default:
      return [
        { type: "savings", name: "Savings" },
        { type: "taxable", name: "Investments" },
        { type: "generic-tax-deferred", name: "Pension" },
        { type: "generic-tax-free", name: "Tax-free savings" },
      ];
  }
}

export function defaultAnswers(country = "GB", now = new Date()): SetupAnswers {
  const cd = countryDefaults(country);
  const year = now.getUTCFullYear();
  const sugg = suggestedAccounts(country);
  return {
    country,
    region: countryDefaultsFor(country).defaultRegion ?? undefined,
    currency: cd.currency,
    locale: cd.locale,
    you: { name: "", birthMonth: `${year - 40}-01` },
    partner: null,
    accounts: sugg
      .slice(0, 3)
      .map((a, i) => ({ key: `a${i}`, ...a, balance: 0, owner: "me" as const })),
    salary: { me: 0, partner: 0 },
    spending: { essential: 0, discretionary: 0, frequency: "monthly" },
    retirementAge: cd.retirementAge,
    lifeExpectancy: 92,
    planName: "My plan",
  };
}

const ME = "p-me";
const PARTNER = "p-partner";

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "item"
  );
}

/** Validation for each step; returns human messages keyed by field. */
export function validateAnswers(a: SetupAnswers, now = new Date()): Record<string, string> {
  const e: Record<string, string> = {};
  const year = now.getUTCFullYear();
  const age = (p: SetupPerson) => year - Number(p.birthMonth.slice(0, 4));
  if (!a.you.name.trim()) e["you.name"] = "Add your first name (only used for labels).";
  if (!/^\d{4}-\d{2}$/.test(a.you.birthMonth) || age(a.you) < 16 || age(a.you) > 100)
    e["you.birthMonth"] = "Enter a birth year between 16 and 100 years ago.";
  if (a.partner) {
    if (!a.partner.name.trim()) e["partner.name"] = "Add your partner’s first name.";
    if (!/^\d{4}-\d{2}$/.test(a.partner.birthMonth) || age(a.partner) < 16 || age(a.partner) > 100)
      e["partner.birthMonth"] = "Enter a birth year between 16 and 100 years ago.";
  }
  if (a.retirementAge <= age(a.you) - 1 && a.retirementAge < 100) {
    // Already retired is allowed; nothing to flag.
  }
  if (a.lifeExpectancy <= a.retirementAge)
    e.lifeExpectancy = "Life expectancy must be after retirement.";
  if (a.lifeExpectancy <= age(a.you))
    e.lifeExpectancy = "Life expectancy must be later than your current age.";
  if (a.accounts.some((x) => !Number.isFinite(x.balance) || x.balance < 0))
    e.accounts = "Balances must be zero or more.";
  if (!a.planName.trim()) e.planName = "Give the plan a name.";
  return e;
}

/** Build the whole document. Throws (ZodError) only on programming errors. */
export function buildSetupDocument(
  a: SetupAnswers,
  opts: { now: Date; householdId?: string } = { now: new Date() },
): GlideworthDocument {
  const asOf = opts.now.toISOString().slice(0, 7);
  const couple = !!a.partner;
  const household: Household = {
    id: opts.householdId ?? "hh-main",
    name: couple
      ? `${a.you.name.trim()} & ${a.partner!.name.trim()}`
      : `${a.you.name.trim()}’s household`,
    planningMode: couple ? "couple" : "individual",
    people: [
      {
        id: ME,
        name: a.you.name.trim(),
        role: "primary",
        birthMonth: a.you.birthMonth,
        sex: "unspecified",
      },
      ...(couple
        ? [
            {
              id: PARTNER,
              name: a.partner!.name.trim(),
              role: "partner" as const,
              birthMonth: a.partner!.birthMonth,
              sex: "unspecified" as const,
            },
          ]
        : []),
    ],
    dependents: [],
    location: { country: a.country, ...(a.region ? { region: a.region } : {}) },
    currency: a.currency,
    locale: a.locale,
  };
  // Country presets may carry exchange rates (the dirham's US-dollar peg): pre-fill them.
  const fxRates = (countryDefaultsFor(a.country).fxRates ?? []).filter(
    (r) => r.from === a.currency || r.to === a.currency,
  );
  const finances = {
    asOf,
    accounts: [],
    realAssets: [],
    debts: [],
    ...(fxRates.length ? { fxRates } : {}),
  } as unknown as GlideworthDocument["finances"];
  const ctx = { household, finances };
  const used = new Set<string>();
  finances.accounts = a.accounts
    .filter((x) => x.name.trim() || x.balance > 0)
    .map((x) => {
      const acc = newAccount(x.type, ctx);
      let id = `acc-${slug(x.name || x.type)}`;
      for (let n = 2; used.has(id); n++) id = `acc-${slug(x.name || x.type)}-${n}`;
      used.add(id);
      const owner =
        x.owner === "partner" && couple ? PARTNER : x.owner === "joint" && couple ? JOINT : ME;
      return {
        ...acc,
        id,
        name: x.name.trim() || acc.name,
        balance: x.balance,
        owner,
        ...(acc.costBasis !== undefined ? { costBasis: x.balance } : {}),
        ...(acc.contributionBasis !== undefined ? { contributionBasis: x.balance } : {}),
      };
    });

  const plan = buildPlanFromTemplate("work-save-retire", ctx, {
    id: "plan-main",
    name: a.planName.trim() || "My plan",
    description:
      "Created by guided setup. Every number is a starting point: open the plan to refine it.",
  });

  // Salaries: the template adds one per person; set the amounts (drop zero salaries).
  const salaryFor = (owner: string) => (owner === PARTNER ? a.salary.partner : a.salary.me);
  const income = plan.income
    .map((i) =>
      i.type === "salary"
        ? { ...i, amount: { value: salaryFor(i.owner), basis: "real" as const } }
        : i,
    )
    .filter((i) => i.type !== "salary" || i.amount.value > 0);

  // Spending: essential living costs plus optional discretionary spending.
  const living = newExpense("living", ctx);
  const expenses: ExpenseEvent[] = [];
  if (a.spending.essential > 0)
    expenses.push({
      ...living,
      id: "exp-essential",
      name: "Everyday living",
      amount: { value: a.spending.essential, basis: "real" },
      frequency: a.spending.frequency,
      spendingType: "essential",
    } as ExpenseEvent);
  if (a.spending.discretionary > 0)
    expenses.push({
      ...newExpense("travel", ctx),
      id: "exp-discretionary",
      name: "Travel & fun",
      amount: { value: a.spending.discretionary, basis: "real" },
      frequency: a.spending.frequency,
      spendingType: "discretionary",
    } as ExpenseEvent);

  const milestones = plan.milestones.map((m) => {
    if (m.id === "ms-retire")
      return {
        ...m,
        criteria: [
          { kind: "age" as const, personId: ME, age: a.retirementAge, when: "at" as const },
        ],
      };
    if (m.kind === "life-expectancy" && m.personId)
      return {
        ...m,
        criteria: [
          {
            kind: "age" as const,
            personId: m.personId,
            age: a.lifeExpectancy,
            when: "at" as const,
          },
        ],
      };
    return m;
  });

  const assumptions = a.assumptions
    ? {
        ...plan.assumptions,
        inflation: { kind: "fixed" as const, rate: a.assumptions.inflation },
        stockReturn: { kind: "fixed" as const, rate: a.assumptions.stockReturn },
        bondReturn: { kind: "fixed" as const, rate: a.assumptions.bondReturn },
      }
    : plan.assumptions;

  // Flows reference accounts by id; keep only those whose account exists.
  const accountIds = new Set(finances.accounts.map((x) => x.id));
  const flows = plan.flows.filter((f) => f.kind !== "contribution" || accountIds.has(f.accountId));

  const fullPlan: Plan = {
    ...plan,
    isMain: true,
    income,
    expenses,
    milestones,
    assumptions,
    flows,
    monteCarlo: {
      ...plan.monteCarlo,
      ...(a.monteCarloTrials ? { trials: a.monteCarloTrials } : {}),
    },
  };

  return GlideworthDocument.parse({
    app: "glideworth",
    schemaVersion: SCHEMA_VERSION,
    household,
    finances,
    plans: [fullPlan],
    progress: [],
    settings: { onboarding: { completed: true } },
  });
}
