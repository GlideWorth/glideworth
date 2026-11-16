/**
 * Operator commands (self-host):
 *   backup  [--out <file>]                      consistent copy of the database (safe while running)
 *   restore --from <file> [--force]             replace the database (stop the server first)
 *   seed    [--sample uk|us] [--replace]        load a synthetic sample household
 *   reset-owner-passphrase                      print a one-time token to choose a new owner passphrase (forgot it)
 *
 * Cloud mode (`GLIDEWORTH_MODE=cloud`): every command is the cloud operator CLI (`glideworth-cloud`, from
 * `@glideworth/cloud/server`): `operator create`, `backup-now`, `restore-tenant`, `restore-control`,
 * `restore-test`, `migrate-all`, ... It opens workspaces with this app's tenant runtime (cloud-host.ts) when
 * the server is stopped and queues the command to the running server otherwise.
 */
import { parseArgs } from "node:util";
import { loadConfig, resolveMode } from "../config.js";
import { backupDatabase, restoreDatabase, type SampleName, seedSample } from "./db-tools.js";

if (resolveMode(process.env) === "cloud") {
  const { runCli } = await import("@glideworth/cloud/server");
  const { cloudHost } = await import("../cloud-host.js");
  process.exitCode = await runCli(
    process.argv.slice(2).filter((a) => a !== "--"),
    {
      env: process.env,
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
      readStdin: async () => {
        const chunks: Buffer[] = [];
        for await (const ch of process.stdin) chunks.push(ch as Buffer);
        return Buffer.concat(chunks).toString("utf8");
      },
      host: cloudHost as never,
    },
  );
  process.exit();
}

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest.filter((a) => a !== "--"),
  options: {
    out: { type: "string" },
    from: { type: "string" },
    force: { type: "boolean", default: false },
    sample: { type: "string", default: "uk" },
    replace: { type: "boolean", default: false },
  },
});
const { dbPath } = loadConfig();

try {
  switch (command) {
    case "backup":
      console.log(`Backup written: ${await backupDatabase(dbPath, values.out)}`);
      break;
    case "restore": {
      if (!values.from) throw new Error("usage: restore --from <backup file> [--force]");
      const r = await restoreDatabase(values.from, dbPath, { force: values.force });
      console.log(`Restored ${r.restoredFrom} -> ${dbPath}`);
      if (r.previous) console.log(`The previous database was kept as ${r.previous}`);
      console.log("Start the server again to use the restored data.");
      break;
    }
    case "seed": {
      if (values.sample !== "uk" && values.sample !== "us")
        throw new Error("--sample must be 'uk' or 'us'");
      const r = seedSample(dbPath, {
        sample: values.sample as SampleName,
        replace: values.replace,
      });
      console.log(
        `Loaded synthetic sample '${r.name}' (${r.householdId}) with plans: ${r.plans.join(", ")}`,
      );
      break;
    }
    case "reset-owner-passphrase": {
      const { openDb } = await import("../db/client.js");
      const { Services } = await import("../services.js");
      const { db, close } = openDb(dbPath);
      try {
        const t = new Services(db).users.resetOwner();
        console.log(
          `One-time reset token (valid until ${t.expiresAt}; the owner is signed out everywhere):\n\n  ${t.token}\n`,
        );
        console.log(
          'Open the app and choose "Use a reset token" (POST /api/v1/auth/accept { token, passphrase }).',
        );
      } finally {
        close();
      }
      break;
    }
    default:
      console.error(
        "usage: admin.ts backup [--out file] | restore --from file [--force] | seed [--sample uk|us] [--replace] | reset-owner-passphrase",
      );
      process.exitCode = 2;
  }
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
