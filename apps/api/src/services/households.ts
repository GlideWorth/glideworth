import {
  ACCOUNT_TYPE_INFO,
  Account,
  type Actor,
  CurrentFinances,
  type CurrentFinancesInput,
  Debt,
  Dependent,
  FxRate,
  type FxRateInput,
  fxPairKey,
  fxRateIssues,
  type GlideworthDocument,
  Household,
  type HouseholdInput,
  migrateDocument,
  Person,
  ProgressSnapshot,
  type ProgressSnapshotInput,
  RealAsset,
  SCHEMA_VERSION,
} from "@glideworth/core";
import {
  type HistoryIssue,
  type HistoryRow,
  historyKeyLabel,
  historyTargets,
  planHistoryImport,
} from "@glideworth/importers";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { households, plans, progressSnapshots } from "../db/schema.js";
import { ApiError, conflict, notFound } from "../errors.js";
import { baseConverter } from "../fx.js";
import { clone, mergePatch, newId, nowIso } from "../util.js";
import type { ServiceCtx } from "./context.js";
import type { BalanceHistoryImportResult } from "./history.js";
import type { PlansService } from "./plans.js";
import type { SettingsService } from "./settings.js";

export interface HouseholdRecord {
  household: Household;
  finances: CurrentFinances;
  version: number;
}

/** Households and plans both start at version 1 (the version counts stored states; ETag = version). */
export const INITIAL_VERSION = 1;

export type FinanceKind = "accounts" | "realAssets" | "debts";
export const FINANCE_LABEL: Record<FinanceKind, string> = {
  accounts: "account",
  realAssets: "real asset",
  debts: "debt",
};

export const BalanceUpdate = z
  .object({
    asOf: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional()
      .describe("Set CurrentFinances.asOf to this month 'YYYY-MM' (defaults to unchanged)."),
    accounts: z
      .array(
        z.object({
          accountId: z.string().min(1).max(64),
          balance: z.number().describe("New balance in major currency units."),
          costBasis: z.number().min(0).optional(),
          contributionBasis: z.number().min(0).optional(),
        }),
      )
      .default([]),
    realAssets: z
      .array(
        z
          .object({
            assetId: z.string().min(1).max(64),
            currentValue: z.number().min(0).optional().describe("New market value of the asset."),
            loanBalance: z
              .number()
              .min(0)
              .optional()
              .describe(
                "New outstanding balance of the asset's loan (a mortgage paying down). 422 if the asset has no loan.",
              ),
          })
          .refine((r) => r.currentValue !== undefined || r.loanBalance !== undefined, {
            message: "give currentValue and/or loanBalance",
          }),
      )
      .default([]),
    debts: z
      .array(
        z.object({
          debtId: z
            .string()
            .min(1)
            .max(64)
            .describe(
              "A debt id, or the id of a real asset that has a loan (updates the loan balance).",
            ),
          balance: z.number().min(0),
        }),
      )
      .default([]),
    recordSnapshot: z
      .boolean()
      .optional()
      .describe(
        "Record a progress snapshot of the new state. Default: follows settings.autoProgressSnapshots.",
      ),
    snapshotNote: z.string().max(500).optional(),
  })
  .meta({
    id: "BalanceUpdate",
    examples: [
      {
        accounts: [
          { accountId: "acc-cash", balance: 31250.4 },
          { accountId: "acc-brokerage", balance: 171904.12 },
        ],
        debts: [{ debtId: "debt-car", balance: 8120 }],
        recordSnapshot: true,
      },
    ],
  });
export type BalanceUpdate = z.infer<typeof BalanceUpdate>;

export const SnapshotCreate = z
  .object({
    id: z.string().min(1).max(64).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    source: z.enum(["manual", "auto", "import", "api"]).default("api"),
    netWorth: z.number(),
    assets: z.number(),
    liabilities: z.number(),
    byCategory: ProgressSnapshot.shape.byCategory.optional(),
    accounts: ProgressSnapshot.shape.accounts.optional(),
    realAssets: ProgressSnapshot.shape.realAssets.optional(),
    debts: ProgressSnapshot.shape.debts.optional(),
    note: z.string().max(20_000).optional(),
  })
  .meta({ id: "SnapshotCreate" });
export type SnapshotCreate = z.infer<typeof SnapshotCreate>;

