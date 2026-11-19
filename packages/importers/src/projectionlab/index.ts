/**
 * ProjectionLab export importer (workstream f).
 *
 * Source shape (observed in a real v4.6 export; summarised in docs/WORKPLAN.md §f):
 *   meta{version}, today{savingsAccounts[], investmentAccounts[], assets[], debts[], partner fields},
 *   plans[]{accounts.events[], assets.events[], income.events[], expenses.events[],
 *           priorities.events[] (= Flows), milestones[], computedMilestones[], withdrawalStrategy{},
 *           montecarlo{}, variables{}},
 *   settings{ci{currency,locale}, montecarlo{outcomeTypes,...}}, progress{data[]}.
 * Dates are {type:'keyword'|'date'|'year'|'milestone', value, modifier:'include'|'exclude'}.
 * Amount types: 'today$' => real basis. Rates are percentages (8 = 8%).
 *
 * Privacy: values from the source are only ever copied into the produced document. Issue messages
 * carry key paths and enum values, never names, ids or amounts. `settings.plugins.apiKey` is
 * discarded and never read.
 */
import {
  defaultsForCountry,
  GlideworthDocument,
  SCHEMA_VERSION,
  ValidationError,
} from "@glideworth/core";
import type {
  ImportCount,
  ImportIssue,
  ImportIssueCategory,
  ImportReport,
  ImportResult,
} from "../types.js";
import { IdRegistry } from "../util/ids.js";
import { arr, isObj, num, type Obj, obj, str } from "../util/read.js";
import { mapAccounts, mapPlanAccounts } from "./accounts.js";
import { mapAssets, mapPlanAssets } from "./assets.js";
import { appearanceOf } from "./common.js";
import {
  approximated,
  indexPlanReferences,
  infoNote,
  invalid,
  note,
  type PlanScope,
  type PlContext,
} from "./context.js";
import {
  buildCoverage,
  classifyPath,
  clipPath,
  collectKeyPaths,
  MAX_KEY_PATHS,
  OVERFLOW_KEY_PATH,
  overflowsKeyPaths,
} from "./coverage.js";
import { toMonth } from "./dates.js";
import { mapDebts, mapPlanDebtEvent } from "./debts.js";
import { mapExpenseEvent, mapIncomeEvent } from "./events.js";
import { mapFlow } from "./flows.js";
import { mapMilestones, registerMilestones } from "./milestones.js";
import { mapProgress } from "./progress.js";
import {
  mapDrawdown,
  mapFlexSpending,
  mapMonteCarlo,
  mapOutcomeCategories,
  mapWithdrawalStrategy,
} from "./strategies.js";
import { mapAssumptions, mapTax } from "./variables.js";

export {
  buildCoverage,
  classifyPath,
  collectKeyPaths,
  MAX_KEY_PATH_CHARS,
  MAX_KEY_PATHS,
  OVERFLOW_KEY_PATH,
  RULES,
  type Rule,
} from "./coverage.js";

export function detectProjectionLabExport(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return typeof r.today === "object" && Array.isArray(r.plans) && typeof r.meta === "object";
}

/**
 * Largest export the importer takes (security review: hostile-input cost of the importers). Each plan lists
 * or excludes every Current Finances item, so the work and the document grow with plans times items: 2,000
 * plans and 2,000 accounts took seconds and a few thousand more ran out of memory. Mapping an event or a
 * progress entry costs about 10 microseconds, so a few hundred thousand of them held the server for seconds.
 * A larger export is a `ValidationError` before anything is mapped. Real exports have a handful of plans,
 * tens of items and hundreds of events.
 */
export const PROJECTIONLAB_LIMITS = {
  /** `plans[]`. */
  plans: 100,
  /** Each of: accounts (`today.savingsAccounts` and `today.investmentAccounts` together), `today.assets`, `today.debts`. */
  itemsPerKind: 500,
  /** Events and milestones of all plans together. */
  events: 20_000,
  /** `progress.data[]`. */
  progress: 20_000,
} as const;

