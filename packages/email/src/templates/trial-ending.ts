import { action, compose, greeting, p } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { dateText, freeText } from "../validate.js";

/**
 * Sent a few days before the free trial ends. Two cases:
 * - the no-card trial (`amountText` null): the workspace becomes read-only, nothing is deleted;
 * - the owner subscribed during the trial (Stripe's `trial_will_end`): the date, the amount and how to cancel.
 */
export function trialEnding(data: TemplateData["trial-ending"], ctx: RenderContext): Rendered {
  const on = dateText(data.trialEndsOn, "trialEndsOn");
  if (data.amountText === null) {
    return compose(
      "trial-ending",
      "Your free trial ends soon",
      [
        p(greeting(data.name)),
        p(
          `Your free trial of Glideworth Cloud ends on ${on}. We do not have a card for you, so nothing will be charged.`,
        ),
        p(
          "After that your workspace becomes read-only: you can still open your plans and export your data, but you cannot change them. Nothing is deleted. Subscribe at any time to keep editing.",
        ),
        action("Subscribe to keep editing", data.billingUrl),
      ],
      ctx,
    );
  }
  return compose(
    "trial-ending",
    "Your free trial ends soon",
    [
      p(greeting(data.name)),
      p(
        `Your free trial of Glideworth Cloud ends on ${on}. You subscribed during the trial, so on that day we will charge ${freeText(data.amountText, "amountText", 60)}, plus any tax that applies, to the card you gave. The subscription then renews until you cancel it.`,
      ),
      p(
        `If you do not want to continue, cancel before ${on} on your billing page (Manage billing, then Cancel subscription). You will not be charged, and you keep full access until the trial ends.`,
      ),
      action("Open your billing page", data.billingUrl),
    ],
    ctx,
  );
}