/** Build a progress snapshot from CurrentFinances (used for "record now" and auto-snapshots). */
export function snapshotFromFinances(
  householdId: string,
  finances: CurrentFinances,
  date: string,
  source: ProgressSnapshot["source"],
  note?: string,
  baseCurrency?: string,
): ProgressSnapshotInput {
  // Foreign-currency items are converted to the household currency (no-op for a single-currency household).
  const base = baseCurrency ?? "";
  const fx = baseConverter(finances, base);
  const conv = (v: number, c: string | undefined) => (base ? fx.convert(v, c) : v);
  const byCategory: Record<string, number> = {};
  let assets = 0;
  let liabilities = 0;
  for (const a of finances.accounts) {
    if (a.archived) continue;
    const cat = ACCOUNT_TYPE_INFO[a.type].drawdown;
    const bal = conv(a.balance, a.currency);
    byCategory[cat] = (byCategory[cat] ?? 0) + bal;
    assets += bal;
  }
  let realAssetValue = 0;
  let loans = 0;
  for (const r of finances.realAssets) {
    if (r.archived) continue;
    realAssetValue += conv(r.currentValue, r.currency);
    loans += conv(r.loan?.balance ?? 0, r.currency);
  }
  if (realAssetValue) byCategory["real-assets"] = realAssetValue;
  assets += realAssetValue;
  let debt = 0;
  for (const d of finances.debts) if (!d.archived) debt += conv(d.balance, d.currency);
  liabilities = debt + loans;
  if (debt) byCategory.debt = debt;
  if (loans) byCategory.loans = loans;
  return {
    id: newId("snap"),
    householdId,
    date,
    source,
    netWorth: assets - liabilities,
    assets,
    liabilities,
    byCategory,
    accounts: finances.accounts
      .filter((a) => !a.archived)
      .map((a) => ({ accountId: a.id, balance: a.balance })),
    realAssets: finances.realAssets
      .filter((r) => !r.archived)
      .map((r) => ({ assetId: r.id, value: r.currentValue, loanBalance: r.loan?.balance ?? 0 })),
    debts: finances.debts
      .filter((d) => !d.archived)
      .map((d) => ({ debtId: d.id, balance: d.balance })),
    ...(note ? { note } : {}),
  };
}

const balanceFingerprint = (f: CurrentFinances) =>
  JSON.stringify([
    f.accounts.map((a) => [a.id, a.balance]),
    f.realAssets.map((r) => [r.id, r.currentValue, r.loan?.balance ?? 0]),
    f.debts.map((d) => [d.id, d.balance]),
  ]);

export class HouseholdsService {
  /** Set by the Services facade (plans service needs households and vice versa). */
  plans!: PlansService;
  settings!: SettingsService;
  constructor(private readonly ctx: ServiceCtx) {}
  get db() {
    return this.ctx.db;
  }

  // ----------------------------------------------------------------------------- households
  list(): Household[] {
    return this.db
      .select()
      .from(households)
      .orderBy(asc(households.createdAt))
      .all()
      .map((r) => Household.parse(r.body));
  }

  get(id: string): HouseholdRecord {
    const row = this.db.select().from(households).where(eq(households.id, id)).get();
    if (!row) throw notFound("household", id);
    return {
      household: Household.parse(row.body),
      finances: CurrentFinances.parse(row.finances),
      version: row.version,
    };
  }

  version(id: string): number {
    return this.get(id).version;
  }

  /**
   * Create a household. Without `finances` the balances are empty and dated THIS month (never an arbitrary
   * past date: plans that follow live finances start at `finances.asOf`).
   */
  create(input: {
    household: HouseholdInput;
    finances?: CurrentFinancesInput | undefined;
  }): HouseholdRecord {
    const ts = nowIso();
    const household = Household.parse({ ...input.household, createdAt: ts, updatedAt: ts });
    const finances = CurrentFinances.parse({
      ...(input.finances ?? { asOf: ts.slice(0, 7) }),
      updatedAt: ts,
    });
    if (
      this.db
        .select({ id: households.id })
        .from(households)
        .where(eq(households.id, household.id))
        .get()
    )
      throw conflict(`household '${household.id}' already exists`);
    this.db
      .insert(households)
      .values({
        id: household.id,
        name: household.name,
        schemaVersion: SCHEMA_VERSION,
        body: household,
        finances,
        version: INITIAL_VERSION,
      })
      .run();
    return { household, finances, version: INITIAL_VERSION };
  }

  private checkVersion(rec: HouseholdRecord, expected?: number) {
    if (expected !== undefined && rec.version !== expected)
      throw conflict(
        `household is at version ${rec.version}, not ${expected}`,
        { currentVersion: rec.version },
        "VERSION_CONFLICT",
      );
  }

  /** Persist a new household body and/or finances atomically, bumping the version. */
  private save(
    id: string,
    next: { household?: Household; finances?: CurrentFinances },
    expected?: number,
  ) {
    const cur = this.get(id);
    this.checkVersion(cur, expected);
    const ts = nowIso();
    const household = Household.parse({ ...(next.household ?? cur.household), updatedAt: ts });
    const finances = CurrentFinances.parse({ ...(next.finances ?? cur.finances), updatedAt: ts });
    // One FX table, whichever route writes it (Current finances save, /fx-rates, MCP, imports): an
    // empty table is stored as absent, and a changed table must be valid (core `fxRateIssues`).
    if (finances.fxRates && finances.fxRates.length === 0) delete finances.fxRates;
    if (JSON.stringify(finances.fxRates ?? []) !== JSON.stringify(cur.finances.fxRates ?? [])) {
      const issues = fxRateIssues(finances.fxRates ?? []);
      if (issues.length)
        throw new ApiError(400, "VALIDATION", issues[0]!.message, {
          issues: issues.map((i) => ({
            path: ["finances", "fxRates", i.index],
            message: i.message,
          })),
        });
    }
    const res = this.db
      .update(households)
      .set({
        name: household.name,
        body: household,
        finances,
        version: cur.version + 1,
        updatedAt: ts,
      })
      .where(and(eq(households.id, id), eq(households.version, cur.version)))
      .run();
    if (res.changes !== 1)
      throw conflict("household changed concurrently", undefined, "VERSION_CONFLICT");
    return { household, finances, version: cur.version + 1 } satisfies HouseholdRecord;
  }

