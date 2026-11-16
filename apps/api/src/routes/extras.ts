/** FX rates, debt payoff strategies, income-by-tax-rate matrix and 72(t) SEPP comparison. */
import { FxRate } from "@glideworth/core";
import { z } from "@hono/zod-openapi";
import { parseIfMatch } from "../middleware.js";
import { actorOf, IdParam, IfMatch, json, pathId, type RouteCtx, route } from "./helpers.js";

const Any = (id: string) => z.record(z.string(), z.unknown()).meta({ id });
const FxList = z
  .object({ baseCurrency: z.string(), items: z.array(FxRate) })
  .meta({ id: "FxRates" });
const PairParams = IdParam.extend({ pair: pathId("pair").describe("`FROM-TO`, e.g. `GBP-USD`.") });

export function extraRoutes({ app, svc }: RouteCtx) {
  const H = "/api/v1/households/{id}/fx-rates";

  // ----------------------------------------------------------------------------- FX rates
  app.openapi(
    route("read", {
      method: "get",
      path: H,
      operationId: "listFxRates",
      tags: ["FX rates"],
      summary:
        "FX rates of a household: foreign currency -> base currency (as of the finances date)",
      description:
        "Accounts, real assets, debts and events may carry a `currency` other than the household’s. Each foreign currency needs a pair (either direction) here; `annualDrift` moves the rate over the plan (what-if: “sterling falls 2% a year”). Plans can override pairs in `assumptions.fxRates`.",
      request: { params: IdParam },
      responses: { 200: json(FxList, "Rates") },
    }),
    (c) => c.json(svc(c).households.listFx(c.req.valid("param").id), 200),
  );
  app.openapi(
    route("write", {
      method: "put",
      path: H,
      operationId: "replaceFxRates",
      tags: ["FX rates"],
      summary: "Replace all FX rates",
      request: {
        params: IdParam,
        headers: IfMatch,
        body: {
          content: {
            "application/json": { schema: z.object({ items: z.array(FxRate).max(100) }) },
          },
          required: true,
        },
      },
      responses: {
        200: json(z.object({ items: z.array(FxRate), version: z.number().int() }), "Replaced"),
      },
    }),
    (c) => {
      const out = svc(c).households.replaceFx(
        c.req.valid("param").id,
        c.req.valid("json").items,
        parseIfMatch(c),
        actorOf(c),
      );
      c.header("ETag", `"${out.version}"`);
      return c.json(out, 200);
    },
  );
  app.openapi(
    route("write", {
      method: "post",
      path: H,
      operationId: "setFxRate",
      tags: ["FX rates"],
      summary: "Add or update one pair (upsert by from/to)",
      request: {
        params: IdParam,
        headers: IfMatch,
        body: {
          content: {
            "application/json": {
              schema: FxRate.meta({
                examples: [{ from: "GBP", to: "USD", rate: 1.27, annualDrift: 0 }],
              }),
            },
          },
          required: true,
        },
      },
      responses: { 200: json(z.object({ rate: FxRate, version: z.number().int() }), "Saved") },
    }),
    (c) => {
      const out = svc(c).households.upsertFx(
        c.req.valid("param").id,
        c.req.valid("json"),
        parseIfMatch(c),
        actorOf(c),
      );
      c.header("ETag", `"${out.version}"`);
      return c.json(out, 200);
    },
  );
  app.openapi(
    route("write", {
      method: "delete",
      path: `${H}/{pair}`,
      operationId: "deleteFxRate",
      tags: ["FX rates"],
      summary: "Remove one pair",
      request: { params: PairParams, headers: IfMatch },
      responses: { 204: { description: "Removed" } },
    }),
    (c) => {
      const p = c.req.valid("param");
      const [from, to] = p.pair.toUpperCase().split("-");
      const v = svc(c).households.deleteFx(p.id, from ?? "", to ?? "", parseIfMatch(c), actorOf(c));
      c.header("ETag", `"${v}"`);
      return c.body(null, 204);
    },
  );

  // ----------------------------------------------------------------------------- insights
  app.openapi(
    route("simulate", {
      method: "post",
      path: "/api/v1/plans/{id}/insights/debt-payoff",
      operationId: "compareDebtPayoff",
      tags: ["Insights"],
      summary: "Debt payoff strategies: minimum payments vs avalanche vs snowball",
      description:
        "Runs the plan three ways with the same extra budget: minimum payments only, avalanche (highest rate first) and snowball (smallest balance first). Reports interest paid and saved, the debt-free date and when each debt is cleared. Give an existing `debtPaydown` flow (`flowId`, its budget is reallocated) or an `extraPerMonth` amount.",
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  flowId: z
                    .string()
                    .optional()
                    .describe("A debtPaydown flow whose budget each strategy reallocates."),
                  extraPerMonth: z
                    .number()
                    .positive()
                    .optional()
                    .describe("Otherwise: extra monthly payment (nominal)."),
                  targetIds: z
                    .array(z.string())
                    .max(50)
                    .optional()
                    .describe("Debts / financed assets in scope (default all)."),
                  rollover: z
                    .boolean()
                    .optional()
                    .describe("Snowball rollover of freed payments (default true)."),
                })
                .meta({ id: "DebtPayoffRequest", examples: [{ extraPerMonth: 500 }] }),
            },
          },
          required: true,
        },
      },
      responses: { 200: json(Any("DebtPayoffComparison"), "Comparison") },
    }),
    async (c) =>
      c.json(
        (await svc(c).sim.debtPayoff(c.req.valid("param").id, c.req.valid("json"))) as never,
        200,
      ),
  );

  app.openapi(
    route("simulate", {
      method: "post",
      path: "/api/v1/plans/{id}/insights/income-by-tax-rate",
      operationId: "incomeByTaxRate",
      tags: ["Insights"],
      summary:
        "Income by tax rate: how much income falls in each marginal-rate band, per year (a heatmap)",
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  jurisdictionId: z
                    .string()
                    .optional()
                    .describe("Default: the first jurisdiction with brackets (national)."),
                  basis: z.enum(["real", "nominal"]).default("real"),
                  schedules: z
                    .array(z.string())
                    .optional()
                    .describe("Limit to schedules, e.g. non-savings, savings, dividends."),
                })
                .meta({ id: "IncomeByTaxRateRequest" }),
            },
          },
          required: false,
        },
      },
      responses: { 200: json(Any("IncomeByTaxRateMatrix"), "Matrix") },
    }),
    async (c) => {
      const body = z
        .object({
          jurisdictionId: z.string().optional(),
          basis: z.enum(["real", "nominal"]).default("real"),
          schedules: z.array(z.string()).optional(),
        })
        .parse((await c.req.json().catch(() => ({}))) ?? {});
      return c.json(svc(c).sim.incomeByTaxRate(c.req.valid("param").id, body) as never, 200);
    },
  );

  app.openapi(
    route("simulate", {
      method: "post",
      path: "/api/v1/insights/sepp-comparison",
      operationId: "compareSepp",
      tags: ["Insights"],
      summary: "72(t) SEPP methods side by side (RMD, fixed amortisation, fixed annuitisation)",
      description:
        "Stateless: give `balance` and `startAge`, or `householdId` + `accountId` to take them from an account and its owner. Shows the first-year payment, the total withdrawn and the balance left for each method.",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  balance: z.number().positive().optional(),
                  startAge: z.number().min(18).max(100).optional(),
                  interestRate: z.number().min(0).max(0.2).optional().describe("Default 5%."),
                  growthRate: z.number().min(-0.5).max(0.5).optional().describe("Default 5%."),
                  householdId: z.string().optional(),
                  accountId: z.string().optional(),
                })
                .meta({
                  id: "SeppComparisonRequest",
                  examples: [{ balance: 800000, startAge: 52 }],
                }),
            },
          },
          required: true,
        },
      },
      responses: { 200: json(Any("SeppComparison"), "Comparison") },
    }),
    (c) => c.json(svc(c).sim.seppComparison(c.req.valid("json")) as never, 200),
  );
}
