import type { ImportIssue, ImportIssueCategory } from "../types.js";
import type { IdRegistry } from "../util/ids.js";

/** Mutable state shared by all ProjectionLab mapping steps for one import. */
export interface PlContext {
  issues: ImportIssue[];
  /** Person ids in the produced household. */
  primaryId: string;
  partnerId?: string;
  country: string;
  currency: string;
  /** Foreign currencies used by entities (each needs an FX rate). */
  foreignCurrencies?: Set<string>;
  /** `YYYY-MM` the balances are as of. */
  asOf: string;
  accountIds: IdRegistry;
  assetIds: IdRegistry;
  debtIds: IdRegistry;
  planIds: IdRegistry;
  /** Source ids of entities present in Current Finances, for dangling-reference checks. */
  knownAccounts: Set<string>;
  knownAssets: Set<string>;
  knownDebts: Set<string>;
  /** Plan-scoped state, set while one plan is being mapped. */
  plan?: PlanScope;
}

export interface PlanScope {
  index: number;
  path: string;
  milestoneIds: IdRegistry;
  /** Source ids of milestones defined in this plan. */
  knownMilestones: Set<string>;
  eventIds: IdRegistry;
  /**
   * Plan events have their own ids, distinct from the Current Finances entity they refer to
   * (`accounts.events[].id` vs `.accountId`), and other plan events reference the EVENT id.
   * These map an event id (or the entity id) to the Current Finances source id.
   */
  accountAlias: Map<string, string>;
  assetAlias: Map<string, string>;
  debtAlias: Map<string, string>;
  /** Source ids of accounts that exist only in this plan. */
  plannedAccounts: Set<string>;
}

/** Resolve a reference found in a plan to the Current Finances (or planned) source id. */
export function resolveSource(
  ctx: PlContext,
  kind: "account" | "asset" | "debt",
  sid: unknown,
): string | undefined {
  if (typeof sid !== "string") return undefined;
  const known =
    kind === "account" ? ctx.knownAccounts : kind === "asset" ? ctx.knownAssets : ctx.knownDebts;
  if (known.has(sid)) return sid;
  const scope = ctx.plan;
  if (!scope) return undefined;
  const alias = (
    kind === "account" ? scope.accountAlias : kind === "asset" ? scope.assetAlias : scope.debtAlias
  ).get(sid);
  if (
    alias !== undefined &&
    (known.has(alias) || (kind === "account" && scope.plannedAccounts.has(alias)))
  )
    return alias;
  if (kind === "account" && scope.plannedAccounts.has(sid)) return sid;
  return undefined;
}

/** Pre-pass: index the plan's own event ids so references between events resolve. */
export function indexPlanReferences(ctx: PlContext, plan: Record<string, unknown>): void {
  const scope = ctx.plan!;
  const events = (v: unknown): Record<string, unknown>[] => {
    const e = (v as { events?: unknown } | undefined)?.events;
    return Array.isArray(e)
      ? e.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
      : [];
  };
  for (const e of events(plan.accounts)) {
    const accountId = typeof e.accountId === "string" ? e.accountId : undefined;
    const id = typeof e.id === "string" ? e.id : undefined;
    const target = accountId ?? id;
    if (!target) continue;
    if (!ctx.knownAccounts.has(target)) scope.plannedAccounts.add(target);
    if (id) scope.accountAlias.set(id, target);
  }
  for (const e of events(plan.assets)) {
    const assetId = typeof e.assetId === "string" ? e.assetId : undefined;
    const id = typeof e.id === "string" ? e.id : undefined;
    if (id && (assetId ?? id)) scope.assetAlias.set(id, assetId ?? id);
  }
  for (const e of events(plan.expenses)) {
    if (e.type !== "debt") continue;
    const debtId = typeof e.debtId === "string" ? e.debtId : undefined;
    const id = typeof e.id === "string" ? e.id : undefined;
    if (id && debtId) scope.debtAlias.set(id, debtId);
  }
}

export function note(
  ctx: PlContext,
  severity: ImportIssue["severity"],
  category: ImportIssueCategory,
  sourcePath: string,
  message: string,
  extra: { code?: string; entityId?: string; suggestedField?: string } = {},
): void {
  ctx.issues.push({ severity, category, sourcePath, message, ...extra });
}

export function approximated(ctx: PlContext, path: string, message: string, code?: string): void {
  note(ctx, "warning", "approximated", path, message, { code: code ?? "pl.approximated" });
}

export function infoNote(ctx: PlContext, path: string, message: string, code?: string): void {
  note(ctx, "info", "info", path, message, { code: code ?? "pl.info" });
}

export function unsupported(
  ctx: PlContext,
  path: string,
  message: string,
  suggestedField: string,
  severity: ImportIssue["severity"] = "warning",
): void {
  note(ctx, severity, "unsupported", path, message, { code: "pl.unsupported", suggestedField });
}

export function defaulted(ctx: PlContext, path: string, message: string): void {
  note(ctx, "info", "defaulted", path, message, { code: "pl.defaulted" });
}

export function invalid(ctx: PlContext, path: string, message: string): void {
  note(ctx, "warning", "invalid", path, message, { code: "pl.invalid" });
}
