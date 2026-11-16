import type { SimulationInput, SimulationOptionsInput } from "./engine/types.js";
import { SimulationOptions } from "./engine/types.js";
import { ScenarioError } from "./errors.js";
import type { GlideworthDocument } from "./schema/document.js";

/** Build the engine input for one plan of a document (the web worker and API both use this). */
export function buildSimulationInput(
  doc: GlideworthDocument,
  planId: string,
  options: SimulationOptionsInput = {},
): SimulationInput {
  const plan = doc.plans.find((p) => p.id === planId);
  if (!plan) throw new ScenarioError(`plan '${planId}' not found`, { planId });
  if (plan.lineage)
    throw new ScenarioError("branch plans must be materialised first (insights.materializePlan)", {
      planId,
    });
  return {
    household: doc.household,
    finances: doc.finances,
    plan,
    options: SimulationOptions.parse(options),
  };
}
