/**
 * Review finding 6: the `glideworth-cloud` subcommands the ops scripts call, against temporary directories, in
 * both modes (queued to a running server, or run in-process); key encodings; and the `./server` boot with its
 * two listeners.
 */
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/main.js";
import { beat, CommandWorker } from "../src/commands.js";
import { openControlDb } from "../src/control/db.js";
import { accounts, operatorSessions, operators, users } from "../src/control/schema.js";
import { newUserId } from "../src/crypto/random.js";
import { createCloudRuntime } from "../src/runtime.js";
import { start } from "../src/server.js";
import { controlDbPath } from "../src/tenancy/paths.js";
import {
  type FakeRuntime,
  fakeOpener,
  removeTempDirs,
  SENTINEL_HOUSEHOLD,
  strongPassword,
  tempDir,
  verifiers,
} from "./cloud-fixture.js";
import { remember, testLog } from "./helpers.js";

const pricingFile = resolve(import.meta.dirname, "..", "..", "billing", "pricing.example.json");

function env(dataDir: string, keys: "hex" | "base64" = "hex"): NodeJS.ProcessEnv {
  const a = randomBytes(32);
  const b = randomBytes(32);
  return {
    GLIDEWORTH_PUBLIC_URL: "https://app.example.test",
    GLIDEWORTH_DATA_DIR: dataDir,
    GLIDEWORTH_SECRETS_KEY: remember(keys === "hex" ? a.toString("hex") : a.toString("base64")),
    GLIDEWORTH_BACKUP_KEK: remember(keys === "hex" ? b.toString("hex") : b.toString("base64")),
    GLIDEWORTH_BACKUP_KEK_ID: "kek-2026-11",
    GLIDEWORTH_PRICING_FILE: pricingFile,
    GLIDEWORTH_EMAIL_TRANSPORT: "file",
    GLIDEWORTH_BILLING: "fake",
    GLIDEWORTH_LOG_LEVEL: "error",
  };
}

const host = () => {
  const opener = fakeOpener();
  return { opener, cliHost: { createOpener: () => opener } };
};

function io(
  e: NodeJS.ProcessEnv,
  o: { stdin?: string; host?: ReturnType<typeof host>["cliHost"] } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      env: e,
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      readStdin: async () => o.stdin ?? "",
      log: testLog,
      waitMs: 10_000,
      ...(o.host ? { host: o.host } : {}),
    },
    json: () => JSON.parse(out.at(-1) as string) as Record<string, unknown>,
  };
}

/** A verified person with a workspace and some data, created through the runtime's own services. */
async function seed(e: NodeJS.ProcessEnv, h: ReturnType<typeof host>) {
  const rt = await createCloudRuntime({ env: e, createOpener: () => h.opener, log: testLog });
  const userId = newUserId();
  rt.db
    .insert(users)
    .values({
      id: userId,
      email: "seed@example.org",
      emailNormalized: "seed@example.org",
      name: "Seed",
      passwordHash: "x",
      termsVersion: "1",
      emailVerifiedAt: new Date().toISOString(),
    })
    .run();
  const id = await rt.workspaces.create(userId, "Seeded");
  await rt.registry.with(id, (r) => (r as FakeRuntime).addHousehold("h", SENTINEL_HOUSEHOLD, 1));
  await rt.registry.shutdown();
  rt.closeDb();
  return id;
}

afterEach(() => removeTempDirs());

