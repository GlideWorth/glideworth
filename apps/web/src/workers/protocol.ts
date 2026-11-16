import type { ProjectionResult, SimulationInput } from "@glideworth/core";

/** Messages to the simulation worker. Workstream (c) adds 'monteCarlo' with trial sharding. */
export type WorkerRequest = { id: number; kind: "simulate"; input: SimulationInput };

export interface WorkerErrorPayload {
  name: string;
  message: string;
  code?: string;
  feature?: string;
  workstream?: string;
}

export type WorkerResponse =
  | { id: number; ok: true; kind: "simulate"; result: ProjectionResult; ms: number }
  | { id: number; ok: false; error: WorkerErrorPayload };
