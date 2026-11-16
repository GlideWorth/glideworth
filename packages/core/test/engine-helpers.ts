import { expect } from "vitest";
import type { ProjectionResult, SimulationInputInput } from "../src/engine/types.js";
import type { AccountInput } from "../src/schema/accounts.js";
import type { CurrentFinancesInput, PlanInput } from "../src/schema/plan.js";

export const always = { start: { kind: "planStart" as const }, end: { kind: "planEnd" as const } };
export const from = (date: string) => ({
  start: { kind: "date" as const, date },
  end: { kind: "planEnd" as const },
});
export const between = (a: string, b: string) => ({
  start: { kind: "date" as const, date: a },
  end: { kind: "date" as const, date: b },
});

export const ZERO_TAX = {
  mode: "flat" as const,
  flat: { ordinary: 0, capitalGains: 0, dividends: 0, local: 0 },
};
export const flatTax = (ordinary: number, capitalGains = 0, dividends = 0) => ({
  mode: "flat" as const,
  flat: { ordinary, capitalGains, dividends, local: 0 },
});

export interface Over {
  accounts?: AccountInput[];
  finances?: Partial<CurrentFinancesInput>;
  plan?: Partial<PlanInput>;
  years?: number;
  inflation?: number;
  start?: string;
  /** Birth months: one for a single person, two for a couple (ids 'a' and 'b'). */
  births?: string[];
  location?: { country: string; region?: string };
  options?: SimulationInputInput["options"];
}

/**
 * Deterministic test scenario: zero returns and zero inflation unless overridden, flat 0% tax,
 * horizon `years` from `start` (default 2027-01). Single person id 'me' (born 1980-01) unless
 * `births` gives a couple ('a' primary, 'b' partner).
 */
export function sim(over: Over = {}): SimulationInputInput {
  const start = over.start ?? "2027-01";
  const years = over.years ?? 3;
  const [y, m] = start.split("-").map(Number) as [number, number];
  const end = `${y + years}-${String(m).padStart(2, "0")}`;
  const couple = (over.births?.length ?? 1) > 1;
  const people = couple
    ? [
        { id: "a", name: "A", role: "primary" as const, birthMonth: over.births![0]! },
        { id: "b", name: "B", role: "partner" as const, birthMonth: over.births![1]! },
      ]
    : [
        {
          id: "me",
          name: "Me",
          role: "primary" as const,
          birthMonth: over.births?.[0] ?? "1980-01",
        },
      ];
  return {
    household: {
      id: "h",
      name: "Test",
      planningMode: couple ? "couple" : "individual",
      people,
      location: over.location ?? { country: "XX" },
      currency: "GBP",
      locale: "en-GB",
    },
    finances: { asOf: start, accounts: over.accounts ?? [], ...over.finances },
    plan: {
      id: "p",
      householdId: "h",
      name: "Test plan",
      tax: ZERO_TAX,
      ...over.plan,
      assumptions: {
        inflation: { kind: "fixed", rate: over.inflation ?? 0 },
        stockReturn: { kind: "fixed", rate: 0 },
        dividendYield: { kind: "fixed", rate: 0 },
        bondReturn: { kind: "fixed", rate: 0 },
        bondYield: { kind: "fixed", rate: 0 },
        cashReturn: { kind: "fixed", rate: 0 },
        cryptoReturn: { kind: "fixed", rate: 0 },
        end: { kind: "ref", ref: { kind: "date", date: end } },
        ...over.plan?.assumptions,
      },
    },
    options: { trace: "summary", ...over.options },
  };
}

export const acct = (
  id: string,
  type: AccountInput["type"],
  balance: number,
  extra: Partial<AccountInput> = {},
): AccountInput => ({
  id,
  name: id,
  type,
  owner: "me",
  balance,
  ...extra,
});

export function period(r: ProjectionResult, year: number) {
  const p = r.periods.find((x) => x.year === year);
  if (!p) throw new Error(`no period ${year}`);
  return p;
}

export function account(r: ProjectionResult, year: number, id: string) {
  const a = period(r, year).accounts.find((x) => x.accountId === id);
  if (!a) throw new Error(`no account ${id} in ${year}`);
  return a;
}

/**
 * Conservation invariants (full mode):
 *  - the cash pool balances every period (inflows = outflows);
 *  - every account reconciles: closing = opening + growth - fees + reinvested dividends +
 *    contributions - withdrawals + transfersIn - transfersOut;
 *  - no account goes negative; funded never exceeds requested.
 */
export function expectInvariants(r: ProjectionResult, tolerance = 1e-6): void {
  for (const p of r.periods) {
    let into = 0;
    let out = 0;
    for (const e of p.ledger) {
      if (e.to === "pool") into += e.amount;
      if (e.from === "pool") out += e.amount;
      expect(e.amount).toBeGreaterThanOrEqual(0);
    }
    expect(Math.abs(into - out), `pool imbalance in ${p.year}: in ${into} out ${out}`).toBeLessThan(
      tolerance * Math.max(1, into),
    );
    for (const a of p.accounts) {
      const expected =
        a.opening +
        a.growth -
        a.fees +
        (a.dividendsReinvested ?? 0) +
        a.contributions -
        a.withdrawals +
        a.transfersIn -
        a.transfersOut;
      expect(Math.abs(a.closing - expected), `account ${a.accountId} in ${p.year}`).toBeLessThan(
        tolerance * Math.max(1, Math.abs(a.opening) + a.contributions + a.withdrawals),
      );
      expect(a.closing, `${a.accountId} negative in ${p.year}`).toBeGreaterThanOrEqual(-tolerance);
    }
    for (const e of p.expenses) {
      expect(e.funded).toBeLessThanOrEqual(e.requested + tolerance);
      expect(e.funded).toBeGreaterThanOrEqual(-tolerance);
    }
  }
}
