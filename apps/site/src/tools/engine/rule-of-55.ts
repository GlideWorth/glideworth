/**
 * Rule of 55 check: from the year of birth, the year someone leaves a job, where the money is and the
 * kind of plan, whether the separation-from-service exception to the 10% additional tax on early
 * distributions applies, which other routes to money before 59½ are open, and the years to bridge.
 *
 * No simulation and no engine model: the engine does not model this exception (an account's
 * early-withdrawal penalty stops at the account's qualifying age, which the user sets). The 59½ age
 * and the 10% rate are read from core (`US_FIXED`); the rules below are not in core and carry their
 * official sources here. Every source was read on 2026-11-26.
 *
 * - 26 U.S.C. 72(t), United States Code 2024 edition (govinfo):
 *   https://www.govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleA-chap1-subchapB-partII-sec72.htm
 *   (t)(1) the 10% additional tax on the part included in gross income; (t)(2)(A)(i) age 59½;
 *   (t)(2)(A)(iv) substantially equal periodic payments; (t)(2)(A)(v) "made to an employee after
 *   separation from service after attainment of age 55"; (t)(3)(A) (A)(v) does not apply to
 *   distributions from an individual retirement plan; (t)(3)(B) periodic payments from a qualified
 *   plan must begin after separation; (t)(4)(A) changing the payments before the later of five years
 *   from the first payment and 59½ brings back the tax; (t)(9) a governmental 457(b) distribution is
 *   treated as one from a qualified plan only to the extent it comes from a rollover in; (t)(10) for a
 *   qualified public safety employee in a governmental plan, or a firefighter in a private-sector plan,
 *   "age 50 or 25 years of service under the plan, whichever is earlier" replaces age 55 (added by
 *   Pub. L. 109-280 §828, widened by Pub. L. 114-26, Pub. L. 114-113 and Pub. L. 117-328 §§308, 329,
 *   330, per the section's amendment notes).
 * - IRS Publication 575 (2025), Pension and Annuity Income, "Tax on Early Distributions", "Separation
 *   from service" and its example (separation at 49 does not qualify at 55), https://www.irs.gov/publications/p575:
 *   the separation must be in or after the calendar year you reach 55 (or the earlier of 50 or 25
 *   years of service under the plan for qualified public safety employees and private-sector
 *   firefighters).
 * - IRS, Retirement topics: exceptions to tax on early distributions (table, "Separation from service":
 *   qualified plans yes, IRAs no; footnote: governmental 457(b) distributions are not subject to the
 *   10% additional tax except amounts from rollovers), https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-exceptions-to-tax-on-early-distributions
 *   (the IRS marks this page as historical; the statute above is the primary source).
 * - IRS, When can a retirement plan distribute benefits? ("The plan is not required to allow
 *   distributions for every possible distributable event"), https://www.irs.gov/retirement-plans/plan-participant-employee/when-can-a-retirement-plan-distribute-benefits
 * - 26 U.S.C. 408A(d)(3)(A) (a conversion is included in gross income), 408A(d)(3)(F) (the 10% applies
 *   to converted amounts taken within the 5-taxable-year period beginning with the year of the
 *   conversion) and 408A(d)(4)(B) (regular contributions come out first), with IRS Publication 590-B
 *   (2025), "Additional Tax on Early Distributions" and "Ordering Rules for Distributions":
 *   https://www.govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleA-chap1-subchapD-partI-subpartA-sec408A.htm
 *   and https://www.irs.gov/publications/p590b
 */
import { US_FIXED } from "@glideworth/core";
import { num, str } from "../state";
import type { Values, ViewModel } from "../types";
import { MONTHS, monthName } from "./uk-pension-age";

/** The date every source in this file was read. */
export const READ_ON = "26 November 2026";

