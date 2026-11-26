/**
 * The one-page summary for a partner: plain words, few numbers, every number from an engine result.
 *
 * Inputs are results the engine already computed (the deterministic projection, a Monte Carlo summary, one
 * projection per survivor scenario, the assumption audit). Nothing here simulates or estimates: a figure that
 * appears in any sentence is listed in `figures` with the result field it was read from, so a test (and a
 * reviewer) can check each one against its source. Missing inputs give "not run yet" sentences, never a guess.
 */
import { type ProjectionResult, type SimulationInput, toBasis } from "../engine/types.js";
import type { Plan } from "../schema/plan.js";
import type { RateSpec } from "../schema/time.js";
import type { Finding } from "./contracts.js";
import { type FormatContext, fmtMoney, fmtPercent } from "./format.js";
import { survivorScenario } from "./scenarios.js";

/** Ages at which each partner's death is evaluated (the defaults of `survivorScenarios`). */
export const PARTNER_SUMMARY_SURVIVOR_AGES = [70, 80, 90] as const;

/** The Monte Carlo fields the summary reads (a `MonteCarloResult` fits). */
export interface PartnerSummaryMonteCarlo {
  successRate: number;
  trials: number;
  sequenceRisk?: {
    years: number;
    anchor: "retirement" | "planStart";
    buckets: { successRate: number; trials: number }[];
  } | null;
}

export interface PartnerSummarySurvivorRun {
  /** The person who dies. */
  personId: string;
  age: number;
  result: ProjectionResult;
}

export interface PartnerSummaryInput {
  input: SimulationInput;
  /** Deterministic projection of `input`. */
  result: ProjectionResult;
  /** Chance of success with the plan's own settings; null when it has not been run for this version. */
  monteCarlo?: PartnerSummaryMonteCarlo | null;
  /** One deterministic projection per survivor scenario (`partnerSummarySurvivorCases`). */
  survivors?: PartnerSummarySurvivorRun[];
  /** `auditAssumptions` of the same input and result. */
  findings?: Finding[];
}

/** One number shown in the summary, and where it was read from. */
export interface PartnerSummaryFigure {
  id: string;
  /** Exactly as written in the sentences. */
  display: string;
  /** The unrounded value from the source. */
  value: number;
  kind: "money" | "percent" | "year" | "age" | "count";
  /** The result field it was read from, e.g. `projection.summary.retirementYear`. */
  source: string;
}

export type ConfidenceLevel = "high" | "good" | "uncertain" | "low" | "unknown";

export interface PartnerSummary {
  planId: string;
  planVersion: number;
  planName: string;
  currency: string;
  locale: string;
  people: { id: string; name: string }[];
  headline: string;
  stopWork: {
    text: string;
    year: number | null;
    month: string | null;
    ages: { personId: string; name: string; age: number }[];
  };
  spending: {
    text: string;
    /** Spending in today's money in `year` (the first full year after stopping work, else the first year). */
    yearly: number | null;
    year: number | null;
    /** Whether every year's spending is paid for on the plan's own assumptions. */
    allFunded: boolean;
    firstShortfallYear: number | null;
  };
  confidence: {
    text: string;
    level: ConfidenceLevel;
    successRate: number | null;
    trials: number | null;
  };
  survivor: {
    text: string;
    applicable: boolean;
    cases: {
      personId: string;
      name: string;
      survivorId: string;
      survivorName: string;
      age: number;
      success: boolean;
      firstShortfallYear: number | null;
    }[];
  };
  risks: { id: string; text: string; source: string }[];
  assumptions: { label: string; value: string; source: string }[];
  figures: PartnerSummaryFigure[];
  caveats: string[];
}

/**
 * The survivor scenarios the summary evaluates: each partner at each of `PARTNER_SUMMARY_SURVIVOR_AGES` they
 * have not reached yet. The caller projects each `patch` and passes the results back as `survivors`.
 */
export function partnerSummarySurvivorCases(input: SimulationInput) {
  if (input.household.people.length < 2) return [];
  const sc = input.plan.startingConditions;
  const asOf = sc.kind === "snapshot" ? sc.finances.asOf : input.finances.asOf;
  const startMonth = monthIndex(asOf);
  return input.household.people.flatMap((p) =>
    PARTNER_SUMMARY_SURVIVOR_AGES.filter(
      (age) => monthIndex(p.birthMonth) + age * 12 > startMonth,
    ).map((age) => ({
      personId: p.id,
      age,
      patch: survivorScenario(input, { personId: p.id, age }).patch,
    })),
  );
}

