/**
 * MCP server exposing Glideworth to AI agents. Same Services layer as REST (every tool has a REST twin).
 *
 * Safety model:
 *  - Read-only by default. Write tools register only when the server allows writes
 *    (GLIDEWORTH_MCP_ALLOW_WRITES=true) AND the caller's key has `write` scope.
 *  - Writes are change sets: propose (diff + before/after preview) -> apply. There is no
 *    whole-plan overwrite and no delete tool; "revert" is itself a proposal.
 *  - Outputs are compact JSON (no pretty-printing); heavy tools take `detail: 'summary' | 'full'`.
 */
import { type Actor, GoalSeekRequest, PatchOp } from "@glideworth/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { allows, type Principal, type Scope } from "../auth.js";
import { ApiError, describeError } from "../errors.js";
import { baseConverter } from "../fx.js";
import { findUnsafeInput } from "../security.js";
import type { JobView } from "../services/jobs.js";
import type { Services } from "../services.js";
import {
  compactAttribution,
  compactMonteCarlo,
  compactPlan,
  compactProjection,
  compactSolver,
  compactStrategies,
  compactYearNarrative,
  outcomeOf,
  roundMoney,
} from "../views.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";

export interface McpContext {
  services: Services;
  /** Scopes of the caller's key (stdio: derived from the allow-writes flag). */
  scopes: Scope[];
  /** Whether write tools may be registered (server flag && key scope). */
  canWrite: boolean;
  actor?: Actor;
  /** The authenticated caller (HTTP): writes are recorded in the audit log under this person. */
  principal?: Principal | undefined;
}

const SOLVER_KINDS = new Set([
  "max-spending",
  "earliest-retirement",
  "required-savings",
  "required-portfolio",
  "safe-withdrawal-rate",
  "goal-seek",
]);

export const SERVER_INSTRUCTIONS = [
  "Glideworth is a personal financial planning engine (retirement / life-plan projections).",
  "UNITS: money is in MAJOR currency units of the household currency (1234.56). Rates are decimal fractions (0.07 = 7%/yr).",
  'Amounts have a basis: "real" = today\'s money, "nominal" = future money. Tool outputs default to REAL (today\'s money) unless they say otherwise.',
  "START: get_plan_summary (one compact call: plan + outcome; planId defaults to the main plan, householdId to the only household). Use ids exactly as returned by list_* tools.",
  'COMMON QUESTIONS: "chance of success / why does it fail" -> run_monte_carlo (read failureAnalysis) then explain_year on the first failing year; "how much can I spend" -> solve_max_spending; "retire N years earlier" -> preview_whatif early-retirement, create_branch_from_template, compare_plans; "problems with my assumptions" -> audit_plan (each finding may carry a suggested change you can preview with preview_changes); "update balances" -> update_account_balances.',
  "MORE ANALYSIS: compare_debt_payoff (avalanche vs snowball), strategy_matrix, income_by_tax_rate, compare_sepp_methods (72(t)). MULTI-CURRENCY: list_fx_rates / set_fx_rate. CHECK-INS: what_changed_since_checkin, get_plan_health_history, list_notifications; create_share_link for read-only sharing.",
  "ANALYSE: simulate_plan (deterministic), run_monte_carlo (chance of success), explain_projection / explain_year(s) / explain_difference, audit_plan, sensitivity, compare_plans, solve_* (max spending, earliest retirement, required savings / portfolio, safe withdrawal rate), evaluate_guardrails / guyton_klinger, optimise_tax_strategy.",
  "WHAT-IF: list_whatif_templates -> preview_whatif (nothing stored) -> create_branch_from_template; survivor_scenarios for couples.",
  "MOVING COUNTRY: get_residency_timeline (who lives where, when); compare_stay_or_move (outcome and tax by country); tax_by_country (residence / source / citizenship / relief rows); explain_item_taxation (how one account, property or income is taxed and why); cross_border_rules (non-resident rules, treaties, wrapper recognition); propose_move and set_person_cross_border to edit.",
  "DATA: export_table / export_report for tables and report data; preview_csv_import (dry run) before apply_csv_import; preview_bank_file_import before apply_bank_file_import for OFX/QFX/QIF statements.",
  "EDITS: plan changes are never overwrites. Use preview_changes for what-ifs, then propose_change_set -> show the user the diff + before/after -> apply_change_set only after they agree. Edits are RFC 6902 ops; address list items by id: /income/[id=salary]/amount/value.",
  "Household data (balances, snapshots, CSV imports) is written directly by update_account_balances / record_progress_snapshot / apply_csv_import; plan edits always go through change sets or branches.",
  "Read-only unless the server enables writes; write tools are absent otherwise.",
  'Tools return compact JSON; pass detail="full" only when you need everything.',
].join("\n");

const asText = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
/** What an agent should do next, by error code: errors that say how to recover get recovered from. */
const HINTS: Record<string, string> = {
  NOT_FOUND:
    "Ids must be copied exactly from the list_* tools (list_plans, list_accounts, list_households, get_plan). Call the matching list tool and retry.",
  VALIDATION:
    "Fix the arguments named in details/message and retry. Money is in major units, rates are fractions, dates are YYYY-MM or YYYY-MM-DD.",
  VERSION_CONFLICT:
    "The plan changed since you read it. Call get_plan_summary for the current version and propose again.",
  CHANGESET_CONFLICT:
    "The plan changed after this proposal. Call get_plan_summary, then propose_change_set again against the new version.",
  CHANGESET_NOT_PROPOSED:
    "Only proposed change sets can be applied or discarded. Call get_change_set to see its status.",
  PATCH_CONFLICT:
    "An op path does not exist or a test op failed. Read get_plan for item ids and address list items as /expenses/[id=<id>]/amount/value (never by index).",
  SCENARIO:
    "The plan or request is inconsistent (dangling id, unknown person, non-scalable flow). Read the message, check ids with get_plan, and retry.",
  JOB_NOT_FINISHED: "Call get_job with this jobId and wait=60.",
  NOT_IMPLEMENTED:
    "The plan uses an engine feature that is not available yet; details.feature names it. Remove that feature or skip this analysis.",
  RATE_LIMITED: "Slow down and retry after the delay in details.retryAfterSeconds.",
  IMPORT_FAILED:
    "Run preview_csv_import (or preview_bank_file_import) first and fix the blocking issues it lists.",
};
const asError = (err: unknown, validIds?: (message: string) => string[]) => {
  const e = describeError(err);
  const hint = HINTS[e.code];
  let ids: string[] | undefined;
  if (e.code === "NOT_FOUND" && validIds)
    try {
      ids = validIds(e.message);
    } catch {
      /* best effort */
    }
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: { ...e, ...(hint ? { hint } : {}), ...(ids?.length ? { validIds: ids } : {}) },
        }),
      },
    ],
  };
};

type Extra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: never) => Promise<void>;
};

