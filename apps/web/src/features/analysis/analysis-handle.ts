/**
 * Heavy analysis requests, shared by the analysis worker and the inline fallback (tests): debt
 * payoff comparison, income by tax rate (a full-trace projection), strategies × metrics (a
 * deterministic run plus Monte Carlo per strategy) and the 72(t) comparison.
 */
import {
  compareDebtPayoffStrategies,
  compareSeppMethods,
  type IncomeByTaxRateMatrix,
  incomeByTaxRateForInput,
  type PayoffComparison,
  type SeppComparison,
  type SimulationInput,
  type StrategyMetricsMatrix,
  strategyMetricsMatrix,
  type ValueBasis,
} from "@glideworth/core";

export type AnalysisRequest =
  | {
      id: number;
      kind: "debtPayoff";
      input: SimulationInput;
      opts: { extraPerMonth?: number; flowId?: string; rollover?: boolean };
    }
  | {
      id: number;
      kind: "incomeByTaxRate";
      input: SimulationInput;
      opts: { basis: ValueBasis; jurisdictionId?: string };
    }
  | { id: number; kind: "strategyMatrix"; input: SimulationInput; opts: { successRate: boolean } }
  | {
      id: number;
      kind: "sepp";
      opts: { balance: number; startAge: number; interestRate?: number; growthRate?: number };
    };

export type AnalysisResult = {
  debtPayoff: PayoffComparison;
  incomeByTaxRate: IncomeByTaxRateMatrix;
  strategyMatrix: StrategyMetricsMatrix;
  sepp: SeppComparison;
};

export type AnalysisResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string; code?: string };

export async function runAnalysis(req: AnalysisRequest): Promise<unknown> {
  switch (req.kind) {
    case "debtPayoff":
      return compareDebtPayoffStrategies(req.input, req.opts);
    case "incomeByTaxRate":
      return incomeByTaxRateForInput(req.input, req.opts);
    case "strategyMatrix":
      return strategyMetricsMatrix(req.input, undefined, { successRate: req.opts.successRate });
    case "sepp":
      return compareSeppMethods(req.opts);
  }
}
