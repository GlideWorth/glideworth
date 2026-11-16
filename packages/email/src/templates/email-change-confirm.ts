import { action, compose, greeting, p, plural } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { assertEmail, positiveInt } from "../validate.js";

export function emailChangeConfirm(
  data: TemplateData["email-change-confirm"],
  ctx: RenderContext,
): Rendered {
  const hours = positiveInt(data.expiresInHours, "expiresInHours");
  const newEmail = assertEmail(data.newEmail, "newEmail");
  return compose(
    "email-change-confirm",
    "Confirm your new email address",
    [
      p(greeting(data.name)),
      p(
        `You asked to change the email address on your Glideworth account to ${newEmail}. Please confirm that this address is yours.`,
      ),
      action("Confirm new email address", data.url),
      p(
        `This link works for ${plural(hours, "hour", "hours")}. If you did not ask for this, ignore this email and nothing will change.`,
      ),
    ],
    ctx,
  );
}
