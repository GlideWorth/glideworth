import { ENGINE_VERSION } from "@glideworth/core";
import { and, asc, eq, sql } from "drizzle-orm";
import { simulationRuns } from "../db/schema.js";
import { newId } from "../util.js";
import type { ServiceCtx } from "./context.js";

export type CacheKind = "deterministic" | "monte-carlo" | "historical" | "solver";

const MAX_ROWS = 200;
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Result cache in `simulation_runs`, keyed by plan id + plan version + kind + hash(options,
 * household version) + engine version. Any plan write bumps the version, so entries never go stale;
 * old ones are evicted oldest-first.
 */
export class ResultCache {
  constructor(private readonly ctx: ServiceCtx) {}

  get(
    planId: string,
    planVersion: number,
    kind: CacheKind,
    inputHash: string,
  ): unknown | undefined {
    const row = this.ctx.db
      .select({ result: simulationRuns.result })
      .from(simulationRuns)
      .where(
        and(
          eq(simulationRuns.planId, planId),
          eq(simulationRuns.planVersion, planVersion),
          eq(simulationRuns.kind, kind),
          eq(simulationRuns.inputHash, inputHash),
          eq(simulationRuns.engineVersion, ENGINE_VERSION),
        ),
      )
      .get();
    return row?.result ?? undefined;
  }

  put(
    planId: string,
    planVersion: number,
    kind: CacheKind,
    inputHash: string,
    result: unknown,
  ): void {
    const json = JSON.stringify(result);
    if (json.length > MAX_BYTES) return;
    this.ctx.db
      .insert(simulationRuns)
      .values({
        id: newId("run"),
        planId,
        planVersion,
        kind,
        inputHash,
        engineVersion: ENGINE_VERSION,
        result: result as never,
      })
      .run();
    const count =
      this.ctx.db
        .select({ n: sql<number>`count(*)` })
        .from(simulationRuns)
        .get()?.n ?? 0;
    if (count > MAX_ROWS) {
      const old = this.ctx.db
        .select({ id: simulationRuns.id })
        .from(simulationRuns)
        .orderBy(asc(simulationRuns.createdAt))
        .limit(count - MAX_ROWS)
        .all();
      for (const o of old)
        this.ctx.db.delete(simulationRuns).where(eq(simulationRuns.id, o.id)).run();
    }
  }
}
