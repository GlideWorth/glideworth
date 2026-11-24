/**
 * Guardrails retirement calculator: Guyton-Klinger and risk-based guardrails in money terms, then the
 * year-by-year spending each would have paid through a bad and a typical stretch of US history.
 *
 * Engine use:
 *  - `guytonKlingerGuardrails` (core): the portfolio values at which the Guyton-Klinger rules would cut
 *    or raise, and the spending after each, with the visitor's guardrail width and adjustment.
 *  - `evaluateGuardrails` (core): risk-based guardrails. The plan's chance of success on one shared,
 *    seeded set of simulations (US history, random start years; the solver caps it at 500), the
 *    spending the rules give now, and the portfolio values at which the chance would leave the band.
 *    Every candidate the solver scores runs as a chunked session (solver-deps.ts), so it reports
 *    progress and can be cancelled.
 *  - History: `historical-sequential` replays (history-runs.ts) of three plans over every start year:
 *    constant real spending, the engine's `guyton-klinger` withdrawal rule, and risk-based guardrails
 *    applied year by year through the plan's `riskGuardrails` with the withdrawal-rate band derived
 *    from the thresholds (the same band `evaluateGuardrails` builds for its own path).
 * The bad sequence is the start year in which constant spending did worst; the typical one has the
 * median ending balance under constant spending.
 */
import {
  evaluateGuardrails,
  type GuardrailsResult,
  guytonKlingerGuardrails,
  MARKET_DATASETS,
  MonteCarloSettings,
  RiskGuardrails,
  type SimulationInput,
} from "@glideworth/core";
import { money, pct, pctInput, whole, wholeYears } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, Table, Timing, Values, ViewModel } from "../types";
import { checkAbort, percentile, type RunOptions } from "./common";
import { replayHistory, type StartYearRun, startYearCount, worstFirst } from "./history-runs";
import { buildInput, HISTORY_DATASET, monteCarloSettings, taxText, timingText } from "./model";
import { solverRun } from "./solver-deps";

/** Trials per candidate in the risk-based solve: the engine's own cap for guardrail solves. */
export const RISK_TRIALS = 500;
/** About how many candidates `evaluateGuardrails` scores (progress estimate only). */
const EXPECTED_EVALUATIONS = 50;

/** The engine's default risk-based settings (read from the schema, never typed in). */
export const RISK_DEFAULTS = RiskGuardrails.parse({ start: { kind: "planStart" } });

export interface GuardrailsAnswer {
  gk: ReturnType<typeof guytonKlingerGuardrails>;
  risk: GuardrailsResult;
  /** Constant spending, Guyton-Klinger and risk-based guardrails over every start year. */
  history: { constant: StartYearRun[]; gk: StartYearRun[]; risk: StartYearRun[] };
  bad: number;
  typical: number;
}

function baseInput(v: Values, spending: number): SimulationInput {
  return buildInput({
    currency: str(v, "cur"),
    age: 65,
    years: num(v, "years"),
    balance: num(v, "balance"),
    timing: str(v, "timing") as Timing,
    taxRate: rate(v, "tax"),
    realReturn: 0,
    stockShare: rate(v, "stocks"),
    spending: [{ id: "spending", name: "Spending", amount: spending, from: 0, to: null }],
  });
}

function riskSettings(v: Values) {
  return {
    start: { kind: "planStart" as const },
    scope: "all" as const,
    targetSuccess: rate(v, "target"),
    lowerGuardrail: rate(v, "lower"),
    upperGuardrail: rate(v, "upper"),
  };
}

