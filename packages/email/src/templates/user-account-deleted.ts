import { compose, greeting, p } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { freeText } from "../validate.js";

/** A security notice: the person deleted their own account. Workspace deletion has its own email. */
export function userAccountDeleted(
  data: TemplateData["user-account-deleted"],
  ctx: RenderContext,
): Rendered {
  return compose(
    "user-account-deleted",
    "Your account has been deleted",
    [
      p(greeting(data.name)),
      p(
        `Your Glideworth account was deleted on ${freeText(data.deletedAt, "deletedAt", 100)}. You have been signed out everywhere, and your password, sessions and two-factor settings have been removed.`,
      ),
      p(
        "If you were a member of someone else's workspace, you have been removed from it. Their plans are not affected.",
      ),
      p(`If you did not ask for this, write to ${ctx.supportEmail} straight away.`),
    ],
    ctx,
  );
}
