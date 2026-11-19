/**
 * Cross-border routes for items held in another country than the one the household lives in: which
 * items, "how is this taxed and why", tax by country and basis, and the read-only rule tables.
 */
import { INCOME_CATEGORIES } from "@glideworth/core";
import { z } from "@hono/zod-openapi";
import { IdParam, json, type RouteCtx, route } from "./helpers.js";

const Obj = z.record(z.string(), z.unknown());
const CountryParam = (name: string) =>
  z
    .string()
    .regex(/^[A-Za-z]{2}$/, "a two-letter ISO country code")
    .openapi({ param: { name, in: "path" } });

const ExplainTaxationRequest = z
  .object({
    itemId: z.string().min(1).max(64).describe("An account, real asset, debt or income id."),
    year: z.number().int().optional().describe("Projection year (default: the first full year)."),
  })
  .meta({ id: "ExplainTaxationRequest" });

const ExplainRuleRequest = z
  .object({
    residence: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .describe("Country of residence (ISO alpha-2)."),
    source: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .describe("Country the income comes from or the asset is in."),
    category: z.enum(INCOME_CATEGORIES),
    nationalOfResidence: z.boolean().optional(),
    accountType: z
      .string()
      .max(40)
      .optional()
      .describe("An account type, to include wrapper recognition."),
  })
  .meta({ id: "ExplainRuleRequest" });

const TaxByCountryQuery = z.object({
  basis: z.enum(["real", "nominal"]).default("real"),
  fromYear: z.coerce.number().int().optional(),
  toYear: z.coerce.number().int().optional(),
});

