import { compose, facts, greeting, link, p } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { dateText, freeText } from "../validate.js";

export function signinAlert(data: TemplateData["signin-alert"], ctx: RenderContext): Rendered {
  return compose(
    "signin-alert",
    "New sign-in to your account",
    [
      p(greeting(data.name)),
      p("We noticed a sign-in to your Glideworth account from a device we have not seen before."),
      facts(
        ["When", dateText(data.at, "at")],
        ["Device", freeText(data.device, "device", 200)],
        ["IP address", freeText(data.ip, "ip", 64)],
      ),
      p("If this was you, there is nothing to do."),
      link(
        "If it was not you, sign out the other devices and change your password here",
        data.sessionsUrl,
      ),
    ],
    ctx,
  );
}
