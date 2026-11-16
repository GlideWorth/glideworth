/**
 * The app behind the REAL Node HTTP server (@hono/node-server). `app.request()` skips the Node adapter, so
 * regressions that only show up on a socket (request bodies, streaming, headers) need this.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, setup, WRITE_KEY } from "./helpers.js";

let h: Harness;
let server: Server;
afterEach(() => {
  server?.close();
  h?.close();
});

async function start(opts: Parameters<typeof setup>[0] = {}): Promise<string> {
  h = setup(opts);
  await new Promise<void>((resolve) => {
    server = serve({ fetch: h.app.fetch, port: 0, hostname: "127.0.0.1" }, () =>
      resolve(),
    ) as Server;
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const auth = { authorization: `Bearer ${WRITE_KEY}`, "content-type": "application/json" };

describe("over a real socket", () => {
  it("reads JSON request bodies (with Content-Length)", async () => {
    const base = await start();
    const r = await fetch(`${base}/api/v1/plans/plan-main/preview`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        ops: [{ op: "replace", path: "/expenses/[id=exp-living]/amount/value", value: 5700 }],
      }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { changes: unknown[] }).changes).toHaveLength(1);
  });

  it("reads chunked request bodies and enforces the size limit on them", async () => {
    const base = await start({ appOptions: { maxBodyBytes: 4096 } });
    const stream = (text: string) =>
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      });
    const ok = await fetch(`${base}/api/v1/plans/plan-main/preview`, {
      method: "POST",
      headers: auth,
      body: stream(
        JSON.stringify({
          ops: [{ op: "replace", path: "/expenses/[id=exp-living]/amount/value", value: 1 }],
        }),
      ),
      duplex: "half",
    });
    expect(ok.status).toBe(200);
    const big = await fetch(`${base}/api/v1/plans/plan-main/preview`, {
      method: "POST",
      headers: auth,
      body: stream(JSON.stringify({ pad: "x".repeat(10_000), ops: [] })),
      duplex: "half",
    });
    expect(big.status).toBe(413);
  });

  it("rejects an oversized Content-Length body with 413", async () => {
    const base = await start({ appOptions: { maxBodyBytes: 4096 } });
    const r = await fetch(`${base}/api/v1/plans/plan-main/change-sets`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ summary: "x".repeat(10_000), ops: [] }),
    });
    expect(r.status).toBe(413);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("speaks MCP over HTTP to a real client", async () => {
    const base = await start({ mcpAllowWrites: true });
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } =
      await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "socket-test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: auth.authorization } },
      }),
    );
    const res = (await client.callTool({ name: "list_plans", arguments: {} })) as {
      content: { text: string }[];
    };
    expect(JSON.parse(res.content[0]!.text).length).toBeGreaterThan(0);
    await client.close();
  });

  it("streams job events over SSE with the API key", async () => {
    const base = await start();
    const start1 = await fetch(`${base}/api/v1/plans/plan-main/monte-carlo?wait=20`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ settings: { trials: 100 } }),
    });
    const job = (await start1.json()) as { id: string };
    const sse = await fetch(`${base}/api/v1/jobs/${job.id}/events`, {
      headers: { authorization: auth.authorization },
    });
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const text = await sse.text();
    expect(text).toContain("event: done");
  });
});
