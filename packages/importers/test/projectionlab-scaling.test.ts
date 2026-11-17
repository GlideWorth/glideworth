/**
 * Security review, hostile-input cost of the importers: the ProjectionLab importer runs on the API's request
 * thread (`POST /api/v1/import`), so its time must grow in proportion to the export, and what it returns must
 * not grow faster than the export. Each scaling case builds a crafted export at two sizes, 8x apart, and
 * compares the times: linear is about 8x, quadratic about 64x (the method of `parse-scaling.test.ts`).
 *
 * Set GW_PARSE_TIMINGS=1 to print the measured times.
 */
import { ValidationError } from "@glideworth/core";
import { describe, expect, it } from "vitest";
import {
  collectKeyPaths,
  importProjectionLab,
  MAX_KEY_PATH_CHARS,
  MAX_KEY_PATHS,
} from "../src/index.js";
import type { PlContext } from "../src/projectionlab/context.js";
import { type MappedDebt, mapPlanDebtEvent } from "../src/projectionlab/debts.js";
import { IdRegistry } from "../src/util/ids.js";

type Json = Record<string, unknown>;

/** Linear is 8, quadratic is 64. */
const MAX_RATIO = 20;
const TIMEOUT = 300_000;

const time = (run: () => unknown): number => {
  const t0 = performance.now();
  run();
  return performance.now() - t0;
};

/** As in parse-scaling.test.ts: best of several runs at `n` and `8n`, and near-linear growth. */
function expectLinear<T>(name: string, n: number, build: (n: number) => T, run: (x: T) => unknown) {
  const [warm, small, large] = [Math.max(1, Math.floor(n / 5)), n, 8 * n].map(build) as [T, T, T];
  run(warm);
  let tSmall = Infinity;
  for (let i = 0; i < 5; i++)
    tSmall = Math.min(
      tSmall,
      time(() => run(small)),
    );
  const allowed = MAX_RATIO * Math.max(tSmall, 5);
  let tLarge = Infinity;
  for (let i = 0; i < 3 && tLarge > allowed; i++)
    tLarge = Math.min(
      tLarge,
      time(() => run(large)),
    );
  if (process.env.GW_PARSE_TIMINGS)
    console.info(`${name}: n=${n} ${tSmall.toFixed(1)} ms, n=${8 * n} ${tLarge.toFixed(1)} ms`);
  expect(
    tLarge,
    `${name}: ${tSmall.toFixed(1)} ms at ${n}, ${tLarge.toFixed(1)} ms at ${8 * n}`,
  ).toBeLessThanOrEqual(allowed);
}

/** A minimal export the importer accepts. */
function exportWith(extra: (raw: Json) => void): Json {
  const raw: Json = {
    meta: { version: "4.6.0" },
    today: { birthYear: 1980, lastUpdated: Date.UTC(2026, 0, 1), location: { country: "US" } },
    plans: [],
    settings: { ci: { currency: "USD", locale: "en-US" } },
  };
  extra(raw);
  return raw;
}
const today = (raw: Json) => raw.today as Json;
const run = (raw: Json) => importProjectionLab(raw);

