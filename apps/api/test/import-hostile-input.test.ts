/**
 * Security review pass 3, hostile-input cost of the document import (`POST /api/v1/import`): a Glideworth
 * export or a ProjectionLab export, validated in an import worker and written on the request thread. These
 * tests prove the bounds put on that work (`IMPORT_LIMITS`, `checkImportSize` and the plan count on the request
 * thread; `validationProbe` and the issue caps in the worker) and that ordinary documents, including the
 * largest realistic ones, still import exactly as before.
 *
 * Set GW_PARSE_TIMINGS=1 to print the measured times.
 */
import { type GlideworthDocument, migrateDocument, ValidationError } from "@glideworth/core";
import { createSampleDocument, createUkSampleDocument } from "@glideworth/core/samples";
import { afterEach, describe, expect, it } from "vitest";
import { checkImportSize, IMPORT_LIMITS, validationProbe } from "../src/jobs/import-limits.js";
import { type Harness, setup } from "./helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- documents are built and edited as plain JSON
type Json = Record<string, any>;

let h: Harness;
afterEach(() => h?.close());

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const log = (line: string) => {
  if (process.env.GW_PARSE_TIMINGS) console.info(line);
};

/** The sample household with `accounts` accounts, `plans` copies of its main plan and `snapshots` daily snapshots. */
function household(o: {
  accounts: number;
  plans?: number;
  snapshots: number;
  balancesPerSnapshot?: boolean;
}): Json {
  const d = clone(createSampleDocument()) as Json;
  const account = d.finances.accounts[0];
  const plan = d.plans[0];
  d.finances.accounts = Array.from({ length: o.accounts }, (_, i) => ({
    ...account,
    id: `acct-${i}`,
    name: `Account ${i}`,
  }));
  d.plans = Array.from({ length: o.plans ?? 1 }, (_, i) => ({
    ...clone(plan),
    id: i === 0 ? plan.id : `plan-${i}`,
    isMain: i === 0,
  }));
  d.progress = Array.from({ length: o.snapshots }, (_, i) => ({
    id: `snap-${i}`,
    householdId: d.household.id,
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    source: "auto",
    netWorth: 1,
    assets: 1,
    liabilities: 0,
    ...(o.balancesPerSnapshot
      ? { accounts: d.finances.accounts.map((a: Json) => ({ accountId: a.id, balance: 12.5 })) }
      : {}),
  }));
  return d;
}

const importDoc = (data: unknown, extra: Json = {}) =>
  h.call("/api/v1/import", {
    method: "POST",
    body: { format: "glideworth", data, dryRun: false, ...extra },
  });

const timed = async <T>(run: () => Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now();
  const r = await run();
  return [r, performance.now() - t0];
};

