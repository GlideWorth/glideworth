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
import { runGuardrails } from "./guardrails";
import { runHistoricalBacktest } from "./historical-backtest";
import { runHowLong } from "./how-long";
import { runIrmaa } from "./irmaa";
import { runIsaVsPension } from "./isa-vs-pension";
import { runMonteCarloTool } from "./monte-carlo";
import { runRmd } from "./rmd";
import { runRuleOf55 } from "./rule-of-55";
import { runSepp } from "./sepp";
import { runUaeGratuity } from "./uae-gratuity";
import { runUkFire } from "./uk-fire";
import { runUkPensionAge } from "./uk-pension-age";
import { runRetirementSpending } from "./retirement-spending";
import { runUkDrawdown } from "./uk-drawdown";
import { runWithdrawal } from "./withdrawal";
import { runRetirementTax } from "./retirement-tax";
import { runRothConversion } from "./roth-conversion";
import { runAcaSubsidy } from "./aca-subsidy";
import { runSocialSecurity } from "./social-security";

const RUNNERS: Record<ToolId, (v: Values, opts: RunOptions) => Promise<ViewModel>> = {
  "coast-fire": runCoast,
  fire: runFire,
  "fat-fire": runFatFire,
  "barista-fire": runBarista,
  "how-long": runHowLong,
  withdrawal: runWithdrawal,
  "monte-carlo": runMonteCarloTool,
  rmd: runRmd,
  "sepp-72t": runSepp,
  "rule-of-55": runRuleOf55,
  irmaa: runIrmaa,
  "uk-fire": runUkFire,
  "uk-pension-age": runUkPensionAge,
  "uae-gratuity": runUaeGratuity,
  "retirement-tax": runRetirementTax,
  "roth-conversion": runRothConversion,
  "aca-subsidy": runAcaSubsidy,
  guardrails: runGuardrails,
  "retirement-spending": runRetirementSpending,
  "historical-backtest": runHistoricalBacktest,
  "uk-drawdown": runUkDrawdown,
  "isa-vs-pension": runIsaVsPension,
  "social-security": runSocialSecurity,
};

export type { RunOptions };

export function runTool(tool: ToolId, values: Values, opts: RunOptions = {}): Promise<ViewModel> {
  return RUNNERS[tool](values, opts);
}
