/**
 * Retired historical datasets (DATA-LICENSES.md): `uk-1871` (Jordà-Schularick-Taylor, non-commercial)
 * is read as `uk-1983`, and `us-1871` (Shiller, no licence) as `us-1928`, with no schema-version bump.
 * Old saved plans, exports and API requests keep working, and the engine tells the user
 * (DATASET_REPLACED) instead of swapping the data silently. Also: the optional local Shiller dataset
 * (`us-1871-local`) and deterministic historical sequences that start before the bundled data.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeReplacedDataset,
  clearLocalDatasets,
  getMarketDataset,
  migrateDocument,
  migratePlan,
  MonteCarloSettings,
  Plan,
  registerLocalDataset,
  runMonteCarlo,
  type SimulationInputInput,
  type SimWarning,
  simulate,
} from "../src/index.js";
import { createUkSampleDocument, UK_SAMPLE_PLAN_ID } from "../src/samples/index.js";
import { scenario } from "./helpers.js";

/** A stored document exactly as an older build wrote it: schemaVersion 1, plan naming `uk-1871`. */
function storedOldDocument(dataset: "uk-1871" | "us-1871"): string {
  const doc = JSON.parse(JSON.stringify(createUkSampleDocument())) as Record<string, unknown> & {
    plans: { monteCarlo: Record<string, unknown> }[];
  };
  doc.app = "cairn"; // documents written before the rename are still read
  doc.plans[0]!.monteCarlo.dataset = dataset;
  delete doc.plans[0]!.monteCarlo.replacedDataset;
  return JSON.stringify(doc);
}

const replacedWarnings = (r: { warnings?: SimWarning[] }) =>
  (r.warnings ?? []).filter((w) => w.code === "DATASET_REPLACED");

/** Node built-ins without @types/node (core's tests compile without Node types; vitest runs on Node). */
interface NodeProcess {
  env: Record<string, string | undefined>;
  getBuiltinModule(name: "node:fs"): {
    mkdtempSync(prefix: string): string;
    writeFileSync(path: string, data: string): void;
    rmSync(path: string, o: { recursive: boolean; force: boolean }): void;
  };
  getBuiltinModule(name: "node:os"): { tmpdir(): string };
}
const proc = (globalThis as unknown as { process: NodeProcess }).process;
const fs = proc.getBuiltinModule("node:fs");

describe("retired dataset ids", () => {
  it("the schema reads a retired id as its replacement, rejects unknown ids and keeps the default", () => {
    expect(MonteCarloSettings.parse({ dataset: "uk-1871" }).dataset).toBe("uk-1983");
    expect(MonteCarloSettings.parse({ dataset: "us-1871" }).dataset).toBe("us-1928");
    expect(MonteCarloSettings.parse({}).dataset).toBe("us-1928");
    expect(MonteCarloSettings.safeParse({ dataset: "uk-1900" }).success).toBe(false);
    // The output type never carries a retired id: everything downstream sees only current ids.
    const plan = Plan.parse({
      id: "p",
      householdId: "h",
      name: "Old",
      monteCarlo: { dataset: "uk-1871" },
    });
    expect(plan.monteCarlo.dataset).toBe("uk-1983");
    expect(plan.monteCarlo.replacedDataset).toBe("uk-1871");
  });

  it("a stored document in the old shape loads, runs, and reports the replacement once per run", () => {
    const doc = migrateDocument(JSON.parse(storedOldDocument("uk-1871")));
    const plan = doc.plans.find((p) => p.id === UK_SAMPLE_PLAN_ID)!;
    expect(doc.app).toBe("glideworth");
    expect(doc.schemaVersion).toBe(1);
    expect(plan.monteCarlo.dataset).toBe("uk-1983");
    expect(plan.monteCarlo.replacedDataset).toBe("uk-1871");

    const input = {
      household: doc.household,
      finances: doc.finances,
      plan,
      options: { trace: "off" as const },
    };
    const notes = replacedWarnings(simulate(input));
    expect(notes).toHaveLength(1);
    const msg = notes[0]!.message;
    expect(msg).toMatch(/has been withdrawn/);
    expect(msg).toMatch(/1983-2025/);
    expect(msg).toMatch(/US shares converted to sterling/);
    expect(msg).toMatch(/results will differ/);
    expect(notes[0]).toMatchObject({ severity: "warning", refs: ["uk-1871", "uk-1983"] });

    // The chance-of-success run uses the replacement and says so in its own result.
    const mc = runMonteCarlo(input, { ...plan.monteCarlo, trials: 20, seed: 1 });
    expect(mc.dataset).toBe("uk-1983");
    expect(replacedWarnings(mc)).toHaveLength(1);

    // Saving writes the new id (and the marker, so the notice survives until it is dealt with)...
    const saved = migrateDocument(JSON.parse(JSON.stringify(doc)));
    expect(saved.plans[0]!.monteCarlo).toMatchObject({
      dataset: "uk-1983",
      replacedDataset: "uk-1871",
    });
    // ...choosing another dataset drops the stale marker and the notice...
    const changed = Plan.parse({ ...plan, monteCarlo: { ...plan.monteCarlo, dataset: "us-1928" } });
    expect(changed.monteCarlo.replacedDataset).toBeUndefined();
    expect(replacedWarnings(simulate({ ...input, plan: changed }))).toHaveLength(0);
    // ...and an app that has shown the notice can acknowledge it.
    const seen = { ...plan, monteCarlo: acknowledgeReplacedDataset(plan.monteCarlo) };
    expect(replacedWarnings(simulate({ ...input, plan: Plan.parse(seen) }))).toHaveLength(0);
  });

  it("a stored plan body (API database row) naming us-1871 migrates to us-1928 with its own notice", () => {
    const body = JSON.parse(storedOldDocument("us-1871")).plans[0];
    const plan = migratePlan(body, 1);
    expect(plan.monteCarlo).toMatchObject({ dataset: "us-1928", replacedDataset: "us-1871" });
    const doc = createUkSampleDocument();
    const r = simulate({
      household: doc.household,
      finances: doc.finances,
      plan,
      options: { trace: "off" },
    });
    const [note] = replacedWarnings(r);
    expect(note!.message).toMatch(/Robert Shiller/);
    expect(note!.message).toMatch(/1928-2025/);
  });

  it("an API-shaped request (raw JSON input and Monte Carlo settings) naming a retired id still runs", () => {
    // What the REST API, MCP and web worker send: plain JSON, parsed by core.
    const request = JSON.parse(
      JSON.stringify({
        ...scenario({ years: 5, plan: { monteCarlo: { dataset: "uk-1871" } } }),
        options: { trace: "off" },
      }),
    ) as SimulationInputInput;
    expect(replacedWarnings(simulate(request))).toHaveLength(1);
    // Run settings sent on their own (POST .../monte-carlo body `settings`) are flagged too.
    const r = runMonteCarlo(request, {
      method: "historical-random-restart",
      dataset: "us-1871",
      trials: 10,
      seed: 3,
    });
    expect(r.dataset).toBe("us-1928");
    expect(replacedWarnings(r)[0]!.refs).toEqual(["us-1871", "us-1928"]);
    // A current id produces no notice.
    const fresh = runMonteCarlo(request, { method: "historical-random-restart", trials: 10 });
    expect(fresh.warnings).toBeUndefined();
  });
});

