import { action, compose, greeting, p } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { freeText } from "../validate.js";

export function paymentReceipt(
  data: TemplateData["payment-receipt"],
  ctx: RenderContext,
): Rendered {
  return compose(
    "payment-receipt",
    "Thank you for your payment",
    [
      p(greeting(data.name)),
      p(`We received your payment of ${freeText(data.amountText, "amountText", 50)}. Thank you.`),
      action("View your invoice", data.invoiceUrl),
    ],
    ctx,
  );
}
