/**
 * SYNTHETIC example data for analysis views whose engine pieces are not available yet. Every
 * value is invented. Fixtures are typed against the real contracts (ProjectionResult,
 * MonteCarloResult, GoalSeekResult, Finding...) and are always shown with an "Example data"
 * badge. Where possible they are derived from the REAL engine output of the active plan so
 * charts stay internally consistent.
 */

import {
  createRng,
  DEFAULT_OUTCOME_CATEGORIES,
  type Explanation,
  type Finding,
  type GoalSeekResult,
  type MarketPath,
  type MonteCarloResult,
  type MonteCarloSettings,
  type PlanDiff,
  type ProjectionResult,
} from "@glideworth/core";
import { total } from "../../lib/money";

// ---------------------------------------------------------------------------------------------
// Monte Carlo
// ---------------------------------------------------------------------------------------------

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

interface FixtureTrial {
  z: number[];
  nw: number[];
}

function fixtureTrials(det: ProjectionResult, n: number, seed: number): FixtureTrial[] {
  const P = det.periods;
  const base = P.map((p) => total(p, "netWorth", "real"));
  const out: FixtureTrial[] = [];
  for (let t = 0; t < n; t++) {
    const rng = createRng((seed + t * 7919) >>> 0);
    const z = P.map(() => rng.normal());
    let f = 1;
    const nw = base.map((b, i) => {
      f *= Math.exp(0.105 * z[i]! - 0.0055);
      return b * f;
    });
    out.push({ z, nw });
  }
  return out;
}