/** 26 U.S.C. 72(t)(2)(A)(v): separation from service after attainment of age 55. */
export const SEPARATION_AGE = 55;
/** 26 U.S.C. 72(t)(10)(A): age 50 for qualified public safety employees and firefighters... */
export const PUBLIC_SAFETY_AGE = 50;
/** ...or 25 years of service under the plan, whichever is earlier (Pub. L. 117-328 §329). */
export const PUBLIC_SAFETY_SERVICE = 25;
/** 26 U.S.C. 72(t)(4)(A)(ii)(I): payments must not change before five years from the first payment. */
export const SEPP_MIN_YEARS = 5;
/** 26 U.S.C. 408A(d)(3)(F): the 5-taxable-year period beginning with the year of the conversion. */
export const CONVERSION_YEARS = 5;
/** 26 U.S.C. 72(t)(2)(A)(i), as core holds it. */
export const ACCESS_AGE = US_FIXED.retirementAccessAge;
/** 26 U.S.C. 72(t)(1), as core holds it. */
export const PENALTY_RATE = US_FIXED.earlyWithdrawalPenalty;

export const SOURCES = {
  usc72:
    "https://www.govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleA-chap1-subchapB-partII-sec72.htm",
  usc408A:
    "https://www.govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleA-chap1-subchapD-partI-subpartA-sec408A.htm",
  pub575: "https://www.irs.gov/publications/p575",
  pub590b: "https://www.irs.gov/publications/p590b",
  exceptions:
    "https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-exceptions-to-tax-on-early-distributions",
  distribute:
    "https://www.irs.gov/retirement-plans/plan-participant-employee/when-can-a-retirement-plan-distribute-benefits",
} as const;

/** Where the money is. */
export type Source = "this-plan" | "old-plan" | "ira";
/** Kind of workplace plan. */
export type PlanType = "qualified" | "gov457";

export interface Rule55Input {
  birthYear: number;
  /** 1 to 12. */
  birthMonth: number;
  /** Year you leave your job (stop work). */
  leaveYear: number;
  source: Source;
  planType: PlanType;
  /** Year you left the employer whose plan holds the money (source 'old-plan'). */
  oldLeaveYear: number;
  publicSafety: boolean;
  /** Years of service under the plan when you leave that employer (public safety only). */
  serviceYears: number;
}

export type Rule55Status = "applies" | "does-not-apply" | "not-needed" | "ira";

export interface Rule55Result {
  status: Rule55Status;
  /** Year you leave the employer whose plan holds the money (null for an IRA). */
  separationYear: number | null;
  /** Age reached in that calendar year. */
  separationAge: number | null;
  /** The age the exception needs (55, or 50 for public safety). */
  ageNeeded: number;
  /** Public safety: 25 years of service met. */
  byService: boolean;
  /** Month index (year × 12 + month − 1) in which you reach 59½. */
  accessMonth: number;
  /** Whole months from the end of the year you leave your job to 59½ (0 when already reached). */
  bridgeMonths: number;
  /** 72(t) payments starting in January after you leave must run until this month index at least. */
  seppUntilMonth: number;
  /** A conversion made in the year you leave can come out without the 10% from January of this year. */
  ladderFirstYear: number;
}

const mi = (year: number, month: number) => year * 12 + (month - 1);

export function checkRuleOf55(x: Rule55Input): Rule55Result {
  const accessMonth = mi(x.birthYear, x.birthMonth) + Math.round(ACCESS_AGE * 12);
  const endOfLeaveYear = mi(x.leaveYear + 1, 1);
  const bridgeMonths = Math.max(0, accessMonth - endOfLeaveYear);
  const seppUntilMonth = Math.max(endOfLeaveYear + SEPP_MIN_YEARS * 12, accessMonth);
  const ladderFirstYear = x.leaveYear + CONVERSION_YEARS;
  const ageNeeded = x.publicSafety ? PUBLIC_SAFETY_AGE : SEPARATION_AGE;
  const base = { ageNeeded, accessMonth, bridgeMonths, seppUntilMonth, ladderFirstYear };

  if (x.source === "ira")
    return {
      ...base,
      status: "ira",
      separationYear: null,
      separationAge: null,
      byService: false,
    };
  const separationYear = x.source === "old-plan" ? x.oldLeaveYear : x.leaveYear;
  // Pub 575: "in or after the year in which you reach age 55": the age reached in that calendar year.
  const separationAge = separationYear - x.birthYear;
  const byService = x.publicSafety && x.serviceYears >= PUBLIC_SAFETY_SERVICE;
  if (x.planType === "gov457")
    return { ...base, status: "not-needed", separationYear, separationAge, byService };
  const ok = separationAge >= ageNeeded || byService;
  return {
    ...base,
    status: ok ? "applies" : "does-not-apply",
    separationYear,
    separationAge,
    byService,
  };
}

