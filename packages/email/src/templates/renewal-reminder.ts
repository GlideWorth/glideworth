import { action, compose, greeting, p } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { dateText } from "../validate.js";

/**
 * Sent a few days before an annual renewal. The amount is deliberately not a field: the email states the date,
 * and the billing page (the link) shows the price, tax and invoice.
 */
export function renewalReminder(
  data: TemplateData["renewal-reminder"],
  ctx: RenderContext,
): Rendered {
  return compose(
    "renewal-reminder",
    "Your subscription renews soon",
    [
      p(greeting(data.name)),
      p(
        `Your annual subscription renews on ${dateText(data.renewsOn, "renewsOn")}. The payment method on your account will be charged then.`,
      ),
      p(
        "You can see the amount, change your payment method or cancel before that date on your billing page. If you cancel, you keep access until the end of the period you have paid for.",
      ),
      p(
        "If you are charged and do not want the renewal, you can ask for a full refund within 14 days of the charge.",
      ),
      action("Open your billing page", data.billingUrl),
    ],
    ctx,
  );
}
