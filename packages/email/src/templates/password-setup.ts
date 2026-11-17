import { action, compose, greeting, p, plural } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { positiveInt } from "../validate.js";

/**
 * For an account that signed up with Google and has no password yet: the person asked for this link while
 * signed in (often because a change needed a recent check). Not reset wording: there is nothing to reset.
 */
export function passwordSetup(data: TemplateData["password-setup"], ctx: RenderContext): Rendered {
  const mins = positiveInt(data.expiresInMinutes, "expiresInMinutes");
  return compose(
    "password-setup",
    "Set a password for your Glideworth account",
    [
      p(greeting(data.name)),
      p(
        "You asked to set a password for your Glideworth account. You sign in with Google today; with a password you can also confirm changes that need a recent check, such as creating an API key.",
      ),
      action("Set your password", data.url),
      p(
        `This link works for ${plural(mins, "minute", "minutes")} and can be used once. If you did not ask for this, ignore this email and nothing will change.`,
      ),
    ],
    ctx,
  );
}
