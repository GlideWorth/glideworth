import { GlideworthDocument, Plan } from "@glideworth/core";
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { allows } from "../auth.js";
import { compactPlan, planViewContext } from "../views.js";
import type { McpContext } from "./server.js";

export const GLOSSARY = `# Glideworth glossary

- **Household**: the people (1-2), dependents, location and currency being planned for.
- **Dependent**: a child or other dependent in \`household.dependents\` (birth month, \`independentAtAge\`). They count for tax credits and the automatic ACA household size from birth until that age. Costs can follow their age: an expense with \`dependentId\` and \`{ "kind": "dependentAge", "dependentId", "age" }\` dates moves when their birth month changes.
- **Current finances**: starting balances. Accounts (balance, cost basis), real assets (value, loan) and debts.
- **Plan**: a scenario on top of the finances: milestones, income, expenses, flows, assumptions, tax and Monte Carlo settings. Plans have a numeric \`version\` that increases on every write.
- **Branch**: a plan that stores a patch over a parent and follows it (a what-if scenario).
- **Milestone**: a named point in time, resolved from ages/dates/metrics (e.g. "Retirement" at age 60). Events can start or end at a milestone.
- **Flow**: the ordered savings waterfall applied to each period's surplus (contributions, debt paydown, transfers). Index 0 has the highest priority.
- **Real vs nominal**: *real* = today's money (inflation removed); *nominal* = actual future currency. User-entered amounts carry a basis; engine results are nominal with a per-period \`priceIndex\`; compact tool outputs default to real.
- **Success rate**: share of Monte Carlo / historical trials in which every period's expenses were fully funded (unless the plan defines a liquid-floor success definition).
- **Shortfall**: expenses the plan could not fund in a period. Any shortfall means the deterministic plan failed that year.
- **Change set**: a proposed list of edits (RFC 6902 patch ops) with a diff and before/after preview. Apply only after the user agrees.
- **Progress snapshot**: recorded actuals (net worth etc.) at a date, to compare against the plan.
`;

export const UNITS = `# Units and conventions

- Money: major currency units of the household currency, as numbers (1234.56). Never cents.
- Rates: decimal fractions per year (0.07 = 7%).
- Amount: \`{ value, basis: "real" | "nominal" }\` plus a frequency (once, weekly, biweekly, semimonthly, monthly, quarterly, semiannually, yearly). "$20k/month" is value 20000 with frequency "monthly", NOT yearly.
- Months: "YYYY-MM". Dates: "YYYY-MM-DD".
- Ages may be fractional (59.5).
- Patch paths address list items by id: \`/income/[id=salary-1]/amount/value\` (indexes are fragile).
`;

export const CHANGE_SET_WORKFLOW = `# Editing plans safely

1. Read: get_plan_summary(planId). Note \`version\` and the ids of the items to change.
2. What-if (optional): preview_changes(planId, ops) shows the diff and before/after outcome without storing anything.
3. Propose: propose_change_set(planId, ops, summary, rationale). Returns a readable diff and before/after.
4. Show the user the changes and outcome. Ask before applying.
5. Apply: apply_change_set(changeSetId). If the plan changed meanwhile you get CHANGESET_CONFLICT: re-read and propose again.
6. Undo: list_plan_versions then propose_revert(planId, version), then apply it.

Prefer create_branch for exploratory scenarios: the parent stays untouched.
`;

