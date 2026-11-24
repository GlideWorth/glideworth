/**
 * Replays a calculator plan through every start year of US history (`historical-sequential` on
 * `us-1928`: one trial per start year whose whole horizon fits in the data, no looping) and returns
 * each start year's portfolio and spending in today's money. Used by the historical backtest and by the
 * guardrails calculator's bad and typical sequences.
 *
 * Engine use: `createMonteCarloSession` stepped in chunks (progress and cancel), metrics `portfolio`,
 * `spending` and `shortfall`; balances deflate by the end-of-year price index, flows by the
 * start-of-year index (the shard's `priceIndex` and `priceIndexStart`).
 */
import { createMonteCarloSession, type SimulationInput } from "@glideworth/core";
import { type RunOptions, stepSession } from "./common";
import { monteCarloSettings } from "./model";

export interface StartYearRun {
  /** First calendar year of the historical sequence. */
  startYear: number;
  /** Portfolio at the start (index 0) and at the end of each year, today's money. */
  portfolio: number[];
  /** What was paid each year (the engine's spending total), today's money. */
  spending: number[];
  /** Year of retirement (1-based) of the first year not paid in full; null when every year was. */
  firstShortYear: number | null;
  /** Portfolio at the end, today's money. */
  end: number;
  /** Lowest yearly spending paid, today's money. */
  minSpending: number;
}

/** Number of start years the data allows for a horizon (cheap: nothing is run). */
export function startYearCount(input: SimulationInput): number {
  return createMonteCarloSession(input, monteCarloSettings({ kind: "history-sequential" }, 1, 1))
    .total;
}

export async function replayHistory(
  input: SimulationInput,
  balance: number,
  opts: RunOptions & { offset?: number; total?: number } = {},
): Promise<StartYearRun[]> {
  const session = createMonteCarloSession(
    input,
    monteCarloSettings({ kind: "history-sequential" }, 1, 1),
    { metrics: ["portfolio", "spending", "shortfall"], keepTrials: false },
  );
  await stepSession(session, opts);
  const shard = session.shard();
  const Y = shard.years.length;
  const M = shard.metrics.length;
  const mi = (name: string) => shard.metrics.indexOf(name as (typeof shard.metrics)[number]);
  const [iP, iS, iF] = [mi("portfolio"), mi("spending"), mi("shortfall")];
  const out: StartYearRun[] = [];
  for (let t = 0; t < shard.trialIndex.length; t++) {
    const portfolio = [Math.max(0, balance)];
    const spending: number[] = [];
    let firstShortYear: number | null = null;
    for (let y = 0; y < Y; y++) {
      const stock = shard.priceIndex[t * Y + y] || 1;
      const flow = shard.priceIndexStart?.[t * Y + y] || stock;
      portfolio.push(Math.max(0, shard.values[(t * M + iP) * Y + y]! / stock));
      spending.push(Math.max(0, shard.values[(t * M + iS) * Y + y]! / flow));
      if (firstShortYear === null && shard.values[(t * M + iF) * Y + y]! > 1e-6)
        firstShortYear = y + 1;
    }
    out.push({
      startYear: shard.summaries[t]?.startYear ?? 0,
      portfolio,
      spending,
      firstShortYear,
      end: portfolio[Y] ?? 0,
      minSpending: spending.length ? Math.min(...spending) : 0,
    });
  }
  return out.sort((a, b) => a.startYear - b.startYear);
}

/**
 * Start years from worst to best for a plan: those with a year not paid in full first (earliest
 * first), then the lowest real balance at the end (or, with `by: 'spending'`, for rules whose
 * spending moves, the lowest yearly spending). Ties go to the earlier start year.
 */
export function worstFirst(
  runs: readonly StartYearRun[],
  by: "end" | "spending" = "end",
): StartYearRun[] {
  return [...runs].sort((a, b) => {
    const fa = a.firstShortYear ?? Number.POSITIVE_INFINITY;
    const fb = b.firstShortYear ?? Number.POSITIVE_INFINITY;
    if (fa !== fb) return fa - fb;
    if (by === "spending" && a.minSpending !== b.minSpending) return a.minSpending - b.minSpending;
    if (a.end !== b.end) return a.end - b.end;
    return a.startYear - b.startYear;
  });
}
