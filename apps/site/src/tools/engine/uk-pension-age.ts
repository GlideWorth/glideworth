/**
 * UK pension age calculator: from a year and month of birth, the State Pension age and the earliest
 * age a private or workplace pension can be taken, with the dates. No simulation: every age comes
 * from the engine's UK rules (`ukStatePensionAge`, `ukNormalMinimumPensionAge`, `UK_PENSION_ACCESS`),
 * which carry their official sources in packages/core/src/tax/data/uk.ts.
 *
 * Dates: an age of A years and m months is reached in the month A years and m months after the birth
 * month. Day-level rules (the State Pension timetable is by date of birth) are not modelled: the
 * calculator gives the month.
 */
import {
  UK_PENSION_ACCESS,
  UK_TAX_YEARS,
  ukNormalMinimumPensionAge,
  ukStatePensionAge,
} from "@glideworth/core";
import { num, str } from "../state";
import type { Values, ViewModel } from "../types";

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Month index (year × 12 + month − 1) of a year and a 1-based month. */
const mi = (year: number, month: number) => year * 12 + (month - 1);

/** "March 2058" for a month index. */
export function monthName(index: number): string {
  const y = Math.floor(index / 12);
  return `${MONTHS[index - y * 12]} ${y}`;
}

/** An age in years and months: 66.25 -> "66 years 3 months"; 57 -> "57". */
export function ageText(age: number, long = false): string {
  const whole = Math.floor(age + 1e-9);
  const months = Math.round((age - whole) * 12);
  if (months === 0) return long ? `${whole} years` : String(whole);
  return `${whole} years ${months} ${months === 1 ? "month" : "months"}`;
}

export interface UkAges {
  birthYear: number;
  birthMonth: number;
  /** State Pension age in years (fractions are whole months). */
  statePensionAge: number;
  statePensionMonth: number;
  /** Normal minimum pension age when it is first reached (55 or 57). */
  firstAccessAge: number;
  firstAccessMonth: number;
  /**
   * Age from which a private pension stays open. It differs from the first access age when someone
   * reaches the lower age before the rise and the higher age after it: access is then lost at the
   * rise until the higher age (the engine's `ukPensionOpenAt`; protected pension ages not modelled).
   */
  steadyAccessAge: number;
  steadyAccessMonth: number;
  /** The gap between the rise and the higher age, when there is one. */
  gap: { from: number; to: number } | null;
}

/** Month index at which the normal minimum pension age rises (UK_PENSION_ACCESS). */
export const RISE_MONTH = mi(UK_PENSION_ACCESS.laterFromYear, UK_PENSION_ACCESS.laterFromMonth);

export function ukAges(birthYear: number, birthMonth: number): UkAges {
  const birth = mi(birthYear, birthMonth);
  const sp = ukStatePensionAge(birthYear, birthMonth);
  const first = ukNormalMinimumPensionAge(birthYear, birthMonth);
  const firstMonth = birth + first * 12;
  const laterMonth = birth + UK_PENSION_ACCESS.laterAge * 12;
  const gap =
    first < UK_PENSION_ACCESS.laterAge && laterMonth > RISE_MONTH
      ? { from: RISE_MONTH, to: laterMonth }
      : null;
  const steady = gap ? UK_PENSION_ACCESS.laterAge : first;
  return {
    birthYear,
    birthMonth,
    statePensionAge: sp,
    statePensionMonth: birth + Math.round(sp * 12),
    firstAccessAge: first,
    firstAccessMonth: firstMonth,
    steadyAccessAge: steady,
    steadyAccessMonth: birth + steady * 12,
    gap,
  };
}

/** Official sources core records for these rules (State Pension age timetable). */
export const STATE_PENSION_AGE_SOURCE = UK_TAX_YEARS.flatMap((y) => y.sources).find((s) =>
  s.url.includes("state-pension-age-timetable"),
);

export async function runUkPensionAge(v: Values): Promise<ViewModel> {
  const by = num(v, "by");
  const bm = Number(str(v, "bm"));
  const a = ukAges(by, bm);
  const born = `${MONTHS[bm - 1]} ${by}`;
  const headline = `Born in ${born}, your State Pension age is ${ageText(a.statePensionAge, true)}, reached in ${monthName(a.statePensionMonth)}. You can take a private or workplace pension from age ${a.steadyAccessAge}, in ${monthName(a.steadyAccessMonth)}.${a.gap ? ` You reach ${a.firstAccessAge} before the age rises, so you could also take it from ${monthName(a.firstAccessMonth)}, but without a protected pension age access stops in ${monthName(a.gap.from)} until you are ${a.steadyAccessAge}.` : ""}`;

  const rows: string[][] = [
    ["Private or workplace pension", String(a.steadyAccessAge), monthName(a.steadyAccessMonth)],
    ["State Pension", ageText(a.statePensionAge), monthName(a.statePensionMonth)],
  ];
  if (a.gap)
    rows.splice(1, 0, [
      "Pension, before the age rises",
      String(a.firstAccessAge),
      `${monthName(a.firstAccessMonth)} to ${monthName(a.gap.from - 1)}`,
    ]);

  const bridge = (a.statePensionMonth - a.steadyAccessMonth) / 12;
  return {
    tool: "uk-pension-age",
    headline,
    announce: `State Pension age ${ageText(a.statePensionAge, true)}; private pension from ${a.steadyAccessAge}.`,
    figures: [
      {
        label: "State Pension age",
        value: ageText(a.statePensionAge, true),
        detail: `From ${monthName(a.statePensionMonth)}`,
      },
      {
        label: "Earliest private pension age",
        value: `${a.steadyAccessAge} years`,
        detail: a.gap
          ? `From ${monthName(a.steadyAccessMonth)}; also ${monthName(a.firstAccessMonth)} to ${monthName(a.gap.from - 1)}`
          : `From ${monthName(a.steadyAccessMonth)}`,
      },
      {
        label: "Years between them",
        value: ageText(bridge, true),
        detail: "From the earliest private pension age to State Pension age",
      },
    ],
    charts: [],
    table: {
      caption: `Pension ages and dates for someone born in ${born}`,
      columns: ["", "Age", "From"],
      rows,
    },
    method: [
      `State Pension age: the engine’s ukStatePensionAge(${by}, ${bm}), month-accurate for the cohorts whose age rises month by month.`,
      `Private pension: the engine’s normal minimum pension age, ${UK_PENSION_ACCESS.age} rising to ${UK_PENSION_ACCESS.laterAge} from ${MONTHS[UK_PENSION_ACCESS.laterFromMonth - 1]} ${UK_PENSION_ACCESS.laterFromYear} (ukNormalMinimumPensionAge).`,
      "Dates are the month you reach each age; the exact day depends on your date of birth.",
    ],
    warnings: [],
  };
}
