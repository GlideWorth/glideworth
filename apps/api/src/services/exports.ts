/**
 * Data exports built by @glideworth/importers: CSV/JSON tables of a projection or of progress history,
 * and the printable report as plain data (the web app renders it).
 */
import type { ValueBasis } from "@glideworth/core";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { ServiceCtx } from "./context.js";
import type { HouseholdsService } from "./households.js";
import type { PlansService } from "./plans.js";
import type { SimulationService } from "./simulation.js";

export const TABLE_IDS = ["year-by-year", "cash-flow", "taxes", "account-balances"] as const;
export type TableId = (typeof TABLE_IDS)[number];

export const ExportQuery = z.object({
  basis: z.enum(["real", "nominal"]).default("real").describe("'real' = today's money (default)."),
  format: z.enum(["json", "csv"]).default("json"),
});
export const ReportQuery = z.object({
  basis: z.enum(["real", "nominal"]).default("real"),
  tableEvery: z.coerce
    .number()
    .int()
    .min(1)
    .max(25)
    .default(5)
    .describe("Table row spacing in years."),
  title: z.string().max(200).optional(),
});

export class ExportsService {
  constructor(
    private readonly ctx: ServiceCtx,
    private readonly households: HouseholdsService,
    private readonly plans: PlansService,
    private readonly sim: SimulationService,
  ) {}

  private labels(householdId: string): Record<string, string> {
    const doc = this.households.get(householdId);
    return Object.fromEntries([
      ...doc.household.people.map((p) => [p.id, p.name]),
      ...doc.finances.accounts.map((a) => [a.id, a.name]),
    ]);
  }

  /** A projection table as data or CSV text. */
  projectionTable(planId: string, table: string, basis: ValueBasis, format: "json" | "csv") {
    if (!(TABLE_IDS as readonly string[]).includes(table))
      throw new ApiError(404, "NOT_FOUND", `unknown table '${table}'`, { known: TABLE_IDS });
    const plan = this.plans.get(planId);
    const { result } = this.sim.projection(planId, { trace: "off" });
    const build = this.ctx.imports.tableBuilders[table as TableId];
    const t = build(result, { basis, labels: this.labels(plan.householdId) });
    return format === "csv"
      ? { csv: this.ctx.imports.tableToCsv(t), filename: `${planId}-${table}.csv` }
      : { table: t };
  }

  /** Progress snapshots as a table (values as recorded). */
  progressTable(householdId: string, format: "json" | "csv") {
    const doc = this.households.getDocument(householdId);
    const t = this.ctx.imports.progressTable(doc);
    return format === "csv"
      ? { csv: this.ctx.imports.tableToCsv(t), filename: `${householdId}-progress.csv` }
      : { table: t };
  }

  /** Printable report as plain data for one plan. */
  report(planId: string, o: { basis: ValueBasis; tableEvery: number; title?: string | undefined }) {
    const plan = this.plans.get(planId);
    const doc = this.households.getDocument(plan.householdId);
    const { result } = this.sim.projection(planId, { trace: "off" });
    return this.ctx.imports.buildReportData(doc, planId, result, {
      basis: o.basis,
      tableEvery: o.tableEvery,
      ...(o.title ? { title: o.title } : {}),
    });
  }
}