function monthIndex(s: string): number {
  const [y, m] = s.split("-");
  return Number(y) * 12 + (Number(m) || 1) - 1;
}

/** Few numbers: money to three significant figures (48,250 -> 48,300), never more precise than 100. */
export function roundForPartner(v: number): number {
  const abs = Math.abs(v);
  if (abs < 1000) return Math.round(v / 100) * 100;
  const step = 10 ** (Math.floor(Math.log10(abs)) - 2);
  return Math.round(v / step) * step;
}

const wholePercent = (rate: number) => Math.round(rate * 100) / 100;

function rateText(spec: RateSpec, fmt: FormatContext): string | null {
  switch (spec.kind) {
    case "none":
      return "none";
    case "fixed":
      return `${fmtPercent(spec.rate, fmt)} a year`;
    case "schedule":
      return "changes over time";
    case "historical":
      return `historical ${spec.series}`;
    default:
      return null;
  }
}

const LEVEL_TEXT: Record<Exclude<ConfidenceLevel, "unknown">, string> = {
  high: "very likely to work",
  good: "likely to work",
  uncertain: "could go either way",
  low: "more likely to fall short than not",
};

function levelOf(rate: number): Exclude<ConfidenceLevel, "unknown"> {
  if (rate >= 0.9) return "high";
  if (rate >= 0.75) return "good";
  if (rate >= 0.5) return "uncertain";
  return "low";
}

