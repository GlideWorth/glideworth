import { action, compose, greeting, p } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";

export function trialExpired(data: TemplateData["trial-expired"], ctx: RenderContext): Rendered {
  return compose(
    "trial-expired",
    "Your trial has ended",
    [
      p(greeting(data.name)),
      p(
        "Your free trial has ended, so your workspace is now read-only. You can still look at your plans and export your data. Nothing has been deleted.",
      ),
      action("Subscribe to keep editing", data.billingUrl),
    ],
    ctx,
  );
}