export const EDIT_PATHS = `# Common plan edits (RFC 6902 ops; ids come from get_plan)

- Change an expense amount: { "op": "replace", "path": "/expenses/[id=EXPENSE]/amount/value", "value": 2500 }  (keep the item's own frequency: a monthly expense is a monthly number)
- Change an income amount: { "op": "replace", "path": "/income/[id=INCOME]/amount/value", "value": 95000 }
- Stop/start an item: { "op": "replace", "path": "/expenses/[id=EXPENSE]/enabled", "value": false }
- Move retirement: { "op": "replace", "path": "/milestones/[id=MILESTONE]/criteria/0/age", "value": 58 } (or use preview_whatif early-retirement)
- Add an expense: { "op": "add", "path": "/expenses/-", "value": { "id": "exp-care", "type": "healthcare", "name": "Care", "owner": "joint", "amount": { "value": 5000, "basis": "real" }, "frequency": "yearly", "range": { "start": { "kind": "age", "personId": "PERSON", "age": 80, "offsetMonths": 0 }, "end": { "kind": "planEnd", "offsetMonths": 0 } }, "change": { "kind": "inflation", "plus": 0.02 }, "spendingType": "essential" } }
- Add a child's cost by age (no amount is assumed: use the user's figure): { "op": "add", "path": "/expenses/-", "value": { "id": "exp-robin-college", "type": "education", "name": "Robin's college", "owner": "joint", "dependentId": "DEPENDENT", "amount": { "value": USER_AMOUNT, "basis": "real" }, "frequency": "yearly", "range": { "start": { "kind": "dependentAge", "dependentId": "DEPENDENT", "age": 18, "offsetMonths": 0 }, "end": { "kind": "dependentAge", "dependentId": "DEPENDENT", "age": 22, "offsetMonths": 0 } } } }  (end is exclusive: the cost stops on the 22nd birthday)
- ACA household size: { "op": "replace", "path": "/expenses/[id=EXPENSE]/healthcare/householdSize", "value": "auto" } follows the tax household each year (adults on the return + dependents still dependent); a number fixes it for every year. explain_year states the size used.
- Change an assumption: { "op": "replace", "path": "/assumptions/stockReturn", "value": { "kind": "fixed", "rate": 0.05 } }
- Monte Carlo settings: { "op": "replace", "path": "/monteCarlo/trials", "value": 2000 }

Do not guess other paths: read glideworth://plans/{planId} for the exact shape, or glideworth://schema/plan (large, about 100 KB) for the full schema. A wrong path is PATCH_CONFLICT and changes nothing.
`;

/** Resource URI scheme. */
export const RESOURCE_SCHEME = "glideworth://";
/**
 * The scheme before the rename. A client may have stored such URIs, so `cairn://<path>` still reads the same
 * resource as `glideworth://<path>`; it is not listed.
 */
export const LEGACY_RESOURCE_SCHEME = "cairn://";

type Contents = { body: string; mimeType: string };

