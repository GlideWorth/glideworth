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
import { type Actor, GoalSeekRequest, type MonteCarloResult, PatchOp } from "@glideworth/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { allows, type Principal, type Scope } from "../auth.js";
import { ApiError, describeError } from "../errors.js";
import { baseConverter } from "../fx.js";
import { findUnsafeInput } from "../security.js";
import {
  BalanceHistoryImportBody,
  type BalanceHistoryImportResult,
  HistoryParseOptions,
  HistoryRowBody,
} from "../services/history.js";
import { HouseholdChangeOp } from "../services/household-changes.js";
import type { JobView } from "../services/jobs.js";
import type { Services } from "../services.js";
import {
  compactAttribution,
  compactMonteCarlo,
  compactOptimise,
  compactPlan,
  compactProjection,
  compactSolver,
  compactRothPlan,
  compactStrategies,
  compactYearNarrative,
  outcomeOf,
  planViewContext,
  roundMoney,
} from "../views.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import {
  registerWidgetResource,
  type WidgetEnv,
  outcomeNumbers as numbers,
  tweakableParams,
  WithWidget,
  widgetBuilders,
  widgetMeta,
  widgetToolMeta,
  withWidget,
} from "./widgets.js";

export interface McpContext {
  services: Services;
  /** Scopes of the caller's key (stdio: derived from the allow-writes flag). */
  scopes: Scope[];
  /** Whether write tools may be registered (server flag && key scope). */
  canWrite: boolean;
  actor?: Actor;
  /** The authenticated caller (HTTP): writes are recorded in the audit log under this person. */
  principal?: Principal | undefined;
  /**
   * Public origin of the web app (GLIDEWORTH_PUBLIC_URL, or this server's origin when it serves the web app).
   * Chat widgets link into the app from it; null or absent = no links.
   */
  webUrl?: string | null | undefined;
}

/** Solver jobs that have an answer widget (the solve_* tools; goal_seek has none). */
const WIDGET_SOLVER_KINDS = new Set([
  "max-spending",
  "earliest-retirement",
  "required-savings",
  "required-portfolio",
  "safe-withdrawal-rate",
]);

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
  'COMMON QUESTIONS: "chance of success / why does it fail" -> run_monte_carlo (read failureAnalysis) then explain_year on the first failing year; "how much can I spend" -> solve_max_spending; "retire N years earlier" -> preview_whatif early-retirement, create_branch_from_template, compare_plans; "problems with my assumptions" -> audit_plan (each finding may carry a suggested change you can preview with preview_changes); "update balances" -> update_account_balances; "I opened an account / sold the car / my mortgage rate changed" -> preview_household_change then apply_household_change; "overpay the mortgage or invest / which savings changes let me retire earliest" -> optimise_plan, then preview_changes with its ops.',
  "MORE ANALYSIS: strategy_matrix, income_by_tax_rate. MULTI-CURRENCY: list_fx_rates / set_fx_rate. CHECK-INS: what_changed_since_checkin, explain_result_change (why a result moved, by cause), get_plan_health_history, list_notifications; create_share_link for read-only sharing.",
  "ANALYSE: simulate_plan (deterministic), run_monte_carlo (chance of success), explain_projection / explain_year(s) / explain_difference, audit_plan, sensitivity, compare_plans, solve_* (max spending, earliest retirement, required savings / portfolio, safe withdrawal rate), optimise_plan (which flow levers best meet a goal), evaluate_guardrails / guyton_klinger, optimise_tax_strategy, plan_roth_conversions (US: a conversion amount per year with the reason).",
  "WHAT-IF: list_whatif_templates -> preview_whatif (nothing stored) -> create_branch_from_template; survivor_scenarios for couples.",
  "ASSETS ABROAD: the household lives in one country for the whole plan; accounts, property and income in another country are taxed there as a non-resident, with treaty relief at home. tax_by_country (rows by country and basis), explain_item_taxation (how one item is taxed and why), cross_border_rules (non-resident rules, treaties, wrapper recognition).",
  "DATA: export_table / export_report for tables and report data; preview_csv_import (dry run) before apply_csv_import; balance history per account (a spreadsheet of dates x accounts): preview_balance_history_import before apply_balance_history_import.",
  "EDITS: plan changes are never overwrites. Use preview_changes for what-ifs, then propose_change_set -> show the user the diff + before/after -> apply_change_set only after they agree. Edits are RFC 6902 ops; address list items by id: /income/[id=salary]/amount/value. Plans themselves: duplicate_plan, rename_plan, set_main_plan, set_plan_archived.",
  "Household data (balances, snapshots, CSV imports) is written directly by update_account_balances / record_progress_snapshot / apply_csv_import; other household edits (accounts, property, debts, people) by preview_household_change -> apply_household_change; plan edits always go through change sets or branches.",
  "Read-only unless the server enables writes; write tools are absent otherwise.",
  'Tools return compact JSON; pass detail="full" only when you need everything.',
  "INTERACTIVE VIEW: in hosts that show Glideworth's interactive view, it already shows the chart and the numbers: answer in a few sentences and do not restate every figure.",
  "ESTIMATES, NOT ADVICE: results are projections from the plan's assumptions, not financial, tax or investment advice; say so when the user may act on a figure. Glideworth never moves money or places trades.",
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
    "It changed since you read it. For a plan, call get_plan_summary for the current version and try again; for a household, run preview_household_change again for the current householdVersion.",
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
  ACCOUNT_READ_ONLY:
    "Read tools still work. Tell the user the workspace is read-only and that the workspace owner can change that in the Glideworth app; do not retry.",
  IMPORT_FAILED: "Run preview_csv_import first and fix the blocking issues it lists.",
};
/**
 * A lapsed cloud workspace refuses jobs with ACCOUNT_READ_ONLY. The REST API adds the billing URL; an assistant
 * gets a neutral explanation instead, because the ChatGPT and Claude directories do not allow upgrade prompts or
 * subscription selling inside the chat (OpenAI plugin guidelines 5; Anthropic directory policy 4).
 */