describe("ProjectionLab import time grows linearly with the export", () => {
  it(
    "ids that shorten to the same base (each one used to retry every suffix before it)",
    () => {
      const prefix = "x".repeat(56);
      expectLinear(
        "colliding ids",
        2_000,
        (n) => Array.from({ length: n }, (_, i) => `${prefix}!${i}`),
        (ids) => {
          const r = new IdRegistry();
          for (const id of ids) r.get(id, "account");
        },
      );
    },
    TIMEOUT,
  );

  it(
    "many debts and many debt events (each event used to search every debt)",
    () => {
      // The mapping step itself: the importer's item limit keeps whole exports below sizes where this shows.
      const ctx = {
        issues: [],
        primaryId: "me",
        country: "US",
        currency: "USD",
        asOf: "2026-01",
        accountIds: new IdRegistry(),
        assetIds: new IdRegistry(),
        debtIds: new IdRegistry(),
        planIds: new IdRegistry(),
        knownAccounts: new Set<string>(),
        knownAssets: new Set<string>(),
        knownDebts: new Set<string>(),
      } as PlContext;
      expectLinear(
        "debt events x debts",
        1_000,
        (n) =>
          Array.from({ length: n }, (_, i) => ({
            sourceId: `d${i}`,
            debt: { id: `d${i}`, behaviour: {} },
            src: {},
          })) as MappedDebt[],
        (debts) => {
          const last = `d${debts.length - 1}`;
          for (let i = 0; i < debts.length; i++)
            mapPlanDebtEvent(ctx, { type: "debt", debtId: last }, "$", debts);
          ctx.issues.length = 0;
        },
      );
    },
    TIMEOUT,
  );

  it("1,000 foreign currencies and 100,000 exchange rates (each currency searched every rate; each rate's values were matched against every coverage rule)", () => {
    const codes: string[] = [];
    for (let a = 65; a < 91; a++)
      for (let b = 65; b < 91; b++) codes.push(`Q${String.fromCharCode(a, b)}`);
    const raw = exportWith((r) => {
      today(r).savingsAccounts = codes.slice(0, 500).map((c, i) => ({ id: `a${i}`, currency: c }));
      today(r).assets = codes.slice(500, 1000).map((c, i) => ({ id: `r${i}`, currency: c }));
      (r.settings as Json).ci = {
        currency: "USD",
        locale: "en-US",
        exchangeRates: Array.from({ length: 100_000 }, () => ({ from: "ZZZ", rate: 1 })),
      };
    });
    run(raw);
    let best = Infinity;
    for (let i = 0; i < 2; i++)
      best = Math.min(
        best,
        time(() => run(raw)),
      );
    if (process.env.GW_PARSE_TIMINGS) console.info(`currencies x rates: ${best.toFixed(1)} ms`);
    expect(best).toBeLessThan(1_000);
  });

  it(
    "long keys nested deeply above many keys (every key path repeated all the keys above it)",
    () => {
      expectLinear(
        "deep long keys",
        250,
        (n) =>
          exportWith((raw) => {
            const leaf: Json = {};
            for (let i = 0; i < n; i++) leaf[`k${i}`] = 0;
            let node: Json = leaf;
            for (let d = 0; d < 60; d++) node = { ["x".repeat(1000)]: node };
            raw.junk = node;
          }),
        run,
      );
    },
    TIMEOUT,
  );

  it("50,000 distinct unknown keys are classified quickly (each was tested against all 946 coverage rules)", () => {
    const raw = exportWith((r) => {
      r.junk = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, 0]));
    });
    run(raw);
    let best = Infinity;
    for (let i = 0; i < 3; i++)
      best = Math.min(
        best,
        time(() => run(raw)),
      );
    if (process.env.GW_PARSE_TIMINGS) console.info(`50,000 unknown keys: ${best.toFixed(1)} ms`);
    // About 0.7 s before the fix (every rule tried on every path), about 30 ms after.
    expect(best).toBeLessThan(400);
  });
});

