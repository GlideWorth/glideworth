import { action, compose, greeting, p, plural } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { positiveInt } from "../validate.js";

export function verifyEmail(data: TemplateData["verify-email"], ctx: RenderContext): Rendered {
  const hours = positiveInt(data.expiresInHours, "expiresInHours");
  return compose(
    "verify-email",
    "Confirm your email address",
    [
      p(greeting(data.name)),
      p("Please confirm your email address to finish setting up your Glideworth account."),
      action("Confirm email address", data.url),
      p(
        `This link works for ${plural(hours, "hour", "hours")}. If you did not create an account, you can ignore this email.`,
      ),
    ],
    ctx,
  );
}
