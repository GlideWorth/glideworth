/**
 * Entry point of the calculators' engine side: runs a calculator on its inputs and returns the result
 * to render. Imported by the Web Worker (in the browser) and by the pages at build time. This is the
 * only module graph that pulls in @glideworth/core.
 */
import type { ToolId, Values, ViewModel } from "../types";
import { runBarista } from "./barista";
import { runCoast } from "./coast";
import type { RunOptions } from "./common";
import { runFatFire } from "./fat-fire";
import { runFire } from "./fire";
import { runHowLong } from "./how-long";
import { runMonteCarloTool } from "./monte-carlo";
import { runWithdrawal } from "./withdrawal";

const RUNNERS: Record<ToolId, (v: Values, opts: RunOptions) => Promise<ViewModel>> = {
  "coast-fire": runCoast,
  fire: runFire,
  "fat-fire": runFatFire,
  "barista-fire": runBarista,
  "how-long": runHowLong,
  withdrawal: runWithdrawal,
  "monte-carlo": runMonteCarloTool,
};

export type { RunOptions };

export function runTool(tool: ToolId, values: Values, opts: RunOptions = {}): Promise<ViewModel> {
  return RUNNERS[tool](values, opts);
}