  /** Replace or merge-patch household fields (people/dependents have their own routes). */
  update(
    id: string,
    patch: Record<string, unknown>,
    mode: "replace" | "merge",
    expected?: number,
  ): HouseholdRecord {
    const cur = this.get(id);
    const merged =
      mode === "merge"
        ? mergePatch(cur.household, patch)
        : { ...patch, createdAt: cur.household.createdAt };
    const household = Household.parse({ ...(merged as object), id });
    return this.save(id, { household }, expected);
  }

  delete(id: string): void {
    this.get(id);
    this.db.delete(households).where(eq(households.id, id)).run();
  }

  // ----------------------------------------------------------------------------- people / dependents
  private mutateHousehold(
    id: string,
    fn: (h: Household) => Household,
    expected?: number,
  ): HouseholdRecord {
    const cur = this.get(id);
    const next = fn(clone(cur.household));
    // Keep planningMode consistent with the head count so adding/removing a partner is one call.
    if (next.people.length === 2 && next.planningMode === "individual")
      next.planningMode = "couple";
    if (next.people.length === 1 && next.planningMode === "couple")
      next.planningMode = "individual";
    return this.save(id, { household: Household.parse(next) }, expected);
  }

  addPerson(
    id: string,
    input: unknown,
    expected?: number,
  ): { person: Person; record: HouseholdRecord } {
    const person = Person.parse(input);
    const record = this.mutateHousehold(
      id,
      (h) => {
        if (h.people.some((p) => p.id === person.id))
          throw conflict(`person '${person.id}' already exists`);
        h.people.push(person);
        return h;
      },
      expected,
    );
    return { person, record };
  }

  updatePerson(id: string, personId: string, patch: unknown, expected?: number) {
    let out: Person | undefined;
    const record = this.mutateHousehold(
      id,
      (h) => {
        const i = h.people.findIndex((p) => p.id === personId);
        if (i < 0) throw notFound("person", personId);
        out = Person.parse({ ...(mergePatch(h.people[i], patch) as object), id: personId });
        h.people[i] = out;
        return h;
      },
      expected,
    );
    return { person: out!, record };
  }

  removePerson(id: string, personId: string, expected?: number): HouseholdRecord {
    return this.mutateHousehold(
      id,
      (h) => {
        const left = h.people.filter((p) => p.id !== personId);
        if (left.length === h.people.length) throw notFound("person", personId);
        if (left.length === 0 || !left.some((p) => p.role === "primary"))
          throw new ApiError(409, "CONFLICT", "cannot remove the primary person");
        h.people = left;
        return h;
      },
      expected,
    );
  }

  addDependent(id: string, input: unknown, expected?: number) {
    const dep = Dependent.parse(input);
    const record = this.mutateHousehold(
      id,
      (h) => {
        if (h.dependents.some((d) => d.id === dep.id))
          throw conflict(`dependent '${dep.id}' already exists`);
        h.dependents.push(dep);
        return h;
      },
      expected,
    );
    return { dependent: dep, record };
  }

  updateDependent(id: string, depId: string, patch: unknown, expected?: number) {
    let out: Dependent | undefined;
    const record = this.mutateHousehold(
      id,
      (h) => {
        const i = h.dependents.findIndex((d) => d.id === depId);
        if (i < 0) throw notFound("dependent", depId);
        out = Dependent.parse({ ...(mergePatch(h.dependents[i], patch) as object), id: depId });
        h.dependents[i] = out;
        return h;
      },
      expected,
    );
    return { dependent: out!, record };
  }

  removeDependent(id: string, depId: string, expected?: number): HouseholdRecord {
    return this.mutateHousehold(
      id,
      (h) => {
        const left = h.dependents.filter((d) => d.id !== depId);
        if (left.length === h.dependents.length) throw notFound("dependent", depId);
        h.dependents = left;
        return h;
      },
      expected,
    );
  }

  // ----------------------------------------------------------------------------- finances (accounts / assets / debts)
  /**
   * Apply a finances mutation and bump the version. When balances moved (and `autoProgressSnapshots`
   * is on) the household's automatic progress snapshot for TODAY is created or updated in place: at
   * most one per day, however many writes happen. `recordSnapshot: true/false` overrides the setting.
   */
  private mutateFinances(
    id: string,
    fn: (f: CurrentFinances) => CurrentFinances,
    expected: number | undefined,
    _actor: Actor,
    opts: { recordSnapshot?: boolean | undefined; snapshotNote?: string | undefined } = {},
  ): { record: HouseholdRecord; snapshot: ProgressSnapshot | null } {
    const cur = this.get(id);
    const next = CurrentFinances.parse(fn(clone(cur.finances)));
    const record = this.save(id, { finances: next }, expected);
    const moved = balanceFingerprint(cur.finances) !== balanceFingerprint(record.finances);
    const want = opts.recordSnapshot ?? (moved && this.autoSnapshotsEnabled());
    const snapshot = want
      ? this.upsertDailyAutoSnapshot(
          id,
          record.finances,
          opts.snapshotNote,
          opts.recordSnapshot === true,
        )
      : null;
    return { record, snapshot };
  }

