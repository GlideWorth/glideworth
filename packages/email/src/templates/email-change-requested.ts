import { compose, greeting, link, p, plural } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { assertEmail, dateText, positiveInt } from "../validate.js";

/** To the current address when someone asks to move the account to another one. Nothing has changed yet. */
export function emailChangeRequested(
  data: TemplateData["email-change-requested"],
  ctx: RenderContext,
): Rendered {
  const newEmail = assertEmail(data.newEmail, "newEmail");
  const hours = positiveInt(data.expiresInHours, "expiresInHours");
  return compose(
    "email-change-requested",
    "A change of email address was requested",
    [
      p(greeting(data.name)),
      p(
        `On ${dateText(data.at, "at")}, someone signed in to your Glideworth account asked to change its email address to ${newEmail}.`,
      ),
      p(
        `Nothing has changed yet. The change happens only if the confirmation link we sent to ${newEmail} is opened within ${plural(hours, "hour", "hours")}. Until then, this address stays on the account.`,
      ),
      p("If you asked for this, there is nothing to do."),
      link(
        "If you did not, change your password now (that also cancels the request), then contact us",
        data.securityUrl,
      ),
    ],
    ctx,
  );
}
