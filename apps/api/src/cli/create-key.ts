/** Create an API key: `pnpm keys:create -- --name laptop --scopes read,simulate`. Prints the key once. */
import { parseArgs } from "node:util";
import { generateKey, insertKey, SCOPES, type Scope } from "../auth.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";

// `pnpm keys:create -- --name x` forwards the `--` separator to the script: ignore it (as admin.ts does).
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    name: { type: "string", default: "cli" },
    scopes: { type: "string", default: "read" },
  },
});
const scopes = values.scopes.split(",").map((s) => s.trim()) as Scope[];
if (!scopes.every((s) => SCOPES.includes(s)))
  throw new Error(`scopes must be among: ${SCOPES.join(", ")}`);
const { db, close } = openDb(loadConfig().dbPath);
const { key } = generateKey();
const id = insertKey(db, key, values.name, scopes);
close();
console.log(
  `Created ${id} (${scopes.join(",")}). Store this key now; it is not shown again:\n${key}`,
);
