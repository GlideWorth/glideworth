import type { ProjectionResult, SimulationInput } from "@glideworth/core";
import { createSampleDocument } from "@glideworth/core/samples";
import { type AppOptions, createApp } from "../src/app.js";
import { insertKey } from "../src/auth.js";
import { openDb } from "../src/db/client.js";
import { type CoreDeps, coreDeps } from "../src/deps.js";
import { inlineExecutor, type JobExecutor } from "../src/jobs/executor.js";
import type { ImportRunnerOption } from "../src/services/imports.js";
import type { AuthOptions } from "../src/services/auth.js";
import type { WebhookOptions } from "../src/services/webhooks.js";
import { Services } from "../src/services.js";

export const WRITE_KEY = "glideworth_testwrit_0123456789abcdef0123456789abcdef";
export const READ_KEY = "glideworth_testread_0123456789abcdef0123456789abcdef";
export const SIM_KEY = "glideworth_testsimu_0123456789abcdef0123456789abcdef";

/**
 * A small deterministic stand-in for the engine so API tests do not depend on the engine's state
 * (workstream a is landing features concurrently). End net worth falls as expenses rise, so
 * change-set previews show a visible before/after difference.
 */
export function fakeSimulate(input: SimulationInput): ProjectionResult {
  const spend = input.plan.expenses
    .filter((e) => e.enabled)
    .reduce((s, e) => s + e.amount.value, 0);
  const income = input.plan.income.filter((e) => e.enabled).reduce((s, e) => s + e.amount.value, 0);
  const endNetWorth =
    2_000_000 +
    income * 5 -
    spend * 20 +
    input.finances.accounts.reduce((s, a) => s + a.balance, 0);
  const periods = [2026, 2036, 2046, 2056].map((year, index) => ({
    index,
    year,
    startMonth: `${year}-01`,
    months: 12,
    ages: { [input.household.people[0]!.id]: 40 + index * 10 },
    alive: {},
    market: {
      stocks: 0.07,
      bonds: 0.03,
      cash: 0.02,
      inflation: 0.03,
      dividendYield: 0.02,
      bondYield: 0.03,
      crypto: 0.05,
    },
    priceIndex: 1.03 ** (index * 10),
    accounts: input.finances.accounts.map((a) => ({
      accountId: a.id,
      category: "cash",
      opening: a.balance,
      contributions: 0,
      withdrawals: 0,
      growth: 0,
      dividends: 0,
      fees: 0,
      transfersIn: 0,
      transfersOut: 0,
      closing: a.balance * (1 + index),
      costBasis: null,
      contributionBasis: null,
      withdrawable: true,
      liquid: true,
    })),
    realAssets: [],
    debts: [],
    income: [],
    expenses: [],
    taxes: {
      total: 1000 * (index + 1),
      lines: [
        {
          jurisdictionId: "us-federal",
          kind: "income",
          label: "Federal income tax",
          amount: 800 * (index + 1),
        },
        { jurisdictionId: "us-state", kind: "income", label: "State", amount: 200 * (index + 1) },
      ],
      grossIncome: income,
      taxableIncome: income * 0.8,
      effectiveRate: 0.2,
      marginalRate: 0.24,
      withheld: 1000,
      settlement: 0,
      facts: {},
    },
    ledgerNodes: [],
    ledger: [],
    milestonesReached: [],
    totals: {
      netWorth: endNetWorth * ((index + 1) / 4),
      liquidNetWorth: endNetWorth * ((index + 1) / 8),
      assets: endNetWorth,
      liabilities: 0,
      portfolio: 1,
      cash: 1,
      realAssets: 0,
      income,
      passiveIncome: 0,
      expenses: spend,
      spending: spend,
      taxes: 1000 * (index + 1),
      contributions: 0,
      withdrawals: 0,
      savingsRate: 0.2,
      withdrawalRate: null,
      shortfall: 0,
      byCategory: {},
    },
    status: "ok" as const,
  }));
  const last = periods[periods.length - 1]!;
  return {
    meta: {
      engineVersion: "fake",
      schemaVersion: 1,
      resolution: "annual",
      planId: input.plan.id,
      planVersion: input.plan.version,
      currency: input.household.currency,
      referenceMonth: "2026-01",
      startMonth: "2026-01",
      endMonth: "2056-12",
      valueBasis: "nominal",
      strict: true,
    },
    periods,
    milestones: input.plan.milestones.map((m) => ({
      milestoneId: m.id,
      name: m.name,
      status: "reached" as const,
      month: "2040-01",
      periodIndex: 1,
      ages: {},
      via: "time" as const,
    })),
    warnings: [],
    summary: {
      success: spend < 100_000,
      firstShortfallYear: spend < 100_000 ? null : 2050,
      totalShortfall: 0,
      endNetWorth: last.totals.netWorth,
      endNetWorthReal: endNetWorth,
      lifetimeTaxes: 10_000,
      lifetimeTaxesReal: 8_000,
      retirementYear: 2045,
    },
    trace: [],
  } as ProjectionResult;
}

