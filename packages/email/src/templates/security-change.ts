import { compose, greeting, link, p } from "../layout.js";
import type { RenderContext, Rendered, SecurityChange, TemplateData } from "../types.js";
import { assertEmail, dateText, EmailValidationError } from "../validate.js";

const CHANGE_TEXT: Readonly<Record<SecurityChange, string>> = {
  "password-changed": "Your password was changed.",
  "password-reset":
    "Your password was reset using an email link. Apps connected to your account were disconnected; your API keys still work.",
  "email-changed": "The email address on your account was changed.",
  "totp-enabled": "Two-factor authentication was switched on.",
  "totp-disabled": "Two-factor authentication was switched off.",
  "recovery-codes-regenerated": "Your recovery codes were replaced. The old codes no longer work.",
  "recovery-code-used": "A recovery code was used to sign in to your account.",
  "api-key-created": "A new API key was created.",
  "mcp-app-connected": "An app was connected to your account.",
  "ownership-transferred": "Ownership of a workspace was transferred.",
  "support-access-used":
    "Glideworth support opened a read-only view of your workspace, using a support access grant you created.",
};

export function securityChange(
  data: TemplateData["security-change"],
  ctx: RenderContext,
): Rendered {
  if (!Object.hasOwn(CHANGE_TEXT, data.change)) {
    throw new EmailValidationError("invalid_data", "change is not a known security change");
  }
  const changeText =
    data.change === "email-changed" && data.newEmail !== undefined
      ? `The email address on your account was changed to ${assertEmail(data.newEmail, "newEmail")}. Account emails now go to that address, not this one.`
      : CHANGE_TEXT[data.change];
  return compose(
    "security-change",
    "A security setting changed",
    [
      p(greeting(data.name)),
      p(changeText),
      p(`This happened at ${dateText(data.at, "at")}.`),
      p(
        data.change === "support-access-used"
          ? "If you asked support for help, there is nothing to do."
          : "If you made this change, there is nothing to do.",
      ),
      link(
        data.change === "support-access-used"
          ? "To see your support grants and end one, open your workspace settings"
          : "If you did not, secure your account here and then contact us",
        data.securityUrl,
      ),
    ],
    ctx,
  );
}
