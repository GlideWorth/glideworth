/**
 * Retirement spending calculator: the most you can spend every year, steady in today's money, while
 * keeping a chosen chance that every year is paid, with optional other income from an age, and the
 * spend-down of the portfolio at that spending.
 *
 * Engine use:
 *  - `solveMaxSpending` (core goal seek, objective 'successRate', variable 'spendingScale' on one
 *    yearly expense, tolerance 0.0025 of that expense). Every candidate is a seeded Monte Carlo on the
 *    same market paths (common random numbers), run as a chunked session so it shows progress and
 *    can be cancelled (solver-deps.ts). Neighbouring targets come from the solver's own sensitivity
 *    re-solves, which reuse its cached evaluations.
 *  - The spend-down: `createMonteCarloSession` at the answer, same settings and seed, for the
 *    portfolio percentiles by age.
 * Market models as in the Monte Carlo calculator: US history (random start years or 5-year blocks)
 * or log-normal random real returns.
 */
import {
  createMonteCarloSession,
  type GoalSeekResult,
  MonteCarloSettings,
  type SimulationInput,
  solveMaxSpending,
} from "@glideworth/core";
import { money, pct, whole, wholeYears } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, Timing, Values, ViewModel } from "../types";
import { type RunOptions, stepSession } from "./common";
import { buildInput, monteCarloSettings, taxText, timingText, type Window } from "./model";
import { marketModel, modelText } from "./monte-carlo";
import { solverRun } from "./solver-deps";

/** Neighbouring chances of success shown beside the answer (percentage points from the target). */
export const NEIGHBOURS = [-10, -5, 5, 10] as const;
/** Upper search bound, as a multiple of the starting guess (portfolio ÷ years + other income). */
const MAX_SCALE = 6;
const EXPECTED_EVALUATIONS = 40;

export interface SpendingAnswer {
  /** Most yearly spending (today's money) that keeps the target; null when even 0 misses it. */
  spending: number | null;
  /** True when the answer is the search's upper limit (the true answer may be higher). */
  atLimit: boolean;
  /** Chance of success at the answer, on the solver's simulations. */
  achieved: number | null;
  /** Spending at neighbouring targets (fractions), ascending by target. */
  neighbours: { target: number; spending: number | null }[];
  evaluations: number;
  solve: GoalSeekResult;
}

/** "a 90%" or "an 85%" (eight, eleven, eighteen and the eighties take "an"). */
export function aPct(fraction: number): string {
  const p = Math.round(fraction * 100);
  return `${p === 8 || p === 11 || p === 18 || (p >= 80 && p < 90) ? "an" : "a"} ${p}%`;
}

/** The plan's horizon and other-income window from the form. */
function windows(v: Values): { years: number; income: Window[] } {
  const age = num(v, "age");
  const years = num(v, "planTo") - age;
  const inc = num(v, "inc");
  const from = Math.max(0, num(v, "incAge") - age);
  return {
    years,
    income:
      inc > 0 && from < years
        ? [{ id: "income", name: "Other income", amount: inc, from, to: null }]
        : [],
  };
}

function planInput(v: Values, spending: number): SimulationInput {
  const model = marketModel(v);
  const { years, income } = windows(v);
  const input = buildInput({
    currency: str(v, "cur"),
    age: num(v, "age"),
    years,
    balance: num(v, "balance"),
    timing: str(v, "timing") as Timing,
    taxRate: rate(v, "tax"),
    realReturn: model.kind === "parametric" ? model.mean : 0,
    ...(model.kind === "parametric" ? {} : { stockShare: rate(v, "stocks") }),
    spending: [{ id: "spending", name: "Spending", amount: spending, from: 0, to: null }],
    income,
  });
  const mc = MonteCarloSettings.parse(
    monteCarloSettings(model, Number(str(v, "trials")), num(v, "seed")),
  );
  return { ...input, plan: { ...input.plan, monteCarlo: mc } };
}

/** The starting guess the solver scales: the portfolio spread evenly over the years, plus income. */
export function baseSpending(v: Values): number {
  const { years } = windows(v);
  return num(v, "balance") / Math.max(1, years) + num(v, "inc");
}

