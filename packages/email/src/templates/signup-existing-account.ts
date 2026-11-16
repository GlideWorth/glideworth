import { action, compose, link, p } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";

export function signupExistingAccount(
  data: TemplateData["signup-existing-account"],
  ctx: RenderContext,
): Rendered {
  return compose(
    "signup-existing-account",
    "You already have an account",
    [
      p(
        "Someone, probably you, tried to sign up to Glideworth with this email address. There is already an account for it, so we did not create a new one.",
      ),
      action("Sign in", data.signInUrl),
      link("If you have forgotten your password, you can reset it here", data.resetUrl),
      p("If this was not you, you do not need to do anything. Your account has not been changed."),
    ],
    ctx,
  );
}