function checkLimits(raw: Obj): void {
  const today = obj(raw.today);
  const plans = arr(raw.plans);
  let events = 0;
  for (const p of plans) {
    const plan = obj(p);
    for (const section of ["accounts", "assets", "income", "expenses", "priorities"])
      events += arr(obj(plan[section]).events).length;
    events += arr(plan.milestones).length + arr(plan.computedMilestones).length;
  }
  const counts: [string, number, number][] = [
    ["plans", plans.length, PROJECTIONLAB_LIMITS.plans],
    [
      "accounts",
      arr(today.savingsAccounts).length + arr(today.investmentAccounts).length,
      PROJECTIONLAB_LIMITS.itemsPerKind,
    ],
    ["assets", arr(today.assets).length, PROJECTIONLAB_LIMITS.itemsPerKind],
    ["debts", arr(today.debts).length, PROJECTIONLAB_LIMITS.itemsPerKind],
    ["plan events and milestones", events, PROJECTIONLAB_LIMITS.events],
    ["progress entries", arr(obj(raw.progress).data).length, PROJECTIONLAB_LIMITS.progress],
  ];
  for (const [what, n, max] of counts)
    if (n > max)
      throw new ValidationError(
        `the export has ${n.toLocaleString("en-US")} ${what}; at most ${max.toLocaleString("en-US")} can be imported`,
        { limit: max, count: n, kind: what },
      );
}

export interface ImportProjectionLabOptions {
  /** Id for the produced household. */
  householdId?: string;
  /** ISO timestamp used only when the export carries no usable date (the importer never reads a clock). */
  now?: string;
}

const KNOWN_MAJOR = 4;
/** Notes listing excluded items, per plan and kind; the rest are counted in one more note. */
const MAX_EXCLUSION_NOTES = 20;

function monthOfMs(ms: unknown): string | undefined {
  return typeof ms === "number" ? toMonth(ms) : undefined;
}

function isSet(v: unknown): boolean {
  if (
    v === null ||
    v === undefined ||
    v === false ||
    v === 0 ||
    v === "" ||
    v === "none" ||
    v === "never"
  )
    return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isObj(v)) return Object.keys(v).length > 0;
  return true;
}

/** Notes per key path about unrecognised or unsupported values; the rest are counted in one more note. */
const MAX_NOTES_PER_KEY_PATH = 3;

/**
 * Walk concrete leaves, emitting issues for unsupported / ignored / unknown paths. `paths` is the key-path
 * table of the same value: a path it does not hold was counted as `OVERFLOW_KEY_PATH` and is not descended
 * into. Notes are capped per key path, so one unknown array of a million numbers is three notes and a count,
 * not a million notes (security review: hostile-input cost of the importers).
 */
function reportCoverageIssues(
  ctx: PlContext,
  raw: unknown,
  unknownPaths: Set<string>,
  paths: Map<string, unknown>,
): void {
  const ignoredGroups = new Map<string, { count: number; example: string }>();
  const noted = new Map<
    string,
    {
      count: number;
      severity: ImportIssue["severity"];
      category: ImportIssueCategory;
      message: string;
      code: string;
      suggestedField?: string | undefined;
      example: string;
    }
  >();
  const rules = new Map<string, ReturnType<typeof classifyPath>>();
  const emit = (
    norm: string,
    concrete: string,
    severity: ImportIssue["severity"],
    category: ImportIssueCategory,
    message: string,
    extra: { code: string; suggestedField?: string | undefined },
  ): void => {
    const g = noted.get(norm);
    if (!g) noted.set(norm, { count: 1, severity, category, message, ...extra, example: concrete });
    else g.count += 1;
    if ((g?.count ?? 1) <= MAX_NOTES_PER_KEY_PATH)
      note(ctx, severity, category, concrete, message, extra);
  };
  const walk = (v: unknown, norm: string, concrete: string, depth: number): void => {
    if (overflowsKeyPaths(norm, paths)) {
      emit(
        OVERFLOW_KEY_PATH,
        clipPath(concrete),
        "warning",
        "unrecognised",
        `key path too long, or more distinct key paths than the report lists (${MAX_KEY_PATHS.toLocaleString("en-US")}); not imported`,
        { code: "pl.unrecognised" },
      );
      return;
    }
    const container = Array.isArray(v) ? v.length > 0 : isObj(v) && Object.keys(v).length > 0;
    if (container && depth < 64) {
      if (Array.isArray(v)) {
        for (const [i, x] of v.entries()) walk(x, `${norm}[]`, `${concrete}[${i}]`, depth + 1);
      } else
        for (const k of Object.keys(v as Obj))
          walk((v as Obj)[k], `${norm}.${k}`, `${concrete}.${k}`, depth + 1);
      return;
    }
    // Leaf (primitive or empty container).
    if (unknownPaths.has(norm)) {
      emit(
        norm,
        concrete,
        norm.startsWith("$.settings") ? "info" : "warning",
        "unrecognised",
        "key not recognised by this importer (newer export version?); not imported",
        { code: "pl.unrecognised" },
      );
      return;
    }
    let rule = rules.get(norm);
    if (rule === undefined && !rules.has(norm)) {
      rule = classifyPath(norm);
      rules.set(norm, rule);
    }
    if (!rule) return;
    if (rule.status === "unsupported") {
      const set = isSet(v);
      emit(
        // Set and default values get different notes, so they are capped separately.
        `${norm}\u0000${set ? "set" : "default"}`,
        concrete,
        set ? "warning" : "info",
        "unsupported",
        `${rule.note ?? "no Glideworth equivalent"}${set ? "" : " (value is a default/empty, nothing lost)"}`,
        { code: "pl.unsupported", suggestedField: rule.target },
      );
    } else if (rule.status === "ignored" && norm !== "$.settings.plugins.apiKey") {
      const key = rule.note ?? "ignored";
      const g = ignoredGroups.get(key);
      if (g) g.count += 1;
      else ignoredGroups.set(key, { count: 1, example: concrete });
    }
  };
  walk(raw, "$", "$", 0);
  for (const g of noted.values()) {
    if (g.count <= MAX_NOTES_PER_KEY_PATH) continue;
    note(
      ctx,
      g.severity,
      g.category,
      g.example,
      `${g.count - MAX_NOTES_PER_KEY_PATH} more value(s) at this key path: ${g.message}`,
      {
        code: g.code,
        ...(g.suggestedField !== undefined ? { suggestedField: g.suggestedField } : {}),
      },
    );
  }
  for (const [reason, g] of ignoredGroups) {
    note(
      ctx,
      "info",
      "dropped",
      g.example,
      `${g.count} source value(s) intentionally not imported: ${reason}`,
      { code: "pl.ignored" },
    );
  }
  const settings = obj(obj(raw).settings);
  if (isObj(settings.plugins) && "apiKey" in settings.plugins) {
    note(
      ctx,
      "info",
      "dropped",
      "$.settings.plugins.apiKey",
      "API key discarded (never copied into the document or this report)",
      {
        code: "pl.secret-discarded",
      },
    );
  }
}

