import { action, compose, greeting, p } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { freeText } from "../validate.js";

export function trialEnding(data: TemplateData["trial-ending"], ctx: RenderContext): Rendered {
  return compose(
    "trial-ending",
    "Your trial ends soon",
    [
      p(greeting(data.name)),
      p(`Your free trial ends on ${freeText(data.trialEndsOn, "trialEndsOn", 100)}.`),
      p(
        "After that your workspace becomes read-only: you can still look at your plans and export your data, but you cannot change anything. Nothing is deleted.",
      ),
      action("Subscribe to keep editing", data.billingUrl),
    ],
    ctx,
  );
}
