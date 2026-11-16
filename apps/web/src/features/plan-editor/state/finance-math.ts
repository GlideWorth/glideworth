/** Small, pure money helpers for the input side (net worth summary, loan payoff maths). */
import {
  ACCOUNT_TYPE_INFO,
  type CurrentFinances,
  type DrawdownCategory,
  type Household,
  JOINT,
} from "@glideworth/core";

export interface NetWorthBreakdown {
  assets: number;
  liabilities: number;
  netWorth: number;
  liquid: number;
  byCategory: Partial<Record<DrawdownCategory | "debt" | "loans", number>>;
  byOwner: Record<string, number>;
  accounts: number;
  realAssets: number;
  debts: number;
  loans: number;
}

const UK_PENSION_TYPES = new Set(["uk-sipp", "uk-workplace-pension", "uk-pension"]);

/**
 * UK pensions cannot be touched before the normal minimum pension age (55, rising to 57 from
 * April 2028), whatever the account's withdrawal setting, unless the account models an
 * early-access penalty. Mirrors the engine's `ukPensionOpenAt` so "liquid" here matches the
 * projection's liquid net worth.
 */
export function ukPensionLocked(birthMonth: string, asOf: string): boolean {
  const at = monthIndex(asOf);
  const age = at < 2028 * 12 + 3 ? 55 : 57;
  return at < monthIndex(birthMonth) + age * 12;
}

export function netWorth(
  f: CurrentFinances,
  household?: Pick<Household, "people">,
): NetWorthBreakdown {
  const byCategory: NetWorthBreakdown["byCategory"] = {};
  const byOwner: Record<string, number> = {};
  const add = (owner: string, v: number) => {
    byOwner[owner] = (byOwner[owner] ?? 0) + v;
  };
  let accounts = 0;
  let liquid = 0;
  for (const a of f.accounts) {
    if (a.archived) continue;
    const info = ACCOUNT_TYPE_INFO[a.type];
    accounts += a.balance;
    byCategory[info.drawdown] = (byCategory[info.drawdown] ?? 0) + a.balance;
    add(a.owner, a.balance);
    const rule = a.behaviour.liquid;
    const owner = household?.people.find((p) => p.id === a.owner);
    const locked =
      UK_PENSION_TYPES.has(a.type) &&
      !a.behaviour.earlyWithdrawal.enabled &&
      owner !== undefined &&
      ukPensionLocked(owner.birthMonth, f.asOf);
    if (
      rule === "always" ||
      (rule === "whenWithdrawable" && a.behaviour.withdrawals.kind === "always" && !locked)
    )
      liquid += a.balance;
  }
  let realAssets = 0;
  let loans = 0;
  for (const r of f.realAssets) {
    if (r.archived) continue;
    realAssets += r.currentValue;
    const loan = r.loan?.balance ?? 0;
    loans += loan;
    add(r.owner, r.currentValue - loan);
    if (!r.behaviour.excludeLoanFromLiquidNetWorth) liquid -= loan;
  }
  byCategory["real-assets"] = realAssets;
  let debts = 0;
  for (const d of f.debts) {
    if (d.archived) continue;
    debts += d.balance;
    add(d.owner, -d.balance);
  }
  byCategory.debt = debts;
  byCategory.loans = loans;
  liquid -= debts;
  const assets = accounts + realAssets;
  const liabilities = debts + loans;
  return {
    assets,
    liabilities,
    netWorth: assets - liabilities,
    liquid,
    byCategory,
    byOwner,
    accounts,
    realAssets,
    debts,
    loans,
  };
}

export function ownerLabel(h: Household, owner: string): string {
  if (owner === JOINT) return "Joint";
  return h.people.find((p) => p.id === owner)?.name ?? "Unassigned";
}

/** Monthly rate from an APR under the given compounding. */
export function monthlyRate(
  apr: number,
  compounding: "daily" | "monthly" | "annually" = "monthly",
): number {
  if (compounding === "monthly") return apr / 12;
  if (compounding === "daily") return (1 + apr / 365) ** (365 / 12) - 1;
  return (1 + apr) ** (1 / 12) - 1;
}

/** Months until a balance is repaid, or null when the payment never covers the interest. */
export function monthsToPayoff(
  balance: number,
  apr: number,
  payment: number,
  compounding?: "daily" | "monthly" | "annually",
): number | null {
  if (balance <= 0) return 0;
  if (payment <= 0) return null;
  const r = monthlyRate(apr, compounding);
  if (r === 0) return Math.ceil(balance / payment);
  if (payment <= balance * r) return null;
  return Math.ceil(-Math.log(1 - (r * balance) / payment) / Math.log(1 + r));
}

/** Payment that clears `balance` in `months` months. */
export function paymentFor(
  balance: number,
  apr: number,
  months: number,
  compounding?: "daily" | "monthly" | "annually",
): number {
  if (months <= 0) return balance;
  const r = monthlyRate(apr, compounding);
  if (r === 0) return balance / months;
  return (r * balance) / (1 - (1 + r) ** -months);
}

/** 'YYYY-MM' plus n months. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y! * 12 + (m! - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export function monthIndex(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return y! * 12 + (m! - 1);
}

export function monthFromIndex(i: number): string {
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** Age in whole years at a month. */
export function ageAt(birthMonth: string, month: string): number {
  return Math.floor((monthIndex(month) - monthIndex(birthMonth)) / 12);
}