  private autoSnapshotsEnabled(): boolean {
    return this.settings.get().autoProgressSnapshots;
  }

  /**
   * The once-a-day automatic snapshot. Updates today's `auto` snapshot in place (same id, so history
   * does not churn and `snapshot.created` fires once). A manual/api/import snapshot already dated
   * today is the user's own record, so an implicit auto-snapshot leaves it alone (returns null)
   * unless `explicit` (the caller asked for one).
   */
  private upsertDailyAutoSnapshot(
    householdId: string,
    finances: CurrentFinances,
    note: string | undefined,
    explicit: boolean,
  ): ProgressSnapshot | null {
    const date = nowIso().slice(0, 10);
    const today = this.listSnapshots(householdId, { from: date, to: date });
    const existing = today.find((s) => s.source === "auto");
    if (!existing && !explicit && today.length > 0) return null;
    const fresh = snapshotFromFinances(
      householdId,
      finances,
      date,
      "auto",
      note,
      this.get(householdId).household.currency,
    );
    if (!existing) return this.addSnapshot(fresh);
    const next = ProgressSnapshot.parse({
      ...fresh,
      id: existing.id,
      createdAt: existing.createdAt,
      ...((note ?? existing.note) ? { note: note ?? existing.note } : {}),
    });
    this.db
      .update(progressSnapshots)
      .set({ date: next.date, body: next })
      .where(eq(progressSnapshots.id, existing.id))
      .run();
    this.ctx.events.publish("snapshot.updated", {
      snapshotId: next.id,
      householdId,
      date: next.date,
      netWorth: next.netWorth,
      source: next.source,
    });
    return next;
  }

  /**
   * Save the whole "current finances" document in ONE atomic write: the household (people,
   * dependents...) and every account, real asset and debt. This is what the web app's editor calls
   * instead of a series of per-item requests. `expected` is the household version (If-Match).
   */
  replaceCurrent(
    id: string,
    input: { household?: unknown; finances: unknown },
    expected: number | undefined,
    _actor: Actor,
  ): { record: HouseholdRecord; snapshot: ProgressSnapshot | null } {
    const cur = this.get(id);
    const household = input.household
      ? Household.parse({ ...(input.household as object), id, createdAt: cur.household.createdAt })
      : cur.household;
    if (household.people.length === 2 && household.planningMode === "individual")
      household.planningMode = "couple";
    if (household.people.length === 1 && household.planningMode === "couple")
      household.planningMode = "individual";
    const finances = CurrentFinances.parse(input.finances);
    const record = this.save(id, { household, finances }, expected);
    const moved = balanceFingerprint(cur.finances) !== balanceFingerprint(record.finances);
    const snapshot =
      moved && this.autoSnapshotsEnabled()
        ? this.upsertDailyAutoSnapshot(id, record.finances, undefined, false)
        : null;
    return { record, snapshot };
  }

  /**
   * Persist a display order for accounts / real assets / debts. The order is the array order of the
   * stored document, so every reader (list endpoints, export, the web app) sees it. Ids not listed
   * keep their relative order after the listed ones; an unknown id is a 404 and changes nothing.
   */
  reorderFinance(
    id: string,
    kind: FinanceKind,
    ids: string[],
    expected: number | undefined,
    actor: Actor,
  ) {
    if (new Set(ids).size !== ids.length)
      throw new ApiError(400, "VALIDATION", "ids contains duplicates");
    return this.mutateFinances(
      id,
      (f) => {
        const list = f[kind] as { id: string }[];
        const unknown = ids.filter((i) => !list.some((x) => x.id === i));
        if (unknown.length)
          throw new ApiError(404, "NOT_FOUND", `unknown ids: ${unknown.join(", ")}`, {
            unknownIds: unknown,
          });
        const rank = new Map(ids.map((i, n) => [i, n]));
        const listed = list
          .filter((x) => rank.has(x.id))
          .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
        (f as Record<FinanceKind, { id: string }[]>)[kind] = [
          ...listed,
          ...list.filter((x) => !rank.has(x.id)),
        ];
        return f;
      },
      expected,
      actor,
      { recordSnapshot: false },
    ).record;
  }

  listFinance(
    id: string,
    kind: FinanceKind,
    includeArchived = false,
  ): (Account | RealAsset | Debt)[] {
    const items = this.get(id).finances[kind] as (Account | RealAsset | Debt)[];
    return includeArchived ? items : items.filter((i) => !i.archived);
  }

  getFinance(id: string, kind: FinanceKind, itemId: string): Account | RealAsset | Debt {
    const item = (this.get(id).finances[kind] as { id: string }[]).find((i) => i.id === itemId);
    if (!item) throw notFound(FINANCE_LABEL[kind], itemId);
    return item as Account | RealAsset | Debt;
  }

