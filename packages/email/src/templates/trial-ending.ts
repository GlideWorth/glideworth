import { action, compose, greeting, p } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { dateText, freeText } from "../validate.js";

/**
 * Sent a few days before a free trial ends and the card is charged for the first time (Stripe's
 * `trial_will_end`, or the billing sweep). States the date, the amount and how to cancel.
 */
export function trialEnding(data: TemplateData["trial-ending"], ctx: RenderContext): Rendered {
  const on = dateText(data.trialEndsOn, "trialEndsOn");
  return compose(
    "trial-ending",
    "Your free trial ends soon",
    [
      p(greeting(data.name)),
      p(
        `Your free trial of Glideworth Cloud ends on ${on}. On that day we will charge ${freeText(data.amountText, "amountText", 60)}, plus any tax that applies, to the card you gave when you started the trial. The subscription then renews until you cancel it.`,
      ),
      p(
        `If you do not want to continue, cancel before ${on} on your billing page (Manage billing, then Cancel subscription). You will not be charged, and you keep full access until the trial ends.`,
      ),
      action("Open your billing page", data.billingUrl),
    ],
    ctx,
  );
}