/** "4 years 6 months", "11 months", "0 months". */
export function monthsText(m: number): string {
  const y = Math.floor(m / 12);
  const r = m - y * 12;
  const ys = y ? `${y} ${y === 1 ? "year" : "years"}` : "";
  const ms = r || !y ? `${r} ${r === 1 ? "month" : "months"}` : "";
  return [ys, ms].filter(Boolean).join(" ");
}

export function inputFromValues(v: Values): Rule55Input {
  return {
    birthYear: num(v, "by"),
    birthMonth: Number(str(v, "bm")),
    leaveYear: num(v, "leave"),
    source: str(v, "src") as Source,
    planType: str(v, "type") as PlanType,
    oldLeaveYear: num(v, "oldLeave"),
    publicSafety: str(v, "ps") === "yes",
    serviceYears: num(v, "svc"),
  };
}

const PLAN_NAME: Record<PlanType, string> = {
  qualified: "401(k), 403(b) or other workplace plan",
  gov457: "governmental 457(b) plan",
};

const pct = (r: number) => `${Math.round(r * 100)}%`;

export async function runRuleOf55(v: Values): Promise<ViewModel> {
  const x = inputFromValues(v);
  const r = checkRuleOf55(x);
  const pen = pct(PENALTY_RATE);
  const access = monthName(r.accessMonth);
  const leaveAge = x.leaveYear - x.birthYear;
  const pastAccess = r.bridgeMonths === 0;
  const plan = PLAN_NAME[x.planType];
  const who = x.publicSafety ? "public safety " : "";

  let verdict: string;
  let status: string;
  let statusDetail: string;
  switch (r.status) {
    case "ira":
      status = "Does not apply";
      statusDetail = "IRAs are excluded";
      verdict = `The rule of 55 does not apply to an IRA, including money rolled over from a workplace plan: withdrawals before 59½ pay the ${pen} additional tax unless another exception applies.`;
      break;
    case "not-needed":
      status = "Not needed";
      statusDetail = "No 10% tax on a governmental 457(b)";
      verdict = `A governmental 457(b) plan does not charge the ${pen} additional tax at any age, except on money rolled into it from another kind of plan or an IRA, so the rule of 55 is not needed if the plan lets you withdraw.`;
      break;
    case "applies":
      status = "Applies";
      statusDetail = r.byService
        ? `${x.serviceYears} years of service under the plan`
        : `You turn ${r.separationAge} in ${r.separationYear}`;
      verdict = `Leaving that employer in ${r.separationYear}, the year you turn ${r.separationAge}${r.byService && (r.separationAge ?? 0) < r.ageNeeded ? `, with ${x.serviceYears} years of service under the plan` : ""}, the rule of 55${x.publicSafety ? " (age 50 or 25 years of service for public safety)" : ""} lets you take money from that employer’s ${plan} without the ${pen} additional tax, if the plan allows withdrawals. Income tax still applies.`;
      break;
    default:
      status = "Does not apply";
      statusDetail = `You turn ${r.separationAge} in ${r.separationYear}; it needs ${r.ageNeeded}`;
      verdict = `You leave that employer in ${r.separationYear}, the year you turn ${r.separationAge}. The ${who}exception needs you to leave in or after the year you turn ${r.ageNeeded}${x.publicSafety ? ` or after ${PUBLIC_SAFETY_SERVICE} years of service under the plan` : ""}, so it does not apply to that plan, even once you are older.`;
  }

  const bridge = pastAccess
    ? `You reach 59½ in ${access}, by the end of ${x.leaveYear}: the ${pen} additional tax no longer applies after that.`
    : `You reach 59½ in ${access}: ${monthsText(r.bridgeMonths)} to bridge from the end of ${x.leaveYear}.`;
  const headline = `${verdict} ${bridge}`;

  const routes: string[][] = [];
  routes.push([
    "Rule of 55",
    r.status === "applies" ? "Yes" : r.status === "not-needed" ? "Not needed" : "No",
    r.status === "applies"
      ? "From that employer’s plan only, while the money stays in it, and only if the plan pays out to people who have left."
      : r.status === "ira"
        ? "IRAs are excluded by law. Money left in the employer’s plan would have kept it."
        : r.status === "not-needed"
          ? "A governmental 457(b) has no 10% additional tax, except on money rolled into it."
          : `Needs you to leave the employer in or after the year you turn ${r.ageNeeded}.`,
  ]);
  if (pastAccess) {
    routes.push(["Any account after 59½", "Yes", `From ${access}, no 10% additional tax.`]);
  } else {
    routes.push([
      "72(t) payments",
      "Yes",
      `Fixed yearly payments from an IRA or, after you leave, from the workplace plan. Started in January ${x.leaveYear + 1}, they must not change until ${monthName(r.seppUntilMonth)}.`,
    ]);
    routes.push([
      "Roth IRA contributions",
      "Yes, if you have them",
      "What you paid in (not the growth) can come out at any time without income tax or the 10% additional tax.",
    ]);
    routes.push([
      "Roth conversion ladder",
      r.ladderFirstYear * 12 < r.accessMonth ? "Yes, after 5 years" : "Too late to help",
      r.ladderFirstYear * 12 < r.accessMonth
        ? `A conversion in ${x.leaveYear} is taxed as income that year and can come out without the 10% from January ${r.ladderFirstYear}.`
        : `A conversion in ${x.leaveYear} is free of the 10% only from January ${r.ladderFirstYear}, after you reach 59½.`,
    ]);
    routes.push([
      "Taxable savings",
      "Yes",
      "No early-withdrawal tax at any age; selling investments can still mean tax on gains.",
    ]);
  }

  const figures = [
    { label: "Rule of 55", value: status, detail: statusDetail },
    {
      label: "Age in the year you leave",
      value: String(leaveAge),
      detail: `In ${x.leaveYear}${x.source === "old-plan" ? `; ${r.separationAge} when you left the earlier employer` : ""}`,
    },
    {
      label: "Years to bridge to 59½",
      value: pastAccess ? "None" : monthsText(r.bridgeMonths),
      detail: `You reach 59½ in ${access}`,
    },
  ];

  return {
    tool: "rule-of-55",
    headline,
    announce: `Rule of 55: ${status.toLowerCase()}. ${pastAccess ? "Already past 59½." : `${monthsText(r.bridgeMonths)} to 59½.`}`,
    figures,
    charts: [],
    table: {
      caption: `Routes to retirement money before 59½, leaving work in ${x.leaveYear}`,
      columns: ["", "Open?", "How"],
      rows: routes,
    },
    method: [
      `Age is the age you reach in the calendar year you leave the employer (born ${x.birthYear}, leaving ${r.separationYear ?? x.leaveYear}); the law counts the year, not the day.`,
      `59½ is the month six months after your 59th birthday (born ${MONTHS[x.birthMonth - 1]} ${x.birthYear}); the exact day depends on your date of birth.`,
      "Bridge years run from the end of the year you leave to the month you reach 59½. 72(t) payments are assumed to start in January after you leave.",
      `Rules from 26 U.S.C. 72(t) and 408A and IRS Publications 575 and 590-B, read ${READ_ON}.`,
    ],
    warnings: [],
  };
}