describe("glideworth-cloud CLI", () => {
  it("operator create (password from stdin, TOTP secret shown once) and disable", async () => {
    const e = env(tempDir());
    const c = io(e, { stdin: `${strongPassword()}\n` });
    expect(
      await runCli(
        ["operator", "create", "--email", "ops@example.org", "--name", "Ops", "--role", "admin"],
        c.io,
      ),
    ).toBe(0);
    const r = c.json();
    expect(String(r.totpSecret)).toMatch(/^[A-Z2-7]{32}$/);
    remember(String(r.totpSecret));
    remember(String(r.otpauthUri));
    const { db, close } = openControlDb(controlDbPath(String(e.GLIDEWORTH_DATA_DIR)));
    const op = db.select().from(operators).get();
    expect(op?.totpSecretEnc).toMatch(/^v1\./);
    expect(op?.passwordHash).toMatch(/^scrypt\$/);
    close();
    const dup = io(e, { stdin: `${strongPassword()}\n` });
    expect(
      await runCli(
        ["operator", "create", "--email", "ops@example.org", "--name", "Ops", "--role", "admin"],
        dup.io,
      ),
    ).toBe(1);
    const weak = io(e, { stdin: "short\n" });
    expect(
      await runCli(
        ["operator", "create", "--email", "b@example.org", "--name", "B", "--role", "support"],
        weak.io,
      ),
    ).toBe(1);
    const dis = io(e);
    expect(await runCli(["operator", "disable", "--email", "ops@example.org"], dis.io)).toBe(0);
  });

  it("operator reset-totp prints a new secret as one JSON line, like create, and ends the sessions", async () => {
    const e = env(tempDir());
    const c = io(e, { stdin: `${strongPassword()}\n` });
    await runCli(
      ["operator", "create", "--email", "ops@example.org", "--name", "Ops", "--role", "admin"],
      c.io,
    );
    const created = c.json();
    remember(String(created.totpSecret));
    remember(String(created.otpauthUri));
    const path = controlDbPath(String(e.GLIDEWORTH_DATA_DIR));
    const before = openControlDb(path);
    const old = before.db.select().from(operators).get();
    before.db
      .insert(operatorSessions)
      .values({
        id: "a".repeat(64),
        operatorId: String(created.operatorId),
        csrf: "x",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      })
      .run();
    before.close();

    const r = io(e);
    expect(await runCli(["operator", "reset-totp", "--email", "OPS@example.org"], r.io)).toBe(0);
    expect(r.out).toHaveLength(1);
    expect(r.err).toEqual([]);
    const out = r.json();
    remember(String(out.totpSecret));
    remember(String(out.otpauthUri));
    expect(Object.keys(out)).toEqual(Object.keys(created));
    expect(out.operatorId).toBe(created.operatorId);
    expect(String(out.totpSecret)).toMatch(/^[A-Z2-7]{32}$/);
    expect(out.totpSecret).not.toBe(created.totpSecret);
    expect(String(out.otpauthUri)).toContain(`secret=${String(out.totpSecret)}`);

    const { db, close } = openControlDb(path);
    const op = db.select().from(operators).get();
    expect(op?.totpSecretEnc).toMatch(/^v1\./);
    expect(op?.totpSecretEnc).not.toBe(old?.totpSecretEnc);
    expect(db.select().from(operatorSessions).all()).toEqual([]);
    close();

    const unknown = io(e);
    expect(await runCli(["operator", "reset-totp", "--email", "x@example.org"], unknown.io)).toBe(
      1,
    );
    expect(unknown.out).toEqual([]);
    expect(await runCli(["operator", "reset-totp"], io(e).io)).toBe(1);
    await runCli(["operator", "disable", "--email", "ops@example.org"], io(e).io);
    const disabled = io(e);
    expect(
      await runCli(["operator", "reset-totp", "--email", "ops@example.org"], disabled.io),
    ).toBe(1);
    expect(disabled.out).toEqual([]);
  });

  it("backup-now, restore-test, restore-tenant and migrate-all run in-process when no server is running", async () => {
    const dir = tempDir();
    const e = env(dir, "base64");
    const h = host();
    const id = await seed(e, h);
    const b = io(e, { host: h.cliHost });
    expect(await runCli(["backup-now"], b.io)).toBe(0);
    expect(b.json()).toMatchObject({ via: "local", backedUp: 1, failed: [] });
    expect(String(b.out.join("\n"))).not.toContain(String(e.GLIDEWORTH_SECRETS_KEY));
    const t = io(e, { host: h.cliHost });
    expect(await runCli(["restore-test", "--sample", "5"], t.io)).toBe(0);
    expect(t.json()).toMatchObject({ verified: 1, failed: [] });
    const r = io(e, { host: h.cliHost });
    expect(await runCli(["restore-tenant", id], r.io)).toBe(0);
    expect(r.json()).toMatchObject({ via: "local", restored: [id] });
    const all = io(e, { host: h.cliHost });
    expect(await runCli(["restore-tenant", "--all"], all.io)).toBe(0);
    const m = io(e, { host: h.cliHost });
    expect(await runCli(["migrate-all", "--concurrency", "2"], m.io)).toBe(0);
    expect(m.json()).toMatchObject({ ok: 1, failed: [] });
    // Without the host's tenant runtime (and no server), commands that open tenants refuse.
    const no = io(e);
    expect(await runCli(["restore-tenant", id], no.io)).toBe(1);
    expect(no.err.join("\n")).toMatch(/TENANT_UNAVAILABLE/);
    expect(await runCli(["restore-tenant", "../x"], io(e, { host: h.cliHost }).io)).toBe(1);
  });

  it("restore-control rebuilds the control plane from its backup and puts tenant keys back from escrow", async () => {
    const dir = tempDir();
    const e = env(dir);
    const h = host();
    const id = await seed(e, h);
    expect(await runCli(["backup-now"], io(e, { host: h.cliHost }).io)).toBe(0);
    rmSync(join(dir, "control"), { recursive: true, force: true });
    const r = io(e);
    expect(await runCli(["restore-control"], r.io)).toBe(0);
    expect(r.json()).toMatchObject({ keysRestored: 1 });
    expect(existsSync(controlDbPath(dir))).toBe(true);
    // The restored control plane can restore the tenant (its key came back).
    const t = io(e, { host: h.cliHost });
    expect(await runCli(["restore-tenant", id], t.io)).toBe(0);
  });

  it("with a running server the command is queued and executed by the server", async () => {
    const dir = tempDir();
    const e = env(dir);
    const h = host();
    await seed(e, h);
    const server = await createCloudRuntime({ env: e, createOpener: () => h.opener, log: testLog });
    beat(server.db);
    const worker = new CommandWorker(server, testLog);
    const timer = setInterval(() => void worker.poll(), 20);
    try {
      const c = io(e); // no host: the server process has the tenant runtime
      expect(await runCli(["migrate-all"], c.io)).toBe(0);
      expect(c.json()).toMatchObject({ via: "server", status: "done", ok: 1 });
      const r = io(e);
      expect(await runCli(["restore-control"], r.io)).toBe(1); // refuses while the server runs
      expect(r.err.join("\n")).toMatch(/stop it first/);
    } finally {
      clearInterval(timer);
      await server.registry.shutdown();
      server.closeDb();
    }
  });

  it("usage and configuration errors: exit codes, names only (never values)", async () => {
    expect(await runCli(["nope"], io({}).io)).toBe(2);
    const bad = io({ GLIDEWORTH_SECRETS_KEY: "not-a-key-and-secret-looking-value" });
    expect(await runCli(["backup-now"], bad.io)).toBe(1);
    expect(bad.err.join("\n")).toMatch(/GLIDEWORTH_SECRETS_KEY must be 32 bytes/);
    expect(bad.err.join("\n")).not.toContain("not-a-key-and-secret-looking-value");
  });
});

