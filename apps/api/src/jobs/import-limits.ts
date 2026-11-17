/**
 * Limits on a document import (`POST /api/v1/import`, security review pass 3). Pure, so the same functions run
 * on the request thread (the cheap size, depth and plan-count checks, before the document is copied to a
 * worker) and in an import worker thread (the validation probe and the issue caps, in `import-task.ts`).
 */
import { randomInt } from "node:crypto";
import { ValidationError } from "@glideworth/core";
import { ApiError } from "../errors.js";

/**
 * Bounds on a document import, checked before the document is validated. Validation reports every problem it
 * finds, so without them one request of a few megabytes could hold an import worker for minutes or exhaust its
 * memory. A Glideworth export of a household with 50 accounts, 20 plans and five years of daily snapshots is
 * about 400,000 values; `docs/launch/security-review-pass3.md` has the measured cost at these limits.
 */
export const IMPORT_LIMITS = {
  /** JSON values (objects, arrays, strings, numbers, booleans and nulls) in `data`. */
  values: 500_000,
  /** Nesting of `data`. Documents nest about 10 levels; ProjectionLab exports about 12. */
  depth: 64,
  /** `data.plans` of a Glideworth document (ProjectionLab exports have their own limits in the importer). */
  plans: 200,
  /** Validation problems listed in a 400 response; `issueCount` gives the total. */
  issues: 100,
  /** Import notes listed in a response (`issues` and `report.issues`); `stats.issues` gives the total. */
  notes: 1_000,
} as const;

/**
 * Bounds on a bank-file import (`POST /api/v1/households/{id}/import/bank-file` and the MCP bank-file tools).
 * Each new account makes every later read and write of the household dearer, and one 2 MB QIF file can name
 * tens of thousands of accounts (security review finding 4, "Still open"). A dry run still reports how many an
 * apply would create (`reconciliation.created`).
 */
export const BANK_FILE_LIMITS = {
  /** New accounts and debts one apply may create with `balances.createMissing`. */
  newAccounts: 1_000,
} as const;

/**
 * Throws a 400 when an apply of a bank file would create more than `BANK_FILE_LIMITS.newAccounts` accounts and
 * debts. Runs in the import worker, before the apply's writes are worked out, so nothing is written.
 */
export function checkBankFileNewAccounts(created: number): void {
  if (created <= BANK_FILE_LIMITS.newAccounts) return;
  throw new ApiError(
    400,
    "VALIDATION",
    `the file would create ${created.toLocaleString("en-US")} new accounts; one bank-file import may create at most ${BANK_FILE_LIMITS.newAccounts.toLocaleString("en-US")}. Map the file's accounts to existing ones with balances.accountMap, or import fewer accounts at a time`,
    { limit: BANK_FILE_LIMITS.newAccounts, count: created },
  );
}

/**
 * Throws a 400 when `data` has more than `IMPORT_LIMITS.values` values or nests deeper than
 * `IMPORT_LIMITS.depth`; returns the number of values. Iterative, and stops at the first value past a
 * limit, so it costs at most the limit however large the body is.
 */
export function checkImportSize(data: unknown): number {
  const stack: [unknown, number][] = [[data, 1]];
  let values = 0;
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (++values > IMPORT_LIMITS.values)
      throw new ApiError(
        400,
        "VALIDATION",
        `the document has more than ${IMPORT_LIMITS.values.toLocaleString("en-US")} values, the import limit`,
        { limit: IMPORT_LIMITS.values },
      );
    if (v === null || typeof v !== "object") continue;
    if (depth >= IMPORT_LIMITS.depth)
      throw new ApiError(
        400,
        "VALIDATION",
        `the document nests deeper than ${IMPORT_LIMITS.depth} levels, the import limit`,
        { limit: IMPORT_LIMITS.depth },
      );
    if (Array.isArray(v)) for (const x of v) stack.push([x, depth + 1]);
    else
      for (const k in v)
        if (Object.hasOwn(v, k)) stack.push([(v as Record<string, unknown>)[k], depth + 1]);
  }
  return values;
}