const forAssistant = (e: ReturnType<typeof describeError>): ReturnType<typeof describeError> =>
  e.code === "ACCOUNT_READ_ONLY"
    ? {
        code: e.code,
        message:
          "this workspace is read-only in Glideworth, so it cannot start new analyses or change data here",
      }
    : e;
const asError = (err: unknown, validIds?: (message: string) => string[]) => {
  const e = forAssistant(describeError(err));
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
    { name: "glideworth", version: "1.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const canRead = allows(ctx.scopes, "read");
  const canSim = allows(ctx.scopes, "simulate");
  const widgetEnv: WidgetEnv = { services, canWrite: ctx.canWrite, webUrl: ctx.webUrl ?? null };

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

  /** MCP tool annotations. `destructive` is true for anything that overwrites or removes existing state (the spec:
   *  false means "only additive updates"); `openWorld` for a tool whose effect reaches outside the workspace. */
  type Hint = {
    readOnly: boolean;
    idempotent?: boolean;
    destructive?: boolean;
    openWorld?: boolean;
    /** Record each call in the audit log (default: every tool that is not read-only). */
    audit?: boolean;
  };
  /**
   * Tools that start a calculation (Monte Carlo, solvers, sensitivity, Roth conversions...). Each call stores a
   * job record, but it changes no plan or household data and repeats the same result, so a read-scope key may
   * call it and the hint is read-only. The audit log records changes to data, and these stay out of it.
   */
  const CALCULATION: Hint = { readOnly: true, idempotent: true };
  function tool<S extends z.ZodRawShape>(
    name: string,
    cfg: { title: string; description: string; input: S; hint: Hint },
    handler: (args: z.infer<z.ZodObject<S>>, extra: Extra) => unknown | Promise<unknown>,
  ) {
    // Widget tools name the widget template; tools the widget calls are marked callable (widgets.ts).
    const meta = widgetToolMeta(name);
    server.registerTool(
      name,
      {
        title: cfg.title,
        description: cfg.description,
        inputSchema: cfg.input,
        annotations: {
          // Claude's directory reads the title from the annotations; other clients read the top-level one.
          title: cfg.title,
          readOnlyHint: cfg.hint.readOnly,
          destructiveHint: cfg.hint.destructive ?? false,
          idempotentHint: cfg.hint.idempotent ?? cfg.hint.readOnly,
          openWorldHint: cfg.hint.openWorld ?? false,
        },
        ...(meta ? { _meta: meta } : {}),
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
          if (cfg.hint.audit ?? !cfg.hint.readOnly)
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
          if (out instanceof WithWidget) {
            // The model reads the same text as without a widget; the payload rides in `_meta`.
            const payload = widgetMeta(name, out);
            return { ...asText(out.text), ...(payload ? { _meta: payload } : {}) };
          }
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

  // Balance-history import: one input shape for the preview and the apply tool.
  const historyInput = {
    householdId,
    mode: z
      .enum(["merge", "replace"])
      .default("merge")
      .describe(
        "merge: add and update values only. replace: also clear saved values of the imported keys that the import does not have between its first and last date.",
      ),
    text: z
      .string()
      .max(2_000_000)
      .optional()
      .describe(
        "CSV/TSV text or pasted spreadsheet cells: a Date column and one column per account (or dates across, or date/account/balance rows). Give this or rows.",
      ),
    rows: z
      .array(HistoryRowBody)
      .max(5000)
      .optional()
      .describe(
        'Already-mapped values: [{date:"2026-01-31",values:{"account:<id>":1234.5,"debt:<id>":800,"loan:<realAssetId>":null}}]. Ids from list_accounts. null = blank (replace clears it).',
      ),
    // A fresh object without the schema's registry id: an id becomes a JSON Schema $ref, and directory checks
    // (Claude's) read a $ref'd parameter as having no type.
    options: z
      .object(HistoryParseOptions.shape)
      .optional()
      .describe(
        'With text: e.g. {"dateFormat":"DMY","columns":{"Savings":"account:acc-cash","Total":"skip"}}. Ambiguous dates are an error until dateFormat is given.',
      ),
    skipInvalid: z
      .boolean()
      .default(false)
      .describe("With text: import the clean cells and leave out cells with errors."),
    updateCurrentBalances: z
      .boolean()
      .default(false)
      .describe("Also set current balances from values dated today."),
  };
  const compactHistory = (r: BalanceHistoryImportResult) => ({
    applied: r.applied,
    mode: r.mode,
    blocked: r.blocked,
    range: r.range,
    counts: r.counts,
    changes: r.changes.slice(0, 40).map((c) => ({
      date: c.date,
      field: c.label,
      key: c.key,
      kind: c.kind,
      before: c.before === null ? null : roundMoney(c.before),
      after: c.after === null ? null : roundMoney(c.after),
    })),
    changesTruncated: r.changes.length > 40 || r.changesTruncated,
    currentBalances: r.currentBalances,
    issues: r.issues.slice(0, 30),
    ...(r.parse ? { parse: r.parse } : {}),
  });
  const runHistory = (
    args: z.infer<z.ZodObject<typeof historyInput>>,
    dryRun: boolean,
  ): Promise<BalanceHistoryImportResult> =>
    services.imports.importBalanceHistory(
      args.householdId,
      BalanceHistoryImportBody.parse({
        mode: args.mode,
        dryRun,
        updateCurrentBalances: args.updateCurrentBalances,
        skipInvalid: args.skipInvalid,
        ...(args.text !== undefined ? { text: args.text } : {}),
        ...(args.rows !== undefined ? { rows: args.rows } : {}),
        ...(args.options ? { options: args.options } : {}),
      }),
      actor,
    );

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
      "Seconds to wait for the result. A longer calculation keeps running and returns a jobId; read the result with get_job. Calculations change nothing in the plan or household.",
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

  /**
   * A Monte Carlo or solver job's text with its widget: the outcome or answer once finished, pending while it
   * runs. Other jobs, and failed ones, have none. `text` is jobOut's result for the job.
   */
  const jobWidget = (job: JobView, text: unknown) => {
    const of =
      job.kind === "monte-carlo" ? "outcome" : WIDGET_SOLVER_KINDS.has(job.kind) ? "answer" : null;
    if (!of) return text;
    if (job.status === "queued" || job.status === "running")
      return withWidget(text, () => widgetBuilders.pending(widgetEnv, job.planId, job.id, of));
    if (job.status !== "succeeded") return text;
    return withWidget(text, () => {
      if (of === "outcome")
        return widgetBuilders.monteCarloOutcome(
          widgetEnv,
          job.planId,
          text as Record<string, unknown>,
          services.jobs.result(job.id) as MonteCarloResult,
        );
      const target = (job.params as { targetSuccessRate?: unknown } | null)?.targetSuccessRate;
      return widgetBuilders.answer(
        widgetEnv,
        job.planId,
        job.kind,
        text as Record<string, unknown>,
        typeof target === "number" ? target : null,
      );
    });
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
          "A plan. 'summary' (default) lists milestones, income, expenses and flows with ids, amounts (value basis/frequency or a share), date ranges (fixed dates resolved, with the number of months when both ends are fixed) and, for flows, priority order, target account or debt by name and id, and whether it is mandatory (always funded). 'full' is the complete plan JSON (very large).",
        input: { planId, detail },
        hint: { readOnly: true },
      },
      ({ planId, detail }) => {
        const plan = services.plans.get(planId);
        return detail === "full"
          ? plan
          : compactPlan(plan, planViewContext(services.households.get(plan.householdId)));
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
        const base = services.plans.get(basePlanId);
        const diff = services.ctx.deps.diffPlans(
          base,
          services.plans.get(otherPlanId),
          services.households.diffNames(base.householdId),
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
      "get_partner_summary",
      {
        title: "Plan summary for a partner",
        description:
          "A one-page plain-words summary to explain the plan to a partner: when you can stop working, what the plan spends, how confident it is, what happens to the survivor if either partner dies, the biggest risks and what was assumed. Every number in its sentences is in `figures` with the engine result it came from: quote the sentences, do not add numbers of your own. The chance of success appears once a default run_monte_carlo has run for this plan version.",
        input: { planId },
        hint: { readOnly: true },
      },
      ({ planId }) => services.scenarios.partnerSummary(planId),
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

    tool(
      "preview_balance_history_import",
      {
        title: "Preview a balance-history import (dry run)",
        description:
          "Per-account balances over time from a spreadsheet (pasted cells, CSV or TSV) or from already-mapped rows. Reads the dates and numbers, matches columns to accounts/assets/loans/debts (parse.columns shows the match and its confidence), flags problem cells by reference, and returns what merge or replace would add, update and remove. Writes nothing. Show the user the counts and changes, then call apply_balance_history_import with the same arguments.",
        input: historyInput,
        hint: { readOnly: true },
      },
      async (args) => compactHistory(await runHistory(args, true)),
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
            hh.household.locale,
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
          outcome = { error: forAssistant(describeError(err)) };
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
          plan: compactPlan(plan, planViewContext(hh)),
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
      ({ planId, ...view }) => {
        // services.sim.simulate with a view, keeping the run for the widget.
        const run = services.sim.projection(planId, { trace: "off" });
        const text = compactProjection(
          run.result,
          { ...view, include: ["summary", "milestones", "warnings"] },
          run.cached,
        );
        return withWidget(text, () =>
          widgetBuilders.deterministicOutcome(widgetEnv, planId, run.result),
        );
      },
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
        hint: CALCULATION,
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
        const done = await awaitJob(job, wait, extra);
        const text = jobOut(done, (r) => compactMonteCarlo(r as never, { detail }));
        return jobWidget(done, text);
      },
    );

    tool(
      "run_historical_backtest",
      {
        title: "Run historical backtest",
        description:
          "Replay the plan through every historical start year (no randomness). Returns the share of start years that succeeded and the worst cases.",
        input: { planId, detail, wait: waitSeconds },
        hint: CALCULATION,
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
        const text = services.sim.compare(planIds, explain);
        return withWidget(text, () => {
          // The baseline against the first other plan, from the same (cached) projections.
          const [a, b] = text.plans as [(typeof text.plans)[0], (typeof text.plans)[0]];
          const run = (id: string) =>
            services.sim.projection(id, { trace: explain ? "summary" : "off" }).result;
          return widgetBuilders.compare(widgetEnv, {
            planId: a.planId,
            headlinePrefix: `${b.name} against ${a.name}`,
            beforeLabel: a.name,
            afterLabel: b.name,
            before: { ...numbers(a.outcome), success: a.success },
            after: { ...numbers(b.outcome), success: b.success },
            beforeRun: run(a.planId),
            afterRun: run(b.planId),
            changes: text.differences[0]?.changes ?? [],
            ops: null,
            template: null,
          });
        });
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
        hint: CALCULATION,
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
          hint: CALCULATION,
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
          const done = await awaitJob(job, wait, extra);
          return jobWidget(
            done,
            jobOut(done, (r) => compactSolver(r as never, detail)),
          );
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
        hint: CALCULATION,
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
        hint: CALCULATION,
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
      ({ planId, ...q }) => {
        const text = services.sim.taxBreakdown(planId, q);
        return withWidget(text, () =>
          widgetBuilders.tax(
            widgetEnv,
            planId,
            text,
            q.detail === "lines"
              ? text
              : services.sim.taxBreakdown(planId, { ...q, detail: "lines" }),
          ),
        );
      },
    );

    tool(
      "tax_by_country",
      {
        title: "Tax by country and basis",
        description:
          "Plans with accounts, property or income in another country: lifetime and per-year tax per country and basis (residence = the household's country, source = charged by another country as a non-resident, citizenship = US citizens abroad, relief = credit for tax paid elsewhere (negative)). Plans with nothing abroad show one residence row. Includes the simplifications that apply.",
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
          "For one account, real asset, debt or income: its country, the country the household lives in, and per income category whether the source country taxes it (non-resident rule), the treaty article, whether the household's country taxes it and the relief (credit / exemption). Warnings flag unknown treaty pairs and unrecognised foreign wrappers. Ids from get_household / get_plan.",
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
        const text = {
          planVersion: out.plan.version,
          changes: out.diff.changes.slice(0, 40).map((c) => c.description),
          preview: out.preview,
        };
        return withWidget(text, () =>
          out.preview && out.results
            ? widgetBuilders.compare(widgetEnv, {
                planId,
                headlinePrefix: "With these changes",
                beforeLabel: "Current plan",
                afterLabel: "With changes",
                before: numbers(out.preview.before),
                after: numbers(out.preview.after),
                beforeRun: out.results.before,
                afterRun: out.results.after,
                changes: text.changes,
                ops,
                template: null,
              })
            : null,
        );
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
        const text = {
          planId: n.planId,
          planVersion: n.planVersion,
          ...compactYearNarrative(n, detail),
        };
        return withWidget(text, () => widgetBuilders.year(widgetEnv, planId, n));
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
        hint: CALCULATION,
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
        hint: CALCULATION,
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
      "plan_roth_conversions",
      {
        title: "Plan Roth conversions",
        description:
          "US plans: propose a Roth conversion amount for each year and person. Each amount fills the room left under a ceiling after all the year's other income (wages, pensions, taxable Social Security, interest, dividends, gains, RMDs): the top of a federal bracket, optionally an IRMAA tier (from age 63), and the ACA premium tax credit limit in marketplace years. Each year says what bound it, the room left and the tax on the conversion. Compares with no conversions (and the plan's current conversions) on lifetime tax, after-tax wealth at the end and success, and says plainly when no conversions is better. Omit `targets` to let it choose the bracket per block of years. A job; changes nothing in the plan: to apply, pass `patch` to propose_change_set and show the user. Estimates, not advice.",
        input: {
          planId,
          targets: z
            .array(
              z.object({
                personId: z.string().optional(),
                fromYear: z.number().int().optional(),
                toYear: z.number().int().optional(),
                bracketRate: z.number().min(0).max(1).nullable(),
              }),
            )
            .max(200)
            .optional()
            .describe(
              "Your ceilings by person and year (later entries win); bracketRate 0.22 = up to the top of the 22% bracket, null = no conversion. Omit to let the planner choose.",
            ),
          irmaaTier: z
            .number()
            .int()
            .min(1)
            .max(5)
            .nullable()
            .default(null)
            .describe("Keep MAGI within this IRMAA tier (1 = no surcharge) when someone is 63+."),
          aca: z
            .boolean()
            .default(true)
            .describe("Stay under the ACA subsidy limit in marketplace years."),
          fromYear: z.number().int().optional(),
          toYear: z.number().int().optional(),
          objective: z.enum(["afterTaxEndWealth", "lifetimeTax"]).default("afterTaxEndWealth"),
          successRate: z
            .boolean()
            .default(false)
            .describe("Also run Monte Carlo per compared plan (slower)."),
          detail,
          wait: waitSeconds,
        },
        hint: CALCULATION,
      },
      async ({ planId, detail, wait, ...request }, extra) => {
        const job = services.sim.startRothConversionPlan(planId, request, actor);
        return jobOut(await awaitJob(job, wait, extra), (r) => compactRothPlan(r as never, detail));
      },
    );

    // A fresh object per lever (no registry id): directory checks read a $ref'd parameter as untyped.
    const flowRef = z.string().describe("Flow id from get_plan.");
    tool(
      "optimise_plan",
      {
        title: "Optimise plan levers",
        description:
          "Search the flow levers you list for the setting that best meets a goal while the deterministic projection never runs short: earliest-retirement (earliest retirement month), earliest-fi (earliest month the financial-independence milestone, or the milestone you name, is reached) or max-end-net-worth (today's money). Levers per flow: toggle (keep it or switch it the other way), scale (multiply its amount or share by factors between min and max), redirect (a debt paydown becomes a contribution to accountId with the same amount and dates, or a contribution becomes a paydown of targetId: 'overpay the mortgage or invest?'). Small spaces are searched exhaustively, larger ones one lever at a time (coordinate descent), up to maxEvaluations engine runs. A heuristic search over the given levers only, deterministic projections only (no Monte Carlo); not a global optimiser. Returns the best candidate with its RFC 6902 ops (for preview_changes or propose_change_set), the baseline, alternatives as a table and, for earliest-retirement, milestoneOps that also move the retirement milestone. A job; changes nothing in the plan. Estimates, not advice.",
        input: {
          planId,
          goal: z.enum(["earliest-retirement", "earliest-fi", "max-end-net-worth"]),
          milestoneId: z
            .string()
            .optional()
            .describe(
              "Milestone id from get_plan (default: the retirement or financial-independence milestone).",
            ),
          levers: z
            .array(
              z.discriminatedUnion("kind", [
                z.object({ kind: z.literal("toggle"), flowId: flowRef }),
                z.object({
                  kind: z.literal("scale"),
                  flowId: flowRef,
                  min: z.number().min(0).max(10).default(0.5),
                  max: z.number().min(0).max(10).default(2),
                  steps: z
                    .number()
                    .int()
                    .min(2)
                    .max(21)
                    .default(5)
                    .describe("Evenly spaced factors from min to max (1 is always tried)."),
                }),
                z.object({
                  kind: z.literal("redirect"),
                  flowId: flowRef,
                  accountId: z
                    .string()
                    .optional()
                    .describe("For a debt paydown: the account to contribute to instead."),
                  targetId: z
                    .string()
                    .optional()
                    .describe(
                      "For a contribution: the debt or real asset (its loan) to pay instead.",
                    ),
                }),
              ]),
            )
            .min(1)
            .max(12)
            .describe(
              'e.g. [{"kind":"redirect","flowId":"fl-overpay","accountId":"acc-isa"},{"kind":"scale","flowId":"fl-pension","min":0.5,"max":1.5,"steps":3}]',
            ),
          maxEvaluations: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .default(200)
            .describe("Engine runs allowed (default 200)."),
          alternatives: z.number().int().min(0).max(10).default(5),
          detail,
          wait: waitSeconds,
        },
        hint: CALCULATION,
      },
      async ({ planId, detail, wait, ...request }, extra) => {
        const job = services.sim.startOptimisePlan(planId, request, actor);
        return jobOut(await awaitJob(job, wait, extra), (r) => compactOptimise(r as never, detail));
      },
    );

    tool(
      "strategy_matrix",
      {
        title: "Strategy matrix",
        description:
          "Strategies x metrics (lifetime tax, net legacy, chance of success, final net worth) for the built-in tax/drawdown strategies, with per-column scores (0 worst .. 1 best) and the best row per column. A job; set successRate=false to skip the slow Monte Carlo column.",
        input: { planId, successRate: z.boolean().default(true), wait: waitSeconds },
        hint: CALCULATION,
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
      ({ planId, templateId, params }) => {
        const { out, results } = services.scenarios.previewWithResults(planId, templateId, params);
        return withWidget(out, () => {
          if (!out.before || !out.after || !results) return null;
          const years = results.before.periods.map((p) => p.year);
          return widgetBuilders.compare(widgetEnv, {
            planId,
            headlinePrefix: out.template.title,
            beforeLabel: "Current plan",
            afterLabel: out.template.title,
            before: numbers(out.before),
            after: numbers(out.after),
            beforeRun: results.before,
            afterRun: results.after,
            changes: out.changes,
            ops: out.ops as Record<string, unknown>[],
            template: {
              id: templateId,
              label: out.template.title,
              params,
              tweakable: tweakableParams(templateId, params, {
                firstYear: years[0] ?? 0,
                lastYear: years[years.length - 1] ?? 0,
              }),
            },
          });
        });
      },
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
          "Status and progress of a calculation started by another tool (Monte Carlo, solver...). Includes the (compact) result once finished. Read-only.",
        input: {
          jobId: z.string(),
          wait: z.number().min(0).max(110).default(0).describe("Seconds to wait for completion."),
        },
        hint: { readOnly: true },
      },
      async ({ jobId, wait }, extra) => {
        const job = await awaitJob(services.jobs.get(jobId), wait, extra);
        const text = jobOut(job, (r) =>
          job.kind === "monte-carlo" || job.kind === "historical"
            ? compactMonteCarlo(r as never, {})
            : job.kind === "tax-strategy"
              ? compactStrategies(r as never)
              : job.kind === "roth-conversion-plan"
                ? compactRothPlan(r as never)
                : job.kind === "optimise-plan"
                  ? compactOptimise(r as never)
                  : job.kind === "attribution"
                    ? { attribution: compactAttribution(r as never) }
                    : SOLVER_KINDS.has(job.kind)
                      ? compactSolver(r as never)
                      : r,
        );
        // No template of its own, but a finished Monte Carlo or solver job completes a pending widget.
        return job.status === "succeeded" ? jobWidget(job, text) : text;
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
        hint: { readOnly: false, idempotent: true, destructive: true },
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
    /** `readable`, with the review widget built from the same change set. */
    const reviewable = (cs: ReturnType<Services["changeSets"]["get"]>) => {
      const text = readable(cs);
      return withWidget(text, () => widgetBuilders.review(widgetEnv, cs, text.changes));
    };

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
        return reviewable(
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
        hint: { readOnly: false, destructive: true },
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
        hint: { readOnly: false, idempotent: true, destructive: true },
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
        return reviewable(
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
        hint: { readOnly: false, idempotent: true, destructive: true },
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
        hint: { readOnly: false, destructive: true },
      },
      async ({ householdId, kind, text, options, planId }) => {
        const out = (await services.imports.importCsv(
          householdId,
          {
            text,
            kind,
            dryRun: false,
            ...(options ? { options: options as never } : {}),
            ...(planId ? { planId } : {}),
          },
          actor,
        )) as { issueCount: number; changes: unknown; kind: string };
        return { kind: out.kind, applied: true, issueCount: out.issueCount, changes: out.changes };
      },
    );

    tool(
      "apply_balance_history_import",
      {
        title: "Apply a balance-history import",
        description:
          "Write a balance-history import atomically (same arguments as preview_balance_history_import, which you must run first and show the user). Repeating it changes nothing. Errors change nothing and list dates, keys and cell references.",
        input: historyInput,
        hint: { readOnly: false, idempotent: true, destructive: true },
      },
      async (args) => compactHistory(await runHistory(args, false)),
    );

    // ----------------------------------------------------------------------------- plan lifecycle
    const expectedVersion = z
      .number()
      .int()
      .optional()
      .describe("Plan version you read (list_plans); if the plan has moved on, nothing changes.");
    const planRow = (p: ReturnType<Services["plans"]["get"]>) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      isMain: p.isMain,
      status: p.status,
    });

    tool(
      "duplicate_plan",
      {
        title: "Duplicate plan",
        description:
          "Copy a plan into a new, independent plan (not a branch: later edits to either plan do not reach the other). The copy is active and not the main plan; the original is untouched.",
        input: {
          planId,
          name: z
            .string()
            .min(1)
            .max(120)
            .optional()
            .describe('Name of the copy (default: "<name> (copy)").'),
        },
        hint: { readOnly: false },
      },
      ({ planId, name }) => ({
        ...planRow(services.plans.duplicate(planId, { name }, actor)),
        copiedFrom: planId,
      }),
    );

    tool(
      "rename_plan",
      {
        title: "Rename plan",
        description:
          "Change a plan's name (and optionally its description). Recorded in the plan history.",
        input: {
          planId,
          name: z.string().min(1).max(120),
          description: z.string().max(2000).optional(),
          expectedVersion,
        },
        hint: { readOnly: false, idempotent: true, destructive: true },
      },
      ({ planId, name, description, expectedVersion }) => {
        const before = services.plans.get(planId);
        const ops: PatchOp[] = [{ op: "replace", path: "/name", value: name }];
        if (description !== undefined)
          ops.push({
            op: before.description === undefined ? "add" : "replace",
            path: "/description",
            value: description,
          });
        const p = services.plans.patch(
          planId,
          ops,
          expectedVersion,
          actor,
          `renamed from '${before.name}' to '${name}'`,
        );
        return { ...planRow(p), previousName: before.name };
      },
    );

    tool(
      "set_main_plan",
      {
        title: "Set main plan",
        description:
          "Make a plan the household's main plan (the default for every tool). The previous main plan stays, as an ordinary plan; an archived plan is made active again.",
        input: { planId, expectedVersion },
        hint: { readOnly: false, idempotent: true, destructive: true },
      },
      ({ planId, expectedVersion }) => {
        const householdId = services.plans.get(planId).householdId;
        const previous = services.plans
          .list({ householdId })
          .find((p) => p.isMain && p.id !== planId);
        const p = services.plans.setMain(planId, expectedVersion, actor);
        return { ...planRow(p), previousMain: previous?.id ?? null };
      },
    );

    tool(
      "set_plan_archived",
      {
        title: "Archive or unarchive plan",
        description:
          "Archive a plan (kept with its history, hidden from active lists; an archived main plan stops being main) or, with archived=false, make it active again. Nothing is deleted.",
        input: { planId, archived: z.boolean(), expectedVersion },
        hint: { readOnly: false, idempotent: true, destructive: true },
      },
      ({ planId, archived, expectedVersion }) => {
        const wasMain = services.plans.get(planId).isMain;
        const p = services.plans.setArchived(planId, archived, expectedVersion, actor);
        return {
          ...planRow(p),
          ...(archived && wasMain
            ? { note: "This was the main plan; no plan is main now. set_main_plan picks one." }
            : {}),
        };
      },
    );

    // ----------------------------------------------------------------------------- household edits
    const itemKind = z.enum(["account", "realAsset", "debt", "person", "dependent"]);
    const householdOps = z
      .array(
        z.discriminatedUnion("action", [
          z.object({
            action: z.literal("add"),
            kind: itemKind,
            item: z
              .record(z.string(), z.unknown())
              .describe(
                'The new item as in get_household detail="full", e.g. {"name":"Stocks ISA","type":"isa","owner":"p-1","balance":20000}. id optional.',
              ),
          }),
          z.object({
            action: z.literal("update"),
            kind: itemKind,
            id: z.string(),
            changes: z
              .record(z.string(), z.unknown())
              .describe(
                'JSON merge patch: only the fields to change, e.g. {"interest":{"apr":0.045}} or {"archived":true}; null removes an optional field.',
              ),
          }),
          z.object({ action: z.literal("remove"), kind: itemKind, id: z.string() }),
          z.object({
            action: z.literal("updateHousehold"),
            changes: z
              .object({
                name: z.string().min(1).max(120).optional(),
                location: z
                  .object({
                    country: z.string(),
                    region: z.string().optional(),
                    locality: z.string().optional(),
                  })
                  .optional(),
                locale: z.string().optional(),
              })
              .strict()
              .describe(
                "Household name, location (tax residence) or locale. The currency cannot be changed here.",
              ),
          }),
        ]),
      )
      .min(1)
      .max(50)
      .describe(
        "Applied in order, all or nothing. kind realAsset holds a property and its mortgage (loan).",
      );
    const parseHouseholdOps = (ops: unknown) => z.array(HouseholdChangeOp).parse(ops);

    tool(
      "preview_household_change",
      {
        title: "Preview household change",
        description:
          "Check and describe household edits without storing anything: add, update or remove accounts, real assets (a property with its mortgage), debts, people and dependents, or change the household's name, location or locale. Returns each change in words, the household version to pass to apply_household_change and, when the household has a main plan, its outcome before and after. Removing something a plan still uses is refused with the plans and items that use it. Currency cannot be changed here.",
        input: { householdId, operations: householdOps },
        hint: { readOnly: true },
      },
      ({ householdId, operations }) => {
        const out = services.households.applyChanges(
          householdId,
          parseHouseholdOps(operations),
          { dryRun: true },
          actor,
        );
        const main = services.plans.list({ householdId, status: "active" }).find((p) => p.isMain);
        let mainPlan: Record<string, unknown> | null = null;
        if (main)
          try {
            const before = services.sim.projection(main.id, { trace: "off" }).result;
            const { input } = services.sim.inputFor(main.id, { trace: "off" });
            const after = services.ctx.deps.simulate({
              ...input,
              household: out.household,
              finances: out.finances,
            });
            mainPlan = {
              planId: main.id,
              name: main.name,
              before: outcomeOf(before),
              after: outcomeOf(after),
            };
          } catch (err) {
            mainPlan = { planId: main.id, name: main.name, error: describeError(err).message };
          }
        return {
          householdId,
          householdVersion: out.version,
          changes: out.changes,
          ...(mainPlan ? { mainPlan } : {}),
          next: "Show the user the changes, then call apply_household_change with the same operations and this householdVersion.",
        };
      },
    );

    tool(
      "apply_household_change",
      {
        title: "Apply household change",
        description:
          "Store household edits: the same operations as preview_household_change, which checks and describes them without storing anything. All or nothing, in one write; fails with VERSION_CONFLICT if the household changed since householdVersion. Accounts, assets and debts that plans use cannot be removed (archive them instead). Balance changes also update today's automatic progress snapshot when those are on.",
        input: {
          householdId,
          operations: householdOps,
          householdVersion: z
            .number()
            .int()
            .describe("householdVersion from preview_household_change (or get_household)."),
        },
        hint: { readOnly: false, destructive: true },
      },
      ({ householdId, operations, householdVersion }) => {
        const out = services.households.applyChanges(
          householdId,
          parseHouseholdOps(operations),
          { expected: householdVersion, dryRun: false },
          actor,
        );
        return {
          applied: true,
          householdId,
          householdVersion: out.version,
          changes: out.changes,
          snapshotId: out.snapshot?.id ?? null,
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
      "cross_border_rules",
      {
        title: "Cross-border rule tables",
        description:
          "The tables the engine uses. kind='countries' (which countries have rules, tax currency, treaties, pegs); 'non-resident' (how `country` taxes non-residents per income category and its wrappers); 'treaty' (the `country`-`otherCountry` treaty with each category's allocation both ways, or the fallback); 'wrappers' (how `country` as residence treats accounts of `otherCountry`); 'simplifications' (known limitations for the countries given).",
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
        hint: { readOnly: false, idempotent: true, destructive: true },
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
          "Compare the plan and household as they are now with the last check-in: material changes (success rate, milestones, new findings, net worth versus plan), the edits made since and by whom, and notifications. Read-only: the chance of success is the stored one, and nothing is saved. To take a new check-in, use run_checkin (needs write access).",
        input: {
          planId,
          since: z
            .string()
            .optional()
            .describe("ISO time to compare from (default: the last check-in)."),
        },
        hint: { readOnly: true },
      },
      // No refresh option: taking a check-in stores it, so a read-only tool must not (run_checkin does).
      async ({ planId, since }) => services.checkins.sinceLastCheckin(planId, { since }, actor),
    );
  }

  if (canSim) {
    tool(
      "explain_result_change",
      {
        title: "Why did my results change?",
        description:
          "How far the headline results moved since a check-in (chance of success, financial-independence year, end-of-plan net worth in today's money), split into causes: Glideworth's side (engine, tax tables, market history), the passage of time, updated balances versus what the plan expected, household details, and plan edits (each edit named and sized). " +
          "Causes are applied one at a time in the fixed order given in `order`; the parts add up to the total, with any remainder as `unexplained`. from defaults to the latest check-in, to to now. Older check-ins give the total only (available=false). " +
          "Read-only: recomputes in memory (runs Monte Carlo, seconds) and saves nothing. Estimates, not advice.",
        input: {
          planId,
          from: z
            .string()
            .optional()
            .describe("Check-in id to compare from (default: the latest)."),
          to: z.string().optional().describe("Check-in id to compare to (default: now)."),
        },
        hint: { readOnly: true },
      },
      async ({ planId, from, to }) => services.checkins.resultChange(planId, { from, to }),
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
        hint: { readOnly: false, idempotent: true, destructive: true },
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
        hint: { readOnly: false, idempotent: true, destructive: true },
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
        hint: { readOnly: false, openWorld: true },
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
        hint: { readOnly: true },
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
  registerWidgetResource(server, widgetEnv.webUrl);
  registerPrompts(server, ctx);
  return server;
}
