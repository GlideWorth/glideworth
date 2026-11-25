/**
 * stdio entrypoint for local MCP clients: `pnpm --filter @glideworth/api mcp:stdio`.
 * There is no API key on stdio (the client is a local process you started), so the only gate is
 * GLIDEWORTH_MCP_ALLOW_WRITES=true. Read-only otherwise. NEVER write to stdout here: it is the protocol channel.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { Services } from "../services.js";
import { createMcpServer } from "./server.js";

const config = loadConfig();
const { db } = openDb(config.dbPath);
const services = new Services(db);
services.jobs.recoverInterrupted();
const server = createMcpServer({
  services,
  scopes: config.mcpAllowWrites ? ["read", "simulate", "write"] : ["read", "simulate"],
  canWrite: config.mcpAllowWrites,
  actor: { kind: "mcp", label: "mcp-stdio" },
  webUrl: config.publicUrl ?? null,
});
await server.connect(new StdioServerTransport());