export function createMcpServer(ctx: McpContext): McpServer {
  const { services } = ctx;
  const actor: Actor = ctx.actor ?? { kind: "mcp", label: "mcp" };
  const server = new McpServer(
    { name: "glideworth", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const canRead = allows(ctx.scopes, "read");
  const canSim = allows(ctx.scopes, "simulate");

  const mainPlans = () => services.plans.list({ status: "active" }).filter((p) => p.isMain);
  /** `planId` omitted -> the main plan, when that is unambiguous (one household, or a single plan). */
  function defaultPlanId(): string {
    const mains = mainPlans();
    const all = services.plans.list({ status: "active" });
    const pick = mains.length === 1 ? mains[0] : all.length === 1 ? all[0] : undefined;
    if (pick) return pick.id;
    throw new ApiError(
      400,
      "VALIDATION",
      `planId is required here: ${all.length} plans exist${mains.length ? ` (main plans: ${mains.map((p) => p.id).join(", ")})` : ""}. Call list_plans and pass one id.`,
    );
  }
  function defaultHouseholdId(): string {
    const all = services.households.list();
    if (all.length === 1) return all[0]!.id;
    throw new ApiError(
      400,
      "VALIDATION",
      `householdId is required here: ${all.length} households exist (${all.map((h) => h.id).join(", ")}). Call list_households and pass one id.`,
    );
  }
  /** The ids that would have worked, for a NOT_FOUND on a plan or household (other kinds list nothing). */
  const validIds = (message: string) =>
    message.startsWith("plan '")
      ? services.plans.list({}).map((p) => p.id)
      : message.startsWith("household '")
        ? services.households.list().map((h) => h.id)
        : [];

  /** A friendlier version of the solver's "no scalable amount" failure: say which flows can be solved for. */
  function assertScalableFlow(planId: string, flowId: string): void {
    const plan = services.plans.get(planId);
    const scalable = plan.flows.filter(
      (f) =>
        (f.kind === "contribution" &&
          (f.method.kind === "amount" ||
            f.method.kind === "percentOfRemaining" ||
            f.method.kind === "percentOfIncome")) ||
        (f.kind === "debtPaydown" && f.method.kind === "amount"),
    );
    const flow = plan.flows.find((f) => f.id === flowId);
    if (!flow)
      throw new ApiError(404, "NOT_FOUND", `flow '${flowId}' not found in plan '${planId}'`, {
        flowIds: plan.flows.map((f) => f.id),
      });
    if (!scalable.some((f) => f.id === flowId))
      throw new ApiError(
        422,
        "SCENARIO",
        `flow '${flowId}' has no fixed amount or percentage to solve for (its method is '${"method" in flow ? (flow.method as { kind: string }).kind : flow.kind}'). Pick one of: ${scalable.map((f) => f.id).join(", ") || "(none in this plan)"}.`,
        { scalableFlowIds: scalable.map((f) => f.id) },
      );
  }
  /** Plans compared or diffed must belong to the same household (people and accounts must line up). */
  function assertSameHousehold(a: string, b: string): void {
    const pa = services.plans.get(a);
    const pb = services.plans.get(b);
    if (pa.householdId !== pb.householdId)
      throw new ApiError(
        422,
        "SCENARIO",
        `plans '${a}' and '${b}' belong to different households (${pa.householdId}, ${pb.householdId}); compare plans of one household, e.g. a plan and its branch.`,
      );
  }

  type Hint = { readOnly: boolean; idempotent?: boolean; destructive?: boolean };
  function tool<S extends z.ZodRawShape>(
    name: string,
    cfg: { title: string; description: string; input: S; hint: Hint },
    handler: (args: z.infer<z.ZodObject<S>>, extra: Extra) => unknown | Promise<unknown>,
  ) {
    server.registerTool(
      name,
      {
        title: cfg.title,
        description: cfg.description,
        inputSchema: cfg.input,
        annotations: {
          readOnlyHint: cfg.hint.readOnly,
          destructiveHint: cfg.hint.destructive ?? false,
          idempotentHint: cfg.hint.idempotent ?? cfg.hint.readOnly,
          openWorldHint: false,
        },
      },
      (async (args: z.infer<z.ZodObject<S>>, extra: Extra) => {
        try {
          const a = args as Record<string, unknown>;
          const unsafe = findUnsafeInput(a);
          if (unsafe)
            throw new ApiError(
              400,
              "VALIDATION",
              `forbidden key or path segment at ${unsafe} (__proto__, constructor, prototype)`,
            );
          if ("planId" in cfg.input && cfg.input.planId === planId && a.planId === undefined)
            a.planId = defaultPlanId();
          if (
            "householdId" in cfg.input &&
            cfg.input.householdId === householdId &&
            a.householdId === undefined
          )
            a.householdId = defaultHouseholdId();
          const out = await handler(args, extra);
          if (!cfg.hint.readOnly)
            services.audit.record({
              userId: ctx.principal?.userId ?? null,
              userName: ctx.principal?.userName ?? null,
              via: ctx.principal?.via === "oauth" ? "oauth" : "mcp",
              credentialId: ctx.principal?.keyId ?? actor.id ?? null,
              action: `mcp:${name}`,
              resourceType: "planId" in a ? "plan" : "householdId" in a ? "household" : null,
              resourceId:
                (a.planId as string | undefined) ?? (a.householdId as string | undefined) ?? null,
              status: 200,
            });
          return asText(out);
        } catch (err) {
          return asError(err, validIds);
        }
      }) as never,
    );
  }

  // Optional at runtime (the `tool` wrapper fills in the main plan); typed as required for the handlers.
  const planId = z
    .string()
    .optional()
    .describe("Plan id from list_plans. Default: the main plan.") as unknown as z.ZodString;
  /** A plan that must be named (comparisons): there is no sensible default. */
  const planRef = z.string().describe("Plan id from list_plans.");
  const householdId = z
    .string()
    .optional()
    .describe(
      "Household id from list_households. Default: the only household.",
    ) as unknown as z.ZodString;
  const detail = z
    .enum(["summary", "full"])
    .default("summary")
    .describe("'summary' = compact (default); 'full' = everything (large).");
  const waitSeconds = z
    .number()
    .min(0)
    .max(110)
    .default(30)
    .describe(
      "Seconds to wait for the result. If it is not finished, a jobId is returned: poll get_job.",
    );

  /** Wait for a job, forwarding progress to the client when it asked for it. */
  async function awaitJob(job: JobView, wait: number, extra: Extra): Promise<JobView> {
    const token = extra._meta?.progressToken;
    let off = () => {};
    if (token !== undefined)
      off = services.jobs.subscribe(job.id, (v) => {
        void extra
          .sendNotification({
            method: "notifications/progress",
            params: { progressToken: token, progress: Math.round(v.progress * 100), total: 100 },
          } as never)
          .catch(() => {});
      });
    try {
      return await services.jobs.waitFor(job.id, wait * 1000);
    } finally {
      off();
    }
  }

  const jobOut = (job: JobView, finished: (result: unknown) => unknown) => {
    if (job.status === "succeeded") {
      const body = finished(services.jobs.result(job.id)) as Record<string, unknown>;
      // A solver result has its own `status` (converged / max-evaluations...): keep it, as `solverStatus`.
      const { status: solverStatus, ...rest } = body;
      return {
        ...rest,
        jobId: job.id,
        status: job.status,
        cached: job.cached,
        ...(solverStatus !== undefined ? { solverStatus } : {}),
      };
    }
    if (job.status === "failed" || job.status === "cancelled")
      return { jobId: job.id, status: job.status, error: job.error };
    return {
      jobId: job.id,
      status: job.status,
      progress: Math.round(job.progress * 100) / 100,
      hint: "Not finished yet: call get_job with this jobId (or cancel_job).",
    };
  };

  // =============================================================================== read tools
  if (canRead) {
    tool(
      "list_households",
      {
        title: "List households",
        description:
          "List households (id, name, people, currency, location). Usually there is exactly one.",
        input: {},
        hint: { readOnly: true },
      },
      () =>
        services.households.list().map((h) => ({
          id: h.id,
          name: h.name,
          mode: h.planningMode,
          people: h.people.map((p) => ({
            id: p.id,
            name: p.name,
            role: p.role,
            born: p.birthMonth,
          })),
          dependents: h.dependents.length,
          currency: h.currency,
          location: h.location,
        })),
    );

    tool(
      "get_household",
      {
        title: "Get household",
        description:
          "A household with its current finances: accounts, real assets, debts and totals (today's money). 'full' returns the raw documents.",
        input: { householdId, detail },
        hint: { readOnly: true },
      },
      ({ householdId, detail }) => {
        const rec = services.households.get(householdId);
        if (detail === "full") return rec;
        const f = rec.finances;
        const fx = baseConverter(f, rec.household.currency);
        const accounts = f.accounts.filter((a) => !a.archived);
        return {
          id: rec.household.id,
          name: rec.household.name,
          version: rec.version,
          currency: rec.household.currency,
          asOf: f.asOf,
          people: rec.household.people.map((p) => ({
            id: p.id,
            name: p.name,
            role: p.role,
            born: p.birthMonth,
          })),
          accounts: accounts.map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            owner: a.owner,
            balance: roundMoney(a.balance),
            ...(a.currency && a.currency !== rec.household.currency
              ? { currency: a.currency }
              : {}),
          })),
          realAssets: f.realAssets
            .filter((r) => !r.archived)
            .map((r) => ({
              id: r.id,
              name: r.name,
              type: r.type,
              value: roundMoney(r.currentValue),
              loan: r.loan ? roundMoney(r.loan.balance) : 0,
            })),
          debts: f.debts
            .filter((d) => !d.archived)
            .map((d) => ({ id: d.id, name: d.name, type: d.type, balance: roundMoney(d.balance) })),
          // Totals are in the household currency (foreign items converted with the FX rates).
          totals: {
            accounts: roundMoney(
              accounts.reduce((s, a) => s + fx.convert(a.balance, a.currency), 0),
            ),
            realAssets: roundMoney(
              f.realAssets.reduce((s, r) => s + fx.convert(r.currentValue, r.currency), 0),
            ),
            liabilities: roundMoney(
              f.debts.reduce((s, d) => s + fx.convert(d.balance, d.currency), 0) +
                f.realAssets.reduce((s, r) => s + fx.convert(r.loan?.balance ?? 0, r.currency), 0),
            ),
          },
          ...(fx.missing.size ? { missingFxRates: [...fx.missing] } : {}),
        };
      },
    );

    tool(
      "list_accounts",
      {
        title: "List accounts",
        description:
          "Accounts of a household: id, name, type, owner, balance. Use these ids in update_account_balances and plan edits.",
        input: { householdId, includeArchived: z.boolean().default(false) },
        hint: { readOnly: true },
      },
      ({ householdId, includeArchived }) =>
        services.households.listFinance(householdId, "accounts", includeArchived).map((a) => ({
          id: a.id,
          name: a.name,
          type: (a as { type: string }).type,
          owner: a.owner,
          balance: roundMoney((a as { balance: number }).balance),
          ...(a.archived ? { archived: true } : {}),
        })),
    );

    tool(
      "list_plans",
      {
        title: "List plans",
        description:
          "List plans (id, name, version, isMain, status, parent if it is a branch). Version is needed for safe edits.",
        input: {
          householdId: z.string().optional(),
          status: z.enum(["active", "archived"]).optional(),
        },
        hint: { readOnly: true },
      },
      ({ householdId, status }) =>
        services.plans.list({ householdId, status }).map((p) => ({
          id: p.id,
          name: p.name,
          householdId: p.householdId,
          version: p.version,
          isMain: p.isMain,
          status: p.status,
          ...(p.lineage ? { branchOf: p.lineage.parentPlanId } : {}),
          ...(p.description ? { description: p.description } : {}),
        })),
    );

    tool(
      "get_plan",
      {
        title: "Get plan",
        description:
          "A plan. 'summary' (default) lists milestones, income, expenses and flows with ids, amounts (value basis/frequency) and date ranges. 'full' is the complete plan JSON (very large).",
        input: { planId, detail },
        hint: { readOnly: true },
      },
      ({ planId, detail }) => {
        const plan = services.plans.get(planId);
        return detail === "full"
          ? plan
          : compactPlan(plan, {
              currency: services.households.get(plan.householdId).household.currency,
            });
      },
    );

    tool(
      "list_plan_versions",
      {
        title: "List plan versions",
        description:
          "Edit history of a plan, newest first: version, time, who (actor), message. Use with propose_revert.",
        input: { planId, limit: z.number().int().min(1).max(100).default(20) },
        hint: { readOnly: true },
      },
      ({ planId, limit }) =>
        services.plans
          .listVersions(planId)
          .slice(0, limit)
          .map((v) => ({
            version: v.version,
            at: v.createdAt,
            by: v.actor,
            message: v.message,
            changeSetId: v.changeSetId,
          })),
    );

    tool(
      "diff_plans",
      {
        title: "Diff two plans",
        description: "Human-readable differences between two plans (e.g. a branch and its parent).",
        input: { basePlanId: planRef, otherPlanId: planRef },
        hint: { readOnly: true },
      },
      ({ basePlanId, otherPlanId }) => {
        assertSameHousehold(basePlanId, otherPlanId);
        const diff = services.ctx.deps.diffPlans(
          services.plans.get(basePlanId),
          services.plans.get(otherPlanId),
        );
        return {
          count: diff.changes.length,
          changes: diff.changes.slice(0, 60).map((c) => c.description),
          truncated: diff.changes.length > 60,
        };
      },
    );

    tool(
      "list_progress_snapshots",
      {
        title: "List progress snapshots",
        description: "Recorded actuals over time (net worth, assets, liabilities), newest first.",
        input: {
          householdId,
          from: z.string().optional().describe("YYYY-MM-DD"),
          to: z.string().optional().describe("YYYY-MM-DD"),
          limit: z.number().int().min(1).max(200).default(24),
        },
        hint: { readOnly: true },
      },
      ({ householdId, from, to, limit }) =>
        services.households
          .listSnapshots(householdId, { from, to })
          .slice(0, limit)
          .map((s) => ({
            id: s.id,
            date: s.date,
            netWorth: roundMoney(s.netWorth),
            assets: roundMoney(s.assets),
            liabilities: roundMoney(s.liabilities),
            source: s.source,
            ...(s.note ? { note: s.note } : {}),
          })),
    );

    tool(
      "list_change_sets",
      {
        title: "List change sets",
        description: "Proposed/applied/discarded change sets (summary and status only).",
        input: {
          planId: z.string().optional(),
          status: z.enum(["proposed", "applied", "discarded", "conflict"]).optional(),
        },
        hint: { readOnly: true },
      },
      ({ planId, status }) =>
        services.changeSets.list({ planId, status }).map((c) => ({
          id: c.id,
          planId: c.planId,
          baseVersion: c.baseVersion,
          status: c.status,
          summary: c.summary,
          createdAt: c.createdAt,
        })),
    );

    tool(
      "get_change_set",
      {
        title: "Get change set",
        description: "A change set with its ops, readable changes and before/after preview.",
        input: { changeSetId: z.string() },
        hint: { readOnly: true },
      },
      ({ changeSetId }) => {
        const c = services.changeSets.get(changeSetId);
        return { ...c, changes: c.changes.map((x) => x.description) };
      },
    );
  }

  // =============================================================================== data tools (read)
  if (canRead) {
    tool(
      "export_table",
      {
        title: "Export a projection table",
        description:
          "A year-by-year projection table (year-by-year, cash-flow, taxes, account-balances) as compact rows, or as CSV text. Money in the requested basis (default real).",
        input: {
          planId,
          table: z
            .enum(["year-by-year", "cash-flow", "taxes", "account-balances"])
            .default("year-by-year"),
          basis: z.enum(["real", "nominal"]).default("real"),
          format: z.enum(["rows", "csv"]).default("rows"),
          everyNYears: z
            .number()
            .int()
            .min(1)
            .max(50)
            .default(5)
            .describe("Keep every Nth year (first and last always kept)."),
        },
        hint: { readOnly: true },
      },
      ({ planId, table, basis, format, everyNYears }) => {
        const out = services.exports.projectionTable(planId, table, basis, "json");
        const t = out.table!;
        const rows = t.rows.filter((_, i) => i % everyNYears === 0 || i === t.rows.length - 1);
        if (format === "csv")
          return { csv: services.ctx.imports.tableToCsv({ ...t, rows }), rows: rows.length };
        return {
          id: t.id,
          title: t.title,
          basis: t.basis,
          currency: t.currency,
          columns: t.columns.map((c) => c.label),
          rows,
        };
      },
    );

    tool(
      "export_report",
      {
        title: "Report data",
        description:
          "The printable report for a plan as data: key figures, milestones, assumptions, current finances, caveats and thinned series. (The year table is in export_table.)",
        input: {
          planId,
          basis: z.enum(["real", "nominal"]).default("real"),
          tableEvery: z.number().int().min(1).max(25).default(5),
        },
        hint: { readOnly: true },
      },
      ({ planId, basis, tableEvery }) => {
        const r = services.exports.report(planId, { basis, tableEvery });
        return {
          ...r,
          series: r.series.map((s) => ({
            ...s,
            points: s.points
              .filter((_, i) => i % tableEvery === 0 || i === s.points.length - 1)
              .map((p) => ({
                year: p.year,
                value: roundMoney(p.value),
              })),
          })),
        };
      },
    );

    tool(
      "preview_csv_import",
      {
        title: "Preview a CSV import (dry run)",
        description:
          "Parse CSV text (account balances, progress/net-worth history or transactions) and show what an import would do: detected columns, issues and a reconciliation of before/after balances. Writes nothing. Use apply_csv_import to apply.",
        input: {
          householdId,
          kind: z.enum(["account-balances", "progress-snapshots", "transactions"]),
          text: z.string().max(2_000_000).describe("The CSV file contents."),
          options: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              'e.g. {"accountMap":{"ISA":"uk-isa"},"createMissing":false,"columns":{"balance":"Closing balance"}}',
            ),
          planId: z
            .string()
            .optional()
            .describe("transactions: the plan that receives the expense events."),
        },
        hint: { readOnly: true },
      },
      ({ householdId, kind, text, options, planId }) =>
        services.imports.importCsv(
          householdId,
          {
            text,
            kind,
            dryRun: true,
            ...(options ? { options: options as never } : {}),
            ...(planId ? { planId } : {}),
          },
          actor,
        ),
    );
  }

  if (canRead) {
    tool(
      "preview_bank_file_import",
      {
        title: "Preview an OFX/QIF import",
        description:
          "Parse a bank or card statement (OFX, QFX or QIF text) and show what importing it would do: accounts found (numbers masked), balance reconciliation against current finances, spending summarised into annual expense events, issues. Writes nothing. Use apply_bank_file_import to apply.",
        input: {
          householdId,
          text: z.string().max(2_000_000).describe("The file contents."),
          format: z.enum(["ofx", "qif", "auto"]).default("auto"),
          planId: z
            .string()
            .optional()
            .describe("Plan that would receive the annual expense events."),
          createMissing: z
            .boolean()
            .default(false)
            .describe("Create accounts that do not exist yet."),
        },
        hint: { readOnly: true },
      },
      ({ householdId, text, format, planId, createMissing }) =>
        services.imports.importBankFile(
          householdId,
          {
            text,
            format,
            dryRun: true,
            ...(planId ? { planId } : {}),
            balances: { createMissing },
          },
          actor,
        ),
    );
  }

  // =============================================================================== compute tools
  if (canSim) {
    tool(
      "get_plan_summary",
      {
        title: "Plan summary with outcome",
        description:
          "Best first call: the compact plan (ids, amounts, dates), the household's current finances (net worth, accounts, debts) and the deterministic outcome (success, end net worth, first shortfall year, milestones, warnings) with a 5-yearly net-worth table in today's money. For the chance of success call run_monte_carlo.",
        input: { planId, basis: z.enum(["real", "nominal"]).default("real") },
        hint: { readOnly: true },
      },
      ({ planId, basis }) => {
        const plan = services.plans.get(planId);
        const hh = services.households.get(plan.householdId);
        let outcome: unknown;
        try {
          const run = services.sim.projection(planId, { trace: "off" });
          const view = compactProjection(
            run.result,
            {
              basis,
              everyNYears: 5,
              include: ["summary", "milestones", "warnings"],
              series: ["netWorth", "liquidNetWorth", "spending", "taxes", "shortfall"],
            },
            run.cached,
          );
          outcome = {
            ...outcomeOf(run.result),
            success: run.result.summary.success,
            currency: hh.household.currency,
            basis,
            milestones: view.milestones,
            warnings: view.warnings?.slice(0, 12),
            ...((view.warnings?.length ?? 0) > 12 ? { warningsTotal: view.warnings?.length } : {}),
            years: view.years,
          };
        } catch (err) {
          outcome = { error: describeError(err) };
        }
        const f = hh.finances;
        const accounts = f.accounts.filter((a) => !a.archived).reduce((t, a) => t + a.balance, 0);
        const realAssets = f.realAssets
          .filter((r) => !r.archived)
          .reduce((t, r) => t + r.currentValue, 0);
        const liabilities =
          f.debts.filter((d) => !d.archived).reduce((t, d) => t + d.balance, 0) +
          f.realAssets.filter((r) => !r.archived).reduce((t, r) => t + (r.loan?.balance ?? 0), 0);
        return {
          plan: compactPlan(plan, { currency: hh.household.currency }),
          finances: {
            householdId: hh.household.id,
            asOf: f.asOf,
            accounts: roundMoney(accounts),
            realAssets: roundMoney(realAssets),
            liabilities: roundMoney(liabilities),
            netWorth: roundMoney(accounts + realAssets - liabilities),
            note: "Today's money. Account-level detail: get_household.",
          },
          outcome,
        };
      },
    );

    tool(
      "simulate_plan",
      {
        title: "Simulate plan",
        description:
          "Deterministic projection of a stored plan, compact: per-year series in the requested basis. Choose years/series to keep it small. For chance of success use run_monte_carlo.",
        input: {
          planId,
          basis: z.enum(["real", "nominal"]).default("real").describe("'real' = today's money"),
          fromYear: z.number().int().optional(),
          toYear: z.number().int().optional(),
          everyNYears: z.number().int().min(1).max(10).default(1),
          series: z
            .array(
              z.enum([
                "netWorth",
                "liquidNetWorth",
                "assets",
                "liabilities",
                "portfolio",
                "cash",
                "realAssets",
                "income",
                "passiveIncome",
                "expenses",
                "spending",
                "taxes",
                "contributions",
                "withdrawals",
                "savingsRate",
                "withdrawalRate",
                "shortfall",
              ]),
            )
            .optional(),
          accountIds: z
            .array(z.string())
            .optional()
            .describe("Also return these accounts' balances per year."),
        },
        hint: { readOnly: true },
      },
      ({ planId, ...view }) =>
        services.sim.simulate(planId, {
          trace: "off",
          view: { ...view, include: ["summary", "milestones", "warnings"] },
        }),
    );

    tool(
      "run_monte_carlo",
      {
        title: "Run Monte Carlo",
        description:
          "Chance of success. Returns a one-sentence headline, the success rate, outcome category counts, a thinned p10/p50/p90 net-worth fan, and (when some trials fail) failureAnalysis: the years first shortfalls land in, sequence-of-returns risk and failures before/after retirement. Fixed default seed: reproducible and comparable across plans; pass seed to vary.",
        input: {
          planId,
          trials: z
            .number()
            .int()
            .min(100)
            .max(10_000)
            .optional()
            .describe("Default: the plan's setting (usually 1000)."),
          seed: z.number().int().min(0).optional(),
          method: z
            .enum([
              "normal",
              "historical-random-restart",
              "historical-sequential",
              "block-bootstrap",
            ])
            .optional(),
          detail,
          wait: waitSeconds,
        },
        hint: { readOnly: true, idempotent: true },
      },
      async ({ planId, trials, seed, method, detail, wait }, extra) => {
        const settings = {
          ...(trials ? { trials } : {}),
          ...(seed !== undefined ? { seed } : {}),
          ...(method ? { method } : {}),
        };
        const job = services.sim.startMonteCarlo(
          planId,
          { settings, keepTrials: false, randomSeed: false },
          actor,
        );
        return jobOut(await awaitJob(job, wait, extra), (r) =>
          compactMonteCarlo(r as never, { detail }),
        );
      },
    );

    tool(
      "run_historical_backtest",
      {
        title: "Run historical backtest",
        description:
          "Replay the plan through every historical start year (no randomness). Returns the share of start years that succeeded and the worst cases.",
        input: { planId, detail, wait: waitSeconds },
        hint: { readOnly: true, idempotent: true },
      },
      async ({ planId, detail, wait }, extra) => {
        const job = services.sim.startHistorical(planId, {}, actor);
        return jobOut(await awaitJob(job, wait, extra), (r) =>
          compactMonteCarlo(r as never, { detail }),
        );
      },
    );

    tool(
      "compare_plans",
      {
        title: "Compare plans",
        description:
          "Outcomes of 2-6 plans side by side (the first is the baseline) with what differs and, optionally, why the outcome differs.",
        input: { planIds: z.array(z.string()).min(2).max(6), explain: z.boolean().default(false) },
        hint: { readOnly: true },
      },
      ({ planIds, explain }) => {
        for (const id of planIds.slice(1)) assertSameHousehold(planIds[0]!, id);
        return services.sim.compare(planIds, explain);
      },
    );

    tool(
      "explain_projection",
      {
        title: "Explain projection",
        description:
          "Why the plan ended up where it did: findings from the engine trace and ledger (shortfalls, withdrawal sources, tax drivers). Optional question focuses it.",
        input: { planId, question: z.string().max(500).optional(), detail },
        hint: { readOnly: true },
      },
      ({ planId, question, detail }) => {
        const out = services.sim.explain(planId, question);
        if (detail === "full") return out;
        return { ...out, findings: out.findings.map(({ evidence: _evidence, ...f }) => f) };
      },
    );

    tool(
      "audit_plan",
      {
        title: "Audit assumptions",
        description:
          "Checks for modelling mistakes and weak assumptions (double-counted housing, real/nominal mix-ups, implausible returns, missing late-life care, high early withdrawal rate, penalised withdrawals), most severe first. A finding with a `fix` has ready-made ops: preview_changes, then propose_change_set.",
        input: { planId, detail },
        hint: { readOnly: true },
      },
      ({ planId, detail }) => {
        const out = services.sim.audit(planId);
        if (detail === "full") return out;
        // Findings carry a `fix` (description + ops): pass its ops to preview_changes / propose_change_set.
        return { ...out, findings: out.findings.map(({ evidence: _evidence, ...f }) => f) };
      },
    );

    tool(
      "sensitivity",
      {
        title: "Sensitivity analysis",
        description:
          "Tornado: how much returns, inflation, spending, income, retirement date and life expectancy move the outcome. Deterministic metrics are instant; successRate runs Monte Carlo.",
        input: {
          planId,
          metric: z
            .enum(["endNetWorthReal", "lifetimeTaxesReal", "totalShortfallReal", "successRate"])
            .default("endNetWorthReal"),
          wait: waitSeconds,
        },
        hint: { readOnly: true },
      },
      async ({ planId, metric, wait }, extra) => {
        if (metric !== "successRate") return services.sim.sensitivity(planId, { metric });
        const job = services.sim.startSensitivity(planId, { metric }, actor);
        return jobOut(await awaitJob(job, wait, extra), (r) => r);
      },
    );

    const targetSuccessRate = z
      .number()
      .min(0.01)
      .max(1)
      .default(0.85)
      .describe("Target chance of success, 0..1 (0.85 = 85%).");
    const solverTrials = z
      .number()
      .int()
      .min(50)
      .max(10_000)
      .optional()
      .describe(
        "Monte Carlo trials per evaluation (default: the plan's setting). Fewer = faster, noisier.",
      );
    for (const [name, kind, title, description, extraShape] of [
      [
        "solve_max_spending",
        "max-spending",
        "Solve max sustainable spending",
        "How much can I spend? The largest spending level that still meets the target success rate (default 85%; pass 0.9 for 90%). `answer` says it in money per year; `ops` apply it to the plan expenses.",
        {},
      ],
      [
        "solve_retirement_date",
        "earliest-retirement",
        "Solve earliest retirement",
        "Earliest retirement month that still meets the target success rate (give the retirement milestone id). `answer` and details give the date, age and months earlier than planned.",
        { milestoneId: z.string().describe("Milestone id from get_plan.") },
      ],
      [
        "solve_required_savings",
        "required-savings",
        "Solve required savings",
        "How much must I save? Smallest scale on a contribution flow (one with a fixed amount or percentage) that reaches the target success rate (give the flow id from get_plan).",
        { flowId: z.string().describe("Flow id from get_plan.") },
      ],
      [
        "solve_required_portfolio",
        "required-portfolio",
        "Solve required portfolio",
        "How much do I need to have saved? Smallest invested portfolio that still meets the target success rate; details give the required and current amounts and the gap.",
        { accountIds: z.array(z.string()).optional().describe("Only scale these accounts.") },
      ],
      [
        "solve_safe_withdrawal_rate",
        "safe-withdrawal-rate",
        "Solve safe withdrawal rate",
        "Highest constant withdrawal rate (share of the invested portfolio) that still meets the target success rate over `years`; details give the rate and the money per year.",
        {
          years: z
            .number()
            .int()
            .min(1)
            .max(80)
            .optional()
            .describe("Retirement length (default 30)."),
          accountIds: z.array(z.string()).optional(),
        },
      ],
    ] as const) {
      tool(
        name,
        {
          title,
          description,
          input: {
            planId,
            targetSuccessRate,
            trials: solverTrials,
            maxEvaluations: z
              .number()
              .int()
              .min(1)
              .max(200)
              .optional()
              .describe("Search budget (default ~30)."),
            detail,
            wait: waitSeconds,
            ...extraShape,
          } as z.ZodRawShape,
          hint: { readOnly: true, idempotent: true },
        },
        async (args, extra) => {
          const { planId, wait, trials, detail, ...body } = args as {
            planId: string;
            wait: number;
            trials?: number;
            detail: "summary" | "full";
          } & Record<string, unknown>;
          if (kind === "required-savings") assertScalableFlow(planId, body.flowId as string);
          const job = services.sim.startSolver(
            kind,
            planId,
            { ...body, ...(trials ? { monteCarlo: { trials } } : {}) },
            actor,
          );
          return jobOut(await awaitJob(job, wait, extra), (r) => compactSolver(r as never, detail));
        },
      );
    }

    tool(
      "goal_seek",
      {
        title: "Generic goal seek",
        description:
          "Find the value of any plan variable (spendingScale, milestoneMonth, flowScale, path) that just meets an objective. Prefer the solve_* tools for common cases.",
        input: {
          planId,
          variable: z
            .record(z.string(), z.unknown())
            .describe(
              'e.g. {"kind":"spendingScale"} | {"kind":"path","path":"/expenses/[id=rent]/amount/value"}',
            ),
          objective: z
            .record(z.string(), z.unknown())
            .describe('e.g. {"kind":"successRate","target":0.85}'),
          direction: z.enum(["maximize", "minimize"]),
          bounds: z.object({ min: z.number(), max: z.number() }),
          detail,
          wait: waitSeconds,
        },
        hint: { readOnly: true, idempotent: true },
      },
      async ({ planId, wait, detail, ...req }, extra) => {
        const parsed = GoalSeekRequest.parse(req);
        const job = services.sim.startSolver("goal-seek", planId, parsed, actor);
        return jobOut(await awaitJob(job, wait, extra), (r) => compactSolver(r as never, detail));
      },
    );

    tool(
      "evaluate_guardrails",
      {
        title: "Evaluate spending guardrails",
        description:
          "Risk-based guardrails: what the guardrail rules give for this year's spending (hold / cut / raise) and why, from the plan's riskGuardrails.",
        input: {
          planId,
          trials: z
            .number()
            .int()
            .min(50)
            .max(10_000)
            .optional()
            .describe(
              "Monte Carlo trials per evaluation (guardrails run many simulations; fewer = faster).",
            ),
          wait: waitSeconds,
        },
        hint: { readOnly: true, idempotent: true },
      },
      async ({ planId, trials, wait }, extra) =>
        jobOut(
          await awaitJob(
            services.sim.startGuardrails(planId, trials ? { monteCarlo: { trials } } : {}, actor),
            wait,
            extra,
          ),
          (r) => r,
        ),
    );

    tool(
      "tax_breakdown",
      {
        title: "Tax breakdown",
        description: "Taxes per year by jurisdiction and kind, with effective and marginal rates.",
        input: {
          planId,
          fromYear: z.number().int().optional(),
          toYear: z.number().int().optional(),
          basis: z.enum(["real", "nominal"]).default("real"),
          detail: z.enum(["summary", "lines"]).default("summary"),
        },
        hint: { readOnly: true },
      },
      ({ planId, ...q }) => services.sim.taxBreakdown(planId, q),
    );

    tool(
      "tax_by_country",
      {
        title: "Tax by country and basis",
        description:
          "Cross-border plans: lifetime and per-year tax per country and basis (residence = where you live, source = charged as a non-resident, citizenship = US citizens abroad, relief = credit for tax paid elsewhere (negative), exit = departure tax, return = UK temporary non-residence). Single-country plans show one residence row. Includes the simplifications that apply.",
        input: {
          planId,
          basis: z.enum(["real", "nominal"]).default("real"),
          fromYear: z.number().int().optional(),
          toYear: z.number().int().optional(),
          everyNYears: z
            .number()
            .int()
            .min(1)
            .max(50)
            .default(5)
            .describe("Thin the per-year rows."),
        },
        hint: { readOnly: true },
      },
      ({ planId, everyNYears, ...q }) => {
        const out = services.crossBorder.taxByCountry(planId, q);
        const { bases: _bases, ...rest } = out;
        return {
          ...rest,
          years: out.years.filter((_, i) => i % everyNYears === 0 || i === out.years.length - 1),
        };
      },
    );

    tool(
      "explain_item_taxation",
      {
        title: "How is this item taxed, and why",
        description:
          "For one account, real asset, debt or income: its country, the owner's residence that year (split years list both), and per income category whether the source country taxes it (non-resident rule), the treaty article, whether the residence country taxes it and the relief (credit / exemption). Warnings flag unknown treaty pairs and unrecognised foreign wrappers. Ids from get_household / get_plan.",
        input: {
          planId,
          itemId: z.string().describe("Account, real asset, debt or income id."),
          year: z.number().int().optional().describe("Default: the first full projected year."),
        },
        hint: { readOnly: true },
      },
      ({ planId, itemId, year }) => {
        const e = services.crossBorder.explainItem(planId, itemId, year);
        return {
          ...e,
          treatments: e.treatments.map(({ sources: _s, ...t }) => t),
        };
      },
    );

    tool(
      "compare_stay_or_move",
      {
        title: "Compare staying with moving country",
        description:
          "Simulates the plan as is and with a move (to + month, optional returnMonth and personId), or against an existing plan (movePlanId, e.g. a relocation branch). Returns outcome deltas (today's money), lifetime tax by country and basis for both, an attribution of the difference and the plan changes. Nothing is stored; follow with create_branch_from_template templateId=relocation to keep it.",
        input: {
          planId,
          to: z
            .object({ country: z.string().length(2), region: z.string().max(10).optional() })
            .optional()
            .describe('Destination, e.g. {"country":"AE"}.'),
          month: z.string().optional().describe("YYYY-MM, first month living there."),
          returnMonth: z.string().optional().describe("YYYY-MM, first month back (optional)."),
          personId: z.string().optional().describe("Who moves (default: everyone)."),
          movePlanId: z.string().optional(),
        },
        hint: { readOnly: true },
      },
      ({ planId, ...req }) => {
        const out = services.crossBorder.stayOrMove(planId, {
          ...(req.to
            ? {
                to: {
                  country: req.to.country.toUpperCase(),
                  ...(req.to.region ? { region: req.to.region } : {}),
                },
              }
            : {}),
          ...(req.month ? { month: req.month } : {}),
          ...(req.returnMonth ? { returnMonth: req.returnMonth } : {}),
          ...(req.personId ? { personId: req.personId } : {}),
          ...(req.movePlanId ? { movePlanId: req.movePlanId } : {}),
          basis: "real",
        });
        const { ops: _ops, ...rest } = out;
        return { ...rest, changes: out.changes.slice(0, 30) };
      },
    );

    tool(
      "preview_changes",
      {
        title: "Preview changes (what-if)",
        description:
          "Apply RFC 6902 ops IN MEMORY and return what would change plus before/after outcomes. Stores nothing. Use before propose_change_set. Address list items by id: /expenses/[id=rent]/amount/value.",
        input: {
          planId,
          ops: z
            .array(z.record(z.string(), z.unknown()))
            .min(1)
            .max(50)
            .describe('[{"op":"replace","path":"/expenses/[id=rent]/amount/value","value":2400}]'),
        },
        hint: { readOnly: true },
      },
      async ({ planId, ops }) => {
        const out = services.sim.preview(planId, z.array(PatchOp).parse(ops));
        return {
          planVersion: out.plan.version,
          changes: out.diff.changes.slice(0, 40).map((c) => c.description),
          preview: out.preview,
        };
      },
    );

    tool(
      "explain_year",
      {
        title: "Explain one year",
        description:
          "Where the money went in a single year: income, outflows, saving, withdrawals (by account), investment return and the net-worth change, as a short narrative plus top line items.",
        input: {
          planId,
          year: z.number().int().describe("Calendar year, e.g. 2041."),
          basis: z.enum(["real", "nominal"]).default("real"),
          detail,
        },
        hint: { readOnly: true },
      },
      ({ planId, year, basis, detail }) => {
        const n = services.sim.explainYear(planId, { year, basis });
        return { planId: n.planId, planVersion: n.planVersion, ...compactYearNarrative(n, detail) };
      },
    );

    tool(
      "explain_years",
      {
        title: "Explain a range of years",
        description:
          'Narratives for several years (every Nth), compact. Good for "walk me through retirement".',
        input: {
          planId,
          fromYear: z.number().int().optional(),
          toYear: z.number().int().optional(),
          everyNYears: z.number().int().min(1).max(50).default(5),
          basis: z.enum(["real", "nominal"]).default("real"),
          detail,
        },
        hint: { readOnly: true },
      },
      ({ planId, detail, ...q }) => {
        const out = services.sim.explainYears(planId, q);
        return {
          planId: out.planId,
          planVersion: out.planVersion,
          years: out.years.map((y) => compactYearNarrative(y, detail)),
        };
      },
    );

    tool(
      "explain_difference",
      {
        title: "Explain a difference between two plans",
        description:
          "Why do two plans end differently? What changed, a plain-language explanation and (attribute=true) how much of the outcome difference each individual edit explains. metric=successRate runs Monte Carlo.",
        input: {
          basePlanId: planRef,
          otherPlanId: planRef,
          attribute: z.boolean().default(true),
          metric: z
            .enum(["endNetWorthReal", "lifetimeTaxesReal", "totalShortfallReal", "successRate"])
            .default("endNetWorthReal"),
          detail,
          wait: waitSeconds,
        },
        hint: { readOnly: true },
      },
      async ({ basePlanId, otherPlanId, attribute, metric, detail, wait }, extra) => {
        assertSameHousehold(basePlanId, otherPlanId);
        if (attribute && metric === "successRate") {
          const job = services.sim.startAttribution(
            basePlanId,
            otherPlanId,
            { metric: "successRate" },
            actor,
          );
          return jobOut(await awaitJob(job, wait, extra), (r) => ({
            attribution: compactAttribution(r as never, detail),
          }));
        }
        const out = await services.sim.explainDifference(basePlanId, otherPlanId, {
          attribute,
          metric: metric === "successRate" ? "endNetWorthReal" : metric,
        });
        return {
          ...out,
          changes: out.changes.slice(0, 40),
          ...(out.attribution ? { attribution: compactAttribution(out.attribution, detail) } : {}),
        };
      },
    );

    tool(
      "guyton_klinger",
      {
        title: "Guyton-Klinger guardrails",
        description:
          "Money-terms guardrails: spending above which to cut (and portfolio below which), and the mirror raise rule, plus the action now. Defaults come from the plan. For success-rate based guardrails use evaluate_guardrails.",
        input: {
          planId,
          portfolio: z.number().positive().optional(),
          spending: z.number().positive().optional().describe("Annual spending, today's money."),
          initialRate: z.number().positive().optional(),
          guardrail: z.number().positive().max(1).optional().describe("Band width, default 0.2."),
          adjustment: z
            .number()
            .positive()
            .max(1)
            .optional()
            .describe("Cut/raise size, default 0.1."),
        },
        hint: { readOnly: true },
      },
      ({ planId, ...q }) => services.sim.guytonKlinger(planId, q),
    );

    tool(
      "optimise_tax_strategy",
      {
        title: "Compare tax strategies",
        description:
          "Compare tax strategies on the household's own inputs: drawdown order, UK personal-allowance use / lump-sum timing, US bracket filling. Pass `candidates` (plan patches) to compare your own instead. Returns them ordered by the chosen measure and the highest-scoring one as ops you can preview.",
        input: {
          planId,
          objective: z
            .enum(["endNetWorthReal", "lifetimeTaxesReal", "successRate"])
            .default("endNetWorthReal"),
          candidates: z
            .array(
              z.object({
                id: z.string(),
                label: z.string(),
                description: z.string().default(""),
                patch: z.array(z.record(z.string(), z.unknown())).min(1),
              }),
            )
            .optional()
            .describe("Your own candidates; omit for the built-in set."),
          detail,
          wait: waitSeconds,
        },
        hint: { readOnly: true, idempotent: true },
      },
      async ({ planId, objective, candidates, detail, wait }, extra) => {
        const job = services.sim.startTaxStrategy(
          planId,
          {
            objective,
            ...(candidates
              ? {
                  candidates: candidates.map((c) => ({
                    ...c,
                    patch: z.array(PatchOp).parse(c.patch),
                  })),
                }
              : {}),
          },
          actor,
        );
        return jobOut(await awaitJob(job, wait, extra), (r) =>
          compactStrategies(r as never, detail),
        );
      },
    );

    tool(
      "compare_debt_payoff",
      {
        title: "Compare debt payoff strategies",
        description:
          "Minimum payments vs avalanche (highest rate first) vs snowball (smallest balance first) with the same extra budget: interest paid and saved, debt-free date, when each debt is cleared. Give extraPerMonth (nominal) or flowId (an existing debt paydown flow).",
        input: {
          planId,
          extraPerMonth: z.number().positive().optional(),
          flowId: z.string().optional(),
          targetIds: z.array(z.string()).optional(),
        },
        hint: { readOnly: true, idempotent: true },
      },
      async ({ planId, extraPerMonth, flowId, targetIds }) =>
        services.sim.debtPayoff(planId, { extraPerMonth, flowId, targetIds }),
    );

    tool(
      "strategy_matrix",
      {
        title: "Strategy matrix",
        description:
          "Strategies x metrics (lifetime tax, net legacy, chance of success, final net worth) for the built-in tax/drawdown strategies, with per-column scores (0 worst .. 1 best) and the best row per column. A job; set successRate=false to skip the slow Monte Carlo column.",
        input: { planId, successRate: z.boolean().default(true), wait: waitSeconds },
        hint: { readOnly: true, idempotent: true },
      },
      async ({ planId, successRate, wait }, extra) => {
        const job = services.sim.startStrategyMatrix(planId, { successRate }, actor);
        return jobOut(await awaitJob(job, wait, extra), (r) => {
          const m = r as {
            columns: { id: string; label: string; better: string }[];
            rows: Record<string, unknown>[];
            best: (string | null)[];
          };
          return {
            columns: m.columns,
            best: m.best,
            rows: m.rows.map((x) => ({ ...x, deltas: undefined })),
          };
        });
      },
    );

    tool(
      "income_by_tax_rate",
      {
        title: "Income by tax rate",
        description:
          "How much income falls in each marginal tax-rate band, per year (columns = rates, cells = income taxed at that rate). Useful for bracket filling and Roth conversion planning.",
        input: {
          planId,
          jurisdictionId: z.string().optional(),
          basis: z.enum(["real", "nominal"]).default("real"),
          everyNYears: z.number().int().min(1).max(50).default(5),
        },
        hint: { readOnly: true, idempotent: true },
      },
      ({ planId, jurisdictionId, basis, everyNYears }) => {
        const m = services.sim.incomeByTaxRate(planId, { jurisdictionId, basis });
        const keep = m.years
          .map((_, i) => i)
          .filter((i) => i % everyNYears === 0 || i === m.years.length - 1);
        return {
          jurisdictionId: m.jurisdictionId,
          basis: m.basis,
          columns: m.columns,
          years: keep.map((i) => ({ year: m.years[i], cells: m.cells[i]!.map(roundMoney) })),
        };
      },
    );

    tool(
      "compare_sepp_methods",
      {
        title: "Compare 72(t) SEPP methods",
        description:
          "US early retirement 72(t) / SEPP: required minimum distribution vs fixed amortisation vs fixed annuitisation: first-year payment, total withdrawn, balance left. Give balance and startAge, or householdId and accountId (balance and the owner’s age are taken from the account).",
        input: {
          balance: z.number().positive().optional(),
          startAge: z.number().min(18).max(100).optional(),
          interestRate: z.number().min(0).max(0.2).optional(),
          growthRate: z.number().min(-0.5).max(0.5).optional(),
          householdId: z.string().optional(),
          accountId: z.string().optional(),
        },
        hint: { readOnly: true },
      },
      (q) => {
        const c = services.sim.seppComparison(q);
        return {
          ...c,
          rows: c.rows.map((r) => ({
            ...r,
            payments: undefined,
            firstYearPayment: roundMoney(r.firstYearPayment),
            totalPayments: roundMoney(r.totalPayments),
            endingBalance: roundMoney(r.endingBalance),
          })),
        };
      },
    );

    tool(
      "list_whatif_templates",
      {
        title: "List what-if templates",
        description:
          "Scenario templates (market crash, job loss, career break, retire earlier, downsize, child, inheritance, long-term care, survivor) and the parameters each takes (JSON Schema).",
        input: {},
        hint: { readOnly: true },
      },
      () => services.scenarios.list(),
    );

    tool(
      "preview_whatif",
      {
        title: "Preview a what-if template",
        description:
          "Instantiate a template for a plan and show what it would do: the ops, readable changes and before/after outcome. Stores nothing. Follow with create_branch_from_template (or propose_change_set with the ops).",
        input: {
          planId,
          templateId: z.string().describe("From list_whatif_templates, e.g. market-crash."),
          params: z.record(z.string(), z.unknown()).default({}),
        },
        hint: { readOnly: true },
      },
      ({ planId, templateId, params }) => services.scenarios.preview(planId, templateId, params),
    );

    tool(
      "survivor_scenarios",
      {
        title: "Survivor scenarios",
        description:
          "For a couple: what if each partner dies at 70 / 80 / 90 (or your ages)? Returns the scenarios (ops) and, with evaluate=true, before/after outcomes. Survivor benefits are NOT added automatically: see each scenario note.",
        input: {
          planId,
          ages: z.array(z.number().int().min(30).max(120)).max(8).optional(),
          evaluate: z.boolean().default(true),
        },
        hint: { readOnly: true },
      },
      ({ planId, ages, evaluate }) => {
        const out = services.scenarios.survivors(planId, { ages, evaluate });
        const people = services.households.get(services.plans.get(planId).householdId).household
          .people.length;
        return people < 2
          ? {
              ...out,
              note: "Survivor scenarios apply to couples; this household has one person, so there are none.",
            }
          : out;
      },
    );

    tool(
      "get_job",
      {
        title: "Get job",
        description:
          "Status and progress of an async job (Monte Carlo, solver...). Includes the (compact) result once finished.",
        input: {
          jobId: z.string(),
          wait: z.number().min(0).max(110).default(0).describe("Seconds to wait for completion."),
        },
        hint: { readOnly: true },
      },
      async ({ jobId, wait }, extra) => {
        const job = await awaitJob(services.jobs.get(jobId), wait, extra);
        return jobOut(job, (r) =>
          job.kind === "monte-carlo" || job.kind === "historical"
            ? compactMonteCarlo(r as never, {})
            : job.kind === "tax-strategy"
              ? compactStrategies(r as never)
              : job.kind === "attribution"
                ? { attribution: compactAttribution(r as never) }
                : SOLVER_KINDS.has(job.kind)
                  ? compactSolver(r as never)
                  : r,
        );
      },
    );
  }

  // =============================================================================== write tools (change sets)
  if (ctx.canWrite) {
    tool(
      "cancel_job",
      {
        title: "Cancel job",
        description: "Cancel a queued or running job.",
        input: { jobId: z.string() },
        hint: { readOnly: false, idempotent: true },
      },
      async ({ jobId }) => {
        const j = await services.jobs.cancelAndWait(jobId);
        return { jobId: j.id, status: j.status };
      },
    );

    const opsShape = z
      .array(z.record(z.string(), z.unknown()))
      .min(1)
      .max(100)
      .describe(
        'RFC 6902 ops: [{"op":"replace","path":"/income/[id=salary]/amount/value","value":95000}]',
      );
    const readable = (cs: ReturnType<Services["changeSets"]["get"]>) => ({
      id: cs.id,
      planId: cs.planId,
      baseVersion: cs.baseVersion,
      status: cs.status,
      summary: cs.summary,
      changes: cs.changes.slice(0, 60).map((c) => c.description),
      ...(cs.preview ? { before: cs.preview.before, after: cs.preview.after } : {}),
      next:
        cs.status === "proposed"
          ? "Show the user the changes and before/after, then call apply_change_set (or discard_change_set)."
          : undefined,
    });

    tool(
      "propose_change_set",
      {
        title: "Propose change set",
        description:
          "Propose edits to a plan WITHOUT applying them. Returns a readable diff and before/after outcomes. Nothing changes until apply_change_set. Ops are authored against the plan version you read (stale = conflict).",
        input: {
          planId,
          ops: opsShape,
          summary: z.string().min(1).max(500).describe("One line: what this does."),
          rationale: z.string().max(4000).optional(),
          baseVersion: z
            .number()
            .int()
            .optional()
            .describe("Plan version you read (default: current)."),
        },
        hint: { readOnly: false },
      },
      async ({ planId, ops, summary, rationale, baseVersion }) => {
        return readable(
          services.changeSets.propose(
            planId,
            {
              ops: z.array(PatchOp).parse(ops),
              summary,
              ...(rationale ? { rationale } : {}),
              ...(baseVersion !== undefined ? { baseVersion } : {}),
              preview: true,
            },
            actor,
          ),
        );
      },
    );

    tool(
      "apply_change_set",
      {
        title: "Apply change set",
        description:
          "Apply a PROPOSED change set to its plan (atomic, recorded in the plan history with your identity). Fails with CHANGESET_CONFLICT if the plan changed since the proposal: propose again.",
        input: { changeSetId: z.string() },
        hint: { readOnly: false },
      },
      ({ changeSetId }) => {
        const out = services.changeSets.apply(changeSetId, actor);
        return {
          changeSetId,
          status: out.changeSet.status,
          planId: out.plan.id,
          newVersion: out.plan.version,
        };
      },
    );

    tool(
      "discard_change_set",
      {
        title: "Discard change set",
        description: "Discard a proposed change set without applying it.",
        input: { changeSetId: z.string() },
        hint: { readOnly: false, idempotent: true },
      },
      ({ changeSetId }) => {
        const c = services.changeSets.discard(changeSetId);
        return { changeSetId: c.id, status: c.status };
      },
    );

    tool(
      "propose_revert",
      {
        title: "Propose revert to an earlier version",
        description:
          "Undo, safely: proposes a change set that turns the current plan back into an earlier version (see list_plan_versions). Apply it with apply_change_set.",
        input: { planId, version: z.number().int().min(1) },
        hint: { readOnly: false },
      },
      ({ planId, version }) => {
        const current = services.plans.get(planId);
        const old = services.plans.versionBody(planId, version);
        const diff = services.ctx.deps.diffPlans(current, {
          ...old,
          id: current.id,
          householdId: current.householdId,
          version: current.version,
          createdAt: current.createdAt,
          updatedAt: current.updatedAt,
          ...(current.lineage ? { lineage: current.lineage } : {}),
        });
        if (!diff.patch.length)
          return { message: `plan already equals version ${version}; nothing to revert` };
        return readable(
          services.changeSets.propose(
            planId,
            { ops: diff.patch, summary: `Revert to version ${version}`, preview: true },
            actor,
          ),
        );
      },
    );

    tool(
      "record_progress_snapshot",
      {
        title: "Record progress snapshot",
        description:
          "Record today's actual net worth (computed from the household's current balances) as a progress snapshot.",
        input: {
          householdId,
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("YYYY-MM-DD (default: today)"),
          note: z.string().max(500).optional(),
        },
        hint: { readOnly: false },
      },
      ({ householdId, date, note }) => {
        const s = services.households.recordCurrent(householdId, {
          source: "api",
          ...(date ? { date } : {}),
          ...(note ? { note } : {}),
        });
        return {
          id: s.id,
          date: s.date,
          netWorth: roundMoney(s.netWorth),
          assets: roundMoney(s.assets),
          liabilities: roundMoney(s.liabilities),
        };
      },
    );

    tool(
      "update_account_balances",
      {
        title: "Update account balances",
        description:
          "Set current balances for many accounts, real-asset values, mortgage/loan balances and debts at once (all-or-nothing: an unknown id changes nothing). A mortgage is the loan of a real asset: pass realAssets[].loanBalance, or the asset id in debts. Also records a progress snapshot unless recordSnapshot=false. Does not touch any plan.",
        input: {
          householdId,
          accounts: z
            .array(
              z.object({
                accountId: z.string(),
                balance: z.number(),
                costBasis: z.number().min(0).optional(),
              }),
            )
            .default([]),
          realAssets: z
            .array(
              z.object({
                assetId: z.string(),
                currentValue: z.number().min(0).optional(),
                loanBalance: z
                  .number()
                  .min(0)
                  .optional()
                  .describe("Outstanding balance of the asset's mortgage/loan."),
              }),
            )
            .default([]),
          debts: z
            .array(
              z.object({
                debtId: z
                  .string()
                  .describe("A debt id, or a real asset id to set its loan balance."),
                balance: z.number().min(0),
              }),
            )
            .default([]),
          asOf: z
            .string()
            .regex(/^\d{4}-\d{2}$/)
            .optional()
            .describe("YYYY-MM the balances are valid for."),
          recordSnapshot: z.boolean().optional(),
        },
        hint: { readOnly: false, idempotent: true },
      },
      ({ householdId, ...u }) => {
        const out = services.households.updateBalances(
          householdId,
          {
            accounts: u.accounts,
            realAssets: u.realAssets,
            debts: u.debts,
            ...(u.asOf ? { asOf: u.asOf } : {}),
            ...(u.recordSnapshot !== undefined ? { recordSnapshot: u.recordSnapshot } : {}),
          },
          undefined,
          actor,
        );
        return {
          updated: out.updated,
          householdVersion: out.version,
          snapshotId: out.snapshot?.id ?? null,
        };
      },
    );

    tool(
      "create_branch",
      {
        title: "Create plan branch",
        description:
          "Create a branch of a plan (a what-if scenario that follows its parent). Optionally with initial ops. Branches are safe: the parent is untouched. Then simulate/compare the branch.",
        input: {
          planId,
          name: z.string().min(1).max(120),
          description: z.string().max(2000).optional(),
          ops: opsShape.optional(),
          pinParentVersion: z.boolean().default(false),
        },
        hint: { readOnly: false },
      },
      async ({ planId, name, description, ops, pinParentVersion }) => {
        const b = services.plans.createBranch(
          planId,
          {
            name,
            ...(description ? { description } : {}),
            ...(ops ? { patch: z.array(PatchOp).parse(ops) } : {}),
            pinParentVersion,
          },
          actor,
        );
        return {
          id: b.id,
          name: b.name,
          branchOf: planId,
          version: b.version,
          ops: b.lineage?.patch.length ?? 0,
        };
      },
    );

    tool(
      "create_branch_from_template",
      {
        title: "Create a branch from a what-if template",
        description:
          "Store a what-if template as a BRANCH of the plan (parent untouched) so you can simulate and compare it. Preview first with preview_whatif.",
        input: {
          planId,
          templateId: z.string(),
          params: z.record(z.string(), z.unknown()).default({}),
          name: z.string().min(1).max(120).optional(),
        },
        hint: { readOnly: false },
      },
      ({ planId, templateId, params, name }) => {
        const out = services.scenarios.createBranch(planId, templateId, params, { name }, actor);
        return {
          id: out.branch.id,
          name: out.branch.name,
          branchOf: planId,
          version: out.branch.version,
          ops: out.branch.lineage?.patch.length ?? 0,
          notes: out.template.notes,
        };
      },
    );

    tool(
      "apply_bank_file_import",
      {
        title: "Apply an OFX/QIF import",
        description:
          "Apply an OFX/QFX/QIF import atomically (balances and/or annual expense events). Run preview_bank_file_import first and show the user the reconciliation. Blocking errors change nothing.",
        input: {
          householdId,
          text: z.string().max(2_000_000),
          format: z.enum(["ofx", "qif", "auto"]).default("auto"),
          planId: z.string().optional(),
          createMissing: z.boolean().default(false),
        },
        hint: { readOnly: false },
      },
      ({ householdId, text, format, planId, createMissing }) => {
        const out = services.imports.importBankFile(
          householdId,
          {
            text,
            format,
            dryRun: false,
            ...(planId ? { planId } : {}),
            balances: { createMissing },
          },
          actor,
        ) as { issueCount: number; changes: unknown; format: string };
        return {
          format: out.format,
          applied: true,
          issueCount: out.issueCount,
          changes: out.changes,
        };
      },
    );

    tool(
      "apply_csv_import",
      {
        title: "Apply a CSV import",
        description:
          "Apply a CSV import atomically (balances, progress history or transaction-derived expenses). Run preview_csv_import first and show the user the reconciliation. Blocking errors change nothing.",
        input: {
          householdId,
          kind: z.enum(["account-balances", "progress-snapshots", "transactions"]),
          text: z.string().max(2_000_000),
          options: z.record(z.string(), z.unknown()).optional(),
          planId: z.string().optional(),
        },
        hint: { readOnly: false },
      },
      ({ householdId, kind, text, options, planId }) => {
        const out = services.imports.importCsv(
          householdId,
          {
            text,
            kind,
            dryRun: false,
            ...(options ? { options: options as never } : {}),
            ...(planId ? { planId } : {}),
          },
          actor,
        ) as { issueCount: number; changes: unknown; kind: string };
        return { kind: out.kind, applied: true, issueCount: out.issueCount, changes: out.changes };
      },
    );

    tool(
      "set_person_cross_border",
      {
        title: "Set a person's cross-border details",
        description:
          "Update a person's citizenships (ISO codes), US green card, residence before the plan (residenceHistory, oldest first) and state-pension records (country, qualifyingYears, asOf, voluntaryYears). Only the fields you pass change. Writes the household directly (not a plan). Errors explain what to fix.",
        input: {
          householdId,
          personId: z.string(),
          citizenships: z.array(z.string().length(2)).max(5).optional(),
          usGreenCard: z.boolean().optional(),
          residenceHistory: z
            .array(
              z.object({
                country: z.string().length(2),
                from: z.string(),
                to: z.string().optional(),
              }),
            )
            .max(40)
            .optional(),
          statePensionRecords: z
            .array(
              z.object({
                country: z.string().length(2),
                qualifyingYears: z.number().min(0).max(60),
                asOf: z.string().optional(),
                voluntaryYears: z.number().int().min(0).max(35).optional(),
              }),
            )
            .max(10)
            .optional(),
        },
        hint: { readOnly: false, idempotent: true },
      },
      ({ householdId, personId, ...fields }) => {
        const body: Record<string, unknown> = Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined),
        );
        if (body.residenceHistory)
          body.residenceHistory = (body.residenceHistory as { country: string }[]).map((r) => ({
            ...r,
            country: r.country.toUpperCase(),
          }));
        if (body.statePensionRecords)
          body.statePensionRecords = (body.statePensionRecords as { country: string }[]).map(
            (r) => ({
              ...r,
              country: r.country.toUpperCase(),
            }),
          );
        return services.crossBorder.setPersonProfile(householdId, personId, body, "merge");
      },
    );

    tool(
      "propose_move",
      {
        title: "Propose a move (residency change)",
        description:
          "Propose (as a change set, nothing applied) that one person or everyone becomes tax resident in `country` from `month`, optionally coming back in `returnMonth`. Accounts, property and pensions keep their country. Show the user the diff and before/after, then apply_change_set. To compare without changing anything use compare_stay_or_move.",
        input: {
          planId,
          country: z.string().length(2),
          region: z.string().max(10).optional(),
          month: z.string().describe("YYYY-MM"),
          returnMonth: z.string().optional().describe("YYYY-MM"),
          personId: z.string().optional(),
        },
        hint: { readOnly: false },
      },
      ({ planId, country, region, month, returnMonth, personId }) => {
        const { template } = services.scenarios.instantiate(planId, "relocation", {
          to: { country: country.toUpperCase(), ...(region ? { region } : {}) },
          month,
          ...(returnMonth ? { returnMonth } : {}),
          ...(personId ? { personId } : {}),
        });
        return {
          ...readable(
            services.changeSets.propose(
              planId,
              {
                ops: template.patch,
                summary: template.title,
                rationale: template.description,
                preview: true,
              },
              actor,
            ),
          ),
          notes: template.notes,
        };
      },
    );
  }

  // =============================================================================== multi-currency
  if (canRead) {
    tool(
      "list_fx_rates",
      {
        title: "List FX rates",
        description:
          "Exchange rates a household uses for foreign-currency accounts, assets and debts (foreign -> base currency, as of the finances date, with optional annual drift). Each foreign currency needs a pair in either direction.",
        input: { householdId },
        hint: { readOnly: true },
      },
      ({ householdId }) => services.households.listFx(householdId),
    );

    tool(
      "get_residency_timeline",
      {
        title: "Residency timeline",
        description:
          "Where each person lives over the plan: the household location, dated moves (plan residency entries, per person or everyone) and relocation milestones, plus each person's citizenships and past residence, the residence of every projected year (months per country in split years) and warnings. Edit moves with propose_move (or propose_change_set on /residency); person fields with set_person_cross_border.",
        input: { planId, everyNYears: z.number().int().min(1).max(50).default(1) },
        hint: { readOnly: true },
      },
      ({ planId, everyNYears }) => {
        const t = services.crossBorder.timeline(planId);
        // Only years whose residence changes (or every Nth), to stay compact.
        let last = "";
        const years = t.years.filter((y, i) => {
          const k = JSON.stringify(y.residence);
          const keep = k !== last || (i % everyNYears === 0 && everyNYears > 1);
          last = k;
          return keep;
        });
        return { ...t, years };
      },
    );

    tool(
      "cross_border_rules",
      {
        title: "Cross-border rule tables",
        description:
          "The tables the engine uses. kind='countries' (which countries have rules, tax currency, treaties, pegs); 'non-resident' (how `country` taxes non-residents per income category, its wrappers and exit rules); 'treaty' (the `country`-`otherCountry` treaty with each category's allocation both ways, or the fallback); 'wrappers' (how `country` as residence treats accounts of `otherCountry`); 'simplifications' (known limitations for the countries given).",
        input: {
          kind: z.enum(["countries", "non-resident", "treaty", "wrappers", "simplifications"]),
          country: z.string().length(2).optional(),
          otherCountry: z.string().length(2).optional(),
        },
        hint: { readOnly: true },
      },
      ({ kind, country, otherCountry }) => {
        const need = (v: string | undefined, name: string) => {
          if (!v)
            throw new ApiError(
              400,
              "VALIDATION",
              `kind='${kind}' needs ${name} (ISO alpha-2, e.g. GB).`,
            );
          return v;
        };
        switch (kind) {
          case "countries":
            return services.crossBorder.countries();
          case "non-resident": {
            const { sources: _s, ...rules } = services.crossBorder.nonResidentRules(
              need(country, "country"),
            );
            return rules;
          }
          case "treaty":
            return services.crossBorder.treaty(
              need(country, "country"),
              need(otherCountry, "otherCountry"),
            );
          case "wrappers":
            return services.crossBorder.wrappers({
              residence: country,
              accountCountry: otherCountry,
            });
          case "simplifications":
            return services.crossBorder.simplifications(
              [country, otherCountry].filter(Boolean) as string[],
            );
        }
      },
    );
  }
  if (ctx.canWrite) {
    tool(
      "set_fx_rate",
      {
        title: "Set an FX rate",
        description:
          "Add or update one FX pair (base units per 1 unit of `from` when `to` is the base currency). annualDrift moves the rate over the plan (e.g. -0.02 = the foreign currency falls 2% a year).",
        input: {
          householdId,
          from: z.string().length(3),
          to: z.string().length(3),
          rate: z.number().positive(),
          annualDrift: z.number().min(-0.5).max(0.5).default(0),
        },
        hint: { readOnly: false, idempotent: true },
      },
      ({ householdId, from, to, rate, annualDrift }) =>
        services.households.upsertFx(
          householdId,
          { from: from.toUpperCase(), to: to.toUpperCase(), rate, annualDrift },
          undefined,
          actor,
        ),
    );
    tool(
      "unset_fx_rate",
      {
        title: "Unset an FX rate",
        description:
          "Remove one FX pair. Plans that still hold that currency will fail to project until a pair exists again.",
        input: { householdId, from: z.string().length(3), to: z.string().length(3) },
        hint: { readOnly: false, idempotent: true, destructive: true },
      },
      ({ householdId, from, to }) => ({
        version: services.households.deleteFx(
          householdId,
          from.toUpperCase(),
          to.toUpperCase(),
          undefined,
          actor,
        ),
      }),
    );
  }

  // =============================================================================== check-ins, notifications, sharing
  if (canRead) {
    tool(
      "get_plan_health_history",
      {
        title: "Plan health history",
        description:
          "The time series of check-ins for a plan (newest first): chance of success, financial-independence year, net worth versus what the plan projected, milestones and assumption findings. Check-ins run on a schedule (see get_checkin_schedule) or via run_checkin.",
        input: { planId, limit: z.number().int().min(1).max(200).default(20) },
        hint: { readOnly: true },
      },
      ({ planId, limit }) => ({
        planId,
        items: services.checkins.history(planId, { limit }).map((h) => ({
          id: h.id,
          takenAt: h.takenAt,
          trigger: h.trigger,
          planVersion: h.planVersion,
          successRate: h.successRate,
          fiYear: h.fiYear,
          actualNetWorth: h.actualNetWorth,
          plannedNetWorth: h.plannedNetWorth,
          netWorthVsPlan: h.netWorthVsPlan,
          depletionYear: h.depletionYear,
          findings: h.findings.filter((f) => f.severity !== "info").length,
        })),
      }),
    );

    tool(
      "list_notifications",
      {
        title: "List notifications",
        description:
          "Notifications raised by check-ins: chance of success moved, a milestone slipped, a new assumption finding, net worth behind plan. Newest first.",
        input: {
          unreadOnly: z.boolean().default(true),
          planId: z.string().optional(),
          limit: z.number().int().min(1).max(100).default(20),
        },
        hint: { readOnly: true },
      },
      ({ unreadOnly, planId, limit }) => ({
        unread: services.checkins.unreadCount(),
        items: services.checkins.notifications({ unread: unreadOnly, planId, limit }),
      }),
    );

    tool(
      "get_checkin_schedule",
      {
        title: "Check-in schedule",
        description:
          "How often plans are re-run automatically, the change thresholds, and the last and next run.",
        input: {},
        hint: { readOnly: true },
      },
      () => services.checkins.getConfig(),
    );

    tool(
      "what_changed_since_checkin",
      {
        title: "What changed since my last check-in",
        description:
          "Compare the plan and household as they are now with the last check-in: material changes (success rate, milestones, new findings, net worth versus plan), the edits made since and by whom, and notifications. The chance of success is the stored one unless refresh=true, which takes a new check-in (re-runs Monte Carlo; needs write access).",
        input: {
          planId,
          since: z
            .string()
            .optional()
            .describe("ISO time to compare from (default: the last check-in)."),
          refresh: z.boolean().default(false),
        },
        hint: { readOnly: true },
      },
      async ({ planId, since, refresh }) => {
        if (refresh && !ctx.canWrite)
          throw new ApiError(
            403,
            "FORBIDDEN",
            "refresh=true stores a check-in and needs write access; omit it to compare without Monte Carlo",
          );
        return services.checkins.sinceLastCheckin(planId, { since, refresh }, actor);
      },
    );
  }

  if (ctx.canWrite) {
    tool(
      "run_checkin",
      {
        title: "Run a check-in now",
        description:
          "Re-run the plan (projection, Monte Carlo chance of success, assumption audit) and store the result in the plan health history. Returns the material changes against the previous check-in; they are also stored as notifications and sent as webhooks.",
        input: { planId },
        hint: { readOnly: false },
      },
      async ({ planId }) => {
        const r = await services.checkins.runPlan(planId, "api", actor);
        return {
          health: { ...r.health, milestones: undefined, findings: r.health.findings.length },
          changes: r.changes,
        };
      },
    );

    tool(
      "mark_notifications_read",
      {
        title: "Mark notifications read",
        description: "Mark notifications as read: give ids, or all=true.",
        input: { ids: z.array(z.string()).max(200).optional(), all: z.boolean().default(false) },
        hint: { readOnly: false, idempotent: true },
      },
      ({ ids, all }) => ({ marked: services.checkins.markRead(all ? "all" : (ids ?? [])) }),
    );

    tool(
      "set_checkin_schedule",
      {
        title: "Set check-in schedule",
        description:
          "Change the schedule: enabled, cadence (daily/weekly/monthly/quarterly), thresholds, Monte Carlo trials.",
        input: {
          enabled: z.boolean().optional(),
          cadence: z.enum(["daily", "weekly", "monthly", "quarterly"]).optional(),
          successRateDelta: z.number().min(0.001).max(1).optional(),
          milestoneSlipMonths: z.number().int().min(1).max(600).optional(),
          netWorthBehindPlan: z.number().min(0.01).max(1).optional(),
        },
        hint: { readOnly: false, idempotent: true },
      },
      ({ enabled, cadence, successRateDelta, milestoneSlipMonths, netWorthBehindPlan }) =>
        services.checkins.setConfig({
          ...(enabled !== undefined ? { enabled } : {}),
          ...(cadence ? { cadence } : {}),
          thresholds: {
            ...(successRateDelta !== undefined ? { successRateDelta } : {}),
            ...(milestoneSlipMonths !== undefined ? { milestoneSlipMonths } : {}),
            ...(netWorthBehindPlan !== undefined ? { netWorthBehindPlan } : {}),
          },
        }),
    );

    tool(
      "create_share_link",
      {
        title: "Create a share link",
        description:
          "Create an expiring, revocable read-only link to a plan’s results. privacy: full (amounts), percent (percentages of the starting net worth) or hidden (no amounts). The token is returned once: give the user the path (open it on this Glideworth instance).",
        input: {
          planId,
          label: z.string().max(120).optional(),
          privacy: z.enum(["full", "percent", "hidden"]).default("percent"),
          expiresInDays: z.number().int().min(1).max(365).default(14),
        },
        hint: { readOnly: false },
      },
      async ({ planId, label, privacy, expiresInDays }) => {
        const out = await services.shares.create(
          planId,
          { label, privacy, basis: "real", expiresInDays, includeSuccessRate: true },
          actor,
        );
        return {
          link: out.link,
          token: out.token,
          path: `/share/${out.token}`,
          apiPath: `/api/v1/shared/${out.token}`,
        };
      },
    );

    tool(
      "list_share_links",
      {
        title: "List share links",
        description: "Share links (status, expiry, views); tokens are never shown again.",
        input: { planId: z.string().optional() },
        hint: { readOnly: false, idempotent: true },
      },
      ({ planId }) => ({ items: services.shares.list(planId) }),
    );

    tool(
      "revoke_share_link",
      {
        title: "Revoke a share link",
        description: "Stop a share link working immediately.",
        input: { linkId: z.string() },
        hint: { readOnly: false, idempotent: true, destructive: true },
      },
      ({ linkId }) => services.shares.revoke(linkId),
    );
  }

  registerResources(server, ctx);
  registerPrompts(server, ctx);
  return server;
}