function issueCounts(issues: ImportIssue[]): Record<ImportIssueCategory, number> {
  const out: Record<ImportIssueCategory, number> = {
    dropped: 0,
    approximated: 0,
    unsupported: 0,
    unrecognised: 0,
    defaulted: 0,
    invalid: 0,
    info: 0,
  };
  for (const i of issues) out[i.category ?? "info"] += 1;
  return out;
}

/**
 * Exchange rates from `settings.ci.exchangeRates` / `fxRates` when the export carries them: either a
 * map `{ "EUR": 0.85 }` (1 EUR = 0.85 of the household currency) or a list of
 * `{ from, to, rate, annualDrift? }` pairs.
 */
function mapFxRates(
  ctx: PlContext,
  ci: Obj,
): { from: string; to: string; rate: number; annualDrift?: number }[] {
  const raw = ci.exchangeRates ?? ci.fxRates;
  const out: { from: string; to: string; rate: number; annualDrift?: number }[] = [];
  const code = (x: unknown) => {
    const c = str(x)?.toUpperCase();
    return c && /^[A-Z]{3}$/.test(c) ? c : undefined;
  };
  if (Array.isArray(raw)) {
    raw.forEach((r, i) => {
      const o = obj(r);
      const from = code(o.from);
      const to = code(o.to) ?? ctx.currency;
      const rate = num(o.rate);
      if (!from || rate === undefined || !(rate > 0)) {
        invalid(
          ctx,
          `$.settings.ci.exchangeRates[${i}]`,
          "exchange rate without a currency or a positive rate; dropped",
        );
        return;
      }
      const drift = num(o.annualDrift);
      out.push({ from, to, rate, ...(drift !== undefined ? { annualDrift: drift } : {}) });
    });
  } else if (isObj(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      const from = code(k);
      const rate = num(v);
      if (!from || rate === undefined || !(rate > 0)) {
        invalid(
          ctx,
          `$.settings.ci.exchangeRates.${k}`,
          "exchange rate without a currency or a positive rate; dropped",
        );
        continue;
      }
      if (from !== ctx.currency) out.push({ from, to: ctx.currency, rate });
    }
  }
  return out;
}

