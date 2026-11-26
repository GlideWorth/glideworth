/**
 * Social Security break-even calculator: the monthly benefit at 62, at full retirement age (FRA), at 70
 * and at an age the visitor picks, the lifetime benefits each pays by age, and the age from which
 * waiting comes out ahead. With a spouse: the spousal top-up and what the survivor keeps.
 *
 * Every rule comes from @glideworth/core, the same functions the planner's Social Security estimate
 * uses (packages/core/src/engine/tables.ts, which cites them):
 * - `ssFullRetirementAge(birthYear)`: FRA by year of birth (20 CFR 404.409(a));
 * - `ssClaimFactor(monthsEarly)`: 5/9 of 1% a month for the first 36 months early, 5/12 of 1% after
 *   (20 CFR 404.410(a)); 2/3 of 1% a month delayed, to 70 (20 CFR 404.313(b)(2), births after 1942);
 * - `ssSpousalFactor(monthsEarly)`: 25/36 of 1% and 5/12 of 1% (20 CFR 404.410(b)).
 *
 * Rules this module applies itself, with their sources (read 2026-11-26):
 * - The spousal top-up is half the other spouse's primary insurance amount (20 CFR 404.333) less your own
 *   primary insurance amount, reduced for the months before your FRA in which it starts (20 CFR
 *   404.410(b), 404.411(d)). It starts when both of you have claimed: filing for your own benefit counts
 *   as filing for the spouse's benefit and the other way round (Social Security Act §202(r)).
 * - A survivor's benefit is the deceased's benefit, delayed credits included (20 CFR 404.338(a)-(b),
 *   404.313(e)); if the deceased claimed before FRA, the larger of what they were receiving and 82.5% of
 *   their primary insurance amount (20 CFR 404.338(c); Social Security Act §202(e)(2)(D)). A survivor's
 *   own benefit is deducted from it (Social Security Act §202(k)(3)(A)), so the survivor keeps the larger.
 *
 * Money is per month. Amounts are in today's money at 62; with a cost-of-living rate they grow by it
 * once a year from 62. The discount rate brings every payment back to its value at 62.
 */
import { ssClaimFactor, ssFullRetirementAge, ssSpousalFactor } from "@glideworth/core";
import { money, pct, pctInput } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, ComparisonRow, Series, Table, Values, ViewModel } from "../types";
import { ageText } from "./uk-pension-age";

const CUR = "USD";
export const FIRST_AGE = 62;
export const LAST_AGE = 70;
/** Ages the lifetime totals are shown to. */
export const CHART_TO = 100;
/** Break-even is searched to this age; past it the answer is "not by 110". */
const SEARCH_TO = 110;
/** 82.5% floor on a survivor's benefit when the deceased claimed early (20 CFR 404.338(c)). */
export const SURVIVOR_FLOOR = 0.825;
/** Spouse's benefit: half the worker's primary insurance amount (20 CFR 404.333). */
export const SPOUSAL_SHARE = 0.5;

export interface Person {
  born: number;
  /** Benefit at full retirement age (primary insurance amount), per month. */
  pia: number;
}

export interface Assumptions {
  /** Cost-of-living increase a year, fraction. */
  cola: number;
  /** Discount rate a year, fraction. */
  discount: number;
}

const NONE: Assumptions = { cola: 0, discount: 0 };

/** Months from FRA back to the claim age: > 0 early, < 0 delayed (whole months). */
export function monthsEarly(born: number, claimAge: number): number {
  return Math.round((ssFullRetirementAge(born) - claimAge) * 12);
}

/** Own monthly benefit claiming at `claimAge` (62 to 70). */
export function ownMonthly(p: Person, claimAge: number): number {
  return p.pia * ssClaimFactor(monthsEarly(p.born, claimAge));
}

/** Benefit claiming at `claimAge` as a share of the benefit at FRA. */
export function claimShare(born: number, claimAge: number): number {
  return ssClaimFactor(monthsEarly(born, claimAge));
}

/** Months since 62 at an age, to the whole month. */
const monthOf = (age: number) => Math.round((age - FIRST_AGE) * 12);

