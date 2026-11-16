/** Messages between a calculator page and the engine worker. Structured-cloneable plain data only. */
import type { ToolId, Values, ViewModel } from "../types";

export type WorkerRequest =
  | { type: "run"; id: number; tool: ToolId; values: Values }
  | { type: "cancel"; id: number };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "progress"; id: number; done: number; total: number }
  | { type: "result"; id: number; vm: ViewModel; ms: number }
  | { type: "cancelled"; id: number }
  | { type: "error"; id: number; message: string };
