import { action, compose, greeting, p } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { dateText } from "../validate.js";

export function subscriptionCanceled(
  data: TemplateData["subscription-canceled"],
  ctx: RenderContext,
): Rendered {
  return compose(
    "subscription-canceled",
    "Your subscription is cancelled",
    [
      p(greeting(data.name)),
      p(
        `Your Glideworth subscription is cancelled. You keep full access until ${dateText(data.accessUntil, "accessUntil")}.`,
      ),
      p(
        "After that your workspace becomes read-only. Nothing is deleted, and you can export your data at any time.",
      ),
      action("Resubscribe", data.billingUrl),
    ],
    ctx,
  );
}