describe("./server", () => {
  it("serves the public app and the operator console on separate listeners, then shuts down", async () => {
    const dir = tempDir();
    const e = {
      ...env(dir),
      GLIDEWORTH_OPS_LISTEN: "127.0.0.1:8789",
      GLIDEWORTH_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    };
    const opener = fakeOpener();
    const started = await start({
      env: e,
      listen: { host: "127.0.0.1", port: 0, opsPort: 0 },
      timers: false,
      handleSignals: false,
      host: {
        createOpener: () => opener,
        verifiers,
        runDue: async () => ({ nextRunAt: null }),
        createApp: (cloud) => {
          const app = new OpenAPIHono();
          cloud.registerRoutes(app);
          const auth = cloud.tenantAuth("api");
          app.use("/api/*", (c, next) =>
            cloud.isCloudRoute(c.req.path) ? next() : auth(c as never, next),
          );
          app.get("/api/v1/whoami", (c) => c.json({ ok: true }));
          return app;
        },
      },
    });
    try {
      expect(started.opsAddress.address).toBe("127.0.0.1");
      const pub = `http://127.0.0.1:${started.publicAddress.port}`;
      const ops = `http://127.0.0.1:${started.opsAddress.port}`;
      const status = await fetch(`${pub}/api/v1/auth/status`);
      expect(status.status).toBe(200);
      // The web app renders the Turnstile widget from this public key.
      expect(((await status.json()) as { captcha?: unknown }).captcha).toEqual({
        siteKey: "1x00000000000000000000AA",
      });
      expect((await fetch(`${pub}/api/v1/whoami`)).status).toBe(401);
      expect((await fetch(`${pub}/login`)).status).toBe(404);
      expect((await fetch(`${ops}/login`)).status).toBe(200);
      // The console does not serve the public API: unauthenticated requests go to its sign-in page.
      const viaOps = await fetch(`${ops}/api/v1/auth/status`, { redirect: "manual" });
      expect([viaOps.status, viaOps.headers.get("location")]).toEqual([303, "/login"]);
      expect(started.runtime.db.select().from(accounts).all()).toEqual([]);
      expect(started.runtime.db.select().from(users).where(eq(users.id, "x")).all()).toEqual([]);
    } finally {
      await started.close();
    }
  });
});
