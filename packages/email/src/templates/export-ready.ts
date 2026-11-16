import { action, compose, greeting, p } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { freeText } from "../validate.js";

export function exportReady(data: TemplateData["export-ready"], ctx: RenderContext): Rendered {
  return compose(
    "export-ready",
    "Your export is ready",
    [
      p(greeting(data.name)),
      p(
        "The export of your workspace is ready. It is a copy of your data that you can run yourself.",
      ),
      action("Download your export", data.url),
      p(
        `The link can be used once and expires at ${freeText(data.expiresAt, "expiresAt", 100)}. You need to be signed in to download it.`,
      ),
      p("If you did not ask for an export, change your password and contact us."),
    ],
    ctx,
  );
}
