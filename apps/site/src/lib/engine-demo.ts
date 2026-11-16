/**
 * Runs a deterministic projection of the synthetic sample household in the browser. Imported lazily
 * by /tools/engine-check/ (`await import('../../lib/engine-demo')`), so the engine is its own chunk and
 * only downloads when asked for. Calculators in the tools wave can follow the same pattern.
 */
import { buildSimulationInput, simulate } from "@glideworth/core";
import { createSampleDocument, SAMPLE_PLAN_ID } from "@glideworth/core/samples";

export interface DemoResult {
  engineVersion: string;
  periods: number;
  startMonth: string;
  endMonth: string;
  ms: number;
}

export function runSampleProjection(): DemoResult {
  const t0 = performance.now();
  const result = simulate(buildSimulationInput(createSampleDocument(), SAMPLE_PLAN_ID));
  return {
    engineVersion: result.meta.engineVersion,
    periods: result.periods.length,
    startMonth: result.meta.startMonth,
    endMonth: result.meta.endMonth,
    ms: Math.round(performance.now() - t0),
  };
}