  private schemaFor(kind: FinanceKind) {
    const m = { accounts: Account, realAssets: RealAsset, debts: Debt } as const;
    return m[kind] as unknown as z.ZodType;
  }

  createFinance(
    id: string,
    kind: FinanceKind,
    input: Record<string, unknown>,
    expected: number | undefined,
    actor: Actor,
  ) {
    const prefix = kind === "accounts" ? "acct" : kind === "debts" ? "debt" : "asset";
    const item = this.schemaFor(kind).parse({ ...input, id: input.id ?? newId(prefix) }) as {
      id: string;
    };
    const out = this.mutateFinances(
      id,
      (f) => {
        const list = f[kind] as { id: string }[];
        if (list.some((x) => x.id === item.id))
          throw conflict(`${FINANCE_LABEL[kind]} '${item.id}' already exists`);
        list.push(item);
        return f;
      },
      expected,
      actor,
    );
    return { item, ...out };
  }

  updateFinance(
    id: string,
    kind: FinanceKind,
    itemId: string,
    body: Record<string, unknown>,
    mode: "replace" | "merge",
    expected: number | undefined,
    actor: Actor,
  ) {
    let item: { id: string } | undefined;
    const out = this.mutateFinances(
      id,
      (f) => {
        const list = f[kind] as { id: string }[];
        const i = list.findIndex((x) => x.id === itemId);
        if (i < 0) throw notFound(FINANCE_LABEL[kind], itemId);
        const merged = mode === "merge" ? mergePatch(list[i], body) : body;
        item = this.schemaFor(kind).parse({ ...(merged as object), id: itemId }) as { id: string };
        list[i] = item;
        return f;
      },
      expected,
      actor,
    );
    return { item: item!, ...out };
  }

  /** Plans that reference an id (flows, events, milestones...). Used to block dangling deletes. */
  referencingPlans(householdId: string, itemId: string): string[] {
    const out: string[] = [];
    for (const r of this.db.select().from(plans).where(eq(plans.householdId, householdId)).all()) {
      const text = JSON.stringify(r.body);
      const own = new RegExp(`"id":"${itemId}"`, "g");
      const all = new RegExp(`"${itemId}"`, "g");
      if ((text.match(all)?.length ?? 0) > (text.match(own)?.length ?? 0)) out.push(r.id);
    }
    return out;
  }

  deleteFinance(
    id: string,
    kind: FinanceKind,
    itemId: string,
    opts: { force?: boolean; expected?: number | undefined },
    actor: Actor,
  ) {
    this.getFinance(id, kind, itemId);
    const refs = opts.force ? [] : this.referencingPlans(id, itemId);
    if (refs.length)
      throw conflict(
        `${FINANCE_LABEL[kind]} '${itemId}' is referenced by ${refs.length} plan(s); pass force=true or archive it instead`,
        { planIds: refs },
        "IN_USE",
      );
    return this.mutateFinances(
      id,
      (f) => {
        (f as Record<FinanceKind, { id: string }[]>)[kind] = (f[kind] as { id: string }[]).filter(
          (x) => x.id !== itemId,
        );
        return f;
      },
      opts.expected,
      actor,
    );
  }

  /** The integration use case: a budgeting tool pushes balances for many accounts in one call. */
  updateBalances(id: string, u: BalanceUpdate, expected: number | undefined, actor: Actor) {
    const unknown: string[] = [];
    const out = this.mutateFinances(
      id,
      (f) => {
        for (const b of u.accounts) {
          const a = f.accounts.find((x) => x.id === b.accountId);
          if (!a) {
            unknown.push(b.accountId);
            continue;
          }
          a.balance = b.balance;
          if (b.costBasis !== undefined) a.costBasis = b.costBasis;
          if (b.contributionBasis !== undefined) a.contributionBasis = b.contributionBasis;
        }
        const noLoan: string[] = [];
        for (const b of u.realAssets) {
          const a = f.realAssets.find((x) => x.id === b.assetId);
          if (!a) {
            unknown.push(b.assetId);
            continue;
          }
          if (b.currentValue !== undefined) a.currentValue = b.currentValue;
          if (b.loanBalance !== undefined) {
            if (a.loan) a.loan.balance = b.loanBalance;
            else noLoan.push(b.assetId);
          }
        }
        for (const b of u.debts) {
          const d = f.debts.find((x) => x.id === b.debtId);
          if (d) {
            d.balance = b.balance;
            continue;
          }
          // A mortgage lives on its real asset: the asset id addresses its loan.
          const asset = f.realAssets.find((x) => x.id === b.debtId);
          if (!asset) unknown.push(b.debtId);
          else if (!asset.loan) noLoan.push(b.debtId);
          else asset.loan.balance = b.balance;
        }
        if (unknown.length)
          throw new ApiError(404, "NOT_FOUND", `unknown ids: ${unknown.join(", ")}`, {
            unknownIds: unknown,
          });
        if (noLoan.length)
          throw new ApiError(
            422,
            "SCENARIO",
            `real asset(s) ${noLoan.join(", ")} have no loan to update; add a loan to the asset first`,
            { assetIdsWithoutLoan: noLoan },
          );
        if (u.asOf) f.asOf = u.asOf;
        return f;
      },
      expected,
      actor,
      { recordSnapshot: u.recordSnapshot, snapshotNote: u.snapshotNote },
    );
    return {
      updated: {
        accounts: u.accounts.length,
        realAssets: u.realAssets.length,
        debts: u.debts.length,
      },
      version: out.record.version,
      snapshot: out.snapshot,
    };
  }

