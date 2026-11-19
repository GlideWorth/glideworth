/**
 * Never-moved, single-country households (invented) used as the regression guard for the
 * cross-border model: their projections must be byte-identical to the engine before it existed.
 */
import type { SimulationInputInput } from "../../src/engine/types.js";
import {
  createDeSampleDocument,
  createNlSampleDocument,
  createSampleDocument,
  createUkSampleDocument,
} from "../../src/samples/index.js";

type Country = {
  country: string;
  region?: string;
  currency: string;
  pension: string;
  taxFree?: string;
};

const COUNTRIES: Country[] = [
  { country: "GB", region: "ENG", currency: "GBP", pension: "uk-sipp", taxFree: "uk-isa" },
  {
    country: "GB",
    region: "SCT",
    currency: "GBP",
    pension: "uk-workplace-pension",
    taxFree: "uk-isa",
  },
  { country: "US", region: "CA", currency: "USD", pension: "401k", taxFree: "roth-ira" },
  { country: "US", region: "TX", currency: "USD", pension: "traditional-ira" },
  { country: "CA", region: "ON", currency: "CAD", pension: "ca-rrsp", taxFree: "ca-tfsa" },
  { country: "AU", currency: "AUD", pension: "au-super-accumulation" },
  { country: "DE", currency: "EUR", pension: "de-ruerup" },
  { country: "NL", currency: "EUR", pension: "nl-pension" },
  { country: "FR", currency: "EUR", pension: "fr-per", taxFree: "fr-pea" },
  { country: "ES", region: "MD", currency: "EUR", pension: "es-plan-pensiones" },
  { country: "IL", currency: "ILS", pension: "il-pension", taxFree: "il-keren-hishtalmut" },
  { country: "IE", currency: "EUR", pension: "ie-pension" },
  { country: "NZ", currency: "NZD", pension: "nz-kiwisaver" },
];

function household(c: Country, couple: boolean): SimulationInputInput {
  const people = [
    { id: "a", name: "A", role: "primary" as const, birthMonth: "1968-05" },
    ...(couple ? [{ id: "b", name: "B", role: "partner" as const, birthMonth: "1970-09" }] : []),
  ];
  return {
    household: {
      id: "h",
      name: "Stayer",
      planningMode: couple ? "couple" : "individual",
      people,
      location: { country: c.country, ...(c.region ? { region: c.region } : {}) },
      currency: c.currency,
      locale: "en-GB",
    },
    finances: {
      asOf: "2026-03",
      accounts: [
        { id: "cash", name: "Cash", type: "savings", owner: "joint", balance: 40_000 },
        {
          id: "inv",
          name: "Investments",
          type: "taxable",
          owner: "a",
          balance: 250_000,
          costBasis: 150_000,
        },
        { id: "pen", name: "Pension", type: c.pension as never, owner: "a", balance: 400_000 },
        ...(c.taxFree
          ? [{ id: "tf", name: "Tax-free", type: c.taxFree as never, owner: "a", balance: 80_000 }]
          : []),
      ],
      realAssets: [
        {
          id: "home",
          name: "Home",
          type: "house",
          owner: "joint",
          currentValue: 500_000,
          purchasePrice: 300_000,
          behaviour: { usage: "primary-residence" },
        },
        {
          id: "let",
          name: "Let",
          type: "rental-property",
          owner: "a",
          currentValue: 300_000,
          purchasePrice: 200_000,
          behaviour: {
            usage: "investment",
            rental: { enabled: true, income: { kind: "percentOfValue", rate: 0.05 } },
            sale: { at: { kind: "date", date: "2034-06" } },
          },
        },
      ],
      debts: [],
    },
    plan: {
      id: "p",
      householdId: "h",
      name: "Stay",
      tax: { mode: "estimate", filingStatus: couple ? "married-joint" : "single" },
      milestones: [
        {
          id: "ret",
          name: "Retire",
          kind: "retirement",
          personId: "a",
          criteria: [{ kind: "age", personId: "a", age: 62 }],
        },
      ],
      income: [
        {
          id: "pay",
          name: "Pay",
          type: "salary",
          owner: "a",
          amount: { value: 90_000 },
          frequency: "yearly",
          range: { start: { kind: "planStart" }, end: { kind: "milestone", milestoneId: "ret" } },
        },
        ...(couple
          ? [
              {
                id: "pay-b",
                name: "Pay B",
                type: "salary" as const,
                owner: "b",
                amount: { value: 35_000 },
                frequency: "yearly" as const,
                range: { start: { kind: "planStart" as const }, end: { kind: "planEnd" as const } },
              },
            ]
          : []),
        {
          id: "sp",
          name: "State pension",
          type: c.country === "US" ? "social-security" : "state-pension",
          owner: "a",
          amount: { value: 12_000 },
          frequency: "yearly",
          range: { start: { kind: "age", personId: "a", age: 67 }, end: { kind: "planEnd" } },
        },
      ],
      expenses: [
        {
          id: "live",
          name: "Living",
          type: "living",
          owner: "joint",
          amount: { value: 55_000 },
          frequency: "yearly",
          range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
        },
      ],
      flows: [
        {
          kind: "contribution",
          id: "f-pen",
          name: "Pension",
          owner: "a",
          accountId: "pen",
          range: { start: { kind: "planStart" }, end: { kind: "milestone", milestoneId: "ret" } },
          method: { kind: "amount", amount: { value: 6_000 }, frequency: "yearly" },
        },
      ],
      assumptions: { end: { kind: "ref", ref: { kind: "age", personId: "a", age: 90 } } },
    },
    options: { trace: "full" },
  };
}

/** The corpus: every built-in sample plus one single and one couple household per supported country. */
export function singleCountryCorpus(): { name: string; input: SimulationInputInput }[] {
  const out: { name: string; input: SimulationInputInput }[] = [];
  for (const [name, make] of [
    ["sample-us", createSampleDocument],
    ["sample-uk", createUkSampleDocument],
    ["sample-de", createDeSampleDocument],
    ["sample-nl", createNlSampleDocument],
  ] as const) {
    const doc = make();
    for (const plan of doc.plans.filter((p) => !p.lineage))
      out.push({
        name: `${name}:${plan.id}`,
        input: {
          household: doc.household,
          finances: doc.finances,
          plan,
          options: { trace: "full" },
        },
      });
  }
  for (const c of COUNTRIES)
    for (const couple of [false, true])
      out.push({
        name: `${c.country}${c.region ? `-${c.region}` : ""}-${couple ? "couple" : "single"}`,
        input: household(c, couple),
      });
  return out;
}
