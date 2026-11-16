import { z } from "@hono/zod-openapi";
import { ExportQuery, ReportQuery, TABLE_IDS } from "../services/exports.js";
import { IdParam, json, pathId, type RouteCtx, route } from "./helpers.js";

const csv = (description: string) => ({
  200: {
    description,
    content: {
      "text/csv": { schema: z.string() },
      "application/json": { schema: z.record(z.string(), z.unknown()) },
    },
  },
});

/** Table / report exports built by @glideworth/importers. */
export function exportRoutes({ app, svc }: RouteCtx) {
  app.openapi(
    route("read", {
      method: "get",
      path: "/api/v1/plans/{id}/export/tables/{table}",
      operationId: "exportProjectionTable",
      tags: ["Data"],
      summary: `A projection table as JSON or CSV (${TABLE_IDS.join(", ")})`,
      description:
        "`format=csv` returns text/csv (a download). Money is in the requested basis (default real = today's money), rounded to 2 dp; rates to 4 dp.",
      request: {
        params: IdParam.extend({ table: pathId("table") }),
        query: ExportQuery,
      },
      responses: csv("Table"),
    }),
    (c) => {
      const p = c.req.valid("param");
      const q = c.req.valid("query");
      const out = svc(c).exports.projectionTable(p.id, p.table, q.basis, q.format);
      if (out.csv !== undefined)
        return c.body(out.csv, 200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${out.filename}"`,
        }) as never;
      return c.json(out.table as never, 200);
    },
  );

  app.openapi(
    route("read", {
      method: "get",
      path: "/api/v1/households/{id}/export/progress",
      operationId: "exportProgressTable",
      tags: ["Data"],
      summary: "Progress history (net worth, assets, liabilities, categories) as JSON or CSV",
      request: { params: IdParam, query: ExportQuery.pick({ format: true }) },
      responses: csv("Progress table"),
    }),
    (c) => {
      const out = svc(c).exports.progressTable(
        c.req.valid("param").id,
        c.req.valid("query").format,
      );
      if (out.csv !== undefined)
        return c.body(out.csv, 200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${out.filename}"`,
        }) as never;
      return c.json(out.table as never, 200);
    },
  );

  app.openapi(
    route("read", {
      method: "get",
      path: "/api/v1/plans/{id}/report",
      operationId: "planReportData",
      tags: ["Data"],
      summary:
        "Printable report as plain data: key figures, milestones, series, year table, finances, assumptions, caveats",
      description: "The web app renders this (HTML / print CSS); nothing in it is layout.",
      request: { params: IdParam, query: ReportQuery },
      responses: { 200: json(z.record(z.string(), z.unknown()), "Report data") },
    }),
    (c) =>
      c.json(svc(c).exports.report(c.req.valid("param").id, c.req.valid("query")) as never, 200),
  );
}
