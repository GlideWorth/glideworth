/**
 * The @glideworth/core and @glideworth/importers functions the API calls, gathered in one object so tests
 * can inject fakes for a single function while everything else stays real. Production uses the real
 * exports.
 */
import * as core from "@glideworth/core";
import * as importers from "@glideworth/importers";

export interface CoreDeps {
  simulate: typeof core.simulate;
  runMonteCarloAsync: typeof core.runMonteCarloAsync;
  runMonteCarloShard: typeof core.runMonteCarloShard;
  mergeMonteCarloShards: typeof core.mergeMonteCarloShards;
  summarizeMonteCarlo: typeof core.summarizeMonteCarlo;
  runHistorical: typeof core.runHistorical;
  goalSeek: typeof core.goalSeek;
  solveMaxSpending: typeof core.solveMaxSpending;
  solveEarliestRetirement: typeof core.solveEarliestRetirement;
  solveRequiredSavings: typeof core.solveRequiredSavings;
  solveRequiredPortfolio: typeof core.solveRequiredPortfolio;
  solveSafeWithdrawalRate: typeof core.solveSafeWithdrawalRate;
  evaluateGuardrails: typeof core.evaluateGuardrails;
  guytonKlingerGuardrails: typeof core.guytonKlingerGuardrails;
  sensitivityAnalysis: typeof core.sensitivityAnalysis;
  optimiseTaxStrategy: typeof core.optimiseTaxStrategy;
  compareStrategies: typeof core.compareStrategies;
  explainProjection: typeof core.explainProjection;
  explainYear: typeof core.explainYear;
  explainYears: typeof core.explainYears;
  explainDifference: typeof core.explainDifference;
  attributeDifference: typeof core.attributeDifference;
  auditAssumptions: typeof core.auditAssumptions;
  survivorScenarios: typeof core.survivorScenarios;
  diffPlans: typeof core.diffPlans;
  applyPlanPatch: typeof core.applyPlanPatch;
  materializePlan: typeof core.materializePlan;
  createBranch: typeof core.createBranch;
  branchPatch: typeof core.branchPatch;
  mergeBranchIntoParent: typeof core.mergeBranchIntoParent;
  compareDebtPayoffStrategies: typeof core.compareDebtPayoffStrategies;
  strategyMetricsMatrix: typeof core.strategyMetricsMatrix;
  defaultStrategyCandidates: typeof core.defaultStrategyCandidates;
  incomeByTaxRateForInput: typeof core.incomeByTaxRateForInput;
  compareSeppMethods: typeof core.compareSeppMethods;
  compareStayingVersusMoving: typeof core.compareStayingVersusMoving;
  relocationScenario: typeof core.relocationScenario;
}

export const coreDeps: CoreDeps = {
  simulate: core.simulate,
  runMonteCarloAsync: core.runMonteCarloAsync,
  runMonteCarloShard: core.runMonteCarloShard,
  mergeMonteCarloShards: core.mergeMonteCarloShards,
  summarizeMonteCarlo: core.summarizeMonteCarlo,
  runHistorical: core.runHistorical,
  goalSeek: core.goalSeek,
  solveMaxSpending: core.solveMaxSpending,
  solveEarliestRetirement: core.solveEarliestRetirement,
  solveRequiredSavings: core.solveRequiredSavings,
  solveRequiredPortfolio: core.solveRequiredPortfolio,
  solveSafeWithdrawalRate: core.solveSafeWithdrawalRate,
  evaluateGuardrails: core.evaluateGuardrails,
  guytonKlingerGuardrails: core.guytonKlingerGuardrails,
  sensitivityAnalysis: core.sensitivityAnalysis,
  optimiseTaxStrategy: core.optimiseTaxStrategy,
  compareStrategies: core.compareStrategies,
  explainProjection: core.explainProjection,
  explainYear: core.explainYear,
  explainYears: core.explainYears,
  explainDifference: core.explainDifference,
  attributeDifference: core.attributeDifference,
  auditAssumptions: core.auditAssumptions,
  survivorScenarios: core.survivorScenarios,
  diffPlans: core.diffPlans,
  applyPlanPatch: core.applyPlanPatch,
  materializePlan: core.materializePlan,
  createBranch: core.createBranch,
  branchPatch: core.branchPatch,
  mergeBranchIntoParent: core.mergeBranchIntoParent,
  compareDebtPayoffStrategies: core.compareDebtPayoffStrategies,
  strategyMetricsMatrix: core.strategyMetricsMatrix,
  defaultStrategyCandidates: core.defaultStrategyCandidates,
  incomeByTaxRateForInput: core.incomeByTaxRateForInput,
  compareSeppMethods: core.compareSeppMethods,
  compareStayingVersusMoving: core.compareStayingVersusMoving,
  relocationScenario: core.relocationScenario,
};

export interface ImportDeps {
  importProjectionLab: typeof importers.importProjectionLab;
  detectProjectionLabExport: typeof importers.detectProjectionLabExport;
  importCsvInto: typeof importers.importCsvInto;
  analyzeCsv: typeof importers.analyzeCsv;
  buildReportData: typeof importers.buildReportData;
  tableBuilders: typeof importers.TABLE_BUILDERS;
  progressTable: typeof importers.progressTable;
  tableToCsv: typeof importers.tableToCsv;
  importBankFileInto: typeof importers.importBankFileInto;
  detectBankFileFormat: typeof importers.detectBankFileFormat;
}

export const importDeps: ImportDeps = {
  importProjectionLab: importers.importProjectionLab,
  detectProjectionLabExport: importers.detectProjectionLabExport,
  importCsvInto: importers.importCsvInto,
  analyzeCsv: importers.analyzeCsv,
  buildReportData: importers.buildReportData,
  tableBuilders: importers.TABLE_BUILDERS,
  progressTable: importers.progressTable,
  tableToCsv: importers.tableToCsv,
  importBankFileInto: importers.importBankFileInto,
  detectBankFileFormat: importers.detectBankFileFormat,
};
