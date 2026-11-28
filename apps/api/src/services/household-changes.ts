/**
 * Household edits as a list of operations (add / update / remove an account, real asset, debt, person or
 * dependent; update household fields), checked and described in plain words before anything is stored.
 * `HouseholdsService.applyChanges` runs them: a dry run returns what would change, a real run saves the
 * result in one atomic write through the same path as the web app's "current finances" save.
 */
import {
  Account,
  Debt,
  Dependent,
  fmtMoney,
  Household,
  Location,
  LocaleTag,
  Person,
  type Plan,
  RealAsset,
  type CurrentFinances,
} from "@glideworth/core";
import { z } from "zod";
import { ApiError, zodMessage } from "../errors.js";
import { clone, mergePatch, newId } from "../util.js";

export const HOUSEHOLD_ITEM_KINDS = [
  "account",
  "realAsset",
  "debt",
  "person",
  "dependent",
] as const;
export type HouseholdItemKind = (typeof HOUSEHOLD_ITEM_KINDS)[number];

const Fields = z.record(z.string(), z.unknown());

export const HouseholdChangeOp = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), kind: z.enum(HOUSEHOLD_ITEM_KINDS), item: Fields }),
  z.object({
    action: z.literal("update"),
    kind: z.enum(HOUSEHOLD_ITEM_KINDS),
    id: z.string().min(1),
    /** JSON merge patch (RFC 7396): fields to set; null removes an optional field. */
    changes: Fields,
  }),
  z.object({
    action: z.literal("remove"),
    kind: z.enum(HOUSEHOLD_ITEM_KINDS),
    id: z.string().min(1),
  }),
  z.object({
    action: z.literal("updateHousehold"),
    changes: z
      .object({ name: z.string().min(1).max(120), location: Location, locale: LocaleTag })
      .partial()
      .strict(),
  }),
]);
export type HouseholdChangeOp = z.infer<typeof HouseholdChangeOp>;

const LABEL: Record<HouseholdItemKind, string> = {
  account: "account",
  realAsset: "real asset",
  debt: "debt",
  person: "person",
  dependent: "dependent",
};
const ID_PREFIX: Record<HouseholdItemKind, string> = {
  account: "acct",
  realAsset: "asset",
  debt: "debt",
  person: "p",
  dependent: "dep",
};
const SCHEMA: Record<HouseholdItemKind, z.ZodType> = {
  account: Account,
  realAsset: RealAsset,
  debt: Debt,
  person: Person,
  dependent: Dependent,
};

type Item = { id: string; name?: string } & Record<string, unknown>;

export interface HouseholdChangeResult {
  household: Household;
  finances: CurrentFinances;
  changes: string[];
}

/** Where a plan mentions an id: "Main plan (plan-main): flows/fl-isa (ISA top-up)". */
export function planReferences(plans: readonly Plan[], id: string): string[] {
  const needle = `"${id}"`;
  const out: string[] = [];
  for (const p of plans) {
    const where: string[] = [];
    for (const section of [
      "milestones",
      "income",
      "expenses",
      "flows",
      "plannedAccounts",
      "plannedRealAssets",
    ] as const) {
      for (const it of p[section] as readonly { id: string; name?: string }[]) {
        const { id: _own, ...rest } = it;
        if (JSON.stringify(rest).includes(needle))
          where.push(`${section}/${it.id}${it.name ? ` (${it.name})` : ""}`);
      }
    }
    for (const key of ["accountSettings", "realAssetSettings", "debtSettings"] as const)
      if (id in p[key]) where.push(key);
    if (p.excludedIds.includes(id)) where.push("excludedIds");
    if (p.leftover.kind === "save" && p.leftover.accountId === id) where.push("leftover");
    for (const key of ["drawdown", "withdrawalStrategy", "taxStrategy", "assumptions"] as const)
      if (p[key] !== undefined && JSON.stringify(p[key]).includes(needle)) where.push(key);
    if (where.length) out.push(`${p.name} (${p.id}): ${where.join(", ")}`);
  }
  return out;
}

