import { action, compose, greeting, p, plural } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { positiveInt } from "../validate.js";

export function passwordReset(data: TemplateData["password-reset"], ctx: RenderContext): Rendered {
  const mins = positiveInt(data.expiresInMinutes, "expiresInMinutes");
  return compose(
    "password-reset",
    "Reset your password",
    [
      p(greeting(data.name)),
      p("We received a request to reset the password for your Glideworth account."),
      action("Choose a new password", data.url),
      p(
        `This link works for ${plural(mins, "minute", "minutes")} and can be used once. If you did not ask for this, ignore this email and your password will stay as it is.`,
      ),
    ],
    ctx,
  );
}