export interface SetupOptions {
  /** Use the real engine instead of the fake (default: fake). */
  realEngine?: boolean;
  deps?: Partial<CoreDeps>;
  executor?: JobExecutor;
  /** Where imports are parsed (default: the process's import worker pool). */
  importRunner?: ImportRunnerOption;
  seed?: boolean;
  mcpAllowWrites?: boolean;
  rateLimitPerMinute?: number;
  fetch?: typeof fetch;
  webhooks?: WebhookOptions;
  auth?: AuthOptions;
  appOptions?: Partial<AppOptions>;
}

export interface CallOpts {
  method?: string;
  body?: unknown;
  key?: string | null;
  headers?: Record<string, string>;
}

export function setup(o: SetupOptions = {}) {
  const ctx = openDb(":memory:");
  insertKey(ctx.db, WRITE_KEY, "test-write", ["read", "write"]);
  insertKey(ctx.db, READ_KEY, "test-read", ["read"]);
  insertKey(ctx.db, SIM_KEY, "test-sim", ["simulate"]);
  const deps = {
    ...coreDeps,
    ...(o.realEngine ? {} : { simulate: fakeSimulate }),
    ...o.deps,
  } as CoreDeps;
  const services = new Services(ctx.db, {
    deps,
    executor: o.executor ?? inlineExecutor(deps),
    ...(o.importRunner ? { importRunner: o.importRunner } : {}),
    webhooks: { retryDelaysMs: [0, 0], ...(o.fetch ? { fetch: o.fetch } : {}), ...o.webhooks },
    ...(o.auth ? { auth: o.auth } : {}),
  });
  if (o.seed !== false)
    services.households.importDocument(createSampleDocument(), {
      kind: "system",
      label: "test seed",
    });
  const app = createApp({
    db: ctx.db,
    services,
    mcpAllowWrites: o.mcpAllowWrites ?? false,
    rateLimitPerMinute: o.rateLimitPerMinute ?? 0,
    ...o.appOptions,
  });

  // oxlint-disable-next-line typescript/no-explicit-any -- test payloads are untyped JSON that tests probe freely
  async function call<T = any>(
    path: string,
    c: CallOpts = {},
  ): Promise<{
    status: number;
    json: T;
    text: string;
    headers: { get(name: string): string | null };
  }> {
    const headers: Record<string, string> = { ...(c.headers ?? {}) };
    if (c.key !== null) headers.authorization = `Bearer ${c.key ?? WRITE_KEY}`;
    if (c.body !== undefined)
      headers["content-type"] = headers["content-type"] ?? "application/json";
    const res = await app.request(path, {
      method: c.method ?? "GET",
      headers,
      ...(c.body !== undefined
        ? { body: typeof c.body === "string" ? c.body : JSON.stringify(c.body) }
        : {}),
    });
    const text = await res.text();
    let json: T = undefined as T;
    try {
      json = text ? (JSON.parse(text) as T) : (undefined as T);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text, headers: res.headers };
  }
  const fetchViaApp: typeof fetch = async (input, init) =>
    app.request(input instanceof Request ? input : String(input), init);
  return { ctx, services, app, call, fetchViaApp, deps, close: () => ctx.close() };
}

export type Harness = ReturnType<typeof setup>;
export const sample = () => createSampleDocument();
