/**
 * Operator commands shared by the CLI and the running server (review finding 6).
 *
 * A command that touches tenant files (restore, migrate, backup, restore test) must run in the process that
 * owns the open tenant handles, or a restore would swap a file under a live connection. So the CLI queues it in
 * `ops_commands` when the server's heartbeat is fresh, and the server's `CommandWorker` runs it and records the
 * result; when no server is running, the CLI runs it itself.
 */
import { and, asc, eq } from "drizzle-orm";
import type { ControlDb } from "./control/db.js";
import { accounts, cellHeartbeat, opsCommands } from "./control/schema.js";
import { isAccountId, newId } from "./crypto/random.js";
import { CloudError } from "./errors.js";
import type { Logger } from "./log/index.js";
import type { CloudRuntime } from "./runtime.js";
import type { TenantRuntimeBase } from "./types.js";

export const COMMAND_KINDS = [
  "backup-now",
  "restore-tenant",
  "restore-test",
  "migrate-all",
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];
export const HEARTBEAT_MS = 10_000;
export const HEARTBEAT_STALE_MS = 30_000;

type Runnable = Pick<CloudRuntime<TenantRuntimeBase>, "backups" | "registry" | "db" | "log">;

/** Run one command in this process. Results are JSON with ids and counts only. */
export async function runCommand(
  rt: Runnable,
  kind: CommandKind,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (kind) {
    case "backup-now": {
      const tenants = await rt.backups.sweep();
      const control = await rt.backups.backupControl();
      return { backedUp: tenants.backedUp, failed: tenants.failed, control: control.objectKey };
    }
    case "restore-tenant": {
      const at = typeof args.at === "string" ? args.at : undefined;
      const operatorId = typeof args.operatorId === "string" ? args.operatorId : "cli";
      const ids =
        args.all === true
          ? rt.db
              .select({ id: accounts.id })
              .from(accounts)
              .where(eq(accounts.status, "active"))
              .all()
              .map((r) => r.id)
          : [String(args.accountId ?? "")];
      const restored: string[] = [];
      const failed: string[] = [];
      for (const id of ids) {
        if (!isAccountId(id)) throw new CloudError(400, "VALIDATION", "not a workspace id");
        try {
          await rt.backups.restoreTenant(id, { ...(at ? { at } : {}), operatorId });
          restored.push(id);
        } catch (err) {
          if (args.all !== true) throw err;
          failed.push(id);
          rt.log.error("command.restore_failed", { accountId: id, err });
        }
      }
      return { restored, failed };
    }
    case "restore-test": {
      const n = Math.max(1, Math.min(100, Number(args.sample ?? 5) || 5));
      const r = await rt.backups.verifySample(n);
      return { verified: r.verified, failed: r.failed };
    }
    case "migrate-all": {
      const c = Math.max(1, Math.min(16, Number(args.concurrency ?? 2) || 2));
      const r = await rt.registry.migrateAll({ concurrency: c });
      return { ok: r.ok, failed: r.failed };
    }
  }
}

export function heartbeatFresh(db: ControlDb, now = Date.now()): boolean {
  const row = db.select().from(cellHeartbeat).where(eq(cellHeartbeat.id, "server")).get();
  return !!row && now - Date.parse(row.at) < HEARTBEAT_STALE_MS;
}

export function beat(db: ControlDb, now = new Date()): void {
  db.insert(cellHeartbeat)
    .values({ id: "server", pid: process.pid, at: now.toISOString() })
    .onConflictDoUpdate({
      target: cellHeartbeat.id,
      set: { pid: process.pid, at: now.toISOString() },
    })
    .run();
}

export function clearBeat(db: ControlDb): void {
  db.delete(cellHeartbeat)
    .where(and(eq(cellHeartbeat.id, "server"), eq(cellHeartbeat.pid, process.pid)))
    .run();
}

export function enqueueCommand(
  db: ControlDb,
  kind: CommandKind,
  args: Record<string, unknown>,
): string {
  const id = newId("cmd");
  db.insert(opsCommands).values({ id, kind, args }).run();
  return id;
}

/** Wait for a queued command to finish (poll). */
export async function awaitCommand(
  db: ControlDb,
  id: string,
  o: { timeoutMs: number; pollMs?: number },
): Promise<{
  status: "done" | "failed";
  result: Record<string, unknown> | null;
  errorCode: string | null;
}> {
  const deadline = Date.now() + o.timeoutMs;
  for (;;) {
    const row = db.select().from(opsCommands).where(eq(opsCommands.id, id)).get();
    if (row && (row.status === "done" || row.status === "failed"))
      return { status: row.status, result: row.result ?? null, errorCode: row.errorCode };
    if (Date.now() > deadline)
      throw new Error("timed out waiting for the server to run the command");
    await new Promise((r) => setTimeout(r, o.pollMs ?? 500));
  }
}

/** Runs queued commands in the server process, one at a time. */
export class CommandWorker {
  private running: Promise<void> | null = null;

  constructor(
    private readonly rt: Runnable,
    private readonly log: Logger,
  ) {}

  poll(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const next = this.rt.db
        .select()
        .from(opsCommands)
        .where(eq(opsCommands.status, "queued"))
        .orderBy(asc(opsCommands.createdAt))
        .limit(1)
        .get();
      if (!next) return;
      const claimed = this.rt.db
        .update(opsCommands)
        .set({ status: "running", startedAt: new Date().toISOString() })
        .where(and(eq(opsCommands.id, next.id), eq(opsCommands.status, "queued")))
        .run();
      if (claimed.changes !== 1) continue;
      try {
        if (!(COMMAND_KINDS as readonly string[]).includes(next.kind))
          throw new Error("unknown command");
        const result = await runCommand(this.rt, next.kind as CommandKind, next.args);
        this.rt.db
          .update(opsCommands)
          .set({ status: "done", result, finishedAt: new Date().toISOString() })
          .where(eq(opsCommands.id, next.id))
          .run();
        this.log.info("command.done", { commandId: next.id, kind: next.kind });
      } catch (err) {
        const code = err instanceof CloudError ? err.code : ((err as Error)?.name ?? "Error");
        this.rt.db
          .update(opsCommands)
          .set({
            status: "failed",
            errorCode: code.slice(0, 64),
            finishedAt: new Date().toISOString(),
          })
          .where(eq(opsCommands.id, next.id))
          .run();
        this.log.error("command.failed", { commandId: next.id, kind: next.kind, err });
      }
    }
  }
}