describe("what the ProjectionLab importer returns is bounded", () => {
  it("one unknown array of 200,000 numbers is a few notes, not 200,000", () => {
    const r = run(exportWith((raw) => (raw.junk = Array.from({ length: 200_000 }, () => 0))));
    const notes = r.issues.filter((i) => i.sourcePath.startsWith("$.junk"));
    expect(notes.length).toBeLessThanOrEqual(4);
    expect(notes.at(-1)?.message).toMatch(/^199,997 more value\(s\) at this key path|^199997 more/);
    expect(r.report.coverage.unaccountedPaths).toContain("$.junk[]");
  });

  it("the key-path table keeps at most MAX_KEY_PATHS paths of at most MAX_KEY_PATH_CHARS characters and says so", () => {
    const o: Json = {};
    for (let i = 0; i < 3 * MAX_KEY_PATHS; i++) o[`k${i}`] = 0;
    const deep: Json = { ["y".repeat(2 * MAX_KEY_PATH_CHARS)]: { z: 1 } };
    const paths = collectKeyPaths({ junk: o, deep });
    expect(paths.size).toBeLessThanOrEqual(MAX_KEY_PATHS + 1);
    for (const p of paths.keys()) expect(p.length).toBeLessThanOrEqual(MAX_KEY_PATH_CHARS + 50);
    const r = run(exportWith((raw) => Object.assign(raw, { junk: o, deep })));
    expect(r.report.coverage.unaccountedPaths.some((p) => p.startsWith("$.(more key paths"))).toBe(
      true,
    );
    expect(r.issues.length).toBeLessThan(4 * MAX_KEY_PATHS + 100);
  });

  it("a plan that excludes many items notes 20 of them and counts the rest; the excluded ids are all kept", () => {
    const r = run(
      exportWith((raw) => {
        today(raw).savingsAccounts = Array.from({ length: 300 }, (_, i) => ({ id: `a${i}` }));
        raw.plans = [{ accounts: { events: [{ id: "elsewhere" }] } }];
      }),
    );
    expect(r.document.plans[0]!.excludedIds).toHaveLength(300);
    const notes = r.issues.filter((i) => i.code === "pl.excluded-account");
    expect(notes).toHaveLength(21);
    expect(notes.at(-1)?.message).toBe(
      "280 more accounts are not listed in this plan; excluded from it",
    );
  });

  it("a repeated 'excess-cash' drawdown entry is expanded once", () => {
    const r = run(
      exportWith((raw) => {
        today(raw).savingsAccounts = Array.from({ length: 50 }, (_, i) => ({
          id: `a${i}`,
          repurpose: true,
        }));
        raw.plans = [{ variables: { drawdownOrder: Array(1000).fill("excess-cash") } }];
      }),
    );
    expect(r.document.plans[0]!.drawdown.order).toHaveLength(50);
  });

  it("refuses an export over its limits before mapping it, naming the limit", () => {
    const over: [string, (raw: Json) => void][] = [
      ["plans", (raw) => (raw.plans = Array.from({ length: 101 }, () => ({})))],
      [
        "accounts",
        (raw) => {
          today(raw).savingsAccounts = Array.from({ length: 300 }, () => ({}));
          today(raw).investmentAccounts = Array.from({ length: 201 }, () => ({}));
        },
      ],
      ["assets", (raw) => (today(raw).assets = Array.from({ length: 501 }, () => ({})))],
      ["debts", (raw) => (today(raw).debts = Array.from({ length: 501 }, () => ({})))],
      [
        "plan events and milestones",
        (raw) =>
          (raw.plans = [
            {
              income: { events: Array.from({ length: 10_000 }, () => ({})) },
              milestones: Array.from({ length: 10_001 }, () => ({})),
            },
          ]),
      ],
      [
        "progress entries",
        (raw) => (raw.progress = { data: Array.from({ length: 20_001 }, () => ({})) }),
      ],
    ];
    for (const [what, edit] of over) {
      const t0 = performance.now();
      expect(() => run(exportWith(edit))).toThrow(ValidationError);
      expect(() => run(exportWith(edit))).toThrow(new RegExp(`${what}; at most`));
      expect(performance.now() - t0).toBeLessThan(1_000);
    }
  });

  it("an export at every limit at once imports in bounded time and size", () => {
    const raw = exportWith((r) => {
      today(r).savingsAccounts = Array.from({ length: 500 }, (_, i) => ({
        id: `a${i}`,
        repurpose: true,
      }));
      today(r).assets = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}` }));
      today(r).debts = Array.from({ length: 500 }, (_, i) => ({ id: `d${i}` }));
      r.plans = Array.from({ length: 100 }, () => ({
        accounts: { events: [{ id: "x" }] },
        assets: { events: [{ id: "x" }] },
        expenses: { events: [{ type: "debt", debtId: "d0" }] },
        variables: { drawdownOrder: ["excess-cash", "excess-cash"] },
        income: { events: Array.from({ length: 196 }, (_, i) => ({ id: `i${i}`, amount: 1 })) },
      }));
      r.progress = {
        data: Array.from({ length: 20_000 }, (_, i) => ({ date: Date.UTC(2000, 0, 1 + i) })),
      };
    });
    const t0 = performance.now();
    const r = run(raw);
    const ms = performance.now() - t0;
    if (process.env.GW_PARSE_TIMINGS) console.info(`at the limits: ${ms.toFixed(0)} ms`);
    expect(r.document.plans).toHaveLength(100);
    expect(r.document.plans[0]!.excludedIds).toHaveLength(1499);
    // Before the caps: 100 plans x 1,500 excluded items were 150,000 notes.
    expect(r.issues.filter((i) => i.code?.startsWith("pl.excluded-")).length).toBeLessThanOrEqual(
      100 * 3 * 21,
    );
    expect(ms).toBeLessThan(5_000);
  });

  it("ids named like Object.prototype members are never used as they are", () => {
    const r = run(
      exportWith((raw) => {
        today(raw).savingsAccounts = [{ id: "__proto__" }, { id: "constructor" }];
        raw.plans = [{ accounts: { events: [{ accountId: "__proto__", repurpose: true }] } }];
      }),
    );
    const ids = r.document.finances.accounts.map((a) => a.id);
    expect(ids).toEqual(["__proto__-2", "constructor-2"]);
    expect(Object.getPrototypeOf(r.document.plans[0]!.accountSettings)).toBe(Object.prototype);
  });

  it("source values named like Object.prototype members do not reach inherited functions", () => {
    for (const word of ["constructor", "__proto__", "toString", "valueOf"]) {
      const r = run(
        exportWith((raw) => {
          today(raw).savingsAccounts = [{ id: "a", type: word }];
          raw.plans = [{ variables: { drawdownOrder: [word], filingStatus: word } }];
        }),
      );
      expect(r.document.plans[0]!.drawdown.order).toEqual(expect.any(Array));
      expect(r.issues.some((i) => i.message.includes(`'${word}'`))).toBe(true);
    }
  });
});