  // ----------------------------------------------------------------------------- FX rates
  /** FX rates for foreign-currency accounts, assets and debts (stored in the household's current finances). */
  listFx(id: string): { baseCurrency: string; items: FxRate[] } {
    const rec = this.get(id);
    return { baseCurrency: rec.household.currency, items: rec.finances.fxRates ?? [] };
  }

  /** Add or replace one pair. */
  upsertFx(id: string, rate: FxRateInput, expected: number | undefined, actor: Actor) {
    const r = FxRate.parse(rate);
    if (r.from === r.to)
      throw new ApiError(400, "VALIDATION", "from and to must be different currencies");
    const out = this.mutateFinances(
      id,
      (f) => {
        // Upsert by pair in either direction: GBP>USD replaces a stored USD>GBP.
        const rest = (f.fxRates ?? []).filter(
          (x) => fxPairKey(x.from, x.to) !== fxPairKey(r.from, r.to),
        );
        f.fxRates = [...rest, r];
        return f;
      },
      expected,
      actor,
      { recordSnapshot: false },
    );
    return { rate: r, version: out.record.version };
  }

  replaceFx(id: string, rates: FxRateInput[], expected: number | undefined, actor: Actor) {
    const list = rates.map((r) => FxRate.parse(r));
    const issues = fxRateIssues(list);
    if (issues.length) throw new ApiError(400, "VALIDATION", issues[0]!.message);
    const out = this.mutateFinances(
      id,
      (f) => {
        f.fxRates = list;
        return f;
      },
      expected,
      actor,
      { recordSnapshot: false },
    );
    return { items: list, version: out.record.version };
  }

  deleteFx(id: string, from: string, to: string, expected: number | undefined, actor: Actor) {
    // The pair in either direction (the table holds at most one of GBP-USD and USD-GBP).
    const key = fxPairKey(from, to);
    if (!(this.get(id).finances.fxRates ?? []).some((x) => fxPairKey(x.from, x.to) === key))
      throw notFound("fx rate", `${from}-${to}`);
    return this.mutateFinances(
      id,
      (f) => {
        f.fxRates = (f.fxRates ?? []).filter((x) => fxPairKey(x.from, x.to) !== key);
        return f;
      },
      expected,
      actor,
      { recordSnapshot: false },
    ).record.version;
  }

  // ----------------------------------------------------------------------------- progress snapshots
  private rowToSnapshot(body: unknown): ProgressSnapshot {
    return ProgressSnapshot.parse(body);
  }

  listSnapshots(
    householdId: string,
    range: { from?: string | undefined; to?: string | undefined } = {},
  ): ProgressSnapshot[] {
    this.get(householdId);
    const conds = [eq(progressSnapshots.householdId, householdId)];
    if (range.from) conds.push(gte(progressSnapshots.date, range.from));
    if (range.to) conds.push(lte(progressSnapshots.date, range.to));
    return this.db
      .select()
      .from(progressSnapshots)
      .where(and(...conds))
      .orderBy(desc(progressSnapshots.date), desc(progressSnapshots.createdAt))
      .all()
      .map((r) => this.rowToSnapshot(r.body));
  }

  getSnapshot(householdId: string, snapId: string): ProgressSnapshot {
    const row = this.db
      .select()
      .from(progressSnapshots)
      .where(and(eq(progressSnapshots.id, snapId), eq(progressSnapshots.householdId, householdId)))
      .get();
    if (!row) throw notFound("snapshot", snapId);
    return this.rowToSnapshot(row.body);
  }

  addSnapshot(input: unknown, opts: { silent?: boolean } = {}): ProgressSnapshot {
    const snap = ProgressSnapshot.parse({ ...(input as object), createdAt: nowIso() });
    this.get(snap.householdId);
    if (
      this.db
        .select({ id: progressSnapshots.id })
        .from(progressSnapshots)
        .where(eq(progressSnapshots.id, snap.id))
        .get()
    )
      throw conflict(`snapshot '${snap.id}' already exists`);
    this.db
      .insert(progressSnapshots)
      .values({
        id: snap.id,
        householdId: snap.householdId,
        date: snap.date,
        schemaVersion: SCHEMA_VERSION,
        body: snap,
      })
      .run();
    if (!opts.silent)
      this.ctx.events.publish("snapshot.created", {
        snapshotId: snap.id,
        householdId: snap.householdId,
        date: snap.date,
        netWorth: snap.netWorth,
        source: snap.source,
      });
    return snap;
  }

