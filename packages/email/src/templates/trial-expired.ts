import { action, compose, greeting, p } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";

/** Sent once a no-card free trial has ended without a subscription. */
export function trialExpired(data: TemplateData["trial-expired"], ctx: RenderContext): Rendered {
  return compose(
    "trial-expired",
    "Your free trial has ended",
    [
      p(greeting(data.name)),
      p(
        "Your free trial of Glideworth Cloud has ended, so your workspace is now read-only. You can still open your plans and export your data. Nothing has been deleted.",
      ),
      p(
        "Subscribe at any time to pick up where you left off. If you do not subscribe, the workspace is deleted 12 months after the trial ended, and we email you before that happens.",
      ),
      action("Subscribe to keep editing", data.billingUrl),
    ],
    ctx,
  );
}