/** Synthetic chance-of-success result consistent with the deterministic projection. */
export function exampleMonteCarlo(
  det: ProjectionResult,
  settings: MonteCarloSettings,
): MonteCarloResult {
  const P = det.periods;
  const n = Math.min(settings.trials, 600);
  const seed = settings.seed ?? 424242;
  const trials = fixtureTrials(det, n, seed);
  const peak = Math.max(...P.map((p) => total(p, "netWorth", "real")), 1);
  const spend = (i: number) => (P[i]!.totals.spending ? total(P[i]!, "spending", "real") : 1);
  const retireIdx = Math.max(
    0,
    P.findIndex((p) => p.year === det.summary.retirementYear),
  );
  const cats = settings.outcomeCategories.length
    ? settings.outcomeCategories
    : DEFAULT_OUTCOME_CATEGORIES;
  const counts: Record<string, number> = Object.fromEntries(cats.map((c) => [c.id, 0]));
  const summaries = trials.map((tr, t) => {
    const fail = tr.nw.findIndex((v, i) => i >= retireIdx && v < 0.06 * peak);
    const success = fail < 0;
    const end = success ? tr.nw.at(-1)! : 0;
    let cat: string;
    if (success) {
      const mult = end / spend(P.length - 1);
      cat =
        cats
          .filter((c) => c.kind === "success")
          .sort((a, b) => b.threshold - a.threshold)
          .find((c) => mult >= c.threshold)?.id ?? "barely";
    } else {
      const share = fail / P.length;
      cat =
        cats
          .filter((c) => c.kind === "failure")
          .sort((a, b) => b.threshold - a.threshold)
          .find((c) => share >= c.threshold)?.id ?? "failed-early";
    }
    counts[cat] = (counts[cat] ?? 0) + 1;
    const early = tr.z.slice(retireIdx, retireIdx + 10);
    const earlyReturn = early.length
      ? Math.exp(early.reduce((s, x) => s + 0.105 * x, 0) / early.length) - 1 + 0.04
      : null;
    const milestones: Record<string, string | null> = {};
    for (const m of det.milestones) {
      if (!m.month) {
        milestones[m.milestoneId] = null;
        continue;
      }
      if (m.via === "time") milestones[m.milestoneId] = m.month;
      else {
        const shift = Math.round(tr.z.slice(0, 8).reduce((s, x) => s + x, 0) * -0.9);
        const y = Number(m.month.slice(0, 4)) + shift;
        milestones[m.milestoneId] = success || shift < 3 ? `${y}${m.month.slice(4)}` : null;
      }
    }
    return {
      trial: t,
      seed: (seed + t * 7919) >>> 0,
      startYear: null,
      success,
      firstShortfallYear: success ? null : P[fail]!.year,
      failureYear: success ? null : P[fail]!.year,
      endNetWorthReal: end,
      outcomeCategoryId: cat,
      milestones,
      earlyRealReturn: earlyReturn,
    };
  });
  const years = P.map((p) => p.year);
  const band = (pick: (tr: FixtureTrial, i: number) => number) =>
    settings.percentiles.map((p) => ({
      p,
      values: P.map((_, i) =>
        quantile(
          trials.map((tr) => pick(tr, i)).sort((a, b) => a - b),
          p,
        ),
      ),
    }));
  const nwPick = (tr: FixtureTrial, i: number) => {
    const s = summaries[trials.indexOf(tr)]!;
    return s.failureYear !== null && years[i]! >= s.failureYear ? 0 : tr.nw[i]!;
  };
  const percentiles = [
    { metric: "netWorth" as const, years, bands: band(nwPick) },
    {
      metric: "liquidNetWorth" as const,
      years,
      bands: band(
        (tr, i) => nwPick(tr, i) * (P[i]!.totals.liquidNetWorth / (P[i]!.totals.netWorth || 1)),
      ),
    },
    { metric: "spending" as const, years, bands: band((_tr, i) => spend(i)) },
  ];
  const hist = new Map<number, number>();
  for (const s of summaries)
    if (s.failureYear !== null) hist.set(s.failureYear, (hist.get(s.failureYear) ?? 0) + 1);
  const ranked = [...summaries].sort((a, b) => a.endNetWorthReal - b.endNetWorthReal);
  const rep = (i: number) => {
    const s = ranked[Math.min(ranked.length - 1, Math.max(0, i))]!;
    return { trial: s.trial, endNetWorthReal: s.endNetWorthReal, success: s.success };
  };
  const byEarly = [...summaries].sort(
    (a, b) => (a.earlyRealReturn ?? 0) - (b.earlyRealReturn ?? 0),
  );
  const buckets = [0, 1, 2, 3, 4].map((b) => {
    const slice = byEarly.slice(Math.floor((b * n) / 5), Math.floor(((b + 1) * n) / 5));
    const ends = slice.map((s) => s.endNetWorthReal).sort((a, c) => a - c);
    return {
      fromReturn: slice[0]?.earlyRealReturn ?? 0,
      toReturn: slice.at(-1)?.earlyRealReturn ?? 0,
      trials: slice.length,
      successRate: slice.filter((s) => s.success).length / (slice.length || 1),
      medianEndNetWorthReal: quantile(ends, 0.5),
    };
  });
  const people = Object.keys(P[0]?.ages ?? {});
  return {
    method: settings.method,
    trials: n,
    totalTrials: n,
    seed,
    successRate: summaries.filter((s) => s.success).length / n,
    outcomeCounts: counts,
    percentiles,
    years,
    ages: Object.fromEntries(people.map((id) => [id, P.map((p) => p.ages[id] ?? 0)])),
    milestoneTiming: det.milestones
      .filter((m) => m.status === "reached")
      .map((m) => {
        const months = summaries
          .map((s) => s.milestones[m.milestoneId])
          .filter((x): x is string => !!x)
          .sort();
        return {
          milestoneId: m.milestoneId,
          name: m.name,
          reachedShare: months.length / n,
          percentiles: [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => ({
            p,
            month: months.length
              ? months[Math.min(months.length - 1, Math.floor(p * months.length))]!
              : null,
          })),
          cumulativeShare: years.map(
            (y) => months.filter((mo) => Number(mo.slice(0, 4)) <= y).length / n,
          ),
        };
      }),
    trialSummaries: summaries,
    failureYearHistogram: [...hist.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, count]) => ({ year, count })),
    sequenceRisk: {
      anchor: "retirement",
      years: 10,
      bondShare: 0.3,
      buckets,
      rankCorrelation: 0.62,
    },
    representativeTrials: {
      worst: rep(0),
      p10: rep(Math.floor(n * 0.1)),
      median: rep(Math.floor(n / 2)),
      p90: rep(Math.floor(n * 0.9)),
      best: rep(n - 1),
    },
    deterministic: { success: det.summary.success, endNetWorthReal: det.summary.endNetWorthReal },
    durationMs: 0,
  };
}

