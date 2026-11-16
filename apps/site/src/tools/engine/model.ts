/**
 * Builds the engine's SimulationInput from a calculator's inputs. Every calculator describes the same
 * small household: one person, one invested account, yearly spending and income windows, a flat tax
 * mode and a fixed horizon. Shared conventions (stated on every page):
 *
 *  - Today's money. Deterministic runs set inflation to 0 and use the visitor's return after inflation
 *    as the portfolio's return, so every engine figure is already in today's money and matches the
 *    textbook formulas. History runs use the dataset's own inflation and the engine deflates the
 *    results back to today's money (`priceIndexStart` for flows, `priceIndex` for balances).
 *  - One account of type 'generic-tax-deferred' (no country rules, no access age, no contribution
 *    limit). Withdrawals from it are ordinary income, so the flat tax mode's `ordinary` rate is a tax on
 *    withdrawals; at 0% there is no tax at all. Income is entered after tax (character 'tax-free').
 *  - Cash-flow timing (`assumptions.cashFlowTiming`) is the visitor's choice; the planner's default
 *    is 'mid'.
 *  - The plan starts in January of a fixed reference year, so periods are whole years and ages are
 *    whole numbers; the calculators show years from now and ages, never calendar years (except the
 *    historical start years, which are real years).
 */
import {
  type MonteCarloSettingsInput,
  NATIONAL_JURISDICTION_BY_COUNTRY,
  SimulationInput,
  type SimulationInputInput,
  type WithdrawalStrategy,
} from "@glideworth/core";
import type { Timing } from "../types";

/** Reference start of every calculator plan (only relative years are shown). */
export const START_YEAR = 2026;
export const START_MONTH = `${START_YEAR}-01`;
export const ACCOUNT_ID = "portfolio";
export const PERSON_ID = "you";

export interface Window {
  id: string;
  name: string;
  /** Yearly amount in today's money. */
  amount: number;
  /** Years from the plan start (0 = from the start). */
  from: number;
  /** Years from the plan start, exclusive; null = to the end of the plan. */
  to: number | null;
}

export interface ModelOptions {
  currency: string;
  /** Age at the plan start (whole years). */
  age: number;
  /** Plan length in whole years. */
  years: number;
  balance: number;
  timing: Timing;
  /** Flat tax on withdrawals (fraction). */
  taxRate: number;
  /**
   * Deterministic return after inflation (fraction). Ignored by history runs, which sample the dataset.
   */
  realReturn: number;
  /** Stock share for history runs (the rest is in bonds); absent = one asset at `realReturn`. */
  stockShare?: number;
  spending?: Window[];
  /** After-tax income (part-time pay, pensions, savings from salary) in today's money. */
  income?: Window[];
  milestones?: SimulationInputInput["plan"]["milestones"];
  /** A withdrawal rule from the plan start (replaces the spending windows while it runs). */
  withdrawalStrategy?: { rule: WithdrawalStrategy["rule"]; treatAsSpending?: boolean };
  /**
   * Deterministic inflation (default 0: everything in today's money). History runs replace it with the
   * dataset's inflation in every trial.
   */
  inflation?: number;
}

const ref = (offsetYears: number) => ({
  kind: "planStart" as const,
  offsetMonths: Math.round(offsetYears * 12),
});

function windowRange(w: Window) {
  return {
    start: ref(w.from),
    end: w.to === null ? { kind: "planEnd" as const } : ref(w.to),
  };
}

