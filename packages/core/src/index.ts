/**
 * @glideworth/core public API.
 *   schema/*      Zod domain schema (single source of truth) + inferred types + migrations
 *   engine/*      deterministic annual simulation: simulate(input) -> ProjectionResult
 *   tax/*         TaxJurisdiction plug-ins and registry
 *   stochastic/*  Monte Carlo / historical runners (reuse the engine)
 *   solvers/*     goal seek, guardrails
 *   insights/*    explainability, assumption audit, plan diff / patch
 */

export * from "./defaults/country.js";
export * from "./engine/index.js";
export * from "./errors.js";
export * from "./insights/index.js";
export { buildSimulationInput } from "./scenario.js";
export * from "./schema/index.js";
export * from "./solvers/index.js";
export * from "./stochastic/index.js";
export * from "./tax/index.js";
