import { action, compose, p, plural } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { EmailValidationError, freeText, positiveInt } from "../validate.js";

export function invitation(data: TemplateData["invitation"], ctx: RenderContext): Rendered {
  const days = positiveInt(data.expiresInDays, "expiresInDays");
  if (data.role !== "editor" && data.role !== "viewer") {
    throw new EmailValidationError("invalid_data", "role must be editor or viewer");
  }
  const inviter = freeText(data.inviterName, "inviterName", 100) || "Someone";
  const workspace = freeText(data.workspaceName, "workspaceName", 100);
  const roleText =
    data.role === "editor"
      ? "an editor, who can change plans and settings"
      : "a viewer, who can look at plans but not change them";
  return compose(
    "invitation",
    "You have been invited to a workspace",
    [
      p(
        `${inviter} has invited you to join the workspace "${workspace}" on Glideworth as ${roleText}.`,
      ),
      action("View the invitation", data.url),
      p(
        `The invitation expires in ${plural(days, "day", "days")}. You need a Glideworth account with this email address to accept it; if you do not have one yet, you can create one first.`,
      ),
      p("If you were not expecting this, you can ignore this email."),
    ],
    ctx,
  );
}