describe("applying a Glideworth document", () => {
  it("many snapshots of a household with many accounts take linear time (each snapshot used to re-read the household)", async () => {
    // n accounts and n snapshots: the input grows with n, the old cost with n squared.
    const at = async (n: number) => {
      h?.close();
      h = setup({ seed: false });
      const doc = household({ accounts: n, plans: 0, snapshots: n });
      const [r, ms] = await timed(() => importDoc(doc));
      expect(r.status, r.text.slice(0, 300)).toBe(200);
      return ms;
    };
    await at(100);
    let small = Infinity;
    for (let i = 0; i < 3; i++) small = Math.min(small, await at(500));
    let large = Infinity;
    for (let i = 0; i < 2 && large > 20 * Math.max(small, 5); i++)
      large = Math.min(large, await at(4_000));
    log(`snapshots x accounts: 500 ${small.toFixed(0)} ms, 4,000 ${large.toFixed(0)} ms`);
    // Linear is 8, quadratic 64. Before the fix 2,000 x 2,000 took 4 s and 4,000 x 4,000 about 16 s.
    expect(large).toBeLessThanOrEqual(20 * Math.max(small, 5));
    expect(h.services.households.listSnapshots(h.services.households.list()[0]!.id)).toHaveLength(
      4_000,
    );
  }, 300_000);

  it("snapshots are written with the same outcome in every mode", async () => {
    h = setup({ seed: false });
    const doc = household({ accounts: 3, snapshots: 3, balancesPerSnapshot: true });
    const hid = doc.household.id as string;
    const ids = () =>
      h.services.households
        .listSnapshots(hid)
        .map((s) => s.id)
        .sort();
    expect((await importDoc(doc, { mode: "create" })).status).toBe(200);
    expect(ids()).toEqual(["snap-0", "snap-1", "snap-2"]);
    const stored = h.services.households.listSnapshots(hid).find((s) => s.id === "snap-1")!;
    expect(stored.householdId).toBe(hid);
    expect(stored.accounts).toHaveLength(3);
    // create again: the household exists.
    expect((await importDoc(doc, { mode: "create" })).status).toBe(409);
    // merge: snapshots in the document replace those with the same id, the others stay.
    const merged = clone(doc);
    merged.progress = [
      { ...merged.progress[0], netWorth: 99 },
      { ...merged.progress[0], id: "snap-9" },
    ];
    expect((await importDoc(merged, { mode: "merge" })).status).toBe(200);
    expect(ids()).toEqual(["snap-0", "snap-1", "snap-2", "snap-9"]);
    expect(h.services.households.listSnapshots(hid).find((s) => s.id === "snap-0")!.netWorth).toBe(
      99,
    );
    // replace: exactly the document's snapshots.
    const replaced = clone(doc);
    replaced.progress = [replaced.progress[2]];
    expect((await importDoc(replaced, { mode: "replace" })).status).toBe(200);
    expect(ids()).toEqual(["snap-2"]);
    // A snapshot id held by another household is a conflict, and nothing of the import is written.
    const other = clone(doc);
    other.household.id = "hh-other";
    for (const p of other.plans) {
      p.householdId = "hh-other";
      p.id = `${p.id}-other`;
    }
    other.progress = [{ ...other.progress[2], householdId: "hh-other" }];
    const conflict = await importDoc(other, { mode: "create" });
    expect(conflict.status).toBe(409);
    expect(h.services.households.list().map((x) => x.id)).not.toContain("hh-other");
  });

  it("the largest realistic household (50 accounts, 20 plans, five years of daily snapshots) still imports", async () => {
    h = setup({ seed: false });
    const doc = household({ accounts: 50, plans: 20, snapshots: 1_825, balancesPerSnapshot: true });
    const values = checkImportSize(doc);
    const [r, ms] = await timed(() => importDoc(doc));
    log(
      `realistic large household: ${values} values, ${JSON.stringify(doc).length} chars, ${ms.toFixed(0)} ms`,
    );
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(values).toBeGreaterThan(300_000);
    expect(values).toBeLessThan(IMPORT_LIMITS.values);
  }, 60_000);
});