export async function maxSpending(v: Values, opts: RunOptions = {}): Promise<SpendingAnswer> {
  const target = rate(v, "target");
  const base = baseSpending(v);
  const input = planInput(v, base);
  const deltas = NEIGHBOURS.map((d) => d / 100).filter(
    (d) => target + d >= 0.5 - 1e-9 && target + d <= 0.99 + 1e-9,
  );
  const run = solverRun(opts, EXPECTED_EVALUATIONS, { tail: Number(str(v, "trials")) });
  const solve = await solveMaxSpending(
    input,
    {
      targetSuccessRate: target,
      monteCarlo: input.plan.monteCarlo,
      bounds: { min: 0, max: MAX_SCALE },
      sensitivityDeltas: deltas,
    },
    run.deps,
  );
  const neighbours = deltas.map((d, i) => {
    const k = solve.sensitivity[i]?.value ?? null;
    return { target: Math.round((target + d) * 100) / 100, spending: k === null ? null : k * base };
  });
  return {
    spending: solve.value === null ? null : solve.value * base,
    atLimit: solve.status === "at-bound",
    achieved: solve.achieved,
    neighbours,
    evaluations: run.evaluations,
    solve,
  };
}

/** The Monte Carlo at a given spending: same settings and seed as the solve. */
export async function spendDown(
  v: Values,
  spending: number,
  opts: RunOptions & { offset?: number; total?: number } = {},
) {
  const input = planInput(v, spending);
  const session = createMonteCarloSession(input, input.plan.monteCarlo, {
    metrics: ["portfolio"],
    keepTrials: true,
  });
  await stepSession(session, opts);
  return session.result();
}

