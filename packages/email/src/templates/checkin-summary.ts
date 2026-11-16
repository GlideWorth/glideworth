import { action, bullets, compose, p, plural } from "../layout.js";
import type { CheckinChangeKind, RenderContext, Rendered, TemplateData } from "../types.js";
import { EmailValidationError, nonNegativeInt } from "../validate.js";

const KIND_TEXT: Readonly<Record<CheckinChangeKind, string>> = {
  "success-rate-change": "The chance of success moved on at least one plan.",
  "milestone-slipped": "A milestone slipped on at least one plan.",
  "behind-plan": "At least one plan is behind plan.",
  "audit-finding": "There is a new assumption finding.",
};
const KIND_ORDER = Object.keys(KIND_TEXT) as CheckinChangeKind[];

/**
 * No amounts, percentages, plan names or notification titles (spec 5.3): only a count of plans and the
 * kinds of change. The recipient's name is deliberately not used, because names are free text.
 */
export function checkinSummary(
  data: TemplateData["checkin-summary"],
  ctx: RenderContext,
): Rendered {
  const count = nonNegativeInt(data.plansChecked, "plansChecked");
  if (!Array.isArray(data.changeKinds)) {
    throw new EmailValidationError("invalid_data", "changeKinds must be a list");
  }
  for (const k of data.changeKinds) {
    if (!Object.hasOwn(KIND_TEXT, k))
      throw new EmailValidationError("invalid_data", "unknown change kind");
  }
  const kinds = KIND_ORDER.filter((k) => data.changeKinds.includes(k));
  return compose(
    "checkin-summary",
    "Your check-in is ready",
    [
      p("Hello,"),
      p(`Your scheduled check-in has finished. We checked ${plural(count, "plan", "plans")}.`),
      ...(kinds.length > 0
        ? [p("What changed:"), bullets(kinds.map((k) => KIND_TEXT[k]))]
        : [p("Nothing needs your attention.")]),
      action("See the details", data.url),
    ],
    ctx,
  );
}