/**
 * Lifetime benefits received before each month boundary from 62: element k is the total of the
 * payments for the months before age 62 + k/12. The payment for month j (from 62) is
 * `monthly × (1 + cola)^floor(j / 12) ÷ (1 + discount)^(j / 12)` from the claim month on.
 */
export function cumulativeByMonth(
  monthly: number,
  claimAge: number,
  a: Assumptions = NONE,
  toAge = SEARCH_TO,
): number[] {
  const start = monthOf(claimAge);
  const n = monthOf(toAge);
  const out = Array.from<number>({ length: n + 1 });
  out[0] = 0;
  let total = 0;
  for (let j = 0; j < n; j++) {
    if (j >= start)
      total += (monthly * (1 + a.cola) ** Math.floor(j / 12)) / (1 + a.discount) ** (j / 12);
    out[j + 1] = total;
  }
  return out;
}

/**
 * The first age (whole months) from which claiming later has paid at least as much in total as
 * claiming earlier, or null if it does not happen by 110.
 */
export function breakEvenAge(
  p: Person,
  earlier: number,
  later: number,
  a: Assumptions = NONE,
): number | null {
  const e = cumulativeByMonth(ownMonthly(p, earlier), earlier, a);
  const l = cumulativeByMonth(ownMonthly(p, later), later, a);
  for (let k = monthOf(later) + 1; k < l.length; k++)
    if (l[k]! >= e[k]! - 1e-9) return FIRST_AGE + k / 12;
  return null;
}

/**
 * Textbook break-even with no cost-of-living increase and no discounting: the age A at which
 * F_a × (A − a) = F_b × (A − b), so A = (b × F_b − a × F_a) ÷ (F_b − F_a).
 */
export function breakEvenFormula(born: number, earlier: number, later: number): number {
  const fa = claimShare(born, earlier);
  const fb = claimShare(born, later);
  return (later * fb - earlier * fa) / (fb - fa);
}

/** Your age when your spouse is `spouseAge` (born years apart; birth months are not asked). */
const ageWhen = (of: Person, other: Person, otherAge: number) => otherAge + (other.born - of.born);

/**
 * The spousal top-up `p` receives on `other`'s record, per month, once both have claimed: half the
 * other's primary insurance amount less p's own, reduced for the months before p's FRA in which the
 * top-up starts. Zero when p's own primary insurance amount is at least half the other's.
 */
export function spousalTopUp(p: Person, pClaim: number, other: Person, otherClaim: number): number {
  const excess = SPOUSAL_SHARE * other.pia - p.pia;
  if (excess <= 0) return 0;
  const start = Math.max(pClaim, ageWhen(p, other, otherClaim));
  return excess * ssSpousalFactor(Math.max(0, monthsEarly(p.born, start)));
}

/** p's age when the top-up from `other` starts. */
export function topUpStartAge(
  p: Person,
  pClaim: number,
  other: Person,
  otherClaim: number,
): number {
  return Math.max(pClaim, ageWhen(p, other, otherClaim));
}

/**
 * The survivor benefit on the record of someone who claimed at `claimAge` and then died: their
 * benefit, or if they claimed before FRA, the larger of it and 82.5% of their primary insurance amount.
 */
export function survivorBenefit(deceased: Person, claimAge: number): number {
  const own = ownMonthly(deceased, claimAge);
  return monthsEarly(deceased.born, claimAge) > 0
    ? Math.max(own, SURVIVOR_FLOOR * deceased.pia)
    : own;
}

/** What the survivor is paid a month: the larger of their own benefit and the survivor benefit. */
export function survivorKeeps(
  survivor: Person,
  survivorClaim: number,
  deceased: Person,
  deceasedClaim: number,
): number {
  return Math.max(ownMonthly(survivor, survivorClaim), survivorBenefit(deceased, deceasedClaim));
}

/** The claiming ages compared: 62, FRA, 70 and the visitor's age if it is none of those. */
export function claimAges(born: number, chosen: number): number[] {
  const fra = ssFullRetirementAge(born);
  const ages = [FIRST_AGE, fra, LAST_AGE];
  if (!ages.some((a) => Math.abs(a - chosen) < 1e-9)) ages.push(chosen);
  return ages.sort((a, b) => a - b);
}

