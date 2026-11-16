import type { SimulationInputInput } from "../src/engine/types.js";
import type { AccountInput } from "../src/schema/accounts.js";
import type { PlanInput } from "../src/schema/plan.js";

/** Minimal single-person scenario starting January 2027, 0% inflation, everything fixed. */
export function scenario(over: {
  accounts?: AccountInput[];
  plan?: Partial<PlanInput>;
  years?: number;
  inflation?: number;
}): SimulationInputInput {
  const years = over.years ?? 3;
  return {
    household: {
      id: "h",
      name: "Test",
      planningMode: "individual",
      people: [{ id: "me", name: "Me", role: "primary", birthMonth: "1980-01" }],
      location: { country: "XX" },
      currency: "EUR",
      locale: "en-IE",
    },
    finances: { asOf: "2027-01", accounts: over.accounts ?? [] },
    plan: {
      id: "p",
      householdId: "h",
      name: "Test plan",
      tax: { mode: "flat", flat: { ordinary: 0, capitalGains: 0, dividends: 0, local: 0 } },
      ...over.plan,
      assumptions: {
        inflation: { kind: "fixed", rate: over.inflation ?? 0 },
        stockReturn: { kind: "fixed", rate: 0 },
        dividendYield: { kind: "fixed", rate: 0 },
        bondReturn: { kind: "fixed", rate: 0 },
        bondYield: { kind: "fixed", rate: 0 },
        cashReturn: { kind: "fixed", rate: 0 },
        end: { kind: "ref", ref: { kind: "date", date: `${2027 + years}-01` } },
        ...over.plan?.assumptions,
      },
    },
    options: { trace: "summary" },
  };
}

export const always = { start: { kind: "planStart" as const }, end: { kind: "planEnd" as const } };