/** Both guardrail methods and the historical replays. Needs a positive portfolio and spending. */
export async function guardrails(v: Values, opts: RunOptions = {}): Promise<GuardrailsAnswer> {
  const balance = num(v, "balance");
  const spend = num(v, "spend");
  const years = num(v, "years");
  const guardrail = rate(v, "band");
  const adjustment = rate(v, "adj");
  const gk = guytonKlingerGuardrails({
    portfolio: balance,
    spending: spend,
    guardrail,
    adjustment,
    yearsRemaining: years,
    currency: str(v, "cur"),
  });

  const constantInput = baseInput(v, spend);
  const n = startYearCount(constantInput);
  const gkInput = buildInput({
    currency: str(v, "cur"),
    age: 65,
    years,
    balance,
    timing: str(v, "timing") as Timing,
    taxRate: rate(v, "tax"),
    realReturn: 0,
    stockShare: rate(v, "stocks"),
    withdrawalStrategy: {
      rule: { kind: "guyton-klinger", rate: Math.min(10, spend / balance), guardrail, adjustment },
      treatAsSpending: false,
    },
  });
  const total = (extra: number) => ({ total: 3 * n + extra });
  const constant = await replayHistory(constantInput, balance, { ...opts, ...total(0) });
  const gkRuns = await replayHistory(gkInput, balance, { ...opts, offset: n, ...total(0) });

  // Risk-based guardrails on one seeded set of simulations (US history, random start years).
  const mc = MonteCarloSettings.parse(
    monteCarloSettings({ kind: "history" }, RISK_TRIALS, num(v, "seed")),
  );
  const riskInput: SimulationInput = {
    ...constantInput,
    plan: { ...constantInput.plan, monteCarlo: mc },
  };
  const solver = solverRun(opts, EXPECTED_EVALUATIONS, { offset: 2 * n, tail: n });
  const risk = await evaluateGuardrails(riskInput, riskSettings(v), solver.deps);
  checkAbort(opts.signal);

  // Risk-based guardrails applied year by year: the engine's riskGuardrails with the withdrawal-rate
  // band the thresholds imply (cut above spending ÷ lower portfolio, raise below spending ÷ upper).
  const t = risk.thresholds!;
  const recommended = t.recommendedSpending;
  const bandInput = baseInput(v, recommended);
  const guarded: SimulationInput = {
    ...bandInput,
    plan: {
      ...bandInput.plan,
      riskGuardrails: RiskGuardrails.parse({
        ...riskSettings(v),
        enabled: true,
        withdrawalRateBand: {
          cutAbove: t.lowerPortfolio ? Math.min(10, recommended / t.lowerPortfolio) : 10,
          raiseBelow: t.upperPortfolio ? Math.min(10, recommended / t.upperPortfolio) : 0,
        },
      }),
    },
  };
  const riskRuns = await replayHistory(guarded, balance, {
    ...opts,
    offset: 2 * n + solver.trialsRun,
    total: 3 * n + solver.trialsRun,
  });

  const ranked = worstFirst(constant);
  const byEnd = [...constant].sort((a, b) => a.end - b.end || a.startYear - b.startYear);
  return {
    gk,
    risk,
    history: { constant, gk: gkRuns, risk: riskRuns },
    bad: ranked[0]?.startYear ?? 0,
    typical: byEnd[Math.floor((byEnd.length - 1) / 2)]?.startYear ?? 0,
  };
}

const actionWord = (a: "hold" | "cut" | "raise") =>
  a === "cut" ? "Cut" : a === "raise" ? "Raise" : "Hold";

function sequenceChart(
  id: string,
  title: string,
  startYear: number,
  a: GuardrailsAnswer,
  years: number,
  cur: string,
): ChartSpec {
  const m = (x: number) => money(x, cur);
  const pick = (runs: StartYearRun[]) => runs.find((r) => r.startYear === startYear);
  const c = pick(a.history.constant);
  const g = pick(a.history.gk);
  const r = pick(a.history.risk);
  const x = Array.from({ length: years }, (_, i) => i + 1);
  const at = (run: StartYearRun | undefined, i: number) => run?.spending[i] ?? 0;
  const low = (run: StartYearRun | undefined) => (run ? run.minSpending : 0);
  return {
    id,
    kind: "line",
    title: `${title}: retiring at the start of ${startYear}`,
    summary: `Spending each year in today’s money for a retirement starting in ${startYear}. Guyton-Klinger’s lowest year was ${m(low(g))} and risk-based guardrails’ lowest ${m(low(r))}; constant spending ${c?.firstShortYear ? `ran short from year ${c.firstShortYear}` : `was paid every year and left ${m(c?.end ?? 0)}`}. Guyton-Klinger left ${m(g?.end ?? 0)} and risk-based guardrails ${m(r?.end ?? 0)}.`,
    xLabel: "Year of retirement",
    yLabel: "Today’s money",
    x,
    series: [
      { label: "Guyton-Klinger", values: x.map((_, i) => at(g, i)), tone: 1, style: "solid" },
      {
        label: "Risk-based guardrails",
        values: x.map((_, i) => at(r, i)),
        tone: 2,
        style: "dashed",
      },
      { label: "Constant spending", values: x.map((_, i) => at(c, i)), tone: 3, style: "dotted" },
    ],
    currency: cur,
    table: {
      caption: `Spending by year for a retirement starting in ${startYear} (today’s money)`,
      columns: ["Year", "Guyton-Klinger", "Risk-based", "Constant", "Portfolio (Guyton-Klinger)"],
      rows: x.map((y, i) => [
        String(y),
        m(at(g, i)),
        m(at(r, i)),
        m(at(c, i)),
        m(g?.portfolio[y] ?? 0),
      ]),
    },
  };
}

