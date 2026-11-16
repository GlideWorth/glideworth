/** Operator tooling (backup / restore / seed). Temp databases only. */
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupDatabase, restoreDatabase, seedSample } from "../src/cli/db-tools.js";
import { openDb } from "../src/db/client.js";
import { Services } from "../src/services.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "glideworth-cli-"));
  dirs.push(d);
  return d;
};
afterEach(() => vi.restoreAllMocks());

function households(path: string) {
  const { db, close } = openDb(path);
  const s = new Services(db);
  const out = { list: s.households.list().map((h) => h.id), close, services: s };
  return out;
}

describe("pnpm seed", () => {
  it("loads the synthetic UK sample (default) and refuses to overwrite unless --replace", () => {
    const path = join(tmp(), "glideworth.db");
    const r = seedSample(path);
    expect(r).toMatchObject({ householdId: "hh-uk-sample", plans: ["uk-plan-main"] });
    const a = households(path);
    expect(a.list).toEqual(["hh-uk-sample"]);
    expect(a.services.plans.list({ householdId: "hh-uk-sample" })[0]!.id).toBe("uk-plan-main");
    a.close();
    expect(() => seedSample(path)).toThrow(/already exists.*--replace/);
    expect(seedSample(path, { replace: true }).householdId).toBe("hh-uk-sample");
    expect(seedSample(path, { sample: "us" }).householdId).toBe("hh-sample");
  });
});

describe("pnpm keys:create", () => {
  it("accepts the arguments exactly as README.md writes them (with the `--` pnpm forwards)", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = join(tmp(), "glideworth.db");
    const tsx = join(__dirname, "..", "node_modules", ".bin", "tsx");
    const r = spawnSync(
      tsx,
      [
        "--conditions=@glideworth/source",
        "src/cli/create-key.ts",
        "--",
        "--name",
        "laptop",
        "--scopes",
        "read,write",
      ],
      {
        cwd: join(__dirname, ".."),
        env: { ...process.env, GLIDEWORTH_DB_PATH: path },
        encoding: "utf8",
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\(read,write\)/);
    const { db, close } = openDb(path);
    const s = new Services(db);
    expect(s.keys.list().map((k: { name: string }) => k.name)).toContain("laptop");
    close();
  });
});

describe("upgrading from Cairn", () => {
  it("the CLI reads CAIRN_DB_PATH, warns about the old name on stderr and mints keys in the new format", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = join(tmp(), "cairn.db");
    seedSample(path);
    const tsx = join(__dirname, "..", "node_modules", ".bin", "tsx");
    const r = spawnSync(
      tsx,
      ["--conditions=@glideworth/source", "src/cli/create-key.ts", "--name", "old-env"],
      {
        cwd: join(__dirname, ".."),
        env: { ...process.env, CAIRN_DB_PATH: path },
        encoding: "utf8",
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^glideworth_[a-z0-9]{8}_/m);
    expect(r.stderr).toContain("CAIRN_DB_PATH -> GLIDEWORTH_DB_PATH");
    expect(r.stderr).not.toContain(path);
    const { db, close } = openDb(path);
    expect(new Services(db).keys.list().map((k: { name: string }) => k.name)).toContain("old-env");
    close();
  });

  it("the default glideworth.db falls back to an existing cairn.db (CLI included), never copying it", async () => {
    const { spawnSync } = await import("node:child_process");
    const dir = tmp();
    seedSample(join(dir, "cairn.db"));
    const tsx = join(__dirname, "..", "node_modules", ".bin", "tsx");
    const r = spawnSync(
      tsx,
      ["--conditions=@glideworth/source", "src/cli/create-key.ts", "--name", "fallback"],
      {
        cwd: join(__dirname, ".."),
        env: { ...process.env, GLIDEWORTH_DB_PATH: join(dir, "glideworth.db") },
        encoding: "utf8",
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/using the existing database .*cairn\.db/);
    expect(existsSync(join(dir, "glideworth.db"))).toBe(false);
    const { db, close } = openDb(join(dir, "cairn.db"));
    expect(new Services(db).keys.list().map((k: { name: string }) => k.name)).toContain("fallback");
    close();
  });

  it("backups of a cairn.db are named glideworth-<timestamp>.db; restore accepts either name", async () => {
    const dir = tmp();
    const legacy = join(dir, "cairn.db");
    seedSample(legacy);
    const dest = await backupDatabase(legacy);
    expect(dest).toMatch(/[/\\]backups[/\\]glideworth-\d{8}-\d{6}\.db$/);
    const oldName = await backupDatabase(legacy, join(dir, "old", "cairn-20261101-120000.db"));
    for (const from of [dest, oldName]) {
      const target = join(dir, "restored", `${from === dest ? "a" : "b"}`, "glideworth.db");
      await restoreDatabase(from, target);
      const a = households(target);
      expect(a.list).toEqual(["hh-uk-sample"]);
      a.close();
    }
  });
});

describe("pnpm backup / pnpm restore", () => {
  it("backs up a live database consistently and restores it (keeping a safety copy)", async () => {
    const dir = tmp();
    const path = join(dir, "glideworth.db");
    seedSample(path);
    const live = openDb(path); // an open connection (WAL mode), like a running server
    const backup = await backupDatabase(path, join(dir, "b", "one.db"));
    expect(existsSync(backup)).toBe(true);
    await expect(backupDatabase(path, backup)).rejects.toThrow(/overwrite/);

    // Change the live data after the backup.
    const s = new Services(live.db);
    s.households.delete("hh-uk-sample");
    live.close();
    expect(households(path).list).toEqual([]);

    await expect(restoreDatabase(backup, path)).rejects.toThrow(/--force/);
    const r = await restoreDatabase(backup, path, { force: true });
    expect(r.previous).toMatch(/pre-restore/);
    expect(existsSync(r.previous!)).toBe(true);
    const after = households(path);
    expect(after.list).toEqual(["hh-uk-sample"]);
    expect(after.services.plans.list({ householdId: "hh-uk-sample" })).toHaveLength(1);
    after.close();
  });

  it("default backup location, and refuses files that are not Glideworth databases", async () => {
    const dir = tmp();
    const path = join(dir, "glideworth.db");
    seedSample(path);
    const dest = await backupDatabase(path);
    expect(dest.startsWith(join(dir, "backups"))).toBe(true);
    expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
    const { default: Database } = await import("better-sqlite3");
    const other = join(dir, "other.db");
    const o = new Database(other);
    o.exec("create table x(a)");
    o.close();
    await expect(restoreDatabase(other, join(dir, "new.db"))).rejects.toThrow(
      /not a Glideworth database/,
    );
    await expect(restoreDatabase(join(dir, "missing.db"), path)).rejects.toThrow(/not found/);
    await expect(backupDatabase(join(dir, "nope.db"))).rejects.toThrow(/not found/);
  });

  it("restores into a fresh location and applies newer migrations to it", async () => {
    const dir = tmp();
    const path = join(dir, "glideworth.db");
    seedSample(path, { sample: "us" });
    const backup = await backupDatabase(path, join(dir, "x.db"));
    const target = join(dir, "fresh", "glideworth.db");
    const r = await restoreDatabase(backup, target);
    expect(r.previous).toBeNull();
    const a = households(target);
    expect(a.list).toEqual(["hh-sample"]);
    a.close();
  });
});
