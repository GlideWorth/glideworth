/**
 * Calculator hand-off. The free calculators on glideworth.com link to
 * `/signup?from=tool&tool=<id>&v=1&<key>=<value>&…` (apps/site/src/tools/README.md). The receiving side:
 *
 *  1. `/signup` parses the query (`parseHandoff`), keeps only known keys with valid values, and stashes the
 *     result in this browser (`stashHandoff`) so it survives the email-verification round trip, which
 *     usually opens a new tab. The numbers are the person's own calculator inputs, not secrets; they are
 *     kept for 7 days and removed once used or declined.
 *  2. After sign-up the app lands on the welcome screen, which offers "Start from your calculator
 *     inputs"; the guided setup then opens with those answers filled in (`applyHandoff`). Nothing is
 *     created until the person finishes the setup.
 */
import { CURRENCY_CODES } from "../../lib/countries";
import { defaultAnswers, type SetupAnswers } from "../onboarding/build-document";

export const HANDOFF_TOOLS = {
  "coast-fire": "Coast FIRE calculator",
  fire: "FIRE calculator",
  "barista-fire": "Barista FIRE calculator",
  "how-long": "How long will my money last calculator",
  withdrawal: "Withdrawal strategies calculator",
  "monte-carlo": "Monte Carlo calculator",
} as const;
type HandoffTool = keyof typeof HANDOFF_TOOLS;

/** Keys that carry a plain number (money in today's money per year, percentages, ages, counts). */
const NUMBER_KEYS = [
  "age",
  "retire",
  "balance",
  "spend",
  "wr",
  "ret",
  "save",
  "tax",
  "hy",
  "stocks",
  "pt",
  "ptUntil",
  "planTo",
  "rate",
  "years",
  "mean",
  "vol",
  "trials",
  "seed",
  "inc",
  "incFrom",
] as const;
const ENUM_KEYS: Record<string, readonly string[]> = {
  timing: ["start", "mid", "end"],
  method: ["parametric", "history", "block"],
};
const NUMBER = /^-?\d{1,15}(\.\d{1,6})?$/;

export interface Handoff {
  tool: HandoffTool;
  values: Record<string, string>;
}

/** Parse a query string. Returns null unless it is a version-1 calculator hand-off. Unknown keys are ignored. */
export function parseHandoff(search: string): Handoff | null {
  const q = new URLSearchParams(search);
  const tool = q.get("tool");
  if (q.get("from") !== "tool" || q.get("v") !== "1" || !tool || !(tool in HANDOFF_TOOLS))
    return null;
  const values: Record<string, string> = {};
  for (const k of NUMBER_KEYS) {
    const v = q.get(k);
    if (v !== null && NUMBER.test(v)) values[k] = v;
  }
  for (const [k, allowed] of Object.entries(ENUM_KEYS)) {
    const v = q.get(k);
    if (v !== null && allowed.includes(v)) values[k] = v;
  }
  const cur = q.get("cur")?.toUpperCase();
  if (cur && /^[A-Z]{3}$/.test(cur)) values.cur = cur;
  return { tool: tool as HandoffTool, values };
}

// ------------------------------------------------------------------------------------------- storage
const KEY = "glideworth.handoff.v1";
const KEEP_MS = 7 * 24 * 3600 * 1000;

export function stashHandoff(h: Handoff): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...h, at: Date.now() }));
  } catch {
    // storage blocked: the hand-off then only lasts for this tab's sign-up, which is acceptable
  }
}

export function readHandoff(): Handoff | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as { tool?: string; values?: Record<string, string>; at?: number };
    if (
      !o.tool ||
      !(o.tool in HANDOFF_TOOLS) ||
      typeof o.at !== "number" ||
      Date.now() - o.at > KEEP_MS
    ) {
      clearHandoff();
      return null;
    }
    const clean = parseHandoff(
      new URLSearchParams({ from: "tool", v: "1", tool: o.tool, ...(o.values ?? {}) }).toString(),
    );
    return clean;
  } catch {
    return null;
  }
}

export function clearHandoff(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}

// ---------------------------------------------------------------------------------------------- apply
const COUNTRY_FOR_CURRENCY: Record<string, string> = {
  USD: "US",
  GBP: "GB",
  CAD: "CA",
  AUD: "AU",
  NZD: "NZ",
  AED: "AE",
};

const num = (v: string | undefined): number | undefined => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Fill the guided setup's answers from the calculator inputs: currency (and its usual country), age,
 * retirement age (Barista: the age the person stops full-time work), invested balance, yearly spending
 * and, for Barista, the age the plan runs to. Returns what was used, in words. Return, tax, saving and
 * market-model inputs are not carried over: the planner has its own defaults and country tax estimate.
 */
export function applyHandoff(
  h: Handoff,
  now: Date = new Date(),
): { answers: SetupAnswers; used: string[]; skipped: string[] } {
  const v = h.values;
  const used: string[] = [];
  const skipped: string[] = [];
  const cur = v.cur && CURRENCY_CODES.includes(v.cur) ? v.cur : undefined;
  const country = (cur && COUNTRY_FOR_CURRENCY[cur]) || "GB";
  const a = defaultAnswers(country, now);
  if (cur) {
    a.currency = cur;
    used.push(`currency ${cur}`);
  }
  const barista = h.tool === "barista-fire";
  const age = num(v.age);
  if (age !== undefined && !barista && age >= 16 && age <= 100) {
    a.you.birthMonth = `${now.getUTCFullYear() - Math.round(age)}-01`;
    used.push(`age ${Math.round(age)}`);
  }
  const retire = barista ? age : num(v.retire);
  if (retire !== undefined && retire >= 30 && retire <= 100) {
    a.retirementAge = Math.round(retire);
    used.push(
      barista ? `stop full-time work at ${Math.round(retire)}` : `retire at ${Math.round(retire)}`,
    );
  }
  const planTo = num(v.planTo);
  if (planTo !== undefined && planTo > a.retirementAge && planTo <= 120) {
    a.lifeExpectancy = Math.round(planTo);
    used.push(`plan to age ${Math.round(planTo)}`);
  }
  const balance = num(v.balance);
  if (balance !== undefined && balance >= 0) {
    const target = a.accounts.find((x) => x.type !== "savings") ?? a.accounts[0];
    if (target) {
      target.balance = balance;
      used.push("invested balance");
    }
  }
  const spend = num(v.spend);
  if (spend !== undefined && spend >= 0) {
    a.spending = { essential: spend, discretionary: 0, frequency: "yearly" };
    used.push("yearly spending");
  }
  for (const k of ["ret", "tax", "save", "wr", "stocks", "method"])
    if (v[k] !== undefined) skipped.push(k);
  return { answers: a, used, skipped };
}
