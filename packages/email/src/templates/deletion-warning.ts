import { action, compose, greeting, link, p, plural } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { dateText, freeText, positiveInt } from "../validate.js";

/** Sent 30 and 7 days before a lapsed workspace is deleted (the retention rule of the terms of service). */
export function deletionWarning(
  data: TemplateData["deletion-warning"],
  ctx: RenderContext,
): Rendered {
  const workspace = freeText(data.workspaceName, "workspaceName", 100);
  const left = plural(positiveInt(data.daysLeft, "daysLeft"), "day", "days");
  return compose(
    "deletion-warning",
    "Your workspace will be deleted",
    [
      p(greeting(data.name)),
      p(
        `Your workspace "${workspace}" has no active subscription. It will be deleted on ${dateText(data.deletesOn, "deletesOn")}, in ${left}, together with everything in it.`,
      ),
      p("Subscribing again before that date keeps the workspace and everything in it."),
      action("Subscribe to keep your workspace", data.billingUrl),
      link("Or download a copy of your data first", data.exportUrl),
    ],
    ctx,
  );
}
