import { compose, greeting, p } from "../layout.js";
import type { RenderContext, Rendered, TemplateData } from "../types.js";
import { freeText } from "../validate.js";

export function accountDeleted(
  data: TemplateData["account-deleted"],
  ctx: RenderContext,
): Rendered {
  const workspace = freeText(data.workspaceName, "workspaceName", 100);
  return compose(
    "account-deleted",
    "Your workspace has been deleted",
    [
      p(greeting(data.name)),
      p(
        `Your workspace "${workspace}" was deleted on ${freeText(data.deletedAt, "deletedAt", 100)}.`,
      ),
      p(
        "We deleted its live database at once and destroyed the key that encrypts its backups, so every backup copy is now unreadable.",
      ),
      p(
        `The encrypted backup files are removed from storage by ${freeText(data.backupsPurgedBy, "backupsPurgedBy", 100)}.`,
      ),
      p(`If you did not ask for this, write to ${ctx.supportEmail} straight away.`),
    ],
    ctx,
  );
}
