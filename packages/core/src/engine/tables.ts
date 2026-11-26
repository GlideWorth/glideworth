/**
 * Statutory tables used by the engine's distribution and benefit mechanics when no tax
 * jurisdiction in the stack supplies them (flat/custom mode). Jurisdictions (workstream b) may
 * override via `TaxJurisdiction.requiredDistribution`.
 */

import { UNIFORM_LIFETIME } from "../tax/data/us-federal.js";

export function uniformLifetimeDivisor(age: number): number {
  const a = Math.floor(age);
  if (a < 70) return UNIFORM_LIFETIME[70]! + (70 - a);
  return UNIFORM_LIFETIME[Math.min(120, a)] ?? 2.0;
}

/**
 * Single Life Expectancy (2022+), approximated by linear interpolation between published values
 * at anchor ages (within ~0.2 years). Used for inherited stretch and 72(t) RMD/amortisation.
 */
const SINGLE_ANCHORS: [number, number][] = [
  [0, 84.6],
  [10, 74.7],
  [20, 64.8],
  [30, 55.3],
  [40, 45.7],
  [50, 36.2],
  [55, 31.6],
  [60, 27.1],
  [65, 22.9],
  [70, 18.8],
  [75, 14.8],
  [80, 11.2],
  [85, 8.1],
  [90, 5.7],
  [95, 4.1],
  [100, 3.0],
  [110, 1.9],
  [120, 1.0],
];

export function singleLifeExpectancy(age: number): number {
  if (age <= 0) return SINGLE_ANCHORS[0]![1];
  for (let i = 1; i < SINGLE_ANCHORS.length; i++) {
    const [a1, v1] = SINGLE_ANCHORS[i]!;
    const [a0, v0] = SINGLE_ANCHORS[i - 1]!;
    if (age <= a1) return v0 + ((age - a0) / (a1 - a0)) * (v1 - v0);
  }
  return 1;
}

/** SECURE 2.0 required beginning age by birth year: one source of truth in the US tax data. */
export { usRmdStartAge } from "../tax/data/us-federal.js";

/** Canada RRIF minimum withdrawal factor by age at the start of the year. */
const RRIF: Record<number, number> = {
  71: 0.0528,
  72: 0.054,
  73: 0.0553,
  74: 0.0567,
  75: 0.0582,
  76: 0.0598,
  77: 0.0617,
  78: 0.0636,
  79: 0.0658,
  80: 0.0682,
  81: 0.0708,
  82: 0.0738,
  83: 0.0771,
  84: 0.0808,
  85: 0.0851,
  86: 0.0899,
  87: 0.0955,
  88: 0.1021,
  89: 0.1099,
  90: 0.1192,
  91: 0.1306,
  92: 0.1449,
  93: 0.1634,
  94: 0.1879,
};

export function rrifMinimumFactor(age: number): number {
  const a = Math.floor(age);
  if (a < 71) return 1 / Math.max(1, 90 - a);
  return RRIF[a] ?? 0.2;
}

/** Australia superannuation pension minimum drawdown by age. */
export function auMinimumDrawdown(age: number): number {
  if (age < 65) return 0.04;
  if (age < 75) return 0.05;
  if (age < 80) return 0.06;
  if (age < 85) return 0.07;
  if (age < 90) return 0.09;
  if (age < 95) return 0.11;
  return 0.14;
}

/*
 * US Social Security claiming rules. Sources (read 2026-11-26):
 * - 20 CFR 404.409(a), full retirement age by date of birth:
 *   https://www.ecfr.gov/current/title-20/chapter-III/part-404/subpart-E/section-404.409
 * - 20 CFR 404.410(a) and (b), reductions for old-age and for wife's or husband's benefits:
 *   https://www.ecfr.gov/current/title-20/chapter-III/part-404/subpart-E/section-404.410
 * - 20 CFR 404.313(b)(2), delayed retirement credits (2/3 of 1% a month for births after 1/1/1943):
 *   https://www.ecfr.gov/current/title-20/chapter-III/part-404/subpart-C/section-404.313
 * - SSA, "Retirement Age and Benefit Reduction" and "Delayed Retirement Credits" (worked percentages by
 *   birth year; ssa.gov refuses automated access, so read from the Internet Archive copies of
 *   2 Nov 2026 and 31 Oct 2026): https://www.ssa.gov/benefits/retirement/planner/agereduction.html,
 *   https://www.ssa.gov/benefits/retirement/planner/delayret.html
 * Birth years stand for dates of birth: someone born on 1 January is treated by SSA as born in the
 * year before (404.409 ranges run from 2 January), which these functions do not do.
 */

/** US Social Security full retirement age (years) by birth year (20 CFR 404.409(a)). */
export function ssFullRetirementAge(birthYear: number): number {
  if (birthYear <= 1937) return 65;
  if (birthYear <= 1942) return 65 + ((birthYear - 1937) * 2) / 12;
  if (birthYear <= 1954) return 66;
  if (birthYear <= 1959) return 66 + ((birthYear - 1954) * 2) / 12;
  return 67;
}

/**
 * Own-benefit factor for claiming `monthsEarly` (> 0 early, < 0 delayed) relative to FRA: 5/9 of 1%
 * for each of the first 36 months early and 5/12 of 1% for each further month (20 CFR 404.410(a));
 * 2/3 of 1% for each month delayed (20 CFR 404.313(b)(2), births after 1 January 1943 only), up to 70.
 */
export function ssClaimFactor(monthsEarly: number): number {
  if (monthsEarly > 0)
    return 1 - Math.min(monthsEarly, 36) * (5 / 900) - Math.max(0, monthsEarly - 36) * (5 / 1200);
  return 1 + -monthsEarly * (2 / 300);
}

/**
 * Spousal-benefit factor: 25/36 of 1% for each of the first 36 months early and 5/12 of 1% for each
 * further month (20 CFR 404.410(b)). No delayed credits: the spouse's benefit is half the worker's
 * primary insurance amount (20 CFR 404.333), so the worker's own delayed credits do not raise it.
 */
export function ssSpousalFactor(monthsEarly: number): number {
  if (monthsEarly <= 0) return 1;
  return 1 - Math.min(monthsEarly, 36) * (25 / 3600) - Math.max(0, monthsEarly - 36) * (5 / 1200);
}

/** Social Security earnings test exempt amounts (2025, real; indexed with the price index). */
export const SS_EARNINGS_TEST = { underFra: 23_400, fraYear: 62_160 };