  createSnapshot(householdId: string, input: SnapshotCreate): ProgressSnapshot {
    return this.addSnapshot({ ...input, id: input.id ?? newId("snap"), householdId });
  }

  /** Record a snapshot of the household's current finances ("net worth today"). */
  recordCurrent(
    householdId: string,
    opts: { date?: string; note?: string; source?: ProgressSnapshot["source"] } = {},
    _actor?: Actor,
  ): ProgressSnapshot {
    const { finances } = this.get(householdId);
    const date = opts.date ?? nowIso().slice(0, 10);
    const source = opts.source ?? "api";
    return this.addSnapshot(
      snapshotFromFinances(
        householdId,
        finances,
        date,
        source,
        opts.note,
        this.get(householdId).household.currency,
      ),
    );
  }

  updateSnapshot(
    householdId: string,
    snapId: string,
    body: Record<string, unknown>,
    mode: "replace" | "merge",
  ): ProgressSnapshot {
    const cur = this.getSnapshot(householdId, snapId);
    const merged = mode === "merge" ? mergePatch(cur, body) : body;
    const next = ProgressSnapshot.parse({
      ...(merged as object),
      id: snapId,
      householdId,
      createdAt: cur.createdAt,
    });
    this.db
      .update(progressSnapshots)
      .set({ date: next.date, body: next })
      .where(eq(progressSnapshots.id, snapId))
      .run();
    return next;
  }

  deleteSnapshot(householdId: string, snapId: string): void {
    this.getSnapshot(householdId, snapId);
    this.db.delete(progressSnapshots).where(eq(progressSnapshots.id, snapId)).run();
  }

  /** Bulk import (backfill history). `onConflict` decides what happens when an id already exists. */
  bulkImportSnapshots(
    householdId: string,
    items: SnapshotCreate[],
    onConflict: "skip" | "replace" | "error",
  ) {
    this.get(householdId);
    const result = { created: 0, replaced: 0, skipped: 0 };
    this.db.transaction(() => {
      for (const item of items) {
        const id = item.id ?? newId("snap");
        const exists = this.db
          .select({ id: progressSnapshots.id })
          .from(progressSnapshots)
          .where(eq(progressSnapshots.id, id))
          .get();
        if (exists) {
          if (onConflict === "error") throw conflict(`snapshot '${id}' already exists`);
          if (onConflict === "skip") {
            result.skipped++;
            continue;
          }
          this.db.delete(progressSnapshots).where(eq(progressSnapshots.id, id)).run();
          result.replaced++;
        } else result.created++;
        const snap = ProgressSnapshot.parse({ ...item, id, householdId, createdAt: nowIso() });
        this.db
          .insert(progressSnapshots)
          .values({ id, householdId, date: snap.date, schemaVersion: SCHEMA_VERSION, body: snap })
          .run();
      }
    });
    return result;
  }

  /**
   * The date imports measure "the future" and "today" by: the caller's date when it is within a day of the
   * server's (time zones), else the server's (UTC).
   */
  resolveToday(callerToday?: string): string {
    const server = nowIso().slice(0, 10);
    if (!callerToday) return server;
    const gap = Math.abs(
      Date.parse(`${callerToday}T00:00:00Z`) - Date.parse(`${server}T00:00:00Z`),
    );
    if (!(gap <= 864e5))
      throw new ApiError(400, "VALIDATION", "`today` must be within one day of the server's date");
    return callerToday;
  }

  /**
   * Balance-history import (`@glideworth/importers` planHistoryImport): merge or replace per-account values
   * over time. A dry run plans and returns the diff; an apply re-plans inside one transaction and writes it,
   * so a repeat of the same request changes nothing. Errors name dates, keys and cells, never stored values.
   */
  importBalanceHistory(
    householdId: string,
    input: {
      rows: HistoryRow[];
      mode: "merge" | "replace";
      dryRun: boolean;
      updateCurrent: boolean;
      today: string;
    },
    actor: Actor,
    pre: { issues?: HistoryIssue[]; blocked?: boolean } = {},
  ): Omit<BalanceHistoryImportResult, "parse"> {
    const run = () => {
      const { household, finances } = this.get(householdId);
      const targets = historyTargets(finances, household.currency);
      const plan = planHistoryImport({
        existing: this.listSnapshots(householdId),
        rows: input.rows,
        mode: input.mode,
        targets,
        today: input.today,
        updateCurrent: input.updateCurrent,
      });
      const issues = [...(pre.issues ?? []), ...plan.issues];
      const blocked = !!pre.blocked || issues.some((i) => i.severity === "error");
      const result = {
        dryRun: input.dryRun,
        applied: false,
        mode: input.mode,
        blocked,
        range: plan.range,
        counts: plan.counts,
        changes: plan.changes
          .slice(0, 500)
          .map((c) => ({ ...c, label: historyKeyLabel(c.key, targets) })),
        changesTruncated: plan.changes.length > 500,
        currentBalances: plan.current
          ? {
              accounts: plan.current.accounts.length,
              realAssets: plan.current.realAssets.length,
              debts: plan.current.debts.length,
            }
          : null,
        issues: issues.slice(0, 200),
      };
      if (input.dryRun) return result;
      if (blocked)
        throw new ApiError(
          422,
          "IMPORT_FAILED",
          "the import has errors and nothing was written; run it with dryRun=true to see them",
          { issues: issues.filter((i) => i.severity === "error").slice(0, 50) },
        );
      const createdAt = nowIso();
      for (const d of plan.create) {
        const snap = ProgressSnapshot.parse({ ...d, id: newId("snap"), householdId, createdAt });
        this.db
          .insert(progressSnapshots)
          .values({
            id: snap.id,
            householdId,
            date: snap.date,
            schemaVersion: SCHEMA_VERSION,
            body: snap,
          })
          .run();
      }
      for (const u of plan.update) {
        const snap = ProgressSnapshot.parse({ ...u, householdId });
        this.db
          .update(progressSnapshots)
          .set({ date: snap.date, body: snap })
          .where(
            and(eq(progressSnapshots.id, snap.id), eq(progressSnapshots.householdId, householdId)),
          )
          .run();
      }
      for (const id of plan.remove)
        this.db
          .delete(progressSnapshots)
          .where(and(eq(progressSnapshots.id, id), eq(progressSnapshots.householdId, householdId)))
          .run();
      if (plan.current)
        this.updateBalances(
          householdId,
          BalanceUpdate.parse({ ...plan.current, recordSnapshot: false }),
          undefined,
          actor,
        );
      return { ...result, applied: true };
    };
    return input.dryRun ? run() : this.db.transaction(run);
  }

