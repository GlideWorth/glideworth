import { type Block, action, compose, facts, link, p, plural } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { EmailValidationError, freeText, positiveInt } from "../validate.js";

const MAX_INPUTS = 40;
const MAX_FIGURES = 8;

function rows(value: unknown, label: string, max: number): [string, string][] {
  if (!Array.isArray(value) || value.length > max)
    throw new EmailValidationError("invalid_data", `${label} must be a list of at most ${max}`);
  return value.map((row) => {
    if (!Array.isArray(row) || row.length !== 2)
      throw new EmailValidationError("invalid_data", `${label} rows are label and value pairs`);
    return [freeText(row[0], label, 80), freeText(row[1], label, 80)];
  });
}

/**
 * A free calculator's result, sent once because the visitor asked for it (category `requested`). The data is
 * built by the server from its own calculator catalog and checked numbers, never from text the visitor typed.
 * When the visitor ticked the reminder box, the same email carries the double opt-in link.
 */
export function calculatorResult(
  data: TemplateData["calculator-result"],
  ctx: RenderContext,
): Rendered {
  const tool = freeText(data.toolName, "toolName", 80);
  const inputs = rows(data.inputs, "inputs", MAX_INPUTS);
  const figures = rows(data.figures, "figures", MAX_FIGURES);
  const blocks: Block[] = [p(`Here is the result you asked for from the ${tool} on our website.`)];
  if (figures.length > 0) blocks.push(p("Your result:"), facts(...figures));
  blocks.push(action("Open the calculator with these inputs", data.reopenUrl));
  if (inputs.length > 0) blocks.push(p("Your inputs:"), facts(...inputs));
  if (data.confirmUrl) {
    const days = positiveInt(data.confirmExpiresInDays, "confirmExpiresInDays");
    blocks.push(
      p(
        "You also asked for a yearly reminder to re-check this, and occasional Glideworth updates. Confirm that here, or ignore it and you will not be added:",
      ),
      action("Yes, send me the reminder", data.confirmUrl),
      p(
        `The link works for ${plural(days, "day", "days")}. Every reminder and update has a one-click unsubscribe.`,
      ),
    );
  } else if (data.alreadySubscribed) {
    blocks.push(p("You are already on the list for the yearly reminder."));
  }
  if (data.demoUrl || data.trialUrl) {
    blocks.push(
      p(
        "A calculator answers one question. Glideworth plans the whole picture: every account, tax and income, year by year, and shows why a plan falls short.",
      ),
    );
    if (data.demoUrl) blocks.push(link("Try the demo, no sign-up", data.demoUrl));
    if (data.trialUrl) blocks.push(link("Start a 14-day free trial", data.trialUrl));
  }
  blocks.push(
    p(
      "This is an estimate from the numbers entered and the assumptions on the calculator page, not financial advice.",
    ),
  );
  return compose("calculator-result", `Your ${tool} result`, blocks, ctx);
}
