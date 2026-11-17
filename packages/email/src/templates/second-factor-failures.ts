import { action, compose, greeting, link, p } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { dateText } from "../validate.js";

/**
 * Review finding 8: sent once the wrong two-step code has been entered 10 times in a row (at most one a day).
 * Whoever typed them got past the password, so the advice is to change it.
 */
export function secondFactorFailures(
  data: TemplateData["second-factor-failures"],
  ctx: RenderContext,
): Rendered {
  return compose(
    "second-factor-failures",
    "Change your password now",
    [
      p(greeting(data.name)),
      p(
        "Someone entered the wrong two-step code 10 times. They have your password. Change it now.",
      ),
      p(`The last wrong code was entered at ${dateText(data.at, "at")}.`),
      action("Reset your password", data.resetUrl),
      p(
        "A new password stops them trying again and signs out every other device. The wrong codes kept them out, so they have not signed in with them.",
      ),
      link("Check your security settings and signed-in devices", data.securityUrl),
    ],
    ctx,
  );
}
