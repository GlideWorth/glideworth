import { TEMPLATES } from "./templates/index.js";
import type { RenderContext, Rendered, TemplateData, TemplateId } from "./types.js";
import { EmailValidationError } from "./validate.js";

/** Renders a template. Throws `EmailValidationError` for hostile or malformed data (bad URL, wrong type). */
export function render<T extends TemplateId>(
  id: T,
  data: TemplateData[T],
  ctx: RenderContext,
): Rendered {
  const fn = Object.hasOwn(TEMPLATES, id) ? TEMPLATES[id] : undefined;
  if (!fn) throw new EmailValidationError("invalid_data", "unknown template");
  if (typeof data !== "object" || data === null) {
    throw new EmailValidationError("invalid_data", "template data must be an object");
  }
  return fn(data, ctx);
}