export function importProjectionLab(
  raw: unknown,
  options: ImportProjectionLabOptions = {},
): ImportResult {
  if (!isObj(raw) || (!isObj(raw.today) && !Array.isArray(raw.plans))) {
    throw new ValidationError(
      "not a ProjectionLab export: expected an object with `today` and `plans`",
    );
  }
  checkLimits(raw);
  const issues: ImportIssue[] = [];
  const meta = obj(raw.meta);
  const version = str(meta.version);
  const today = obj(raw.today);
  const settings = obj(raw.settings);
  const sources = arr(raw.plans);

  // --- coverage (structure only) -------------------------------------------------------------
  const paths = collectKeyPaths(raw);
  const coverage = buildCoverage(paths);

  const ctx: PlContext = {
    issues,
    primaryId: "me",
    country: "XX",
    currency: "USD",
    foreignCurrencies: new Set(),
    asOf: "2000-01",
    accountIds: new IdRegistry(),
    assetIds: new IdRegistry(),
    debtIds: new IdRegistry(),
    planIds: new IdRegistry(),
    knownAccounts: new Set(),
    knownAssets: new Set(),
    knownDebts: new Set(),
  };

  if (!version)
    infoNote(
      ctx,
      "$.meta.version",
      "export has no version; imported on a best-effort basis",
      "pl.no-version",
    );
  else if (Number.parseInt(version, 10) !== KNOWN_MAJOR) {
    note(
      ctx,
      "warning",
      "info",
      "$.meta.version",
      `export version ${version}: this importer targets ${KNOWN_MAJOR}.x; unknown differences are reported as unrecognised keys`,
      {
        code: "pl.version",
      },
    );
  }

  // --- household ---------------------------------------------------------------------------
  const asOf =
    monthOfMs(today.lastUpdated) ??
    monthOfMs(meta.lastUpdated) ??
    toMonth(options.now) ??
    undefined;
  if (asOf) ctx.asOf = asOf;
  else
    invalid(
      ctx,
      "$.today.lastUpdated",
      "export has no usable date and no `now` option was given; 2000-01 used as the balance month",
    );

  const birth = (y: unknown, m: unknown): string | undefined => {
    const yy = num(y);
    const mm = num(m);
    if (yy === undefined) return undefined;
    return `${String(Math.trunc(yy)).padStart(4, "0")}-${String(Math.min(12, Math.max(1, Math.trunc(mm ?? 1)))).padStart(2, "0")}`;
  };
  let primaryBirth = birth(today.birthYear, today.birthMonth);
  if (!primaryBirth) {
    const age = num(today.age);
    const y = age !== undefined ? Number(ctx.asOf.slice(0, 4)) - Math.round(age) : 1990;
    primaryBirth = `${y}-01`;
    invalid(ctx, "$.today.birthYear", "birth date missing; an approximate birth month was derived");
  }
  const partnerBirth = birth(today.spouseBirthYear, today.spouseBirthMonth);
  const couple = today.partnerStatus === "couple" && partnerBirth !== undefined;
  if (today.partnerStatus === "couple" && !partnerBirth) {
    invalid(
      ctx,
      "$.today.spouseBirthYear",
      "partnerStatus is 'couple' but the partner has no birth date; imported as an individual",
    );
  }
  if (couple) ctx.partnerId = "spouse";
  const people: Obj[] = [
    {
      id: ctx.primaryId,
      name: (str(today.yourName) ?? "Me").trim().slice(0, 80) || "Me",
      role: "primary",
      birthMonth: primaryBirth,
      ...(appearanceOf({ color: today.yourColor, icon: today.yourIcon })
        ? { appearance: appearanceOf({ color: today.yourColor, icon: today.yourIcon }) }
        : {}),
    },
  ];
  if (couple) {
    people.push({
      id: "spouse",
      name: (str(today.spouseName) ?? "Partner").trim().slice(0, 80) || "Partner",
      role: "partner",
      birthMonth: partnerBirth,
      ...(appearanceOf({ color: today.spouseColor, icon: today.spouseIcon })
        ? { appearance: appearanceOf({ color: today.spouseColor, icon: today.spouseIcon }) }
        : {}),
    });
  }
  const loc = obj(today.location);
  const rawCountry = str(loc.country);
  let country = "XX";
  if (rawCountry === "UK") country = "GB";
  else if (rawCountry && /^[A-Z]{2}$/.test(rawCountry)) country = rawCountry;
  else if (rawCountry && rawCountry !== "OTHER")
    invalid(
      ctx,
      "$.today.location.country",
      `unrecognised country '${rawCountry}'; using the custom jurisdiction 'XX'`,
    );
  ctx.country = country;
  const location: Obj = { country };
  const region = str(loc.region ?? loc.state);
  if (region) location.region = region.slice(0, 10);
  const locality = str(loc.locality ?? loc.city);
  if (locality) location.locality = locality.slice(0, 40);

  const ci = obj(settings.ci);
  const currency = str(ci.currency);
  if (currency && /^[A-Z]{3}$/.test(currency)) ctx.currency = currency;
  else invalid(ctx, "$.settings.ci.currency", "currency missing or invalid; USD assumed");
  const locale = str(ci.locale) ?? "en-US";
  if (!str(ci.locale)) invalid(ctx, "$.settings.ci.locale", "locale missing; en-US assumed");

  const householdId = options.householdId ?? "household";
  const household: Obj = {
    id: householdId,
    name: `${(str(today.yourName) ?? "My").trim()}${str(today.yourName) ? "'s household" : " household"}`.slice(
      0,
      120,
    ),
    planningMode: couple ? "couple" : "individual",
    people,
    dependents: [],
    location,
    currency: ctx.currency,
    locale,
  };

  const countryDefaults = defaultsForCountry(country, {
    region: location.region as string | undefined,
  });
  if (countryDefaults.country !== "US")
    infoNote(
      ctx,
      "$.today.location.country",
      `chance-of-success runs use ${countryDefaults.monteCarlo.dataset} market history for this country. ${countryDefaults.monteCarlo.note}`,
      "pl.dataset-country",
    );

  // --- current finances ------------------------------------------------------------------------
  const accounts = mapAccounts(ctx, today);
  const assets = mapAssets(ctx, today);
  const debts = mapDebts(ctx, today);
  const finances: Obj = {
    asOf: ctx.asOf,
    accounts: accounts.map((a) => a.account),
    realAssets: assets.map((a) => a.asset),
    debts: debts.map((d) => d.debt),
  };
  const fxRates = mapFxRates(ctx, ci);
  if (fxRates.length > 0) finances.fxRates = fxRates;
  const lastUpdated = num(today.lastUpdated);
  if (lastUpdated !== undefined && !Number.isNaN(new Date(lastUpdated).getTime())) {
    finances.updatedAt = new Date(lastUpdated).toISOString();
  }

  // --- plans -----------------------------------------------------------------------------------
  let mainIndex = sources.findIndex((p) => obj(p).active === true);
  if (mainIndex < 0 && sources.length > 0) {
    mainIndex = 0;
    infoNote(
      ctx,
      "$.plans",
      "no plan is marked active in the export; the first plan is the main plan",
      "pl.no-active-plan",
    );
  }
  const counts = { income: 0, expenses: 0, debtLinked: 0, flows: 0, milestones: 0 };
  const srcCounts = { income: 0, expenses: 0, flows: 0, milestones: 0 };
  const plans: Obj[] = sources.map((rawPlan, index) => {
    const plan = obj(rawPlan);
    const path = `$.plans[${index}]`;
    const scope: PlanScope = {
      index,
      path,
      milestoneIds: new IdRegistry(),
      knownMilestones: new Set(),
      eventIds: new IdRegistry(),
      accountAlias: new Map(),
      assetAlias: new Map(),
      debtAlias: new Map(),
      plannedAccounts: new Set(),
    };
    ctx.plan = scope;
    indexPlanReferences(ctx, plan);
    registerMilestones(ctx, plan);
    const milestones = mapMilestones(ctx, plan, path);
    srcCounts.milestones += arr(plan.milestones).length + arr(plan.computedMilestones).length;
    counts.milestones += milestones.length;

    const accountEvents = arr(obj(plan.accounts).events);
    const acct = mapPlanAccounts(ctx, accountEvents, `${path}.accounts.events`, accounts);
    const assetEvents = arr(obj(plan.assets).events);
    const ast = mapPlanAssets(ctx, assetEvents, `${path}.assets.events`, assets);

    const incomeSrc = arr(obj(plan.income).events);
    const income = incomeSrc.map((e, i) =>
      mapIncomeEvent(ctx, e, `${path}.income.events[${i}]`, i),
    );
    srcCounts.income += incomeSrc.length;
    counts.income += income.length;
    const incomeIds = new Map<string, string>();
    for (const e of incomeSrc) {
      const sid = str(obj(e).id);
      if (sid) incomeIds.set(sid, scope.eventIds.get(sid, "income"));
    }

    const expenseSrc = arr(obj(plan.expenses).events);
    const expenses: Obj[] = [];
    const debtSettings: Record<string, Obj> = {};
    const presentDebts = new Set<string>();
    let debtEventCount = 0;
    expenseSrc.forEach((e, i) => {
      const epath = `${path}.expenses.events[${i}]`;
      const es = obj(e);
      if (es.type === "debt") {
        const r = mapPlanDebtEvent(ctx, es, epath, debts);
        if (r) {
          counts.debtLinked += 1;
          debtEventCount += 1;
          presentDebts.add(str(es.debtId)!);
          if (Object.keys(r.patch).length > 0) debtSettings[r.debtId] = r.patch;
          return;
        }
      }
      expenses.push(mapExpenseEvent(ctx, e, epath, i, incomeIds));
    });
    srcCounts.expenses += expenseSrc.length;
    counts.expenses += expenses.length;

    const flows: Obj[] = [];
    const prioritySrc = arr(obj(plan.priorities).events);
    prioritySrc.forEach((e, i) => {
      const f = mapFlow(ctx, e, `${path}.priorities.events[${i}]`, i);
      if (f) flows.push(f);
    });
    srcCounts.flows += prioritySrc.length;
    counts.flows += flows.length;

    // Exclusions: Current Finances items the plan does not list. The excluded ids are part of the plan;
    // the notes about them are capped per plan and kind, so plans times items cannot grow the report
    // without bound (security review: hostile-input cost of the importers).
    const excludedIds: string[] = [];
    const exclude = (
      items: { id: string; present: boolean }[],
      kind: "account" | "asset" | "debt",
      notePath: string,
    ): void => {
      let noted = 0;
      for (const { id, present } of items) {
        if (present) continue;
        excludedIds.push(id);
        if (noted++ < MAX_EXCLUSION_NOTES)
          infoNote(
            ctx,
            notePath,
            `${kind} ${id} is not listed in this plan; excluded from it`,
            `pl.excluded-${kind}`,
          );
      }
      if (noted > MAX_EXCLUSION_NOTES)
        infoNote(
          ctx,
          notePath,
          `${noted - MAX_EXCLUSION_NOTES} more ${kind}s are not listed in this plan; excluded from it`,
          `pl.excluded-${kind}`,
        );
    };
    if (accountEvents.length > 0)
      exclude(
        accounts.map((a) => ({
          id: a.account.id as string,
          present: acct.present.has(a.sourceId),
        })),
        "account",
        `${path}.accounts.events`,
      );
    if (assetEvents.length > 0)
      exclude(
        assets.map((a) => ({ id: a.asset.id as string, present: ast.present.has(a.sourceId) })),
        "asset",
        `${path}.assets.events`,
      );
    if (debtEventCount > 0)
      exclude(
        debts.map((d) => ({ id: d.debt.id as string, present: presentDebts.has(d.sourceId) })),
        "debt",
        `${path}.expenses.events`,
      );

    const variables = obj(plan.variables);
    const assumptions = mapAssumptions(
      ctx,
      variables,
      `${path}.variables`,
      obj(settings.plan).alignment,
    );
    const tax = mapTax(ctx, variables, `${path}.variables`, couple ? "couple" : "individual");
    const cash = str(variables.cashFlowDefault);
    let leftover: Obj = { kind: "save" };
    if (cash === "spend") leftover = { kind: "spend" };
    else if (cash !== undefined && cash !== "save")
      invalid(
        ctx,
        `${path}.variables.cashFlowDefault`,
        `unknown leftover policy '${cash}'; using save`,
      );

    if (
      str(plan.startingConditionsType) !== undefined &&
      plan.startingConditionsType !== "default"
    ) {
      approximated(
        ctx,
        `${path}.startingConditionsType`,
        `starting conditions '${String(plan.startingConditionsType)}' are not representable; the plan reads live Current Finances`,
        "pl.starting-conditions",
      );
    }
    if (isObj(plan.startingConditions) && Object.keys(plan.startingConditions).length > 0) {
      approximated(
        ctx,
        `${path}.startingConditions`,
        "plan-specific starting conditions are not representable; the plan reads live Current Finances",
        "pl.starting-conditions",
      );
    }
    if (str(variables.projectFrom) !== undefined && variables.projectFrom !== "now") {
      approximated(
        ctx,
        `${path}.variables.projectFrom`,
        `projection start '${String(variables.projectFrom)}' is not representable; projecting from the balance month`,
        "pl.project-from",
      );
    }

    const out: Obj = {
      id: ctx.planIds.get(str(plan.id), `plan-${index + 1}`),
      householdId,
      name: (str(plan.name) ?? `Plan ${index + 1}`).slice(0, 120),
      isMain: index === mainIndex,
      status: "active",
      startingConditions: { kind: "live" },
      milestones,
      income,
      expenses,
      flows,
      leftover,
      accountSettings: acct.accountSettings,
      plannedAccounts: acct.plannedAccounts,
      realAssetSettings: ast.realAssetSettings,
      plannedRealAssets: ast.plannedRealAssets,
      debtSettings,
      excludedIds,
      assumptions,
      tax,
      // ProjectionLab exports carry no historical dataset: use the country default
      // (defaultsForCountry; for UK households US 1928-2025 in real terms, with the reason in its note).
      monteCarlo: {
        dataset: countryDefaults.monteCarlo.dataset,
        ...mapMonteCarlo(
          ctx,
          plan.montecarlo,
          `${path}.montecarlo`,
          obj(settings.montecarlo),
          scope.knownMilestones,
        ),
      },
      version: 0,
    };
    const icon = appearanceOf({ icon: plan.icon });
    if (icon) out.appearance = icon;
    const drawdown = mapDrawdown(
      ctx,
      variables.drawdownOrder,
      `${path}.variables.drawdownOrder`,
      accounts,
    );
    if (drawdown) out.drawdown = drawdown;
    const ws = mapWithdrawalStrategy(ctx, plan.withdrawalStrategy, `${path}.withdrawalStrategy`);
    if (ws) out.withdrawalStrategy = ws;
    const flex = mapFlexSpending(ctx, variables.flexSpending, `${path}.variables.flexSpending`);
    if (flex) out.flexSpending = flex;
    ctx.plan = undefined;
    return out;
  });

  // Foreign-currency entities need an FX rate to simulate (the engine refuses a missing pair).
  // Currencies with a rate to or from the household currency, collected once: searching every rate for each
  // currency took time proportional to their product on a crafted export.
  const ratedCurrencies = new Set<string>();
  for (const r of fxRates) {
    if (r.to === ctx.currency) ratedCurrencies.add(r.from);
    if (r.from === ctx.currency) ratedCurrencies.add(r.to);
  }
  for (const c of ctx.foreignCurrencies ?? []) {
    const known = ratedCurrencies.has(c);
    if (!known)
      note(
        ctx,
        "warning",
        "invalid",
        "$.settings.ci",
        `entities in ${c} but no ${c}/${ctx.currency} exchange rate; add one to the FX rates before simulating`,
        {
          code: "pl.fx-missing",
        },
      );
  }
  // Event amounts may not be negative in Glideworth (a negative salary or expense is a data error).
  for (const p of plans)
    for (const key of ["income", "expenses"] as const)
      for (const e of (p[key] as Obj[] | undefined) ?? []) {
        const amt = e.amount as { value?: unknown } | undefined;
        if (amt && typeof amt.value === "number" && amt.value < 0) {
          approximated(
            ctx,
            `$.plans[].${key}.events[]`,
            "an event has a negative amount; imported as 0",
            "pl.negative-amount",
          );
          amt.value = 0;
        }
      }

  if (plans.length > 0) {
    infoNote(
      ctx,
      "$.plans",
      "Glideworth credits each year's savings and withdrawals with half a year of growth (mid-year cash-flow timing), so year-end balances can differ slightly from ProjectionLab's; set the plan's cash-flow timing to 'end' to compare like for like",
      "pl.convention-timing",
    );
    infoNote(
      ctx,
      "$.plans",
      "milestones based on balances or net worth are checked on each year's closing figures, so income, expenses and savings tied to them change from the following year",
      "pl.convention-milestones",
    );
  }

  // --- progress + settings -------------------------------------------------------------------
  const progress = mapProgress(ctx, raw.progress, householdId);
  const docSettings: Obj = {
    onboarding: { completed: settings.completedOnboarding === true },
    locale,
  };
  if (settings.theme === "dark" || settings.theme === "light" || settings.theme === "system")
    docSettings.theme = settings.theme;
  else if (settings.theme !== undefined)
    invalid(ctx, "$.settings.theme", `unknown theme '${String(settings.theme)}'`);
  if (typeof settings.autoProgress === "boolean")
    docSettings.autoProgressSnapshots = settings.autoProgress;
  const sp = obj(settings.spending);
  const spending: Obj = {};
  if (typeof sp.taxes === "boolean") spending.includeTaxes = sp.taxes;
  if (typeof sp.mortgage === "boolean") spending.includeMortgage = sp.mortgage;
  if (typeof sp.mortgagePrincipal === "boolean")
    spending.includeMortgagePrincipal = sp.mortgagePrincipal;
  if (typeof sp.consumerDebtPrincipal === "boolean")
    spending.includeConsumerDebtPrincipal = sp.consumerDebtPrincipal;
  if (Object.keys(spending).length > 0) docSettings.spending = spending;
  const etr = obj(obj(settings.effectiveTaxRate).tax);
  const effective: Obj = {};
  if (typeof etr.local === "boolean") effective.includeLocal = etr.local;
  if (typeof etr.property === "boolean") effective.includeProperty = etr.property;
  const etrIncome = obj(obj(settings.effectiveTaxRate).income);
  const income: Obj = {};
  for (const k of [
    "taxFreeDistributions",
    "nonTaxableCapitalWithdrawals",
    "nonTaxableSaleProceeds",
  ])
    if (typeof etrIncome[k] === "boolean") income[k] = etrIncome[k];
  if (Object.keys(income).length > 0) effective.income = income;
  if (Object.keys(effective).length > 0) docSettings.effectiveTaxRate = effective;
  const bands = arr(obj(settings.montecarlo).successRates)
    .map((b) => obj(b))
    .filter((b) => typeof b.name === "string" && b.name.length > 0 && num(b.value) !== undefined)
    .map((b) => ({
      name: String(b.name).slice(0, 60),
      minRate: Math.max(0, Math.min(1, (num(b.value) ?? 0) / 100)),
      ...(typeof b.color === "string" ? { color: b.color.slice(0, 40) } : {}),
    }));
  if (bands.length > 0) docSettings.successRateBands = bands;
  const firstVars = obj(obj(sources[0]).variables);
  if (typeof firstVars.showFutureDollars === "boolean")
    docSettings.valueBasis = firstVars.showFutureDollars ? "nominal" : "real";
  const outcomes = mapOutcomeCategories(
    ctx,
    obj(settings.montecarlo).outcomeTypes,
    "$.settings.montecarlo.outcomeTypes",
  );
  if (outcomes) docSettings.outcomeCategories = outcomes;
  if (mainIndex >= 0 && plans[mainIndex]) docSettings.defaultPlanId = plans[mainIndex]!.id;

  // --- generic coverage issues + assemble ------------------------------------------------------
  reportCoverageIssues(ctx, raw, new Set(coverage.unaccountedPaths), paths);

  const candidate = {
    app: "glideworth" as const,
    schemaVersion: SCHEMA_VERSION,
    household,
    finances,
    plans,
    progress,
    settings: docSettings,
  };
  const parsed = GlideworthDocument.safeParse(candidate);
  if (!parsed.success) {
    throw new ValidationError("imported document failed validation", {
      issues: parsed.error.issues,
    });
  }
  const document = parsed.data;

  const count = (source: number, imported: number): ImportCount => ({ source, imported });
  const reportCounts: Record<string, ImportCount> = {
    people: count(couple ? 2 : 1, document.household.people.length),
    accounts: count(
      arr(today.savingsAccounts).length + arr(today.investmentAccounts).length,
      document.finances.accounts.length,
    ),
    realAssets: count(arr(today.assets).length, document.finances.realAssets.length),
    debts: count(arr(today.debts).length, document.finances.debts.length),
    plans: count(sources.length, document.plans.length),
    income: count(srcCounts.income, counts.income),
    expenses: count(srcCounts.expenses, counts.expenses + counts.debtLinked),
    flows: count(srcCounts.flows, counts.flows),
    milestones: count(srcCounts.milestones, counts.milestones),
    progress: count(arr(obj(raw.progress).data).length, document.progress.length),
  };
  const stats: Record<string, number> = {};
  for (const [k, c] of Object.entries(reportCounts)) stats[k] = c.imported;
  const tallies = issueCounts(issues);
  stats.issues = issues.length;
  stats.warnings = issues.filter((i) => i.severity === "warning").length;
  stats.errors = issues.filter((i) => i.severity === "error").length;
  stats.unsupported = tallies.unsupported;

  const report: ImportReport = {
    source: {
      format: "projectionlab",
      version,
      schema: str(String(num(today.schema) ?? "")) || undefined,
    },
    counts: reportCounts,
    issues,
    issueCounts: tallies,
    coverage,
  };
  return { document, issues, stats, report };
}