const m = (x: number) => money(x, CUR);
/** Dollars a month: whole dollars, as SSA pays them (it rounds benefits down to the dollar). */
const mo = (x: number) => m(Math.floor(x + 1e-9));
const ageLong = (a: number) => ageText(a, true);
const beText = (a: number | null) => (a === null ? `not by ${SEARCH_TO}` : ageLong(a));

function label(age: number, fra: number): string {
  if (Math.abs(age - fra) < 1e-9) return `${ageText(age)} (full retirement age)`;
  return ageText(age);
}

export async function runSocialSecurity(v: Values): Promise<ViewModel> {
  const you: Person = { born: num(v, "born"), pia: num(v, "pia") };
  const chosen = num(v, "claim");
  const a: Assumptions = { cola: rate(v, "cola"), discount: rate(v, "disc") };
  const married = str(v, "spouse") === "yes";
  const spouse: Person | null = married ? { born: num(v, "sborn"), pia: num(v, "spia") } : null;
  const sClaim = married ? num(v, "sclaim") : 0;
  const fra = ssFullRetirementAge(you.born);
  const ages = claimAges(you.born, chosen);
  const monthly = ages.map((x) => ownMonthly(you, x));
  const plain = a.cola === 0 && a.discount === 0;

  const be62to70 = breakEvenAge(you, FIRST_AGE, LAST_AGE, a);
  const be62toFra = breakEvenAge(you, FIRST_AGE, fra, a);
  const beFraTo70 = breakEvenAge(you, fra, LAST_AGE, a);
  const at = (x: number) => ownMonthly(you, x);

  const headline =
    `Born in ${you.born}, your full retirement age is ${ageLong(fra)}. Claiming at 62 pays about ${mo(at(FIRST_AGE))} a month, ` +
    `at ${ageText(fra)} ${mo(at(fra))} and at 70 ${mo(at(LAST_AGE))}. ` +
    (be62to70 === null
      ? `With these assumptions, waiting until 70 does not catch up with claiming at 62 by age ${SEARCH_TO}.`
      : `Waiting until 70 instead of claiming at 62 comes out ahead in total if you live past ${ageLong(be62to70)}.`);

  // ---- cumulative chart and table (yearly points)
  const xs = Array.from({ length: CHART_TO - FIRST_AGE + 1 }, (_, i) => FIRST_AGE + i);
  const cums = ages.map((x, i) => cumulativeByMonth(monthly[i]!, x, a, CHART_TO));
  const TONES: Series["tone"][] = [1, 2, 3, 4];
  const STYLES: Series["style"][] = ["solid", "dashed", "dotted", "solid"];
  const series: Series[] = ages.map((x, i) => ({
    label: `Claim at ${label(x, fra)}`,
    values: xs.map((age) => cums[i]![monthOf(age)]!),
    tone: TONES[i % 4]!,
    style: STYLES[i % 4]!,
  }));
  const terms = plain
    ? "in today’s money"
    : a.discount > 0
      ? `discounted to age 62 at ${pctInput(a.discount * 100)}${a.cola > 0 ? `, with ${pctInput(a.cola * 100)} cost-of-living increases` : ""}`
      : `with ${pctInput(a.cola * 100)} cost-of-living increases, in future dollars`;
  const markers = [
    ...(be62to70 !== null ? [{ x: be62to70, label: `62 vs 70: ${ageText(be62to70)}` }] : []),
  ];
  const chart: ChartSpec = {
    id: "ss-cumulative",
    kind: "line",
    title: `Lifetime Social Security benefits by age, ${terms}`,
    summary:
      `Total benefits received by each age for each claiming age. Claiming at 62 leads at first; ` +
      (be62to70 === null
        ? `with these assumptions, claiming at 70 never catches up by ${SEARCH_TO}.`
        : `claiming at 70 catches up at ${ageLong(be62to70)} and is ahead after that. By ${CHART_TO}, claiming at 62 has paid ${m(cums[0]!.at(-1)!)} and claiming at 70 ${m(cums[ages.indexOf(LAST_AGE)]!.at(-1)!)}.`),
    xLabel: "Your age",
    yLabel: "Total benefits received",
    x: xs,
    series,
    markers,
    currency: CUR,
    table: {
      caption: `Total benefits received by age, ${terms}`,
      columns: ["Age", ...ages.map((x) => `Claim at ${label(x, fra)}`)],
      rows: xs.map((age) => [String(age), ...cums.map((c) => m(c[monthOf(age)]!))]),
    },
  };

  // ---- monthly benefit by claiming age
  const yearAges = Array.from({ length: LAST_AGE - FIRST_AGE + 1 }, (_, i) => FIRST_AGE + i);
  const byAge = [...new Set([...yearAges, fra, chosen])].sort((x, y) => x - y);
  const benefitTable: Table = {
    caption: `Monthly benefit by claiming age, born ${you.born}, from ${m(you.pia)} a month at full retirement age (today’s money)`,
    columns: [
      "Claim at",
      "Months before (−) or after (+) full retirement age",
      "Share of full benefit",
      "Monthly benefit",
    ],
    rows: byAge.map((x) => {
      const me = monthsEarly(you.born, x);
      return [
        label(x, fra),
        me === 0 ? "0" : me > 0 ? `−${me}` : `+${-me}`,
        pct(claimShare(you.born, x), 2),
        mo(ownMonthly(you, x)),
      ];
    }),
  };

  // ---- break-even pairs
  const pairs: [number, number][] = [];
  for (let i = 0; i < ages.length; i++)
    for (let j = i + 1; j < ages.length; j++) pairs.push([ages[i]!, ages[j]!]);
  const beTable: Table = {
    caption: `Break-even ages: from when claiming later has paid more in total, ${terms}`,
    columns: [
      "Claim at",
      "Instead wait until",
      "Extra a month",
      "Waiting comes out ahead from age",
    ],
    rows: pairs.map(([e, l]) => [
      label(e, fra),
      label(l, fra),
      mo(at(l) - at(e)),
      beText(breakEvenAge(you, e, l, a)),
    ]),
  };

  const comparisonRows: ComparisonRow[] = [
    [FIRST_AGE, fra],
    [fra, LAST_AGE],
    [FIRST_AGE, LAST_AGE],
  ]
    .filter(([e, l]) => l! - e! > 1e-9)
    .map(([e, l]) => ({
      label: `${ageText(e!)} vs ${ageText(l!)}`,
      formula: ageLong(Math.round(breakEvenFormula(you.born, e!, l!) * 12) / 12),
      engine: beText(breakEvenAge(you, e!, l!, NONE)),
      note: "Monthly count: the first whole month at or after the formula’s age.",
    }));

  const extraTables: Table[] = [beTable, benefitTable];
  const figures = [
    { label: "Full retirement age", value: ageLong(fra), detail: `Born in ${you.born}` },
    {
      label: "Claim at 62",
      value: `${mo(at(FIRST_AGE))} a month`,
      detail: `${pct(claimShare(you.born, FIRST_AGE), 1)} of your full benefit`,
    },
    {
      label: `Claim at ${ageText(fra)}`,
      value: `${mo(at(fra))} a month`,
      detail: "Your full benefit",
    },
    {
      label: "Claim at 70",
      value: `${mo(at(LAST_AGE))} a month`,
      detail: `${pct(claimShare(you.born, LAST_AGE), 1)} of your full benefit`,
    },
    { label: "Break-even, 62 vs 70", value: beText(be62to70), detail: terms },
    {
      label: `Break-even, 62 vs ${ageText(fra)}`,
      value: beText(be62toFra),
      detail: `${ageText(fra)} vs 70: ${beText(beFraTo70)}`,
    },
  ];
  const own = [FIRST_AGE, fra, LAST_AGE].some((x) => Math.abs(x - chosen) < 1e-9);
  if (!own)
    figures.splice(4, 0, {
      label: `Claim at ${ageText(chosen)} (your age)`,
      value: `${mo(at(chosen))} a month`,
      detail: `${pct(claimShare(you.born, chosen), 1)} of your full benefit`,
    });

  const warnings: string[] = [];
  if (spouse) {
    const sFra = ssFullRetirementAge(spouse.born);
    const rows = ages.map((x) => {
      const spouseOwn = ownMonthly(spouse, sClaim);
      const spouseTop = spousalTopUp(spouse, sClaim, you, x);
      const yourTop = spousalTopUp(you, x, spouse, sClaim);
      return [
        label(x, fra),
        mo(at(x) + yourTop),
        mo(spouseOwn + spouseTop),
        mo(survivorKeeps(spouse, sClaim, you, x)),
        mo(survivorKeeps(you, x, spouse, sClaim)),
      ];
    });
    extraTables.push({
      caption: `With your spouse (born ${spouse.born}, ${m(spouse.pia)} a month at full retirement age ${ageText(sFra)}, claiming at ${ageText(sClaim)}): monthly benefits by your claiming age, today’s money. Survivor amounts assume the one who died had already claimed, and are paid in full from the survivor’s full retirement age for survivor benefits.`,
      columns: [
        "You claim at",
        "You, once both have claimed",
        "Your spouse, once both have claimed",
        "Your spouse if you die first",
        "You if your spouse dies first",
      ],
      rows,
    });
    const top = spousalTopUp(spouse, sClaim, you, chosen);
    const higher = you.pia >= spouse.pia;
    figures.push({
      label: "Spousal top-up for your spouse",
      value: top > 0 ? `${mo(top)} a month` : "None",
      detail:
        top > 0
          ? `From when you have both claimed (your spouse at ${ageText(topUpStartAge(spouse, sClaim, you, chosen))})`
          : "Their own benefit is at least half of yours",
    });
    figures.push({
      label: higher ? "Your spouse keeps, if you die first" : "You keep, if your spouse dies first",
      value: `${mo(higher ? survivorKeeps(spouse, sClaim, you, chosen) : survivorKeeps(you, chosen, spouse, sClaim))} a month`,
      detail: higher
        ? `With you claiming at ${ageText(chosen)}; ${mo(survivorKeeps(spouse, sClaim, you, LAST_AGE))} if you claim at 70`
        : `With your spouse claiming at ${ageText(sClaim)}`,
    });
    if (Math.abs(spouse.born - you.born) > 0)
      warnings.push(
        "Ages between you are counted in whole years from your birth years; your birth months can move the spousal top-up’s start by a few months.",
      );
  }

  return {
    tool: "social-security",
    headline,
    announce: `Full retirement age ${ageLong(fra)}. Break-even 62 vs 70: ${beText(be62to70)}.`,
    figures,
    charts: [chart],
    extraTables,
    comparison: {
      title:
        "Break-even: formula and month-by-month count, with no cost-of-living increase or discounting",
      rows: comparisonRows,
      note: "The formula solves F₁ × (A − a₁) = F₂ × (A − a₂) for the age A, where F is the share of the full benefit at each claiming age a. The calculator counts the checks month by month, so its age is the first whole month at or after the formula’s.",
    },
    method: [
      `Full retirement age, early-claiming reductions and delayed retirement credits: ssFullRetirementAge, ssClaimFactor and ssSpousalFactor from the Glideworth engine, the functions the planner’s Social Security estimate uses (20 CFR 404.409, 404.410 and 404.313).`,
      "Benefits start in the month you reach the claiming age and are counted month by month. Monthly amounts are shown rounded down to the dollar, as SSA pays them; totals are not rounded.",
      plain
        ? "Amounts are in today’s money: Social Security’s cost-of-living increases are assumed to match prices, and nothing is discounted."
        : `Cost-of-living increase ${pctInput(a.cola * 100)} a year from 62; each payment is discounted to its value at 62 at ${pctInput(a.discount * 100)} a year.`,
      "What break-even means: if you live past that age, the later claim has paid more in total; if you die before it, the earlier claim had paid more. It is not a forecast of your lifespan, and the right choice also depends on a spouse, your other income, taxes and health.",
    ],
    warnings,
  };
}