/** Market path for an example trial (same draws as exampleMonteCarlo), to re-run in the engine. */
export function exampleTrialMarket(
  det: ProjectionResult,
  trial: number,
  seed = 424242,
): MarketPath {
  const rng = createRng((seed + trial * 7919) >>> 0);
  return {
    periods: det.periods.map((p) => {
      const z = rng.normal();
      return {
        ...p.market,
        stocks: p.market.stocks + 0.17 * z,
        bonds: p.market.bonds + 0.05 * z * 0.3,
        inflation: Math.max(-0.01, p.market.inflation + 0.012 * rng.normal()),
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Solvers and insights
// ---------------------------------------------------------------------------------------------

export function exampleGoalSeek(
  kind: "spending" | "retirement" | "savings",
  current: number,
): GoalSeekResult {
  const value = kind === "spending" ? 1.12 : kind === "retirement" ? current - 18 : 1.35;
  const metric = (v: number) =>
    Math.max(0, Math.min(1, 0.9 + (kind === "retirement" ? (v - value) / 60 : (value - v) * 0.6)));
  const evals = [0.6, 0.85, 1.0, 1.1, 1.12, 1.15].map((s) => {
    const v = kind === "retirement" ? current + (s - 1) * 60 : s * (kind === "savings" ? 1.2 : 1);
    return { value: v, metric: metric(v) };
  });
  return {
    converged: true,
    value,
    achieved: 0.902,
    evaluations: evals,
    sensitivity: [
      { label: "80% success", value: kind === "retirement" ? value - 14 : value * 1.09 },
      { label: "85% success", value: kind === "retirement" ? value - 7 : value * 1.04 },
      { label: "95% success", value: kind === "retirement" ? value + 11 : value * 0.93 },
    ],
    explanation:
      kind === "spending"
        ? "Example: spending could rise 12% and keep a 90% chance of success."
        : kind === "retirement"
          ? "Example: retirement could move 18 months earlier at 90% success."
          : "Example: contributions need to rise 35% to reach 90% success.",
  } as GoalSeekResult;
}

export function exampleFindings(det: ProjectionResult): Finding[] {
  const shortfall = det.periods.find((p) => p.status === "shortfall");
  return [
    {
      code: "HOUSING_DOUBLE_COUNT",
      severity: "warning",
      title: "Housing may be counted twice",
      message:
        "Your home already carries property tax, insurance and maintenance, and a living-expense line also looks like it includes housing.",
      periodIndex: null,
      refs: [],
      evidence: [{ source: "example" }],
      suggestion:
        "Reduce living expenses by the housing share, or turn off the home running costs.",
    },
    {
      code: "RETURNS_OPTIMISTIC",
      severity: "info",
      title: "Stock return assumption is at the high end",
      message:
        "A 6% real return is above the long-run global average after fees for a mixed portfolio.",
      periodIndex: null,
      refs: [],
      evidence: [{ source: "example" }],
      suggestion: "Try 4.5–5% to see how sensitive the plan is.",
    },
    ...(shortfall
      ? [
          {
            code: "SHORTFALL",
            severity: "critical" as const,
            title: `Spending is not fully funded from ${shortfall.year}`,
            message: "Liquid accounts run out while pensions are still locked.",
            periodIndex: shortfall.index,
            refs: [],
            evidence: [{ source: "example" }],
          },
        ]
      : []),
  ];
}

export function exampleExplanation(det: ProjectionResult): Explanation {
  const s = det.periods.find((p) => p.status === "shortfall");
  return {
    headline: s
      ? `Example: the plan first runs short in ${s.year} because withdrawals outpace growth after retirement.`
      : "Example: every year is funded; the tightest year is just after retirement.",
    findings: exampleFindings(det),
  };
}

export function exampleDiff(baseId: string, otherId: string): PlanDiff {
  return {
    basePlanId: baseId,
    otherPlanId: otherId,
    changes: [
      {
        path: "/milestones/[id=ms-retire]/criteria/0/age",
        kind: "changed",
        entity: { type: "milestone", id: "ms-retire", name: "Retirement" },
        before: 57,
        after: 52,
        description: "Retirement moved from age 57 to age 52",
      },
    ],
    patch: [{ op: "replace", path: "/milestones/[id=ms-retire]/criteria/0/age", value: 52 }],
  };
}