/** Values drawn at random for the validation probe. */
const PROBE_DRAWS = 256;
/** Arrays this short are kept whole in the probe (a household's `people` holds at most two). */
const PROBE_WHOLE_ARRAY = 2;
/** Objects with more keys are cut in the probe. Only records get this wide; no document object has 128 fields. */
const PROBE_WIDE_OBJECT = 128;

/**
 * A small part of a document, validated before the whole of it (security review: hostile-input cost of the
 * importers). Validation creates every problem it finds, about 3.8 KB of memory each, before any can be
 * dropped: 490,000 empty objects as accounts made 2.4 million problems, 1.9 GB and several seconds, and in an
 * event list they overflowed the stack.
 *
 * The probe holds the paths to `PROBE_DRAWS` values drawn at random, every array's first element, arrays of
 * up to `PROBE_WHOLE_ARRAY` elements, and every field of the objects on those paths (an object wider than
 * `PROBE_WIDE_OBJECT` keeps only its first key and the drawn ones). Arrays keep their order and records a
 * subset of their entries, so a valid document gives a valid probe. When a share `f` of the values is
 * invalid, the probe misses all of them with probability (1 - f)^256: under 0.1% for 3%. `values` is the
 * count from `checkImportSize`.
 */
export function validationProbe(data: unknown, values: number): unknown {
  const draws = new Set<number>();
  while (draws.size < Math.min(PROBE_DRAWS, values)) draws.add(randomInt(values));
  const keep = new Map<object, Set<string | number>>();
  const path: [object, string | number][] = [];
  let seq = 0;
  // Depth-first, numbering values as it goes; the depth is at most IMPORT_LIMITS.depth.
  const visit = (v: unknown): void => {
    if (draws.has(seq++))
      for (const [container, key] of path) {
        let marks = keep.get(container);
        if (!marks) keep.set(container, (marks = new Set()));
        marks.add(key);
      }
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v))
      for (let i = 0; i < v.length; i++) {
        path.push([v, i]);
        visit(v[i]);
        path.pop();
      }
    else
      for (const k in v)
        if (Object.hasOwn(v, k)) {
          path.push([v, k]);
          visit((v as Record<string, unknown>)[k]);
          path.pop();
        }
  };
  visit(data);
  const build = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    const marks = keep.get(v);
    if (Array.isArray(v)) {
      if (v.length <= PROBE_WHOLE_ARRAY) return v.map(build);
      const at = new Set<number>([0]);
      for (const i of marks ?? []) at.add(i as number);
      return [...at].sort((a, b) => a - b).map((i) => build(v[i]));
    }
    const keys = Object.keys(v);
    const out: Record<string, unknown> = {};
    for (const [i, k] of keys.entries())
      if (keys.length <= PROBE_WIDE_OBJECT || i === 0 || marks?.has(k))
        // defineProperty: a key named `__proto__` stays an own key, as in the parsed body.
        Object.defineProperty(out, k, {
          value: build((v as Record<string, unknown>)[k]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
    return out;
  };
  return build(data);
}

/**
 * The same error with at most `IMPORT_LIMITS.issues` validation problems in its details. A document of
 * thousands of empty objects fails with several problems each, and the 400 response listed them all: a
 * 250 KB body was answered with 180 MB.
 */
export function withFewerIssues(err: unknown): unknown {
  if (!(err instanceof ValidationError)) return err;
  const issues = (err.details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues) || issues.length <= IMPORT_LIMITS.issues) return err;
  return new ValidationError(err.message, {
    ...err.details,
    issues: issues.slice(0, IMPORT_LIMITS.issues),
    issueCount: issues.length,
  });
}

/** A Glideworth document with more than `IMPORT_LIMITS.plans` plans is refused (400) before the import. */
export function checkPlanCount(data: unknown): void {
  const plans = (data as { plans?: unknown } | null)?.plans;
  if (Array.isArray(plans) && plans.length > IMPORT_LIMITS.plans)
    throw new ApiError(
      400,
      "VALIDATION",
      `the document has ${plans.length.toLocaleString("en-US")} plans; at most ${IMPORT_LIMITS.plans} can be imported`,
      { limit: IMPORT_LIMITS.plans },
    );
}
