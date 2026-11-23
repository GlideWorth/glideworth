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
export const SCHEMA_VERSION = 3 as const;

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
 * Registered migrations, in order. Each `up` returns raw JSON at the next version (`upgrade` sets
 * `schemaVersion`).
 */
export const MIGRATIONS: Migration[] = [
  {
    from: 1,
    describe:
      "remove moving country: Plan.residency, relocate milestone effects, departure-tax / UK temporary non-residence / State Pension freeze switches, Person.residenceHistory and statePensionRecords",
    up: (raw) => {
      const doc = { ...raw };
      if (Array.isArray(doc.plans)) doc.plans = doc.plans.map(dropMovesFromPlan);
      const household = record(doc.household);
      if (household && Array.isArray(household.people))
        doc.household = {
          ...household,
          people: household.people.map((p) => {
            const person = record(p);
            if (!person) return p;
            const { residenceHistory: _h, statePensionRecords: _r, ...rest } = person;
            return rest;
          }),
        };
      return doc;
    },
  },
  {
    from: 2,
    describe:
      "employer match as ordered tiers: { matchShare, upToShareOfPay } becomes tiers: [{ matchRate, bandShareOfPay }] (one tier, same result), in plans and branch patches",
    up: (raw) => {
      const doc = { ...raw };
      if (Array.isArray(doc.plans)) doc.plans = doc.plans.map(tierEmployerMatchInPlan);
      return doc;
    },
  },
];

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const REMOVED_CROSS_BORDER_KEYS = [
  "departureTax",
  "ukTemporaryNonResidence",
  "freezeStatePensionAbroad",
] as const;

const isRelocate = (v: unknown) => record(v)?.kind === "relocate";

/** Drop relocate effects from a milestone-shaped value (a milestone, an effect list). */
function dropRelocate(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => !isRelocate(x)).map(dropRelocate);
  const r = record(v);
  if (!r || !Array.isArray(r.effects)) return v;
  return { ...r, effects: r.effects.filter((e) => !isRelocate(e)) };
}

function dropMovesFromPlan(p: unknown): unknown {
  const plan = record(p);
  if (!plan) return p;
  const { residency: _residency, ...out } = plan;
  if (Array.isArray(out.milestones)) out.milestones = out.milestones.map(dropRelocate);
  const tax = record(out.tax);
  if (tax?.crossBorder) out.tax = { ...tax, crossBorder: dropCrossBorderKeys(tax.crossBorder) };
  const lineage = record(out.lineage);
  if (lineage && Array.isArray(lineage.patch))
    out.lineage = { ...lineage, patch: lineage.patch.filter(keepOp).map(cleanOp) };
  return out;
}

/** Branch patches: ops on removed fields go; values carrying relocate effects lose them. */
function keepOp(op: unknown): boolean {
  const o = record(op);
  const path = typeof o?.path === "string" ? o.path : "";
  if (path === "/residency" || path.startsWith("/residency/")) return false;
  if (REMOVED_CROSS_BORDER_KEYS.some((k) => path === `/tax/crossBorder/${k}`)) return false;
  return !isRelocate(o?.value);
}

function cleanOp(op: unknown): unknown {
  const o = record(op);
  if (!o || !("value" in o) || typeof o.path !== "string") return op;
  if (o.path.startsWith("/milestones")) return { ...o, value: dropRelocate(o.value) };
  if (o.path === "/tax/crossBorder") return { ...o, value: dropCrossBorderKeys(o.value) };
  if (o.path === "/tax") {
    const tax = record(o.value);
    if (tax?.crossBorder)
      return { ...o, value: { ...tax, crossBorder: dropCrossBorderKeys(tax.crossBorder) } };
  }
  return op;
}

function dropCrossBorderKeys(v: unknown): unknown {
  const cb = record(v);
  if (!cb) return v;
  const next = { ...cb };
  for (const k of REMOVED_CROSS_BORDER_KEYS) delete next[k];
  return next;
}

/** A v2 employer match (`matchShare` up to `upToShareOfPay` of pay) as a one-tier v3 match. */
function tierEmployerMatch(v: unknown): unknown {
  const e = record(v);
  if (!e || !("matchShare" in e) || "tiers" in e) return v;
  const { matchShare, upToShareOfPay, ...rest } = e;
  return { ...rest, tiers: [{ matchRate: matchShare, bandShareOfPay: upToShareOfPay ?? 1 }] };
}

/** A flow, or a list of flows, with its employer match tiered. */
function tierFlowMatch(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(tierFlowMatch);
  const f = record(v);
  return f && "employer" in f ? { ...f, employer: tierEmployerMatch(f.employer) } : v;
}

const EMPLOYER_FIELD = /^(.*\/employer)\/(matchShare|upToShareOfPay)$/;

/** Branch patch ops: values holding flows or employer matches, and paths to the two old fields. */
function tierEmployerMatchOp(op: unknown): unknown {
  const o = record(op);
  if (!o || typeof o.path !== "string") return op;
  const field = EMPLOYER_FIELD.exec(o.path);
  if (field)
    return {
      ...o,
      // Removing upToShareOfPay used to restore its default (all of pay).
      ...(o.op === "remove" && field[2] === "upToShareOfPay" ? { op: "replace", value: 1 } : {}),
      path: `${field[1]}/tiers/0/${field[2] === "matchShare" ? "matchRate" : "bandShareOfPay"}`,
    };
  if (!("value" in o)) return op;
  if (o.path === "" || o.path === "/") {
    const plan = record(o.value);
    return plan && Array.isArray(plan.flows)
      ? { ...o, value: { ...plan, flows: tierFlowMatch(plan.flows) } }
      : op;
  }
  if (o.path.endsWith("/employer")) return { ...o, value: tierEmployerMatch(o.value) };
  if (/^\/flows(\/[^/]+)?$/.test(o.path)) return { ...o, value: tierFlowMatch(o.value) };
  return op;
}

function tierEmployerMatchInPlan(p: unknown): unknown {
  const plan = record(p);
  if (!plan) return p;
  const out = { ...plan };
  if (Array.isArray(out.flows)) out.flows = tierFlowMatch(out.flows);
  const lineage = record(out.lineage);
  if (lineage && Array.isArray(lineage.patch))
    out.lineage = { ...lineage, patch: lineage.patch.map(tierEmployerMatchOp) };
  return out;
}

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