export function registerResources(server: McpServer, ctx: McpContext): void {
  const { services } = ctx;
  const text = (uri: string, { body, mimeType }: Contents) => ({
    contents: [{ uri, mimeType, text: body }],
  });
  const schemaOf = (schema: z.ZodType): Contents => {
    let json: unknown;
    try {
      json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
    } catch (err) {
      json = { error: `schema generation failed: ${err instanceof Error ? err.message : "error"}` };
    }
    return { body: JSON.stringify(json), mimeType: "application/schema+json" };
  };
  const markdown = (body: string): Contents => ({ body, mimeType: "text/markdown" });
  const json = (value: unknown): Contents => ({
    body: JSON.stringify(value),
    mimeType: "application/json",
  });

  /** Readers by path (the URI after the scheme), shared by the current and the pre-rename scheme. */
  const staticReaders: Record<string, () => Contents> = {
    "schema/document": () => schemaOf(GlideworthDocument),
    "schema/plan": () => schemaOf(Plan),
    "docs/edit-paths": () => markdown(EDIT_PATHS),
    "docs/glossary": () => markdown(GLOSSARY),
    "docs/units": () => markdown(UNITS),
    "docs/change-sets": () => markdown(CHANGE_SET_WORKFLOW),
  };
  const readPlan = (planId: string) => json(services.plans.get(planId));
  const readPlanSummary = (planId: string) => {
    const plan = services.plans.get(planId);
    return json(compactPlan(plan, planViewContext(services.households.get(plan.householdId))));
  };
  const readHouseholdDocument = (householdId: string) =>
    json(services.households.getDocument(householdId));
  const canRead = allows(ctx.scopes, "read");

  server.registerResource(
    "document-schema",
    `${RESOURCE_SCHEME}schema/document`,
    {
      title: "GlideworthDocument JSON Schema",
      description:
        "JSON Schema of the full document (household, finances, plans, progress, settings). Very large (about 100 KB): only needed to author whole documents.",
      mimeType: "application/schema+json",
    },
    (uri) => text(uri.href, staticReaders["schema/document"]!()),
  );
  server.registerResource(
    "plan-schema",
    `${RESOURCE_SCHEME}schema/plan`,
    {
      title: "Plan JSON Schema",
      description:
        "JSON Schema of a single plan (large, about 100 KB: prefer glideworth://docs/edit-paths and get_plan).",
      mimeType: "application/schema+json",
    },
    (uri) => text(uri.href, staticReaders["schema/plan"]!()),
  );
  server.registerResource(
    "edit-paths",
    `${RESOURCE_SCHEME}docs/edit-paths`,
    {
      title: "Common plan edits",
      description:
        "Ready-to-adapt JSON Patch ops for the edits people ask for most (small; read this before the big schemas).",
      mimeType: "text/markdown",
    },
    (uri) => text(uri.href, staticReaders["docs/edit-paths"]!()),
  );
  server.registerResource(
    "glossary",
    `${RESOURCE_SCHEME}docs/glossary`,
    { title: "Glossary", description: "Terms used by Glideworth.", mimeType: "text/markdown" },
    (uri) => text(uri.href, staticReaders["docs/glossary"]!()),
  );
  server.registerResource(
    "units",
    `${RESOURCE_SCHEME}docs/units`,
    {
      title: "Units and conventions",
      description: "Money, rates, bases, frequencies and patch addressing.",
      mimeType: "text/markdown",
    },
    (uri) => text(uri.href, staticReaders["docs/units"]!()),
  );
  server.registerResource(
    "change-set-workflow",
    `${RESOURCE_SCHEME}docs/change-sets`,
    {
      title: "Editing plans safely",
      description: "The propose / review / apply workflow.",
      mimeType: "text/markdown",
    },
    (uri) => text(uri.href, staticReaders["docs/change-sets"]!()),
  );

  if (canRead) {
    server.registerResource(
      "plan",
      new ResourceTemplate(`${RESOURCE_SCHEME}plans/{planId}`, {
        list: () => ({
          resources: services.plans.list().map((p) => ({
            uri: `${RESOURCE_SCHEME}plans/${p.id}`,
            name: `plan: ${p.name}`,
            description: `Plan document, version ${p.version}`,
            mimeType: "application/json",
          })),
        }),
      }),
      {
        title: "Plan document",
        description: "The full plan JSON (milestones, income, expenses, flows, assumptions, tax).",
        mimeType: "application/json",
      },
      (uri, vars) => text(uri.href, readPlan(String(vars.planId))),
    );
    server.registerResource(
      "plan-compact",
      new ResourceTemplate(`${RESOURCE_SCHEME}plans/{planId}/summary`, {
        list: () => ({
          resources: services.plans.list().map((p) => ({
            uri: `${RESOURCE_SCHEME}plans/${p.id}/summary`,
            name: `plan summary: ${p.name}`,
            mimeType: "application/json",
          })),
        }),
      }),
      {
        title: "Plan summary",
        description: "Compact plan: ids, amounts, date ranges.",
        mimeType: "application/json",
      },
      (uri, vars) => text(uri.href, readPlanSummary(String(vars.planId))),
    );
    server.registerResource(
      "household-document",
      new ResourceTemplate(`${RESOURCE_SCHEME}households/{householdId}/document`, {
        list: undefined,
      }),
      {
        title: "Household document",
        description: "The whole workspace as a GlideworthDocument (large).",
        mimeType: "application/json",
      },
      (uri, vars) => text(uri.href, readHouseholdDocument(String(vars.householdId))),
    );
  }

  // Pre-rename URIs (cairn://...): same resources, same access rules, not listed.
  const legacyRead = (path: string): Contents | null => {
    const fixed = staticReaders[path];
    if (fixed) return fixed();
    if (!canRead) return null;
    const segments = path.split("/").map((s) => decodeURIComponent(s));
    if (segments[0] === "plans" && segments.length === 2) return readPlan(segments[1]!);
    if (segments[0] === "plans" && segments.length === 3 && segments[2] === "summary")
      return readPlanSummary(segments[1]!);
    if (segments[0] === "households" && segments.length === 3 && segments[2] === "document")
      return readHouseholdDocument(segments[1]!);
    return null;
  };
  server.registerResource(
    "legacy-uri",
    new ResourceTemplate(`${LEGACY_RESOURCE_SCHEME}{+path}`, { list: undefined }),
    {
      title: "Pre-rename resource URIs (deprecated)",
      description: `${LEGACY_RESOURCE_SCHEME}<path> reads the same resource as ${RESOURCE_SCHEME}<path>.`,
    },
    (uri) => {
      const path = uri.href.slice(LEGACY_RESOURCE_SCHEME.length);
      const contents = legacyRead(path);
      if (!contents) throw new Error(`Resource ${uri.href} not found`);
      return text(uri.href, contents);
    },
  );
}
