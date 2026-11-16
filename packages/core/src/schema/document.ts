/**
 * The GlideworthDocument is the full portable unit: backup, export, import target and the shape the
 * web app loads. `schemaVersion` gates migrations; every persisted JSON blob (DB rows, exports)
 * is migrated through `migrateDocument` / `migratePlan` before parsing.
 */
import { z } from "zod";
import { ValidationError } from "../errors.js";
import { Household } from "./household.js";
import { CurrentFinances, Plan } from "./plan.js";
import { Timestamp } from "./primitives.js";
import { ProgressSnapshot, UserSettings } from "./progress-settings.js";

/** Bump when a breaking schema change ships, and add a migration below. */
export const SCHEMA_VERSION = 1 as const;

/** The `app` marker every document is written with. */
export const DOCUMENT_APP = "glideworth" as const;
/** The marker of documents and exports written before the rename to Glideworth: still read, never written. */
export const LEGACY_DOCUMENT_APP = "cairn" as const;

export const GlideworthDocument = z
  .object({
    app: z.enum([DOCUMENT_APP, LEGACY_DOCUMENT_APP]),
    schemaVersion: z.literal(SCHEMA_VERSION),
    exportedAt: Timestamp.optional(),
    household: Household,
    finances: CurrentFinances,
    plans: z.array(Plan).default([]),
    progress: z.array(ProgressSnapshot).default([]),
    settings: UserSettings.default(UserSettings.parse({})),
  })
  .meta({ id: "GlideworthDocument" });
export type GlideworthDocument = z.infer<typeof GlideworthDocument>;
export type GlideworthDocumentInput = z.input<typeof GlideworthDocument>;

/** A migration takes a raw document at version `from` and returns raw JSON at `from + 1`. */
export type Migration = {
  from: number;
  describe: string;
  up: (raw: Record<string, unknown>) => Record<string, unknown>;
};

/**
 * Registered migrations, in order. Example for a future v2:
 *   { from: 1, describe: 'rename Plan.flows[].mandatory -> alwaysFund', up: (raw) => ({ ...raw, schemaVersion: 2 }) }
 */
export const MIGRATIONS: Migration[] = [];

/** Bring raw JSON at `version` up to SCHEMA_VERSION by running the registered migrations. */
function upgrade(raw: Record<string, unknown>, version: number): Record<string, unknown> {
  let doc = raw;
  let v = version;
  if (v > SCHEMA_VERSION)
    throw new ValidationError(
      `document schemaVersion ${v} is newer than supported ${SCHEMA_VERSION}`,
    );
  while (v < SCHEMA_VERSION) {
    const m = MIGRATIONS.find((x) => x.from === v);
    if (!m) throw new ValidationError(`no migration from schemaVersion ${v}`);
    doc = m.up(doc);
    v += 1;
    doc.schemaVersion = v;
  }
  return doc;
}

/**
 * Migrate a single persisted plan body (DB `plans.body`, change-set previews) stored at
 * `schemaVersion` (default: current) and validate it. Plans are migrated by wrapping them in a
 * minimal document so one MIGRATIONS list serves documents and plans alike.
 */
export function migratePlan(raw: unknown, schemaVersion: number = SCHEMA_VERSION): Plan {
  if (!raw || typeof raw !== "object") throw new ValidationError("plan must be an object");
  const wrapped = upgrade({ app: DOCUMENT_APP, schemaVersion, plans: [raw] }, schemaVersion);
  const plans = wrapped.plans;
  const body = Array.isArray(plans) ? plans[0] : undefined;
  const parsed = Plan.safeParse(body);
  if (!parsed.success) throw new ValidationError("invalid plan", { issues: parsed.error.issues });
  return parsed.data;
}

/** Migration hook: brings any older raw document to SCHEMA_VERSION, then validates. */
export function migrateDocument(raw: unknown): GlideworthDocument {
  if (!raw || typeof raw !== "object") throw new ValidationError("document must be an object");
  const r = raw as Record<string, unknown>;
  const doc = upgrade(r, typeof r.schemaVersion === "number" ? r.schemaVersion : 0);
  const parsed = GlideworthDocument.safeParse(doc);
  if (!parsed.success)
    throw new ValidationError("invalid document", { issues: parsed.error.issues });
  return { ...parsed.data, app: DOCUMENT_APP };
}
