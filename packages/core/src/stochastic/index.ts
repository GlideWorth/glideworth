/**
 * Chance of success: Monte Carlo and historical runs. They REUSE the deterministic engine: each
 * trial is `simulate({ ...input, options: { market: path, lean: true, trace: 'off' } })` with a
 * MarketPath produced by the sampler. Owner: workstream (c).
 *
 * Entry points:
 *  - runMonteCarlo / runMonteCarloAsync / runHistorical  -> MonteCarloResult (summary)
 *  - createMonteCarloSession                               incremental (step, partial result, shard)
 *  - runMonteCarloShard + mergeMonteCarloShards + summarizeMonteCarlo   sharding across workers
 *  - runTrial / getTrialMarketPath                         inspect one trial in full
 *  - sampleMarketPath                                      path generator
 *  - HISTORICAL_SERIES                                     engine `historical` dep (deterministic sequences)
 */
export * from "./data/index.js";
export { cholesky } from "./math.js";
export * from "./rng.js";
export {
  createMonteCarloSession,
  getTrialMarketPath,
  MonteCarloAbortedError,
  type MonteCarloSession,
  type PrepareOptions,
  runHistorical,
  runMonteCarlo,
  runMonteCarloAsync,
  runMonteCarloShard,
  runTrial,
} from "./runner.js";
export {
  historicalYearIndexes,
  type SamplerContext,
  sampleMarketPath,
  trialCountFor,
} from "./samplers.js";
export { mergeMonteCarloShards, type SummarizeOptions, summarizeMonteCarlo } from "./summary.js";
export * from "./types.js";