export async function runRetirementSpending(v: Values, opts: RunOptions = {}): Promise<ViewModel> {
  const balance = num(v, "balance");
  const age = num(v, "age");
  const target = rate(v, "target");
  const inc = num(v, "inc");
  const incAge = num(v, "incAge");
  const trials = Number(str(v, "trials"));
  const seed = num(v, "seed");
  const stocks = rate(v, "stocks");
  const timing = str(v, "timing") as Timing;
  const cur = str(v, "cur");
  const m = (x: number) => money(x, cur);
  const model = marketModel(v);
  const { years, income } = windows(v);
  const incomeUsed = income.length > 0;
  const incomeFrom = Math.max(age, incAge);

  const common = [
    modelText(model, stocks),
    ...(incomeUsed
      ? [
          `Other income of ${m(inc)} a year (after tax, rising with inflation) from age ${incomeFrom}; it is spent first and the portfolio pays the rest.`,
        ]
      : []),
    timingText(timing),
    taxText(rate(v, "tax")),
  ];

  if (balance <= 0 && !incomeUsed)
    return {
      tool: "retirement-spending",
      headline: "With no portfolio and no other income, there is nothing to spend.",
      announce: "Nothing to spend.",
      figures: [],
      charts: [],
      method: common,
      warnings: [],
    };

  const ans = await maxSpending(v, opts);
  const spending = ans.spending ?? 0;
  const done = ans.evaluations * trials;
  const r = await spendDown(v, spending, { ...opts, offset: done, total: done + trials });
  const band = r.percentiles.find((s) => s.metric === "portfolio");
  const at = (q: number) => [
    balance,
    ...(band?.bands.find((b) => Math.abs(b.p - q) < 1e-9)?.values ?? []),
  ];
  const Y = band?.years.length ?? 0;
  const p10 = at(0.1);
  const p25 = at(0.25);
  const p50 = at(0.5);
  const p75 = at(0.75);
  const p90 = at(0.9);
  const ages = Array.from({ length: Y + 1 }, (_, i) => age + i);
  const firstDraw = Math.max(0, spending - (incomeUsed && incomeFrom <= age ? inc : 0));
  const rateNow = balance > 0 ? firstDraw / balance : 0;
  const limit = ans.atLimit ? "at least " : "";

  const fan: ChartSpec = {
    id: "rs-fan",
    kind: "line",
    title: `Portfolio spending ${m(spending)} a year, in today’s money`,
    summary: `Half the simulations still hold more than ${m(p50[Y] ?? 0)} at age ${age + Y}; one in ten holds less than ${m(p10[Y] ?? 0)}, and one in ten more than ${m(p90[Y] ?? 0)}.`,
    xLabel: "Age",
    yLabel: "Today’s money",
    x: ages,
    bands: [
      {
        label: "10th to 90th percentile (lighter band)",
        lower: p10,
        upper: p90,
        tone: 1,
        level: "outer",
      },
      {
        label: "25th to 75th percentile (darker band)",
        lower: p25,
        upper: p75,
        tone: 1,
        level: "inner",
      },
    ],
    series: [{ label: "Median (50th percentile)", values: p50, tone: 1, style: "solid" }],
    markers:
      incomeUsed && incomeFrom > age ? [{ x: incomeFrom, label: `Income from ${incomeFrom}` }] : [],
    currency: cur,
    table: {
      caption: "Portfolio percentiles at the end of each year of age (today’s money)",
      columns: ["Age", "10th", "25th", "Median", "75th", "90th"],
      rows: ages.map((a, i) => [
        String(a),
        m(p10[i] ?? 0),
        m(p25[i] ?? 0),
        m(p50[i] ?? 0),
        m(p75[i] ?? 0),
        m(p90[i] ?? 0),
      ]),
    },
  };

  const rows = [
    ...ans.neighbours.filter((x) => x.target < target - 1e-9),
    { target, spending: ans.spending },
    ...ans.neighbours.filter((x) => x.target > target + 1e-9),
  ];
  const tradeOff = {
    caption: "Spending at other chances of success (same simulations, today’s money)",
    columns: ["Chance every year is paid", "Most yearly spending", "From the portfolio in year 1"],
    rows: rows.map((x) => [
      `${pct(x.target, 0)}${Math.abs(x.target - target) < 1e-9 ? " (your target)" : ""}`,
      x.spending === null ? "None reaches it" : m(x.spending),
      x.spending === null || balance <= 0
        ? "–"
        : pct(Math.max(0, x.spending - (incomeUsed && incomeFrom <= age ? inc : 0)) / balance, 2),
    ]),
  };

  const headline =
    ans.spending === null
      ? `No level of spending reaches ${aPct(target)} chance that every year to age ${age + years} is paid: even spending nothing before the income starts is not enough on these simulations.`
      : `You can spend ${limit}${m(spending)} a year in today’s money from age ${age} to ${age + years} with ${aPct(target)} chance that every year is paid${incomeUsed ? `, counting ${m(inc)} a year of other income from age ${incomeFrom}` : ""}. That is ${pct(rateNow, 2)} of ${m(balance)} drawn from the portfolio in year 1.`;

  return {
    tool: "retirement-spending",
    headline,
    announce:
      ans.spending === null
        ? "No spending reaches the target."
        : `Most yearly spending ${m(spending)} at ${pct(target, 0)}.`,
    figures: [
      {
        label: `Most yearly spending at ${pct(target, 0)}`,
        value: ans.spending === null ? "None" : `${ans.atLimit ? "≥ " : ""}${m(spending)}`,
        detail: "Today’s money, every year",
      },
      {
        label: "Chance of success at that spending",
        value: pct(r.successRate, 1),
        detail: `${whole(Math.round(r.successRate * r.trials))} of ${whole(r.trials)} simulations`,
      },
      {
        label: "Year-1 withdrawal rate",
        value: balance > 0 ? pct(rateNow, 2) : "–",
        detail:
          incomeUsed && incomeFrom <= age ? "After other income" : "Of the starting portfolio",
      },
      {
        label: `Median portfolio at ${age + Y}`,
        value: m(p50[Y] ?? 0),
        detail: `10th percentile ${m(p10[Y] ?? 0)}`,
      },
    ],
    table: tradeOff,
    charts: [fan],
    method: [
      `Solver: the engine’s solveMaxSpending searches for the largest steady yearly spending whose chance that every year is paid is at least ${pct(target, 0)}, to within ${m(baseSpending(v) * 0.0025)} (${ans.evaluations} candidate spending levels, each a full run of ${whole(trials)} simulations with seed ${seed}; every candidate sees the same market paths, so the answer does not move with sampling noise between candidates).`,
      `The plan runs ${wholeYears(years)}, from age ${age} to ${age + years}. Success: every year’s spending paid in full (the engine’s “all funded” definition).`,
      ...common,
    ],
    warnings: [
      ...(ans.atLimit
        ? [
            `The answer is the top of the search range (${MAX_SCALE} times the portfolio spread evenly over the years plus income); the true limit is higher.`,
          ]
        : []),
      ...(inc > 0 && !incomeUsed
        ? [
            `The other income starts at ${incAge}, at or after the end of the plan, so it is not counted.`,
          ]
        : []),
    ],
  };
}