/** Leaf-level differences between two values, as "path: before -> after" (at most `max`). */
function fieldDiffs(before: unknown, after: unknown, max = 8): string[] {
  const out: string[] = [];
  const show = (v: unknown) =>
    v === undefined ? "(none)" : typeof v === "string" ? v : JSON.stringify(v);
  const walk = (a: unknown, b: unknown, path: string) => {
    if (out.length > max) return;
    const obj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
    if (obj(a) && obj(b)) {
      const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
      for (const k of keys)
        walk(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
          path ? `${path}.${k}` : k,
        );
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${show(a)} -> ${show(b)}`);
  };
  walk(before, after, "");
  return out.length > max ? [...out.slice(0, max), `(and ${out.length - max} more)`] : out;
}

/**
 * Apply the operations to copies of the household and its finances. Throws ApiError naming the operation
 * (index and what it does) for an unknown id, an invalid item, or a removal plans still depend on.
 */
export function planHouseholdChanges(
  current: { household: Household; finances: CurrentFinances },
  ops: HouseholdChangeOp[],
  plans: readonly Plan[],
): HouseholdChangeResult {
  const household = clone(current.household);
  const finances = clone(current.finances);
  const currency = household.currency;
  const money = (v: unknown) =>
    typeof v === "number" ? fmtMoney(v, { currency, locale: household.locale }) : "?";
  const changes: string[] = [];
  const listOf = (kind: HouseholdItemKind): Item[] =>
    (kind === "account"
      ? finances.accounts
      : kind === "realAsset"
        ? finances.realAssets
        : kind === "debt"
          ? finances.debts
          : kind === "person"
            ? household.people
            : household.dependents) as unknown as Item[];
  const describe = (kind: HouseholdItemKind, it: Item) => {
    const base = `${LABEL[kind]} "${it.name ?? it.id}" (${it.id})`;
    if (kind === "account") return `${base}, ${it.type}, balance ${money(it.balance)}`;
    if (kind === "debt") return `${base}, balance ${money(it.balance)}`;
    if (kind === "realAsset") {
      const loan = it.loan as { balance: number } | undefined;
      return `${base}, value ${money(it.currentValue)}${loan ? `, loan ${money(loan.balance)}` : ""}`;
    }
    return `${base}, born ${it.birthMonth}`;
  };

  ops.forEach((op, i) => {
    const where = (what: string) => `operations[${i}] (${what})`;
    const parse = (kind: HouseholdItemKind, value: unknown, what: string): Item => {
      try {
        return SCHEMA[kind].parse(value) as Item;
      } catch (e) {
        if (e instanceof z.ZodError)
          throw new ApiError(400, "VALIDATION", `${where(what)}: ${zodMessage(e)}`, {
            operation: i,
            issues: e.issues.map((x) => ({ path: x.path, message: x.message })),
          });
        throw e;
      }
    };
    if (op.action === "updateHousehold") {
      if (Object.keys(op.changes).length === 0)
        throw new ApiError(
          400,
          "VALIDATION",
          `${where("update household")}: nothing to change; name, location and locale can be changed here`,
        );
      const next = { ...household, ...op.changes };
      for (const line of fieldDiffs(
        { name: household.name, location: household.location, locale: household.locale },
        { name: next.name, location: next.location, locale: next.locale },
      ))
        changes.push(`Household ${line}`);
      Object.assign(household, op.changes);
      return;
    }
    const kind = op.kind;
    const list = listOf(kind);
    if (op.action === "add") {
      const what = `add ${LABEL[kind]}`;
      const item = parse(kind, { ...op.item, id: op.item.id ?? newId(ID_PREFIX[kind]) }, what);
      if (list.some((x) => x.id === item.id))
        throw new ApiError(
          409,
          "CONFLICT",
          `${where(what)}: ${LABEL[kind]} '${item.id}' already exists`,
        );
      list.push(item);
      changes.push(`Add ${describe(kind, item)}`);
      return;
    }
    const at = list.findIndex((x) => x.id === op.id);
    const what = `${op.action} ${LABEL[kind]} '${op.id}'`;
    if (at < 0)
      throw new ApiError(404, "NOT_FOUND", `${where(what)}: ${LABEL[kind]} '${op.id}' not found`, {
        operation: i,
        validIds: list.map((x) => x.id),
      });
    const before = list[at]!;
    if (op.action === "update") {
      const item = parse(kind, { ...(mergePatch(before, op.changes) as object), id: op.id }, what);
      list[at] = item;
      const diffs = fieldDiffs(before, item);
      changes.push(
        `Update ${LABEL[kind]} "${item.name ?? item.id}" (${item.id}): ${diffs.length ? diffs.join("; ") : "no change"}`,
      );
      return;
    }
    // remove: refuse when plans (or, for a person, the household's finances) still point at it.
    const refs = planReferences(plans, op.id);
    if (kind === "person") {
      if (before.role === "primary")
        throw new ApiError(409, "CONFLICT", `${where(what)}: the primary person cannot be removed`);
      const owned = [...finances.accounts, ...finances.realAssets, ...finances.debts]
        .filter((x) => x.owner === op.id)
        .map((x) => `${x.name} (${x.id})`);
      if (owned.length) refs.push(`owns: ${owned.join(", ")}`);
    }
    if (refs.length)
      throw new ApiError(
        409,
        "IN_USE",
        `${where(what)}: still used by ${refs.join("; ")}. Remove or repoint those first${kind === "person" || kind === "dependent" ? "" : `, or archive the ${LABEL[kind]} instead (update with {"archived":true})`}.`,
        { operation: i, references: refs },
      );
    list.splice(at, 1);
    changes.push(`Remove ${describe(kind, before)}`);
  });

  // The same rules as the household save: planning mode follows the head count, and the whole documents parse.
  if (household.people.length === 2 && household.planningMode === "individual")
    household.planningMode = "couple";
  if (household.people.length === 1 && household.planningMode === "couple")
    household.planningMode = "individual";
  const whole = Household.safeParse(household);
  if (!whole.success)
    throw new ApiError(400, "VALIDATION", `household: ${zodMessage(whole.error)}`, {
      issues: whole.error.issues.map((x) => ({ path: x.path, message: x.message })),
    });
  return { household: whole.data, finances, changes };
}