  // ----------------------------------------------------------------------------- document export / import
  getDocument(householdId: string): GlideworthDocument {
    const { household, finances } = this.get(householdId);
    return {
      app: "glideworth",
      schemaVersion: SCHEMA_VERSION,
      exportedAt: nowIso(),
      household,
      finances,
      plans: this.plans.list({ householdId }),
      progress: [...this.listSnapshots(householdId)].reverse(),
      settings: this.settings.get(),
    };
  }

  /**
   * Load a whole document.
   *  - `create` (default): 409 when the household exists.
   *  - `replace`: the document becomes the household (finances, people, snapshots, plans); plans that are
   *    not in it are removed. Plans that are in it KEEP their version history: the import is recorded as
   *    the next version ('imported').
   *  - `merge`: like replace for the household body, finances and the plans in the document, but plans
   *    and snapshots that are not in the document are kept, and settings are left alone.
   * Everything happens in one transaction. `validated`: `raw` is already the output of `migrateDocument` (the
   * imports validate in a worker thread), so it is not parsed again on the request thread.
   */
  importDocument(
    raw: unknown,
    actor: Actor,
    mode: "create" | "replace" | "merge" = "create",
    opts: { validated?: boolean } = {},
  ): GlideworthDocument {
    const doc = opts.validated ? (raw as GlideworthDocument) : migrateDocument(raw);
    const hid = doc.household.id;
    // A document is one household: every plan in it must belong to that household. Say so instead of
    // failing on the database's foreign key (a hand-edited file that renamed the household).
    const stray = doc.plans.filter((p) => p.householdId !== hid);
    if (stray.length)
      throw new ApiError(
        422,
        "IMPORT_FAILED",
        `plan${stray.length === 1 ? "" : "s"} ${stray.map((p) => `'${p.id}'`).join(", ")} belong${stray.length === 1 ? "s" : ""} to household '${stray[0]!.householdId}', not to the document's household '${hid}'. Set each plan's householdId to '${hid}'.`,
        { householdId: hid, planIds: stray.map((p) => p.id) },
      );
    this.db.transaction(() => {
      const existing = this.db.select().from(households).where(eq(households.id, hid)).get();
      if (!existing || mode === "create") {
        this.create({ household: doc.household, finances: doc.finances });
      } else {
        const ts = nowIso();
        const household = Household.parse({
          ...doc.household,
          createdAt: existing.createdAt,
          updatedAt: ts,
        });
        const finances = CurrentFinances.parse({ ...doc.finances, updatedAt: ts });
        this.db
          .update(households)
          .set({
            name: household.name,
            body: household,
            finances,
            version: existing.version + 1,
            updatedAt: ts,
          })
          .where(eq(households.id, hid))
          .run();
        if (mode === "replace") {
          const keep = new Set(doc.plans.map((p) => p.id));
          for (const p of this.plans.list({ householdId: hid }))
            if (!keep.has(p.id)) this.db.delete(plans).where(eq(plans.id, p.id)).run();
          this.db.delete(progressSnapshots).where(eq(progressSnapshots.householdId, hid)).run();
        }
      }
      for (const p of doc.plans) {
        // Branch lineage is restored as stored (the body is already materialised).
        this.plans.insertImported(p, actor);
      }
      for (const s of doc.progress) {
        if (mode === "merge")
          this.db.delete(progressSnapshots).where(eq(progressSnapshots.id, s.id)).run();
        this.addSnapshot({ ...s, householdId: hid }, { silent: true });
      }
      if (mode !== "merge") this.settings.put(doc.settings);
    });
    return doc;
  }
}