describe("limits on a document import", () => {
  it("refuses more values than the limit, before reading the document", async () => {
    h = setup({ seed: false });
    const doc = household({ accounts: 1, plans: 1, snapshots: 0 });
    const base = checkImportSize(doc);
    // The padding array is one value and holds the rest.
    doc.padding = Array(IMPORT_LIMITS.values - base - 1).fill(0);
    expect(checkImportSize(doc)).toBe(IMPORT_LIMITS.values);
    expect((await importDoc(doc, { dryRun: true })).status).toBe(200);
    doc.padding.push(0);
    const over = await importDoc(doc, { dryRun: true });
    expect(over.status).toBe(400);
    expect(over.json.error).toMatchObject({ code: "VALIDATION" });
    expect(over.json.error.message).toContain("500,000 values");
  }, 60_000);

  it("refuses nesting deeper than the limit (and deep nesting is never a stack overflow)", async () => {
    h = setup({ seed: false });
    // 100,000 levels: written by hand, since JSON.stringify itself overflows the stack on it.
    const doc = JSON.stringify(household({ accounts: 1, snapshots: 0 }));
    const depth = 100_000;
    const body = `{"format":"glideworth","dryRun":true,"data":${doc.slice(0, -1)},"deep":${"[".repeat(depth)}0${"]".repeat(depth)}}}`;
    const r = await h.call("/api/v1/import", { method: "POST", body });
    expect(r.status, r.text.slice(0, 200)).toBe(400);
    expect(r.json.error.message).toContain("deeper than 64 levels");
    // Nesting inside a field the schema keeps (a lineage patch value) never reaches storage either.
    let deep: unknown = 0;
    for (let i = 0; i < 1_000; i++) deep = [deep];
    const kept = household({ accounts: 1, plans: 2, snapshots: 0 });
    kept.plans[1].lineage = {
      parentPlanId: kept.plans[0].id,
      patch: [{ op: "add", path: "/x", value: deep }],
    };
    expect((await importDoc(kept)).status).toBe(400);
  });

  it("refuses more plans than the limit", async () => {
    h = setup({ seed: false });
    const ok = household({ accounts: 1, plans: IMPORT_LIMITS.plans, snapshots: 0 });
    const [r, ms] = await timed(() => importDoc(ok));
    log(`${IMPORT_LIMITS.plans} plans: ${ms.toFixed(0)} ms`);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    h.close();
    h = setup({ seed: false });
    const over = household({ accounts: 1, plans: IMPORT_LIMITS.plans + 1, snapshots: 0 });
    const r2 = await importDoc(over);
    expect(r2.status).toBe(400);
    expect(r2.json.error.message).toContain(`at most ${IMPORT_LIMITS.plans} can be imported`);
  });

  it("a mostly invalid document fails fast with a short list of problems (it used to take seconds, GBs and 180 MB of response)", async () => {
    h = setup({ seed: false });
    for (const where of ["accounts", "progress", "income"] as const) {
      const doc = clone(createSampleDocument()) as Json;
      const junk = Array.from({ length: 400_000 }, () => ({}));
      if (where === "accounts") doc.finances.accounts = junk;
      if (where === "progress") doc.progress = junk;
      // In an event list this used to overflow the stack inside validation (a 500).
      if (where === "income") doc.plans[0].income = junk;
      const [r, ms] = await timed(() => importDoc(doc, { dryRun: true }));
      log(`400,000 empty objects in ${where}: ${ms.toFixed(0)} ms, ${r.text.length} bytes`);
      expect(r.status, r.text.slice(0, 200)).toBe(400);
      expect(r.json.error.details.issues.length).toBeLessThanOrEqual(IMPORT_LIMITS.issues);
      expect(r.text.length).toBeLessThan(100_000);
      expect(ms).toBeLessThan(1_500);
    }
  }, 120_000);

  it("a long list of problems is cut to IMPORT_LIMITS.issues with the total in issueCount", async () => {
    h = setup({ seed: false });
    const doc = clone(createSampleDocument()) as Json;
    // Every account broken, few enough that the probe passes them all to full validation sometimes;
    // either way the answer lists at most 100.
    doc.finances.accounts = Array.from({ length: 300 }, () => ({}));
    const r = await importDoc(doc, { dryRun: true });
    expect(r.status).toBe(400);
    expect(r.json.error.details.issues.length).toBeLessThanOrEqual(IMPORT_LIMITS.issues);
    if (r.json.error.details.issueCount !== undefined)
      expect(r.json.error.details.issueCount).toBeGreaterThan(IMPORT_LIMITS.issues);
  });
});

describe("validationProbe", () => {
  it("never fails a valid document (people, records, short and long lists, 200 runs)", () => {
    const docs: unknown[] = [
      createSampleDocument(),
      createUkSampleDocument(),
      household({ accounts: 40, plans: 3, snapshots: 300, balancesPerSnapshot: true }),
    ];
    // A couple, and a record wider than the probe keeps whole.
    const couple = clone(createSampleDocument()) as Json;
    expect(couple.household.people.length).toBe(2);
    const wide = household({ accounts: 200, plans: 1, snapshots: 0 });
    wide.plans[0].accountSettings = Object.fromEntries(
      wide.finances.accounts.map((a: Json) => [a.id, {}]),
    );
    docs.push(couple, wide);
    for (const d of docs) {
      const full = migrateDocument(clone(d)) as GlideworthDocument;
      expect(full.household.id).toBeTruthy();
      const values = checkImportSize(d);
      for (let i = 0; i < 40; i++)
        expect(() => migrateDocument(validationProbe(d, values))).not.toThrow();
    }
  });

  it("catches a document in which 2.5% of the values are invalid in nearly every run", () => {
    const d = household({ accounts: 10, plans: 1, snapshots: 3_000, balancesPerSnapshot: true });
    const values = checkImportSize(d);
    // About 2.5% of the values: one balance in every snapshot is a string.
    for (const s of d.progress) for (const a of s.accounts.slice(0, 1)) a.balance = "x";
    let caught = 0;
    for (let i = 0; i < 50; i++)
      try {
        migrateDocument(validationProbe(d, values));
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        caught++;
      }
    expect(caught).toBeGreaterThanOrEqual(48);
  });

  it("keeps `__proto__` as a plain key, as the parsed body has it", () => {
    const body = JSON.parse('{"a":{"__proto__":{"x":1}},"b":[1,2,3]}') as Json;
    const p = validationProbe(body, checkImportSize(body)) as Json;
    expect(Object.keys(p.a)).toEqual(["__proto__"]);
    expect(({} as Json).x).toBeUndefined();
  });
});