export function buildInput(o: ModelOptions): SimulationInput {
  const inflation = o.inflation ?? 0;
  const oneAsset = o.stockShare === undefined;
  const input: SimulationInputInput = {
    household: {
      id: "calculator",
      name: "Calculator",
      planningMode: "individual",
      people: [
        { id: PERSON_ID, name: "You", role: "primary", birthMonth: `${START_YEAR - o.age}-01` },
      ],
      // 'XX' = no country: no statutory rules, no tax preset. Tax comes only from the flat rate below.
      location: { country: "XX" },
      currency: o.currency,
      locale: "en-US",
    },
    finances: {
      asOf: START_MONTH,
      accounts: [
        {
          id: ACCOUNT_ID,
          name: "Portfolio",
          type: "generic-tax-deferred",
          owner: PERSON_ID,
          balance: Math.max(0, o.balance),
        },
      ],
    },
    plan: {
      id: "calculator-plan",
      householdId: "calculator",
      name: "Calculator plan",
      tax: { mode: "flat", flat: { ordinary: o.taxRate, capitalGains: 0, dividends: 0, local: 0 } },
      leftover: { kind: "save", accountId: ACCOUNT_ID },
      milestones: o.milestones ?? [],
      income: (o.income ?? [])
        .filter((w) => w.amount > 0)
        .map((w) => ({
          id: w.id,
          type: "other" as const,
          name: w.name,
          owner: PERSON_ID,
          amount: { value: w.amount, basis: "real" as const },
          frequency: "yearly" as const,
          tax: { character: "tax-free" as const },
          range: windowRange(w),
        })),
      expenses: (o.spending ?? [])
        .filter((w) => w.amount > 0)
        .map((w) => ({
          id: w.id,
          type: "living" as const,
          name: w.name,
          owner: PERSON_ID,
          amount: { value: w.amount, basis: "real" as const },
          frequency: "yearly" as const,
          range: windowRange(w),
        })),
      ...(o.withdrawalStrategy
        ? {
            withdrawalStrategy: {
              start: { kind: "planStart" as const },
              ...o.withdrawalStrategy,
              enabled: true,
            },
          }
        : {}),
      assumptions: {
        inflation: { kind: "fixed", rate: inflation },
        // One asset: the portfolio grows at the visitor's real return (price growth only, no dividends).
        stockReturn: {
          kind: "fixed",
          rate: inflation === 0 ? o.realReturn : (1 + o.realReturn) * (1 + inflation) - 1,
        },
        dividendYield: { kind: "fixed", rate: 0 },
        bondReturn: { kind: "fixed", rate: inflation },
        bondYield: { kind: "fixed", rate: 0 },
        cashReturn: { kind: "fixed", rate: inflation },
        bondAllocation: oneAsset
          ? { kind: "none" }
          : { kind: "fixed", share: Math.min(1, Math.max(0, 1 - (o.stockShare ?? 1))) },
        cashFlowTiming: o.timing,
        end: { kind: "ref", ref: { kind: "date", date: `${START_YEAR + o.years}-01` } },
      },
    },
    options: { trace: "off" },
  };
  return SimulationInput.parse(input);
}

/** Monte Carlo settings for the two market models the calculators offer. */
export type MarketModel =
  | { kind: "parametric"; mean: number; vol: number }
  | { kind: "history" | "block" | "history-sequential" };

export const HISTORY_DATASET = "us-1928" as const;

export function monteCarloSettings(
  model: MarketModel,
  trials: number,
  seed: number,
): MonteCarloSettingsInput {
  const success = { kind: "all-funded" as const };
  if (model.kind === "parametric")
    return {
      method: "normal",
      distributionShape: "lognormal",
      trials,
      seed,
      success,
      // Only the portfolio's real return varies; inflation stays at 0 (today's money throughout).
      vary: { stocks: true, bonds: false, inflation: false, dividends: false, crypto: false },
      distributions: { stocks: { mean: model.mean, stdDev: model.vol } },
    };
  if (model.kind === "history-sequential")
    return { method: "historical-sequential", dataset: HISTORY_DATASET, seed, success };
  return {
    method: model.kind === "block" ? "block-bootstrap" : "historical-random-restart",
    blockLength: 5,
    dataset: HISTORY_DATASET,
    trials,
    seed,
    success,
  };
}

/** Plain description of the timing convention, for the "how this was calculated" list. */
export function timingText(t: Timing): string {
  return t === "start"
    ? "Money moves at the start of each year (a withdrawal forgoes that year’s growth)."
    : t === "end"
      ? "Money moves at the end of each year (a withdrawal still earns that year’s growth)."
      : "Money moves in the middle of each year (half a year’s growth), the planner’s default.";
}

/** Countries with a national tax model in the engine (read from the engine, never typed in). */
export const TAX_COUNTRIES = Object.keys(NATIONAL_JURISDICTION_BY_COUNTRY).length;

export function taxText(rate: number): string {
  return rate > 0
    ? `A flat ${(rate * 100).toFixed(rate * 100 < 10 ? 1 : 0)}% tax is taken off portfolio withdrawals (the engine’s flat tax mode). No country’s tax rules are applied.`
    : `No tax. The engine’s flat tax mode is set to 0%; the full planner estimates tax for ${TAX_COUNTRIES} countries.`;
}
