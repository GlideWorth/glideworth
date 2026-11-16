import { action, compose, greeting, p } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { freeText } from "../validate.js";

export function paymentProblem(
  data: TemplateData["payment-problem"],
  ctx: RenderContext,
): Rendered {
  return compose(
    "payment-problem",
    "Your payment did not go through",
    [
      p(greeting(data.name)),
      p(
        "We could not take your latest payment for Glideworth. This is usually an expired card or a bank block.",
      ),
      action("Update your payment details", data.portalUrl),
      p(
        `If this is not sorted out by ${freeText(data.readOnlyFrom, "readOnlyFrom", 100)}, your workspace will become read-only: you will still be able to look at your plans and export your data, but not change them. Nothing is deleted.`,
      ),
    ],
    ctx,
  );
}