describe("optional local dataset us-1871-local (self-hosted, personal use)", () => {
  const synthetic = (first: number, n: number) => ({
    firstYear: first,
    lastYear: first + n - 1,
    series: {
      stocks: Array.from({ length: n }, (_, i) => (i % 3 === 0 ? -0.1 : 0.08)),
      dividendYield: Array.from({ length: n }, () => 0.04),
      bonds: Array.from({ length: n }, () => 0),
      bondYield: Array.from({ length: n }, () => 0.04),
      cash: Array.from({ length: n }, (_, i) => (i < 5 ? null : 0.03)),
      inflation: Array.from({ length: n }, () => 0.02),
    },
  });
  const env = proc.env.GLIDEWORTH_LOCAL_DATA_DIR;
  afterEach(() => {
    clearLocalDatasets();
    if (env === undefined) delete proc.env.GLIDEWORTH_LOCAL_DATA_DIR;
    else proc.env.GLIDEWORTH_LOCAL_DATA_DIR = env;
  });

  it("is not available unless installed, and says how to install it", () => {
    delete proc.env.GLIDEWORTH_LOCAL_DATA_DIR;
    expect(() => getMarketDataset("us-1871-local")).toThrow(/not installed.*fetch_shiller_local/);
  });

  it("loads from GLIDEWORTH_LOCAL_DATA_DIR when the file is present, and validates it", () => {
    const dir = fs.mkdtempSync(`${proc.getBuiltinModule("node:os").tmpdir()}/glideworth-local-`);
    try {
      fs.writeFileSync(`${dir}/us-1871.json`, JSON.stringify(synthetic(1871, 60)));
      proc.env.GLIDEWORTH_LOCAL_DATA_DIR = dir;
      const ds = getMarketDataset("us-1871-local");
      expect(ds).toMatchObject({ id: "us-1871-local", firstYear: 1871, lastYear: 1930 });
      expect(ds.attribution).toMatch(/Shiller/);
      const r = runMonteCarlo(scenario({ years: 30 }), {
        method: "historical-sequential",
        dataset: "us-1871-local",
      });
      expect(r.trials).toBe(60 - 30 + 1);
      expect(() =>
        registerLocalDataset("us-1871-local", { ...synthetic(1871, 10), lastYear: 1890 }),
      ).toThrow(/series 'stocks' must have 20 finite values/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deterministic historical sequences start no earlier than the bundled data (1928)", () => {
  it("a 1900 start plays 1928 onwards, in order, and warns (it no longer repeats 1928's return)", () => {
    const input = scenario({
      years: 3,
      accounts: [{ id: "t", name: "T", type: "taxable", owner: "me", balance: 100_000 }],
      plan: {
        assumptions: { stockReturn: { kind: "historical", series: "us-stocks", startYear: 1900 } },
      },
    });
    const r = simulate(input);
    const us = getMarketDataset("us-1928").series.stocks;
    expect(r.periods.map((p) => p.market.stocks)).toEqual([us[0], us[1], us[2]]);
    const w = r.warnings.filter((x) => x.code === "ASSUMPTION" && /starts in 1928/.test(x.message));
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toMatch(/set to start in 1900/);
  });
});
