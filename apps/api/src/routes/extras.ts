/** FX rates and the income-by-tax-rate matrix. */
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
}