describe("ProjectionLab exports", () => {
  const pl = (extra: (raw: Json) => void): Json => {
    const raw: Json = {
      meta: { version: "4.6.0" },
      today: { birthYear: 1980, lastUpdated: Date.UTC(2026, 0, 1), location: { country: "US" } },
      plans: [],
      settings: { ci: { currency: "USD", locale: "en-US" } },
    };
    extra(raw);
    return raw;
  };
  const importPl = (data: unknown) =>
    h.call("/api/v1/import", {
      method: "POST",
      body: { format: "projectionlab", data, dryRun: true },
    });

  it("plans times accounts no longer exhausts memory: the importer refuses more than its limits with a 400", async () => {
    h = setup({ seed: false });
    // Before the fix 4,000 plans and 4,000 accounts (130 KB) built a report too large for a string, and
    // 8,000 of each ran the process out of memory.
    const raw = pl((r) => {
      r.today.savingsAccounts = Array.from({ length: 4_000 }, (_, i) => ({ id: `a${i}` }));
      r.plans = Array.from({ length: 4_000 }, () => ({ accounts: { events: [{ id: "x" }] } }));
    });
    const [r, ms] = await timed(() => importPl(raw));
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain("4,000 plans; at most 100 can be imported");
    expect(ms).toBeLessThan(1_000);
  });

  it("lists at most IMPORT_LIMITS.notes notes, counting all of them in stats", async () => {
    h = setup({ seed: false });
    const raw = pl((r) => {
      r.plans = [
        {
          income: { events: Array.from({ length: 5_000 }, (_, i) => ({ id: `i${i}`, amount: 1 })) },
        },
      ];
    });
    const r = await importPl(raw);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.json.issues.length).toBe(IMPORT_LIMITS.notes);
    expect(r.json.report.issues.length).toBe(IMPORT_LIMITS.notes);
    expect(r.json.stats.issues).toBeGreaterThan(5_000);
  });

  it("crafted exports at the size limits are answered within a bounded time", async () => {
    h = setup({ seed: false });
    const shapes: [string, Json][] = [
      [
        "490,000 distinct unknown keys",
        pl((r) => {
          r.junk = Array.from({ length: 49 }, (_, j) =>
            Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${j}_${i}`, 0])),
          );
        }),
      ],
      ["490,000 unknown numbers", pl((r) => (r.junk = Array(490_000).fill(0)))],
      [
        "deep long keys over many keys",
        pl((r) => {
          let node: Json = Object.fromEntries(
            Array.from({ length: 100_000 }, (_, i) => [`k${i}`, 0]),
          );
          for (let d = 0; d < 60; d++) node = { ["x".repeat(1_000)]: node };
          r.junk = node;
        }),
      ],
      [
        "20,000 events",
        pl((r) => {
          r.plans = [
            {
              income: {
                events: Array.from({ length: 20_000 }, (_, i) => ({ id: `i${i}`, amount: 1 })),
              },
            },
          ];
        }),
      ],
    ];
    for (const [name, raw] of shapes) {
      const [r, ms] = await timed(() => importPl(raw));
      log(
        `ProjectionLab ${name}: ${JSON.stringify(raw).length} chars, ${ms.toFixed(0)} ms, ${r.text.length} bytes`,
      );
      expect(r.status, r.text.slice(0, 200)).toBe(200);
      expect(r.text.length).toBeLessThan(5_000_000);
      expect(ms).toBeLessThan(3_000);
    }
  }, 120_000);
});

describe("bank files", () => {
  it("a QIF section named like an Object.prototype member is reported, not a 500", async () => {
    h = setup();
    const r = await h.call("/api/v1/households/hh-sample/import/bank-file", {
      method: "POST",
      body: { text: "!Type:constructor\nD01/05/2026\nT-5\nPShop\n^\n", format: "qif" },
    });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
  });
});
