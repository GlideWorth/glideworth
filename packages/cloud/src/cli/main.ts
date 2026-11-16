/**
 * `glideworth-cloud`: the cloud operator CLI (spec 6.3, 7; review finding 6). Subcommands are what the
 * hosted deployment's operations scripts call:
 *
 *   operator create --email E --name N --role admin|support [--password-stdin]
 *   operator disable --email E
 *   backup-now                                  back up changed tenants and the control plane now
 *   restore-tenant <id> [--at ISO] | --all [--at ISO]
 *   restore-control [--at ISO] [--force]        server stopped; rebuilds control.db from its backup
 *   restore-test [--sample N]                   restore N random tenants into scratch and verify (exit 1 on failure)
 *   migrate-all [--concurrency N]
 *
 * backup-now, restore-tenant, restore-test and migrate-all run inside the server when it is running (queued in
 * `ops_commands`, see commands.ts) and in this process otherwise; commands that open tenants in this process
 * need the host's tenant runtime (`GLIDEWORTH_TENANT_RUNTIME_MODULE`, exporting `cloudHost`). Configuration is
 * the server's: the same environment, both key encodings (64 hex characters or base64 of 32 bytes).
 * Output is one JSON object per command on stdout; nothing secret is printed except the new operator's TOTP
 * secret, shown once.
 */
import { existsSync } from "node:fs";
import { restoreControlPlane } from "../backups/service.js";
import {
  awaitCommand,
  type CommandKind,
  enqueueCommand,
  heartbeatFresh,
  runCommand,
} from "../commands.js";
import { CloudConfigError, loadCloudConfig } from "../config.js";
import { openControlDb } from "../control/db.js";
import { CloudError } from "../errors.js";
import { createLogger, type Logger } from "../log/index.js";
import { OperatorService } from "../ops/operators.js";
import {
  backupRegion,
  createCloudRuntime,
  createObjectStore,
  type OpenerContext,
} from "../runtime.js";
import { controlDbPath } from "../tenancy/paths.js";
import type { TenantOpener, TenantRuntimeBase } from "../types.js";

export interface CliHost {
  createOpener(ctx: OpenerContext): TenantOpener<TenantRuntimeBase>;
  runDue?(r: TenantRuntimeBase): Promise<{ nextRunAt: string | null }>;
}

export interface CliIo {
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  err(line: string): void;
  /** All of stdin (for `--password-stdin`). */
  readStdin(): Promise<string>;
  /** Overrides the module lookup of the host's tenant runtime (tests). */
  host?: CliHost;
  log?: Logger;
  /** How long to wait for the server to run a queued command. */
  waitMs?: number;
}

const USAGE = `usage: glideworth-cloud <command>
  operator create --email E --name N --role admin|support [--password-stdin]
  operator disable --email E
  backup-now
  restore-tenant <id> [--at ISO] | restore-tenant --all [--at ISO]
  restore-control [--at ISO] [--force]
  restore-test [--sample N]
  migrate-all [--concurrency N]`;

interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !(argv[i + 1] as string).startsWith("--"))
        flags[k] = argv[++i] as string;
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const str = (v: string | true | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

async function loadHost(io: CliIo): Promise<CliHost | undefined> {
  if (io.host) return io.host;
  const spec = io.env.GLIDEWORTH_TENANT_RUNTIME_MODULE;
  if (!spec) return undefined;
  const mod = (await import(spec)) as { cloudHost?: CliHost };
  if (!mod.cloudHost?.createOpener)
    throw new Error("GLIDEWORTH_TENANT_RUNTIME_MODULE does not export cloudHost");
  return mod.cloudHost;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [cmd, sub] = positional;
  const log = io.log ?? createLogger({ level: "warn", sink: (l) => io.err(l) });
  const print = (o: Record<string, unknown>) => io.out(JSON.stringify(o));
  try {
    switch (cmd) {
      case "operator":
        return await operatorCommand(sub, flags, io, print);
      case "backup-now":
        return await delegated("backup-now", {}, io, log, print, false);
      case "restore-tenant": {
        const all = flags.all === true;
        const id = positional[1];
        if (!all && !id)
          throw new CloudError(400, "VALIDATION", "restore-tenant needs a workspace id or --all");
        const at = str(flags.at);
        if (at !== undefined && Number.isNaN(Date.parse(at)))
          throw new CloudError(400, "VALIDATION", "--at must be an ISO time");
        return await delegated(
          "restore-tenant",
          { ...(all ? { all: true } : { accountId: id }), ...(at ? { at } : {}) },
          io,
          log,
          print,
          true,
        );
      }
      case "restore-test": {
        const r = await delegated(
          "restore-test",
          { sample: Number(str(flags.sample) ?? 5) },
          io,
          log,
          print,
          true,
        );
        return r;
      }
      case "migrate-all":
        return await delegated(
          "migrate-all",
          { concurrency: Number(str(flags.concurrency) ?? 2) },
          io,
          log,
          print,
          true,
        );
      case "restore-control":
        return await restoreControl(flags, io, log, print);
      case undefined:
      case "help":
      case "--help":
        io.out(USAGE);
        return cmd ? 0 : 2;
      default:
        io.err(USAGE);
        return 2;
    }
  } catch (err) {
    if (err instanceof CloudConfigError) io.err(`configuration: ${err.problems.join("; ")}`);
    else if (err instanceof CloudError) io.err(`${err.code}: ${err.message}`);
    else io.err(`error: ${(err as Error)?.name ?? "Error"}`);
    log.error("cli.failed", { kind: cmd ?? null, err });
    return 1;
  }
}

async function operatorCommand(
  sub: string | undefined,
  flags: Record<string, string | true>,
  io: CliIo,
  print: (o: Record<string, unknown>) => void,
): Promise<number> {
  const config = loadCloudConfig(io.env);
  const { db, close } = openControlDb(controlDbPath(config.dataDir));
  try {
    const { keyring } = await import("../crypto/keyring.js");
    const { memoryRateLimiter } = await import("../abuse/rate-limiter.js");
    const { controlAudit } = await import("../audit.js");
    const svc = new OperatorService({
      db,
      keys: keyring(config.secretsKey),
      limiter: memoryRateLimiter(),
      audit: controlAudit(db),
    });
    if (sub === "create") {
      const email = str(flags.email);
      const name = str(flags.name);
      const role = str(flags.role);
      if (!email || !name || (role !== "admin" && role !== "support"))
        throw new CloudError(
          400,
          "VALIDATION",
          "operator create needs --email, --name and --role admin|support",
        );
      const password = (await io.readStdin()).replace(/\r?\n$/, "");
      const r = await svc.create({ email, name, role, password });
      print({
        operatorId: r.id,
        totpSecret: r.totpSecret,
        otpauthUri: r.otpauthUri,
        note: "add the secret to an authenticator app now; it is not shown again",
      });
      return 0;
    }
    if (sub === "disable") {
      const email = str(flags.email);
      if (!email) throw new CloudError(400, "VALIDATION", "operator disable needs --email");
      const ok = svc.disable(email);
      print({ disabled: ok });
      return ok ? 0 : 1;
    }
    throw new CloudError(400, "VALIDATION", "operator create|disable");
  } finally {
    close();
  }
}

/** Queue for the running server, or run here. Exit 1 when the command reports failures. */
async function delegated(
  kind: CommandKind,
  args: Record<string, unknown>,
  io: CliIo,
  log: Logger,
  print: (o: Record<string, unknown>) => void,
  needsOpener: boolean,
): Promise<number> {
  const config = loadCloudConfig(io.env);
  const path = controlDbPath(config.dataDir);
  if (existsSync(path)) {
    const { db, close } = openControlDb(path);
    try {
      if (heartbeatFresh(db)) {
        const id = enqueueCommand(db, kind, args);
        const r = await awaitCommand(db, id, { timeoutMs: io.waitMs ?? 60 * 60_000 });
        print({
          via: "server",
          commandId: id,
          status: r.status,
          ...(r.result ?? {}),
          ...(r.errorCode ? { errorCode: r.errorCode } : {}),
        });
        return r.status === "done" && !hasFailures(r.result) ? 0 : 1;
      }
    } finally {
      close();
    }
  }
  const host = await loadHost(io);
  if (needsOpener && !host)
    throw new CloudError(
      503,
      "TENANT_UNAVAILABLE",
      "the server is not running; set GLIDEWORTH_TENANT_RUNTIME_MODULE to run this here",
    );
  const rt = await createCloudRuntime({
    env: io.env,
    log,
    ...(host ? { createOpener: (ctx: OpenerContext) => host.createOpener(ctx) } : {}),
  });
  try {
    const result = await runCommand(rt, kind, args);
    print({ via: "local", status: "done", ...result });
    return hasFailures(result) ? 1 : 0;
  } finally {
    await rt.registry.shutdown();
    rt.closeDb();
  }
}

const hasFailures = (r: Record<string, unknown> | null) =>
  Array.isArray(r?.failed) && (r.failed as unknown[]).length > 0;

async function restoreControl(
  flags: Record<string, string | true>,
  io: CliIo,
  log: Logger,
  print: (o: Record<string, unknown>) => void,
): Promise<number> {
  const config = loadCloudConfig(io.env);
  const path = controlDbPath(config.dataDir);
  if (existsSync(path) && flags.force !== true) {
    let running = false;
    try {
      const { db, close } = openControlDb(path);
      running = heartbeatFresh(db);
      close();
    } catch {
      // unreadable control plane: that is why we are restoring
    }
    if (running)
      throw new CloudError(
        409,
        "CONFLICT",
        "the server is running; stop it first (or pass --force)",
      );
  }
  const at = str(flags.at);
  const r = await restoreControlPlane({
    store: createObjectStore(io.env, config),
    kek: config.backupKek,
    region: backupRegion(io.env),
    dataDir: config.dataDir,
    ...(at ? { at } : {}),
    log,
  });
  print({ restoredFrom: r.restoredFrom, previous: r.previous, keysRestored: r.keysRestored });
  return 0;
}