function historySummary(a: GuardrailsAnswer, years: number, cur: string): Table {
  const m = (x: number) => money(x, cur);
  const row = (name: string, runs: StartYearRun[]) => [
    name,
    m(runs[0]?.spending[0] ?? 0),
    m(runs.length ? Math.min(...runs.map((r) => r.minSpending)) : 0),
    m(
      runs.length
        ? percentile(
            runs.map((r) => r.minSpending),
            0.5,
          )
        : 0,
    ),
    `${runs.filter((r) => r.firstShortYear !== null).length} of ${runs.length}`,
    m(
      runs.length
        ? percentile(
            runs.map((r) => r.end),
            0.5,
          )
        : 0,
    ),
  ];
  return {
    caption: `Every start year of US history with ${years} years after it (today’s money)`,
    columns: [
      "",
      "Year-1 spending",
      "Lowest year, any start",
      "Median of each start’s lowest year",
      "Start years with a year not paid in full",
      "Median portfolio at the end",
    ],
    rows: [
      row("Guyton-Klinger", a.history.gk),
      row("Risk-based guardrails", a.history.risk),
      row("Constant spending", a.history.constant),
    ],
  };
}

export async function runGuardrails(v: Values, opts: RunOptions = {}): Promise<ViewModel> {
  const balance = num(v, "balance");
  const spend = num(v, "spend");
  const years = num(v, "years");
  const stocks = rate(v, "stocks");
  const seed = num(v, "seed");
  const timing = str(v, "timing") as Timing;
  const cur = str(v, "cur");
  const m = (x: number) => money(x, cur);
  const ds = MARKET_DATASETS[HISTORY_DATASET];
  const common = [timingText(timing), taxText(rate(v, "tax"))];

  if (balance <= 0 || spend <= 0)
    return {
      tool: "guardrails",
      headline:
        balance <= 0
          ? "With no portfolio there is nothing to withdraw, so there are no guardrails to set."
          : "With no spending there is no withdrawal rate, so there are no guardrails to set.",
      announce: "Enter a portfolio and yearly spending above zero.",
      figures: [],
      charts: [],
      method: common,
      warnings: [],
    };

  const a = await guardrails(v, opts);
  const gk = a.gk;
  const risk = a.risk;
  const t = risk.thresholds!;
  const s0 = risk.currentSuccessRate ?? risk.current.successRate;
  const lower = rate(v, "lower");
  const upper = rate(v, "upper");
  const target = rate(v, "target");
  const band = rate(v, "band");
  const adj = rate(v, "adj");
  const n = a.history.constant.length;
  const noCut = years <= 15;

  const riskNow =
    risk.current.action === "hold"
      ? `hold spending at ${m(t.recommendedSpending)}`
      : risk.current.action === "raise"
        ? `raise spending to ${m(t.recommendedSpending)}`
        : risk.targetReachable === false
          ? `cut spending to ${m(t.recommendedSpending)}, and even that does not reach ${pct(target, 0)}`
          : `cut spending to ${m(t.recommendedSpending)}`;
  const headline = `At ${m(spend)} a year from ${m(balance)} (${pctInput(Number(((spend / balance) * 100).toFixed(2)))}), Guyton-Klinger would ${noCut ? "not cut in a plan of 15 years or less" : `cut ${pct(adj, 0)} to ${m(gk.spendingAfterCut)} if the portfolio fell below ${m(gk.cutBelowPortfolio)}`} and raise ${pct(adj, 0)} to ${m(gk.spendingAfterRaise)} above ${m(gk.raiseAbovePortfolio)}. Your chance of success is ${pct(s0, 0)}, so risk-based guardrails ${riskNow}${t.lowerPortfolio !== null && t.cutTo !== null ? `, and would cut to ${m(t.cutTo)} below ${m(t.lowerPortfolio)}` : ""}.`;

  const bandText = [
    t.lowerPortfolio
      ? `cut when spending ÷ portfolio is above ${pct(t.recommendedSpending / t.lowerPortfolio, 2)}`
      : "no cut",
    t.upperPortfolio
      ? `raise when it is below ${pct(t.recommendedSpending / t.upperPortfolio, 2)}`
      : "no raise",
  ].join(", ");
  const fmtOr = (x: number | null, none: string) => (x === null ? none : m(x));
  const table: Table = {
    caption: "Your guardrails in money (today’s money)",
    columns: ["", "Guyton-Klinger", "Risk-based"],
    rows: [
      [
        "Spending now",
        `${m(spend)} (hold)`,
        `${m(t.recommendedSpending)} (${actionWord(risk.current.action).toLowerCase()})`,
      ],
      [
        "Cut if the portfolio falls below",
        noCut ? "No cuts: 15 years or less" : m(gk.cutBelowPortfolio),
        fmtOr(t.cutTo === null ? null : t.lowerPortfolio, "No lower threshold"),
      ],
      ["Spending after that cut", noCut ? "–" : m(gk.spendingAfterCut), fmtOr(t.cutTo, "–")],
      [
        "Raise if the portfolio rises above",
        m(gk.raiseAbovePortfolio),
        fmtOr(t.raiseTo === null ? null : t.upperPortfolio, "No upper threshold"),
      ],
      ["Spending after that raise", m(gk.spendingAfterRaise), fmtOr(t.raiseTo, "–")],
      [
        "What sets it off",
        `Withdrawal rate above ${pct(gk.upperRateLimit, 2)} or below ${pct(gk.lowerRateLimit, 2)}`,
        `Chance of success below ${pct(lower, 0)} or above ${pct(upper, 0)}`,
      ],
    ],
  };

  return {
    tool: "guardrails",
    headline,
    announce: `Guardrail spending now ${m(t.recommendedSpending)}; chance of success ${pct(s0, 0)}.`,
    figures: [
      {
        label: "Guardrail spending now",
        value: m(t.recommendedSpending),
        detail: `Risk-based: ${actionWord(risk.current.action).toLowerCase()} (chance of success ${pct(s0, 0)})`,
      },
      {
        label: "Guyton-Klinger: cut below",
        value: noCut ? "No cuts" : m(gk.cutBelowPortfolio),
        detail: noCut ? "Not in the last 15 years" : `Then spend ${m(gk.spendingAfterCut)}`,
      },
      {
        label: "Guyton-Klinger: raise above",
        value: m(gk.raiseAbovePortfolio),
        detail: `Then spend ${m(gk.spendingAfterRaise)}`,
      },
      {
        label: "Risk-based: cut below",
        value: fmtOr(t.cutTo === null ? null : t.lowerPortfolio, "None"),
        detail: t.cutTo === null ? "No cut to offer" : `Then spend ${m(t.cutTo)}`,
      },
    ],
    table,
    charts: n
      ? [
          sequenceChart("gr-bad", "A bad sequence", a.bad, a, years, cur),
          sequenceChart("gr-typical", "A typical sequence", a.typical, a, years, cur),
        ]
      : [],
    extraTables: n ? [historySummary(a, years, cur)] : [],
    method: [
      `Guyton-Klinger (core guytonKlingerGuardrails): the initial rate is your spending ÷ portfolio. The rules cut by ${pct(adj, 0)} when the withdrawal rate rises more than ${pct(band, 0)} above it (not in the last 15 years) and raise by ${pct(adj, 0)} when it falls more than ${pct(band, 0)} below; the portfolio values are your spending divided by those two rates. If you are already retired, the bands are centred on today’s rate.`,
      `Risk-based guardrails (core evaluateGuardrails): chance of success from ${whole(RISK_TRIALS)} simulations with seed ${seed}, US history with random start years from ${ds.label}, ${pctInput(stocks * 100)} stocks and ${pctInput(100 - stocks * 100)} bonds. Below ${pct(lower, 0)} spending is cut back to the ${pct(target, 0)} target; above ${pct(upper, 0)} it is raised to it. The portfolio thresholds are where the chance would cross ${pct(lower, 0)} and ${pct(upper, 0)} at that spending, all on the same simulations.`,
      `History: every start year from ${ds.label} with ${years} years after it (${n} of them), replayed once each in real order. Guyton-Klinger is the engine’s guyton-klinger withdrawal rule; risk-based guardrails are applied year by year as a withdrawal-rate band (${bandText}, by the engine’s default step of ${pct(RISK_DEFAULTS.adjustmentStep, 0)}). The bad sequence (${a.bad}) is the start year where constant spending did worst; the typical one (${a.typical}) has the median ending balance under constant spending.`,
      ...common,
    ],
    warnings: [
      ...(risk.targetReachable === false
        ? [
            `Cutting spending to zero does not reach a ${pct(target, 0)} chance of success over ${wholeYears(years)} on these simulations.`,
          ]
        : []),
    ],
  };
}