export function crossBorderRoutes({ app, svc }: RouteCtx) {
  const P = "/api/v1/plans/{id}";
  const X = "/api/v1/cross-border";

  // ----------------------------------------------------------------------------- plan
  app.openapi(
    route("read", {
      method: "get",
      path: `${P}/cross-border/items`,
      operationId: "listCrossBorderItems",
      tags: ["Insights"],
      summary:
        "Accounts, real assets and income held in another country than the one the household lives in",
      request: { params: IdParam },
      responses: { 200: json(Obj, "Items") },
    }),
    (c) => c.json(svc(c).crossBorder.items(c.req.valid("param").id) as never, 200),
  );
  app.openapi(
    route("simulate", {
      method: "post",
      path: `${P}/insights/explain-taxation`,
      operationId: "explainItemTaxation",
      tags: ["Insights"],
      summary: "How one account, asset, debt or income is taxed in a year, and why",
      description:
        "The item's country, the country the household lives in, and per income category the non-resident rule, the treaty article, how the residence country sees a foreign wrapper and the relief. Unknown treaty pairs and unrecognised wrappers are warnings.",
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: ExplainTaxationRequest } },
          required: true,
        },
      },
      responses: { 200: json(Obj, "Explanation") },
    }),
    (c) => {
      const b = c.req.valid("json");
      return c.json(
        svc(c).crossBorder.explainItem(c.req.valid("param").id, b.itemId, b.year) as never,
        200,
      );
    },
  );
  app.openapi(
    route("simulate", {
      method: "get",
      path: `${P}/tax-breakdown/by-country`,
      operationId: "taxBreakdownByCountry",
      tags: ["Insights"],
      summary:
        "Tax by country and basis (residence, source, citizenship, relief), lifetime and per year",
      description:
        "Source rows are tax a country charges as a non-resident on accounts, property or income held there; relief rows are negative: they are the credit the household's country gives for tax paid elsewhere, so the sum per year is what is actually paid. Plans with nothing abroad report everything as residence tax of the household country (`crossBorder: false`).",
      request: { params: IdParam, query: TaxByCountryQuery },
      responses: { 200: json(Obj, "Tax by country") },
    }),
    (c) =>
      c.json(
        svc(c).crossBorder.taxByCountry(c.req.valid("param").id, c.req.valid("query")) as never,
        200,
      ),
  );

  // ----------------------------------------------------------------------------- rule tables
  app.openapi(
    route("read", {
      method: "get",
      path: `${X}/countries`,
      operationId: "listCrossBorderCountries",
      tags: ["Cross-border rules"],
      summary:
        "Countries with cross-border data: tax currency, non-resident rule depth, treaties, currency pegs",
      responses: { 200: json(z.object({ items: z.array(Obj) }), "Countries") },
    }),
    (c) => c.json({ items: svc(c).crossBorder.countries() } as never, 200),
  );
  app.openapi(
    route("read", {
      method: "get",
      path: `${X}/non-resident-rules/{country}`,
      operationId: "getNonResidentRules",
      tags: ["Cross-border rules"],
      summary:
        "How a country taxes non-residents, per income category, with its wrappers and sources",
      request: { params: z.object({ country: CountryParam("country") }) },
      responses: { 200: json(Obj, "Rules") },
    }),
    (c) => c.json(svc(c).crossBorder.nonResidentRules(c.req.valid("param").country) as never, 200),
  );
  app.openapi(
    route("read", {
      method: "get",
      path: `${X}/treaties`,
      operationId: "listTreaties",
      tags: ["Cross-border rules"],
      summary: "Treaties in the tables (optionally those of one country)",
      request: {
        query: z.object({
          country: z
            .string()
            .regex(/^[A-Za-z]{2}$/)
            .optional(),
        }),
      },
      responses: { 200: json(z.object({ items: z.array(Obj) }), "Treaties") },
    }),
    (c) =>
      c.json({ items: svc(c).crossBorder.treaties(c.req.valid("query").country) } as never, 200),
  );
  app.openapi(
    route("read", {
      method: "get",
      path: `${X}/treaties/{a}/{b}`,
      operationId: "getTreaty",
      tags: ["Cross-border rules"],
      summary:
        "The treaty between two countries (or the fallback), with the decision for every income category both ways",
      request: { params: z.object({ a: CountryParam("a"), b: CountryParam("b") }) },
      responses: { 200: json(Obj, "Treaty") },
    }),
    (c) => {
      const p = c.req.valid("param");
      return c.json(svc(c).crossBorder.treaty(p.a, p.b) as never, 200);
    },
  );
  app.openapi(
    route("read", {
      method: "get",
      path: `${X}/wrappers`,
      operationId: "getWrapperRecognition",
      tags: ["Cross-border rules"],
      summary: "How a residence country treats another country's tax-advantaged accounts",
      description:
        "With both `residence` and `accountCountry`, also lists every account type of that country with the view the engine uses, and what the account country does while the holder is non-resident.",
      request: {
        query: z.object({
          residence: z
            .string()
            .regex(/^[A-Za-z]{2}$/)
            .optional(),
          accountCountry: z
            .string()
            .regex(/^[A-Za-z]{2}$/)
            .optional(),
        }),
      },
      responses: { 200: json(Obj, "Wrapper recognition") },
    }),
    (c) => c.json(svc(c).crossBorder.wrappers(c.req.valid("query")) as never, 200),
  );
  app.openapi(
    route("read", {
      method: "post",
      path: `${X}/explain`,
      operationId: "explainCrossBorderRule",
      tags: ["Cross-border rules"],
      summary:
        "How income of one category from one country is taxed for a resident of another, and why (stateless)",
      request: {
        body: { content: { "application/json": { schema: ExplainRuleRequest } }, required: true },
      },
      responses: { 200: json(Obj, "Treatment") },
    }),
    (c) => c.json(svc(c).crossBorder.explainRule(c.req.valid("json")) as never, 200),
  );
  app.openapi(
    route("read", {
      method: "get",
      path: `${X}/simplifications`,
      operationId: "getCrossBorderSimplifications",
      tags: ["Cross-border rules"],
      summary: "Known simplifications of the cross-border model (general, then per country)",
      request: {
        query: z.object({
          countries: z
            .string()
            .max(200)
            .optional()
            .describe("Comma-separated ISO codes, e.g. GB,AE."),
        }),
      },
      responses: { 200: json(z.object({ items: z.array(z.string()) }), "Simplifications") },
    }),
    (c) => {
      const q = c.req.valid("query").countries;
      return c.json(
        svc(c).crossBorder.simplifications(q ? q.split(",").filter(Boolean) : []) as never,
        200,
      );
    },
  );
}
