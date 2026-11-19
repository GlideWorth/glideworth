/**
 * Heavy analysis requests, shared by the analysis worker and the inline fallback (tests): income
 * by tax rate (a full-trace projection) and strategies × metrics (a deterministic run plus Monte
 * Carlo per strategy).
 */
import {
  type IncomeByTaxRateMatrix,
  incomeByTaxRateForInput,
  type SimulationInput,
  type StrategyMetricsMatrix,
  strategyMetricsMatrix,
  type ValueBasis,
} from "@glideworth/core";

export type AnalysisRequest =
  | {
      id: number;
      kind: "incomeByTaxRate";
      input: SimulationInput;
      opts: { basis: ValueBasis; jurisdictionId?: string };
    }
  | { id: number; kind: "strategyMatrix"; input: SimulationInput; opts: { successRate: boolean } };

export type AnalysisResult = {
  incomeByTaxRate: IncomeByTaxRateMatrix;
  strategyMatrix: StrategyMetricsMatrix;
};

export type AnalysisResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string; code?: string };

export async function runAnalysis(req: AnalysisRequest): Promise<unknown> {
  switch (req.kind) {
    case "incomeByTaxRate":
      return incomeByTaxRateForInput(req.input, req.opts);
    case "strategyMatrix":
      return strategyMetricsMatrix(req.input, undefined, { successRate: req.opts.successRate });
  }
}
