import {
  Explanation,
  Finding,
  GoalSeekResult,
  GuardrailsResult,
  MonteCarloResult,
  Plan,
  ProjectionResult,
  OptimisePlanRequest,
  RothConversionPlanRequest,
  SimulationInput,
} from "@glideworth/core";
import { z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { requireScope } from "../auth.js";
import { ApiError } from "../errors.js";
import {
  CompactProjection,
  CompareRequest,
  EarliestRetirementRequest,
  ExplainDifferenceRequest,
  ExplainRequest,
  ExplainYearRequest,
  ExplainYearsRequest,
  GoalSeekBody,
  GuardrailsRequest,
  GuytonKlingerRequest,
  HistoricalRequest,
  JobSchema,
  JobStatusEnum,
  MaxSpendingRequest,
  MonteCarloRequest,
  RequiredPortfolioRequest,
  RequiredSavingsRequest,
  ResultView,
  SafeWithdrawalRateRequest,
  ScenarioBranchRequest,
  ScenarioRequest,
  SensitivityRequest,
  SimulateRequest,
  StrategyMatrixRequest,
  SurvivorQuery,
  TaxQuery,
  TaxStrategyRequest,
  WaitQuery,
} from "../schemas.js";
import { type JobView, TERMINAL } from "../services/jobs.js";
import { PageQuery, pageOf, paginate } from "../util.js";
import { compactAttribution, compactMonteCarlo, compactYearNarrative } from "../views.js";
import { actorOf, errors, IdParam, json, pathId, type RouteCtx, route } from "./helpers.js";

export const jobLinks = (j: { id: string }) => ({
  self: `/api/v1/jobs/${j.id}`,
  result: `/api/v1/jobs/${j.id}/result`,
  events: `/api/v1/jobs/${j.id}/events`,
  cancel: `/api/v1/jobs/${j.id}/cancel`,
});
export const withLinks = (j: JobView) => ({ ...j, links: jobLinks(j) });

export function simulationRoutes({ app, svc }: RouteCtx) {
  const P = "/api/v1/plans/{id}";

  app.openapi(
    route("simulate", {
      method: "post",
      path: `${P}/simulate`,
      operationId: "simulatePlan",
      tags: ["Simulation"],
      summary:
        "Deterministic projection of a stored plan (whole result, or a compact view of selected years/series)",
      description:
        "Without `view` the full ProjectionResult is returned (can be large). With `view` you choose basis, year range, every-Nth-year and series, and get a small GlideworthCompactProjection. " +
        "Results are cached per plan version + options (`meta.cached` in compact views).",
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: SimulateRequest } }, required: false },
      },
      responses: { 200: json(z.union([ProjectionResult, CompactProjection]), "Projection") },
    }),
    async (c) => {
      const body = SimulateRequest.parse((await c.req.json().catch(() => ({}))) ?? {});
      return c.json(svc(c).sim.simulate(c.req.valid("param").id, body) as never, 200);
    },
  );
  app.openapi(
    route("simulate", {
      method: "post",
      path: "/api/v1/simulate",
      operationId: "simulateStateless",
      tags: ["Simulation"],
      summary: "Stateless: simulate an arbitrary input without storing anything",
      request: {
        body: { content: { "application/json": { schema: SimulationInput } }, required: true },
      },
      responses: { 200: json(ProjectionResult, "Projection") },
    }),
    (c) => c.json(svc(c).ctx.deps.simulate(c.req.valid("json")), 200),
  );

  // ----------------------------------------------------------------------------- async jobs
  async function launch(c: import("hono").Context, job: JobView, wait: number) {
    const done = wait > 0 ? await svc(c).jobs.waitFor(job.id, wait * 1000) : job;
    return c.json(withLinks(done), TERMINAL.includes(done.status) ? 200 : 202);
  }

  const jobOps: {
    seg: string;
    op: string;
    summary: string;
    schema: z.ZodType;
    start: (
      s: import("../services.js").Services,
      id: string,
      body: never,
      actor: ReturnType<typeof actorOf>,
    ) => JobView;
  }[] = [
    {
      seg: "monte-carlo",
      op: "runMonteCarlo",
      summary: "Monte Carlo chance-of-success run (async job)",
      schema: MonteCarloRequest,
      start: (s, id, b, a) => s.sim.startMonteCarlo(id, b, a),
    },
    {
      seg: "historical",
      op: "runHistorical",
      summary: "Historical backtest, one trial per start year (async job)",
      schema: HistoricalRequest,
      start: (s, id, b, a) => s.sim.startHistorical(id, b, a),
    },
    {
      seg: "solve/goal-seek",
      op: "solveGoalSeek",
      summary: "Generic goal seek over any plan variable (async job)",
      schema: GoalSeekBody,
      start: (s, id, b, a) => s.sim.startSolver("goal-seek", id, b, a),
    },
    {
      seg: "solve/max-spending",
      op: "solveMaxSpending",
      summary: "Maximum sustainable spending at a target success rate (async job)",
      schema: MaxSpendingRequest,
      start: (s, id, b, a) => s.sim.startSolver("max-spending", id, b, a),
    },
    {
      seg: "solve/earliest-retirement",
      op: "solveEarliestRetirement",
      summary: "Earliest retirement date at a target success rate (async job)",
      schema: EarliestRetirementRequest,
      start: (s, id, b, a) => s.sim.startSolver("earliest-retirement", id, b, a),
    },
    {
      seg: "solve/required-savings",
      op: "solveRequiredSavings",
      summary: "Required savings to reach a target success rate (async job)",
      schema: RequiredSavingsRequest,
      start: (s, id, b, a) => s.sim.startSolver("required-savings", id, b, a),
    },
    {
      seg: "solve/required-portfolio",
      op: "solveRequiredPortfolio",
      summary:
        "Smallest portfolio (as a scale on invested balances) that reaches a target success rate (async job)",
      schema: RequiredPortfolioRequest,
      start: (s, id, b, a) => s.sim.startSolver("required-portfolio", id, b, a),
    },
    {
      seg: "solve/safe-withdrawal-rate",
      op: "solveSafeWithdrawalRate",
      summary:
        "Highest constant withdrawal rate that still meets a target success rate over N years (async job)",
      schema: SafeWithdrawalRateRequest,
      start: (s, id, b, a) => s.sim.startSolver("safe-withdrawal-rate", id, b, a),
    },
    {
      seg: "solve/tax-strategy",
      op: "optimiseTaxStrategy",
      summary:
        "Compare tax strategies (drawdown order, UK allowance use / lump-sum timing, US bracket filling) or your own candidate patches (async job)",
      schema: TaxStrategyRequest,
      start: (s, id, b, a) => s.sim.startTaxStrategy(id, b, a),
    },
    {
      seg: "solve/roth-conversions",
      op: "planRothConversions",
      summary:
        "Roth conversion plan (US): an amount per year and person, filling the room under a bracket, IRMAA tier or the ACA limit after all other income, with the reason, the tax, and a comparison with no conversions (async job; estimates, not advice)",
      schema: RothConversionPlanRequest,
      start: (s, id, b, a) => s.sim.startRothConversionPlan(id, b, a),
    },
    {
      seg: "solve/optimise",
      op: "optimisePlan",
      summary:
        "Plan optimiser: which settings of the flow levers you list (keep or disable, scale, redirect a debt paydown to an account or back) best meet a goal (earliest retirement, earliest financial independence, most net worth at the end) without a shortfall in the deterministic projection; a heuristic search, not a global optimiser (async job)",
      schema: OptimisePlanRequest,
      start: (s, id, b, a) => s.sim.startOptimisePlan(id, b, a),
    },
    {
      seg: "insights/strategy-matrix",
      op: "strategyMatrix",
      summary:
        "Strategies x metrics matrix: lifetime tax, net legacy, chance of success and final net worth per strategy, with per-column scores (a heatmap; async job)",
      schema: StrategyMatrixRequest,
      start: (s, id, b, a) => s.sim.startStrategyMatrix(id, b, a),
    },
    {
      seg: "insights/guardrails",
      op: "evaluateGuardrails",
      summary: "Risk-based spending guardrails: this year's recommended spending (async job)",
      schema: GuardrailsRequest,
      start: (s, id, b, a) => s.sim.startGuardrails(id, b, a),
    },
  ];
  for (const j of jobOps) {
    app.openapi(
      route("simulate", {
        method: "post",
        path: `${P}/${j.seg}`,
        operationId: j.op,
        tags: [
          j.seg.startsWith("solve")
            ? "Solvers"
            : j.seg.startsWith("insights")
              ? "Insights"
              : "Simulation",
        ],
        summary: j.summary,
        description:
          "Returns **202** with a Job. Poll `GET /jobs/{id}`, stream `GET /jobs/{id}/events` (SSE) and fetch `GET /jobs/{id}/result`. " +
          "Pass `?wait=<seconds>` to block until it finishes (200 with the finished Job). Identical requests on an unchanged plan are served from the result cache.",
        request: {
          params: IdParam,
          query: WaitQuery,
          body: { content: { "application/json": { schema: j.schema } }, required: false },
        },
        responses: {
          200: json(JobSchema, "Finished job (cached or waited)"),
          202: json(JobSchema, "Accepted: job queued or running"),
        },
      }),
      async (c) => {
        const raw = ((await c.req.json().catch(() => ({}))) ?? {}) as unknown;
        const body = j.schema.parse(raw);
        const job = j.start(svc(c), c.req.valid("param").id, body as never, actorOf(c));
        return launch(c as never, job, c.req.valid("query").wait) as never;
      },
    );
  }

  // ----------------------------------------------------------------------------- job control
  const JobParams = z.object({
    id: z
      .string()
      .min(1)
      .max(64)
      .openapi({ param: { name: "id", in: "path" } }),
  });
  app.openapi(
    route("simulate", {
      method: "get",
      path: "/api/v1/jobs",
      operationId: "listJobs",
      tags: ["Jobs"],
      summary: "List jobs (newest first)",
      request: {
        query: PageQuery.extend({
          status: JobStatusEnum.optional(),
          planId: z.string().optional(),
        }),
      },
      responses: { 200: json(pageOf(JobSchema), "Jobs") },
    }),
    (c) => {
      const q = c.req.valid("query");
      const page = paginate(svc(c).jobs.list({ status: q.status, planId: q.planId }), q);
      return c.json({ ...page, items: page.items.map(withLinks) }, 200);
    },
  );
  app.openapi(
    route("simulate", {
      method: "get",
      path: "/api/v1/jobs/{id}",
      operationId: "getJob",
      tags: ["Jobs"],
      summary: "Job status and progress (poll this)",
      request: { params: JobParams },
      responses: { 200: json(JobSchema, "Job") },
    }),
    (c) => c.json(withLinks(svc(c).jobs.get(c.req.valid("param").id)), 200),
  );
  app.openapi(
    route("simulate", {
      method: "get",
      path: "/api/v1/jobs/{id}/result",
      operationId: "getJobResult",
      tags: ["Jobs"],
      summary:
        "Result of a finished job (409 JOB_NOT_FINISHED / JOB_FAILED / JOB_CANCELLED otherwise)",
      description:
        "Monte Carlo / historical results are thinned by default (`detail=summary`); use `detail=full` for the full fan and per-trial rows.",
      request: { params: JobParams, query: ResultView },
      responses: {
        200: json(
          z.union([
            MonteCarloResult,
            GoalSeekResult,
            GuardrailsResult,
            z.record(z.string(), z.unknown()),
          ]),
          "Result (shape depends on job kind)",
        ),
      },
    }),
    (c) => {
      const { id } = c.req.valid("param");
      const job = svc(c).jobs.get(id);
      const result = svc(c).jobs.result(id);
      if (job.kind === "monte-carlo" || job.kind === "historical")
        return c.json(compactMonteCarlo(result as never, c.req.valid("query")) as never, 200);
      return c.json(result as never, 200);
    },
  );
  app.openapi(
    route("simulate", {
      method: "post",
      path: "/api/v1/jobs/{id}/cancel",
      operationId: "cancelJob",
      tags: ["Jobs"],
      summary: "Cancel a queued or running job (worker thread is terminated)",
      description:
        "A credential can cancel the jobs it started; cancelling someone else’s job needs `write`. (A `simulate`-only key can no longer cancel every job.)",
      request: { params: JobParams },
      responses: { 200: json(JobSchema, "Job (status=cancelled once stopped)") },
    }),
    async (c) => {
      const id = c.req.valid("param").id;
      const p = c.get("principal");
      const owner = svc(c).jobs.createdBy(id).id;
      const mine = owner !== undefined && owner === (p.via === "session" ? p.userId : p.keyId);
      if (!mine && !p.scopes.includes("write"))
        throw new ApiError(
          403,
          "FORBIDDEN",
          "you can cancel only jobs you started (or need the write scope)",
          {
            required: "write",
          },
        );
      return c.json(withLinks(await svc(c).jobs.cancelAndWait(id)), 200);
    },
  );
  // Server-Sent Events: registered with plain Hono (event streams are not JSON) but documented below.
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/api/v1/jobs/{id}/events",
    operationId: "streamJobEvents",
    tags: ["Jobs"],
    summary: "Server-Sent Events: `status` / `progress` events until the job is terminal",
    description:
      "Each event is `event: progress|status|done` with a JSON Job as data. Send the Authorization header (use fetch streaming or curl -N; browser EventSource cannot set headers). Scope: `simulate`.",
    security: [{ bearer: [] }],
    request: { params: JobParams },
    responses: {
      200: {
        description: "text/event-stream",
        content: { "text/event-stream": { schema: z.string() } },
      },
      ...errors,
    },
    // oxlint-disable-next-line typescript/no-explicit-any -- extension key
    ...({ "x-required-scope": "simulate" } as any),
  });
  app.get("/api/v1/jobs/:id/events", requireScope("simulate"), (c) => {
    const id = c.req.param("id");
    svc(c).jobs.get(id); // 404 before opening the stream
    // Cloud: the request's lease ends when this handler returns; the stream holds its own until it closes.
    const release = c.get("holdLease")?.() ?? (() => {});
    return streamSSE(c, async (stream) => {
      try {
        let closed = false;
        stream.onAbort(() => {
          closed = true;
        });
        const send = async (v: JobView) => {
          const kind = TERMINAL.includes(v.status)
            ? "done"
            : v.status === "running" && v.progress > 0
              ? "progress"
              : "status";
          await stream.writeSSE({
            event: kind,
            data: JSON.stringify(withLinks(v)),
            id: String(Date.now()),
          });
        };
        const first = svc(c).jobs.get(id);
        await send(first);
        if (TERMINAL.includes(first.status)) return;
        await new Promise<void>((resolve) => {
          const off = svc(c).jobs.subscribe(id, (v) => {
            if (closed) return;
            void send(v).then(() => {
              if (TERMINAL.includes(v.status)) {
                off();
                resolve();
              }
            });
          });
          stream.onAbort(() => {
            off();
            resolve();
          });
        });
      } finally {
        release();
      }
    });
  });

  // ----------------------------------------------------------------------------- insights (synchronous)
  app.openapi(
    route("simulate", {
      method: "post",
      path: `${P}/insights/explain`,
      operationId: "explainPlan",
      tags: ["Insights"],
      summary: "Why did the plan end up here? Findings built from the engine trace and ledger",
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ExplainRequest } }, required: false },
      },
      responses: {
        200: json(
          Explanation.extend({ planId: z.string(), planVersion: z.number().int() }),
          "Explanation",
        ),
      },
    }),
    async (c) => {
      const body = ExplainRequest.parse((await c.req.json().catch(() => ({}))) ?? {});
      return c.json(svc(c).sim.explain(c.req.valid("param").id, body.question), 200);
    },
  );
  app.openapi(
    route("simulate", {
      method: "post",
      path: `${P}/insights/audit`,
      operationId: "auditPlan",
      tags: ["Insights"],
      summary:
        "Assumption audit: double-counted housing, real/nominal mix-ups, implausible returns, missing flows...",
      request: { params: IdParam },
      responses: {
        200: json(
          z.object({
            planId: z.string(),
            planVersion: z.number().int(),
            findings: z.array(Finding),
            counts: z.record(z.string(), z.number()),
          }),
          "Findings",
        ),
      },
    }),
    (c) => c.json(svc(c).sim.audit(c.req.valid("param").id), 200),
  );
  app.openapi(
    route("simulate", {
      method: "post",
      path: `${P}/insights/sensitivity`,
      operationId: "sensitivityAnalysis",
      tags: ["Insights"],
      summary:
        "Tornado data: how much returns, inflation, spending, income, retirement date and life expectancy move the outcome",
      description:
        "Deterministic metrics return 200 immediately. `metric=successRate` runs Monte Carlo and returns a 202 Job like the other async endpoints (supports `?wait=`).",
      request: {
        params: IdParam,
        query: WaitQuery,
        body: { content: { "application/json": { schema: SensitivityRequest } }, required: false },
      },
      responses: {
        200: json(
          z.record(z.string(), z.unknown()),
          "Bars sorted by swing, largest first (or a finished Job)",
        ),
        202: json(JobSchema, "Accepted (successRate)"),
      },
    }),
    async (c) => {
      const body = SensitivityRequest.parse((await c.req.json().catch(() => ({}))) ?? {});
      const id = c.req.valid("param").id;
      if (body.metric === "successRate")
        return launch(
          c as never,
          svc(c).sim.startSensitivity(id, body, actorOf(c)),
          c.req.valid("query").wait,
        ) as never;
      return c.json((await svc(c).sim.sensitivity(id, body)) as never, 200);
    },
  );
  app.openapi(
    route("simulate", {
      method: "post",
      path: `${P}/insights/explain-year`,
      operationId: "explainYear",
      tags: ["Insights"],
      summary:
        "Where did the money go in one year? Narrative from the ledger: income, outflows, withdrawals, saving",
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ExplainYearRequest } }, required: true },
      },
      responses: { 200: json(z.record(z.string(), z.unknown()), "Year narrative") },
    }),
    (c) => {
      const b = c.req.valid("json");
      const n = svc(c).sim.explainYear(c.req.valid("param").id, b);
      return c.json(
        {
          planId: n.planId,
          planVersion: n.planVersion,
          ...compactYearNarrative(n, b.detail),
        } as never,
        200,
      );
    },
  );
  app.openapi(
    route("simulate", {
      method: "post",
      path: `${P}/insights/explain-years`,
      operationId: "explainYears",
      tags: ["Insights"],
      summary: "Year-by-year narratives for a range of years (every Nth)",
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ExplainYearsRequest } }, required: false },
      },
      responses: { 200: json(z.record(z.string(), z.unknown()), "Year narratives") },
    }),
    async (c) => {
      const b = ExplainYearsRequest.parse((await c.req.json().catch(() => ({}))) ?? {});
      const out = svc(c).sim.explainYears(c.req.valid("param").id, b);
      return c.json(
        {
          planId: out.planId,
          planVersion: out.planVersion,
          years: out.years.map((y) => compactYearNarrative(y, b.detail)),
        } as never,
        200,
      );
    },
  );
  app.openapi(
    route("simulate", {
      method: "post",
      path: `${P}/insights/explain-difference`,
      operationId: "explainDifference",
      tags: ["Insights"],
      summary:
        "Why do two plans end differently? Diff, explanation and (optionally) which edit caused how much",
      description:
        "The plan in the path is the baseline. With `attribute` the difference is split across individual edits by replaying each one alone. " +
        "`metric=successRate` uses Monte Carlo and returns a 202 Job like the other async endpoints (supports `?wait=`).",
      request: {
        params: IdParam,
        query: WaitQuery,
        body: {
          content: { "application/json": { schema: ExplainDifferenceRequest } },
          required: true,
        },
      },
      responses: {
        200: json(z.record(z.string(), z.unknown()), "Explanation (or a finished Job)"),
        202: json(JobSchema, "Accepted (successRate attribution)"),
      },
    }),
    async (c) => {
      const b = c.req.valid("json");
      const id = c.req.valid("param").id;
      if (b.attribute && b.metric === "successRate")
        return launch(
          c as never,
          svc(c).sim.startAttribution(
            id,
            b.otherPlanId,
            { metric: "successRate", monteCarlo: b.monteCarlo },
            actorOf(c),
          ),
          c.req.valid("query").wait,
        ) as never;
      const metric = b.metric === "successRate" ? "endNetWorthReal" : b.metric;
      const out = await svc(c).sim.explainDifference(id, b.otherPlanId, {
        attribute: b.attribute,
        metric,
      });
      return c.json(
        {
          ...out,
          ...(out.attribution
            ? { attribution: compactAttribution(out.attribution, b.detail) }
            : {}),
        } as never,
        200,
      );
    },
  );
  app.openapi(
    route("simulate", {
      method: "post",
      path: `${P}/insights/guyton-klinger`,
      operationId: "guytonKlingerGuardrails",
      tags: ["Insights"],
      summary: "Guyton-Klinger guardrails in money terms: when to cut or raise spending (instant)",
      description:
        "Defaults come from the plan: the investable portfolio and spending of the first projected year (today's money). For risk-based guardrails (success-rate bands) use `insights/guardrails`.",
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: GuytonKlingerRequest } },
          required: false,
        },
      },
      responses: { 200: json(z.record(z.string(), z.unknown()), "Thresholds and action") },
    }),
    async (c) => {
      const b = GuytonKlingerRequest.parse((await c.req.json().catch(() => ({}))) ?? {});
      return c.json(svc(c).sim.guytonKlinger(c.req.valid("param").id, b) as never, 200);
    },
  );

  // ----------------------------------------------------------------------------- what-if scenarios
  const TemplateParams = IdParam.extend({ templateId: pathId("templateId") });
  app.openapi(
    route("simulate", {
      method: "get",
      path: "/api/v1/scenarios/templates",
      operationId: "listScenarioTemplates",
      tags: ["Scenarios"],
      summary:
        "What-if templates (market crash, job loss, retire earlier, survivor...) and their parameters",
      responses: {
        200: json(z.object({ items: z.array(z.record(z.string(), z.unknown())) }), "Templates"),
      },
    }),
    (c) => c.json({ items: svc(c).scenarios.list() } as never, 200),
  );
  app.openapi(
    route("simulate", {
      method: "post",
      path: `${P}/scenarios/{templateId}/preview`,
      operationId: "previewScenario",
      tags: ["Scenarios"],
      summary:
        "What would this template do to the plan? Ops, readable changes and before/after outcome. Stores nothing",
      request: {
        params: TemplateParams,
        body: { content: { "application/json": { schema: ScenarioRequest } }, required: false },
      },
      responses: { 200: json(z.record(z.string(), z.unknown()), "Preview") },
    }),
    async (c) => {
      const b = ScenarioRequest.parse((await c.req.json().catch(() => ({}))) ?? {});
      const p = c.req.valid("param");
      return c.json(svc(c).scenarios.preview(p.id, p.templateId, b.params) as never, 200);
    },
  );
  app.openapi(
    route("write", {
      method: "post",
      path: `${P}/scenarios/{templateId}/branch`,
      operationId: "createScenarioBranch",
      tags: ["Scenarios"],
      summary: "Instantiate a what-if template as a BRANCH of the plan (the parent is untouched)",
      request: {
        params: TemplateParams,
        body: {
          content: { "application/json": { schema: ScenarioBranchRequest } },
          required: false,
        },
      },
      responses: { 201: json(Plan, "The new branch plan") },
    }),
    async (c) => {
      const b = ScenarioBranchRequest.parse((await c.req.json().catch(() => ({}))) ?? {});
      const p = c.req.valid("param");
      const out = svc(c).scenarios.createBranch(p.id, p.templateId, b.params, b, actorOf(c));
      c.header("ETag", `"${out.branch.version}"`);
      return c.json(out.branch, 201);
    },
  );
  const Figure = z.object({
    id: z.string(),
    display: z.string().describe("Exactly as written in the sentences."),
    value: z.number().describe("Unrounded, from the source."),
    kind: z.enum(["money", "percent", "year", "age", "count"]),
    source: z.string().describe("The engine result field it was read from."),
  });
  const PartnerSummarySchema = z
    .object({
      planId: z.string(),
      planVersion: z.number().int(),
      planName: z.string(),
      currency: z.string(),
      locale: z.string(),
      people: z.array(z.object({ id: z.string(), name: z.string() })),
      headline: z.string(),
      stopWork: z.object({
        text: z.string(),
        year: z.number().int().nullable(),
        month: z.string().nullable(),
        ages: z.array(z.object({ personId: z.string(), name: z.string(), age: z.number() })),
      }),
      spending: z.object({
        text: z.string(),
        yearly: z.number().nullable().describe("Today's money."),
        year: z.number().int().nullable(),
        allFunded: z.boolean(),
        firstShortfallYear: z.number().int().nullable(),
      }),
      confidence: z.object({
        text: z.string(),
        level: z.enum(["high", "good", "uncertain", "low", "unknown"]),
        successRate: z.number().nullable(),
        trials: z.number().int().nullable(),
      }),
      survivor: z.object({
        text: z.string(),
        applicable: z.boolean(),
        cases: z.array(
          z.object({
            personId: z.string(),
            name: z.string(),
            survivorId: z.string(),
            survivorName: z.string(),
            age: z.number(),
            success: z.boolean(),
            firstShortfallYear: z.number().int().nullable(),
          }),
        ),
      }),
      risks: z.array(z.object({ id: z.string(), text: z.string(), source: z.string() })),
      assumptions: z.array(z.object({ label: z.string(), value: z.string(), source: z.string() })),
      figures: z.array(Figure),
      caveats: z.array(z.string()),
    })
    .meta({ id: "PartnerSummary" });
  app.openapi(
    route("read", {
      method: "get",
      path: `${P}/partner-summary`,
      operationId: "getPartnerSummary",
      tags: ["Insights"],
      summary: "One-page plain-words summary for a partner (engine results only)",
      description:
        "When you can stop working, what the plan spends, how confident it is, what happens to the survivor if either partner dies, the biggest risks and what was assumed. Every number in the sentences is listed in `figures` with the engine result it came from. The chance of success is the cached default `runMonteCarlo` result for this plan version; until one has run, `confidence.level` is `unknown` (run `POST /plans/{id}/monte-carlo` and fetch again). The landing page of a viewer in the web app. Stores nothing.",
      request: { params: IdParam },
      responses: { 200: json(PartnerSummarySchema, "Summary") },
    }),
    (c) => c.json(svc(c).scenarios.partnerSummary(c.req.valid("param").id) as never, 200),
  );

  app.openapi(
    route("simulate", {
      method: "get",
      path: `${P}/scenarios/survivor`,
      operationId: "survivorScenarios",
      tags: ["Scenarios"],
      summary: "Survivor scenarios: what if one partner dies at 70 / 80 / 90? (couples only)",
      request: { params: IdParam, query: SurvivorQuery },
      responses: {
        200: json(
          z.record(z.string(), z.unknown()),
          "Scenarios (with outcomes when evaluate=true)",
        ),
      },
    }),
    (c) => {
      const q = c.req.valid("query");
      return c.json(
        svc(c).scenarios.survivors(c.req.valid("param").id, {
          ages: q.ages?.split(",").map(Number),
          evaluate: q.evaluate,
        }) as never,
        200,
      );
    },
  );

  app.openapi(
    route("simulate", {
      method: "get",
      path: `${P}/tax-breakdown`,
      operationId: "taxBreakdown",
      tags: ["Insights"],
      summary: "Tax breakdown per year, by jurisdiction and kind (effective/marginal rates)",
      request: { params: IdParam, query: TaxQuery },
      responses: { 200: json(z.record(z.string(), z.unknown()), "Tax breakdown") },
    }),
    (c) =>
      c.json(svc(c).sim.taxBreakdown(c.req.valid("param").id, c.req.valid("query")) as never, 200),
  );
  app.openapi(
    route("simulate", {
      method: "post",
      path: "/api/v1/insights/compare",
      operationId: "comparePlans",
      tags: ["Insights"],
      summary:
        "Compare plans: outcomes side by side, plus a diff and explanation against the first plan",
      request: {
        body: { content: { "application/json": { schema: CompareRequest } }, required: true },
      },
      responses: { 200: json(z.record(z.string(), z.unknown()), "Comparison") },
    }),
    (c) => {
      const b = c.req.valid("json");
      return c.json(svc(c).sim.compare(b.planIds, b.explain) as never, 200);
    },
  );
}
