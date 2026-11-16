/**
 * Read-time schema migration for stored plan bodies.
 *
 * Every stored plan (`plans.body`, `plan_versions.body`) goes through core's `migratePlan` together
 * with the `schema_version` column it was written with, before it is used. A future SCHEMA_VERSION
 * bump (plus a registered migration in @glideworth/core) therefore upgrades old rows lazily on read,
 * with no data migration to run. At today's version 1 it only validates.
 */
import { migratePlan, type Plan } from "@glideworth/core";

export function readPlanBody(raw: unknown, schemaVersion?: number): Plan {
  return migratePlan(raw, schemaVersion);
}
