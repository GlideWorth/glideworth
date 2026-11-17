import { compose, greeting, p } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { freeText } from "../validate.js";

export function memberRemoved(data: TemplateData["member-removed"], ctx: RenderContext): Rendered {
  const workspace = freeText(data.workspaceName, "workspaceName", 100);
  return compose(
    "member-removed",
    "You have been removed from a workspace",
    [
      p(greeting(data.name)),
      p(
        `The owner of the Glideworth workspace "${workspace}" has removed you from it. You can no longer see or change its plans.`,
      ),
      p(
        "Your own Glideworth account is not affected: you can still sign in, and you can create a workspace of your own or join another one you are invited to.",
      ),
      p("If you think this was a mistake, ask the workspace owner to invite you again."),
    ],
    ctx,
  );
}
