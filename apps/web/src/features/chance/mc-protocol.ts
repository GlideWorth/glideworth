/**
 * Messages for the chance-of-success worker pool. Each worker runs one shard of trials with
 * core's incremental Monte Carlo session and posts progress, then the raw mergeable shard.
 */
import type {
  MarketPath,
  MonteCarloSettings,
  MonteCarloShard,
  ProjectionResult,
  SimulationInput,
  StochasticMetric,
} from "@glideworth/core";
import type { WorkerErrorPayload } from "../../workers/protocol";

export type McRequest =
  | {
      id: number;
      kind: "shard";
      input: SimulationInput;
      settings: MonteCarloSettings;
      shardIndex: number;
      shardCount: number;
      /** Omit to record every series. An empty list records none; the success rate still comes back. */
      metrics?: readonly StochasticMetric[];
    }
  | {
      id: number;
      kind: "trial";
      input: SimulationInput;
      settings: MonteCarloSettings;
      trial: number;
    };

export type McResponse =
  | { id: number; kind: "progress"; done: number; total: number }
  | { id: number; kind: "shard"; shard: MonteCarloShard; ms: number }
  | { id: number; kind: "trial"; market: MarketPath; result: ProjectionResult }
  | { id: number; kind: "error"; error: WorkerErrorPayload };