const listNames = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** Build the partner summary from engine results. Pure. */
export function buildPartnerSummary(src: PartnerSummaryInput): PartnerSummary {
  const { input, result } = src;
  const plan: Plan = input.plan;
  const currency = input.household.currency;
  const locale = input.household.locale;
  const fmt: FormatContext = { currency, locale };
  const people = input.household.people.map((p) => ({ id: p.id, name: p.name }));
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  const figures: PartnerSummaryFigure[] = [];
  const fig = (
    id: string,
    kind: PartnerSummaryFigure["kind"],
    value: number,
    source: string,
  ): string => {
    let display: string;
    if (kind === "money") display = fmtMoney(roundForPartner(value), fmt);
    else if (kind === "percent") display = fmtPercent(wholePercent(value), { locale });
    else if (kind === "age") display = String(Math.floor(value));
    else display = String(value);
    figures.push({ id, display, value, kind, source });
    return display;
  };

  // ------------------------------------------------------------------ when can we stop working
  const retirementDef =
    plan.milestones.find(
      (m) =>
        m.kind === "retirement" &&
        (!m.personId ||
          input.household.people.find((p) => p.id === m.personId)?.role === "primary"),
    ) ?? null;
  const resolved = retirementDef
    ? (result.milestones.find((m) => m.milestoneId === retirementDef.id) ?? null)
    : null;
  const retirementYear = result.summary.retirementYear;
  const stopAges = resolved?.status === "reached" && resolved.month ? resolved.ages : {};
  const ages = Object.entries(stopAges)
    .filter(([id]) => people.some((p) => p.id === id))
    .map(([personId, age]) => ({ personId, name: nameOf(personId), age }));
  let stopText: string;
  if (retirementYear === null) {
    stopText = retirementDef
      ? "On the plan's assumptions, the point where you stop working is never reached."
      : "This plan does not set a point where you stop working.";
  } else {
    const y = fig("retirementYear", "year", retirementYear, "projection.summary.retirementYear");
    const ageBits = ages.map(
      (a) =>
        `${a.name} is ${fig(`retirementAge.${a.personId}`, "age", a.age, `projection.milestones[${retirementDef?.id}].ages.${a.personId}`)}`,
    );
    stopText = `You can stop working in ${y}${ageBits.length ? `, when ${listNames(ageBits)}` : ""}.`;
  }

  // ------------------------------------------------------------------ how much can we spend
  const periods = result.periods;
  const spendIdx =
    retirementYear !== null
      ? (() => {
          const i = periods.findIndex((p) => p.year === retirementYear + 1);
          return i >= 0 ? i : periods.findIndex((p) => p.year === retirementYear);
        })()
      : 0;
  const spendPeriod = spendIdx >= 0 ? periods[spendIdx] : undefined;
  const yearly = spendPeriod
    ? toBasis(spendPeriod.totals.spending, spendPeriod, "real", "flow")
    : null;
  const firstShortfallYear = result.summary.firstShortfallYear;
  let spendText: string;
  if (!spendPeriod || yearly === null) spendText = "The plan has no years to show spending for.";
  else {
    const amount = fig(
      "yearlySpending",
      "money",
      yearly,
      `projection.periods[${spendIdx}].totals.spending (today's money)`,
    );
    const when =
      retirementYear !== null
        ? `after you stop working (in ${fig("spendingYear", "year", spendPeriod.year, `projection.periods[${spendIdx}].year`)})`
        : `this year (${fig("spendingYear", "year", spendPeriod.year, `projection.periods[${spendIdx}].year`)})`;
    spendText = `The plan spends about ${amount} a year ${when}, in today's money.`;
    spendText += result.summary.success
      ? " Every year's spending is paid for to the end of the plan."
      : ` On the plan's own assumptions the money runs short in ${fig("firstShortfallYear", "year", firstShortfallYear ?? 0, "projection.summary.firstShortfallYear")}.`;
  }

  // ------------------------------------------------------------------ how confident
  const mc = src.monteCarlo ?? null;
  let confidence: PartnerSummary["confidence"];
  if (!mc) {
    confidence = {
      text: "The chance of success has not been worked out for this version of the plan yet.",
      level: "unknown",
      successRate: null,
      trials: null,
    };
  } else {
    const level = levelOf(mc.successRate);
    const pct = fig("successRate", "percent", mc.successRate, "monteCarlo.successRate");
    const n = fig("trials", "count", mc.trials, "monteCarlo.trials");
    confidence = {
      text: `The plan is ${LEVEL_TEXT[level]}: it pays for everything in ${pct} of ${n} simulated futures with different markets and inflation.`,
      level,
      successRate: mc.successRate,
      trials: mc.trials,
    };
  }

  // ------------------------------------------------------------------ if one of us dies
  const survivorCases: PartnerSummary["survivor"]["cases"] = [];
  for (const run of src.survivors ?? []) {
    const survivorP = people.find((p) => p.id !== run.personId);
    if (!survivorP) continue;
    survivorCases.push({
      personId: run.personId,
      name: nameOf(run.personId),
      survivorId: survivorP.id,
      survivorName: survivorP.name,
      age: run.age,
      success: run.result.summary.success,
      firstShortfallYear: run.result.summary.firstShortfallYear,
    });
  }
  const couple = people.length >= 2;
  let survivorText: string;
  const earliestFail = (personId: string) =>
    survivorCases
      .filter((c) => c.personId === personId && !c.success)
      .sort((a, b) => a.age - b.age)[0];
  const caseIndex = (c: (typeof survivorCases)[number]) => survivorCases.indexOf(c);
  if (!couple) survivorText = "This plan is for one person, so there is no survivor to check.";
  else if (!survivorCases.length)
    survivorText = "The survivor checks have not been run for this plan.";
  else {
    const parts: string[] = [];
    for (const p of people) {
      const own = survivorCases.filter((c) => c.personId === p.id);
      if (!own.length) continue;
      const fail = earliestFail(p.id);
      if (fail) {
        const i = caseIndex(fail);
        parts.push(
          `If ${p.name} died at ${fig(`survivor.${i}.age`, "age", fail.age, `survivorScenarios[${i}].age`)}, ${fail.survivorName} would run short of money in ${fig(`survivor.${i}.firstShortfallYear`, "year", fail.firstShortfallYear ?? 0, `survivorScenarios[${i}].projection.summary.firstShortfallYear`)}.`,
        );
      } else {
        const checked = own.map((c) =>
          fig(
            `survivor.${caseIndex(c)}.age`,
            "age",
            c.age,
            `survivorScenarios[${caseIndex(c)}].age`,
          ),
        );
        parts.push(
          `If ${p.name} died (checked at ages ${listNames(checked)}), ${own[0]!.survivorName} would still have enough to the end of the plan.`,
        );
      }
    }
    survivorText = `${parts.join(" ")} These checks keep spending the same and stop the income of the person who dies; pensions and Social Security pass on only where the plan says they do.`;
  }

  // ------------------------------------------------------------------ biggest risks
  const risks: PartnerSummary["risks"] = [];
  if (!result.summary.success && firstShortfallYear !== null)
    risks.push({
      id: "shortfall",
      source: "projection.summary.firstShortfallYear",
      text: `Even with steady markets, the money runs short in ${fig("risk.shortfall.year", "year", firstShortfallYear, "projection.summary.firstShortfallYear")}.`,
    });
  const worstSurvivor = survivorCases
    .filter((c) => !c.success)
    .sort((a, b) => (a.firstShortfallYear ?? 0) - (b.firstShortfallYear ?? 0))[0];
  if (worstSurvivor) {
    const i = caseIndex(worstSurvivor);
    risks.push({
      id: "survivor",
      source: `survivorScenarios[${i}].projection.summary.firstShortfallYear`,
      text: `Losing ${worstSurvivor.name} early: if ${worstSurvivor.name} died at ${fig(`risk.survivor.age`, "age", worstSurvivor.age, `survivorScenarios[${i}].age`)}, ${worstSurvivor.survivorName} would run short in ${fig("risk.survivor.year", "year", worstSurvivor.firstShortfallYear ?? 0, `survivorScenarios[${i}].projection.summary.firstShortfallYear`)}.`,
    });
  }
  if (mc && mc.successRate < 1)
    risks.push({
      id: "markets",
      source: "monteCarlo.successRate",
      text: `Markets and inflation: in ${fig("risk.markets.failShare", "percent", 1 - mc.successRate, "1 - monteCarlo.successRate")} of simulated futures the money runs out before the plan ends.`,
    });
  const worstBucket = mc?.sequenceRisk?.buckets[0];
  if (mc?.sequenceRisk && worstBucket && worstBucket.successRate < mc.successRate - 0.1)
    risks.push({
      id: "sequence",
      source: "monteCarlo.sequenceRisk.buckets[0].successRate",
      text: `Bad timing: if markets are poor in the first ${fig("risk.sequence.years", "count", mc.sequenceRisk.years, "monteCarlo.sequenceRisk.years")} years ${mc.sequenceRisk.anchor === "retirement" ? "after you stop working" : "of the plan"}, the plan works in only ${fig("risk.sequence.successRate", "percent", worstBucket.successRate, "monteCarlo.sequenceRisk.buckets[0].successRate")} of those futures.`,
    });
  for (const sev of ["critical", "warning"] as const)
    for (const f of (src.findings ?? []).filter((x) => x.severity === sev))
      risks.push({ id: `audit.${f.code}`, source: `audit:${f.code}`, text: `${f.title}.` });
  const topRisks = risks.slice(0, 3);

  // ------------------------------------------------------------------ what was assumed
  const a = plan.assumptions;
  const assumptions: PartnerSummary["assumptions"] = [];
  const pushRate = (label: string, spec: RateSpec, source: string) => {
    const v = rateText(spec, { locale });
    if (v !== null) assumptions.push({ label, value: v, source });
  };
  pushRate("Prices rise by", a.inflation, "plan.assumptions.inflation");
  pushRate("Shares grow by", a.stockReturn, "plan.assumptions.stockReturn");
  pushRate("Bonds grow by", a.bondReturn, "plan.assumptions.bondReturn");
  pushRate("Cash earns", a.cashReturn, "plan.assumptions.cashReturn");
  const lifeEnd = plan.milestones.filter((m) => m.kind === "life-expectancy");
  for (const m of lifeEnd) {
    const r = result.milestones.find((x) => x.milestoneId === m.id);
    const pid = m.personId;
    if (r?.status === "reached" && pid && r.ages[pid] !== undefined)
      assumptions.push({
        label: `${nameOf(pid)} lives to`,
        value: String(r.ages[pid]),
        source: `projection.milestones[${m.id}].ages.${pid}`,
      });
  }

  // ------------------------------------------------------------------ headline
  const headBits: string[] = [];
  if (retirementYear !== null) headBits.push(`you can stop working in ${retirementYear}`);
  if (confidence.successRate !== null)
    headBits.push(
      `the plan works in ${fmtPercent(wholePercent(confidence.successRate), { locale })} of simulated futures`,
    );
  else headBits.push(result.summary.success ? "the money lasts on the plan's assumptions" : "");
  const headline = headBits.filter(Boolean).length
    ? `${capitalise(listNames(headBits.filter(Boolean)))}.`
    : "Here is what the plan says, in plain words.";

  return {
    planId: plan.id,
    planVersion: result.meta.planVersion,
    planName: plan.name,
    currency,
    locale,
    people,
    headline,
    stopWork: {
      text: stopText,
      year: retirementYear,
      month: resolved?.month ?? null,
      ages,
    },
    spending: {
      text: spendText,
      yearly,
      year: spendPeriod?.year ?? null,
      allFunded: result.summary.success,
      firstShortfallYear,
    },
    confidence,
    survivor: { text: survivorText, applicable: couple, cases: survivorCases },
    risks: topRisks,
    assumptions,
    figures,
    caveats: [
      "These are estimates from the plan's assumptions, not predictions and not financial advice.",
      "Money is in today's prices: it already allows for the inflation assumed above.",
    ],
  };
}

const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
