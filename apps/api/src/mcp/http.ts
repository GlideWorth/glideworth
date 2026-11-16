import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { actorOf, type Principal } from "../auth.js";
import type { Services } from "../services.js";
import { createMcpServer } from "./server.js";

/**
 * Stateless Streamable HTTP: a fresh server + transport per request (no sessions to leak), JSON
 * responses. Auth already happened in the Hono middleware; the key's scopes decide which tools exist.
 */
export async function handleMcpHttp(
  req: Request,
  opts: { services: Services; principal: Principal; allowWrites: boolean },
): Promise<Response> {
  const server = createMcpServer({
    services: opts.services,
    scopes: opts.principal.scopes,
    canWrite: opts.allowWrites && opts.principal.scopes.includes("write"),
    actor: { ...actorOf(opts.principal), kind: "mcp" },
    principal: opts.principal,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close();
  }
}
