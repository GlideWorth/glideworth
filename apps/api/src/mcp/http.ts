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
  // Stateless, so there is no stream for server-initiated messages (GET) and no session to end
  // (DELETE). Answering GET with an event stream that closes at once made clients reopen it in a
  // tight loop: about 100,000 requests a day per connected client, which used up the workspace's
  // daily API quota. 405 is what the Streamable HTTP spec asks for; clients then only POST.
  if (req.method !== "POST") {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed: this MCP server is stateless; use POST.",
        },
        id: null,
      },
      { status: 405, headers: { allow: "POST" } },
    );
  }
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
